import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  DUET_CHAT_PREFIX,
  THEATER_CHAT_PREFIX,
  cleanupTemporaryChats,
  executeJob,
  isSafeTemporaryChatName,
  normalizeRuntimeVariables,
  planJob,
  summarizeVariableChanges,
  theaterPageRunnerSource,
} from "../runtime/theater-runner.mjs";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function tempChats() {
  const dir = fs.mkdtempSync(path.join(path.dirname(root), ".theater-chats-"));
  return fs.mkdtempSync(path.join(dir, "chats-"));
}

// ── 依赖隔离 ────────────────────────────────────────────────────────────────

test("runner 不引用旧插件目录，也不夹带私人扩展探测", () => {
  const source = fs.readFileSync(path.join(root, "runtime", "theater-runner.mjs"), "utf8");
  assert.doesNotMatch(source, /plugins[\\/]hanabrew/);
  assert.doesNotMatch(source, /plugins[\\/]xianhuaniang/);
  const page = theaterPageRunnerSource();
  assert.doesNotMatch(page, /extensionProbeSentinel/);
  // 真实链路的关键动作必须在：真 Generate、选角色、开隔离聊天、读 MVU。
  assert.match(page, /context\.generate\("normal"\)/);
  assert.match(page, /selectCharacterById/);
  assert.match(page, /openCharacterChat/);
  assert.match(page, /Mvu\.getMvuData/);
});

test("MVU 变量读不到就是 null，不伪装成空对象", () => {
  assert.equal(normalizeRuntimeVariables(null), null);
  assert.equal(normalizeRuntimeVariables(undefined), null);
  assert.equal(normalizeRuntimeVariables({}), null);
  assert.equal(normalizeRuntimeVariables({ stat_data: {} }), null);
  assert.deepEqual(normalizeRuntimeVariables({ stat_data: { 好感度: 3 } }), { 好感度: 3 });
  assert.deepEqual(normalizeRuntimeVariables({ data: { stat_data: { a: 1 } } }), { a: 1 });
  assert.deepEqual(normalizeRuntimeVariables([{}, { variables: { stat_data: { b: 2 } } }]), { b: 2 });
});

test("变量差异只列真正变化的键", () => {
  const changes = summarizeVariableChanges(
    { 好感度: 1, 嵌套: { 保持: "同", 变: "旧" } },
    { 好感度: 4, 嵌套: { 保持: "同", 变: "新" }, 新增: true },
  );
  assert.deepEqual(changes.map((c) => c.key), ["好感度", "嵌套.变", "新增"]);
  const 好感 = changes.find((c) => c.key === "好感度");
  assert.equal(好感.before, 1);
  assert.equal(好感.after, 4);
});

// ── 任务校验（缺正文一律在开浏览器前就挡掉）─────────────────────────────

test("缺台词、缺角色、台词过长的任务直接报错", () => {
  assert.throws(() => planJob({ action: "run", characterFile: "a.png", turns: [] }), /至少需要一句测试台词/);
  assert.throws(() => planJob({ action: "run", turns: ["hi"] }), /没有指定角色卡/);
  assert.throws(() => planJob({ action: "run", characterFile: "a.png", turns: ["x".repeat(2001)], chatFile: "c" }), /超过 2000 字/);
  assert.throws(() => planJob({ action: "run", characterFile: "a.png", turns: Array.from({ length: 13 }, () => "hi"), chatFile: "c" }), /最多 12 幕/);
  assert.throws(() => planJob({ action: "duet-turn", characterFile: "a.png", chatFile: "c" }), /没有可发送的玩家台词/);
  assert.throws(() => planJob({ action: "bogus", characterFile: "a.png" }), /不支持的测卡动作/);
  assert.throws(() => planJob({}), /缺少动作/);
});

test("合法任务规整出唯一隔离聊天名", () => {
  const job = planJob({
    action: "run", characterFile: "小花.png", turns: ["  ", " 你好 "], chatFile: `${THEATER_CHAT_PREFIX}r1`, runId: "r1",
  });
  assert.deepEqual(job.turns, ["你好"]);
  assert.equal(job.timeoutMs, 120000);
  assert.equal(job.characterId, "小花.png");
});

test("常规聊天不校验临时聊天名，但拒绝路径形状的 chatId", () => {
  assert.equal(planJob({ action: "chat", characterFile: "a.png", message: "在吗" }).text, "在吗");
  assert.throws(() => planJob({ action: "chat", characterFile: "a.png", message: "在吗", chatId: "../../secrets" }), /聊天标识不合法/);
  assert.throws(() => planJob({ action: "chat", characterFile: "a.png", message: "" }), /缺少要发送的内容/);
});

// ── 临时聊天清理：唯一前缀 + 路径安全 ───────────────────────────────────

test("只删唯一前缀的 .jsonl，且不越出 chats 根", () => {
  assert.equal(isSafeTemporaryChatName(`${THEATER_CHAT_PREFIX}r1.jsonl`, `${THEATER_CHAT_PREFIX}r1`), true);
  assert.equal(isSafeTemporaryChatName(`${THEATER_CHAT_PREFIX}r1.txt`, `${THEATER_CHAT_PREFIX}r1`), false);
  assert.equal(isSafeTemporaryChatName(`${THEATER_CHAT_PREFIX}r1.jsonl`, `${THEATER_CHAT_PREFIX}r2`), false);
  assert.equal(isSafeTemporaryChatName(`..${path.sep}x${THEATER_CHAT_PREFIX}r1.jsonl`, `${THEATER_CHAT_PREFIX}r1`), false);
  // prefix 只能是完整临时聊天名，不接受路径形状，空 prefix 一律拒。
  assert.equal(isSafeTemporaryChatName(`${THEATER_CHAT_PREFIX}r1.jsonl`, ""), false);
  assert.equal(isSafeTemporaryChatName(`${THEATER_CHAT_PREFIX}r1.jsonl`, `..${path.sep}chat`), false);

  const chats = tempChats();
  const nested = path.join(chats, "小花");
  fs.mkdirSync(nested, { recursive: true });
  const mine = path.join(nested, `${THEATER_CHAT_PREFIX}r1.jsonl`);
  const otherRun = path.join(nested, `${THEATER_CHAT_PREFIX}r2.jsonl`);
  const duet = path.join(nested, `${DUET_CHAT_PREFIX}d1.jsonl`);
  const official = path.join(nested, "日常聊天.jsonl");
  const flat = path.join(chats, `${THEATER_CHAT_PREFIX}r1.jsonl`);
  for (const file of [mine, otherRun, duet, official, flat]) fs.writeFileSync(file, "{}");

  assert.equal(cleanupTemporaryChats(chats, `${THEATER_CHAT_PREFIX}r1`), 2);
  assert.equal(fs.existsSync(mine), false);
  assert.equal(fs.existsSync(flat), false);
  assert.equal(fs.existsSync(otherRun), true);
  assert.equal(fs.existsSync(duet), true);
  assert.equal(fs.existsSync(official), true);
  fs.rmSync(path.dirname(chats), { recursive: true, force: true });
});

// ── executeJob：用注入的假浏览器验证编排，不假装真跑通 ───────────────────

function fakeBrowser(result) {
  const calls = [];
  return {
    calls,
    launch: async () => ({ child: null, cdp: { evaluate: async (expression) => { calls.push(expression); return result; } }, profileDir: null }),
  };
}

test("测卡任务：跑完给 done，变量为 null 时明确进 warnings", async () => {
  const chats = tempChats();
  const browser = fakeBrowser({
    character: { name: "小花", index: 0 },
    chatFile: `${THEATER_CHAT_PREFIX}r1`,
    opening: "……",
    initialVariables: null,
    finalVariables: null,
    finalVariableSource: "unavailable",
    mvuAvailable: false,
    scenes: [{ index: 1, user: "在吗", reply: "在。", variableChanges: [] }],
  });
  const data = await executeJob({
    action: "run", runId: "r1", characterFile: "小花.png", turns: ["在吗"],
    chatFile: `${THEATER_CHAT_PREFIX}r1`, serverUrl: "http://127.0.0.1:18511/", chatsRoot: chats,
  }, browser);
  assert.equal(data.engine, "sillytavern-runtime");
  assert.equal(data.isolated, true);
  assert.equal(data.scenes.length, 1);
  // 最后一条 evaluate 才是页面主脚本（前面几条是进度轮询）。
  assert.match(browser.calls[browser.calls.length - 1], /theaterPageRunner/);
  fs.rmSync(path.dirname(chats), { recursive: true, force: true });
});

test('取消信号中断尚未结束的生成，并先关闭浏览器再清理自己的临时聊天', async () => {
  const chats = tempChats(); const root = path.dirname(chats);
  const profileDir = path.join(root, 'browser-profile'); fs.mkdirSync(profileDir);
  const cancelPath = path.join(root, 'cancel-signal'); const prefix = `${THEATER_CHAT_PREFIX}cancel-race`;
  const own = path.join(chats, prefix + '.jsonl'); const keep = path.join(chats, 'formal.jsonl'); fs.writeFileSync(keep, '{}');
  let closed = false;
  try {
    await assert.rejects(executeJob({ action: 'run', runId: 'cancel-race', characterFile: 'target.png', turns: ['hello'], chatFile: prefix, serverUrl: 'http://127.0.0.1:18511/', chatsRoot: chats, cancelPath }, {
      launch: async () => ({ child: null, profileDir, cdp: {
        close() { closed = true; },
        evaluate(expression) {
          if (expression.startsWith('(() => { const p =')) return Promise.resolve(null);
          fs.writeFileSync(own, '{}'); setTimeout(() => fs.writeFileSync(cancelPath, 'cancel'), 20);
          return new Promise(() => {});
        },
      } }),
    }), /已被取消/);
    assert.equal(closed, true); assert.equal(fs.existsSync(own), false); assert.equal(fs.existsSync(keep), true);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("测卡失败时错误原样上抛，不返回半成品", async () => {
  const chats = tempChats();
  const browser = {
    launch: async () => ({ child: null, cdp: { evaluate: async () => { throw new Error("酒馆这次没有产出回复正文，测卡结果无法确认"); } } }),
  };
  await assert.rejects(() => executeJob({
    action: "run", runId: "r2", characterFile: "小花.png", turns: ["在吗"],
    chatFile: `${THEATER_CHAT_PREFIX}r2`, serverUrl: "http://127.0.0.1:18511/", chatsRoot: chats,
  }, browser), /没有产出回复正文/);
  fs.rmSync(path.dirname(chats), { recursive: true, force: true });
});

test("常规聊天不删任何正式聊天文件，也不要求临时聊天名", async () => {
  const chats = tempChats();
  const official = path.join(chats, "日常聊天.jsonl");
  fs.writeFileSync(official, "{}");
  const browser = fakeBrowser({ character: { name: "小花", index: 0 }, chatFile: "日常聊天", reply: "在。", variables: null });
  const data = await executeJob({
    action: "chat", characterFile: "小花.png", message: "在吗", chatId: "日常聊天",
    serverUrl: "http://127.0.0.1:18511/", chatsRoot: chats,
  }, browser);
  assert.equal(data.reply, "在。");
  assert.equal(data.chatFile, '日常聊天'); assert.equal(data.isolated, false);
  assert.equal(fs.existsSync(official), true);
  fs.rmSync(path.dirname(chats), { recursive: true, force: true });
});

test("结束对戏只清理该场前缀的临时聊天", async () => {
  const chats = tempChats();
  const keep = path.join(chats, `${DUET_CHAT_PREFIX}d1.jsonl`);
  const drop = path.join(chats, `${DUET_CHAT_PREFIX}d2.jsonl`);
  fs.writeFileSync(keep, "{}");
  fs.writeFileSync(drop, "{}");
  const data = await executeJob({
    action: "duet-end", runId: "d2", cleanupPrefix: `${DUET_CHAT_PREFIX}d2`,
    serverUrl: "http://127.0.0.1:18511/", chatsRoot: chats,
  }, { launch: async () => { throw new Error("duet-end 不该开浏览器"); } });
  assert.equal(data.cleanedChats, 1);
  assert.equal(fs.existsSync(drop), false);
  assert.equal(fs.existsSync(keep), true);
  fs.rmSync(path.dirname(chats), { recursive: true, force: true });
});

test("没有酒馆地址时立即拒绝，不假装能跑", async () => {
  await assert.rejects(
    () => executeJob({ action: "run", runId: "r3", characterFile: "a.png", turns: ["hi"], chatFile: "c", serverUrl: "" }),
    /缺少酒馆地址/,
  );
});