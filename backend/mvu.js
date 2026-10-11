// 鲜花酿 v2 · MVU 变量
//
// 只做两件事：
//   1. 纯函数层：JSON Pointer / JSON Patch / 从模型回复里提取 <UpdateVariable> 宏块；
//   2. 账本层：把真实测卡里酒馆回传的变量按 runId 存进 App 数据目录，供工具回查。
//
// 真正的变量计算发生在 SillyTavern 页面里（脚本/正则扩展），这里不冒充酒馆执行，
// 也不把「没读到变量」写成 {}。
//
// 逻辑与旧版花酿同源，这里是 App 内独立副本：状态目录换成宿主给的 dataDir，
// 不再落任何旧插件目录，也不读旧插件数据。

import fs from "node:fs";
import path from "node:path";

// ── JSON Pointer（RFC 6901）────────────────────────────────────────────────

const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);

export function parseJsonPointer(pointer) {
  if (!pointer || pointer === "") return [];
  if (typeof pointer !== "string" || !pointer.startsWith("/")) {
    throw new Error(`invalid JSON pointer: ${String(pointer)}`);
  }
  return pointer.slice(1).split("/").map((segment) => {
    const decoded = segment.replace(/~1/g, "/").replace(/~0/g, "~");
    // 拒原型链键：模型输出里的路径不是可信输入，__proto__ 能一路写到 Object.prototype。
    if (FORBIDDEN_KEYS.has(decoded)) {
      throw new Error(`JSON pointer 不允许写入原型链字段：${decoded}`);
    }
    return decoded;
  });
}

/**
 * 按已解码的段数组逐层下钻。
 * 不能把段 join 回 "/a/b" 再 parse 一遍：段里含 "~1" 解出的 "/" 会被二次切开，键就错了。
 */
function readBySegments(target, segments) {
  let node = target;
  for (const segment of segments) {
    if (node == null) return undefined;
    if (Array.isArray(node)) node = node[Number(segment)];
    else if (typeof node !== "object") return undefined;
    // 读也不走原型链，避免拿到 inherited 属性当成变量。
    else if (Object.prototype.hasOwnProperty.call(node, segment)) node = node[segment];
    else return undefined;
  }
  return node;
}

export function pointerGet(target, pointer) {
  return readBySegments(target, parseJsonPointer(pointer));
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

/**
 * RFC 6902 的 add/replace/remove 子集。宽容处理：add/replace 到不存在的路径自动补中间对象；
 * 数组 index 越界时 add 追加、replace 推到末尾。MVU 只用到这三个操作。
 */
export function applyJsonPatch(target, patches) {
  const result = clone(target ?? {});
  for (const patch of Array.isArray(patches) ? patches : []) {
    if (!patch || typeof patch !== "object") continue;
    const op = String(patch.op || "").toLowerCase();
    const pointer = String(patch.path || "");
    if (!pointer) continue;
    const segments = parseJsonPointer(pointer);
    if (segments.length === 0) {
      if (op === "replace" || op === "add") return clone(patch.value);
      continue;
    }
    const last = segments[segments.length - 1];
    // 单层路径（/a）的父节点就是根对象，不能去查 "/"（它会被解成空键名）。
    const parentSegments = segments.slice(0, -1);
    let parent = parentSegments.length ? readBySegments(result, parentSegments) : result;
    if (parent == null && (op === "add" || op === "replace")) {
      parent = result;
      for (const segment of parentSegments) {
        if (parent[segment] == null) parent[segment] = {};
        parent = parent[segment];
      }
    }
    if (parent == null) continue;

    if (Array.isArray(parent)) {
      const index = last === "-" ? parent.length : Number(last);
      if (op === "add") {
        parent.splice(Number.isFinite(index) ? Math.min(index, parent.length) : parent.length, 0, clone(patch.value));
      } else if (op === "replace") {
        if (Number.isFinite(index) && index >= 0 && index < parent.length) parent[index] = clone(patch.value);
        else if (Number.isFinite(index) && index === parent.length) parent.push(clone(patch.value));
      } else if (op === "remove") {
        if (Number.isFinite(index) && index >= 0 && index < parent.length) parent.splice(index, 1);
      }
    } else if (typeof parent === "object") {
      // 拒绝的键已在 parseJsonPointer 拦下；这里再守一道，不信任调用方直接传 segments。
      if (FORBIDDEN_KEYS.has(last)) continue;
      if (op === "add" || op === "replace") parent[last] = clone(patch.value);
      else if (op === "remove") delete parent[last];
    }
  }
  return result;
}

/**
 * 宽容提取 <UpdateVariable> 里的 JSONPatch 数组。
 * 模型常带尾逗号、注释、markdown 围栏，逐级清理再试；解析不出来就返回空数组，不让聊天炸掉。
 */
export function extractJsonPatch(text) {
  const source = String(text == null ? "" : text);
  if (!source) return [];
  const block = source.match(/<UpdateVariable>([\s\S]*?)<\/UpdateVariable>/i)?.[1]
    || source.match(/<JSONPatch>([\s\S]*?)<\/JSONPatch>/i)?.[1];
  if (!block) return [];
  const patchMatch = block.match(/<JSONPatch>\s*([\s\S]*?)\s*<\/JSONPatch>/i) || block.match(/^(\[[\s\S]*\])$/);
  if (!patchMatch) return [];
  const cleaned = patchMatch[1]
    .replace(/```json\s*/gi, "")
    .replace(/```/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "")
    .replace(/,(\s*[}\]])/g, "$1");
  for (const candidate of [cleaned, patchMatch[1]]) {
    try {
      const parsed = JSON.parse(candidate);
      if (Array.isArray(parsed)) return parsed;
      if (parsed && Array.isArray(parsed.patches)) return parsed.patches;
    } catch { /* 换下一个候选 */ }
  }
  return [];
}

/** 把变量对象格式化成扁平文本（供工具回读和拼诊断用）。 */
export function formatVariableText(vars) {
  if (!vars || typeof vars !== "object") return "";
  const lines = [];
  const walk = (node, prefix) => {
    if (!node || typeof node !== "object" || Array.isArray(node)) return;
    for (const [key, value] of Object.entries(node)) {
      const path = prefix ? `${prefix}.${key}` : key;
      if (value && typeof value === "object") walk(value, path);
      else lines.push(`${path}: ${value}`);
    }
  };
  walk(vars, "");
  return lines.join("\n");
}

// ── 测卡变量账本 ────────────────────────────────────────────────────────────

const LEDGER_LIMIT = 200;

function ledgerFile(dataDir) {
  return path.join(dataDir, "theater-mvu-ledger.json");
}

function readLedger(dataDir) {
  try {
    const raw = fs.readFileSync(ledgerFile(dataDir), "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function writeLedger(dataDir, ledger) {
  const file = ledgerFile(dataDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(ledger, null, 2), "utf8");
  fs.renameSync(temp, file);
}

/**
 * 记一次测卡读到的变量。initial/final 都是 null 时也要写，
 * 这样回查时能明确知道「酒馆没给变量」，而不是读到 undefined 猜。
 * 归属（sessionId / sessionPath / agentId）一并落盘：回查必须按会话判，没有归属就不可读。
 */
export function recordRunVariables(dataDir, runId, entry = {}) {
  if (!dataDir || !runId) return null;
  const ledger = readLedger(dataDir);
  ledger[runId] = {
    characterId: entry.characterId || "",
    characterName: entry.characterName || "",
    chatFile: entry.chatFile || "",
    sessionId: entry.sessionId || "",
    sessionPath: entry.sessionPath || "",
    agentId: entry.agentId || "",
    mode: entry.mode || "scripted",
    initialVariables: entry.initialVariables ?? null,
    finalVariables: entry.finalVariables ?? null,
    initialVariableSource: entry.initialVariableSource || "unavailable",
    finalVariableSource: entry.finalVariableSource || "unavailable",
    mvuAvailable: entry.mvuAvailable === true,
    updatedAt: new Date().toISOString(),
  };
  const keys = Object.keys(ledger).sort((left, right) => (
    String(ledger[left]?.updatedAt || "").localeCompare(String(ledger[right]?.updatedAt || ""))
  ));
  for (const key of keys.slice(0, Math.max(0, keys.length - LEDGER_LIMIT))) delete ledger[key];
  writeLedger(dataDir, ledger);
  return ledger[runId];
}

/** 与 theater-service 同一套归属规则：会话一致才给；agentId 只当一致性核对。 */
function ownedBy(entry, scope = {}) {
  if (!entry) return false;
  if (scope.sessionId && entry.sessionId) {
    if (scope.sessionId !== entry.sessionId) return false;
  } else if (scope.sessionId || entry.sessionId) {
    if (!scope.sessionId !== !entry.sessionId) return false;
  }
  if (scope.sessionPath && entry.sessionPath) {
    if (scope.sessionPath !== entry.sessionPath) return false;
  } else if (scope.sessionPath || entry.sessionPath) {
    if (!scope.sessionPath !== !entry.sessionPath) return false;
  }
  if (scope.agentId && entry.agentId && scope.agentId !== entry.agentId) return false;
  return Boolean(scope.sessionId || scope.sessionPath);
}

export function readRunVariables(dataDir, runId, scope) {
  if (!dataDir || !runId) return null;
  const entry = readLedger(dataDir)[runId];
  if (!scope) return null;
  return ownedBy(entry, scope) ? entry : null;
}

/**
 * 历史回查。调用方必须传 scope；不传就保守返回空数组 ——
 * 宁可说「没查到」，也不把别的会话的变量整本交出去。
 */
export function listRunVariables(dataDir, limit = 20, scope) {
  if (!scope || (!scope.sessionId && !scope.sessionPath)) return [];
  const ledger = readLedger(dataDir);
  return Object.entries(ledger)
    .filter(([, entry]) => ownedBy(entry, scope))
    .sort((left, right) => String(right[1]?.updatedAt || "").localeCompare(String(left[1]?.updatedAt || "")))
    .slice(0, Math.max(1, Math.min(100, Number(limit) || 20)))
    .map(([runId, entry]) => ({ runId, ...entry }));
}

export function clearRunVariables(dataDir, runId) {
  if (!dataDir || !runId) return false;
  const ledger = readLedger(dataDir);
  if (!Object.hasOwn(ledger, runId)) return false;
  delete ledger[runId];
  writeLedger(dataDir, ledger);
  return true;
}

export { ownedBy as ownsVariableEntry };