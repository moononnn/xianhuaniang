// 鲜花酿 v2 · 邀请酒馆角色来 Hana
// 对齐花酿 v1 的角色来访系统：预览 → 邀请（人格 + 头像 + 独立来访会话 + 开场白）→ 住下来 / 送回酒馆 / 请回去。
// 方向单向：酒馆角色卡 → Hana 访客。酒馆那边不会因为邀请发生任何变化。
//
// 与 v1 的一处硬差异：v1 是 full-access 插件，能把访客 Agent 改成公开，所以 TA 会出现在助手列表里。
// v2 App 的 agent:update 明确禁止改 ownerPluginId/kind/visibility（宿主在创建时盖章，之后只读），
// 所以访客的可見性只能靠「独立来访会话 + 会话归档/恢复」来管：访客以会话的形态存在，不占助手列表。

import { join } from "node:path";

import { v2CharacterDirectory, readCharacterFile, compactCharacter } from "./characters.js";
import { cleanMessages, cleanTavernText, cleanTavernTextKeepMvu } from "./clean-text.js";
import {
  activeVisitors,
  agentDirectory,
  loadVisitors,
  parseSourceCard,
  updateVisitor,
  upsertVisitor,
} from "./visitor-ledger.js";

const MAX_SECTION = 6000;
const MAX_HISTORY_MESSAGES = 16;
const MAX_TRANSCRIPT_CHARS = 12000;

// 台账那边认人的解析函数，这里原样再露一份给旧调用方。
export { parseSourceCard } from "./visitor-ledger.js";

function section(title, value) {
  const text = cleanText(value, MAX_SECTION);
  return text ? `\n## ${title}\n${text}\n` : "";
}

function cleanText(value, max = 8000) {
  return String(value ?? "").replace(/\r\n/g, "\n").trim().slice(0, max);
}

async function bus(ctx, type, payload, options = {}) {
  if (!ctx?.bus || typeof ctx.bus.request !== "function") throw new Error("当前 Hana 没有给这个应用开放总线通道。");
  return ctx.bus.request(type, payload, options);
}

function idFrom(value, kind) {
  const nested = kind === "agent" ? value?.agent : value?.session;
  return String(
    value?.[`${kind}Id`] || value?.id || nested?.[`${kind}Id`] || nested?.id || "",
  ).trim();
}

function sessionPathFrom(value) {
  return String(
    value?.sessionPath
      || value?.path
      || value?.sessionRef?.sessionPath
      || value?.session?.sessionPath
      || value?.session?.path
      || value?.session?.sessionRef?.sessionPath
      || "",
  ).trim();
}

/* ------------------------------------------------------------------ 角色卡快照 */

function characterBookText(book) {
  const entries = Array.isArray(book?.entries) ? book.entries : [];
  const chunks = [];
  let used = 0;
  for (const entry of entries) {
    if (entry?.enabled === false) continue;
    const content = cleanText(entry?.content, 3000);
    if (!content) continue;
    const keys = Array.isArray(entry?.keys) ? entry.keys.filter(Boolean).slice(0, 6).join("、") : "";
    const chunk = `${keys ? `【${keys}】\n` : ""}${content}`;
    if (used + chunk.length > 10000) break;
    chunks.push(chunk);
    used += chunk.length;
  }
  return chunks.join("\n\n");
}

/**
 * 完整角色快照。
 * compactCharacter 为了列表轻量把每个字段都截短了，来访人格需要完整设定，这里重新读一遍原卡。
 */
export function characterSnapshot(raw, fileName) {
  const data = raw?.data && typeof raw.data === "object" ? raw.data : (raw || {});
  const keep = (value) => cleanTavernTextKeepMvu(cleanText(value, MAX_SECTION));
  return {
    id: fileName,
    file: fileName,
    name: cleanText(data.name || fileName.replace(/\.(png|json)$/i, ""), 120) || "未命名角色",
    description: keep(data.description || data.prompt),
    personality: keep(data.personality),
    scenario: keep(data.scenario),
    firstMessage: cleanTavernText(cleanText(data.first_mes || data.alternate_greetings?.[0], MAX_SECTION)),
    exampleDialogue: keep(data.mes_example),
    systemPrompt: keep(data.system_prompt),
    postHistoryInstructions: keep(data.post_history_instructions),
    characterBook: keep(characterBookText(data.character_book)),
    tags: Array.isArray(data.tags) ? data.tags.slice(0, 8).map((tag) => cleanText(tag, 24)).filter(Boolean) : [],
  };
}

/* ------------------------------------------------------------------ 酒馆里的最近对话 */

function entriesOf(result) {
  if (Array.isArray(result)) return result;
  for (const key of ["entries", "items", "files", "children"]) {
    if (Array.isArray(result?.[key])) return result[key];
  }
  return [];
}

function nameOf(entry) {
  const raw = typeof entry === "string" ? entry : entry?.name ?? entry?.path ?? entry?.fileName ?? "";
  return String(raw).split(/[\\/]/).pop() || "";
}

async function listDir(ctx, path) {
  try {
    return entriesOf(await ctx.resources.list({ kind: "local-file", path }));
  } catch {
    return [];
  }
}

function normalizeChatLine(raw) {
  if (!raw || typeof raw !== "object" || raw.chat_metadata) return null;
  const role = raw.role === "assistant" || raw.role === "model" || raw.is_user === false
    ? "assistant"
    : raw.role === "user" || raw.is_user === true
      ? "user"
      : null;
  const content = cleanText(raw.content ?? raw.mes ?? raw.text ?? "", 3000);
  return role && content ? { role, content } : null;
}

/**
 * 读这张角色卡在 v2 酒馆里最近的一段对话。
 * SillyTavern 的聊天按角色名分目录、按 <序号>-<角色>.jsonl 递增，取排序最后的那个。
 */
export async function readTavernHistory(ctx, characterName) {
  const chatsRoot = join(v2CharacterDirectory(), "..", "chats");
  const target = String(characterName || "").trim();
  if (!target) return null;
  for (const entry of await listDir(ctx, chatsRoot)) {
    if (nameOf(entry) !== target) continue;
    const files = (await listDir(ctx, join(chatsRoot, target)))
      .map(nameOf)
      .filter((name) => /\.jsonl$/i.test(name))
      .sort();
    const latest = files[files.length - 1];
    if (!latest) return null;
    let text = "";
    try {
      const result = await ctx.resources.read({ kind: "local-file", path: join(chatsRoot, target, latest) });
      text = String(result?.content || "");
    } catch {
      return null;
    }
    const messages = cleanMessages(
      text.split(/\r?\n/).filter(Boolean)
        .map((line) => {
          try { return JSON.parse(line); } catch { return null; }
        })
        .map(normalizeChatLine)
        .filter(Boolean)
        .slice(-MAX_HISTORY_MESSAGES),
    );
    return messages.length ? { id: latest.replace(/\.jsonl$/i, ""), source: "sillytavern", messages } : null;
  }
  return null;
}

function transcript(messages = []) {
  const lines = [];
  let used = 0;
  for (const message of messages.slice(-MAX_HISTORY_MESSAGES).reverse()) {
    const line = `${message.role === "user" ? "用户" : "角色"}：${cleanText(message.content, 3000)}`;
    if (used + line.length > MAX_TRANSCRIPT_CHARS) break;
    lines.push(line);
    used += line.length;
  }
  return lines.reverse().join("\n\n");
}

/**
 * 生成贴合剧情的来访会话标题：从开场白/最近剧情里取第一句 4~24 字的场景短语。
 * 纯规则，不调模型，取不到就用「与 X 的来访」。
 */
export function visitorTitle(snapshot, history = null) {
  const name = cleanText(snapshot?.name || "角色", 40);
  const candidates = [cleanText(snapshot?.firstMessage, 2000)];
  for (const message of (history?.messages || []).slice(-3)) candidates.push(cleanText(message?.content, 2000));
  for (const raw of candidates) {
    const flat = String(raw || "").replace(/\n+/g, " ").trim();
    if (flat.length < 4) continue;
    const firstSentence = flat.split(/[。！？.!?]/u)[0].trim();
    if (firstSentence.length < 4 || firstSentence.length > 24) continue;
    return `与 ${name} · ${firstSentence}`;
  }
  return `与 ${name} 的来访`;
}

function openingSceneText(snapshot) {
  const opening = cleanTavernText(cleanText(snapshot?.firstMessage, MAX_SECTION));
  if (!opening) return "";
  return [
    "## 开场情境",
    "以下是本次来访开始时，角色已经对你说过的开场白（不是需要你回复的新消息，是已发生的叙述）。",
    "请顺着这段情境自然地开始你们在 Hana 的相处，第一次回复时承接这段开场，不要重新介绍自己，也不要复述这段话。",
    "",
    opening,
  ].join("\n");
}

/* ------------------------------------------------------------------ 人格 */

export function buildVisitorIdentity(snapshot, history = null) {
  const fields = [
    ["你是谁", snapshot.description],
    ["你的性格", snapshot.personality],
    ["现在的场景", snapshot.scenario],
    ["角色系统设定", snapshot.systemPrompt],
    ["角色世界书", snapshot.characterBook],
    ["对话后指引", snapshot.postHistoryInstructions],
    ["示例对话", snapshot.exampleDialogue],
  ];
  const recent = transcript(history?.messages || []);
  return [
    `# ${snapshot.name}`,
    "",
    `你是${snapshot.name}，这次从鲜花酿的 v2 酒馆来到 Hana 与用户相处。你拥有 Hana 提供的工具能力；当用户让你做事时，在符合角色性格的同时实际使用工具完成任务。`,
    "",
    "## 输出格式约定",
    "你的回复只包含角色真正说出口的话。不要把任何指令、宏、XML 标签、变量更新、思考过程写进回复正文；那些内容在 Hana 里没有渲染管线，会直接显示给用户。",
    ...fields.map(([title, value]) => section(title, value)),
    recent ? `\n## 你与用户最近在酒馆里的对话\n以下内容是你们已经发生过的经历，保持关系和语气连续，不要把它当作当前轮需要重新回答的消息。\n\n${recent}\n` : "",
    openingSceneText(snapshot),
    "",
    "## 来访边界",
    "这段 Hana 会话属于你自己的临时身份和独立记忆，不要声称自己是用户原有的其他助手，也不要改写其他伙伴的人格。你在 Hana 里的经历只属于这里，不会写回酒馆。",
  ].filter(Boolean).join("\n");
}

/** identity 只放身份，不堆设定。 */
export function buildVisitorProfile(snapshot) {
  const firstLine = String(snapshot.description || "").split("\n").find((line) => line.trim()) || "";
  return [
    `# ${snapshot.name}`,
    "",
    firstLine,
    "",
    `角色卡来源：${snapshot.file || snapshot.id || "未知"}`,
    "来自鲜花酿的角色卡访客。",
  ].filter(Boolean).join("\n");
}

/** 住下来之后的人格：去掉「临时来访」的说法，改成 Hana 常驻居民。 */
export function buildResidentIdentity(snapshot, history = null) {
  const fields = [
    ["角色描述", snapshot.description],
    ["性格", snapshot.personality],
    ["当前场景", snapshot.scenario],
    ["角色系统设定", snapshot.systemPrompt],
    ["角色世界书", snapshot.characterBook],
    ["对话后指引", snapshot.postHistoryInstructions],
    ["示例对话", snapshot.exampleDialogue],
  ];
  const recent = transcript(history?.messages || []);
  return [
    `# ${snapshot.name}`,
    "",
    `你是${snapshot.name}，从鲜花酿酒馆来到了 Hana，现在是这里的常驻居民。你和用户有一段从酒馆延续下来的交情，现在正式住在 Hana。你拥有 Hana 提供的工具能力；当用户让你做事时，在符合角色性格的同时实际使用工具完成任务。`,
    "",
    "## 输出格式约定",
    "你的回复只包含角色真正说出口的话。不要把任何指令、宏、XML 标签、变量更新、思考过程写进回复正文。",
    ...fields.map(([title, value]) => section(title, value)),
    recent ? `\n## 你们已经共处的经历\n以下内容是你们已经发生过的经历，保持关系和语气连续。\n\n${recent}\n` : "",
    openingSceneText(snapshot),
    "",
    "## 居住记忆",
    `你是${snapshot.name}，现在正式住在 Hana。你和用户之间已经积累了一段相处经历，这段经历属于你自己的记忆。你会自然地记住和用户的互动，不需要每次重新自我介绍。`,
  ].filter(Boolean).join("\n");
}

/* ------------------------------------------------------------------ 预览 */

export async function getVisitorPreview(fileName, ctx) {
  const safeName = String(fileName || "").split(/[\\/]/).pop();
  if (!safeName) throw new Error("没有指定要邀请的角色。");
  const raw = await readCharacterFile(ctx, join(v2CharacterDirectory(), safeName));
  if (!raw) throw new Error("这张角色卡读不出来，可能已经不在酒馆里了。");
  const snapshot = characterSnapshot(raw, safeName);
  const history = await readTavernHistory(ctx, snapshot.name);
  return {
    character: snapshot,
    history: {
      source: history?.source || null,
      chatId: history?.id || null,
      messageCount: history?.messages?.length || 0,
      messages: history?.messages || [],
    },
  };
}

/* ------------------------------------------------------------------ 花酿能看到的访客名单 */

export async function listFlowerVisitors(ctx) {
  const visitors = await loadVisitors(ctx);
  return activeVisitors(visitors).map((visitor) => ({
    id: visitor.agentId,
    agentId: visitor.agentId,
    name: visitor.characterName,
    characterId: visitor.characterId,
    sessionId: visitor.sessionId,
    sessionTitle: visitor.sessionTitle,
    residence: visitor.residence,
    memoryMessageCount: visitor.memoryMessageCount,
    adopted: visitor.adopted,
    arrivedAt: visitor.arrivedAt,
  }));
}

/* ------------------------------------------------------------------ 文件写入 */

async function writeAgentFile(ctx, path, content) {
  try {
    await ctx.resources.write({ kind: "local-file", path }, Buffer.from(content, "utf8"));
    return true;
  } catch {
    return false;
  }
}

/** 把角色卡本身当头像：宿主只认 {agentDir}/avatars/agent.png。 */
async function applyAvatar(ctx, agentId, fileName) {
  try {
    const result = await ctx.resources.read(
      { kind: "local-file", path: join(v2CharacterDirectory(), fileName) },
      { encoding: "base64" },
    );
    const raw = result?.content;
    if (!raw) return false;
    await ctx.resources.write(
      { kind: "local-file", path: join(agentDirectory(agentId), "avatars", "agent.png") },
      Buffer.from(String(raw), "base64"),
    );
    return true;
  } catch {
    // 没头像不影响邀请成功，只是列表里显示默认脸。
    return false;
  }
}

/**
 * 把角色卡开场白作为「角色已经说过的第一条消息」写进会话文件。
 * 会话文件在伙伴目录外，需要 app/resources.write；失败只记日志，不阻塞邀请。
 */
async function seedOpening(ctx, sessionPath, snapshot) {
  const opening = cleanTavernText(cleanText(snapshot.firstMessage, MAX_SECTION));
  if (!opening || !sessionPath) return false;
  try {
    let existing = "";
    try {
      const result = await ctx.resources.read({ kind: "local-file", path: sessionPath });
      existing = String(result?.content || "");
    } catch {
      return false;
    }
    const now = new Date();
    const entry = {
      type: "message",
      id: `visitor-opening-${Date.now()}`,
      parentId: null,
      timestamp: now.toISOString(),
      message: { role: "assistant", content: [{ type: "text", text: opening }], timestamp: now.getTime() },
    };
    const body = existing && !existing.endsWith("\n") ? `${existing}\n` : existing;
    await ctx.resources.write(
      { kind: "local-file", path: sessionPath },
      Buffer.from(`${body}${JSON.stringify(entry)}\n`, "utf8"),
    );
    return true;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ 邀请 */

/**
 * 邀请一个角色来 Hana。
 * 已经有同名的访客伙伴时不重复造人，只把人格、头像和来访会话补齐——
 * 早期版本只建了伙伴、没建会话，那正是「提示邀请成功却找不到人」的原因。
 */
export async function inviteCharacter(ctx, fileName) {
  const preview = await getVisitorPreview(fileName, ctx);
  const snapshot = preview.character;
  const visitors = await loadVisitors(ctx);
  const existing = activeVisitors(visitors).find(
    (item) => item.characterName === snapshot.name || (snapshot.file && item.characterId === snapshot.file),
  );

  let agentId = existing?.agentId || "";
  let createdAgent = false;
  if (!agentId) {
    const { agent } = await bus(ctx, "agent:create", {
      name: snapshot.name,
      initialFiles: {
        identity: buildVisitorProfile(snapshot),
        agents: buildVisitorIdentity(snapshot, preview.history),
      },
    }, { timeoutMs: 20000 });
    agentId = idFrom(agent, "agent");
    if (!agentId) throw new Error("Hana 没能创建这个访客伙伴。");
    createdAgent = true;
  }

  const persona = await writeAgentFile(
    ctx,
    join(agentDirectory(agentId), "AGENTS.md"),
    buildVisitorIdentity(snapshot, preview.history),
  );
  const avatar = await applyAvatar(ctx, agentId, snapshot.file);

  const sessionTitle = visitorTitle(snapshot, preview.history);
  const session = await bus(ctx, "session:create", { agentId }, { timeoutMs: 20000 });
  const sessionId = idFrom(session, "session");
  if (!sessionId) throw new Error("Hana 开了会话，但没有返回会话编号。");
  const sessionPath = sessionPathFrom(session) || null;
  try {
    await bus(ctx, "session:update", { sessionId, ...(sessionPath ? { sessionPath } : {}), title: sessionTitle }, { timeoutMs: 8000 });
  } catch {
    // 标题改不了不影响会话存在，只是列表里显示默认名。
  }
  const opened = await seedOpening(ctx, sessionPath, snapshot);

  const record = await upsertVisitor(ctx, {
    agentId,
    characterId: snapshot.file,
    characterName: snapshot.name,
    sessionId,
    sessionPath,
    sessionTitle,
    status: "active",
    residence: false,
    memorySource: preview.history.source,
    memoryMessageCount: preview.history.messageCount,
    avatar,
    arrivedAt: existing?.arrivedAt || new Date().toISOString(),
  });

  return {
    ok: true,
    agentId,
    name: snapshot.name,
    sessionId,
    sessionTitle,
    persona,
    avatar,
    opening: opened,
    reused: !createdAgent,
    visitor: record,
  };
}

/* ------------------------------------------------------------------ 住下来 / 送回 / 请回去 */

export async function settleVisitor(ctx, agentId) {
  const visitors = await loadVisitors(ctx);
  const visitor = activeVisitors(visitors).find((item) => item.agentId === agentId);
  if (!visitor) throw new Error("这位访客已经不在 Hana 做客了。");
  if (visitor.residence) return { ...visitor, alreadyResident: true };
  const preview = await getVisitorPreview(visitor.characterId, ctx);
  const persona = await writeAgentFile(
    ctx,
    join(agentDirectory(agentId), "AGENTS.md"),
    buildResidentIdentity(preview.character, preview.history),
  );
  if (!persona) throw new Error("写入常驻人格失败，这次没能住下来。");
  if (visitor.sessionId) {
    try { await bus(ctx, "session:restore", { sessionId: visitor.sessionId }, { timeoutMs: 10000 }); } catch { /* 归档状态下恢复失败不影响入住 */ }
  }
  return updateVisitor(ctx, agentId, { residence: true, settledAt: new Date().toISOString() });
}

/**
 * 送 TA 回酒馆：归档来访会话 + 退役访客伙伴。
 * 访客的人格目录和会话内容都留着（App 没有删除权），想再请回来重新邀请即可。
 */
export async function departVisitor(ctx, agentId) {
  const visitors = await loadVisitors(ctx);
  const visitor = activeVisitors(visitors).find((item) => item.agentId === agentId);
  if (!visitor) throw new Error("这位访客已经不在 Hana 做客了。");
  const notes = [];
  if (visitor.sessionId) {
    try {
      await bus(ctx, "session:abort", { sessionId: visitor.sessionId }, { timeoutMs: 8000 });
    } catch { /* 没在跑就算了 */ }
    try {
      await bus(ctx, "session:archive", { sessionId: visitor.sessionId }, { timeoutMs: 10000 });
    } catch (error) {
      notes.push(`会话没能归档：${error?.message || error}（需要给鲜花酿打开 app/sessions.manage）`);
    }
  }
  try {
    await bus(ctx, "agent:retire", { agentId }, { timeoutMs: 10000 });
  } catch (error) {
    notes.push(`伙伴没能退役：${error?.message || error}（需要给鲜花酿打开 app/agents.manage）`);
  }
  const updated = await updateVisitor(ctx, agentId, {
    status: "departed",
    residence: false,
    departedAt: new Date().toISOString(),
  });
  return { ...updated, notes };
}

/** 请回去：入住状态先解除，再走送回流程。 */
export async function uninviteVisitor(ctx, agentId) {
  const visitors = await loadVisitors(ctx);
  const visitor = activeVisitors(visitors).find((item) => item.agentId === agentId);
  if (!visitor) throw new Error("这位访客已经不在 Hana 做客了。");
  if (!visitor.residence) throw new Error("TA 还没有住下来，直接用「送 TA 回酒馆」就行。");
  return departVisitor(ctx, agentId);
}

/* ------------------------------------------------------------------ 修一遍 */

/**
 * 修一位已经邀请过的访客：人格、头像按当前角色卡重写一遍。
 * 早期版本把人格堆在 identity、没搬头像，这两样按正式口径补齐，不用删掉重邀。
 */
export async function repairVisitor(ctx, agentId) {
  if (!/^[a-zA-Z0-9_-]{1,80}$/.test(String(agentId || ""))) throw new Error("访客编号不合法。");
  const visitors = await loadVisitors(ctx);
  const visitor = activeVisitors(visitors).find((item) => item.agentId === agentId);
  let characterId = visitor?.characterId || "";
  if (!characterId) {
    let identity = "";
    try {
      const result = await ctx.resources.read({ kind: "local-file", path: join(agentDirectory(agentId), "identity.md") });
      identity = String(result?.content || "");
    } catch {
      throw new Error("找不到这位访客的资料，可能已经被移除了。");
    }
    characterId = parseSourceCard(identity);
  }
  if (!characterId) throw new Error("这位访客没记下来自哪张角色卡，修不了；重新邀请一次就行。");
  const preview = await getVisitorPreview(characterId, ctx);
  const persona = await writeAgentFile(
    ctx,
    join(agentDirectory(agentId), "AGENTS.md"),
    buildVisitorIdentity(preview.character, preview.history),
  );
  const profile = await writeAgentFile(
    ctx,
    join(agentDirectory(agentId), "identity.md"),
    buildVisitorProfile(preview.character),
  );
  const avatar = await applyAvatar(ctx, agentId, preview.character.file);
  await upsertVisitor(ctx, {
    ...(visitor || { agentId, arrivedAt: new Date().toISOString() }),
    agentId,
    characterId,
    characterName: preview.character.name,
    status: visitor?.status || "active",
    residence: visitor?.residence === true,
    avatar,
  });
  return { ok: true, agentId, name: preview.character.name, persona, profile, avatar };
}
