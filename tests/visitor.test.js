import test from "node:test";
import assert from "node:assert/strict";

import {
  buildResidentIdentity,
  buildVisitorIdentity,
  buildVisitorProfile,
  characterSnapshot,
  getVisitorPreview,
  inviteCharacter,
  departVisitor,
  listFlowerVisitors,
  repairVisitor,
  settleVisitor,
  uninviteVisitor,
  visitorTitle,
} from "../backend/visitors.js";
import { ledgerPath, looksLikeVisitor, parseSourceCard } from "../backend/visitor-ledger.js";

/** 一个纯内存的 ctx：资源读写、总线调用都不碰磁盘。 */
function makeCtx(options = {}) {
  const files = new Map();
  const dirs = new Map();
  const calls = [];
  const agentIdentities = new Map(Object.entries(options.identities || {}));
  const card = options.card || {
    name: "示例角色",
    description: "用于验证角色资料处理。",
    personality: "测试性格。",
    scenario: "测试场景。",
    system_prompt: "",
    first_mes: "你好，欢迎开始这段测试。",
    tags: ["测试", "示例"],
  };
  files.set("card:test.json", JSON.stringify(card));

  const ctx = {
    dataDir: "C:/tmp/hanabrew-v2-test",
    calls,
    files,
    resources: {
      async stat(ref) {
        const path = String(ref?.path || "").replace(/\\/g, "/");
        if (path.endsWith("characters/test.json")) {
          return { exists: true, isDirectory: false, size: Buffer.byteLength(JSON.stringify(card)) };
        }
        const value = files.get(path);
        if (value == null) throw new Error("missing");
        return { exists: true, isDirectory: false, size: Buffer.byteLength(String(value)) };
      },
      async read(ref, opts) {
        const path = String(ref?.path || "").replace(/\\/g, "/");
        calls.push(["read", path]);
        if (path.endsWith("characters/test.json")) {
          return opts?.encoding === "base64"
            ? { content: Buffer.from(JSON.stringify(card)).toString("base64") }
            : { content: JSON.stringify(card) };
        }
        if (path.includes("/agents/") && path.endsWith("/identity.md")) {
          const id = path.split("/").slice(-2, -1)[0];
          const text = agentIdentities.get(id);
          if (text == null) throw new Error("missing");
          return { content: text };
        }
        if (path.includes("/chats/")) return { content: options.chat || "" };
        if (path === ledgerPath(ctx).replace(/\\/g, "/")) {
          if (!files.has(path)) throw new Error("missing");
          return { content: files.get(path) };
        }
        if (path.endsWith(".jsonl")) return { content: options.session || "" };
        throw new Error(`unexpected read ${path}`);
      },
      async write(ref, bytes) {
        const path = String(ref?.path || "").replace(/\\/g, "/");
        calls.push(["write", path]);
        files.set(path, Buffer.from(bytes).toString("utf8"));
        return { ok: true };
      },
      async list(ref) {
        const path = String(ref?.path || "").replace(/\\/g, "/");
        calls.push(["list", path]);
        if (path.endsWith("/agents")) {
          return [...agentIdentities.keys()].map((name) => ({ name }));
        }
        if (path.endsWith("/chats")) return options.chatDirs || [];
        if (path.includes("/chats/")) return options.chatFiles || [];
        return dirs.get(path) || [];
      },
    },
    bus: {
      async request(type, payload) {
        calls.push([type, payload]);
        if (type === "agent:create") return { agent: { id: "visitor-made", name: payload.name } };
        if (type === "session:create") return { session: { id: "sess-1", sessionPath: "C:/tmp/visitor-made/session.jsonl" } };
        if (type === "session:update" && options.titleFails) throw new Error("没有 app/sessions.manage");
        return { ok: true };
      },
    },
  };
  return ctx;
}

test("会话标题从开场白里取场景短语，取不到就回退", () => {
  const snapshot = { name: "示例角色", firstMessage: "我们先从这个测试场景开始。" };
  assert.equal(visitorTitle(snapshot), "与 示例角色 · 我们先从这个测试场景开始");
  assert.equal(visitorTitle({ name: "示例角色", firstMessage: "" }), "与 示例角色 的来访");
  // 句子太短或太长都不当标题用
  assert.equal(visitorTitle({ name: "甲", firstMessage: "好。" }), "与 甲 的来访");
});

test("身份文件里的角色卡来源能被认出，别的伙伴不会被误认", () => {
  const visitor = "# 示例角色\n\n角色卡来源：示例角色.png\n来自花酿 v2 酒馆的角色卡访客。";
  assert.equal(parseSourceCard(visitor), "示例角色.png");
  assert.equal(looksLikeVisitor(visitor), true);
  assert.equal(looksLikeVisitor("# 伙伴甲\n\n理性助手"), false);
});

test("人格把设定、边界和开场情境都写进去了", () => {
  const snapshot = {
    name: "示例角色",
    file: "示例角色.png",
    description: "用于验证资料流转的角色。",
    personality: "测试性格。",
    scenario: "测试地点。",
    systemPrompt: "",
    characterBook: "",
    exampleDialogue: "",
    postHistoryInstructions: "",
    firstMessage: "你好。",
  };
  const persona = buildVisitorIdentity(snapshot, { messages: [{ role: "user", content: "早" }, { role: "assistant", content: "坐。" }] });
  assert.match(persona, /## 你是谁\n用于验证资料流转的角色。/);
  assert.match(persona, /## 现在的场景\n测试地点。/);
  assert.match(persona, /## 开场情境/);
  assert.match(persona, /最近在酒馆里的对话/);
  assert.match(persona, /来访边界/);
  const resident = buildResidentIdentity(snapshot, null);
  assert.match(resident, /常驻居民/);
  assert.doesNotMatch(resident, /来访边界/);
  assert.match(buildVisitorProfile(snapshot), /角色卡来源：示例角色\.png/);
});

test("快照保留完整设定，并剥掉酒馆宏但留住 MVU 规则块", () => {
  const snapshot = characterSnapshot({
    name: "甲",
    description: "设定正文<StatusPlaceHolderImpl/>尾巴<update_variable_rules>好感度</update_variable_rules>",
    personality: "性格<think>思考过程</think>",
  }, "甲.png");
  assert.equal(snapshot.name, "甲");
  assert.doesNotMatch(snapshot.description, /StatusPlaceHolderImpl/);
  assert.match(snapshot.description, /设定正文/);
  assert.match(snapshot.description, /update_variable_rules/);
  assert.doesNotMatch(snapshot.personality, /思考过程/);
});

test("预览读得到角色设定，也读得到酒馆里最近的一段对话", async () => {
  const chatLine = JSON.stringify({ role: "user", mes: "在吗" }) + "\n"
    + JSON.stringify({ role: "assistant", mes: "在。" });
  const ctx = makeCtx({ chatDirs: [{ name: "示例角色" }], chatFiles: [{ name: "1-示例角色.jsonl" }], chat: chatLine });
  const preview = await getVisitorPreview("test.json", ctx);
  assert.equal(preview.character.name, "示例角色");
  assert.equal(preview.history.messageCount, 2);
  assert.equal(preview.history.messages[0].content, "在吗");
});

test("访客名单只认台账和带标记的遗留访客，不把本家伙伴算进来", async () => {
  const ctx = makeCtx({
    identities: {
      "sample-partner": "# 示例角色\n\n角色卡来源：示例角色.png\n来自花酿 v2 酒馆的角色卡访客。",
      "partner-a": "# 伙伴甲\n\n理性助手",
    },
  });
  const visitors = await listFlowerVisitors(ctx);
  assert.deepEqual(visitors.map((item) => item.name), ["示例角色"]);
  assert.equal(visitors[0].adopted, true);
  assert.equal(visitors[0].sessionTitle, "");
});

test("邀请会开一条独立来访会话；同名访客只补齐不重复造人", async () => {
  const ctx = makeCtx({ identities: { "sample-partner": "# 示例角色\n\n角色卡来源：示例角色.png\n来自花酿 v2 酒馆。" } });
  const result = await inviteCharacter(ctx, "test.json");
  assert.equal(result.reused, true);
  assert.equal(result.agentId, "sample-partner");
  assert.equal(result.sessionId, "sess-1");
  assert.equal(result.sessionTitle, "与 示例角色 · 你好，欢迎开始这段测试");
  assert.equal(ctx.calls.some(([type, payload]) => type === "agent:create"), false, "已有访客不该再造一个伙伴");
  assert.equal(ctx.calls.some(([type]) => type === "session:create"), true);
  // 人格真的写进了伙伴目录
  const persona = [...ctx.files.entries()].find(([key]) => key.endsWith("agents/sample-partner/AGENTS.md"))?.[1] || "";
  assert.match(persona, /## 你是谁/);
  // 台账里登记了
  const visitors = await listFlowerVisitors(ctx);
  assert.equal(visitors.length, 1);
  assert.equal(visitors[0].sessionId, "sess-1");
  assert.equal(visitors[0].adopted, false);
});

test("没有同名访客时新建伙伴，标题改不了也不阻塞邀请", async () => {
  const ctx = makeCtx({ titleFails: true });
  const result = await inviteCharacter(ctx, "test.json");
  assert.equal(result.reused, false);
  assert.equal(result.agentId, "visitor-made");
  assert.equal(ctx.calls.some(([type]) => type === "agent:create"), true);
  assert.equal((await listFlowerVisitors(ctx)).length, 1);
});

test("住下来、送回、请回去各自改台账，送回后不再算在访客里", async () => {
  const ctx = makeCtx();
  await inviteCharacter(ctx, "test.json");
  const settled = await settleVisitor(ctx, "visitor-made");
  assert.equal(settled.residence, true);
  const persona = [...ctx.files.entries()].find(([key]) => key.endsWith("agents/visitor-made/AGENTS.md"))?.[1] || "";
  assert.match(persona, /常驻居民/);

  const gone = await uninviteVisitor(ctx, "visitor-made");
  assert.equal(gone.status, "departed");
  assert.equal((await listFlowerVisitors(ctx)).length, 0);
  assert.equal(ctx.calls.some(([type]) => type === "agent:retire"), true);
  assert.equal(ctx.calls.some(([type]) => type === "session:archive"), true);
});

test("没住下来就说清楚，别让人以为请回去能走", async () => {
  const ctx = makeCtx();
  await inviteCharacter(ctx, "test.json");
  await assert.rejects(() => uninviteVisitor(ctx, "visitor-made"), /还没有住下来/);
  const departed = await departVisitor(ctx, "visitor-made");
  assert.equal(departed.status, "departed");
});

test("修一遍按当前角色卡重写人格和身份", async () => {
  const ctx = makeCtx({ identities: { "sample-partner": "# 示例角色\n\n角色卡来源：test.json" } });
  const fixed = await repairVisitor(ctx, "sample-partner");
  assert.equal(fixed.name, "示例角色");
  assert.equal(fixed.persona, true);
  const identity = [...ctx.files.entries()].find(([key]) => key.endsWith("agents/sample-partner/identity.md"))?.[1] || "";
  assert.match(identity, /角色卡来源：test\.json/);
});
