// 鲜花酿 v2 · 访客台账
//
// 「正在 Hana 做客」这份名单只认两样东西：
//   1. 台账里登记过的访客（鲜花酿自己邀请时写下）；
//   2. 伙伴目录里身份文件带鲜花酿来访标记的遗留访客（早期版本只建了伙伴、没登记台账）。
// 绝不用 agent:list 全量名单冒充访客——本机伙伴不应被算成酒馆客人。

import { join } from "node:path";
import { homedir } from "node:os";

const LEDGER_FILE = "visitors.json";
const AGENT_ID_RE = /^[a-zA-Z0-9_-]{1,80}$/;

export function hanaHome() {
  return process.env.HANA_HOME || join(homedir(), ".hanako");
}

export function agentDirectory(agentId) {
  return join(hanaHome(), "agents", agentId);
}

/** 台账放在这个 App 自己的数据目录里（App 沙箱允许免授权读写）。 */
export function ledgerPath(ctx) {
  const dir = String(ctx?.dataDir || "").trim() || join(hanaHome(), "app-data", "xianhuaniang");
  return join(dir, LEDGER_FILE);
}

const EMPTY = { visitors: [] };

export async function readLedger(ctx) {
  try {
    const result = await ctx.resources.read({ kind: "local-file", path: ledgerPath(ctx) });
    const parsed = JSON.parse(String(result?.content || ""));
    const visitors = Array.isArray(parsed?.visitors) ? parsed.visitors : [];
    return { visitors: visitors.filter((item) => item && typeof item === "object") };
  } catch {
    return { ...EMPTY };
  }
}

export async function writeLedger(ctx, ledger) {
  const visitors = (Array.isArray(ledger?.visitors) ? ledger.visitors : []).map(normalizeEntry);
  const payload = JSON.stringify({ version: 1, visitors }, null, 2);
  await ctx.resources.write({ kind: "local-file", path: ledgerPath(ctx) }, Buffer.from(payload, "utf8"));
  return visitors;
}

function normalizeEntry(entry) {
  return {
    agentId: String(entry?.agentId || ""),
    characterId: String(entry?.characterId || ""),
    characterName: String(entry?.characterName || ""),
    sessionId: String(entry?.sessionId || ""),
    sessionPath: entry?.sessionPath ? String(entry.sessionPath) : null,
    sessionTitle: String(entry?.sessionTitle || ""),
    status: entry?.status === "departed" ? "departed" : "active",
    residence: entry?.residence === true,
    memorySource: entry?.memorySource || null,
    memoryMessageCount: Number(entry?.memoryMessageCount || 0),
    avatar: entry?.avatar === true,
    arrivedAt: String(entry?.arrivedAt || ""),
    settledAt: entry?.settledAt ? String(entry.settledAt) : null,
    departedAt: entry?.departedAt ? String(entry.departedAt) : null,
    adopted: entry?.adopted === true,
  };
}

/**
 * 从旧版身份文件里认出访客。
 * 早期版本把「来自花酿的 v2 酒馆 / 角色卡来源：xxx.png」写进 identity.md，
 * 认这行标记就能把没登记台账的访客捞回来，不用删掉重邀。
 */
export function parseSourceCard(identityText) {
  const match = String(identityText || "").match(/角色卡(?:来源)?[：:]\s*(\S+)/);
  return match ? match[1].trim().replace(/[\\/]+$/, "") : "";
}

export function looksLikeVisitor(identityText) {
  return /花酿[的\s]*(v2\s*)?酒馆|鲜花酿|来自花酿/.test(String(identityText || ""));
}

function entriesOf(result) {
  if (Array.isArray(result)) return result;
  for (const key of ["entries", "items", "files", "children"]) {
    if (Array.isArray(result?.[key])) return result[key];
  }
  return [];
}

function dirNameOf(entry) {
  const raw = typeof entry === "string" ? entry : entry?.name ?? entry?.path ?? "";
  return String(raw).split(/[\\/]/).filter(Boolean).pop() || "";
}

async function readText(ctx, path) {
  try {
    const result = await ctx.resources.read({ kind: "local-file", path });
    return String(result?.content || "");
  } catch {
    return "";
  }
}

/**
 * 扫伙伴目录，把带鲜花酿来访标记、但台账里没有的访客补登记进来。
 * 只补「找得到身份文件、认得出角色卡来源」的；认不出的不猜，让界面上以普通伙伴身份存在。
 */
export async function adoptUnregisteredVisitors(ctx, ledger) {
  let listing;
  try {
    listing = await ctx.resources.list({ kind: "local-file", path: join(hanaHome(), "agents") });
  } catch {
    return { ledger, adopted: [] };
  }
  const known = new Set(ledger.visitors.map((item) => item.agentId));
  const adopted = [];
  for (const entry of entriesOf(listing)) {
    const agentId = dirNameOf(entry);
    if (!AGENT_ID_RE.test(agentId) || known.has(agentId)) continue;
    const identity = await readText(ctx, join(agentDirectory(agentId), "identity.md"));
    if (!looksLikeVisitor(identity)) continue;
    const characterId = parseSourceCard(identity);
    const name = String(identity.split("\n")[0] || "").replace(/^#\s*/, "").trim() || agentId;
    adopted.push(normalizeEntry({
      agentId,
      characterId,
      characterName: name,
      arrivedAt: "",
      adopted: true,
    }));
  }
  if (!adopted.length) return { ledger, adopted };
  const visitors = [...ledger.visitors, ...adopted];
  await writeLedger(ctx, { visitors });
  return { ledger: { visitors }, adopted };
}

/** 读台账并顺手把遗留访客补进来，返回归一化后的名单。 */
export async function loadVisitors(ctx) {
  const base = await readLedger(ctx);
  const { ledger } = await adoptUnregisteredVisitors(ctx, base);
  return ledger.visitors.map((item) => ({ ...item }));
}

export async function upsertVisitor(ctx, entry) {
  const ledger = await readLedger(ctx);
  const visitors = ledger.visitors.filter((item) => item.agentId !== entry.agentId);
  visitors.push(normalizeEntry({ ...entry, status: entry.status || "active" }));
  await writeLedger(ctx, { visitors });
  return normalizeEntry(entry);
}

export async function updateVisitor(ctx, agentId, patch) {
  const ledger = await readLedger(ctx);
  let updated = null;
  const visitors = ledger.visitors.map((item) => {
    if (item.agentId !== agentId) return item;
    updated = normalizeEntry({ ...item, ...patch });
    return updated;
  });
  if (!updated) throw new Error("这位访客不在台账里，可能已经被送回酒馆了。");
  await writeLedger(ctx, { visitors });
  return updated;
}

export function activeVisitors(visitors) {
  return (Array.isArray(visitors) ? visitors : []).filter((item) => item.status !== "departed");
}
