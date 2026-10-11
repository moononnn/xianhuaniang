// 鲜花酿 v2 · 真实测卡 / 代笔对戏服务
//
// 职责分层（App 主进程受限，不能 spawn、不能 listen、不能读 %APPDATA% 之外的裸 fs）：
//   本文件（主进程）  排期、状态账、scope 隔离、取消信号、启动受管 worker、读回结果；
//   runtime/theater-runner.mjs（受管 runtime） 真正开无界面 Chromium、连 CDP、在酒馆页面里跑 Generate()。
// 两者只通过 ctx.dataDir 下的任务文件通信，和 backend/tavern-admin.js 同一套路。
//
// 约定：
//   - 变量只在真实酒馆临时聊天里算，本服务不自己算 MVU（backend/mvu.js 只做账本）；
//   - 读不到变量就报 null，并带来源标记，绝不写成 {}；
//   - 测卡/对戏临时聊天用唯一前缀，worker 结束（含延迟复查）自删，正式聊天不动。

import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { ensureServer, runtimeConfig, runtimeStatus } from "./st-runtime.js";
import { listRunVariables, readRunVariables, recordRunVariables } from "./mvu.js";
import { analyzeTheaterRun } from "./theater-analysis.js";
import { listTheaterReports, readTheaterReport, writeTheaterReport } from "./theater-reports.js";
import { DUET_CHAT_PREFIX, THEATER_CHAT_PREFIX } from './theater-contract.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const JOB_DIR = "theater-jobs";
const TASK_FILE = "theater-tasks.json";
const READY_TIMEOUT_MS = 30000;
const RUN_TTL_MS = 30 * 60 * 1000;
const DUET_TTL_MS = 2 * 60 * 60 * 1000;
const TASK_TTL_MS = 12 * 60 * 60 * 1000;
const MAX_OBJECTIVE_CHARS = 4000;
const DEFAULT_TIMEOUT_MS = 120000;
const MAX_TURNS = 12;
// 工具侧最多等这么久再把控制权还给模型。宿主对 App 工具执行有 30 秒回调上限
// （RPC callback.tools.execute timed out after 30000ms），真实测卡却要跑几分钟，
// 同步等必然被砍：任务还在跑、回包却已经断了。留出余量后超时就返回 running 快照。
const TOOL_WAIT_MS = 20000;
// 多幕测卡的总时限宽限（按幕数放大之后再额外给的一段，含启动浏览器与收尾的时间）。
const TOTAL_GRACE_MS = 60000;
// 模型侧回查/回报统一指向这个工具名，文案里要写清楚，避免模型凭空猜工具。
const RESULT_TOOL = "hanabrew-test-result";
const INTERRUPTED_NOTE = "鲜花酿重载或上次运行中断，这次测试已停，不会自动重跑。请回工作台重新开始，或结束它并清理临时聊天。";

/**
 * 代笔节奏。UI 已经让用户选过节奏，这里只负责把它变成硬约束：
 * maxAutoRounds 之前可以连续推进，到顶了必须由模型交回控制权（checkpoint），
 * 否则会把「慢慢推进」跑成一路自动代写。
 */
const DUET_PACE_DEFINITIONS = Object.freeze({
  free: Object.freeze({
    id: "free", label: "自由发展", maxAutoRounds: 6,
    pausePolicy: "只在重大剧情、不可逆选择或明确边界节点暂停",
  }),
  slow: Object.freeze({
    id: "slow", label: "慢慢推进", maxAutoRounds: 4,
    pausePolicy: "普通回合连续推进；关键剧情、关系变化、越界或重大时间跳跃时暂停",
  }),
  restrained: Object.freeze({
    id: "restrained", label: "保持克制", maxAutoRounds: 1,
    pausePolicy: "每轮保留方向控制；出现暧昧、冲突或边界变化前暂停",
  }),
});

const DUET_PACE_BY_LABEL = Object.freeze(Object.fromEntries(
  Object.values(DUET_PACE_DEFINITIONS).map((pace) => [pace.label, pace.id]),
));

export function resolveDuetPace(value) {
  const raw = String(value ?? "").trim();
  const id = Object.hasOwn(DUET_PACE_DEFINITIONS, raw)
    ? raw
    : (DUET_PACE_BY_LABEL[raw] || "free");
  return DUET_PACE_DEFINITIONS[id];
}

function text(value, limit = 200) {
  return String(value ?? "").trim().slice(0, limit);
}

/**
 * 单幕等待上限：既是 worker 里每一幕的上限，也是估算整轮总时限的基数。
 * 不能拿它直接当总时限：一轮测卡本来就要跑几分钟，多幕测卡会被误判成超时。
 */
export function perTurnTimeoutMs(value) {
  const raw = Number(value);
  return raw > 0 ? raw : DEFAULT_TIMEOUT_MS;
}

/** 临时聊天都写在 v2 自己的 st-data 下；路径来自 st-runtime 的静态配置，不等运行时记录。 */
function chatsRoot() {
  return path.join(runtimeConfig().dataRoot, "default-user", "chats");
}

/**
 * scope 适配：归属只能由会话认定。
 *
 * agentId 是同一个伙伴的两个会话共享的东西，拿它当归属依据等于让 A 会话读到 B 会话的测卡，
 * 所以 agentId 只做一致性核对，不参与归属判定。只有 agentId 的请求一律拒。
 */
export function normalizeScope(scope = {}) {
  const sessionId = text(scope.sessionId ?? scope.sessionRef, 200);
  const sessionPath = text(scope.sessionPath, 400);
  const agentId = text(scope.agentId, 120);
  if (!sessionId && !sessionPath) {
    throw new Error("测卡必须绑定到具体会话（sessionId 或 sessionPath），当前请求没有会话标识。");
  }
  const keys = [
    sessionId ? `sessionId:${sessionId}` : "",
    sessionPath ? `sessionPath:${pathKey(sessionPath)}` : "",
  ].filter(Boolean);
  // callToken 只是发消息用的动词凭据，不参与归属判定，也不落盘（成绩单只挑会话标识写）；
  // 它是异步测卡跑完之后还能往这个会话回报的唯一凭据。
  return { sessionId, sessionPath, agentId, keys, callToken: text(scope.callToken, 200) };
}

/**
 * 路径比对的唯一口径：C 盘入口与 D 盘真实目录可能是同一处（junction），
 * 而且宿主给的路径未必规范化过。比对前先解成真实路径再统一小写。
 */
function pathKey(value) {
  const raw = text(value, 400);
  if (!raw) return "";
  try {
    return fsSync.realpathSync.native(raw).toLowerCase();
  } catch {
    try {
      return path.resolve(raw).toLowerCase();
    } catch {
      return raw.toLowerCase();
    }
  }
}

// deps 只为测试留：可以换掉 ensureServer / runtimeStatus，不必真拉酒馆。
export function createTheaterService(ctx, deps = {}) {
  const runs = new Map();
  const duets = new Map();
  const pendingByScope = new Map();
  const active = new Set();
  const totalGraceMs = Number(deps.totalGraceMs) > 0 ? Number(deps.totalGraceMs) : TOTAL_GRACE_MS;
  let tail = Promise.resolve();
  let workerTail = Promise.resolve();
  let disposed = false;

  recoverTasks();

  function purge() {
    const now = Date.now();
    for (const [runId, run] of runs) {
      const ttl = ['waiting', 'waiting_for_direction', 'interrupted'].includes(run.status) ? TASK_TTL_MS : (run.mode === "duet" ? DUET_TTL_MS : RUN_TTL_MS);
      if (now - run.updatedAt <= ttl) continue;
      runs.delete(runId);
      dropScopeBinding(runId);
    }
  }

  function dropScopeBinding(runId) {
    for (const [key, ids] of pendingByScope) {
      const rest = ids.filter((id) => id !== runId);
      if (rest.length) pendingByScope.set(key, rest);
      else pendingByScope.delete(key);
    }
  }

  function bindScope(scope, runId) {
    for (const key of scope.keys) {
      const ids = pendingByScope.get(key) || [];
      ids.push(runId);
      pendingByScope.set(key, ids);
    }
  }

  /**
   * 归属判定：提供的标识要么缺、要么与记录逐字一致；不得出现任何冲突。
   * 并且至少有一个标识真的对得上。
   *
   * 缺字段不等于冲突：宿主给模型的工具上下文（app-contract 的
   * HanaPluginToolExecuteContextV2）只有 sessionPath，没有 sessionId；卡片提交时
   * 却会同时记下 sessionId 与 sessionPath。旧实现在“只有一边有 sessionId”时直接
   * 判否，于是卡片在当前对话里建的测卡，工具拿着同一段 sessionPath 也认不出来。
   * 冲突（一处有、值不同）仍然拒：伪造路径、错会话不会被放过。
   */
  function ownedBy(run, scope) {
    if (!run || !run.scope) return false;
    const runScope = run.scope;
    const idConflict = Boolean(scope.sessionId && runScope.sessionId && scope.sessionId !== runScope.sessionId);
    const pathConflict = Boolean(scope.sessionPath && runScope.sessionPath
      && pathKey(scope.sessionPath) !== pathKey(runScope.sessionPath));
    const agentConflict = Boolean(scope.agentId && runScope.agentId && scope.agentId !== runScope.agentId);
    if (idConflict || pathConflict || agentConflict) return false;
    const idMatch = Boolean(scope.sessionId && runScope.sessionId && scope.sessionId === runScope.sessionId);
    const pathMatch = Boolean(scope.sessionPath && runScope.sessionPath
      && pathKey(scope.sessionPath) === pathKey(runScope.sessionPath));
    return idMatch || pathMatch;
  }

  /**
   * 认领一条 pending：必须 ownedBy 逐字段核对，不能因为 pendingByScope 里恰好有同一个 key 就拿走。
   */
  function claimPending(scope, input = {}) {
    purge();
    const wantedMode = text(input.mode, 20);
    const wantedCharacter = text(input.characterId, 200);
    const candidate = [...new Set(scope.keys.flatMap((key) => pendingByScope.get(key) || []))]
      .map((id) => runs.get(id))
      .filter((run) => run && (run.status === "waiting" || run.status === "waiting_for_direction"))
      .filter((run) => ownedBy(run, scope))
      .filter((run) => !wantedMode || run.mode === wantedMode)
      .filter((run) => !run.chatFile)
      .filter((run) => !wantedCharacter || !run.characterId || run.characterId === wantedCharacter)
      .sort((left, right) => left.createdAt - right.createdAt)[0];
    if (!candidate) return null;
    candidate.status = "running";
    candidate.updatedAt = Date.now();
    dropScopeBinding(candidate.runId);
    return candidate;
  }

  /**
   * 对外快照：只给卡片与交接文案需要的字段。
   * scope / scopeKeys / 本地路径是归属凭据，不进 JSON；内部 ownedBy 不受影响。
   */
  function publicRun(run) {
    return {
      runId: run.runId,
      duetId: run.duetId || "",
      mode: run.mode,
      status: run.status,
      createdAt: run.createdAt,
      updatedAt: run.updatedAt,
      characterId: run.characterId || "",
      characterName: run.characterName || "",
      characterFile: run.characterId || "",
      chatFile: run.chatFile || "",
      testType: run.testType || "",
      pace: run.pace || "",
      paceLabel: run.paceLabel || "",
      objective: run.objective || "",
      pausePolicy: run.pausePolicy || "",
      turns: Array.isArray(run.turns) ? run.turns : (typeof run.turns === "number" ? run.turns : []),
      currentTurnIndex: run.currentTurnIndex ?? 0,
      activeScene: run.activeScene ?? null,
      opening: run.opening || "",
      scenes: Array.isArray(run.scenes) ? run.scenes : [],
      initialVariables: run.initialVariables ?? null,
      finalVariables: run.finalVariables ?? null,
      initialVariableSource: run.initialVariableSource || "unavailable",
      finalVariableSource: run.finalVariableSource || "unavailable",
      mvuAvailable: run.mvuAvailable ?? null,
      isolated: run.isolated === true,
      engine: run.engine || "sillytavern-runtime",
      maxAutoRounds: run.maxAutoRounds ?? 0,
      autoRoundsSinceCheckpoint: run.autoRoundsSinceCheckpoint ?? 0,
      needsUserCheckpoint: run.needsUserCheckpoint === true,
      recovered: run.recovered === true,
      warnings: Array.isArray(run.warnings) ? run.warnings : [],
      // notes 是「不算故障但必须说清楚」的情况（比如开局基准还没建立），
      // 卡片不展示它，结论正文和成绩单要用。
      notes: Array.isArray(run.notes) ? run.notes : [],
      error: run.error || null,
    };
  }

  async function waitForTavern() {
    if (!ctx?.runtime?.start) throw new Error("当前 Hana 不支持受管本机运行时，真实测卡无法启动。");
    const startTavern = deps.ensureServer || ensureServer;
    const readStatus = deps.runtimeStatus || runtimeStatus;
    await startTavern(ctx);
    let ready = false;
    const until = Date.now() + READY_TIMEOUT_MS;
    while (Date.now() < until && !disposed) {
      const status = await readStatus(ctx);
      if (status.ready) { ready = true; break; }
      if (status.state === "failed") throw new Error("酒馆启动失败，请回到鲜花酿主页面重试。");
      await sleep(200);
    }
    if (!ready) throw new Error("酒馆尚未就绪，请先打开鲜花酿主页面。");
    return readStatus(ctx);
  }

  /**
   * 量行闸门：酒馆页面状态是全局的，同一时刻只能有一个受管 worker 在跑。
   * 放在最底层是因为测卡现在可以异步（工具先返回、任务在后台跑完），
   * 上层那圈 enqueue 只管得住同一条调用面的先后，管不住后台任务。
   */
  async function runWorkerJob(payload, options = {}) {
    const previous = workerTail;
    let release;
    workerTail = new Promise((resolve) => { release = resolve; });
    try {
      await previous.catch(() => {});
      return await runWorkerJobInner(payload, options);
    } finally {
      release();
    }
  }

  /** 跑一个 worker 任务：写任务文件 → 起受管 runtime → 等结果文件 → 收尾删临时传输文件。 */
  async function runWorkerJobInner(payload, { timeoutMs = DEFAULT_TIMEOUT_MS, progressPath = "", cancelPath = "" } = {}) {
    if (disposed) throw new Error("鲜花酿正在重新加载，请稍后重试。");
    if (!ctx?.dataDir || !ctx.runtime?.start) throw new Error("当前应用没有受管酒馆任务通道。");
    const status = await waitForTavern();
    const dir = path.join(ctx.dataDir, JOB_DIR);
    await fs.mkdir(dir, { recursive: true });
    const id = randomUUID();
    const requestPath = path.join(dir, `${id}.request.json`);
    const resultPath = path.join(dir, `${id}.result.json`);
    const request = {
      ...payload,
      serverUrl: status.serverUrl,
      chatsRoot: chatsRoot(),
      progressPath,
      cancelPath,
      timeoutMs,
    };
    const json = JSON.stringify(request);
    if (Buffer.byteLength(json) > 4 * 1024 * 1024) throw new Error("测卡任务资料过大。");
    await fs.writeFile(requestPath, json, { mode: 0o600 });

    let worker = null;
    let cancellationDeadline = 0;
    try {
      if (cancelPath && fsSync.existsSync(cancelPath)) throw new Error('测卡已被取消。');
      worker = await ctx.runtime.start({
        runtime: "node",
        entry: "runtime/theater-runner.mjs",
        profile: "local-machine",
        network: "external",
        // 必须显式声明 scope: "app"：工具执行期间宿主会把当前 callToken 无条件注进
        // runtime.start（app-host-entry.js 的 domain 包装器只看 input.scope !== "app"），
        // 而 local-machine 明确拒绝 callToken（APPS.md「受管程序与本地服务」）。
        // 不声明就会撞上 “Local-machine execution does not accept readRoots, writeRoots,
        // callToken, or taskId scope inputs.”，测卡根本起不来。
        scope: "app",
        args: [requestPath, resultPath],
      });
      const runtimeId = worker?.runtimeId;
      if (!runtimeId) throw new Error("测卡任务没有拿到受管运行时编号。");
      active.add(runtimeId);
      // 测卡本身可能跑十几分钟，这里给足余量；取消靠 cancelPath，不靠杀进程。
      // graceMs 只为测试存在：默认 60s，测试注入小值好等超时路径。
      const deadline = Date.now() + timeoutMs + (Number(deps.graceMs) || 60000);
      while (Date.now() < deadline && !disposed) {
        const cancelled = Boolean(cancelPath && fsSync.existsSync(cancelPath));
        if (cancelled && !cancellationDeadline) cancellationDeadline = Date.now() + 8000;
        if (cancellationDeadline && Date.now() >= cancellationDeadline) throw new Error('取消信号已发送，但运行时未及时确认；不能当作测卡完成。');
        let raw;
        try {
          raw = await fs.readFile(resultPath, "utf8");
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
        }
        if (raw) {
          if (cancelled) throw new Error('测卡已被取消。');
          let result;
          try { result = JSON.parse(raw); } catch { throw new Error("测卡结果文件损坏，结果无法确认。"); }
          if (result.ok !== true || result.data == null) throw new Error(result.error || "酒馆没有给出测卡结果。");
          return result.data;
        }
        const state = await ctx.runtime.get?.(runtimeId);
        if (state?.state === "failed") {
          throw new Error("测卡运行时中途失败；没有收到酒馆的完成确认，不能当作测通。");
        }
        await sleep(200);
      }
      // disposed 时也要说清楚是重载打断，不是测卡超时。
      throw new Error(disposed ? "鲜花酿正在重新加载，请稍后重试。" : "测卡超时，未收到酒馆完成确认。");
    } finally {
      if (worker?.runtimeId) {
        try { await ctx.runtime.stop?.(worker.runtimeId); } catch {}
        active.delete(worker.runtimeId);
      }
      await Promise.all([
        requestPath, resultPath, `${resultPath}.tmp`,
        ...(progressPath ? [progressPath] : []),
        ...(cancelPath ? [cancelPath] : []),
      ].map((file) => fs.rm(file, { force: true }).catch(() => {})));
    }
  }

  function cancelPathFor(runId) {
    return path.join(ctx.dataDir, JOB_DIR, `${runId}.cancel`);
  }

  // ── 任务快照 ────────────────────────────────────────────────────────────
  // 一份账同时管两件事：
  //   1. 重载后重建卡片任务（pending 要能接着交接，否则用户填的卡与方向全丢）；
  //   2. 证明某个临时聊天前缀属于哪个会话（没证明就不能删，无归属盲删会误删别的会话）。
  // scripted 与 duet 走同一套，不分两份账。

  function taskLedgerPath() {
    return path.join(ctx.dataDir, TASK_FILE);
  }

  /** 损坏的快照不能当空账使：写入时必须报错，不许假装保存成功。 */
  function readTaskLedger() {
    let raw;
    try {
      raw = fsSync.readFileSync(taskLedgerPath(), "utf8");
    } catch (error) {
      if (error.code === "ENOENT") return {};
      throw new Error(`小剧场任务快照读不出来（${error.message}），本次没有保存任何新任务。`);
    }
    try {
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("格式不是对象");
      return parsed;
    } catch (error) {
      throw new Error(`小剧场任务快照已损坏（${error.message}），本次没有保存任何新任务。请检查 App 数据目录。`);
    }
  }

  function writeTaskLedger(ledger) {
    fsSync.mkdirSync(path.dirname(taskLedgerPath()), { recursive: true });
    const temp = `${taskLedgerPath()}.tmp`;
    fsSync.writeFileSync(temp, JSON.stringify(ledger, null, 2), "utf8");
    fsSync.renameSync(temp, taskLedgerPath());
  }

  function taskEntryOf(record) {
    return {
      runId: record.runId,
      mode: record.mode,
      status: record.status,
      characterId: record.characterId || "",
      characterName: record.characterName || "",
      chatFile: record.chatFile || "",
      testType: record.testType || "",
      pace: record.pace || "",
      paceLabel: record.paceLabel || "",
      objective: record.objective || "",
      sessionId: record.scope?.sessionId || "",
      sessionPath: record.scope?.sessionPath || "",
      agentId: record.scope?.agentId || "",
      createdAt: record.createdAt || Date.now(),
      updatedAt: Date.now(),
    };
  }

  /** 写一条快照。写不成就抛，不许让调用方以为已经持久化。 */
  function rememberTask(record) {
    const ledger = readTaskLedger();
    ledger[record.runId] = taskEntryOf(record);
    writeTaskLedger(ledger);
  }

  function updateTask(runId, patch = {}) {
    const ledger = readTaskLedger();
    if (!Object.hasOwn(ledger, runId)) return;
    Object.assign(ledger[runId], patch, { updatedAt: Date.now() });
    writeTaskLedger(ledger);
  }

  function forgetTask(runId) {
    const ledger = readTaskLedger();
    if (!Object.hasOwn(ledger, runId)) return;
    delete ledger[runId];
    writeTaskLedger(ledger);
  }

  /**
   * 重启恢复：
   *   - waiting / waiting_for_direction → 重新建成 pending，卡片能接着交接；
   *   - running → interrupted（已开始但被打断，不自动重跑）；
   *   - done / error / interrupted / cancelled → 不复活，直接清掉。
   * 超过保质期的一律清掉。
   */
  function recoverTasks() {
    let ledger;
    try {
      ledger = readTaskLedger();
    } catch (error) {
      ctx?.logger?.warn?.(`[xianhuaniang] ${error.message} 本次不做重启恢复。`);
      return;
    }
    const now = Date.now();
    const rebuilt = {};
    for (const [runId, entry] of Object.entries(ledger)) {
      const updatedAt = Number(entry?.updatedAt) || 0;
      if (!entry || now - updatedAt > TASK_TTL_MS) continue;
      // done / error / cancelled 是终态，不复活；interrupted 要留着（让用户看到它停在哪）。
      if (["done", "error", "cancelled"].includes(entry.status)) continue;
      const wasRunning = entry.status === "running";
      const interrupted = wasRunning || entry.status === "interrupted";
      rebuilt[runId] = { ...entry, status: interrupted ? "interrupted" : entry.status, updatedAt: now };
      runs.set(runId, {
        runId,
        mode: entry.mode === "duet" ? "duet" : "scripted",
        status: interrupted ? "interrupted" : entry.status,
        createdAt: entry.createdAt || now,
        updatedAt: now,
        characterId: entry.characterId || "",
        characterName: entry.characterName || "",
        chatFile: interrupted ? (entry.chatFile || "") : "",
        testType: entry.testType || "",
        pace: entry.pace || "",
        paceLabel: entry.paceLabel || "",
        objective: entry.objective || "",
        turns: [],
        currentTurnIndex: 0,
        activeScene: null,
        opening: "",
        scenes: [],
        initialVariables: null,
        finalVariables: null,
        initialVariableSource: "unavailable",
        finalVariableSource: "unavailable",
        mvuAvailable: null,
        isolated: false,
        engine: "sillytavern-runtime",
        warnings: [],
        error: interrupted ? INTERRUPTED_NOTE : "",
        scope: { sessionId: entry.sessionId || "", sessionPath: entry.sessionPath || "", agentId: entry.agentId || "" },
        recovered: true,
        duetId: entry.mode === "duet" ? runId : "",
        progressPath: "",
        cancelPath: "",
      });
      if (wasRunning && entry.mode === "duet") {
        rebuilt[runId].duetId = runId;
      }
    }
    writeTaskLedger(rebuilt);
  }

  async function readProgress(run) {
    if (!run.progressPath) return null;
    try {
      const raw = await fs.readFile(run.progressPath, "utf8");
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  // ── 真实测卡 ──────────────────────────────────────────────────────────────

  /**
   * 定位要跑的那次测卡：卡片先 submit 拿到 runId，工具必须用它，不能另起一个编号。
   * 明确传了 runId 就用它（校验归属/角色/形态）；没传才去同会话同角色认领一条 pending。
   */
  function resolveTargetRun(input, scope, mode) {
    const wanted = text(input?.runId, 80);
    if (wanted) {
      const run = runs.get(wanted);
      if (!run) throw new Error("这次测卡的编号不存在、已过期或不属于当前对话。");
      if (!ownedBy(run, scope)) throw new Error("这次测卡的编号不属于当前对话。");
      if (run.mode !== mode) throw new Error("这次测卡的形态和当前操作对不上。");
      const wantedCharacter = text(input?.characterId ?? input?.characterFile, 200);
      if (wantedCharacter && run.characterId && run.characterId !== wantedCharacter) {
        throw new Error("这次测卡的角色和当前指定的角色对不上，请先结束它再重新开始。");
      }
      return run;
    }
    const characterId = text(input?.characterId ?? input?.characterFile, 200);
    const candidate = claimPending(scope, { mode, characterId });
    return candidate || null;
  }

  /**
   * 准备一次真实测卡：校验归属与参数、落任务快照，但不启动 worker。
   * 拆出来是为了让「启动」和「等跑完」解耦 —— 宿主对 App 工具执行有 30 秒回调上限，
   * 真实测卡却要跑几分钟，同步等待必然被那道上限砍断（任务还在跑，回包已经断了）。
   */
  function prepareRun(input, scope) {
    purge();
    // 归属先判：传了别人的 runId 就该报归属问题，而不是先报参数问题。
    const target = resolveTargetRun(input, scope, "scripted");
    const characterId = text(input?.characterId ?? input?.characterFile, 200);
    const characterName = text(input?.characterName, 80);
    if (!characterId && !characterName && !target?.characterId) throw new Error("测卡需要指定酒馆里的角色卡。");
    const turns = (Array.isArray(input?.turns) ? input.turns : [])
      .map((turn) => text(turn, 2000))
      .filter(Boolean);
    if (!turns.length) throw new Error("真实测卡至少需要一句测试台词。");
    if (turns.length > MAX_TURNS) throw new Error(`真实测卡一次最多 ${MAX_TURNS} 幕，请分批测。`);

    // 有卡片 runId 就复用那条 pending，progress 才会真的动起来。
    const runId = target?.runId || `theater-${Date.now()}-${randomUUID().slice(0, 8)}`;
    const chatFile = target?.chatFile || `${THEATER_CHAT_PREFIX}${runId}`;
    const run = target || {
      runId,
      mode: "scripted",
      status: "running",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      characterId,
      characterName,
      chatFile,
      turns: turns.length,
      opening: "",
      scenes: [],
      currentTurnIndex: 0,
      activeScene: null,
      initialVariables: null,
      finalVariables: null,
      initialVariableSource: "unavailable",
      finalVariableSource: "unavailable",
      mvuAvailable: null,
      isolated: true,
      engine: "sillytavern-runtime",
      warnings: [],
      notes: [],
      error: null,
      scope,
      scopeKeys: scope.keys,
      progressPath: path.join(ctx.dataDir, JOB_DIR, `${runId}.progress.json`),
      cancelPath: cancelPathFor(runId),
      seq: 0,
    };
    // 卡片建的 pending 记着 sessionId，而工具调用只带 sessionPath。两边都过了 ownedBy，
    // 合并起来跑完才有会话可回报；只留工具那半边，异步完成时就找不到该叫醒谁了。
    const mergedScope = normalizeScope({
      sessionId: scope.sessionId || target?.scope?.sessionId,
      sessionPath: scope.sessionPath || target?.scope?.sessionPath,
      agentId: scope.agentId || target?.scope?.agentId,
      callToken: scope.callToken,
    });
    // 复用 UI 那条 pending 时，把它的状态与路径接上，scenes 才有地方显示。
    Object.assign(run, {
      status: "running",
      updatedAt: Date.now(),
      // 显式重试（工具带 runId 再跑一次）才继续；重载本身不会自动重跑。
      // 重试时清掉上次中断的提示，否则过程面板会一直挂着旧状态。
      error: null,
      recovered: false,
      characterId: run.characterId || characterId,
      characterName: run.characterName || characterName,
      chatFile,
      turns: turns.length,
      scope: mergedScope,
      scopeKeys: mergedScope.keys,
      notes: [],
      progressPath: path.join(ctx.dataDir, JOB_DIR, `${runId}.progress.json`),
      cancelPath: cancelPathFor(runId),
      objective: run.objective || text(input?.objective ?? input?.detail, MAX_OBJECTIVE_CHARS),
    });
    runs.set(runId, run);
    dropScopeBinding(runId);
    // 已开始：快照改标 running，重启后就不会被当成 pending 自动重跑。
    try { rememberTask(run); }
    catch (error) { run.status = 'error'; run.error = '开始状态未能保存，没有启动真实测卡。'; throw new Error(`${run.error} ${error.message}`); }
    return { run, turns, startedAt: Date.now() };
  }

  /**
   * 把这次测卡真正跑完：起受管 worker、吸收进度、跑完落账。
   * 返回跑完后的对外快照；调用方可以 await 它，也可以让它在后台自行跑完。
   */
  async function executeRunJob(run, turns, input, scope, startedAt) {
    // 明确重试才移除上一次的取消信号；新取消仍由本次worker接收。
    await fs.rm(run.cancelPath, { force: true });
    const pump = setInterval(async () => {
      const snapshot = await readProgress(run);
      if (!snapshot) return;
      Object.assign(run, {
        opening: snapshot.opening ?? run.opening,
        scenes: Array.isArray(snapshot.scenes) ? snapshot.scenes : run.scenes,
        currentTurnIndex: snapshot.currentTurnIndex ?? run.currentTurnIndex,
        activeScene: snapshot.activeScene ?? null,
        initialVariables: snapshot.initialVariables ?? run.initialVariables,
        initialVariableSource: snapshot.initialVariableSource ?? run.initialVariableSource,
        mvuAvailable: snapshot.mvuAvailable ?? run.mvuAvailable,
        updatedAt: Date.now(),
      });
    }, 400);
    pump.unref?.();

    try {
      const data = await runWorkerJob(
        { action: "run", runId: run.runId, characterId: run.characterId, characterName: run.characterName, turns, chatFile: run.chatFile },
        {
          // 这里传的是总时限的基数，不是单幕时限：按幕数放大，宽限另算。
          timeoutMs: perTurnTimeoutMs(input?.timeoutMs) * Math.max(1, turns.length) + totalGraceMs,
          progressPath: run.progressPath,
          cancelPath: run.cancelPath,
        },
      );
      Object.assign(run, {
        status: "done",
        activeScene: null,
        opening: data.opening || run.opening,
        // 酒馆回传的真实角色名优先：成绩单里不该只有 PNG 文件名。
        characterName: data.character?.name || run.characterName,
        scenes: data.scenes || [],
        currentTurnIndex: (data.scenes || []).length,
        initialVariables: data.initialVariables ?? null,
        finalVariables: data.finalVariables ?? null,
        initialVariableSource: data.initialVariableSource || "unavailable",
        finalVariableSource: data.finalVariableSource || "unavailable",
        mvuAvailable: data.mvuAvailable === true,
        updatedAt: Date.now(),
      });
      // 生成成功 ≠ MVU 跑通：体检结论单列，读不到变量、基准断裂、时间倒流都在这里说清。
      const analysis = analyzeTheaterRun({
        scenes: run.scenes,
        initialVariables: run.initialVariables,
        finalVariables: run.finalVariables,
        initialVariableSource: run.initialVariableSource,
        finalVariableSource: run.finalVariableSource,
        mvuAvailable: run.mvuAvailable,
      });
      run.warnings = [...run.warnings, ...analysis.warnings];
      run.notes = analysis.notes;
      // 测完了：待办快照作废，重启后不再复活这张卡；成绩单留下来供回查。
      try { forgetTask(run.runId); } catch { /* 账本问题不掩盖测卡结果 */ }
      recordRunVariables(ctx.dataDir, run.runId, {
        characterId: run.characterId,
        characterName: data.character?.name || run.characterName,
        chatFile: run.chatFile,
        sessionId: run.scope?.sessionId,
        sessionPath: run.scope?.sessionPath,
        agentId: run.scope?.agentId,
        mode: "scripted",
        initialVariables: run.initialVariables,
        finalVariables: run.finalVariables,
        initialVariableSource: run.initialVariableSource,
        finalVariableSource: run.finalVariableSource,
        mvuAvailable: run.mvuAvailable,
      });
      reportRun(run, startedAt);
      return publicRun(run);
    } catch (error) {
      Object.assign(run, {
        status: "error",
        activeScene: null,
        error: text(error?.message || error, 500),
        updatedAt: Date.now(),
      });
      // 被重载/关停打断不是「测崩了」：快照留着并标 interrupted，重启后能看到它停在哪。
      // 真的测崩（酒馆报错、没出正文）才清掉，重启后不该复活一张已经测崩的卡。
      try {
        if (disposed) updateTask(run.runId, { status: "interrupted" });
        else forgetTask(run.runId);
      } catch { /* 同上，不让账本问题掩盖真实错误 */ }
      // 失败也留档：跑到第几幕停的、报了什么错，比一句「这次没跑成」有用得多。
      reportRun(run, startedAt);
      throw error;
    } finally {
      clearInterval(pump);
      dropScopeBinding(run.runId);
      // 工具早就把控制权还给模型了（超过等待上限），这里补一条回报。
      // 回报结果（含「没能回报」的原因）要再落一次成绩单，否则那条信息只活在内存里。
      if (run.notifyOnFinish) {
        notifyRunFinished(run)
          .catch(() => {})
          .then(() => { reportRun(run, startedAt); })
          .catch(() => {});
      }
    }
  }

  /** 同步等跑完的那条路径：内部与测试用，工具入口走 startRun。 */
  async function performRun(input, scope) {
    const { run, turns, startedAt } = prepareRun(input, scope);
    return executeRunJob(run, turns, input, run.scope, startedAt);
  }

  /**
   * 工具入口：最多等 TOOL_WAIT_MS 就把控制权交回去。
   * 跑得快的（一两幕）直接把完整过程和变量带回去；跑得慢的返回 running 快照，
   * 任务留在后台跑完，完成时再往这个会话回报一条消息，而不是让回包被宿主砍断。
   */
  async function startRun(input, scope, waitMs = TOOL_WAIT_MS) {
    const { run, turns, startedAt } = prepareRun(input, scope);
    const job = executeRunJob(run, turns, input, run.scope, startedAt);
    const outcome = await Promise.race([
      job.then(() => ({ settled: true, error: null }), (error) => ({ settled: true, error })),
      sleep(Math.max(0, Number(waitMs) || 0)).then(() => ({ settled: false, error: null })),
    ]);
    if (outcome.error) throw outcome.error;
    if (outcome.settled) return { ...publicRun(run), finished: true, reportTool: RESULT_TOOL };
    // 竞态保护：超时那一刻刚好跑完，就别再补一条回报。
    if (run.status === "running") run.notifyOnFinish = true;
    return {
      ...publicRun(run),
      finished: false,
      reportTool: RESULT_TOOL,
      note: `真实测卡已经在酒馆里跑起来了（共 ${run.turns} 幕），还在逐幕生成。现在不要下结论，也不用重复发起；跑完会自动回到这个对话，你随时可以用 ${RESULT_TOOL} 带 runId 查进度。`,
    };
  }

  /**
   * 跑完回报。测卡是分钟级任务，用户不该守着窗口等：
   * 有会话编号就往那个会话投一条普通消息，宿主会让模型接着处理。
   * 投不出去不算测卡失败（成绩单和进度都在），只记一条 warning 说清楚。
   */
  async function notifyRunFinished(run) {
    const scope = run.scope || {};
    if (!scope.sessionId) {
      run.warnings.push(`这次测卡没有可用于回报的会话编号，跑完没有自动叫醒对话；请用 ${RESULT_TOOL} 主动查询。`);
      return false;
    }
    const head = run.status === "done"
      ? `真实测卡跑完了（${run.characterName || run.characterId || "角色卡"}，共 ${run.scenes.length} 幕）`
      : `真实测卡没有跑完（${run.error || "原因未记录"}）`;
    try {
      const result = await ctx.bus.request("session:send", {
        sessionId: scope.sessionId,
        scope: "all",
        text: `${head}。runId: ${run.runId}。用 ${RESULT_TOOL} 取这次的过程、变量和体检结论，然后在主对话里给出判断和建议。`,
      });
      if (result?.accepted !== true) throw new Error("宿主没有确认接纳这条测卡回报。");
      return true;
    } catch (error) {
      run.warnings.push(`测卡跑完了，但没能自动回报到对话（${error?.message || String(error)}）；请用 ${RESULT_TOOL} 主动查询。`);
      return false;
    }
  }

  /** 落一份只读成绩单；写不进去只记 warning，不让它掩盖测卡结果。 */
  function reportRun(run, startedAt) {
    try {
      writeTheaterReport(ctx.dataDir, {
        runId: run.runId,
        mode: run.mode,
        status: run.status,
        characterId: run.characterId,
        characterName: run.characterName,
        testType: run.testType,
        objective: run.objective,
        chatFile: run.chatFile,
        startedAt: new Date(startedAt).toISOString(),
        finishedAt: new Date().toISOString(),
        durationMs: Date.now() - startedAt,
        opening: run.opening,
        scenes: run.scenes,
        initialVariables: run.initialVariables,
        finalVariables: run.finalVariables,
        initialVariableSource: run.initialVariableSource,
        finalVariableSource: run.finalVariableSource,
        mvuAvailable: run.mvuAvailable,
        warnings: run.warnings,
        notes: run.notes,
        error: run.error,
        scope: run.scope,
      });
      return true;
    } catch (error) {
      run.warnings.push(`这次的过程没能写成成绩单（${error?.message || String(error)}），只能靠对话记录回看。`);
      return false;
    }
  }

  // ── 代笔对戏 ──────────────────────────────────────────────────────────────

  async function performDuetStart(input, scope) {
    purge();
    if (duets.size) throw new Error("已有一场代笔对戏在进行，请先结束它。");
    // 卡片可能已经建好 pending（有 runId），必须复用，否则卡片永远停在等待。
    const target = resolveTargetRun(input, scope, "duet");
    const characterId = text(input?.characterId ?? input?.characterFile, 200);
    const characterName = text(input?.characterName, 80);
    if (!characterId && !characterName && !target?.characterId) throw new Error("代笔对戏需要指定酒馆里的角色卡。");
    const pace = resolveDuetPace(input?.pace ?? target?.pace ?? target?.paceLabel);
    const duetId = target?.runId || `duet-${Date.now()}-${randomUUID().slice(0, 8)}`;
    const chatFile = target?.chatFile || `${DUET_CHAT_PREFIX}${duetId}`;
    await fs.rm(cancelPathFor(duetId), { force: true });
    const selectedCharacterId = characterId || target?.characterId || '';
    const selectedCharacterName = characterName || target?.characterName || '';
    // 卡片建的 pending 记着 sessionId，而工具调用只带 sessionPath。两边都过了 ownedBy，
    // 合并起来这一轮跑完才有会话可回报；只留工具那半边，异步跑完时就找不到该叫醒谁了
    // （测卡那边早就这么合并，对戏这条漏了）。
    const mergedScope = normalizeScope({
      sessionId: scope.sessionId || target?.scope?.sessionId,
      sessionPath: scope.sessionPath || target?.scope?.sessionPath,
      agentId: scope.agentId || target?.scope?.agentId,
      callToken: scope.callToken || target?.scope?.callToken,
    });
    const preparing = target || { runId: duetId, mode: 'duet', scope: mergedScope, scopeKeys: mergedScope.keys, createdAt: Date.now(), scenes: [] };
    Object.assign(preparing, { status: 'running', characterId: selectedCharacterId, characterName: selectedCharacterName, chatFile, pace: pace.id, objective: text(input?.objective ?? target?.objective, MAX_OBJECTIVE_CHARS), updatedAt: Date.now() });
    rememberTask(preparing); runs.set(duetId, preparing);
    let data;
    try { data = await runWorkerJob({ action: 'duet-start', runId: duetId, characterId: selectedCharacterId, characterName: selectedCharacterName, chatFile }); }
    catch (error) {
      preparing.status = 'interrupted'; preparing.error = `对戏开场未完成：${error.message}`;
      updateTask(duetId, { status: 'interrupted' });
      throw error;
    }
    const record = {
      runId: duetId,
      duetId,
      mode: "duet",
      status: "running",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      characterId: selectedCharacterId,
      characterName: data.character?.name || selectedCharacterName,
      chatFile,
      opening: data.opening || "",
      initialVariables: data.initialVariables ?? null,
      initialVariableSource: data.initialVariableSource || "unavailable",
      mvuAvailable: data.mvuAvailable === true,
      scenes: [],
      isolated: true,
      engine: "sillytavern-runtime",
      warnings: data.initialVariables === null
        ? ["对戏开场没有读到变量，MVU 是否生效暂时无法确认。"]
        : [],
      error: null,
      scope: mergedScope,
      scopeKeys: mergedScope.keys,
      pace: pace.id,
      paceLabel: pace.label,
      pausePolicy: pace.pausePolicy,
      maxAutoRounds: pace.maxAutoRounds,
      autoRoundsSinceCheckpoint: 0,
      needsUserCheckpoint: false,
      objective: text(input?.objective ?? target?.objective, MAX_OBJECTIVE_CHARS),
      progressPath: "",
      cancelPath: cancelPathFor(duetId),
    };
    duets.set(duetId, record);
    runs.set(duetId, record);
    dropScopeBinding(duetId);
    // 归属落盘：重启后仍能证明这个临时聊天前缀属于哪个会话。
    rememberTask(record);
    recordRunVariables(ctx.dataDir, duetId, {
      characterId: record.characterId,
      characterName: record.characterName,
      chatFile: record.chatFile,
      sessionId: mergedScope.sessionId,
      sessionPath: mergedScope.sessionPath,
      agentId: mergedScope.agentId,
      mode: "duet",
      initialVariables: record.initialVariables,
      finalVariables: null,
      initialVariableSource: record.initialVariableSource,
      finalVariableSource: "unavailable",
      mvuAvailable: record.mvuAvailable,
    });
    return publicRun(record);
  }

  function requireDuet(duetId, scope) {
    const id = text(duetId, 80);
    const record = duets.get(id);
    if (!record) {
      const recovered = runs.get(id);
      if (recovered?.status === "interrupted") {
        throw new Error("这场对戏已在重载时中断，只能清理它留下的临时聊天或重新开始。");
      }
      throw new Error("代笔对戏会话不存在或已结束，请重新开始一场。");
    }
    if (!ownedBy(record, scope)) throw new Error("这场对戏不属于当前对话。");
    return record;
  }

  /** 一轮跑完之后落账：推进幕、更新节奏计数、记变量、给对外快照。 */
  function settleDuetTurn(record, scene, { checkpoint, maxAutoRounds }) {
    record.scenes.push(scene);
    record.pendingTurn = null;
    record.updatedAt = Date.now();
    if (checkpoint) {
      record.autoRoundsSinceCheckpoint = 0;
      record.needsUserCheckpoint = false;
    } else {
      record.autoRoundsSinceCheckpoint += 1;
      if (record.autoRoundsSinceCheckpoint >= maxAutoRounds) record.needsUserCheckpoint = true;
    }
    if (scene.variablesAfter === null && record.warnings.length < 3) {
      record.warnings.push("这一轮没有读到变量，MVU 变化无法核对。");
    }
    // 对戏的变量也要入账，否则模型永远查不到对戏读到了什么。
    recordRunVariables(ctx.dataDir, record.duetId, {
      characterId: record.characterId,
      characterName: record.characterName,
      chatFile: record.chatFile,
      sessionId: record.scope?.sessionId,
      sessionPath: record.scope?.sessionPath,
      agentId: record.scope?.agentId,
      mode: "duet",
      initialVariables: record.initialVariables,
      finalVariables: scene.variablesAfter ?? null,
      initialVariableSource: record.initialVariableSource,
      finalVariableSource: scene.variableSource || "unavailable",
      mvuAvailable: scene.variablesAfter !== null,
    });
    return {
      ...publicRun(record),
      scene,
      pace: {
        id: record.pace,
        label: record.paceLabel,
        pausePolicy: record.pausePolicy,
        maxAutoRounds,
        autoRoundsSinceCheckpoint: record.autoRoundsSinceCheckpoint,
        needsUserCheckpoint: record.needsUserCheckpoint,
      },
    };
  }

  /**
   * 一轮跑完（或跑挂）之后回报发起会话，模型据此决定继续还是暂停。
   * 没有会话编号就不发（工具直调的场景本来就不该往某个会话乱投），只记一条 warning。
   */
  async function notifyDuetTurn(record, error) {
    const scope = record.scope || {};
    if (!scope.sessionId) {
      record.warnings.push(`这一轮没有可用于回报的会话编号，跑完没有自动叫醒对话；请用 ${RESULT_TOOL} 主动查询。`);
      return false;
    }
    const head = error
      ? `代笔对戏这一轮没跑完（${error?.message || error}）`
      : `代笔对戏推进到第 ${record.scenes.length} 轮（${record.characterName || record.characterId || "角色卡"}）`;
    try {
      const result = await ctx.bus.request("session:send", {
        sessionId: scope.sessionId,
        scope: "all",
        text: `${head}。duetId: ${record.duetId}。要接着往下推就用 hanabrew-duet-turn，或者趁这个节点停下来问我；结果也能用 ${RESULT_TOOL} 查。`,
      });
      if (result?.accepted !== true) throw new Error("宿主没有确认接纳这条回报。");
      return true;
    } catch (err) {
      record.warnings.push(`这一轮跑完了，但没能自动回报到对话（${err?.message || String(err)}）；请用 ${RESULT_TOOL} 主动查询。`);
      return false;
    }
  }

  /**
   * 推进一轮代笔对戏。
   * 跟测卡同一个道理：宿主对 App 工具执行有 30 秒回调上限，而真实生成一二十秒起步、
   * 卡住还要等单幕硬超时，同步等必然被回包砍断（2026-10-11 实测确认）。
   * 所以启动后最多等 TOOL_WAIT_MS，没回来就先返回「这一轮还在跑」，跑完再回报一条。
   */
  async function performDuetTurn(input, scope, waitMs = TOOL_WAIT_MS) {
    const record = requireDuet(input?.duetId ?? input?.runId, scope);
    const playerMessage = text(input?.playerMessage ?? input?.text, 2000);
    if (!playerMessage) throw new Error("代笔对戏这一轮没有可发送的玩家台词。");
    // 节奏上限：自动推进到顶必须交回控制权，不让模型一路写下去。
    const checkpoint = input?.checkpoint === true;
    const maxAutoRounds = record.maxAutoRounds || 1;
    if (!checkpoint && record.needsUserCheckpoint) {
      throw new Error("这场对戏已到自动推进上限，请先给方向或确认 checkpoint 再继续。");
    }
    // 同一场对戏一次只能推进一轮：上一轮还在生成时再发一轮，两边的临时聊天状态会打架。
    if (record.pendingTurn) throw new Error("上一轮还在生成，等它回来再推进这场对戏。");
    const sceneIndex = Number(input?.sceneIndex) || record.scenes.length + 1;
    record.pendingTurn = { index: sceneIndex, user: playerMessage };
    const job = runWorkerJob({
      action: "duet-turn",
      runId: record.duetId,
      characterId: record.characterId,
      characterName: record.characterName,
      chatFile: record.chatFile,
      text: playerMessage,
      sceneIndex,
    });
    const outcome = await Promise.race([
      job.then((data) => ({ settled: true, data, error: null }), (error) => ({ settled: true, data: null, error })),
      sleep(Math.max(0, Number(waitMs) || 0)).then(() => ({ settled: false, data: null, error: null })),
    ]);
    if (outcome.error) {
      record.pendingTurn = null;
      throw outcome.error;
    }
    if (outcome.settled) {
      return settleDuetTurn(record, outcome.data?.scene || {}, { checkpoint, maxAutoRounds });
    }
    job.then(
      (data) => {
        settleDuetTurn(record, data?.scene || {}, { checkpoint, maxAutoRounds });
        notifyDuetTurn(record).catch(() => {});
      },
      (error) => {
        record.pendingTurn = null;
        record.warnings.push(`这一轮没有跑完：${error?.message || error}`);
        record.updatedAt = Date.now();
        notifyDuetTurn(record, error).catch(() => {});
      },
    ).catch(() => {});
    return {
      ...publicRun(record),
      turnPending: true,
      note: `这一轮还在真实酒馆里生成（第 ${sceneIndex} 轮）。不要重复发起；跑完会自动回到这个对话，也可以随时用 ${RESULT_TOOL} 带 duetId 查进度。`,
    };
  }

  async function performDuetEnd(input, scope) {
    const duetId = text(input?.duetId ?? input?.runId, 80);
    const record = duets.get(duetId);
    if (record && !ownedBy(record, scope)) throw new Error("这场对戏不属于当前对话。");
    // 归属证明：内存里没有就查落盘的账。没有账就拒绕 ——
    // 拿 duetId 拼前缀去删，可能删掉另一个会话的临时聊天。
    let owned = null;
    try {
      owned = readTaskLedger()[duetId] || null;
    } catch (error) {
      throw new Error(`${error.message} 这次没有删除任何临时聊天。`);
    }
    if (!record && !owned) {
      throw new Error("没有找到这场对戏的归属记录，拒绝按编号盲删临时聊天；请先确认对戏编号或重新开始。");
    }
    if (!record && !ownedBy({ scope: { sessionId: owned.sessionId, sessionPath: owned.sessionPath, agentId: owned.agentId } }, scope)) {
      throw new Error("这场对戏不属于当前对话。");
    }
    const chatFile = record?.chatFile || owned.chatFile;
    const data = await runWorkerJob({
      action: "duet-end",
      runId: duetId,
      cleanupPrefix: chatFile,
    });
    duets.delete(duetId);
    forgetTask(duetId);
    runs.delete(duetId);
    if (record) {
      Object.assign(record, { status: "done", updatedAt: Date.now(), cleanedChats: data.cleanedChats });
      dropScopeBinding(duetId);
    }
    return { duetId, ended: true, alreadyEnded: !record, cleanedChats: data.cleanedChats || 0 };
  }

  // ── 常规聊天（旧 tavern-chat 的替代，不走临时测卡链）────────────────────────

  async function performChat(input, scope) {
    const characterId = text(input?.characterId ?? input?.characterFile, 200);
    const characterName = text(input?.characterName, 80);
    if (!characterId && !characterName) throw new Error("聊天需要指定酒馆里的角色卡。");
    const message = text(input?.message, 2000);
    if (!message) throw new Error("聊天缺少要发送的内容。");
    // 这一路用角色自己的正式聊天，不创建也不删除任何临时聊天文件。
    const data = await runWorkerJob({
      action: "chat",
      runId: `chat-${Date.now()}-${randomUUID().slice(0, 6)}`,
      characterId,
      characterName,
      text: message,
      chatId: text(input?.chatId, 120),
    });
    return {
      character: data.character,
      chatFile: data.chatFile || "",
      message,
      reply: data.reply || "",
      variables: data.variables ?? null,
      variableSource: data.variableSource || "unavailable",
      mvuAvailable: data.mvuAvailable === true,
      scope: { sessionId: scope.sessionId, agentId: scope.agentId },
      engine: "sillytavern-runtime",
    };
  }

  /** 串行化：酒馆页面状态是全局的，同一时刻只允许一个真实任务在跑。 */
  function enqueue(task) {
    const pending = tail.then(task);
    tail = pending.catch(() => {});
    return pending;
  }

  return {
    /** 卡片只创建 pending：测试目标由模型按用户意图填 turns，UI 交接走 hana.chat.sendMessage。 */
    submit(input, scope) {
      purge();
      // 只有 agentId 会在 normalizeScope 里被拒（没有会话就不能建立归属）。
      const normalized = normalizeScope(scope);
      const mode = text(input?.mode, 20) === "duet" ? "duet" : "scripted";
      const runId = `${mode === "duet" ? "duet" : "theater"}-${Date.now()}-${randomUUID().slice(0, 8)}`;
      const run = {
        runId,
        mode,
        status: mode === "duet" ? "waiting_for_direction" : "waiting",
        createdAt: Date.now(),
        updatedAt: Date.now(),
        characterId: text(input?.characterId ?? input?.characterFile, 200),
        characterName: text(input?.characterName, 80),
        testType: text(input?.testType, 40),
        // 方向原样保留：卡片允许写 4000 字，截短就等于把用户写的戏丢了。
        objective: text(input?.objective ?? input?.detail, MAX_OBJECTIVE_CHARS),
        chatFile: "",
        turns: [],
        currentTurnIndex: 0,
        activeScene: null,
        opening: "",
        scenes: [],
        initialVariables: null,
        finalVariables: null,
        initialVariableSource: "unavailable",
        finalVariableSource: "unavailable",
        mvuAvailable: null,
        isolated: false,
        engine: "sillytavern-runtime",
        warnings: [],
        error: null,
        scope: normalized,
        scopeKeys: normalized.keys,
        pace: text(input?.pace, 20),
        paceLabel: text(input?.paceLabel, 20),
        progressPath: "",
        cancelPath: "",
      };
      // 先落盘再进内存：快照写失败就不能假装任务存下来了。
      rememberTask(run);
      runs.set(runId, run);
      bindScope(normalized, runId);
      return publicRun(run);
    },

    progress(runId, scope) {
      purge();
      const run = runs.get(text(runId, 80));
      if (!run) throw new Error("测试过程不存在、已过期或不属于当前对话。");
      if (!ownedBy(run, normalizeScope(scope))) {
        throw new Error("测试过程不存在、已过期或不属于当前对话。");
      }
      return publicRun(run);
    },

    pending(scope) {
      purge();
      const normalized = normalizeScope(scope);
      return [...runs.values()].filter(run => ownedBy(run, normalized) && ['waiting', 'waiting_for_direction', 'interrupted'].includes(run.status)).sort((a, b) => b.createdAt - a.createdAt).map(publicRun);
    },

    /**
     * 卡片恢复用：当前会话里最近一条还没结束的任务。
     * pending 只认「还没开始」的任务，对戏一旦跑起来状态就是 running，
     * 卡片被收回再打开（或宿主重启后重建）时只靠 pending 找不到它，会迷路回选择页。
     */
    active(scope) {
      purge();
      const normalized = normalizeScope(scope);
      return [...runs.values()]
        .filter(run => ownedBy(run, normalized) && !['done', 'error', 'cancelled', 'ended'].includes(run.status))
        .sort((a, b) => b.createdAt - a.createdAt)
        .map(publicRun)[0] || null;
    },

    /** 模型侧按目标领取一条 pending（同会话 FIFO），用于把用户意图和卡片对上。 */
    claim(scope, input = {}) {
      const candidate = claimPending(normalizeScope(scope), input);
      return candidate ? publicRun(candidate) : null;
    },

    control(input, scope) {
      purge();
      const runId = text(input?.runId, 80);
      const run = runs.get(runId);
      if (!run || !ownedBy(run, normalizeScope(scope))) {
        throw new Error("测试过程不存在、已过期或不属于当前对话。");
      }
      const action = text(input?.action, 20);
      if (action === "cancel") {
        // 先持久写入取消信号，再清快照；任一步失败都不伪报完全取消。
        const cancelPath = run.cancelPath || cancelPathFor(run.runId);
        fsSync.mkdirSync(path.dirname(cancelPath), { recursive: true });
        fsSync.writeFileSync(cancelPath, 'cancel', { mode: 0o600 });
        forgetTask(run.runId);
        run.status = "error";
        run.error = run.chatFile ? '取消信号已记录；中断遗留的临时聊天如仍存在会保留待检查，原始聊天不动。' : '已取消。';
        run.updatedAt = Date.now();
        return publicRun(run);
      }
      if (action === "end") {
        if (run.mode !== "duet") throw new Error("只有代笔对戏可以从卡片结束。");
        if (!run.chatFile && ['waiting', 'waiting_for_direction'].includes(run.status)) {
          forgetTask(run.runId); dropScopeBinding(run.runId);
          run.status = 'ended'; run.updatedAt = Date.now();
          return publicRun(run);
        }
        return enqueue(() => performDuetEnd({ duetId: runId }, scope));
      }
      throw new Error("不支持的测卡操作。");
    },

    run: (input, scope) => enqueue(() => performRun(input, normalizeScope(scope))),
    startRun: (input, scope, waitMs) => startRun(input, normalizeScope(scope), waitMs),
    duetStart: (input, scope) => enqueue(() => performDuetStart(input, normalizeScope(scope))),
    duetTurn: (input, scope, waitMs) => enqueue(() => performDuetTurn(input, normalizeScope(scope), waitMs)),
    duetEnd: (input, scope) => enqueue(() => performDuetEnd(input, normalizeScope(scope))),
    chat: (input, scope) => enqueue(() => performChat(input, normalizeScope(scope))),

    /**
     * 成绩单入口：带 runId 先看内存里那次（可能还在跑，能拿到实时进度），
     * 内存里没有就回读落盘的只读成绩单；不带 runId 列当前会话最近几份。
     */
    report(runId, scope, limit) {
      const normalized = normalizeScope(scope);
      const id = text(runId, 120);
      if (!id) return { history: listTheaterReports(ctx.dataDir, limit, normalized) };
      const live = runs.get(id);
      if (live && ownedBy(live, normalized)) return publicRun(live);
      const stored = readTheaterReport(ctx.dataDir, id, normalized);
      if (!stored) throw new Error("这次测卡的成绩单不存在、已过期或不属于当前对话。");
      return stored;
    },

    /** 变量回查也按会话判：没有 scope 就什么都不给。 */
    variables(runId, scope) {
      const normalized = normalizeScope(scope);
      return readRunVariables(ctx?.dataDir, text(runId, 80), normalized);
    },
    variablesHistory(limit, scope) {
      if (!scope || (!scope.sessionId && !scope.sessionPath)) {
        throw new Error("回查变量必须带会话标识；没有会话就不返回任何账本。");
      }
      return listRunVariables(ctx?.dataDir, limit, normalizeScope(scope));
    },

    async dispose() {
      disposed = true;
      for (const run of runs.values()) {
        if (run.cancelPath && run.status === "running") {
          fs.writeFile(run.cancelPath, "cancel", "utf8").catch(() => {});
        }
      }
      await Promise.all([...active].map((id) => ctx.runtime.stop?.(id).catch(() => {})));
      active.clear();
      runs.clear();
      duets.clear();
      pendingByScope.clear();
    },
  };
}

export const theaterServiceDefaults = {
  runTtlMs: RUN_TTL_MS,
  duetTtlMs: DUET_TTL_MS,
  maxTurns: MAX_TURNS,
  defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
};