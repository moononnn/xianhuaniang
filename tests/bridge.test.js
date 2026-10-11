// 鲜花酿 v2 · 邀请与伙伴出口的自动测试
// 纯逻辑测：不碰真机文件、不连宿主。用假的 ctx 顶替 resources / bus。

import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readFileSync } from "node:fs";

import { MAX_CHARACTER_CARD_BYTES, compactCharacter, listV2Characters } from "../backend/characters.js";
import { buildVisitorIdentity, buildVisitorProfile, inviteCharacter, parseSourceCard, repairVisitor } from "../backend/visitors.js";
import {
  buildBookEntries,
  buildPartnerCard,
  extractDialect,
  isValidPartnerId,
  sanitizeMemory,
  listExportableAgents,
  readPartnerPersona,
} from "../backend/partner-export.js";
import { embedCharacterCardPng, isPng, readEmbeddedCard } from "../backend/png-card.js";
import { fileURLToPath } from "node:url";

/** 拿花酿自己的图标当测试头像：真实可解码的 PNG，不造假字节。 */
function tinyPng() {
  return readFileSync(fileURLToPath(new URL("../assets/icon.png", import.meta.url)));
}

function fakeCtx({ files = {}, fileSizes = {}, agents = [], busHandlers = {} } = {}) {
  const calls = { list: [], stat: [], read: [], write: [], mkdir: [], bus: [] };
  const ctx = {
    appId: "xianhuaniang",
    calls,
    resources: {
      async list(ref) {
        calls.list.push(ref.path);
        const prefix = ref.path;
        // 只列直接子项：子目录取目录名，文件取文件名（真实 ResourceIO 就是这个形状）
        const entries = new Set();
        for (const path of Object.keys(files)) {
          if (!path.startsWith(prefix)) continue;
          const relative = path.slice(prefix.length + 1);
          const first = relative.split(/[\\/]/)[0];
          if (first) entries.add(first);
        }
        if (!entries.size) throw new Error("resource not found");
        return { entries: [...entries].map((name) => ({ name })) };
      },
      async stat(ref) {
        calls.stat.push(ref.path);
        const value = files[ref.path];
        if (value == null) throw new Error("resource not found");
        return { exists: true, isDirectory: false, size: fileSizes[ref.path] ?? Buffer.byteLength(Buffer.from(value)) };
      },
      async read(ref, options) {
        calls.read.push({ path: ref.path, options });
        const value = files[ref.path];
        if (value == null) throw new Error("resource not found");
        return { content: options?.encoding === "base64" ? Buffer.from(value).toString("base64") : value };
      },
      async mkdir(ref) { calls.mkdir.push(ref.path); },
      async write(ref, content) { calls.write.push({ path: ref.path, content }); },
    },
    bus: {
      async request(action, payload) {
        calls.bus.push({ action, payload });
        if (action === "agent:list") return { agents };
        if (action === "agent:create") {
          return { agent: { id: `new-${payload.name}`, name: payload.name } };
        }
        if (action === "session:create") {
          return { session: { id: `sess-${payload.agentId}`, sessionPath: join(tmpdir(), `${payload.agentId}.jsonl`) } };
        }
        if (action === "agent:update") {
          return { agent: { id: payload.agentId } };
        }
        const handler = busHandlers[action];
        if (handler) return handler(payload);
        if (action.startsWith("session:") || action === "agent:retire") return { ok: true };
        throw new Error(`unexpected bus action ${action}`);
      },
    },
  };
  return ctx;
}

/** 把 dataRoot 指到临时目录，免得测到真酒馆。 */
function useTempDataRoot() {
  const previous = process.env.APPDATA;
  const dir = join(tmpdir(), `hanabrew-v2-test-${Date.now()}`);
  process.env.APPDATA = dir;
  return {
    dir,
    charactersDir: join(dir, "xianhuaniang", "st-data", "default-user", "characters"),
    restore() { process.env.APPDATA = previous; },
  };
}

test("角色卡条目只带出必要字段，长文本被截断", () => {
  const item = compactCharacter({
    name: "  阿岚  ",
    description: "长".repeat(900),
    tags: ["刀", 123, "夜"],
    first_mes: "嗨。",
  }, "阿岚.png");
  assert.equal(item.name, "阿岚");
  assert.equal(item.description.length, 500);
  assert.deepEqual(item.tags, ["刀", "123", "夜"]);
  assert.equal(item.greeting, "嗨。");
  assert.equal(item.format, "png");
  assert.equal(compactCharacter({ system_prompt: "私有系统提示", prompt: "指令字段", personality: "" }, "空白.json").description, "");
});

test("角色目录读不到时返回空数组，不抛错", async () => {
  const root = useTempDataRoot();
  try {
    const ctx = fakeCtx();
    assert.deepEqual(await listV2Characters(ctx), []);
  } finally {
    root.restore();
  }
});

test("列出 PNG 与 JSON 两种角色卡并按名字排序", async () => {
  const root = useTempDataRoot();
  try {
    const ctx = fakeCtx({
      files: {
        [join(root.charactersDir, "小北.json")]: JSON.stringify({ name: "小北", description: "北风" }),
        [join(root.charactersDir, "阿岚.png")]: embedCharacterCardPng(tinyPng(), {
          spec: "chara_card_v2",
          data: { name: "阿岚", description: "南风" },
        }),
      },
    });
    const characters = await listV2Characters(ctx);
    assert.deepEqual(characters.map((c) => c.name), ["阿岚", "小北"]);
  } finally {
    root.restore();
  }
});

test("读角色卡前先核文件体积，超限卡片留在列表说明原因且不读取正文", async () => {
  const root = useTempDataRoot();
  try {
    const file = join(root.charactersDir, "超大角色.json");
    const ctx = fakeCtx({
      files: { [file]: JSON.stringify({ name: "超大角色" }) },
      fileSizes: { [file]: MAX_CHARACTER_CARD_BYTES + 1 },
    });
    const [character] = await listV2Characters(ctx);
    assert.equal(character.name, "超大角色");
    assert.match(character.unavailableReason, /16 MB 安全读取上限/);
    assert.deepEqual(ctx.calls.read, []);
    assert.deepEqual(ctx.calls.stat, [file]);
  } finally {
    root.restore();
  }
});

test("能从旧版 identity 里找出原始角色卡", () => {
  assert.equal(parseSourceCard("# 示例角色\n角色卡来源：示例角色.png\n"), "示例角色.png");
  assert.equal(parseSourceCard("# 示例角色\n角色卡：示例角色.png\n"), "示例角色.png");
  assert.equal(parseSourceCard("没有来源信息"), "");
});

test("修一遍：按当前角色卡补人格与头像", async () => {
  const root = useTempDataRoot();
  const home = join(root.dir, "home");
  const previousHome = process.env.HANA_HOME;
  process.env.HANA_HOME = home;
  try {
    const card = embedCharacterCardPng(readFileSync(fileURLToPath(new URL("../assets/icon.png", import.meta.url))), {
      spec: "chara_card_v2",
      data: { name: "示例角色", description: "测试用角色设定" },
    });
    const files = {
      [join(root.charactersDir, "示例角色.png")]: card,
      [join(home, "agents", "sample-partner", "identity.md")]: "# 示例角色\n\n角色卡来源：示例角色.png\n",
    };
    const ctx = fakeCtx({ files, agents: [{ id: "sample-partner", name: "示例角色" }] });
    const result = await repairVisitor(ctx, "sample-partner");
    assert.equal(result.ok, true);
    assert.equal(result.persona, true);
    assert.equal(result.avatar, true);
    const writtenAgents = ctx.calls.write.find((w) => w.path.endsWith("AGENTS.md"));
    assert.ok(writtenAgents, "应当补写 AGENTS.md");
    assert.match(writtenAgents.content.toString("utf8"), /测试用角色设定/);
    const writtenAvatar = ctx.calls.write.find((w) => w.path.endsWith("agent.png"));
    assert.ok(writtenAvatar, "应当把角色卡复制成头像");
  } finally {
    if (previousHome === undefined) delete process.env.HANA_HOME;
    else process.env.HANA_HOME = previousHome;
    root.restore();
  }
});

test("修一遍：没记来源的访客明确报错", async () => {
  const root = useTempDataRoot();
  const home = join(root.dir, "home");
  const previousHome = process.env.HANA_HOME;
  process.env.HANA_HOME = home;
  try {
    const ctx = fakeCtx({ files: { [join(home, "agents", "mystery", "identity.md")]: "# 某人\n" } });
    await assert.rejects(() => repairVisitor(ctx, "mystery"), /角色卡/);
    await assert.rejects(() => repairVisitor(ctx, "../evil"), /不合法/);
  } finally {
    if (previousHome === undefined) delete process.env.HANA_HOME;
    else process.env.HANA_HOME = previousHome;
    root.restore();
  }
});

test("访客身份文本带上角色设定与开场白", () => {
  const identity = buildVisitorIdentity({
    name: "阿岚",
    file: "阿岚.png",
    description: "南风来的",
    personality: "嘴硬",
    firstMessage: "你来啦。",
    tags: ["夜"],
  });
  assert.match(identity, /^# 阿岚/);
  assert.match(identity, /南风来的/);
  assert.match(identity, /你来啦。/);
  assert.match(identity, /## 你的性格/);
  assert.doesNotMatch(buildVisitorProfile({ name: "阿岚", description: "南风来的" }), /嘴硬/, "简介不堆设定");
});

test("邀请会建伙伴并开一条独立来访会话", async () => {
  const root = useTempDataRoot();
  const home = join(root.dir, "home");
  const previousHome = process.env.HANA_HOME;
  process.env.HANA_HOME = home;
  try {
    const files = {
      [join(root.charactersDir, "阿岚.png")]: embedCharacterCardPng(tinyPng(), {
        spec: "chara_card_v2",
        data: { name: "阿岚", description: "南风" },
      }),
    };
    const ctx = fakeCtx({ files, agents: [{ id: "hanako", name: "小花" }] });
    const result = await inviteCharacter(ctx, "阿岚.png");
    assert.equal(result.ok, true);
    assert.equal(result.name, "阿岚");
    assert.equal(result.reused, false);
    const create = ctx.calls.bus.find((c) => c.action === "agent:create");
    assert.ok(create, "应当调用 agent:create");
    assert.equal(create.payload.name, "阿岚");
    assert.match(create.payload.initialFiles.agents, /南风/, "人格要写进 AGENTS.md");
    assert.match(create.payload.initialFiles.identity, /^# 阿岚/);
    const session = ctx.calls.bus.find((c) => c.action === "session:create");
    assert.ok(session, "应当开一条来访会话");
    assert.equal(session.payload.agentId, "new-阿岚");
    assert.ok(result.sessionTitle.startsWith("与 阿岚"), "会话标题应当带着角色名");
  } finally {
    if (previousHome === undefined) delete process.env.HANA_HOME;
    else process.env.HANA_HOME = previousHome;
    root.restore();
  }
});

test("已经有同名访客时复用它，只补会话，不重复造伙伴", async () => {
  const root = useTempDataRoot();
  const home = join(root.dir, "home");
  const previousHome = process.env.HANA_HOME;
  process.env.HANA_HOME = home;
  try {
    const files = {
      [join(root.charactersDir, "阿岚.png")]: embedCharacterCardPng(tinyPng(), {
        spec: "chara_card_v2",
        data: { name: "阿岚" },
      }),
      [join(home, "agents", "alan", "identity.md")]: "# 阿岚\n\n角色卡来源：阿岚.png\n来自花酿 v2 酒馆。\n",
    };
    const ctx = fakeCtx({ files, agents: [{ id: "alan", name: "阿岚" }] });
    const result = await inviteCharacter(ctx, "阿岚.png");
    assert.equal(result.ok, true);
    assert.equal(result.reused, true);
    assert.equal(result.agentId, "alan");
    assert.ok(!ctx.calls.bus.some((c) => c.action === "agent:create"), "不该再造一个同名伙伴");
    assert.ok(ctx.calls.bus.some((c) => c.action === "session:create"), "应该补一条来访会话");
  } finally {
    if (previousHome === undefined) delete process.env.HANA_HOME;
    else process.env.HANA_HOME = previousHome;
    root.restore();
  }
});

test("记忆清洗丢掉技术内容，保留性格层", () => {
  const cleaned = sanitizeMemory([
    "她说话带四川方言，称呼当前用户。",
    "数据库密码在 config 里，端口 5432。",
    "她诚实，不说恭维话。",
    "https://example.com/token/abcdef",
  ].join("\n"));
  assert.match(cleaned, /四川方言/);
  assert.match(cleaned, /诚实/);
  assert.doesNotMatch(cleaned, /密码/);
  assert.doesNotMatch(cleaned, /5432/);
  assert.doesNotMatch(cleaned, /example\.com/);
});

test("伙伴编号挡住路径穿越", () => {
  assert.equal(isValidPartnerId("hanako"), true);
  assert.equal(isValidPartnerId("../secrets"), false);
  assert.equal(isValidPartnerId("a/b"), false);
  assert.equal(isValidPartnerId(""), false);
});

test("导出的角色卡带姓名、性格与开场白", () => {
  const card = buildPartnerCard(
    { name: "伙伴甲" },
    { identity: "# 伙伴甲\n\n理性优先，说话克制。", description: "用户的伙伴", memory: "诚实，直接。" },
  );
  assert.equal(card.spec, "chara_card_v2");
  assert.equal(card.data.name, "伙伴甲");
  assert.match(card.data.description, /理性优先|用户的伙伴/);
  assert.equal(card.data.personality, "诚实，直接。".length ? card.data.personality : "");
  assert.match(card.data.scenario, /单向快照/);
  assert.equal(card.data.mes_example, "");
  assert.equal(card.data.creator, "moononnn & 小花");
  assert.deepEqual(card.data.tags, ["Hana伙伴", "单向快照", "鲜花酿"]);
  assert.equal(card.data.extensions["hanabrew-agent-export"].oneWay, true);
});

test("方言块单独拎出来放在性格开头", () => {
  const card = buildPartnerCard({ name: "小花" }, {
    identity: "# 小花\n\n四川人。",
    description: "",
    agentsMd: "<!-- biaoqingbao-dialect:start -->要得、巴适噻<!-- biaoqingbao-dialect:end -->\n其它规则",
    dialect: "要得、巴适噻",
    memory: "",
  });
  assert.match(card.data.personality, /【语言习惯】/);
  assert.match(card.data.personality, /巴适/);
  // 与 v1 正式版一致：AGENTS.md 的人格规则整体带走，只去掉注释标记。
  assert.match(card.data.personality, /其它规则/);
  assert.doesNotMatch(card.data.personality, /<!--/);
});

test("记忆拆成带关键词的世界书条目", () => {
  const card = buildPartnerCard({ name: "伙伴甲" }, {
    identity: "",
    description: "理性",
    memory: "我们认识很久了。\n\n她喜欢真实，不喜欢恭维。",
  });
  const book = card.data.character_book;
  assert.equal(book.name, "伙伴甲的回忆");
  assert.equal(book.entries.length, 2);
  assert.ok(book.entries[0].keys.length >= 1);
  assert.equal(book.entries[0].comment, "来自 Hana 的记忆快照");
  assert.equal(book.entries[0].position, "before_char");
});

test("不带记忆时不生成世界书", () => {
  const card = buildPartnerCard({ name: "伙伴甲" }, { identity: "x", description: "y", memory: "" });
  assert.equal(card.data.character_book, null);
});

test("方言块能从 AGENTS.md 里抠出来", () => {
  const md = "前面\n<!-- biaoqingbao-dialect:start -->\n说话带四川味\n<!-- biaoqingbao-dialect:end -->\n后面";
  assert.equal(extractDialect(md), "说话带四川味");
  assert.equal(extractDialect("没有标记"), "");
});

test("PNG 角色卡写入后能原样读回", () => {
  const card = { spec: "chara_card_v2", data: { name: "伙伴甲" } };
  const png = embedCharacterCardPng(tinyPng(), card);
  assert.equal(isPng(png), true);
  const back = readEmbeddedCard(png);
  assert.equal(back.data.name, "伙伴甲");
  assert.equal(back.spec_version, "3.0", "ccv3 字段应标成 V3");
});

test("非 PNG 头像直接拒绝，不硬塞", () => {
  assert.throws(() => embedCharacterCardPng(Buffer.from("not a png"), { data: {} }), /PNG/);
});

test("伙伴列表标出哪些是自己名下的", async () => {
  const ctx = fakeCtx({
    agents: [
      { id: "hanako", name: "小花", ownerPluginId: "xianhuaniang" },
      { id: "partner-a", name: "伙伴甲", ownerPluginId: "" },
    ],
  });
  const agents = await listExportableAgents(ctx);
  assert.deepEqual(agents.map((a) => a.name), ["伙伴甲", "小花"]);
  assert.equal(agents.find((a) => a.name === "小花").mine, true);
  assert.equal(agents.find((a) => a.name === "伙伴甲").mine, false);
});

test("读伙伴资料时清洗记忆、读不到就留空", async () => {
  const root = useTempDataRoot();
  const home = process.env.APPDATA;
  void home;
  const files = {};
  const ctx = fakeCtx({ files });
  const hanaHome = process.env.HANA_HOME;
  process.env.HANA_HOME = join(root.dir, "home");
  try {
    files[join(process.env.HANA_HOME, "agents", "partner-a", "identity.md")] = "# 伙伴甲\n\n理性优先。";
    files[join(process.env.HANA_HOME, "agents", "partner-a", "pinned.md")] = "她重视真实。\n插件版本 0.1 已发布。";
    const persona = await readPartnerPersona(ctx, "partner-a");
    assert.match(persona.identity, /理性优先/);
    assert.match(persona.memory, /重视真实/);
    assert.doesNotMatch(persona.memory, /插件/);  } finally {
    if (hanaHome === undefined) delete process.env.HANA_HOME;
    else process.env.HANA_HOME = hanaHome;
    root.restore();
  }
});
