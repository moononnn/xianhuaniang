// 鲜花酿 → 茶话会的单向角色邀请。
// 只转角色卡资料，不读取酒馆聊天记录、不改 Hana 伙伴文件。

import { homedir } from "node:os";
import { join } from "node:path";

import { readCharacterAvatar, readCharacterFile, v2CharacterDirectory } from "./characters.js";
import { cleanTavernText } from "./clean-text.js";
import { stripPngRoleCardMetadata } from "./png-card.js";

export const TEA_PARTY_APP_ID = "chahuahui";
export const TEA_PARTY_IMPORT_SERVICE = `app:${TEA_PARTY_APP_ID}/import-character`;
// 2：角色卡的世界书人格条目（基础信息 / 性格 / 二次解释 / 扮演准则）跟着一起走。
export const TEA_PARTY_IMPORT_SCHEMA_VERSION = 2;

/** 人格档案条目上限：茶话会那边的 persona 编译有总预算，这里先收口。 */
export const MAX_PERSONA_NOTES = 8;
const MAX_PERSONA_NOTE_TEXT = 2000;
const MAX_PERSONA_NOTES_TOTAL = 6000;

/**
 * 茶话会要的是「这位伙伴是谁、怎么说话、怎么待人」。
 *
 * 酒馆的世界书工程型卡片（花酿工作台那一套）几乎不写卡面四栏，人格全在
 * character_book 里。只搬人格四类条目：基础信息、性格、二次解释、扮演准则。
 * 场景、NPC、世界观、MVU 变量协议属于剧情层——搬进聊天只会让她在 QQ 上
 * 接着演办公室，关系也该由茶话会自己那套维护，不该由卡片的旧设定决定。
 */
const PERSONA_BOOK_TAGS = new Set([
  "character_basic", "character_personality", "character_rephrase", "role_play_setting",
]);
const PERSONA_BOOK_NAME_HINTS = [
  "性格", "基础信息", "扮演", "准则", "理解与思考", "调色盘", "解读", "性格档案",
];
const PERSONA_BOOK_BLOCKED = [
  "mvu", "update_variable", "status_", "initvar", "变量", "脚本", "正则", "状态栏",
  "scene", "npc", "world_setting", "地理", "事件", "剧情",
];
export const MAX_TRANSFER_AVATAR_BYTES = 4 * 1024 * 1024;

function clean(value, limit) {
  return cleanTavernText(String(value ?? ""), { userName: "你" }).slice(0, limit);
}

function cardText(value, partnerName, limit) {
  const expanded = String(value ?? "").replace(/\{\{\s*([^{}]+?)\s*\}\}/gu, (whole, rawName) => {
    const key = String(rawName).trim().toLowerCase();
    if (["char", "charname", "agentname", "name"].includes(key)) return partnerName;
    if (["user", "username"].includes(key)) return "你";
    return whole;
  });
  return clean(expanded, limit);
}

/** 条目正文外层酒馆用来圈住结构的那层标签（<world_setting>、<scene scene="办公室"> 等）。
 *  茶话会没有酒馆的渲染管线，留着只会让模型把标签当正文的一部分。 */
function stripBookScaffolding(content) {
  return String(content ?? "")
    .replace(/^[ \t]*---[ \t]*$/gmu, "")
    .replace(/^[ \t]*<\/?[a-z_][\w-]*(?:\s[^>]*)?>[ \t]*$/gimu, "")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
}

function bookEntryTag(content) {
  // 花酿工程导出的条目正文总以 `---` 分隔行开头，先跳过它再认结构标签。
  return /^\s*(?:---[ \t]*\r?\n)*[ \t]*<([a-z_][\w-]*)/iu.exec(String(content ?? ""))?.[1]?.toLowerCase() ?? "";
}

function mentions(list, value) {
  const lower = String(value ?? "").toLowerCase();
  return list.some((hint) => lower.includes(hint));
}

/**
 * 从 character_book 里挑出能进聊天的人格条目。
 * 判定以正文里的结构标签为准，条目名只作兜底；两边都认不出来的一律不收，
 * 宁可少搬也不把剧情层塞进闲聊。
 */
export function collectPersonaNotes(book) {
  const entries = Array.isArray(book?.entries) ? book.entries : [];
  const notes = [];
  let total = 0;
  for (const entry of entries) {
    if (entry?.enabled === false) continue;
    const name = String(entry?.name ?? entry?.comment ?? "").trim();
    const tag = bookEntryTag(entry?.content);
    if (mentions(PERSONA_BOOK_BLOCKED, tag) || mentions(PERSONA_BOOK_BLOCKED, name)) continue;
    const wanted = PERSONA_BOOK_TAGS.has(tag)
      || (mentions(PERSONA_BOOK_NAME_HINTS, name) && !mentions(PERSONA_BOOK_BLOCKED, name));
    if (!wanted) continue;
    const body = stripBookScaffolding(entry?.content);
    if (!body) continue;
    if (notes.length >= MAX_PERSONA_NOTES) break;
    const trimmed = body.slice(0, MAX_PERSONA_NOTE_TEXT);
    if (total + trimmed.length > MAX_PERSONA_NOTES_TOTAL) break;
    total += trimmed.length;
    notes.push({ label: clean(name, 40) || "性格档案", text: trimmed });
  }
  return notes;
}

function safeCharacterFile(value) {
  const name = String(value ?? "");
  if (!name || name !== name.split(/[\\/]/).pop() || /[\0\r\n]/u.test(name) || !/\.(?:png|json)$/iu.test(name)) {
    throw new Error("角色卡编号不合法。");
  }
  return name;
}

/** 酒馆字段 → 茶话会的版本化邀请包；提示词控制项和剧情层世界书不进入可执行资料。 */
export function buildTeaPartyImportPayload(snapshot, avatarBytes = null) {
  const file = safeCharacterFile(snapshot?.file ?? snapshot?.id);
  const safeAvatar = Buffer.isBuffer(avatarBytes) && avatarBytes.length <= MAX_TRANSFER_AVATAR_BYTES
    ? stripPngRoleCardMetadata(avatarBytes)
    : null;
  const avatar = safeAvatar
    ? { mimeType: "image/png", dataBase64: safeAvatar.toString("base64") }
    : null;
  return {
    schemaVersion: TEA_PARTY_IMPORT_SCHEMA_VERSION,
    source: {
      cardId: file,
      format: /\.png$/iu.test(file) ? "png" : "json",
    },
    character: {
      name: clean(snapshot?.name, 40),
      description: cardText(snapshot?.description, clean(snapshot?.name, 40), 8000),
      personality: cardText(snapshot?.personality, clean(snapshot?.name, 40), 4000),
      scenario: cardText(snapshot?.scenario, clean(snapshot?.name, 40), 4000),
      exampleDialogue: cardText(snapshot?.exampleDialogue, clean(snapshot?.name, 40), 3000).replace(/<START>/giu, "\n\n").replace(/\n{3,}/gu, "\n\n").trim(),
      creator: clean(snapshot?.creator, 80),
      characterVersion: clean(snapshot?.characterVersion, 100),
      creatorNotes: clean(snapshot?.creatorNotes, 2000),
      tags: Array.isArray(snapshot?.tags) ? snapshot.tags.slice(0, 12).map((tag) => clean(tag, 32)).filter(Boolean) : [],
      personaNotes: Array.isArray(snapshot?.personaNotes)
        ? snapshot.personaNotes.slice(0, MAX_PERSONA_NOTES).map((note) => ({
          label: clean(note?.label, 40),
          text: clean(note?.text, MAX_PERSONA_NOTE_TEXT),
        })).filter((note) => note.text)
        : [],
    },
    firstMessage: cardText(snapshot?.firstMessage, clean(snapshot?.name, 40), 6000),
    ...(avatar ? { avatar } : {}),
  };
}

/** 花酿判定「茶话会装没装」时用的家目录。App 沙箱里读不到它，只作探测日志里的参考值。 */
export function teaPartyHome() {
  return process.env.HANA_HOME || join(homedir(), ".hanako");
}

/** 探测接收入口有没有登记；这个宿主上对跨 App 服务恒为 false，只留痕不作判定。 */
function probeHandler(ctx) {
  if (typeof ctx?.bus?.hasHandler !== "function") return null;
  try {
    return ctx.bus.hasHandler(TEA_PARTY_IMPORT_SERVICE) === true;
  } catch {
    return null;
  }
}

/**
 * 邀请入口的状态。
 *
 * available 只有一个依据：鲜花酿有没有跨 App 通道。
 *
 * 早先版本的两个依据都已实机证伪，不再当门禁：
 * - 目录探测（existsSync 看茶话会在不在）：App 沙箱里 node:fs 看不到 HANA_HOME，
 *   家目录算得再对也是恒 false，会把装着的茶话会报成没装。
 * - hasHandler 探测：茶话会 14:25:58 注册成功，四分钟后探测仍返回 false。
 *
 * 两者都只留痕（写进探测日志备查），能不能邀请一律交给请求本身，失败码比预判准。
 */
export function teaPartyStatus(ctx) {
  const hasRequest = typeof ctx?.bus?.request === "function";
  return {
    available: hasRequest,
    reason: hasRequest ? "ready" : "no-bus",
    probe: {
      service: TEA_PARTY_IMPORT_SERVICE,
      hasRequest,
      home: teaPartyHome(),
      detected: probeHandler(ctx),
    },
  };
}

const TEA_PARTY_FAILURE_HELP = new Map([
  ["APP_CAPABILITY_DENIED", "鲜花酿没有「应用间服务调用（app/services.call）」权限。请到 Hana 设置 → 应用 → 应用权限，给鲜花酿打开这一项，再重新加载鲜花酿。"],
  ["APP_SERVICE_CALLER_INVALID", "Hana 没认出这次调用来自鲜花酿。请重新加载鲜花酿后再试一次。"],
  ["APP_SERVICE_CROSS_APP_DENIED", "茶话会没有把接收入口开放给别的 App。请把茶话会重新加载一次。"],
  ["APP_SERVICE_DISPOSED", "茶话会刚被重载过，接收入口已经重新登记。请再点一次邀请。"],
  ["APP_SERVICE_DUPLICATE", "茶话会已经登记过同名入口。请把茶话会重新加载一次。"],
  ["APP_SERVICE_NAME_INVALID", "两边的服务名对不上，属于花酿和茶话会版本不匹配。请把这两个应用都重新加载一次。"],
  ["APP_SERVICE_TYPE_INVALID", "两边的服务名对不上，属于花酿和茶话会版本不匹配。请把这两个应用都重新加载一次。"],
]);

/** 把宿主抛回来的错误码翻成一句能照着做的话，不把英文栈甩给用户。 */
export function describeTeaPartyFailure(error) {
  if (error?.name === "BusTimeoutError") return "茶话会 20 秒没有应答。请确认茶话会已经装好、启用并打开过，然后重新加载它再试。";
  if (error?.name === "AbortError") return "这次邀请被取消了。";
  const help = TEA_PARTY_FAILURE_HELP.get(String(error?.code || ""));
  if (help) return help;
  const message = String(error?.message || "");
  if (/no handler|找不到|not found|UNKNOWN_SERVICE|does not exist/iu.test(message)) {
    return "Hana 那边找不到茶话会的接收入口，多半是茶话会还没装、没启用，或者装完没重新加载过它。";
  }
  return `茶话会没有接下这位角色，聊天资料没有改动。${message ? `（${message}）` : ""}`;
}

async function characterData(ctx, fileName) {
  const file = safeCharacterFile(fileName);
  const data = await readCharacterFile(ctx, join(v2CharacterDirectory(), file));
  if (!data) throw new Error("这张角色卡读不出来，可能已经不在酒馆里了。");
  const name = clean(data.name || file.replace(/\.(?:png|json)$/iu, ""), 120) || "未命名角色";
  const book = data.character_book;
  const hasCharacterBook = Boolean(book && typeof book === "object" && (
    (Array.isArray(book.entries) && book.entries.length > 0) || Object.keys(book).length > 0
  ));
  const personaNotes = collectPersonaNotes(book).map((note) => ({
    ...note,
    text: cardText(note.text, name, MAX_PERSONA_NOTE_TEXT),
  })).filter((note) => note.text);
  // 只取明确映射的资料；system_prompt / post-history / worldbook 本身不进入导入对象。
  // 常见 {{char}} / {{user}} 只作名字替换，酒馆专用宏不执行。
  return {
    file,
    name,
    description: cardText(data.description, name, 8000),
    personality: cardText(data.personality, name, 4000),
    scenario: cardText(data.scenario, name, 4000),
    exampleDialogue: cardText(data.mes_example, name, 3000).replace(/<START>/giu, "\n\n").replace(/\n{3,}/gu, "\n\n").trim(),
    firstMessage: cardText(data.first_mes || data.alternate_greetings?.[0], name, 6000),
    creator: clean(data.creator, 80),
    characterVersion: clean(data.character_version, 100),
    creatorNotes: clean(data.creator_notes, 2000),
    tags: Array.isArray(data.tags) ? data.tags.slice(0, 12).map((tag) => clean(tag, 32)).filter(Boolean) : [],
    personaNotes,
    hasSystemPrompt: Boolean(String(data.system_prompt ?? "").trim() || String(data.prompt ?? "").trim()),
    hasPostHistoryInstructions: Boolean(String(data.post_history_instructions ?? "").trim()),
    hasCharacterBook,
  };
}

export async function teaPartyCharacterPreview(ctx, fileName) {
  const character = await characterData(ctx, fileName);
  const avatarBytes = await readCharacterAvatar(ctx, character.file);
  const safeAvatar = avatarBytes && avatarBytes.length <= MAX_TRANSFER_AVATAR_BYTES
    ? stripPngRoleCardMetadata(avatarBytes)
    : null;
  return {
    character: {
      name: character.name,
      description: clean(character.description, 8000),
      personality: clean(character.personality, 4000),
      scenario: clean(character.scenario, 4000),
      exampleDialogue: clean(character.exampleDialogue, 3000),
      firstMessage: clean(character.firstMessage, 6000),
      creator: clean(character.creator, 80),
      characterVersion: clean(character.characterVersion, 100),
      creatorNotes: clean(character.creatorNotes, 2000),
      tags: Array.isArray(character.tags) ? character.tags.slice(0, 12).map((tag) => clean(tag, 32)).filter(Boolean) : [],
    },
    avatarAvailable: Boolean(safeAvatar),
    avatarNote: !avatarBytes
      ? ""
      : avatarBytes.length > MAX_TRANSFER_AVATAR_BYTES
        ? "头像超过 4 MB，本次不会更新茶话会头像"
        : safeAvatar ? "" : "头像结构异常或尺寸超出限制，本次不会更新茶话会头像",
    notImported: [
      character.hasSystemPrompt ? "酒馆系统提示" : "",
      character.hasPostHistoryInstructions ? "对话后指引" : "",
      character.hasCharacterBook && !character.personaNotes.length
        ? "角色世界书"
        : character.hasCharacterBook ? "角色世界书的场景 / 剧情 / 变量条目" : "",
      "酒馆聊天记录",
    ].filter(Boolean),
    personaNotesIncluded: character.personaNotes.length,
  };
}

export async function inviteCharacterToTeaParty(ctx, fileName) {
  if (typeof ctx?.bus?.request !== "function") throw new Error("鲜花酿没有拿到 Hana 的应用间通道。请到 Hana 设置 → 应用 → 应用权限，给鲜花酿打开「应用间服务调用（app/services.call）」，再重新加载鲜花酿。");

  const character = await characterData(ctx, fileName);
  const avatarBytes = await readCharacterAvatar(ctx, character.file);
  const payload = buildTeaPartyImportPayload(character, avatarBytes);
  let result;
  try {
    result = await ctx.bus.request(TEA_PARTY_IMPORT_SERVICE, payload, { timeout: 20000 });
  } catch (error) {
    // 请求本身才是判定：探测说没有也照发一次，失败码能说清到底卡在哪一步。
    throw new Error(describeTeaPartyFailure(error));
  }
  if (!result || result.ok !== true || !result.partnerId) {
    throw new Error(result?.error || "茶话会没有确认收到这位角色，聊天资料没有改动。");
  }
  return {
    ...result,
    avatarIncluded: Boolean(payload.avatar),
    avatarNote: avatarBytes && !payload.avatar
      ? avatarBytes.length > MAX_TRANSFER_AVATAR_BYTES ? "头像超过 4 MB，本次不会更新茶话会头像" : "头像结构异常或尺寸超出限制，本次不会更新茶话会头像"
      : "",
  };
}
