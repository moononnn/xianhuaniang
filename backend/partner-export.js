// 鲜花酿 v2 · 把 Hana 伙伴带去酒馆
// 方向单向：Hana 伙伴人格快照 → 酒馆角色卡（带头像的 PNG）。
// 酒馆里新发生的经历不回写 Hana，两边物理隔离；这里只读伙伴资料，不写回任何一份。

import { join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { embedCharacterCardPng, isPng } from "./png-card.js";
import { v2CharacterDirectory } from "./characters.js";

const MAX_FIELD = {
  description: 6000,
  personality: 4000,
  scenario: 2000,
  firstMes: 3000,
  systemPrompt: 6000,
};

/** 导出标记：写在角色卡里，方便以后认得出这张卡从哪来。 */
const EXPORT_MARK = "hanabrew-agent-export";

/* ---------------------------------------------------------------- 隐私清洗 */

/**
 * 只保留「性格层」信息：她是谁、她怎么待人。
 * 技术规则 / 凭据 / 路径 / 内部约定逐行丢掉——白名单式筛选，拿不准宁可少带。
 * 这套规则从 v1 打磨而来，v2 沿用同一口径。
 */
const BLOCKED_HINTS = [
  "密码", "口令", "凭据", "密钥", "密匙", "token", "password", "passwd", "pwd", "secret",
  "api", "apikey", "access_key", "bearer", "ssh", "key", "pem", "证书", "验证码", "恢复码",
  "登录", "登陆", "账号", "帐号", "账户", "cookie", "session", "手机号", "邮箱", "qq号", "微信号",
  "服务器", "ip:", "ip：", "端口", "域名", "主机", "数据库", "mongodb", "mysql", "redis",
  "git", "github", "仓库", "push", "commit", "release", "sha256", "2fa",
  "工作台", "壁纸", "目录", "路径", "文件夹", "备份",
  "插件", "skill", "manifest", "发布", "打包", "命名红线", "交叉审查", "踩坑", "经验", "知识库",
  "检查清单", "测试", "dev", "开发", "代码", "技术规则", "技术细节",
  "版本", "更新", "配置", "设置", "开关", "规则",
];

const REMEMBER_HINTS = [
  "称呼", "亲近", "不要叫", "冷漠", "疏离", "真话", "恭维", "不实", "编造", "注水",
  "诚实", "敏感", "自我否定", "卑微", "鞭策", "闪光", "谦虚",
  "方言", "四川话", "说话", "语气", "口吻", "简称", "大白话", "通俗", "术语",
  "她是谁", "她怎么", "相处", "边界", "红线", "原则", "底线",
  "喜欢", "偏好", "审美", "色彩", "风格", "像素", "薄荷", "古风", "手帐",
  "共同", "记忆", "经历", "交情", "认识", "老朋友",
  "关系", "信任", "归属", "陪伴",
  "珍惜", "重视", "在意", "珍视",
  "支持", "理解", "包容", "温暖", "温度",
  "独立", "可靠", "客观", "判断",
];

const SENSITIVE_PATTERNS = [
  /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/,
  /\b[a-z][a-z0-9+.-]*:\/\//i,
  /@[\w.-]+:/,
  /:\d{2,5}\b/,
  /[A-Za-z0-9_-]{20,}/,
  /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/,
  /\b[\w-]+\.(ai|com|net|org|cn|dev|io|app|me|site|xyz|top|cc|vip|store|cloud)\b/i,
];

const INLINE_SANITIZE = [
  /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}(?::\d{1,5})?\b/g,
  /[A-Za-z0-9_-]{20,}/g,
  /@[\w.-]+:\d+/g,
  /\b[\w-]+\.(ai|com|net|org|cn|dev|io|app|me|site|xyz|top|cc|vip|store|cloud)\b/gi,
];

const PLACEHOLDER = "（已隐去）";

/** 逐行筛掉技术内容，只留性格层记忆；命中的敏感子串再抹一遍。 */
export function sanitizeMemory(raw) {
  if (!raw) return "";
  const kept = [];
  for (const line of String(raw).split(/\r?\n/).map((l) => l.trim()).filter(Boolean)) {
    const lower = line.toLowerCase();
    const blocked = BLOCKED_HINTS.some((hint) => lower.includes(hint.toLowerCase()))
      || SENSITIVE_PATTERNS.some((re) => re.test(line));
    if (blocked) continue;
    if (!REMEMBER_HINTS.some((hint) => lower.includes(hint.toLowerCase()))) continue;
    let cleaned = line;
    for (const re of INLINE_SANITIZE) cleaned = cleaned.replace(re, PLACEHOLDER);
    kept.push(cleaned);
  }
  return kept.join("\n");
}

function clip(value, limit) {
  return String(value ?? "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/\r\n/g, "\n")
    .trim()
    .slice(0, limit);
}

/**
 * 从 AGENTS.md 里取方言块。
 * 方言是伙伴性格里最鲜明的语言印记（表情包插件那块标记），原样带走。
 */
export function extractDialect(agentsMd) {
  const match = String(agentsMd || "").match(/<!--\s*[\w-]*dialect[\w-]*:start\s*-->([\s\S]*?)<!--\s*[\w-]*dialect[\w-]*:end\s*-->/i);
  return match ? match[1].trim() : "";
}

/**
 * 把记忆拆成世界书条目，每条带关键词触发。
 * 酒馆那边靠这些条目在对话里想起共同经历；跟 v1 同一套拆法。
 */
export function buildBookEntries(memoryText, userName = "对方") {
  const text = String(memoryText || "").trim();
  if (!text) return [];
  const paragraphs = text.split(/\n{2,}|(?=\n)/).map((p) => p.trim()).filter((p) => p.length >= 2);
  const entries = [];
  let uid = 1;
  for (const para of paragraphs) {
    const flat = para.replace(/\n+/g, " ").trim();
    if (flat.length < 2) continue;
    const keys = Array.from(new Set([
      userName,
      flat.slice(0, 4),
      ...(flat.match(/[\u4e00-\u9fa5]{2,4}/g) || []).slice(0, 3),
    ])).filter(Boolean).slice(0, 6);
    entries.push({
      keys,
      content: flat,
      extensions: {},
      enabled: true,
      insertion_order: uid,
      case_sensitive: false,
      name: `回忆 ${uid}`,
      priority: 10,
      id: uid,
      comment: "来自 Hana 的记忆快照",
      selective: true,
      constant: false,
      position: "before_char",
    });
    uid += 1;
  }
  return entries;
}

/* ------------------------------------------------------------------ 读伙伴 */

function toText(value) {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (value instanceof Uint8Array) return Buffer.from(value).toString("utf8");
  return String(value);
}

function toBytes(result) {
  const raw = result?.content ?? result?.data ?? result?.body ?? result;
  if (raw == null) return null;
  if (raw instanceof Uint8Array) return Buffer.from(raw);
  if (raw instanceof ArrayBuffer) return Buffer.from(new Uint8Array(raw));
  if (typeof raw === "string") {
    const buf = Buffer.from(raw.trim(), "base64");
    return buf.length ? buf : null;
  }
  return null;
}

function hanaHome() {
  return process.env.HANA_HOME || join(homedir(), ".hanako");
}

export function isValidPartnerId(agentId) {
  return typeof agentId === "string" && /^[a-zA-Z0-9_-]{1,80}$/.test(agentId);
}

/** 列出可带去酒馆的伙伴。用户自己名下和 App 私有的都会列出来，界面上可分辨。 */
export async function listExportableAgents(ctx) {
  const result = await ctx.bus.request("agent:list", { scope: "all" });
  const agents = result?.agents || [];
  return agents
    .filter((agent) => agent?.id)
    .map((agent) => ({
      id: agent.id,
      name: agent.name || agent.id,
      yuan: agent.yuan || "",
      owner: agent.ownerPluginId || "user",
      mine: agent.ownerPluginId === ctx?.appId,
    }))
    .sort((a, b) => a.name.localeCompare(b.name, "zh-CN"));
}

async function readAgentFile(ctx, agentId, relative, encoding) {
  const path = join(hanaHome(), "agents", agentId, relative);
  try {
    const result = await ctx.resources.read({ kind: "local-file", path }, encoding ? { encoding } : undefined);
    return encoding ? toBytes(result) : toText(result?.content);
  } catch {
    return encoding ? null : "";
  }
}

/** 读一份伙伴人格资料（只读，永不写回）。 */
export async function readPartnerPersona(ctx, agentId) {
  const [identity, description, agentsMd, pinned] = await Promise.all([
    readAgentFile(ctx, agentId, "identity.md"),
    readAgentFile(ctx, agentId, "description.md"),
    readAgentFile(ctx, agentId, "AGENTS.md"),
    readAgentFile(ctx, agentId, "pinned.md"),
  ]);
  return {
    identity,
    description,
    agentsMd,
    dialect: extractDialect(agentsMd),
    memory: sanitizeMemory(pinned),
  };
}

/* ---------------------------------------------------------------- 组装角色卡 */

/**
 * 伙伴资料 → 酒馆角色卡。写法对齐 v1 正式版：
 * 人格主体带方言与世界书记忆，场景和系统提示都写明「单向快照」的边界。
 */
export function buildPartnerCard(partner, persona, options = {}) {
  const withMemory = options.withMemory !== false;
  const name = clip(partner.name, 120) || "Hana 伙伴";
  const dialect = persona.dialect || "";

  const personalityBase = clip(
    [persona.description, persona.agentsMd].filter(Boolean).join("\n\n") || persona.identity,
    MAX_FIELD.personality,
  );
  const personality = dialect
    ? `【语言习惯】\n${clip(dialect, 1400)}\n\n【性格】\n${personalityBase}`
    : personalityBase;

  const scenario = `【酒馆版 · 单向快照】你是从 Hana 来到酒馆的「${name}」，这份记忆是导出的那一刻的快照。你在酒馆里的经历只属于酒馆，不会传回 Hana。保持你原本的性格、口吻与相处方式。`;
  const systemPrompt = withMemory
    ? `你带着和${options.userName || "对方"}相处的真实记忆来到酒馆。记得你们之间的称呼、共同经历与相处习惯，自然地延续这份关系。`
    : "";
  const firstLine = clip(persona.identity, 2000).split("\n").find((line) => line.trim() && !line.trim().startsWith("#")) || "";
  const firstMes = clip(
    options.firstMes || `${name}从另一个世界轻轻敲了敲你的门：\n\n「好久不见呀。听说在这里，我们可以只是我们。」`,
    MAX_FIELD.firstMes,
  );
  const characterBook = withMemory && persona.memory
    ? { name: `${name}的回忆`, entries: buildBookEntries(persona.memory, options.userName) }
    : null;

  return {
    spec: "chara_card_v2",
    spec_version: "2.0",
    data: {
      name,
      description: clip(personalityBase, MAX_FIELD.description),
      personality,
      scenario: clip(scenario, MAX_FIELD.scenario),
      first_mes: firstLine ? clip(`${firstLine}\n\n${firstMes}`, MAX_FIELD.firstMes) : firstMes,
      mes_example: "",
      creator_notes: `由 Hana 导出 · ${new Date().toISOString().slice(0, 10)}\n这份角色卡是「${partner.id}」的单向快照，酒馆里的经历不会回写 Hana。`,
      system_prompt: clip(systemPrompt || persona.identity, MAX_FIELD.systemPrompt),
      post_history_instructions: "",
      tags: ["Hana伙伴", "单向快照", "鲜花酿"],
      creator: "moononnn & 小花",
      character_version: "1.0.0",
      extensions: { [EXPORT_MARK]: { agentId: partner.id, exportedAt: new Date().toISOString(), oneWay: true } },
      character_book: characterBook,
    },
  };
}

/* -------------------------------------------------------------------- 落盘 */

function safeFileStem(name) {
  return String(name || "partner")
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, "_")
    .slice(0, 60) || "partner";
}

/**
 * 写文件。
 * ctx.resources.write 的入参形状没有实测记录，这里按 SDK 对称形状依次尝试，
 * 成功形态在进程内记住，之后不再重复试错。
 */
let writeShape = null;
async function writeResource(ctx, path, bytes) {
  const attempts = writeShape === null
    ? [
        () => ctx.resources.write({ kind: "local-file", path }, bytes),
        () => ctx.resources.write({ kind: "local-file", path }, { content: bytes }),
        () => ctx.resources.write({ kind: "local-file", path }, bytes.toString("base64"), { encoding: "base64" }),
      ]
    : [() => ctx.resources.write({ kind: "local-file", path }, bytes)];
  let lastError = null;
  for (let index = 0; index < attempts.length; index++) {
    try {
      const result = await attempts[index]();
      if (writeShape === null) writeShape = index;
      return result;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error("角色卡写进酒馆失败。");
}

/** 读伙伴头像：只认已经是 PNG 的字节；没有就用花酿自带的默认脸。 */
async function readPartnerAvatar(ctx, agentId) {
  for (const ext of ["png", "jpg", "jpeg", "webp"]) {
    const bytes = await readAgentFile(ctx, agentId, join("avatars", `agent.${ext}`), "base64");
    if (ext === "png" && bytes && isPng(bytes)) return bytes;
  }
  return null;
}

async function defaultAvatar(ctx) {
  const path = fileURLToPath(new URL("../assets/icon.png", import.meta.url));
  const result = await ctx.resources.read({ kind: "local-file", path }, { encoding: "base64" });
  return toBytes(result);
}

/** 酒馆还没在这台机器上开过时角色目录并不存在，先把它建出来。 */
async function ensureCharacterDirectory(ctx) {
  const directory = v2CharacterDirectory();
  try {
    await ctx.resources.mkdir({ kind: "local-file", path: directory });
  } catch {
    // 已存在时宿主会报错，这里忽略：随后的写入会自己说明结果。
  }
  return directory;
}

/**
 * 执行导出：把一位伙伴整理成酒馆角色卡并落盘。
 * 返回写出的文件名和是否换用了默认头像。
 */
export async function exportPartnerToTavern(ctx, agentId) {
  if (!isValidPartnerId(agentId)) throw new Error("伙伴编号不合法。");
  const agents = await listExportableAgents(ctx);
  const partner = agents.find((agent) => agent.id === agentId);
  if (!partner) throw new Error("没有找到这位伙伴。");

  const persona = await readPartnerPersona(ctx, agentId);
  const card = buildPartnerCard(partner, persona);

  const avatar = await readPartnerAvatar(ctx, agentId) || await defaultAvatar(ctx);
  if (!avatar) throw new Error("找不到可用的头像，角色卡没有写出。");
  const png = embedCharacterCardPng(avatar, card);

  const fileName = `${safeFileStem(partner.name)}.png`;
  const directory = await ensureCharacterDirectory(ctx);
  await writeResource(ctx, join(directory, fileName), png);
  return { ok: true, file: fileName, name: partner.name };
}
