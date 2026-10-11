import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { embedCharacterCardPng, readEmbeddedCard, stripPngRoleCardMetadata } from "../backend/png-card.js";
import {
  MAX_PERSONA_NOTES,
  MAX_TRANSFER_AVATAR_BYTES,
  TEA_PARTY_IMPORT_SCHEMA_VERSION,
  TEA_PARTY_IMPORT_SERVICE,
  buildTeaPartyImportPayload,
  collectPersonaNotes,
  describeTeaPartyFailure,
  inviteCharacterToTeaParty,
  teaPartyCharacterPreview,
  teaPartyStatus,
} from "../backend/tea-party.js";

const iconBytes = fs.readFileSync(new URL("../assets/icon.png", import.meta.url));

/** 造一个临时酒馆数据根，角色卡读写不碰真机文件。 */
function useTempDataRoot() {
  const previous = process.env.APPDATA;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hanabrew-tea-party-"));
  return {
    dir,
    charactersDir: path.join(dir, "xianhuaniang", "st-data", "default-user", "characters"),
    restore() { if (previous === undefined) delete process.env.APPDATA; else process.env.APPDATA = previous; },
  };
}

function fakeCtx(files = {}, bus = {}) {
  return {
    resources: {
      async stat(ref) {
        if (!Object.prototype.hasOwnProperty.call(files, ref.path)) throw new Error("missing");
        const value = files[ref.path];
        return { exists: true, isDirectory: false, size: Buffer.byteLength(Buffer.from(value)) };
      },
      async read(ref) {
        if (!Object.prototype.hasOwnProperty.call(files, ref.path)) throw new Error("missing");
        return { content: files[ref.path] };
      },
    },
    bus,
  };
}

test("酒馆字段按茶话会邀请契约分栏，系统提示和世界书不作为可执行内容", () => {
  const payload = buildTeaPartyImportPayload({
    id: "阿岚.png",
    file: "阿岚.png",
    name: "阿岚",
    description: "{{char}}是海边侦探",
    personality: "嘴硬心软",
    scenario: "来自小岛",
    exampleDialogue: "{{char}}：别误会",
    firstMessage: "{{user}}，你来啦",
    systemPrompt: "不要导入",
    postHistoryInstructions: "不要导入",
    characterBook: "不要导入",
    creator: "作者",
    tags: ["侦探"],
  });
  assert.equal(payload.schemaVersion, TEA_PARTY_IMPORT_SCHEMA_VERSION);
  assert.deepEqual(payload.source, { cardId: "阿岚.png", format: "png" });
  assert.equal(payload.character.description, "阿岚是海边侦探");
  assert.equal(payload.character.personality, "嘴硬心软");
  assert.equal(payload.character.scenario, "来自小岛");
  assert.equal(payload.character.exampleDialogue, "阿岚：别误会");
  assert.equal(payload.firstMessage, "你，你来啦");
  assert.equal(payload.character.creator, "作者");
  assert.equal("systemPrompt" in payload.character, false);
  assert.equal("characterBook" in payload.character, false);
  assert.equal("history" in payload, false);
});

test("角色卡 PNG 剥离隐藏卡片数据，并拒绝异常尺寸和动画头像", () => {
  const marked = embedCharacterCardPng(iconBytes, { spec: "chara_card_v2", data: { system_prompt: "不应藏在头像里" } });
  assert.ok(readEmbeddedCard(marked));
  const clean = stripPngRoleCardMetadata(marked);
  assert.ok(clean);
  assert.equal(readEmbeddedCard(clean), null);

  const huge = Buffer.from(iconBytes);
  huge.writeUInt32BE(5000, 16);
  assert.equal(stripPngRoleCardMetadata(huge), null);

  const animated = Buffer.concat([iconBytes.subarray(0, 33), Buffer.alloc(12), iconBytes.subarray(33)]);
  animated.writeUInt32BE(0, 33);
  animated.write("acTL", 37, "ascii");
  assert.equal(stripPngRoleCardMetadata(animated), null);
});

test("太大的头像不会挤进跨 App 邀请包，角色资料仍可转换", () => {
  const payload = buildTeaPartyImportPayload({ file: "角色.png", name: "角色" }, Buffer.alloc(MAX_TRANSFER_AVATAR_BYTES + 1));
  assert.equal("avatar" in payload, false);
});

test("门禁只看我有没有跨 App 通道，目录探测不作数", () => {
  // 实机证据：App 沙箱里 existsSync 看不到 HANA_HOME，目录探测恒为 false，不能拿来判死活。
  const inSandbox = teaPartyStatus({ bus: { hasHandler: () => true, request() {} } });
  assert.equal(inSandbox.available, true);
  assert.equal(inSandbox.reason, "ready");
  assert.equal("installed" in inSandbox, false, "目录探测已从状态里拿掉");
  assert.equal(inSandbox.probe.hasRequest, true);

  // 拿不到跨 App 通道才是真的不行。
  const noBus = teaPartyStatus({ bus: { hasHandler: () => true } });
  assert.equal(noBus.available, false);
  assert.equal(noBus.reason, "no-bus");
  assert.equal(noBus.probe.hasRequest, false);
});

test("入口探测只留痕，不参与判定", () => {
  // 实机证据：茶话会注册成功后 hasHandler 仍返回 false，这个探测本身不可信。
  const undetected = teaPartyStatus({ bus: { hasHandler: () => false, request() {} } });
  assert.equal(undetected.available, true);
  assert.equal(undetected.probe.detected, false);

  // 探测抛错也只能记成「没测到」，不能变成「不能试」。
  const broken = teaPartyStatus({ bus: { hasHandler() { throw new Error("bus gone"); }, request() {} } });
  assert.equal(broken.available, true);
  assert.equal(broken.probe.detected, null);

  // 压根没有 hasHandler 时也不能影响判定。
  const bare = teaPartyStatus({ bus: { request() {} } });
  assert.equal(bare.available, true);
  assert.equal(bare.probe.detected, null);
});

test("宿主错误码翻成能照着做的一句话，不甩英文栈", () => {
  const denied = Object.assign(new Error('App "xianhuaniang" requires "app/services.call".'), { code: "APP_CAPABILITY_DENIED" });
  assert.match(describeTeaPartyFailure(denied), /应用间服务调用（app\/services\.call）/);
  const cross = Object.assign(new Error("x"), { code: "APP_SERVICE_CROSS_APP_DENIED" });
  assert.match(describeTeaPartyFailure(cross), /重新加载一次/);
  const timeout = Object.assign(new Error("x"), { name: "BusTimeoutError" });
  assert.match(describeTeaPartyFailure(timeout), /20 秒/);
  const missing = describeTeaPartyFailure(new Error("no handler registered for app:chahuahui/import-character"));
  assert.match(missing, /茶话会还没装/);
  const unknown = describeTeaPartyFailure(new Error("茶话会崩了"));
  assert.match(unknown, /聊天资料没有改动/);
  assert.match(unknown, /茶话会崩了/);
});

test("邀请预览与送达不带酒馆聊天记录，只传清理后的角色设定和 PNG 头像", async () => {
  const root = useTempDataRoot();
  process.env.APPDATA = root.dir;
  const file = path.join(root.charactersDir, "阿岚.png");
  const png = embedCharacterCardPng(iconBytes, {
    spec: "chara_card_v2",
    data: {
      name: "阿岚",
      description: "{{char}}住在海边",
      prompt: "不应把酒馆提示字段当成茶话会设定",
      personality: "嘴硬心软",
      scenario: "她原本住在小岛",
      first_mes: "{{user}}，你来啦",
      mes_example: "<START>\n{{char}}：别误会",
      system_prompt: "茶话会不应执行这条顶层提示",
      post_history_instructions: "茶话会不应执行这条后置指引",
      character_book: { entries: [{ keys: ["潮汐"], content: "世界书暂不导入", enabled: true }] },
      creator: "作者",
      tags: ["侦探"],
    },
  });
  const calls = [];
  const ctx = fakeCtx({ [file]: png }, {
    hasHandler: (name) => name === TEA_PARTY_IMPORT_SERVICE,
    async request(name, payload, options) {
      calls.push({ name, payload, options });
      return { ok: true, partnerId: "local_1", name: "阿岚", created: true, updated: false, hasAvatar: true };
    },
  });
  try {
    const preview = await teaPartyCharacterPreview(ctx, "阿岚.png");
    assert.equal(preview.character.name, "阿岚");
    assert.equal(preview.avatarAvailable, true);
    assert.deepEqual(preview.notImported, ["酒馆系统提示", "对话后指引", "角色世界书", "酒馆聊天记录"]);
    const result = await inviteCharacterToTeaParty(ctx, "阿岚.png");
    assert.equal(result.created, true);
    assert.equal(result.avatarIncluded, true);
    assert.equal(calls[0].name, TEA_PARTY_IMPORT_SERVICE);
    assert.equal(calls[0].payload.source.cardId, "阿岚.png");
    assert.equal(calls[0].payload.character.description, "阿岚住在海边");
    assert.equal(calls[0].payload.firstMessage, "你，你来啦");
    assert.equal(calls[0].payload.avatar.mimeType, "image/png");
    const transferredAvatar = Buffer.from(calls[0].payload.avatar.dataBase64, "base64");
    assert.equal(readEmbeddedCard(transferredAvatar), null, "角色卡元数据不得藏在头像 PNG 里传到茶话会");
    assert.equal("systemPrompt" in calls[0].payload.character, false);
    assert.equal("history" in calls[0].payload, false);
    assert.equal(calls[0].options.timeout, 20000);
  } finally {
    root.restore();
  }
});

test("探测说没注册时照样把请求发出去，失败码才是判定", async () => {
  const root = useTempDataRoot();
  process.env.APPDATA = root.dir;
  const file = path.join(root.charactersDir, "角色.png");
  fs.mkdirSync(root.charactersDir, { recursive: true });
  fs.writeFileSync(file, embedCharacterCardPng(iconBytes, { spec: "chara_card_v2", data: { name: "角色" } }));
  let called = 0;
  const ctx = fakeCtx({ [file]: fs.readFileSync(file) }, {
    hasHandler: () => false,
    async request() {
      called += 1;
      throw Object.assign(new Error('App "xianhuaniang" requires "app/services.call".'), { code: "APP_CAPABILITY_DENIED" });
    },
  });
  try {
    await assert.rejects(() => inviteCharacterToTeaParty(ctx, "角色.png"), /应用间服务调用/);
    assert.equal(called, 1, "探测失灵不该让请求根本没发出去");
  } finally {
    root.restore();
  }
});

test("拿不到跨 App 通道时邀请明确失败，不伪报成功", async () => {
  await assert.rejects(
    () => inviteCharacterToTeaParty(fakeCtx({}, { hasHandler: () => false }), "角色.png"),
    /没有拿到 Hana 的应用间通道/,
  );
});

test("世界书工程型卡片只把人格四类条目带去聊天，剧情层留在酒馆", () => {
  const notes = collectPersonaNotes({
    entries: [
      { name: "世界设定", content: "---\n<world_setting>\n虚构城市\n</world_setting>" },
      { name: "扮演准则", content: "---\n<role_play_setting>\n按角色设定自然回应\n</role_play_setting>" },
      { name: "场景", content: "---\n<scene scene=\"场景\">\n测试地点\n</scene>" },
      { name: "示例角色_基础信息", content: "---\n<character_basic character=\"示例角色\">\n测试资料\n</character_basic>" },
      { name: "示例角色_性格档案", content: "---\n<character_personality character=\"示例角色\">\n测试性格\n</character_personality>" },
      { name: "示例角色_补充说明", content: "---\n<character_rephrase character=\"示例角色\">\n测试说明\n</character_rephrase>" },
      { name: "配角", content: "---\n<npc name=\"配角\">\n测试设定\n</npc>" },
      { name: "[mvu_update]变量更新规则", content: "---\n<update_variable_rules>\n必须输出变量\n</update_variable_rules>" },
      { name: "[InitVar]请勿打开", content: "关系:\n  好感度: 35" },
      { name: "示例角色_性格档案", enabled: false, content: "<character_personality>关掉的条目不进</character_personality>" },
    ],
  });
  assert.deepEqual(notes.map((note) => note.label), ["扮演准则", "示例角色_基础信息", "示例角色_性格档案", "示例角色_补充说明"]);
  for (const note of notes) {
    assert.equal(/<|---/u.test(note.text), false, `酒馆结构标签应被剥掉：${note.label}`);
  }
  assert.equal(notes.some((note) => note.text.includes("好感度")), false, "变量协议不该进聊天");
  assert.equal(collectPersonaNotes(null).length, 0);
  assert.equal(collectPersonaNotes({ entries: [{ name: "性格补充", content: "话少规矩" }] }).length, 1, "没有标签时按条目名兜底");
  const overlong = Array.from({ length: 20 }, (_, index) => ({ name: `性格${index}`, content: "x".repeat(600) }));
  assert.equal(collectPersonaNotes({ entries: overlong }).length, MAX_PERSONA_NOTES, "条目数有上限");
});

test("人格档案跟着邀请包一起送达，场景与变量留在酒馆", async () => {
  const root = useTempDataRoot();
  process.env.APPDATA = root.dir;
  const file = path.join(root.charactersDir, "示例角色.png");
  const png = embedCharacterCardPng(iconBytes, {
    spec: "chara_card_v2",
    data: {
      name: "示例角色",
      description: "用于测试角色资料传递。",
      first_mes: "你好。",
      character_book: {
        name: "示例角色",
        entries: [
          { name: "扮演准则", content: "---\n<role_play_setting>\n按角色设定自然回应\n</role_play_setting>" },
          { name: "场景", content: "---\n<scene scene=\"测试场景\">\n测试地点\n</scene>" },
          { name: "示例角色_性格档案", content: "---\n<character_personality character=\"示例角色\">\n测试性格\n  补充说明: 这是一条用于验证传递的文本\n</character_personality>" },
        ],
      },
    },
  });
  const calls = [];
  const ctx = fakeCtx({ [file]: png }, {
    hasHandler: () => true,
    async request(name, payload) {
      calls.push({ name, payload });
      return { ok: true, partnerId: "local_1", name: "示例角色", created: true, updated: false, hasAvatar: true };
    },
  });
  try {
    const preview = await teaPartyCharacterPreview(ctx, "示例角色.png");
    assert.equal(preview.personaNotesIncluded, 2);
    assert.deepEqual(preview.notImported, ["角色世界书的场景 / 剧情 / 变量条目", "酒馆聊天记录"]);
    await inviteCharacterToTeaParty(ctx, "示例角色.png");
    const notes = calls[0].payload.character.personaNotes;
    assert.equal(notes.length, 2);
    assert.equal(notes[0].label, "扮演准则");
    assert.match(notes[1].text, /用于验证传递的文本/);
    assert.equal(notes[1].text.includes("<user>"), false, "酒馆的用户占位符要换成称呼");
    assert.equal("characterBook" in calls[0].payload.character, false, "原始世界书不进邀请包");
  } finally {
    root.restore();
  }
});
