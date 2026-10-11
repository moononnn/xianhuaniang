import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createTheaterService, normalizeScope, perTurnTimeoutMs } from "../backend/theater-service.js";
import { registerTavernTools } from "../backend/tavern-tools.js";
import { applyJsonPatch, extractJsonPatch, listRunVariables, parseJsonPointer, pointerGet, readRunVariables, recordRunVariables } from "../backend/mvu.js";

const appDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function tempDataDir() {
  return fs.mkdtempSync(path.join(path.dirname(appDir), ".theater-data-"));
}

/** Windows 上 worker 刚写完就删目录会撞 ENOTEMPTY，重试几次即可。 */
function cleanupDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 60 });
}

/**
 * 假宿主：给一个可控的 runtime.start。
 * mode='ok' 回一份带变量的结果；'nullVars' 回变量为 null；'fail' 抛错；'never' 永远不出结果文件。
 * opts.delayMs 让 worker 晚一点交结果，用来测「工具先返回、任务后台跑完」那条路。
 */
function fakeCtx(dataDir, mode = "ok", opts = {}) {
  const started = [];
  const busCalls = [];
  const ctx = {
    dataDir,
    started,
    busCalls,
    bus: {
      async request(type, input) { busCalls.push([type, input]); return { accepted: true }; },
    },
    runtime: {
      async start(options) {
        started.push(options);
        if (mode === "startFail") throw new Error("受管运行时拒绝启动");
        const runtimeId = `rt-${started.length}`;
        // 模拟 worker 干活：写结果文件。
        (async () => {
          const [, resultPath] = options.args;
          if (mode === "never") return;
          if (opts.delayMs) await new Promise((resolve) => setTimeout(resolve, opts.delayMs));
          await fsp.mkdir(path.dirname(resultPath), { recursive: true });
          if (mode === "fail") {
            await fsp.writeFile(resultPath, JSON.stringify({ ok: false, error: "酒馆这次没有产出回复正文，测卡结果无法确认" }));
            return;
          }
          const nullVars = mode === "nullVars";
          await fsp.writeFile(resultPath, JSON.stringify({
            ok: true,
            data: {
              character: { name: "小花", index: 0 },
              chatFile: "hanabrew-v2-theater-x",
              opening: "……",
              initialVariables: nullVars ? null : { 好感度: 1 },
              finalVariables: nullVars ? null : { 好感度: 4 },
              initialVariableSource: nullVars ? "unavailable" : "Mvu.getMvuData",
              finalVariableSource: nullVars ? "unavailable" : "Mvu.getMvuData",
              mvuAvailable: !nullVars,
              scenes: [{ index: 1, user: "在吗", reply: "在。", variablesBefore: { 好感度: 1 }, variablesAfter: { 好感度: 4 }, variableChanges: [{ key: "好感度", before: 1, after: 4 }] }],
              engine: "sillytavern-runtime",
              isolated: true,
            },
          }));
        })();
        return { runtimeId };
      },
      async get() { return { state: "running" }; },
      async stop() {},
    },
    async ensureServer() {},
    logger: { info() {}, warn() {}, error() {} },
  };
  return ctx;
}

const STUB_DEPS = {
  ensureServer: async () => ({ serverUrl: "http://127.0.0.1:18511/" }),
  runtimeStatus: async () => ({ ready: true, state: "ready", serviceState: "ready", serverUrl: "http://127.0.0.1:18511/" }),
};

// 酒馆就绪判定不依赖真实运行时，测试直接注入假的 ensureServer/runtimeStatus。
async function withStubbedRuntime(fn) {
  return fn();
}

function serviceWith(ctx, mode) {
  return createTheaterService(ctx, STUB_DEPS);
}

test('取消pending后明确重试会清掉旧信号，并只凭runId沿用已选角色', async () => {
  const dir = tempDataDir(); const ctx = fakeCtx(dir); const originalStart = ctx.runtime.start;
  ctx.runtime.start = async options => {
    const request = JSON.parse(fs.readFileSync(options.args[0], 'utf8'));
    assert.equal(request.characterId, 'target.png'); assert.equal(fs.existsSync(request.cancelPath), false);
    return originalStart(options);
  };
  const service = serviceWith(ctx); const scope = { sessionId: 'retry-scope' };
  try {
    const pending = service.submit({ characterFile: 'target.png' }, scope);
    service.control({ runId: pending.runId, action: 'cancel' }, scope);
    assert.equal((await service.run({ runId: pending.runId, turns: ['hello'] }, scope)).status, 'done');
  } finally { await service.dispose(); cleanupDir(dir); }
});

test('尚未开跑的对戏可以结束，不启动worker或猜前缀清理', async () => {
  const dir = tempDataDir(); const ctx = fakeCtx(dir); const service = serviceWith(ctx); const scope = { sessionId: 'pending-duet' };
  try {
    const run = service.submit({ mode: 'duet', characterFile: 'target.png' }, scope);
    assert.equal(service.control({ runId: run.runId, action: 'end' }, scope).status, 'ended');
    assert.equal(ctx.started.length, 0); assert.equal(service.pending(scope).length, 0);
  } finally { await service.dispose(); cleanupDir(dir); }
});

test('对戏开场失败保留中断归属；不再永远停在running', async () => {
  const dir = tempDataDir(); const ctx = fakeCtx(dir, 'fail'); const service = serviceWith(ctx); const scope = { sessionId: 'failed-duet' };
  try {
    const run = service.submit({ mode: 'duet', characterFile: 'target.png' }, scope);
    await assert.rejects(service.duetStart({ runId: run.runId }, scope), /没有产出/);
    assert.equal(service.progress(run.runId, scope).status, 'interrupted');
    const request = JSON.parse(fs.readFileSync(path.join(dir, 'theater-tasks.json'), 'utf8'))[run.runId];
    assert.equal(request.status, 'interrupted'); assert.ok(request.chatFile);
  } finally { await service.dispose(); cleanupDir(dir); }
});

// ── scope 归属 ──────────────────────────────────────────────────────────────

test("scope 归一化：只认会话，agentId 不能当归属依据", () => {
  assert.deepEqual(normalizeScope({ sessionId: "s1" }).keys, ["sessionId:s1"]);
  assert.deepEqual(normalizeScope({ sessionPath: "C:/h/x.jsonl" }).keys, ["sessionPath:c:\\h\\x.jsonl"]);
  // 只有 agentId 或什么都没有都不给归属：同一伙伴的两个会话不能互相读到测卡。
  assert.throws(() => normalizeScope({ agentId: "partner-a" }), /必须绑定到具体会话/);
  assert.throws(() => normalizeScope({}), /必须绑定到具体会话/);
});

test("测卡与诊断工具全部挂在 hanabrew-* 命名空间下且不重名", async () => {
  const dir = tempDataDir();
  const registered = [];
  const ctx = {
    ...fakeCtx(dir, "ok"),
    tools: {
      async register(spec) {
        registered.push(spec.name);
        return async () => {};
      },
    },
  };
  const cleanup = await registerTavernTools(ctx);
  assert.equal(registered.length, 9, "只注册测卡/对戏/聊天/变量/诊断/开卡/取结果这一批，不重复注册 admin");
  for (const name of registered) assert.match(name, /^hanabrew-/);
  assert.deepEqual(registered.sort(), [
    "hanabrew-card-test", "hanabrew-chat", "hanabrew-debug", "hanabrew-duet-end",
    "hanabrew-duet-start", "hanabrew-duet-turn", "hanabrew-open-theater",
    "hanabrew-test-result", "hanabrew-test-variables",
  ].sort());
  assert.equal(new Set(registered).size, registered.length, "重名会让整个应用 failed");
  await cleanup();
  cleanupDir(dir);
});

test("admin 注册失败也不影响测卡这批工具", async () => {
  const dir = tempDataDir();
  const registered = [];
  const ctx = {
    ...fakeCtx(dir, "ok"),
    tools: {
      async register(spec) {
        // admin 那三个名字由 App 入口独立注册，这里假装撞名被拒。
        if (registered.includes(spec.name)) throw new Error("duplicate tool name");
        registered.push(spec.name);
        return async () => {};
      },
    },
  };
  const service = serviceWith(ctx);
  const cleanup = await registerTavernTools(ctx, service);
  assert.ok(registered.includes("hanabrew-card-test"));
  await cleanup();
  await service.dispose();
  cleanupDir(dir);
});

test('工具上下文以宿主盖章的路径与令牌为准，不信模型自报的 scope，也不再绕 session:get', async () => {
  let spec, captured;
  const busCalls = [];
  const ctx = {
    tools: { register: async value => { if (value.name === 'hanabrew-card-test') spec = value; return () => {}; } },
    bus: { request: async (type, input) => { busCalls.push([type, input]); return {}; } },
  };
  const cleanup = await registerTavernTools(ctx, { startRun: async (_args, scope) => { captured = scope; return { runId: 'pending-from-ui' }; } });
  const result = await spec.execute({
    runId: 'pending-from-ui',
    turns: ['hello'],
    scope: { sessionId: 'forged' },
    context: { sessionPath: 'C:/mine.jsonl', callToken: 'tok-123', messageId: null, messageText: null },
  });
  assert.notEqual(result.isError, true);
  // 模型自报的 scope 不能进归属；宿主上下文原样保留，令牌另存给投递用。
  assert.deepEqual(captured, { sessionId: '', sessionPath: 'C:/mine.jsonl', agentId: '', callToken: 'tok-123' });
  assert.deepEqual(busCalls, [], '归属判定不再走 session:get：契约里那枚令牌只对 send/send-custom 生效');
  await cleanup();
});

test('投递当前会话优先交 callToken，不自报编号让宿主自己解析', async () => {
  let spec;
  let sent;
  const ctx = {
    tools: { register: async value => { if (value.name === 'hanabrew-open-theater') spec = value; return () => {}; } },
    bus: { request: async (type, input) => { sent = [type, input]; return { entryId: 'e1' }; } },
  };
  const cleanup = await registerTavernTools(ctx, { pending: () => [] });
  await spec.execute({ context: { sessionPath: 'C:/mine.jsonl', callToken: 'tok-9' } });
  assert.equal(sent[0], 'session:send-custom');
  assert.deepEqual(sent[1], {
    scope: 'all',
    callToken: 'tok-9',
    customType: 'theater',
    content: sent[1].content,
    display: true,
    triggerTurn: false,
  });
  // 只铺卡片、不起回合：会话空闲且显式 false 时不需要发起回复的授权。
  assert.equal(sent[1].triggerTurn, false);
  await cleanup();
});

test('只有令牌、没有可核对路径时拒绝执行，不猜归属', async () => {
  let spec;
  const ctx = {
    tools: { register: async value => { if (value.name === 'hanabrew-card-test') spec = value; return () => {}; } },
    bus: { request: async () => ({}) },
  };
  const cleanup = await registerTavernTools(ctx, { run: async () => ({ runId: 'x' }) });
  const result = await spec.execute({ turns: ['x'], context: { sessionPath: null, callToken: 'tok-only' } });
  assert.equal(result.isError, true);
  await cleanup();
});

test("进度与取消按会话隔离：别的会话、同伙伴另一会话都拿不到", async () => {
  const dir = tempDataDir();
  await withStubbedRuntime(async () => {
    const service = serviceWith(fakeCtx(dir));
    const mine = { sessionId: "s-mine", agentId: "partner-a" };
    const otherSessionSameAgent = { sessionId: "s-other", agentId: "partner-a" };
    const theirs = { sessionId: "s-theirs", agentId: "小花" };
    const run = service.submit({ characterId: "小花.png" }, mine);
    assert.equal(run.status, "waiting");
    assert.equal(service.progress(run.runId, mine).runId, run.runId);
    assert.throws(() => service.progress(run.runId, theirs), /不属于当前对话/);
    // 同一伙伴的另一个会话也不能读、不能改。
    assert.throws(() => service.progress(run.runId, otherSessionSameAgent), /不属于当前对话/);
    assert.throws(() => service.control({ runId: run.runId, action: "cancel" }, otherSessionSameAgent), /不属于当前对话/);
    assert.equal(service.control({ runId: run.runId, action: "cancel" }, mine).status, "error");
    // 没会话标识的请求直接拒，不给无主 run 留口子。
    assert.throws(() => service.submit({}, {}), /必须绑定到具体会话/);
    assert.throws(() => service.submit({}, { agentId: "partner-a" }), /必须绑定到具体会话/);
    await service.dispose();
  });
  cleanupDir(dir);
});

test("伪路径与冲突会话一律拒：不能用另一个 key 绕过去", async () => {
  const dir = tempDataDir();
  await withStubbedRuntime(async () => {
    const service = serviceWith(fakeCtx(dir));
    const run = service.submit({ characterId: "小花.png" }, { sessionId: "s1", sessionPath: "C:/real/a.jsonl", agentId: "partner-a" });
    // sessionId 对但 sessionPath 是伪造的：拒。
    assert.throws(() => service.progress(run.runId, { sessionId: "s1", sessionPath: "C:/fake/a.jsonl" }), /不属于当前对话/);
    // 只有伪路径：拒。
    assert.throws(() => service.progress(run.runId, { sessionPath: "C:/fake/a.jsonl" }), /不属于当前对话/);
    // 两个都对：过。
    assert.equal(service.progress(run.runId, { sessionId: "s1", sessionPath: "C:/real/a.jsonl" }).runId, run.runId);
    // sessionId 缺失但路径一致：过。宿主给模型的工具上下文
    // （HanaPluginToolExecuteContextV2）只有 sessionPath，缺字段不等于冲突。
    assert.equal(service.progress(run.runId, { sessionPath: "C:/real/a.jsonl" }).runId, run.runId);
    // 同一条路径但大小写/写法不同：按真实路径归一后仍算同一条会话。
    assert.equal(service.progress(run.runId, { sessionPath: "c:\\REAL\\a.jsonl" }).runId, run.runId);
    await service.dispose();
  });
  cleanupDir(dir);
});

test("submit 只建 pending；claim 按会话 FIFO 领取", async () => {
  const dir = tempDataDir();
  const service = serviceWith(fakeCtx(dir));
  const scope = { sessionId: "s1" };
  const first = service.submit({ characterId: "a.png", mode: "scripted" }, scope);
  const second = service.submit({ characterId: "b.png", mode: "scripted" }, scope);
  assert.equal(first.status, "waiting");
  assert.throws(() => service.claim({ agentId: "partner-a" }), /必须绑定到具体会话/);
  assert.equal(service.claim(scope).runId, first.runId);
  assert.equal(service.claim(scope).runId, second.runId);
  // 领走的 pending 不再重复出现。
  assert.equal(service.claim(scope), null);
  assert.equal(service.progress(first.runId, scope).status, "running");
  assert.doesNotMatch(JSON.stringify(service.progress(first.runId, scope)), /scopeKeys/);
});

// ── 真实测卡链路（走假 runtime，验证编排，不冒充实机）──────────────────────

test("测卡成功：结果落到 progress 与变量账本", async () => {
  const dir = tempDataDir();
  const scope = { sessionId: "s1", sessionPath: "C:/a.jsonl" };
  await withStubbedRuntime(async () => {
    const service = serviceWith(fakeCtx(dir, "ok"));
    const run = await service.run({ characterFile: "小花.png", turns: ["在吗"] }, scope);
    assert.equal(run.scenes.length, 1);
    assert.equal(run.finalVariables.好感度, 4);
    assert.deepEqual(run.warnings, []);
    const stored = readRunVariables(dir, run.runId, scope);
    assert.equal(stored.finalVariables.好感度, 4);
    assert.equal(stored.chatFile, run.chatFile);
    assert.equal(stored.sessionId, "s1");
    await service.dispose();
  });
  cleanupDir(dir);
});

test("变量读不到：给 null 并写明警告，不报成测通", async () => {
  const dir = tempDataDir();
  const scope = { sessionId: "s1", sessionPath: "C:/a.jsonl" };
  await withStubbedRuntime(async () => {
    const service = serviceWith(fakeCtx(dir, "nullVars"));
    const run = await service.run({ characterFile: "小花.png", turns: ["在吗"] }, scope);
    assert.equal(run.status, "done");
    assert.equal(run.finalVariables, null);
    assert.equal(run.mvuAvailable, false);
    assert.equal(run.finalVariableSource, "unavailable");
    assert.match(run.warnings.join(), /全程没有读到变量/);
    const stored = readRunVariables(dir, run.runId, scope);
    assert.equal(stored.finalVariables, null);
    await service.dispose();
  });
  cleanupDir(dir);
});

test("缺台词、缺角色、超幕数在起 worker 前就拒", async () => {
  const dir = tempDataDir();
  await withStubbedRuntime(async () => {
    const ctx = fakeCtx(dir, "ok");
    const service = serviceWith(ctx);
    await assert.rejects(() => service.run({ characterFile: "a.png", turns: [] }, { sessionId: "s" }), /至少需要一句测试台词/);
    await assert.rejects(() => service.run({ turns: ["在吗"] }, { sessionId: "s" }), /需要指定酒馆里的角色卡/);
    await assert.rejects(
      () => service.run({ characterFile: "a.png", turns: Array.from({ length: 13 }, () => "在吗") }, { sessionId: "s" }),
      /最多 12 幕/,
    );
    assert.equal(ctx.started.length, 0, "校验失败不该启动受管运行时");
    await service.dispose();
  });
  cleanupDir(dir);
});

test("worker 报失败：状态记 error，错误原样上抛", async () => {
  const dir = tempDataDir();
  await withStubbedRuntime(async () => {
    const service = serviceWith(fakeCtx(dir, "fail"));
    const scope = { sessionId: "s1" };
    await assert.rejects(
      () => service.run({ characterFile: "小花.png", turns: ["在吗"] }, scope),
      /没有产出回复正文/,
    );
    await service.dispose();
  });
  cleanupDir(dir);
});

test("worker 超时：报未确认，不当作测通", async () => {
  const dir = tempDataDir();
  await withStubbedRuntime(async () => {
    // timeoutMs、宽限与总时限宽限都压到最小，模拟「worker 一直没交结果」；不为等测试而等真超时。
    const service = createTheaterService(fakeCtx(dir, "never"), { ...STUB_DEPS, graceMs: 50, totalGraceMs: 1 });
    await assert.rejects(
      () => service.run({ characterFile: "小花.png", turns: ["在吗"], timeoutMs: 1 }, { sessionId: "s1" }),
      /测卡超时，未收到酒馆完成确认/,
    );
    await service.dispose();
  });
  cleanupDir(dir);
});

test("并发：两次测卡串行执行，不同时切换酒馆页面", async () => {
  const dir = tempDataDir();
  await withStubbedRuntime(async () => {
    const ctx = fakeCtx(dir, "ok");
    const service = serviceWith(ctx);
    const order = [];
    const first = service.run({ characterFile: "a.png", turns: ["1"] }, { sessionId: "s1" }).then(() => order.push("a"));
    const second = service.run({ characterFile: "b.png", turns: ["2"] }, { sessionId: "s2" }).then(() => order.push("b"));
    await Promise.all([first, second]);
    assert.deepEqual(order, ["a", "b"]);
    await service.dispose();
  });
  cleanupDir(dir);
});

test("取消：写 cancel 标记，运行中的测卡被中止", async () => {
  const dir = tempDataDir();
  await withStubbedRuntime(async () => {
    const service = createTheaterService(fakeCtx(dir, "never"), { ...STUB_DEPS, graceMs: 60000 });
    const scope = { sessionId: "s1" };
    const pending = service.run({ characterFile: "a.png", turns: ["在吗"] }, scope);
    await new Promise((resolve) => setTimeout(resolve, 200));
    const submitted = service.submit({ characterId: "a.png" }, scope);
    const cancelled = service.control({ runId: submitted.runId, action: "cancel" }, scope);
    assert.equal(cancelled.status, "error");
    assert.equal(cancelled.error, "已取消。");
    // cancel 会落一个标记文件：worker 轮询到它才中止，自己去清临时聊天。
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(fs.existsSync(path.join(dir, "theater-jobs", `${submitted.runId}.cancel`)), true);
    await service.dispose();
    await assert.rejects(() => pending, /重新加载/);
  });
  cleanupDir(dir);
});

test("重启恢复：dispose 后运行中的 run 写 cancel，新 service 不认旧状态", async () => {
  const dir = tempDataDir();
  await withStubbedRuntime(async () => {
    const first = createTheaterService(fakeCtx(dir, "never"), { ...STUB_DEPS, graceMs: 60000 });
    // 运行中的测卡等很久也没结果，dispose 应立刻把它打断。
    const pending = first.run({ characterFile: "a.png", turns: ["在吗"] }, { sessionId: "s1" });
    await new Promise((resolve) => setTimeout(resolve, 200));
    await first.dispose();
    await assert.rejects(() => pending, /重新加载/);

    // 新实例：变量账本还在（跨重启可回查），但运行态不残留。
    const second = serviceWith(fakeCtx(dir, "ok"));
    assert.throws(() => second.progress("theater-whatever", { sessionId: "s1" }), /不存在/);
    assert.deepEqual(listRunVariables(dir), []);
    await second.dispose();
  });
  cleanupDir(dir);
});

// ── 代笔对戏 ────────────────────────────────────────────────────────────────

test("对戏：同一时间只允许一场，跨对话不能推进别人的对戏", async () => {
  const dir = tempDataDir();
  await withStubbedRuntime(async () => {
    const service = serviceWith(fakeCtx(dir, "ok"));
    const mine = { sessionId: "s-mine" };
    const theirs = { sessionId: "s-theirs" };
    const duet = await service.duetStart({ characterFile: "小花.png" }, mine);
    assert.equal(duet.status, "running");
    assert.match(duet.chatFile, /^hanabrew-v2-duet-/);
    await assert.rejects(() => service.duetStart({ characterFile: "小花.png" }, mine), /已有一场代笔对戏/);
    await assert.rejects(
      () => service.duetTurn({ duetId: duet.duetId, playerMessage: "在吗" }, theirs),
      /不属于当前对话/,
    );
    await assert.rejects(
      () => service.duetTurn({ duetId: duet.duetId, playerMessage: "  " }, mine),
      /没有可发送的玩家台词/,
    );
    await assert.rejects(() => service.duetTurn({ duetId: "duet-nope", playerMessage: "在吗" }, mine), /不存在或已结束/);
    await service.dispose();
  });
  cleanupDir(dir);
});

test("结束对戏：清掉记录并清临时聊天，已失效的也能按前缀再清一次", async () => {
  const dir = tempDataDir();
  await withStubbedRuntime(async () => {
    const service = serviceWith(fakeCtx(dir, "ok"));
    const mine = { sessionId: "s1" };
    const duet = await service.duetStart({ characterFile: "小花.png" }, mine);
    const ended = await service.duetEnd({ duetId: duet.duetId }, mine);
    assert.equal(ended.ended, true);
    assert.equal(ended.alreadyEnded, false);
    // 结束过的那场不再有归属记录：再次结束要拒，不能拿编号盲删。
    await assert.rejects(() => service.duetEnd({ duetId: duet.duetId }, mine), /没有找到这场对戏的归属记录/);
    await service.dispose();
  });
  cleanupDir(dir);
});

test("control 只允许 cancel 与对戏 end", async () => {
  const dir = tempDataDir();
  await withStubbedRuntime(async () => {
    const service = serviceWith(fakeCtx(dir));
    const scope = { sessionId: "s1" };
    const scripted = service.submit({ characterId: "a.png", mode: "scripted" }, scope);
    const duet = service.submit({ characterId: "a.png", mode: "duet" }, scope);
    assert.throws(() => service.control({ runId: scripted.runId, action: "end" }, scope), /只有代笔对戏/);
    assert.throws(() => service.control({ runId: duet.runId, action: "burn" }, scope), /不支持的测卡操作/);
    await service.dispose();
  });
  cleanupDir(dir);
});

// ── 常规聊天：不走临时测卡链 ──────────────────────────────────────────────

test("UI submit → 工具 run 复用同一个 runId，目标与卡片一致", async () => {
  const dir = tempDataDir();
  await withStubbedRuntime(async () => {
    const service = serviceWith(fakeCtx(dir, "ok"));
    const scope = { sessionId: "s1", sessionPath: "C:/a.jsonl" };
    const pending = service.submit({ characterFile: "小花.png", objective: "看看好感度会不会涨" }, scope);
    assert.equal(pending.status, "waiting");
    assert.equal(pending.scenes.length, 0);

    const run = await service.run({ runId: pending.runId, characterFile: "小花.png", turns: ["在吗"] }, scope);
    // 关键：真实执行跑在卡片那条 run 上，progress 才有 scenes 可看。
    assert.equal(run.runId, pending.runId);
    assert.equal(run.status, "done");
    assert.equal(run.scenes.length, 1);
    assert.equal(run.objective, "看看好感度会不会涨");
    assert.equal(service.progress(pending.runId, scope).scenes.length, 1);
    assert.equal(readRunVariables(dir, pending.runId, scope).finalVariables.好感度, 4);
    await service.dispose();
  });
  cleanupDir(dir);
});

test("runId 传错就拒：别人的编号、形态不符、角色不符都不动", async () => {
  const dir = tempDataDir();
  await withStubbedRuntime(async () => {
    const ctx = fakeCtx(dir, "ok");
    const service = serviceWith(ctx);
    const mine = { sessionId: "s1" };
    const theirs = { sessionId: "s2" };
    const pending = service.submit({ characterFile: "小花.png" }, mine);
    await assert.rejects(() => service.run({ runId: pending.runId, turns: ["在"] }, theirs), /不属于当前对话/);
    await assert.rejects(() => service.run({ runId: pending.runId, turns: ["在"] }, { agentId: "partner-a" }), /必须绑定到具体会话/);
    await assert.rejects(() => service.run({ runId: pending.runId, characterFile: "别人.png", turns: ["在"] }, mine), /角色和当前指定的角色对不上/);
    // 对戏形态的 pending 不能拿来做脚本测卡。
    const duetPending = service.submit({ characterFile: "小花.png", mode: "duet" }, mine);
    await assert.rejects(() => service.run({ runId: duetPending.runId, turns: ["在"] }, mine), /形态和当前操作对不上/);
    await assert.rejects(() => service.run({ runId: "theater-不存在", turns: ["在"] }, mine), /编号不存在/);
    assert.equal(ctx.started.length, 0, "校验不过不该起 worker");
    await service.dispose();
  });
  cleanupDir(dir);
});

test("不给 runId 时只认领同会话同角色的 pending，不会抓别人的", async () => {
  const dir = tempDataDir();
  await withStubbedRuntime(async () => {
    const service = serviceWith(fakeCtx(dir, "ok"));
    const pending = service.submit({ characterFile: "小花.png" }, { sessionId: "s1" });
    const run = await service.run({ characterFile: "小花.png", turns: ["在吗"] }, { sessionId: "s1" });
    assert.equal(run.runId, pending.runId);
    // 另一个会话的 pending 不被这次认领顺带拿走。
    const other = service.submit({ characterFile: "小花.png" }, { sessionId: "s2" });
    assert.equal(service.progress(other.runId, { sessionId: "s2" }).status, "waiting");
    await service.dispose();
  });
  cleanupDir(dir);
});

test("变量回查不传 scope 直接拒：不能拿全账本", async () => {
  const dir = tempDataDir();
  await withStubbedRuntime(async () => {
    const service = serviceWith(fakeCtx(dir, "ok"));
    await assert.rejects(async () => service.variablesHistory(20, {}), /必须带会话标识/);
    await assert.rejects(async () => service.variablesHistory(20, { agentId: "partner-a" }), /必须带会话标识/);
    assert.equal(service.variables("r-nope", { sessionId: "s1" }), null);
    await service.dispose();
  });
  cleanupDir(dir);
});

test("未知 duetId 不能盲删临时聊天", async () => {
  const dir = tempDataDir();
  await withStubbedRuntime(async () => {
    const ctx = fakeCtx(dir, "ok");
    const service = serviceWith(ctx);
    await assert.rejects(
      () => service.duetEnd({ duetId: "duet-从未存在" }, { sessionId: "s1" }),
      /没有找到这场对戏的归属记录/,
    );
    assert.equal(ctx.started.length, 0, "没归属就不该起 worker 去删东西");
    await service.dispose();
  });
  cleanupDir(dir);
});

test("重载恢复：上次的 running 对戏变 interrupted，且还能按归属清理", async () => {
  const dir = tempDataDir();
  await withStubbedRuntime(async () => {
    const first = serviceWith(fakeCtx(dir, "ok"));
    const scope = { sessionId: "s1", sessionPath: "C:/a.jsonl", agentId: "partner-a" };
    const duet = await first.duetStart({ characterFile: "小花.png" }, scope);
    await first.dispose();

    // 新实例（模拟 App 重载）：状态是 interrupted，不是假 running。
    const second = serviceWith(fakeCtx(dir, "ok"));
    const recovered = second.progress(duet.duetId, scope);
    assert.equal(recovered.status, "interrupted");
    assert.match(recovered.error, /已停/);
    await assert.rejects(() => second.duetTurn({ duetId: duet.duetId, playerMessage: "在吗" }, scope), /已在重载时中断/);
    // 但归属还在，能安全清掉它的临时聊天；别人的会话不行。
    await assert.rejects(() => second.duetEnd({ duetId: duet.duetId }, { sessionId: "s-other" }), /不属于当前对话/);
    const ended = await second.duetEnd({ duetId: duet.duetId }, scope);
    assert.equal(ended.ended, true);
    assert.equal(ended.alreadyEnded, true);
    await second.dispose();
  });
  cleanupDir(dir);
});

test("代笔节奏：pace 存下来，自动推进到顶必须先 checkpoint", async () => {
  const dir = tempDataDir();
  await withStubbedRuntime(async () => {
    const service = serviceWith(fakeCtx(dir, "ok"));
    const scope = { sessionId: "s1" };
    const duet = await service.duetStart({ characterFile: "小花.png", pace: "restrained" }, scope);
    assert.equal(duet.pace, "restrained");
    assert.equal(duet.paceLabel, "保持克制");
    assert.equal(duet.maxAutoRounds, 1);
    assert.match(duet.pausePolicy, /方向控制/);

    const first = await service.duetTurn({ duetId: duet.duetId, playerMessage: "在吗" }, scope);
    assert.equal(first.pace.autoRoundsSinceCheckpoint, 1);
    assert.equal(first.pace.needsUserCheckpoint, true);
    // 到顶了：不确认就不给再推。
    await assert.rejects(
      () => service.duetTurn({ duetId: duet.duetId, playerMessage: "继续" }, scope),
      /自动推进上限/,
    );
    const resumed = await service.duetTurn({ duetId: duet.duetId, playerMessage: "继续", checkpoint: true }, scope);
    assert.equal(resumed.pace.autoRoundsSinceCheckpoint, 0);
    assert.equal(resumed.pace.needsUserCheckpoint, false);
    // 对戏变量也入账。
    assert.ok(readRunVariables(dir, duet.duetId, scope));
    await service.dispose();
  });
  cleanupDir(dir);
});

test("节奏上限：free 连推 6 幕后停，不会一路写下去", async () => {
  const dir = tempDataDir();
  await withStubbedRuntime(async () => {
    const service = serviceWith(fakeCtx(dir, "ok"));
    const scope = { sessionId: "s1" };
    const duet = await service.duetStart({ characterFile: "小花.png", pace: "free" }, scope);
    assert.equal(duet.maxAutoRounds, 6);
    for (let i = 0; i < 6; i += 1) {
      await service.duetTurn({ duetId: duet.duetId, playerMessage: `第${i}轮` }, scope);
    }
    await assert.rejects(() => service.duetTurn({ duetId: duet.duetId, playerMessage: "第7轮" }, scope), /自动推进上限/);
    await service.dispose();
  });
  cleanupDir(dir);
});

test("常规聊天缺内容直接拒，不进酒馆", async () => {
  const dir = tempDataDir();
  await withStubbedRuntime(async () => {
    const ctx = fakeCtx(dir, "ok");
    const service = serviceWith(ctx);
    await assert.rejects(() => service.chat({ characterFile: "a.png", message: "  " }, { sessionId: "s" }), /缺少要发送的内容/);
    await assert.rejects(() => service.chat({ message: "在吗" }, { sessionId: "s" }), /需要指定酒馆里的角色卡/);
    assert.equal(ctx.started.length, 0);
    await service.dispose();
  });
  cleanupDir(dir);
});

// ── MVU 纯逻辑与账本 ───────────────────────────────────────────────────────

test("原型链污染：路径里的原型链字段一律拒", () => {
  assert.throws(() => parseJsonPointer("/__proto__/polluted"), /不允许写入原型链字段/);
  assert.throws(() => parseJsonPointer("/constructor"), /不允许写入原型链字段/);
  assert.throws(() => parseJsonPointer("/a/prototype"), /不允许写入原型链字段/);
  assert.throws(() => applyJsonPatch({}, [{ op: "add", path: "/__proto__/x", value: 1 }]), /原型链/);
  assert.throws(() => applyJsonPatch({}, [{ op: "replace", path: "/constructor", value: 1 }]), /原型链/);
  assert.equal({}.polluted, undefined);
  assert.equal(Object.prototype.polluted, undefined);
});

test("带 / 的键不会被二次解码：a~1b 作为单层键写入", () => {
  // 旧写法把父路径 join 回字符串再 parse，“a/b” 会被切成两段，键就错了。
  assert.deepEqual(applyJsonPatch({}, [{ op: "add", path: "/a~1b", value: 1 }]), { "a/b": 1 });
  assert.deepEqual(applyJsonPatch({ "a/b": { c: 1 } }, [{ op: "replace", path: "/a~1b/c", value: 2 }]), { "a/b": { c: 2 } });
  assert.equal(pointerGet({ "a/b": { c: 9 } }, "/a~1b/c"), 9);
  assert.deepEqual(applyJsonPatch({ "x~y": 1 }, [{ op: "remove", path: "/x~0y" }]), {});
  // 读也不能摸到原型链上的属性。
  assert.equal(pointerGet({}, "/toString"), undefined);
});

test("JSON Pointer 与 Patch 覆盖 add/replace/remove 和自动补中间层", () => {
  assert.deepEqual(parseJsonPointer("/a/b~1c"), ["a", "b/c"]);
  assert.deepEqual(parseJsonPointer(""), []);
  assert.throws(() => parseJsonPointer("a"), /invalid JSON pointer/);
  assert.equal(pointerGet({ a: { b: 2 } }, "/a/b"), 2);
  assert.equal(pointerGet({ a: 1 }, "/missing/deep"), undefined);
  assert.deepEqual(applyJsonPatch({}, [{ op: "add", path: "/a/b", value: 1 }]), { a: { b: 1 } });
  assert.deepEqual(applyJsonPatch({ a: 1 }, [{ op: "replace", path: "/a", value: 2 }]), { a: 2 });
  assert.deepEqual(applyJsonPatch({ a: 1, b: 2 }, [{ op: "remove", path: "/b" }]), { a: 1 });
  assert.deepEqual(applyJsonPatch({ list: [1] }, [{ op: "add", path: "/list/-", value: 2 }]), { list: [1, 2] });
  assert.deepEqual(applyJsonPatch(null, []), {});
});

test("宏块提取宽容：尾逗号、注释、代码围栏都能解，解不出给空数组", () => {
  const fenced = "回复\n<UpdateVariable>\n<JSONPatch>\n```json\n[{\"op\":\"replace\",\"path\":\"/好感度\",\"value\":5,},]\n```\n</JSONPatch>\n</UpdateVariable>";
  assert.deepEqual(extractJsonPatch(fenced), [{ op: "replace", path: "/好感度", value: 5 }]);
  assert.deepEqual(extractJsonPatch("没有宏块"), []);
  assert.deepEqual(extractJsonPatch("<UpdateVariable>坏掉了</UpdateVariable>"), []);
  assert.deepEqual(extractJsonPatch(null), []);
});

test("publicRun 不吐归属凭据：scope/sessionPath/scopeKeys 都不进 JSON", async () => {
  const dir = tempDataDir();
  await withStubbedRuntime(async () => {
    const service = serviceWith(fakeCtx(dir, "ok"));
    const scope = { sessionId: "s1", sessionPath: "C:/秘密/会话.jsonl", agentId: "partner-a" };
    const pending = service.submit({ characterFile: "小花.png" }, scope);
    const json = JSON.stringify(service.progress(pending.runId, scope));
    assert.doesNotMatch(json, /scopeKeys/);
    assert.doesNotMatch(json, /C:\/秘密/);
    assert.doesNotMatch(json, /"scope"/);
    assert.doesNotMatch(json, /cancelPath/);
    // 对外仍保留卡片与交接文案要用的字段。
    assert.equal(service.progress(pending.runId, scope).characterFile, "小花.png");
    // 归属没弱化：换个会话照样拿不到。
    assert.throws(() => service.progress(pending.runId, { sessionId: "s2" }), /不属于当前对话/);
    await service.dispose();
  });
  cleanupDir(dir);
});

test("方向原样保存：4000 字不截断，交接文案拿得到", async () => {
  const dir = tempDataDir();
  await withStubbedRuntime(async () => {
    const service = serviceWith(fakeCtx(dir));
    const scope = { sessionId: "s1" };
    const long = "长".repeat(4000);
    const pending = service.submit({ characterFile: "小花.png", mode: "duet", objective: long, pace: "保持克制" }, scope);
    assert.equal(pending.objective.length, 4000);
    assert.equal(pending.objective, long);
    // 交接文案读的就是这个字段。
    const { handoffText } = await import("../ui/theater-handoff.js");
    const text = handoffText(pending, pending.runId);
    assert.match(text, /保持克制/);
    assert.ok(text.includes(long.slice(0, 200)), "交接文案要带上用户写的方向");
    await service.dispose();
  });
  cleanupDir(dir);
});

test("重载后 pending 原样回来：同 ID、角色、测试类型、节奏、方向与归属", async () => {
  const dir = tempDataDir();
  const scope = { sessionId: "s1", sessionPath: "C:/a.jsonl", agentId: "partner-a" };
  await withStubbedRuntime(async () => {
    const first = serviceWith(fakeCtx(dir));
    const pending = first.submit({ characterFile: "小花.png", mode: "duet", testType: "mvu", pace: "慢慢推进", objective: "写到关系转折" }, scope);
    await first.dispose();

    const second = serviceWith(fakeCtx(dir));
    const restored = second.progress(pending.runId, scope);
    assert.equal(restored.runId, pending.runId);
    assert.equal(restored.status, "waiting_for_direction");
    assert.equal(restored.mode, "duet");
    assert.equal(restored.characterFile, "小花.png");
    assert.equal(restored.testType, "mvu");
    assert.equal(restored.pace, "慢慢推进");
    assert.equal(restored.objective, "写到关系转折");
    assert.equal(restored.recovered, true);
    // 归属也还在：原会话能接着用，别人的会话拿不到。
    assert.throws(() => second.progress(pending.runId, { sessionId: "s2" }), /不属于当前对话/);
    // 还能真的被工具接上。
    const duet = await second.duetStart({ runId: pending.runId, characterFile: "小花.png" }, scope);
    assert.equal(duet.duetId, pending.runId);
    await second.dispose();
  });
  cleanupDir(dir);
});

test("已开始但被重载打断：标 interrupted，不自动重跑", async () => {
  const dir = tempDataDir();
  const scope = { sessionId: "s1", sessionPath: "C:/a.jsonl" };
  await withStubbedRuntime(async () => {
    const first = createTheaterService(fakeCtx(dir, "never"), { ...STUB_DEPS, graceMs: 60000 });
    const pending = first.submit({ characterFile: "小花.png", turns: undefined }, scope);
    const running = first.run({ runId: pending.runId, characterFile: "小花.png", turns: ["在吗"] }, scope);
    await new Promise((resolve) => setTimeout(resolve, 250));
    await first.dispose();
    await assert.rejects(() => running, /重新加载/);

    const second = serviceWith(fakeCtx(dir, "ok"));
    const recovered = second.progress(pending.runId, scope);
    assert.equal(recovered.status, "interrupted");
    assert.equal(recovered.recovered, true);
    assert.match(recovered.error, /不会自动重跑/);
    // 重载本身不会把它当 pending 重新跑起来：没有在跑，也没被认领。
    assert.equal(second.claim(scope, { mode: "scripted" }), null);
    // 显式带 runId 重试才继续，并清掉上次中断的提示。
    const retried = await second.run({ runId: pending.runId, characterFile: "小花.png", turns: ["再来一次"] }, scope);
    assert.equal(retried.status, "done");
    assert.equal(retried.error, null);
    assert.equal(retried.recovered, false);
    await second.dispose();
  });
  cleanupDir(dir);
});

test("取消/成功/结束的任务重载后不复活", async () => {
  const dir = tempDataDir();
  const scope = { sessionId: "s1", sessionPath: "C:/a.jsonl" };
  await withStubbedRuntime(async () => {
    const first = serviceWith(fakeCtx(dir, "ok"));
    const cancelled = first.submit({ characterFile: "小花.png" }, scope);
    first.control({ runId: cancelled.runId, action: "cancel" }, scope);
    const done = await first.run({ runId: first.submit({ characterFile: "小花.png" }, scope).runId, characterFile: "小花.png", turns: ["在吗"] }, scope);
    const duet = await first.duetStart({ characterFile: "小花.png" }, scope);
    await first.duetEnd({ duetId: duet.duetId }, scope);
    await first.dispose();

    const second = serviceWith(fakeCtx(dir, "ok"));
    for (const runId of [cancelled.runId, done.runId, duet.duetId]) {
      assert.throws(() => second.progress(runId, scope), /不存在、已过期/);
    }
    await second.dispose();
  });
  cleanupDir(dir);
});

test("过期快照会被清掉，不复活也不堆积", async () => {
  const dir = tempDataDir();
  const scope = { sessionId: "s1", sessionPath: "C:/a.jsonl" };
  const file = path.join(dir, "theater-tasks.json");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, JSON.stringify({
    old: {
      runId: "old", mode: "scripted", status: "waiting", characterId: "小花.png",
      sessionId: "s1", sessionPath: "C:/a.jsonl", createdAt: 1, updatedAt: 1,
    },
  }), "utf8");
  await withStubbedRuntime(async () => {
    const service = serviceWith(fakeCtx(dir));
    assert.throws(() => service.progress("old", scope), /不存在、已过期/);
    assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), {});
    await service.dispose();
  });
  cleanupDir(dir);
});

test("快照损坏时 submit 报错，不假装任务已保存", async () => {
  const dir = tempDataDir();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "theater-tasks.json"), "{ 这不是 JSON", "utf8");
  await withStubbedRuntime(async () => {
    const service = serviceWith(fakeCtx(dir));
    assert.throws(() => service.submit({ characterFile: "小花.png" }, { sessionId: "s1" }), /快照已损坏|快照读不出来/);
    await service.dispose();
  });
  cleanupDir(dir);
});

test("角色与形态不串：重载后不会拿错卡接对戏", async () => {
  const dir = tempDataDir();
  const scope = { sessionId: "s1", sessionPath: "C:/a.jsonl" };
  await withStubbedRuntime(async () => {
    const first = serviceWith(fakeCtx(dir, "ok"));
    const scripted = first.submit({ characterFile: "甲.png", mode: "scripted" }, scope);
    const duet = first.submit({ characterFile: "乙.png", mode: "duet" }, scope);
    await first.dispose();

    const second = serviceWith(fakeCtx(dir, "ok"));
    assert.equal(second.progress(scripted.runId, scope).characterFile, "甲.png");
    assert.equal(second.progress(duet.runId, scope).characterFile, "乙.png");
    // 拿甲的编号去开对戏：角色对不上就拒。
    await assert.rejects(() => second.duetStart({ runId: scripted.runId, characterFile: "甲.png" }, scope), /形态和当前操作对不上/);
    await assert.rejects(() => second.duetStart({ runId: duet.runId, characterFile: "丙.png" }, scope), /角色和当前指定的角色对不上/);
    await second.dispose();
  });
  cleanupDir(dir);
});

test("变量账本：null 也写，回查能分清「没读到」与「变量为空」", () => {
  const dir = tempDataDir();
  const scope = { sessionId: "s1", sessionPath: "C:/a.jsonl", agentId: "partner-a" };
  recordRunVariables(dir, "r1", { ...scope, finalVariables: null, finalVariableSource: "unavailable", mvuAvailable: false });
  recordRunVariables(dir, "r2", { ...scope, finalVariables: { 好感度: 3 }, finalVariableSource: "Mvu.getMvuData", mvuAvailable: true });
  assert.equal(readRunVariables(dir, "r1", scope).finalVariables, null);
  assert.equal(readRunVariables(dir, "r1", scope).mvuAvailable, false);
  assert.deepEqual(readRunVariables(dir, "r2", scope).finalVariables, { 好感度: 3 });
  assert.equal(readRunVariables(dir, "nope", { sessionId: "s1" }), null);
  cleanupDir(dir);
});

test("变量回查必须带 scope：不传不给，同会话不同人也不给", () => {
  const dir = tempDataDir();
  const mine = { sessionId: "s-mine", sessionPath: "C:/a.jsonl", agentId: "partner-a" };
  recordRunVariables(dir, "r1", { ...mine, finalVariables: { 好感度: 3 } });
  // 不传 scope：不返回任何东西，不能把整本账交出去。
  assert.equal(readRunVariables(dir, "r1"), null);
  assert.deepEqual(listRunVariables(dir, 20), []);
  assert.deepEqual(listRunVariables(dir, 20, { agentId: "partner-a" }), []);
  // 同伙伴另一个会话：同样不给。
  assert.equal(readRunVariables(dir, "r1", { sessionId: "s-other", agentId: "partner-a" }), null);
  assert.equal(readRunVariables(dir, "r1", { sessionPath: "C:/fake.jsonl", agentId: "partner-a" }), null);
  assert.deepEqual(listRunVariables(dir, 20, { sessionId: "s-other", agentId: "partner-a" }), []);
  // 自己的会话才给。
  assert.deepEqual(readRunVariables(dir, "r1", mine).finalVariables, { 好感度: 3 });
  assert.deepEqual(listRunVariables(dir, 20, mine).map((x) => x.runId), ["r1"]);
  cleanupDir(dir);
});

/** 轮询等到某个同步读值满足条件；超时把最后读到的值报出来，不静默通过。 */
async function waitUntil(read, timeoutMs, predicate = Boolean) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    try { last = read(); } catch { last = null; }
    if (predicate(last)) return last;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`等到超时：${JSON.stringify(last)}`);
}

// ── 异步测卡：工具不再被宿主那 30 秒回调上限砍断 ─────────────────────────────

test("总时限按幕数放大，不拿单幕上限当整轮上限", () => {
  // 单幕上限：缺省、小于等于 0 都退回默认值。
  assert.equal(perTurnTimeoutMs(undefined), 120000);
  assert.equal(perTurnTimeoutMs(0), 120000);
  assert.equal(perTurnTimeoutMs(-5), 120000);
  assert.equal(perTurnTimeoutMs(30000), 30000);
  // 幕数放大用的就是这个基数（公式在 executeRunJob 里：基数 × 幕数 + 宽限），
  // 五幕按默认值算出来是 600 秒量级，不会再被 180 秒那道旧上限误判。
  assert.equal(perTurnTimeoutMs(60000) * 5 + 60000, 360000);
});

test("跑得慢时先返回 running，任务在后台跑完后留下成绩单并回报一次", async () => {
  const dir = tempDataDir();
  const scope = { sessionId: "s1", sessionPath: "C:/a.jsonl" };
  const ctx = fakeCtx(dir, "ok", { delayMs: 300 });
  const service = serviceWith(ctx);
  try {
    const started = await service.startRun({ characterFile: "小花.png", turns: ["在吗"] }, scope, 20);
    assert.equal(started.status, "running");
    assert.equal(started.finished, false);
    assert.equal(started.reportTool, "hanabrew-test-result");
    assert.match(started.note, /不要下结论/, "返回 running 时必须把「别急着下结论」写清楚");

    // 还没跑完也能查到：卡片与工具看到的是同一条账。
    assert.equal(service.report(started.runId, scope).status, "running");

    const done = await waitUntil(() => service.report(started.runId, scope), 5000, (value) => value?.status === "done");
    assert.equal(done.scenes.length, 1);
    assert.equal(done.characterName, "小花");

    // 后台跑完要回报一次，模型才知道回来取结果。
    await waitUntil(() => ctx.busCalls.length, 3000, (value) => value > 0);
    assert.equal(ctx.busCalls[0][0], "session:send");
    assert.equal(ctx.busCalls[0][1].sessionId, "s1");
    assert.match(ctx.busCalls[0][1].text, /hanabrew-test-result/);
    assert.match(ctx.busCalls[0][1].text, new RegExp(started.runId));
  } finally { await service.dispose(); cleanupDir(dir); }
});

test("跑得快就直接带回结果，不多发一条回报", async () => {
  const dir = tempDataDir();
  const scope = { sessionId: "s1", sessionPath: "C:/a.jsonl" };
  const ctx = fakeCtx(dir, "ok");
  const service = serviceWith(ctx);
  try {
    const result = await service.startRun({ characterFile: "小花.png", turns: ["在吗"] }, scope, 5000);
    assert.equal(result.finished, true);
    assert.equal(result.status, "done");
    assert.equal(result.scenes.length, 1);
    assert.deepEqual(ctx.busCalls, [], "工具已经把结果带上去了，不该再叫一次");
  } finally { await service.dispose(); cleanupDir(dir); }
});

test("卡片那条 pending 的会话编号会被接住，后台跑完才能回报到对的地方", async () => {
  const dir = tempDataDir();
  // 卡片建 pending 时带着 sessionId；工具调用只带 sessionPath，这是真实上下文形状。
  const cardScope = { sessionId: "s1", sessionPath: "C:/a.jsonl" };
  const toolScope = { sessionId: "", sessionPath: "C:/a.jsonl", agentId: "", callToken: "tok-1" };
  const ctx = fakeCtx(dir, "ok", { delayMs: 300 });
  const service = serviceWith(ctx);
  try {
    const pending = service.submit({ characterFile: "小花.png" }, cardScope);
    const started = await service.startRun({ runId: pending.runId, characterFile: "小花.png", turns: ["在吗"] }, toolScope, 20);
    assert.equal(started.finished, false);
    await waitUntil(() => ctx.busCalls.length, 3000, (value) => value > 0);
    assert.equal(ctx.busCalls[0][1].sessionId, "s1", "回报要发给卡片那条 pending 记下的会话，而不是工具那半边空编号");
  } finally { await service.dispose(); cleanupDir(dir); }
});

test("成绩单按会话隔离：别的会话查不到，不带 runId 只列自己的", async () => {
  const dir = tempDataDir();
  const mine = { sessionId: "s1", sessionPath: "C:/a.jsonl" };
  const theirs = { sessionId: "s2", sessionPath: "C:/b.jsonl" };
  const ctx = fakeCtx(dir, "ok");
  const service = serviceWith(ctx);
  try {
    const result = await service.startRun({ characterFile: "小花.png", turns: ["在吗"] }, mine, 5000);
    assert.equal(service.report(result.runId, mine).status, "done");
    assert.throws(() => service.report(result.runId, theirs), /不存在、已过期或不属于当前对话/);

    const history = service.report(undefined, mine, 5);
    assert.equal(history.history.length, 1);
    assert.equal(history.history[0].runId, result.runId);
    assert.deepEqual(service.report(undefined, theirs, 5).history, []);
  } finally { await service.dispose(); cleanupDir(dir); }
});

test("测卡失败也留一份成绩单，能看出停在哪儿", async () => {
  const dir = tempDataDir();
  const scope = { sessionId: "s1", sessionPath: "C:/a.jsonl" };
  const ctx = fakeCtx(dir, "fail");
  const service = serviceWith(ctx);
  try {
    await assert.rejects(
      () => service.run({ characterFile: "小花.png", turns: ["在吗"] }, scope),
      /没有产出回复正文/,
    );
    const history = service.report(undefined, scope, 5).history;
    assert.equal(history.length, 1);
    assert.equal(history[0].status, "error");
    assert.match(history[0].error, /没有产出回复正文/);
  } finally { await service.dispose(); cleanupDir(dir); }
});

// ── 代笔对戏：同样不能被 30 秒回调上限耗死 ─────────────────────────

test("代笔对戏跑得慢时先返回 pending，跑完后幕数增加并回报一次", async () => {
  const dir = tempDataDir();
  const scope = { sessionId: "s1", sessionPath: "C:/a.jsonl" };
  const ctx = fakeCtx(dir, "ok", { delayMs: 400 });
  const service = serviceWith(ctx);
  try {
    const duet = await service.duetStart({ characterFile: "小花.png", pace: "free" }, scope);
    assert.equal(duet.mode, "duet");
    assert.equal(duet.status, "running");

    const turn = await service.duetTurn({ duetId: duet.duetId, playerMessage: "在吗" }, scope, 20);
    assert.equal(turn.turnPending, true, "超过等待上限要先返回 pending，不能把回包耗死");
    assert.match(turn.note, /不要重复发起/);

    // 上一轮还在生成时不允许再推一轮：两个临时聊天会抢同一个页面状态。
    await assert.rejects(
      () => service.duetTurn({ duetId: duet.duetId, playerMessage: "再来" }, scope, 20),
      /上一轮还在生成/,
    );

    const settled = await waitUntil(() => service.report(duet.duetId, scope), 5000, (value) => value?.scenes?.length === 1);
    assert.equal(settled.scenes.length, 1);

    await waitUntil(() => ctx.busCalls.length, 3000, (value) => value > 0);
    assert.equal(ctx.busCalls[0][0], "session:send");
    assert.match(ctx.busCalls[0][1].text, /代笔对戏推进到第 1 轮/);
    assert.match(ctx.busCalls[0][1].text, /hanabrew-duet-turn/);
  } finally { await service.dispose(); cleanupDir(dir); }
});

test("代笔对戏跑得快就直接返回这一轮，不用补一条回报", async () => {
  const dir = tempDataDir();
  const scope = { sessionId: "s1", sessionPath: "C:/a.jsonl" };
  const ctx = fakeCtx(dir, "ok");
  const service = serviceWith(ctx);
  try {
    const duet = await service.duetStart({ characterFile: "小花.png", pace: "restrained" }, scope);
    const turn = await service.duetTurn({ duetId: duet.duetId, playerMessage: "在吗" }, scope, 5000);
    assert.equal(turn.turnPending, undefined);
    assert.equal(turn.scenes.length, 1);
    // 保持克制：一轮到顶就要求交回控制权。
    assert.equal(turn.pace.needsUserCheckpoint, true);
    assert.deepEqual(ctx.busCalls, [], "工具已经把结果带上去了，不该再叫一次");
  } finally { await service.dispose(); cleanupDir(dir); }
});

test("卡片重挂后能按会话接回正在跑的对戏（running 不在 pending 里）", async () => {
  const dir = tempDataDir();
  const scope = { sessionId: "s1", sessionPath: "C:/a.jsonl" };
  const ctx = fakeCtx(dir, "ok");
  const service = serviceWith(ctx);
  try {
    assert.equal(service.active(scope), null);
    const duet = await service.duetStart({ characterFile: "小花.png", pace: "free" }, scope);
    assert.equal(duet.status, "running");
    // running 的对戏在 pending 里是找不到的，卡片被收回再打开时只能靠 active 接回去。
    assert.equal(service.pending(scope).length, 0);
    assert.equal(service.active(scope).runId, duet.duetId);
    // 别的会话接不走这一场。
    assert.equal(service.active({ sessionId: "s2" }), null);
    await service.duetEnd({ duetId: duet.duetId }, scope);
    assert.equal(service.active(scope), null, "结束之后不该再接回来");
  } finally { await service.dispose(); cleanupDir(dir); }
});

test("对戏也接住卡片那条 pending 的会话编号，一轮跑完能回报到对话", async () => {
  const dir = tempDataDir();
  // 卡片建 pending 时带着 sessionId；工具调用只带 sessionPath，这是真实上下文形状。
  const cardScope = { sessionId: "s1", sessionPath: "C:/a.jsonl" };
  const toolScope = { sessionId: "", sessionPath: "C:/a.jsonl", agentId: "", callToken: "tok-1" };
  const ctx = fakeCtx(dir, "ok", { delayMs: 300 });
  const service = serviceWith(ctx);
  try {
    const pending = service.submit({ mode: "duet", characterFile: "小花.png", pace: "free" }, cardScope);
    const started = await service.duetStart({ runId: pending.runId, characterFile: "小花.png" }, toolScope);
    assert.equal(started.status, "running");
    ctx.busCalls.length = 0;
    const turn = await service.duetTurn({ duetId: pending.runId, playerMessage: "在吗" }, toolScope, 20);
    assert.equal(turn.turnPending, true, "这一轮先返回 pending，后台跑完再回报");
    await waitUntil(() => ctx.busCalls.length, 3000, (value) => value > 0);
    assert.equal(ctx.busCalls[0][0], "session:send");
    assert.equal(ctx.busCalls[0][1].sessionId, "s1", "回报要发给卡片那条 pending 记下的会话，而不是工具那半边空编号");
    assert.match(ctx.busCalls[0][1].text, /hanabrew-duet-turn/);
  } finally { await service.dispose(); cleanupDir(dir); }
});