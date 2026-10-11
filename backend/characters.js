// 鲜花酿 v2 · 酒馆角色目录（只读切片）
// v2 App 跑在受限子进程里，角色目录在 %APPDATA% 之外，裸 fs 读会被运行时拒绝，
// 所以这里一律走 ctx.resources 通道（需要 app/resources.read 授权）。

import { join } from "node:path";
import { isPng, readEmbeddedCard } from "./png-card.js";
import { runtimeConfig } from "./st-runtime.js";

const CARD_EXT = /\.(png|json)$/i;
const MAX_FIELD = {
  description: 500,
  greeting: 300,
  scenario: 300,
  personality: 300,
  systemPrompt: 400,
};
export const MAX_CHARACTER_CARD_BYTES = 16 * 1024 * 1024;
export const MAX_CHARACTER_LIST_READERS = 4;

export function v2CharacterDirectory() {
  return join(runtimeConfig().dataRoot, "default-user", "characters");
}

function text(value, limit) {
  return String(value ?? "").trim().slice(0, limit);
}

/** 角色卡原始数据 → 列表用的紧凑条目。 */
export function compactCharacter(data, fileName) {
  const name = text(data?.name, 80) || fileName.replace(CARD_EXT, "") || "未命名角色";
  return {
    id: fileName,
    file: fileName,
    name,
    description: text(data?.description, MAX_FIELD.description),
    personality: text(data?.personality, MAX_FIELD.personality),
    scenario: text(data?.scenario, MAX_FIELD.scenario),
    systemPrompt: text(data?.system_prompt, MAX_FIELD.systemPrompt),
    greeting: text(data?.first_mes ?? data?.alternate_greetings?.[0], MAX_FIELD.greeting),
    tags: Array.isArray(data?.tags) ? data.tags.slice(0, 12).map((tag) => text(tag, 24)).filter(Boolean) : [],
    creator: text(data?.creator, 60),
    format: fileName.toLowerCase().endsWith(".json") ? "json" : "png",
  };
}

/** list 回包的目录项在不同宿主版本里字段名不一致，这里都收一遍。 */
function entriesOf(result) {
  if (Array.isArray(result)) return result;
  for (const key of ["entries", "items", "files", "children"]) {
    if (Array.isArray(result?.[key])) return result[key];
  }
  return [];
}

function fileNameOf(entry) {
  const raw = typeof entry === "string" ? entry : entry?.name ?? entry?.path ?? entry?.fileName ?? "";
  return String(raw).split(/[\\/]/).pop() || "";
}

function toBytes(result) {
  const raw = result?.content ?? result?.data ?? result?.body ?? result;
  if (raw == null) return null;
  if (raw instanceof Uint8Array) return Buffer.from(raw);
  if (raw instanceof ArrayBuffer) return Buffer.from(new Uint8Array(raw));
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (!trimmed) return null;
    const buf = Buffer.from(trimmed, "base64");
    return buf.length ? buf : null;
  }
  return null;
}

async function readBytes(ctx, filePath, maxBytes = MAX_CHARACTER_CARD_BYTES) {
  const stat = await ctx.resources.stat({ kind: "local-file", path: filePath });
  if (!stat?.exists || stat.isDirectory) return null;
  const knownSize = Number(stat.version?.size ?? stat.size);
  if (!Number.isFinite(knownSize) || knownSize < 0) return null;
  if (knownSize > maxBytes) {
    const error = new Error(`角色卡超过 ${Math.floor(maxBytes / (1024 * 1024))} MB 安全读取上限，无法预览或导入。`);
    error.code = "HANABREW_CHARACTER_TOO_LARGE";
    throw error;
  }
  const result = await ctx.resources.read({ kind: "local-file", path: filePath }, { encoding: "base64" });
  const bytes = toBytes(result);
  if (bytes?.length > maxBytes) {
    const error = new Error(`角色卡超过 ${Math.floor(maxBytes / (1024 * 1024))} MB 安全读取上限，无法预览或导入。`);
    error.code = "HANABREW_CHARACTER_TOO_LARGE";
    throw error;
  }
  return bytes;
}

/** 解析一张卡：先经 ResourceIO stat 限尺寸，再读 PNG/JSON；坏卡跳过，超限卡明确报错。 */
export async function readCharacterFile(ctx, filePath) {
  let card = null;
  try {
    if (filePath.toLowerCase().endsWith(".json")) {
      const bytes = await readBytes(ctx, filePath);
      if (!bytes) return null;
      card = JSON.parse(bytes.toString("utf8"));
    } else {
      const bytes = await readBytes(ctx, filePath);
      card = bytes ? readEmbeddedCard(bytes) : null;
    }
  } catch (error) {
    if (error?.code === "HANABREW_CHARACTER_TOO_LARGE") throw error;
    return null;
  }
  if (!card) return null;
  // 角色卡外层包着 spec/data，真正的人设字段都在 data 里。
  return card.data && typeof card.data === "object" ? card.data : card;
}

/** 取角色卡 PNG 当头像；JSON 卡尝试同名 PNG，读不到就按无头像处理。 */
export async function readCharacterAvatar(ctx, fileName) {
  const name = String(fileName ?? "");
  if (!name || name !== name.split(/[\\/]/).pop() || /[\0\r\n]/u.test(name)) return null;
  const candidates = /\.png$/iu.test(name) ? [name] : /\.json$/iu.test(name) ? [name.replace(/\.json$/iu, ".png")] : [];
  for (const candidate of candidates) {
    try {
      const bytes = await readBytes(ctx, join(v2CharacterDirectory(), candidate));
      if (isPng(bytes)) return bytes;
    } catch {
      // 没有可用头像时允许角色以首字占位进入茶话会。
    }
  }
  return null;
}

/**
 * 列出 v2 酒馆里的角色卡。单卡限 16 MB、最多并发读四张；超限项留在列表说明原因。
 * 读不到目录（酒馆没起、数据根还没生成、权限没批）时返回空数组，由界面提示。
 */
export async function listV2Characters(ctx) {
  const directory = v2CharacterDirectory();
  let listing;
  try {
    listing = await ctx.resources.list({ kind: "local-file", path: directory });
  } catch {
    return [];
  }
  const files = entriesOf(listing)
    .map(fileNameOf)
    .filter((name) => CARD_EXT.test(name));
  if (!files.length) return [];

  const cards = new Array(files.length);
  let nextIndex = 0;
  const workerCount = Math.min(MAX_CHARACTER_LIST_READERS, files.length);
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (nextIndex < files.length) {
      const index = nextIndex++;
      const file = files[index];
      try {
        const data = await readCharacterFile(ctx, join(directory, file));
        cards[index] = data ? compactCharacter(data, file) : null;
      } catch (error) {
        cards[index] = error?.code === "HANABREW_CHARACTER_TOO_LARGE"
          ? {
            id: file,
            file,
            name: file.replace(CARD_EXT, "") || "未命名角色",
            description: "这张角色卡超过安全读取上限，不能预览或导入。",
            personality: "",
            scenario: "",
            systemPrompt: "",
            greeting: "",
            tags: [],
            creator: "",
            format: file.toLowerCase().endsWith(".json") ? "json" : "png",
            unavailableReason: error.message,
          }
          : null;
      }
    }
  }));
  return cards
    .filter(Boolean)
    .sort((a, b) => a.name.localeCompare(b.name, "zh-CN"));
}
