// 鲜花酿 v2 · 真实测卡 / 代笔对戏的无界面浏览器 worker
//
// 这个文件同时是两个东西：
//   1. 被 backend/theater-service.js 导入的纯逻辑（页面脚本源码、任务校验、临时聊天清理）；
//   2. 被 ctx.runtime.start 拉起的一次性 worker 入口（真正开无界面 Chromium、连 CDP、跑酒馆）。
//
// App 主进程不能 spawn 子进程也不能监听端口，所以浏览器一定跑在这个受管 runtime 里。
// 入口有 isDirectRun 守卫，测试 import 上面那些纯函数时不会把浏览器顶起来。
//
// 隔离约定：
//   - 只连 v2 自己的酒馆端口（st-runtime 的 serverUrl），数据根是 %APPDATA%\hanabrew-v2-dev\st-data；
//   - 每次任务用唯一临时聊天前缀，任务结束（含延迟复查）删干净，不读正式聊天变量。

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";

import { THEATER_CHAT_PREFIX, DUET_CHAT_PREFIX, PROGRESS_FILE_SUFFIX, CANCEL_FILE_SUFFIX } from '../backend/theater-contract.js';
export { THEATER_CHAT_PREFIX, DUET_CHAT_PREFIX, PROGRESS_FILE_SUFFIX, CANCEL_FILE_SUFFIX } from '../backend/theater-contract.js';
const DEFAULT_TIMEOUT_MS = 120000;
const PAGE_READY_TIMEOUT_MS = 30000;
const CDP_COMMAND_TIMEOUT_MS = 30000;
const PROGRESS_POLL_MS = 200;
const CLEANUP_PASSES = 12;
const CLEANUP_GAP_MS = 150;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function isExecutionContextError(error) {
  return /execution context|context with specified id/i.test(String(error?.message || error));
}

function isObject(value) {
  return value !== null && typeof value === "object";
}

function clone(value) {
  if (value === undefined || value === null) return value ?? null;
  return JSON.parse(JSON.stringify(value));
}

/** 深层差异摘要：真实测卡要能逐条核对变量前后值，不做模糊描述。 */
export function summarizeVariableChanges(before, after) {
  const flatten = (value, prefix = "", output = {}) => {
    if (!isObject(value) || Array.isArray(value)) {
      if (prefix) output[prefix] = value;
      return output;
    }
    const keys = Object.keys(value);
    if (!keys.length && prefix) output[prefix] = value;
    for (const key of keys) flatten(value[key], prefix ? `${prefix}.${key}` : key, output);
    return output;
  };
  const left = flatten(before || {});
  const right = flatten(after || {});
  return [...new Set([...Object.keys(left), ...Object.keys(right)])]
    .filter((key) => JSON.stringify(left[key]) !== JSON.stringify(right[key]))
    .sort()
    .map((key) => ({
      key,
      before: Object.hasOwn(left, key) ? left[key] : null,
      after: Object.hasOwn(right, key) ? right[key] : null,
    }));
}

/**
 * 从 Mvu / chat_metadata / 楼层 variables 的不同包装里取 stat_data。
 * 读不到就返回 null —— 「没读到变量」绝不伪装成 {}。
 */
export function normalizeRuntimeVariables(value) {
  if (value === undefined || value === null) return null;
  const isEmptyRecord = (item) => isObject(item) && !Array.isArray(item) && Object.keys(item).length === 0;
  const statData = (item) => {
    if (!isObject(item) || isEmptyRecord(item)) return null;
    if (isObject(item.stat_data) && !isEmptyRecord(item.stat_data)) return clone(item.stat_data);
    if (isObject(item.data?.stat_data) && !isEmptyRecord(item.data.stat_data)) return clone(item.data.stat_data);
    if (isObject(item.variables?.stat_data) && !isEmptyRecord(item.variables.stat_data)) return clone(item.variables.stat_data);
    return null;
  };
  const direct = statData(value);
  if (direct !== null) return direct;
  if (Array.isArray(value)) {
    for (let index = value.length - 1; index >= 0; index -= 1) {
      const found = normalizeRuntimeVariables(value[index]);
      if (found !== null) return found;
    }
    return null;
  }
  // 带空 stat_data 的壳（{stat_data:{}}、{data:{stat_data:{}}}）同样不算读到数据。
  if (isObject(value)
    && ("stat_data" in value || "variables" in value || isObject(value.data) && "stat_data" in value.data)) {
    return null;
  }
  // 完全空壳也不算，否则会把「没读到变量」说成「变量为空」。
  return isEmptyRecord(value) ? null : (isObject(value) ? clone(value) : null);
}

/**
 * 页面里跑的脚本。用 .toString() 送进 CDP evaluate，所以它只能闭包自己，不能引用外部任何东西。
 * 与旧版流程的差别只有一处：私人扩展的加载探测与相关字段已全部去除，其余步骤逐行保留。
 */
function theaterPageRunner(input) {
  const sleepInPage = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const cloneInPage = (value) => {
    if (value === undefined || value === null) return value ?? null;
    try { return JSON.parse(JSON.stringify(value)); } catch { return null; }
  };
  const publishProgress = (patch = {}) => {
    try {
      const current = window.__hanabrewV2Progress || { runId: input.runId, status: "running", scenes: [] };
      window.__hanabrewV2Progress = { ...current, ...patch, updatedAt: Date.now() };
    } catch {}
  };
  const isEmptyRecord = (value) => value !== null && typeof value === "object"
    && !Array.isArray(value) && Object.keys(value).length === 0;
  const hasStatData = (value) => value !== null && typeof value === "object"
    && value.stat_data && typeof value.stat_data === "object" && !isEmptyRecord(value.stat_data);
  const normalizeInPage = (value) => {
    if (value === undefined || value === null) return null;
    if (hasStatData(value)) return cloneInPage(value.stat_data);
    if (value && typeof value === "object" && value.data && hasStatData(value.data)) {
      return cloneInPage(value.data.stat_data);
    }
    if (value && typeof value === "object" && value.variables && hasStatData(value.variables)) {
      return cloneInPage(value.variables.stat_data);
    }
    if (Array.isArray(value)) {
      for (let index = value.length - 1; index >= 0; index -= 1) {
        const found = normalizeInPage(value[index]);
        if (found !== null) return found;
      }
      return null;
    }
    // 空壳不能冒充有效数据：读不到就继续往楼层和消息变量里找。
    return isEmptyRecord(value) ? null : (value && typeof value === "object" ? cloneInPage(value) : null);
  };
  const flattenInPage = (value, prefix = "", output = {}) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      if (prefix) output[prefix] = value;
      return output;
    }
    const keys = Object.keys(value);
    if (!keys.length && prefix) output[prefix] = value;
    for (const key of keys) flattenInPage(value[key], prefix ? `${prefix}.${key}` : key, output);
    return output;
  };
  const changesInPage = (before, after) => {
    const left = flattenInPage(before || {});
    const right = flattenInPage(after || {});
    return [...new Set([...Object.keys(left), ...Object.keys(right)])]
      .sort()
      .filter((key) => JSON.stringify(left[key]) !== JSON.stringify(right[key]))
      .map((key) => ({
        key,
        before: Object.hasOwn(left, key) ? left[key] : null,
        after: Object.hasOwn(right, key) ? right[key] : null,
      }));
  };
  const waitForInPage = async (predicate, timeoutMs, message) => {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      if (predicate()) return;
      await sleepInPage(100);
    }
    throw new Error(message);
  };
  const readVariables = (context) => {
    let live = context;
    try {
      const candidate = window.SillyTavern.getContext();
      if (candidate && typeof candidate === "object") live = candidate;
    } catch {
      // ST 模块切换期间 getContext 会短暂撞到 TDZ，继续用当前 chat 快照读。
    }
    let raw = null;
    let source = "unavailable";
    try {
      if (typeof Mvu !== "undefined" && typeof Mvu.getMvuData === "function") {
        raw = Mvu.getMvuData({ type: "chat" });
        source = "Mvu.getMvuData";
      }
    } catch {}
    if (raw === null || raw === undefined) {
      try {
        if (typeof Mvu !== "undefined" && typeof Mvu.getAllVariables === "function") {
          raw = Mvu.getAllVariables();
          source = "Mvu.getAllVariables";
        }
      } catch {}
    }
    let normalized = normalizeInPage(raw);
    if (normalized !== null) return { value: normalized, source };
    // Mvu 的 chat 级数据可能只是空壳（没开「更新到聊天变量」时常见），继续往下找。
    for (const [candidate, candidateSource] of [
      [live.chatMetadata?.stat_data, "chat_metadata.stat_data"],
      [live.chatMetadata?.variables, "chat_metadata.variables"],
    ]) {
      normalized = normalizeInPage(candidate);
      if (normalized !== null) return { value: normalized, source: candidateSource };
    }
    // 楼层式存储：从最新消息往前找第一条带非空 stat_data 的。
    for (let index = (live.chat?.length || 0) - 1; index >= 0; index -= 1) {
      const candidate = normalizeInPage(live.chat[index]?.variables);
      if (candidate !== null) return { value: candidate, source: "chat.message.variables" };
    }
    return { value: null, source };
  };
  const waitForStableVariables = async (context, timeoutMs = 2000) => {
    const hasProvider = typeof Mvu !== "undefined"
      && (typeof Mvu.getMvuData === "function" || typeof Mvu.getAllVariables === "function");
    let state = readVariables(context);
    if (!hasProvider || state.value !== null) return state;
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      await sleepInPage(100);
      state = readVariables(context);
      if (state.value !== null) return state;
    }
    return state;
  };
  const latestAssistantMessage = (context) => {
    for (let index = (context.chat?.length || 0) - 1; index >= 0; index -= 1) {
      const message = context.chat[index];
      if (message && !message.is_user && !message.is_system) return message;
    }
    return null;
  };
  const sendTurn = async (context, text, timeoutMs) => {
    const textarea = document.querySelector("#send_textarea");
    if (!textarea) throw new Error("SillyTavern 页面没有找到消息输入框。");
    const beforeLength = context.chat?.length || 0;
    textarea.value = text;
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    // generate() 自己不带超时：上游凭据缺失、渠道卡住时它会一直挂着不 resolve。
    // 只靠下面的 waitForInPage 兜不住（根本走不到那一行），整轮测卡会挂到外层总超时，
    // 用户只看到「整体超时」，问不出是哪一幕、为什么。这里给它一个硬上限。
    let generateTimer = null;
    try {
      await Promise.race([
        context.generate("normal"),
        new Promise((_, reject) => {
          generateTimer = setTimeout(
            () => reject(new Error(`等待 SillyTavern 生成超时（${Math.round(timeoutMs / 1000)} 秒没有返回）。`)),
            timeoutMs,
          );
        }),
      ]);
    } finally {
      if (generateTimer) clearTimeout(generateTimer);
    }
    await waitForInPage(
      () => (context.chat?.length || 0) > beforeLength && Boolean(latestAssistantMessage(context)?.mes),
      timeoutMs,
      "等待 SillyTavern 生成回复超时。",
    );
    const message = latestAssistantMessage(context);
    // 生成成功但没有正文不算成功：变量测卡必须读到实际回复。
    if (!String(message?.mes || "").trim()) {
      throw new Error("酒馆这次没有产出回复正文，测卡结果无法确认（可能是模型没配或请求失败）。");
    }
    return message;
  };
  const getRuntimeContext = async () => {
    await waitForInPage(
      () => Boolean(window.SillyTavern && typeof window.SillyTavern.getContext === "function"),
      input.timeoutMs,
      "SillyTavern 前端运行时尚未就绪，无法进行真实测卡。",
    );
    const context = window.SillyTavern.getContext();
    await waitForInPage(
      () => Array.isArray(context.characters) && context.characters.length > 0,
      input.timeoutMs,
      "等待 SillyTavern 角色列表就绪超时。",
    );
    return context;
  };
  const findCharacterIndex = (context) => {
    const wantedName = String(input.characterName || "").trim();
    const wantedId = String(input.characterId || "").trim();
    return context.characters.findIndex((character) => (
      (wantedName && String(character?.name || "").trim() === wantedName)
      || (wantedId && String(character?.avatar || "").trim() === wantedId)
      || (wantedId && String(character?.id || "").trim() === wantedId)
    ));
  };
  const normalizeChatName = (value) => String(value || "").trim().replace(/\.jsonl$/i, "");
  const openRequestedChat = async (context, characterIndex, chatFile, force) => {
    const expected = normalizeChatName(chatFile);
    const current = normalizeChatName(context.chatId || context.chatFile || "");
    const currentCharacter = String(context.characterId ?? "").trim();
    // 「当前没有聊天 / 没有角色」不能算匹配：worker 每一轮都是新开的浏览器，
    // 页面多半停在欢迎页，旧写法把它当成「已经在目标聊天里」，
    // 于是整轮生成在无角色上下文里跑，回来的就是 ST 那句「试着问我点什么吧」的默认欢迎语。
    const matches = Boolean(current && currentCharacter)
      && currentCharacter === String(characterIndex)
      && current === expected;
    if (force || !matches) {
      await context.selectCharacterById(characterIndex, { switchMenu: false });
      await context.openCharacterChat(chatFile);
      await sleepInPage(500);
    }
    return window.SillyTavern.getContext();
  };
  const requireCharacter = (context) => {
    const index = findCharacterIndex(context);
    if (index < 0) {
      const label = String(input.characterName || input.characterId || "").trim();
      throw new Error(`SillyTavern 里没有找到角色卡“${label}”。`);
    }
    return index;
  };

  // 常规聊天：走角色自己的正式聊天，不碰任何临时聊天文件。
  // chatId 为空时让酒馆按角色开默认聊天；给了就切到那一路继续。
  if (input.action === "chat") {
    return (async () => {
      const context = await getRuntimeContext();
      const characterIndex = requireCharacter(context);
      await context.selectCharacterById(characterIndex, { switchMenu: false });
      const chatFile = String(input.chatId || "").trim();
      if (chatFile) {
        await context.openCharacterChat(chatFile);
        await sleepInPage(500);
      }
      const live = window.SillyTavern.getContext();
      const message = String(input.text || "").trim();
      if (!message) throw new Error("常规聊天缺少要发送的内容。");
      const replyMessage = await sendTurn(live, message, input.timeoutMs);
      const afterState = await waitForStableVariables(live);
      return {
        action: "chat",
        character: {
          name: String(live.characters[characterIndex]?.name || input.characterName || ""),
          index: characterIndex,
        },
        chatFile: String(live.chatId || live.chatFile || chatFile || ""),
        user: message,
        reply: String(replyMessage?.mes || ""),
        mvuAvailable: typeof Mvu !== "undefined",
        variables: afterState.value,
        variableSource: afterState.source,
      };
    })();
  }

  if (["duet-start", "duet-resume", "duet-turn"].includes(input.action)) {
    return (async () => {
      const context = await getRuntimeContext();
      const characterIndex = requireCharacter(context);
      const chatFile = String(input.chatFile || "").trim();
      if (!chatFile) throw new Error("代笔对戏缺少隔离聊天标识。");
      const chatContext = await openRequestedChat(context, characterIndex, chatFile, input.action !== "duet-turn");
      const character = {
        name: String(chatContext.characters[characterIndex]?.name || input.characterName || ""),
        index: characterIndex,
      };
      if (input.action !== "duet-turn") {
        const openingMessage = chatContext.chat?.find((m) => m && !m.is_user && !m.is_system);
        const initialState = await waitForStableVariables(chatContext);
        return {
          action: input.action,
          character,
          chatFile,
          opening: String(openingMessage?.mes || ""),
          initialVariables: initialState.value,
          initialVariableSource: initialState.source,
          finalVariables: null,
          finalVariableSource: "unavailable",
          mvuAvailable: typeof Mvu !== "undefined",
        };
      }
      const user = String(input.text || "").trim();
      if (!user) throw new Error("代笔对戏这一轮没有可发送的玩家台词。");
      const sceneIndex = Math.max(1, Number(input.sceneIndex) || 1);
      const beforeState = await waitForStableVariables(chatContext);
      const replyMessage = await sendTurn(chatContext, user, input.timeoutMs);
      await sleepInPage(250);
      const afterState = await waitForStableVariables(chatContext);
      const before = beforeState.value;
      const after = afterState.value;
      return {
        action: input.action,
        character,
        chatFile,
        mvuAvailable: typeof Mvu !== "undefined",
        finalVariables: after,
        finalVariableSource: afterState.source,
        scene: {
          index: sceneIndex,
          user,
          reply: String(replyMessage?.mes || ""),
          variableSource: afterState.source,
          variablesBefore: before,
          variablesAfter: after,
          // 读不到变量时如实给空数组，并在来源里写清是 unavailable，不伪造差异。
          variableChanges: before === null || after === null ? [] : changesInPage(before, after),
        },
      };
    })();
  }

  return (async () => {
    publishProgress({ status: "running", scenes: [], activeScene: null });
    try {
      const context = await getRuntimeContext();
      const characterIndex = requireCharacter(context);
      await context.selectCharacterById(characterIndex, { switchMenu: false });
      const chatFile = String(input.chatFile || "").trim();
      if (!chatFile) throw new Error("真实测卡缺少隔离聊天标识。");
      await context.openCharacterChat(chatFile);
      await sleepInPage(500);

      const openingMessage = context.chat?.find((m) => m && !m.is_user && !m.is_system);
      const opening = String(openingMessage?.mes || "");
      const initialState = await waitForStableVariables(context);
      const scenes = [];
      publishProgress({
        opening,
        initialVariables: initialState.value,
        initialVariableSource: initialState.source,
        mvuAvailable: typeof Mvu !== "undefined",
      });
      for (let index = 0; index < input.turns.length; index += 1) {
        const user = String(input.turns[index] || "").trim();
        publishProgress({ activeScene: { index: index + 1, user }, currentTurnIndex: index });
        const beforeState = await waitForStableVariables(context);
        const replyMessage = await sendTurn(context, user, input.timeoutMs);
        await sleepInPage(250);
        const afterState = await waitForStableVariables(context);
        const before = beforeState.value;
        const after = afterState.value;
        scenes.push({
          index: index + 1,
          user,
          reply: String(replyMessage?.mes || ""),
          variableSource: afterState.source,
          variablesBefore: before,
          variablesAfter: after,
          variableChanges: before === null || after === null ? [] : changesInPage(before, after),
        });
        publishProgress({ activeScene: null, currentTurnIndex: index + 1, scenes: scenes.slice() });
      }
      const finalState = await waitForStableVariables(context);
      const result = {
        character: { name: String(context.characters[characterIndex]?.name || input.characterName || ""), index: characterIndex },
        chatFile,
        opening,
        initialVariables: initialState.value,
        initialVariableSource: initialState.source,
        finalVariables: finalState.value,
        finalVariableSource: finalState.source,
        mvuAvailable: typeof Mvu !== "undefined",
        scenes,
      };
      publishProgress({
        status: "done",
        activeScene: null,
        currentTurnIndex: scenes.length,
        finalVariables: finalState.value,
        finalVariableSource: finalState.source,
        scenes: scenes.slice(),
      });
      return result;
    } catch (error) {
      publishProgress({ status: "error", activeScene: null, error: String(error?.message || error) });
      throw error;
    }
  })();
}

/** 页面脚本源码。测试用它确认没有夹带私人扩展探测，且流程步骤都在。 */
export function theaterPageRunnerSource() {
  return theaterPageRunner.toString();
}

// ── 任务校验（纯逻辑，先在这里挡掉明显不完整的任务）─────────────────────────

const MAX_TURNS = 12;
const MAX_TURN_CHARS = 2000;

/**
 * 把 service 递进来的任务请求规整成 worker 认识的形状。
 * 缺正文（没有测试台词 / 这一轮没有玩家台词）在这里就报错，不浪费一次浏览器启动。
 */
export function planJob(request = {}) {
  const action = String(request.action || "").trim();
  if (!action) throw new Error("测卡任务缺少动作。");
  const timeoutMs = Number(request.timeoutMs) > 0 ? Number(request.timeoutMs) : DEFAULT_TIMEOUT_MS;
  const base = {
    action,
    runId: String(request.runId || "").trim(),
    timeoutMs,
    // characterFile 与 characterId 同义：前者是酒馆 PNG 文件名，后者是内部角色编号。
    characterId: String(request.characterId ?? request.characterFile ?? "").trim(),
    characterName: String(request.characterName || "").trim(),
  };
  // duet-end 只做临时聊天清理，不连酒馆页面，因此不要求角色卡。
  if (action !== "duet-end" && !base.characterId && !base.characterName) {
    throw new Error("测卡任务没有指定角色卡。");
  }

  if (action === "run") {
    const turns = (Array.isArray(request.turns) ? request.turns : [])
      .map((turn) => String(turn || "").trim())
      .filter(Boolean);
    if (!turns.length) throw new Error("真实测卡至少需要一句测试台词。");
    if (turns.length > MAX_TURNS) throw new Error(`真实测卡一次最多 ${MAX_TURNS} 幕，请分批测。`);
    if (turns.some((turn) => turn.length > MAX_TURN_CHARS)) {
      throw new Error(`单幕测试台词超过 ${MAX_TURN_CHARS} 字，请拆成几幕。`);
    }
    const chatFile = String(request.chatFile || "").trim();
    if (!chatFile) throw new Error("真实测卡缺少隔离聊天标识。");
    return { ...base, turns, chatFile };
  }

  if (["duet-start", "duet-resume", "duet-turn"].includes(action)) {
    const chatFile = String(request.chatFile || "").trim();
    if (!chatFile) throw new Error("代笔对戏缺少隔离聊天标识。");
    if (action !== "duet-turn") return { ...base, chatFile };
    const text = String(request.text || "").trim();
    if (!text) throw new Error("代笔对戏这一轮没有可发送的玩家台词。");
    if (text.length > MAX_TURN_CHARS) throw new Error(`这一轮台词超过 ${MAX_TURN_CHARS} 字，请精简后再发。`);
    return { ...base, chatFile, text, sceneIndex: Math.max(1, Number(request.sceneIndex) || 1) };
  }

  if (action === "duet-end") return { ...base };

  if (action === "chat") {
    // 服务层传 text，工具层参数叫 message，两者等价。
    const text = String(request.text ?? request.message ?? "").trim();
    if (!text) throw new Error("常规聊天缺少要发送的内容。");
    if (text.length > MAX_TURN_CHARS) throw new Error(`单条消息超过 ${MAX_TURN_CHARS} 字，请拆开发送。`);
    const chatId = String(request.chatId || "").trim();
    // chatId 会直接喂给 openCharacterChat，只放行酒馆自己的聊天名形状。
    if (chatId && (chatId.includes("/") || chatId.includes("\\") || chatId.includes("..") || !/^[\w一-鿿. -]+$/u.test(chatId))) {
      throw new Error("聊天标识不合法，请使用酒馆里的聊天名，不要填写路径。");
    }
    return { ...base, text, chatId };
  }

  throw new Error(`不支持的测卡动作：${action}`);
}

// ── 临时聊天清理 ────────────────────────────────────────────────────────────

/**
 * 只认唯一前缀 + .jsonl。
 * prefix 本身就是完整的临时聊天名（已含 runId），所以 `${prefix}.jsonl` 正是要删的那一个；
 * 安全靠“不含路径分隔符”和“必须落在 chats 根或其一级子目录内”保证。
 */
export function isSafeTemporaryChatName(name, prefix) {
  const file = String(name || "");
  const base = String(prefix || "");
  return Boolean(base) && file === `${base}.jsonl`
    && !file.includes("/") && !file.includes("\\")
    && !base.includes("/") && !base.includes("\\");
}

/**
 * 扫 chats 根 + 一级子目录删掉本次前缀的临时聊天。
 * ST 的聊天目录在不同导入路径下可能按角色名、头像名、角色 ID 分目录，也可能平铺在根下，
 * 所以按唯一前缀扫，不猜角色名路径。
 */
export function cleanupTemporaryChats(chatsRoot, prefix) {
  if (!chatsRoot || !prefix) return 0;
  const root = path.resolve(chatsRoot);
  let folders;
  try {
    folders = [root, ...fs.readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(root, entry.name))];
  } catch {
    return 0;
  }
  let removed = 0;
  for (const folder of folders) {
    const resolved = path.resolve(folder);
    if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) continue;
    let names;
    try { names = fs.readdirSync(resolved); } catch { continue; }
    for (const name of names) {
      if (!isSafeTemporaryChatName(name, prefix)) continue;
      const file = path.resolve(resolved, name);
      if (!file.startsWith(`${resolved}${path.sep}`)) continue;
      try { fs.rmSync(file, { force: true }); removed += 1; } catch {}
    }
  }
  return removed;
}

/** ST 可能在最后一条回复之后才落盘，任务结束要短暂复查几轮，别把刚生成的临时聊天留下。 */
export async function cleanupTemporaryChatsEventually(chatsRoot, prefix, passes = CLEANUP_PASSES) {
  let removed = 0;
  for (let pass = 0; pass < passes; pass += 1) {
    removed += cleanupTemporaryChats(chatsRoot, prefix);
    if (pass < passes - 1) await sleep(CLEANUP_GAP_MS);
  }
  return removed;
}

// ── 无界面浏览器 + CDP ──────────────────────────────────────────────────────

const BROWSER_CANDIDATES = {
  win32: () => [
    [process.env["ProgramFiles(x86)"], "Microsoft", "Edge", "Application", "msedge.exe"],
    [process.env.ProgramFiles, "Microsoft", "Edge", "Application", "msedge.exe"],
    [process.env.ProgramFiles, "Google", "Chrome", "Application", "chrome.exe"],
    [process.env["ProgramFiles(x86)"], "Google", "Chrome", "Application", "chrome.exe"],
    [process.env.LocalAppData, "Google", "Chrome", "Application", "chrome.exe"],
    [process.env.LocalAppData, "BraveSoftware", "Brave-Browser", "Application", "brave.exe"],
    [process.env.LocalAppData, "Vivaldi", "Application", "vivaldi.exe"],
    // 受管运行时的环境变量未必完整（ProgramFiles / LocalAppData 可能为空），
    // 所以再给一串写死的安装位置兜底：文件确实在那儿，就该找得到。
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe",
    "C:\\Program Files\\Vivaldi\\Application\\vivaldi.exe",
  ].map((parts) => (Array.isArray(parts) ? path.join(...parts.map((part) => part || "")) : parts)),
  darwin: () => [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
  ],
  linux: () => ["/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/microsoft-edge", "/snap/bin/chromium"],
};

export function findChromiumBinary(platform = process.platform) {
  const candidates = (BROWSER_CANDIDATES[platform] || BROWSER_CANDIDATES.linux)();
  return candidates.find((candidate) => candidate && fs.existsSync(candidate)) || null;
}

function findFreePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

class CdpClient {
  constructor(webSocketUrl) {
    this.webSocketUrl = webSocketUrl;
    this.socket = null;
    this.nextId = 1;
    this.pending = new Map();
    this.executionContextId = null;
  }

  async connect(timeoutMs = PAGE_READY_TIMEOUT_MS) {
    if (typeof WebSocket !== "function") {
      throw new Error("当前 Node 运行时没有 WebSocket，无法连接 SillyTavern 前端调试协议。");
    }
    const socket = new WebSocket(this.webSocketUrl);
    this.socket = socket;
    await new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        try { socket.close(); } catch {}
        reject(new Error("连接 SillyTavern 前端调试协议超时。"));
      }, timeoutMs);
      const finish = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) reject(error);
        else resolve();
      };
      socket.addEventListener("open", () => finish());
      socket.addEventListener("error", () => finish(new Error("连接 SillyTavern 前端调试协议失败。")));
    });

    socket.addEventListener("message", (event) => {
      let message;
      try { message = JSON.parse(String(event.data)); } catch { return; }
      if (message.method === "Runtime.executionContextCreated") {
        const context = message.params?.context;
        if (context && (context.aux?.isDefault || this.executionContextId === null)) {
          this.executionContextId = context.id;
        }
      } else if (message.method === "Runtime.executionContextsCleared") {
        this.executionContextId = null;
      } else if (message.method === "Runtime.executionContextDestroyed"
        && message.params?.executionContextId === this.executionContextId) {
        this.executionContextId = null;
      }
      if (!message.id) return;
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message || "CDP 命令失败。"));
      else pending.resolve(message.result || {});
    });
    socket.addEventListener("close", () => {
      const error = new Error("SillyTavern 前端调试连接已关闭。");
      for (const pending of this.pending.values()) pending.reject(error);
      this.pending.clear();
    });
  }

  send(method, params = {}, timeoutMs = CDP_COMMAND_TIMEOUT_MS) {
    if (!this.socket || this.socket.readyState !== 1) {
      return Promise.reject(new Error("SillyTavern 前端调试连接尚未建立。"));
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP 命令超时：${method}`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => { clearTimeout(timer); resolve(value); },
        reject: (error) => {
          if (isExecutionContextError(error)) this.executionContextId = null;
          clearTimeout(timer);
          reject(error);
        },
      });
      try {
        this.socket.send(JSON.stringify({ id, method, params }));
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  async evaluate(expression, timeoutMs = DEFAULT_TIMEOUT_MS) {
    const startedAt = Date.now();
    let lastError = null;
    while (Date.now() - startedAt < timeoutMs) {
      try {
        const result = await this.send("Runtime.evaluate", {
          expression,
          awaitPromise: true,
          returnByValue: true,
          userGesture: true,
          ...(this.executionContextId === null ? {} : { contextId: this.executionContextId }),
        }, Math.max(CDP_COMMAND_TIMEOUT_MS, timeoutMs + 5000));
        if (result.exceptionDetails) {
          throw new Error(
            result.exceptionDetails.exception?.description
            || result.exceptionDetails.text
            || "SillyTavern 页面执行失败。",
          );
        }
        return result.result?.value;
      } catch (error) {
        if (!isExecutionContextError(error)) throw error;
        lastError = error;
        await sleep(100);
      }
    }
    throw lastError || new Error("SillyTavern 页面执行超时。");
  }

  close() {
    try { this.socket?.close(); } catch {}
    this.socket = null;
  }
}

async function waitForCdpTarget(debugPort, expectedUrl, timeoutMs) {
  const startedAt = Date.now();
  let lastError = null;
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(`http://127.0.0.1:${debugPort}/json/list`, { signal: AbortSignal.timeout(1500) });
      const targets = await response.json();
      const page = targets.find((target) => target.type === "page"
        && String(target.url || "").startsWith(expectedUrl)
        && target.webSocketDebuggerUrl);
      if (page) return page;
    } catch (error) {
      lastError = error;
    }
    await sleep(150);
  }
  throw new Error(`没有找到 SillyTavern 页面调试目标。${lastError ? ` ${lastError.message}` : ""}`);
}

async function waitForExecutionContext(cdp, timeoutMs = PAGE_READY_TIMEOUT_MS) {
  const startedAt = Date.now();
  let lastError = null;
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const result = await cdp.send("Runtime.evaluate", {
        expression: "typeof window",
        returnByValue: true,
        ...(cdp.executionContextId === null ? {} : { contextId: cdp.executionContextId }),
      }, 2000);
      if (result.result?.value === "object") return;
    } catch (error) {
      lastError = error;
    }
    await sleep(150);
  }
  throw new Error(`SillyTavern 页面脚本执行上下文尚未建立。${lastError ? ` ${lastError.message}` : ""}`);
}

async function launchBrowser(serverUrl, tag) {
  const binary = findChromiumBinary();
  if (!binary) {
    throw new Error("真实测卡需要 Chrome、Edge、Brave 或 Vivaldi；当前电脑没有找到可用的 Chromium 浏览器。");
  }
  const debugPort = await findFreePort();
  const profileDir = path.join(os.tmpdir(), `hanabrew-v2-theater-${tag}`);
  fs.mkdirSync(profileDir, { recursive: true });
  const args = [
    "--headless=new",
    "--disable-gpu",
    "--disable-extensions",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-timer-throttling",
    "--disable-renderer-backgrounding",
    "--disable-features=TranslateUI,InfiniteSessionRestore",
    "--allow-running-insecure-content",
    "--window-size=1280,900",
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${profileDir}`,
    serverUrl,
  ];
  let child;
  try {
    child = spawn(binary, args, { detached: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  } catch (error) {
    fs.rmSync(profileDir, { recursive: true, force: true });
    throw new Error(`启动无界面 Chromium 失败：${error.message}`);
  }
  let output = "";
  const collect = (chunk) => { output = `${output}${String(chunk)}`.slice(-2000); };
  child.stdout?.on("data", collect);
  child.stderr?.on("data", collect);
  const exited = new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));

  try {
    let target = null;
    const startedAt = Date.now();
    while (Date.now() - startedAt < PAGE_READY_TIMEOUT_MS) {
      const early = await Promise.race([exited, sleep(200).then(() => null)]);
      if (early) throw new Error(`无界面 Chromium 提前退出（${early.code ?? early.signal}）。${output}`);
      try {
        target = await waitForCdpTarget(debugPort, serverUrl, 800);
        break;
      } catch {
        target = null;
      }
    }
    if (!target) throw new Error("无界面 Chromium 页面启动超时。");
    const cdp = new CdpClient(target.webSocketDebuggerUrl);
    await cdp.connect();
    await cdp.send("Runtime.enable");
    await waitForExecutionContext(cdp);
    return { child, cdp, profileDir };
  } catch (error) {
    closeBrowserSync(child);
    fs.rmSync(profileDir, { recursive: true, force: true });
    throw error;
  }
}

function closeBrowserSync(child) {
  try { child?.kill(); } catch {}
}

async function closeBrowser(browser) {
  if (!browser) return;
  try { browser.cdp?.close(); } catch {}
  if (browser.child?.pid && process.platform === "win32") {
    await new Promise((resolve) => {
      const killer = spawn("taskkill", ["/pid", String(browser.child.pid), "/t", "/f"], { windowsHide: true, stdio: "ignore" });
      killer.once("exit", resolve);
      killer.once("error", resolve);
    });
  }
  closeBrowserSync(browser.child);
  for (let attempt = 0; attempt < 12; attempt += 1) {
    try {
      fs.rmSync(browser.profileDir, { recursive: true, force: true });
      break;
    } catch {
      await sleep(150);
    }
  }
}

async function startProgressPolling(cdp, runId, progressPath, cancelPath) {
  let stopped = false;
  let last = "";
  let rejectCancelled;
  const cancelled = new Promise((_resolve, reject) => { rejectCancelled = reject; });
  cancelled.catch(() => {});
  const loop = (async () => {
    while (!stopped) {
      try {
        const snapshot = await cdp.evaluate(
          `(() => { const p = window.__hanabrewV2Progress; return p && p.runId === ${JSON.stringify(runId)} ? p : null; })()`,
          2000,
        );
        const serialized = JSON.stringify(snapshot || null);
        if (snapshot && serialized !== last) {
          last = serialized;
          await fsp.writeFile(progressPath, JSON.stringify(snapshot), "utf8");
        }
      } catch {
        // 上下文切换或页面即将关闭时读不到进度，不影响主结果。
      }
      if (!stopped && cancelPath && fs.existsSync(cancelPath)) {
        rejectCancelled(new Error('测卡已被取消。'));
        break;
      }
      if (!stopped) await sleep(PROGRESS_POLL_MS);
    }
  })();
  const stop = async () => {
    stopped = true;
    await loop.catch(() => {});
  };
  stop.cancelled = cancelled;
  return stop;
}

// ── 一次性执行一个任务 ──────────────────────────────────────────────────────

/**
 * 跑完一个测卡/对戏任务并返回结果。deps 只为测试留：可以换掉开浏览器和 evaluate。
 * 无论成功失败都会清掉本次前缀的临时聊天。
 */
export async function executeJob(request, deps = {}) {
  const job = planJob(request);
  const serverUrl = String(request.serverUrl || "").trim();
  const chatsRoot = String(request.chatsRoot || "").trim();
  const runId = job.runId || job.chatFile || "adhoc";
  const prefix = String(request.chatFile || "").trim()
    || (job.action === "duet-end" ? "" : `${THEATER_CHAT_PREFIX}${runId}`);
  // duet-end 要删的是那一场的对戏前缀，与它当时的 chatFile 同名。
  const cleanupPrefix = job.action === "duet-end" ? String(request.cleanupPrefix || prefix).trim() : prefix;
  const launch = deps.launch || ((url, tag) => launchBrowser(url, tag));

  // 只有真要开浏览器时才需要酒馆地址；duet-end 是纯清理。
  if (job.action !== "duet-end" && !serverUrl) throw new Error("测卡任务缺少酒馆地址，请先启动酒馆。");

  if (job.action === "duet-end") {
    const removed = cleanupPrefix ? await cleanupTemporaryChatsEventually(chatsRoot, cleanupPrefix) : 0;
    return { action: "duet-end", ended: true, cleanedChats: removed };
  }

  // 常规聊天和 duet-end 都不产生临时聊天：一个走正式聊天，一个只做清理。
  const ownsTemporaryChat = job.action !== "chat";

  if (ownsTemporaryChat && chatsRoot && prefix) cleanupTemporaryChats(chatsRoot, prefix);

  const browser = await launch(serverUrl, runId);
  let data;
  let failure = null;
  try {
    const stopProgress = job.action === "run"
      ? await startProgressPolling(browser.cdp, runId, request.progressPath || "", request.cancelPath || "")
      : async () => {};
    try {
      const expression = `(${theaterPageRunner.toString()})(${JSON.stringify({ ...job, runId })})`;
      const turns = Array.isArray(job.turns) ? job.turns.length : 1;
      const generation = browser.cdp.evaluate(expression, job.timeoutMs * Math.max(2, turns + 1));
      data = await (stopProgress.cancelled ? Promise.race([generation, stopProgress.cancelled]) : generation);
    } finally {
      await stopProgress();
    }
  } catch (error) {
    failure = error;
  } finally {
    await closeBrowser(browser);
    if (ownsTemporaryChat && chatsRoot && prefix) await cleanupTemporaryChatsEventually(chatsRoot, prefix);
  }
  if (failure) throw failure;
  return { ...data, engine: "sillytavern-runtime", isolated: job.action !== 'chat', serverUrl, chatFile: job.chatFile || data?.chatFile || null };
}

// ── worker 入口 ─────────────────────────────────────────────────────────────

export async function runWorker(requestPath, resultPath) {
  let output;
  try {
    const stat = await fsp.stat(requestPath);
    if (stat.size > 4 * 1024 * 1024) throw new Error("测卡任务请求过大。");
    const request = JSON.parse(await fsp.readFile(requestPath, "utf8"));
    output = { ok: true, data: await executeJob(request) };
  } catch (error) {
    output = { ok: false, error: error?.message || String(error) };
  }
  const temp = `${resultPath}.tmp`;
  await fsp.writeFile(temp, JSON.stringify(output), { mode: 0o600 });
  await fsp.rename(temp, resultPath);
  console.log("HANABREW_THEATER_DONE");
}

// 入口守卫：不能直接比字符串。安装目录可能是 junction，import.meta.url 给出的真实路径
// 与 argv 中的入口路径可能不同——两者指向同一个文件但字符串不等，直跑会静默退出。
function sameFilePath(left, right) {
  if (!left || !right) return false;
  try {
    return fs.realpathSync(left).toLowerCase() === fs.realpathSync(right).toLowerCase();
  } catch {
    try {
      return path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase();
    } catch {
      return false;
    }
  }
}

const isDirectRun = Boolean(process.argv[1])
  && sameFilePath(fileURLToPath(import.meta.url), path.resolve(process.argv[1]));

if (isDirectRun) {
  const [requestPath, resultPath] = process.argv.slice(2);
  if (!requestPath || !resultPath) throw new Error("测卡 worker 缺少任务文件参数。");
  await runWorker(path.resolve(requestPath), path.resolve(resultPath));
}