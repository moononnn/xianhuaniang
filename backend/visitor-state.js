// 鲜花酿 v2 · 来访剧情状态
//
// 一句话：把「这次来访演到哪儿了」记在鲜花酿自己的账里，按来访会话分账。
//
// 边界写死，不给后面的调用绕：
//   - 只有鲜花酿邀请出来的访客会话能读写。按访客台账的 sessionId + sessionPath 精确对上，
//     对不上就说对不上。不按「唯一一位访客」「当前活动角色」「同一个伙伴」兜底。
//   - 伙伴身份取自访客台账（App 独占写、模型碰不到）：1.0.x 宿主工具上下文只有 sessionPath /
//     messageId / messageText / callToken，不带 agentId。归属再由宿主 agent:list(scope:'own')
//     盖章；宿主没给出名单就拒绝，不猜。宿主将来给出 agentId 时，必须与台账一致，不放宽。
//   - 会话身份只认宿主给的调用上下文；模型自报的 scope 一律不信。
//   - 状态初值永远是 {}，来源只标 app-plot。测卡账是测卡剧情的产物，跟这次来访不是同一件事，
//     会话对得上也不代表测卡变量能当来访初值，所以这里一概不读。
//   - 只写 App 自己的 dataDir 账本。账本读不出来（权限、未知错误、空文件、坏结构）一律拒绝读写，
//     不拿空账把现场抹了。
//   - 不删任何东西：只有剧情状态字段的 add / replace / remove，没有删用户数据的入口。

import { join, resolve } from "node:path";

import { readLedger } from "./visitor-ledger.js";
import { resolveSessionScope } from "./session-scope.js";
import { applyJsonPatch, parseJsonPointer, pointerGet } from "./mvu.js";

const TOOL_NAME = "hanabrew-visitor-state";
const LEDGER_FILE = "visitor-state.json";
const MAX_PATCHES = 32;
const MAX_PATH_LENGTH = 200;
const MAX_VALUE_CHARS = 8000;
const MAX_VALUE_DEPTH = 8;
const MAX_LEDGER_CHARS = 262144;
const ALLOWED_OPS = new Set(["add", "replace", "remove"]);
const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const NOT_FOUND_RE = /ENOENT|no such file|not found|不存在/i;
const NOTE = "这是鲜花酿在 Hana 里维护的来访剧情状态，不是酒馆 ST MVU 变量，也不会写回酒馆。";
const SAVE_UNKNOWN = "不能确认保存成功，请先回查再重试";

/** 同一 ctx 的写操作串行：并发调用排队，不让后一条 patch 覆盖前一条的结果。 */
const queues = new WeakMap();

/** 只有宿主给的数据目录算数，没有就拒绝，不去猜默认位置。 */
export function visitorStateFile(ctx) {
  const dir = String(ctx?.dataDir || "").trim();
  if (!dir) throw new Error("宿主没有给出这个应用的数据目录，来访状态无处落账，操作已拒绝。");
  return join(dir, LEDGER_FILE);
}

function emptyLedger() {
  return { version: 1, entries: {} };
}

function samePath(left, right) {
  return resolve(String(left || "")) === resolve(String(right || ""));
}

function enqueue(ctx, task) {
  const previous = queues.get(ctx) || Promise.resolve();
  const next = previous.then(task, task);
  queues.set(ctx, next.then(() => {}, () => {}));
  return next;
}

/* ------------------------------------------------------------------ 账本 */

function corrupt(reason) {
  return { ledger: null, corrupt: `来访状态账本${reason}，拒绝读写，避免覆盖现场。` };
}

const DENIED_RE = /EACCES|EPERM|ENOTDIR|EISDIR|permission|denied|拒绝/i;

function isNotFound(error) {
  return NOT_FOUND_RE.test(String(error?.code || "")) || NOT_FOUND_RE.test(String(error?.message || ""));
}

/** 只有宿主明确说「文件不存在」才算空账；权限拒绝和任何未知错误都不算。 */
async function confirmedAbsent(ctx, path) {
  if (typeof ctx?.resources?.stat !== "function") return false;
  try {
    const info = await ctx.resources.stat({ kind: "local-file", path });
    return info?.exists === false;
  } catch (error) {
    return isNotFound(error);
  }
}

async function readStateLedger(ctx) {
  const path = visitorStateFile(ctx);
  let raw = "";
  try {
    const result = await ctx.resources.read({ kind: "local-file", path });
    raw = String(result?.content ?? "");
  } catch (error) {
    const detail = String(error?.message || error);
    // 访问被拒不是「没有文件」，一律拒绝。
    if (DENIED_RE.test(String(error?.code || "")) || DENIED_RE.test(detail)) {
      return corrupt(`读不出来，读权限被拒（${detail}）`);
    }
    // 明确的不存在，或者宿主 stat 确认不存在，才算空账。
    if (isNotFound(error) || (await confirmedAbsent(ctx, path))) return { ledger: emptyLedger(), corrupt: "" };
    return corrupt(`读不出来，错误不明（${detail}）`);
  }
  if (!raw.trim()) return corrupt("是空文件");

  let parsed = null;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return corrupt("不是合法 JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return corrupt("结构不对");
  const entries = parsed.entries;
  if (!entries || typeof entries !== "object" || Array.isArray(entries)) return corrupt("缺少 entries");

  for (const [key, value] of Object.entries(entries)) {
    if (FORBIDDEN_KEYS.has(key)) return corrupt(`里出现危险条目名 ${key}`);
    if (!value || typeof value !== "object" || Array.isArray(value)) return corrupt(`里 ${key} 这条不是对象`);
    if (String(value.sessionId || "") !== key) return corrupt(`里条目 ${key} 与它自己的 sessionId 对不上`);
  }
  return { ledger: { version: 1, entries: { ...entries } }, corrupt: "" };
}

function usable(read) {
  if (read.corrupt) throw new Error(read.corrupt);
  return read.ledger;
}

/* ------------------------------------------------------------------ 归属 */

async function assertOwnedAgent(ctx, agentId) {
  if (!agentId) throw new Error("宿主没有确认这次调用对应的伙伴身份，无法核实归属。");
  if (!ctx?.bus?.request) {
    throw new Error("宿主没有提供伙伴名单通道，无法核实这份访客档案属于鲜花酿。");
  }
  let result = null;
  try {
    result = await ctx.bus.request("agent:list", { scope: "own" });
  } catch (error) {
    throw new Error(`宿主归属核实失败，操作已停止：${error?.message || error}`);
  }
  if (!Array.isArray(result?.agents)) {
    throw new Error("宿主未返回应用所属伙伴名单，无法核实归属，操作已停止。");
  }
  if (!result.agents.some((agent) => agent?.id === agentId)) {
    throw new Error("这次会话的伙伴不在鲜花酿的所属范围内，拒绝读写来访状态。");
  }
}

/**
 * 台账里必须有一条与当前会话对得上的活跃访客；对不上就是没有，不兜底。
 * 这里只认会话（sessionId + sessionPath）；伙伴身份的一致性由调用点单独核，
 * 宿主给出的 agentId 与台账不符时在那里拒绝。
 */
function matchVisitor(ledger, scope) {
  const matches = (ledger?.visitors || []).filter((item) => {
    if (!item || item.status === "departed") return false;
    if (String(item.sessionId || "") !== scope.sessionId) return false;
    if (!item.sessionPath || !scope.sessionPath) return false;
    if (!samePath(item.sessionPath, scope.sessionPath)) return false;
    if (!item.agentId) return false;
    return true;
  });
  if (!matches.length) {
    throw new Error("这次会话不是鲜花酿邀请的来访会话，没有对应的访客剧情状态；不会按唯一访客、活动角色或同一伙伴兜底。");
  }
  if (matches.length > 1) {
    throw new Error("访客台账里有多条记录对应这条来访会话，拒绝读写，请先整理台账。");
  }
  return matches[0];
}

/** 已建好的条目必须仍属于这一条来访会话和这一位角色，否则不认、不覆盖。 */
function assertEntryMatches(entry, scope, visitor) {
  if (String(entry.sessionId || "") !== scope.sessionId) {
    throw new Error("账本里这条来访状态的会话与当前会话对不上，拒绝读写。");
  }
  if (!samePath(entry.sessionPath, scope.sessionPath)) {
    throw new Error("账本里这条来访状态的会话路径与当前会话对不上，拒绝读写。");
  }
  if (String(entry.agentId || "") !== scope.agentId) {
    throw new Error("账本里这条来访状态的伙伴与当前会话对不上，拒绝读写。");
  }
  if (String(entry.characterId || "") !== String(visitor?.characterId || "")) {
    throw new Error("账本里这条来访状态的角色与访客台账对不上，拒绝读写。");
  }
  if (!entry.variables || typeof entry.variables !== "object" || Array.isArray(entry.variables)) {
    throw new Error("账本里这条来访状态的变量不是对象，拒绝读写。");
  }
}

/* ------------------------------------------------------------------ patch 校验 */

/** 逐段解码前的原始检查：非法 ~ 转义、空键先在这里挡掉。 */
function decodePointer(path, at) {
  const raw = path.slice(1).split("/");
  for (const segment of raw) {
    for (let i = 0; i < segment.length; i += 1) {
      if (segment[i] !== "~") continue;
      const next = segment[i + 1];
      if (next !== "0" && next !== "1") throw new Error(`${at} 的 path 里有非法转义 ~${next ?? ""}。`);
      i += 1;
    }
    if (!segment) throw new Error(`${at} 的 path 有空键。`);
  }
  return parseJsonPointer(path);
}

function assertSafeValue(value, at, depth = 0) {
  if (depth > MAX_VALUE_DEPTH) throw new Error(`${at} 的 value 嵌套超过 ${MAX_VALUE_DEPTH} 层。`);
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertSafeValue(item, `${at} 的第 ${index + 1} 项`, depth + 1));
    return;
  }
  for (const [key, item] of Object.entries(value)) {
    if (FORBIDDEN_KEYS.has(key)) throw new Error(`${at} 的 value 里不允许出现 ${key}。`);
    assertSafeValue(item, `${at} 的 ${key}`, depth + 1);
  }
}

function validatePatches(patches) {
  if (!Array.isArray(patches)) throw new Error("patches 必须是数组。");
  if (!patches.length) throw new Error("patches 是空数组，没有要写入的变更。");
  if (patches.length > MAX_PATCHES) throw new Error(`一次最多 ${MAX_PATCHES} 条 patch，收到 ${patches.length} 条。`);

  return patches.map((patch, index) => {
    const at = `第 ${index + 1} 条 patch`;
    if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw new Error(`${at} 不是对象。`);
    const op = String(patch.op || "").toLowerCase();
    if (!ALLOWED_OPS.has(op)) throw new Error(`${at} 的 op 只能是 add / replace / remove。`);
    const path = String(patch.path || "");
    if (!path.startsWith("/")) throw new Error(`${at} 的 path 必须是以 / 开头的 JSON Pointer。`);
    if (path.length > MAX_PATH_LENGTH) throw new Error(`${at} 的 path 太长。`);
    // 原型链键（__proto__ / constructor / prototype）在这里被拒。
    const segments = decodePointer(path, at);
    if (op === "remove") return { op, path, segments };
    if (!Object.hasOwn(patch, "value")) throw new Error(`${at} 是 ${op}，必须带 value。`);
    const value = patch.value;
    if (value === undefined || typeof value === "function" || typeof value === "symbol" || typeof value === "bigint") {
      throw new Error(`${at} 的 value 不是可 JSON 序列化的数据。`);
    }
    let text;
    try {
      text = JSON.stringify(value);
    } catch {
      throw new Error(`${at} 的 value 不能序列化成 JSON。`);
    }
    if (text === undefined) throw new Error(`${at} 的 value 不能序列化成 JSON。`);
    if (text.length > MAX_VALUE_CHARS) {
      throw new Error(`${at} 的 value 太大（${text.length} 字符），单个值上限 ${MAX_VALUE_CHARS} 字符。`);
    }
    assertSafeValue(value, at);
    return { op, path, segments, value };
  });
}

function parentPointer(segments) {
  const head = segments.slice(0, -1);
  if (!head.length) return "";
  return `/${head.map((part) => part.replace(/~/g, "~0").replace(/\//g, "~1")).join("/")}`;
}

function nodeAt(target, segments) {
  let node = target;
  for (const segment of segments) {
    if (node == null) return undefined;
    if (Array.isArray(node)) node = node[Number(segment)];
    else if (typeof node !== "object") return undefined;
    else if (Object.prototype.hasOwnProperty.call(node, segment)) node = node[segment];
    else return undefined;
  }
  return node;
}

function sameValue(left, right) {
  return JSON.stringify(left === undefined ? null : left) === JSON.stringify(right === undefined ? null : right);
}

/** 中间层已有值却不是对象/数组时，底层会静默不动，这里直接说清楚。 */
function assertChainIsWritable(current, segments, at) {
  let node = current;
  for (const segment of segments.slice(0, -1)) {
    if (node == null) return;
    if (Array.isArray(node) || typeof node !== "object") {
      throw new Error(`${at} 的 path 中间层 ${segment} 不是可以写入的对象。`);
    }
    node = Object.prototype.hasOwnProperty.call(node, segment) ? node[segment] : undefined;
  }
}

/** 数组下标单独校验：负数、小数、非数字、越界、以及 replace/remove 用 "-" 追加位都拒。 */
function assertArrayTarget(parent, patch, at) {
  if (!Array.isArray(parent)) return;
  const last = patch.segments[patch.segments.length - 1];
  if (last === "-") {
    if (patch.op !== "add") throw new Error(`${at} 是 ${patch.op}，不接受数组追加位 /-。`);
    return;
  }
  if (!/^\d+$/.test(last)) throw new Error(`${at} 的数组下标必须是非负整数，收到 "${last}"。`);
  const index = Number(last);
  if (index > parent.length) throw new Error(`${at} 的数组下标 ${index} 越界（长度 ${parent.length}）。`);
  if (patch.op !== "add" && index >= parent.length) throw new Error(`${at} 的数组下标 ${index} 越界（长度 ${parent.length}）。`);
}

function verifyApplied(before, after, patch, at) {
  const beforeParent = nodeAt(before, patch.segments.slice(0, -1));
  if (Array.isArray(beforeParent)) {
    const afterParent = nodeAt(after, patch.segments.slice(0, -1));
    if (!Array.isArray(afterParent)) throw new Error(`${at} 没有生效，${SAVE_UNKNOWN}。`);
    if (patch.op === "remove") {
      if (afterParent.length !== beforeParent.length - 1) throw new Error(`${at} 没有生效，${SAVE_UNKNOWN}。`);
      return;
    }
    const last = patch.segments[patch.segments.length - 1];
    const landed = last === "-" ? afterParent[afterParent.length - 1] : afterParent[Number(last)];
    if (!sameValue(landed, patch.value)) throw new Error(`${at} 没有生效，${SAVE_UNKNOWN}。`);
    return;
  }
  if (patch.op === "remove") {
    if (pointerGet(after, patch.path) !== undefined) throw new Error(`${at} 没有生效，${SAVE_UNKNOWN}。`);
    return;
  }
  if (!sameValue(pointerGet(after, patch.path), patch.value)) throw new Error(`${at} 没有生效，${SAVE_UNKNOWN}。`);
}

/**
 * 复用 mvu 的 applyJsonPatch，但按提交顺序逐条「校验 → 应用 → 确认」。
 * 逐条来才有批内语义：先 add 再 replace/remove 能吃到同一批里的前一步结果，
 * 数组删掉一个元素后，后继元素合法移位到那个下标，后续针对该下标的 patch 照常成立。
 * 底层对无效落点是静默跳过的，这里把每一次跳过都变成明面上的拒绝。
 */
function applyChecked(variables, patches) {
  let current = variables;
  for (const patch of patches) {
    const at = `${patch.op} ${patch.path}`;
    assertChainIsWritable(current, patch.segments, at);
    const parent = nodeAt(current, patch.segments.slice(0, -1));
    assertArrayTarget(parent, patch, at);
    if (patch.op !== "add" && pointerGet(current, patch.path) === undefined) {
      throw new Error(`patch ${at} 指向的字段不存在，没有写入任何变更。`);
    }
    const next = applyJsonPatch(current, [patch]);
    verifyApplied(current, next, patch, at);
    current = next;
  }
  if (!current || typeof current !== "object" || Array.isArray(current)) {
    throw new Error("这次写入把剧情状态变成了非对象，已放弃。剧情状态必须是一个对象。");
  }
  return current;
}

/* ------------------------------------------------------------------ 视图 */

function view(scope, visitor, entry) {
  return {
    ok: true,
    kind: "visitor-plot-state",
    note: NOTE,
    characterId: String(visitor?.characterId || ""),
    characterName: String(visitor?.characterName || ""),
    sessionId: scope.sessionId,
    variables: entry?.variables ?? {},
    source: "app-plot",
    revision: Number(entry?.revision || 0),
    updatedAt: String(entry?.updatedAt || ""),
  };
}

/* ------------------------------------------------------------------ 工具 */

function ok(data) {
  return { content: [{ type: "text", text: JSON.stringify(data) }] };
}

function fail(error) {
  return {
    isError: true,
    content: [{ type: "text", text: JSON.stringify({ ok: false, error: error?.message || String(error) })}],
  };
}

export async function registerVisitorStateTools(ctx) {
  if (!ctx?.tools?.register) throw new Error("宿主没有提供应用工具注册通道。");

  const cleanup = await ctx.tools.register({
    name: TOOL_NAME,
    description: "读写这次来访会话的剧情状态（鲜花酿自己维护的账，不是酒馆 ST MVU 变量，也不继承测卡变量，不会写回酒馆）。get 回读当前状态；update 用 JSON Patch（add/replace/remove）更新剧情进展，初始状态永远是空对象。任何无效 patch、越界 payload 或对不上访客会话的调用都会当场拒绝，不会静默跳过；只写这个 App 自己 dataDir 里的账本，不删用户数据。",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["get", "update"],
          description: "get 回读剧情状态；update 按 patches 写入。只更新剧情状态，不删任何用户数据。",
        },
        patches: {
          type: "array",
          description: `update 用的 JSON Patch 数组，最多 ${MAX_PATCHES} 条，按顺序生效。只改剧情状态字段，例如 {"op":"replace","path":"/mood","value":"放松"}。`,
          items: {
            type: "object",
            properties: {
              op: { type: "string", enum: ["add", "replace", "remove"], description: "add 新增或覆盖；replace 必须指向已存在字段；remove 必须指向已存在字段。" },
              path: { type: "string", description: "以 / 开头的 JSON Pointer，如 /mood、/scene/location、/list/0。不允许 __proto__ / constructor / prototype，数组下标必须是非负整数。" },
              value: { description: "add / replace 的新值；remove 不需要。单个值有大小和嵌套上限。" },
            },
            required: ["op", "path"],
          },
        },
        reason: { type: "string", description: "可选：这次更新对应的剧情变化，不影响状态内容。" },
      },
      required: ["action"],
    },
    execute: async (input) => {
      try {
        const args = input?.arguments ?? input ?? {};
        const action = String(args.action || "").trim().toLowerCase();
        if (action !== "get" && action !== "update") throw new Error("action 只能是 get 或 update。");
        if (action === "get" && args.patches != null) throw new Error("get 不接受 patches，只有 update 会写状态。");

        // 会话身份只认宿主给的上下文（模型自报的 scope 不信）。
        // 伙伴身份从访客台账读：1.0.x 的宿主工具上下文只有 sessionPath / messageId /
        // messageText / callToken，不带 agentId；台账是 App 独占写的，模型碰不到。
        const scope = await resolveSessionScope(ctx, input?.context);
        const visitor = matchVisitor(await readLedger(ctx), scope);
        scope.agentId = String(visitor.agentId || "");
        await assertOwnedAgent(ctx, scope.agentId);

        if (action === "get") {
          const entry = usable(await readStateLedger(ctx)).entries[scope.sessionId];
          if (entry) assertEntryMatches(entry, scope, visitor);
          return ok(view(scope, visitor, entry));
        }

        const patches = validatePatches(args.patches);
        const entry = await enqueue(ctx, async () => {
          const ledger = usable(await readStateLedger(ctx));
          const existing = ledger.entries[scope.sessionId];
          let base;
          if (existing) {
            assertEntryMatches(existing, scope, visitor);
            base = { ...existing };
          } else {
            base = {
              sessionId: scope.sessionId,
              sessionPath: scope.sessionPath,
              agentId: scope.agentId,
              characterId: String(visitor.characterId || ""),
              characterName: String(visitor.characterName || ""),
              variables: {},
              source: "app-plot",
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
              revision: 0,
            };
          }

          const variables = applyChecked(base.variables, patches);
          const next = { ...base, variables, revision: Number(base.revision || 0) + 1, updatedAt: new Date().toISOString() };
          const payload = JSON.stringify({ version: 1, entries: { ...ledger.entries, [scope.sessionId]: next } }, null, 2);
          if (payload.length > MAX_LEDGER_CHARS) {
            throw new Error(`来访状态账本会涨到 ${payload.length} 字符，超过 ${MAX_LEDGER_CHARS} 上限，已放弃这次写入。`);
          }

          try {
            await ctx.resources.write({ kind: "local-file", path: visitorStateFile(ctx) }, Buffer.from(payload, "utf8"));
          } catch (error) {
            throw new Error(`来访状态写入过程出错，${SAVE_UNKNOWN}：${error?.message || error}`);
          }

          try {
            const saved = usable(await readStateLedger(ctx)).entries[scope.sessionId];
            if (!saved || saved.revision !== next.revision || JSON.stringify(saved.variables) !== JSON.stringify(variables)) {
              throw new Error("落盘后回读与写入内容不一致");
            }
          } catch (error) {
            if (String(error?.message || "").includes(SAVE_UNKNOWN)) throw error;
            throw new Error(`落盘后回读不通过，${SAVE_UNKNOWN}：${error?.message || error}`);
          }
          return next;
        });

        return ok({ ...view(scope, visitor, entry), applied: patches.length, reason: String(args.reason || "") });
      } catch (error) {
        return fail(error);
      }
    },
  });

  return async () => {
    if (typeof cleanup === "function") await cleanup();
  };
}