import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { registerVisitorStateTools, visitorStateFile } from "../backend/visitor-state.js";

const VISITOR = {
  agentId: "sample-partner",
  characterId: "示例角色.png",
  characterName: "示例角色",
  sessionId: "sess-1",
  sessionPath: "C:/tmp/sample-role/sess-1.jsonl",
  status: "active",
  residence: false,
  arrivedAt: "2026-10-01T00:00:00.000Z",
};

const SESSIONS = {
  "sess-1": { sessionId: "sess-1", path: "C:/tmp/sample-role/sess-1.jsonl", agentId: "sample-partner" },
  "sess-2": { sessionId: "sess-2", path: "C:/tmp/sample-role/sess-2.jsonl", agentId: "sample-partner" },
};

/** 测试临时文件放系统临时目录，不往 App 源码目录里写。 */
const TMP_ROOT = path.join(os.tmpdir(), "xianhuaniang-visitor-state-tests");

function tmpCase(name) {
  const dir = path.join(TMP_ROOT, name);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function norm(filePath) {
  return String(filePath).replace(/\\/g, "/");
}

/**
 * 纯内存 ctx：资源读写不碰磁盘，总线只认 session:get / agent:list。
 * sessionPath 一律用 C:/tmp/... 形式，避免 Windows 下 resolve() 改斜杠导致匹配失败。
 */
function makeCtx(options = {}) {
  const dataDir = options.dataDir === undefined ? "C:/tmp/hanabrew-visitor-state-test" : options.dataDir;
  const files = new Map();
  const calls = [];
  const registered = [];
  const visitors = options.visitors ?? [VISITOR];
  const statePath = dataDir ? norm(visitorStateFile({ dataDir })) : "";

  if (statePath && options.stateFile != null) files.set(statePath, options.stateFile);

  const ctx = {
    calls,
    registered,
    resources: {
      async stat(ref) {
        const target = norm(ref?.path || "");
        calls.push(["stat", target]);
        if (target !== statePath) return { exists: true, isDirectory: false, size: 0 };
        if (options.statThrows) throw options.statThrows;
        if (!files.has(target)) {
          throw Object.assign(new Error(`ENOENT: no such file or directory, open '${target}'`), { code: "ENOENT" });
        }
        return { exists: true, isDirectory: false, size: String(files.get(target)).length };
      },
      async read(ref) {
        const target = norm(ref?.path || "");
        calls.push(["read", target]);
        // 访客台账永远读得到，失败只发生在来访状态账本上。
        if (target.endsWith("/visitors.json")) return { content: JSON.stringify({ version: 1, visitors }) };
        if (target === statePath && options.stateReadThrows) throw options.stateReadThrows;
        if (!files.has(target)) {
          throw Object.assign(new Error(`ENOENT: no such file or directory, open '${target}'`), { code: "ENOENT" });
        }
        return { content: files.get(target) };
      },
      async write(ref, bytes) {
        const target = norm(ref?.path || "");
        calls.push(["write", target]);
        if (options.writeFails) throw new Error("磁盘写满了");
        files.set(target, Buffer.from(bytes).toString("utf8"));
        return { ok: true };
      },
    },
  };
  if (dataDir) ctx.dataDir = dataDir;
  if (!options.noBus) {
    ctx.bus = {
      async request(type, payload) {
        calls.push([type, payload]);
        if (type === "session:get") {
          const session = SESSIONS[payload.sessionId];
          return session ? { session } : { ok: true };
        }
        if (type === "agent:list") {
          if (options.agentListThrows) throw new Error("没有 agent:list 权限");
          return options.ownedAgents === undefined ? { agents: [{ id: "sample-partner" }] } : options.ownedAgents;
        }
        return { ok: true };
      },
    };
  }
  ctx.tools = {
    async register(registration) {
      registered.push(registration);
      return async () => { calls.push(["dispose", registration.name]); };
    },
  };
  ctx.files = files;
  ctx.statePath = statePath;
  return ctx;
}

async function call(ctx, input) {
  await registerVisitorStateTools(ctx);
  const tool = ctx.registered[0];
  const result = await tool.execute(input);
  const parsed = JSON.parse(result.content[0].text);
  return { result, parsed, isError: result.isError === true };
}

function contextFor(sessionId) {
  const session = SESSIONS[sessionId];
  return { sessionId, sessionPath: session.path };
}

test("只注册一个 hanabrew-visitor-state，cleanup 把它注销", async () => {
  const ctx = makeCtx();
  const cleanup = await registerVisitorStateTools(ctx);
  assert.equal(ctx.registered.length, 1);
  assert.equal(ctx.registered[0].name, "hanabrew-visitor-state");
  await cleanup();
  assert.deepEqual(ctx.calls.filter(([kind]) => kind === "dispose"), [["dispose", "hanabrew-visitor-state"]]);
});

test("get 回读自己的来访会话状态，并写明这是 App 剧情状态不是 ST MVU", async () => {
  const ctx = makeCtx();
  const { parsed } = await call(ctx, { action: "get", context: contextFor("sess-1") });
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.variables, {});
  assert.equal(parsed.source, "app-plot");
  assert.equal(parsed.kind, "visitor-plot-state");
  assert.match(parsed.note, /不是酒馆 ST MVU/);
  assert.equal(parsed.characterName, "示例角色");
});

test("update 落盘后回读一致，get 能读回同一份状态", async () => {
  const ctx = makeCtx();
  const first = await call(ctx, {
    action: "update",
    context: contextFor("sess-1"),
    patches: [{ op: "add", path: "/mood", value: "松弛" }],
  });
  assert.equal(first.isError, false);
  assert.equal(first.parsed.variables.mood, "松弛");
  assert.equal(first.parsed.revision, 1);
  assert.equal(first.parsed.applied, 1);

  const second = await call(ctx, {
    action: "update",
    context: contextFor("sess-1"),
    patches: [{ op: "replace", path: "/mood", value: "警觉" }, { op: "add", path: "/scene/location", value: "天台" }],
  });
  assert.deepEqual(second.parsed.variables, { mood: "警觉", scene: { location: "天台" } });
  assert.equal(second.parsed.revision, 2);

  const read = await call(ctx, { action: "get", context: contextFor("sess-1") });
  assert.deepEqual(read.parsed.variables, { mood: "警觉", scene: { location: "天台" } });
});

test("测卡账里的变量一律不读不继承，哪怕会话对得上", async () => {
  const dir = tmpCase("no-theater-inherit");
  fs.writeFileSync(path.join(dir, "theater-mvu-ledger.json"), JSON.stringify({
    "run-1": {
      sessionId: "sess-1",
      sessionPath: "C:/tmp/sample-role/sess-1.jsonl",
      agentId: "sample-partner",
      initialVariables: { mood: "平静", 好感: 3 },
      initialVariableSource: "scripted",
      updatedAt: "2026-10-08T00:00:00.000Z",
    },
  }), "utf8");

  const ctx = makeCtx({ dataDir: dir });
  const first = await call(ctx, { action: "update", context: contextFor("sess-1"), patches: [{ op: "add", path: "/scene", value: "工位" }] });
  assert.equal(first.isError, false);
  assert.deepEqual(first.parsed.variables, { scene: "工位" }, "测卡变量不该成为来访初值");
  assert.equal(first.parsed.source, "app-plot");

  const second = await call(ctx, { action: "update", context: contextFor("sess-1"), patches: [{ op: "add", path: "/mood", value: "松弛" }] });
  assert.deepEqual(second.parsed.variables, { scene: "工位", mood: "松弛" });
  assert.equal(second.parsed.source, "app-plot");

  assert.equal(
    ctx.calls.some(([, target]) => String(target).includes("theater-mvu-ledger")),
    false,
    "来访状态不该去读测卡账",
  );
  fs.rmSync(dir, { recursive: true, force: true });
});

test("同一个伙伴的另一次会话不共享剧情状态，也不按同伙伴兜底", async () => {
  const ctx = makeCtx();
  await call(ctx, { action: "update", context: contextFor("sess-1"), patches: [{ op: "add", path: "/mood", value: "松弛" }] });
  const other = await call(ctx, { action: "get", context: contextFor("sess-2") });
  assert.equal(other.isError, true);
  assert.match(other.parsed.error, /不是鲜花酿邀请的来访会话/);
});

test("会话身份对不上就拒绝，不认模型自报的 scope", async () => {
  const ctx = makeCtx();
  const ghost = await call(ctx, { action: "get", context: { sessionId: "sess-ghost", sessionPath: "C:/tmp/ghost.jsonl" } });
  assert.equal(ghost.isError, true);
  assert.match(ghost.parsed.error, /不是鲜花酿邀请的来访会话/);

  const lying = await call(ctx, {
    action: "update",
    context: { sessionId: "sess-1", sessionPath: "C:/tmp/elsewhere/other.jsonl" },
    patches: [{ op: "add", path: "/mood", value: "x" }],
  });
  assert.equal(lying.isError, true);
  assert.match(lying.parsed.error, /会话路径已变化|不是鲜花酿邀请的来访会话/);
});

test("宿主通道不可用或归属核不出来，操作一律拒绝", async () => {
  const noBus = makeCtx({ noBus: true });
  const missing = await call(noBus, { action: "get", context: contextFor("sess-1") });
  assert.equal(missing.isError, true);
  assert.match(missing.parsed.error, /伙伴名单通道/);

  const broken = makeCtx({ agentListThrows: true });
  const threw = await call(broken, { action: "get", context: contextFor("sess-1") });
  assert.equal(threw.isError, true);
  assert.match(threw.parsed.error, /宿主归属核实失败/);

  const empty = makeCtx({ ownedAgents: { ok: true } });
  const noList = await call(empty, { action: "get", context: contextFor("sess-1") });
  assert.equal(noList.isError, true);
  assert.match(noList.parsed.error, /未返回应用所属伙伴名单/);
});

test("不属于本应用的访客伙伴拒绝读写", async () => {
  const ctx = makeCtx({ ownedAgents: { agents: [{ id: "partner-a" }] } });
  const denied = await call(ctx, { action: "update", context: contextFor("sess-1"), patches: [{ op: "add", path: "/mood", value: "x" }] });
  assert.equal(denied.isError, true);
  assert.match(denied.parsed.error, /不在鲜花酿的所属范围/);
  assert.equal(ctx.files.has(ctx.statePath), false);
});

test("污染键、超大 payload、无效 patch 一律拒绝，且不落盘", async () => {
  const ctx = makeCtx();
  const cases = [
    { name: "原型链键", patches: [{ op: "add", path: "/__proto__/polluted", value: 1 }], expect: /原型链/ },
    { name: "constructor 键", patches: [{ op: "replace", path: "/constructor", value: 1 }], expect: /原型链/ },
    { name: "value 里的嵌套危险键", patches: [{ op: "add", path: "/deep", value: { a: { constructor: 1 } } }], expect: /不允许出现 constructor/ },
    { name: "value 里的数组危险键", patches: [{ op: "add", path: "/deep", value: [{ prototype: 1 }] }], expect: /不允许出现 prototype/ },
    { name: "超大 value", patches: [{ op: "add", path: "/note", value: "长".repeat(9000) }], expect: /太大/ },
    { name: "patches 不是数组", patches: { op: "add" }, expect: /必须是数组/ },
    { name: "空数组", patches: [], expect: /空数组/ },
    { name: "非法 op", patches: [{ op: "move", path: "/mood", value: 1 }], expect: /op 只能是/ },
    { name: "path 不合法", patches: [{ op: "add", path: "mood", value: 1 }], expect: /以 \/ 开头/ },
    { name: "非法转义", patches: [{ op: "add", path: "/a~2b", value: 1 }], expect: /非法转义/ },
    { name: "空键", patches: [{ op: "add", path: "/a//b", value: 1 }], expect: /空键/ },
    { name: "replace 指向不存在字段", patches: [{ op: "replace", path: "/mood", value: 1 }], expect: /不存在/ },
    { name: "remove 指向不存在字段", patches: [{ op: "remove", path: "/mood" }], expect: /不存在/ },
    { name: "add 缺 value", patches: [{ op: "add", path: "/mood" }], expect: /必须带 value/ },
  ];
  for (const item of cases) {
    const result = await call(ctx, { action: "update", context: contextFor("sess-1"), patches: item.patches });
    assert.equal(result.isError, true, `${item.name} 应当被拒绝`);
    assert.match(result.parsed.error, item.expect, `${item.name} 的报错不对：${result.parsed.error}`);
  }
  assert.equal(ctx.files.has(ctx.statePath), false, "无效 patch 不该留下任何账本");
  assert.equal({}.polluted, undefined);
  assert.equal(Object.prototype.polluted, undefined);
});

test("数组下标与追加位单独校验，非法的一律拒绝", async () => {
  const ctx = makeCtx();
  await call(ctx, { action: "update", context: contextFor("sess-1"), patches: [{ op: "add", path: "/list", value: [1, 2, 3] }] });
  const cases = [
    { name: "越界 add", patches: [{ op: "add", path: "/list/9", value: 1 }], expect: /越界/ },
    { name: "越界 replace", patches: [{ op: "replace", path: "/list/9", value: 1 }], expect: /越界/ },
    { name: "越界 remove", patches: [{ op: "remove", path: "/list/9" }], expect: /越界/ },
    { name: "负下标", patches: [{ op: "replace", path: "/list/-1", value: 1 }], expect: /非负整数/ },
    { name: "非数字下标", patches: [{ op: "replace", path: "/list/abc", value: 1 }], expect: /非负整数/ },
    { name: "replace 用追加位", patches: [{ op: "replace", path: "/list/-", value: 1 }], expect: /不接受数组追加位/ },
    { name: "remove 用追加位", patches: [{ op: "remove", path: "/list/-" }], expect: /不接受数组追加位/ },
  ];
  for (const item of cases) {
    const result = await call(ctx, { action: "update", context: contextFor("sess-1"), patches: item.patches });
    assert.equal(result.isError, true, `${item.name} 应当被拒绝`);
    assert.match(result.parsed.error, item.expect, `${item.name} 的报错不对：${result.parsed.error}`);
  }
  const stored = JSON.parse(ctx.files.get(ctx.statePath));
  assert.deepEqual(stored.entries["sess-1"].variables.list, [1, 2, 3], "被拒的 patch 不该改动已存状态");
});

test("同一批 patch 按顺序生效：先 add 再 replace 能吃到前一步", async () => {
  const ctx = makeCtx();
  const result = await call(ctx, {
    action: "update",
    context: contextFor("sess-1"),
    patches: [
      { op: "add", path: "/mood", value: "松弛" },
      { op: "replace", path: "/mood", value: "警觉" },
      { op: "remove", path: "/mood" },
    ],
  });
  assert.equal(result.isError, false);
  assert.deepEqual(result.parsed.variables, {});
  assert.equal(result.parsed.applied, 3);
});

test("数组删掉一个后，后继元素合法移位，后续针对该下标的 patch 照常成立", async () => {
  const ctx = makeCtx();
  await call(ctx, { action: "update", context: contextFor("sess-1"), patches: [{ op: "add", path: "/list", value: [1, 2, 3] }] });
  const result = await call(ctx, {
    action: "update",
    context: contextFor("sess-1"),
    patches: [
      { op: "remove", path: "/list/0" },
      { op: "replace", path: "/list/0", value: 9 },
    ],
  });
  assert.equal(result.isError, false, JSON.stringify(result.parsed));
  assert.deepEqual(result.parsed.variables.list, [9, 3]);

  const appended = await call(ctx, {
    action: "update",
    context: contextFor("sess-1"),
    patches: [{ op: "add", path: "/list/-", value: 4 }],
  });
  assert.equal(appended.isError, false);
  assert.deepEqual(appended.parsed.variables.list, [9, 3, 4]);

  const stored = JSON.parse(ctx.files.get(ctx.statePath));
  assert.deepEqual(stored.entries["sess-1"].variables.list, [9, 3, 4]);
});

test("并发 update 不丢 patch，两条变更都在账里", async () => {
  const ctx = makeCtx();
  await registerVisitorStateTools(ctx);
  const tool = ctx.registered[0];
  const [left, right] = await Promise.all([
    tool.execute({ action: "update", context: contextFor("sess-1"), patches: [{ op: "add", path: "/mood", value: "松弛" }] }),
    tool.execute({ action: "update", context: contextFor("sess-1"), patches: [{ op: "add", path: "/scene", value: "天台" }] }),
  ]);
  assert.equal(JSON.parse(left.content[0].text).ok, true);
  assert.equal(JSON.parse(right.content[0].text).ok, true);

  const stored = JSON.parse(ctx.files.get(ctx.statePath));
  assert.deepEqual(stored.entries["sess-1"].variables, { mood: "松弛", scene: "天台" });
  assert.equal(stored.entries["sess-1"].revision, 2);
});

test("落盘出错不谎称没生效，只说不能确认保存", async () => {
  const ctx = makeCtx({ writeFails: true });
  const result = await call(ctx, { action: "update", context: contextFor("sess-1"), patches: [{ op: "add", path: "/mood", value: "松弛" }] });
  assert.equal(result.isError, true);
  assert.match(result.parsed.error, /不能确认保存成功，请先回查再重试/);
  assert.doesNotMatch(result.parsed.error, /没有生效/);
  assert.equal(ctx.files.has(ctx.statePath), false);
});

test("落盘后的回查出错，同样只说不能确认保存成功", async () => {
  const ctx = makeCtx();
  let written = false;
  const originalWrite = ctx.resources.write.bind(ctx.resources);
  ctx.resources.write = async (ref, bytes) => {
    const result = await originalWrite(ref, bytes);
    written = true;
    return result;
  };
  const originalRead = ctx.resources.read.bind(ctx.resources);
  ctx.resources.read = async (ref) => {
    if (written && norm(ref?.path || "") === ctx.statePath) throw new Error("读取时磁盘抖了一下");
    return originalRead(ref);
  };

  const result = await call(ctx, { action: "update", context: contextFor("sess-1"), patches: [{ op: "add", path: "/mood", value: "松弛" }] });
  assert.equal(result.isError, true);
  assert.match(result.parsed.error, /不能确认保存成功，请先回查再重试/);
  assert.doesNotMatch(result.parsed.error, /没有生效/);
  // 写已经发生，所以账本里确实留下了痕迹——这也正是不能谎称「没生效」的原因。
  assert.equal(JSON.parse(ctx.files.get(ctx.statePath)).entries["sess-1"].variables.mood, "松弛");
});

test("账本读不出来一律拒绝，不覆盖：空文件、坏 JSON、坏结构、危险条目名", async () => {
  const cases = [
    { name: "空文件", raw: "   ", expect: /空文件/ },
    { name: "坏 JSON", raw: "{ 这不是 JSON", expect: /不是合法 JSON/ },
    { name: "entries 是数组", raw: JSON.stringify({ version: 1, entries: [] }), expect: /缺少 entries/ },
    { name: "条目不是对象", raw: JSON.stringify({ version: 1, entries: { "sess-1": 7 } }), expect: /不是对象/ },
    { name: "键与自身 sessionId 不符", raw: JSON.stringify({ version: 1, entries: { "sess-x": { sessionId: "sess-1", variables: {} } } }), expect: /与它自己的 sessionId 对不上/ },
    { name: "危险条目名", raw: '{"version":1,"entries":{"__proto__":{"sessionId":"__proto__","variables":{}}}}', expect: /危险条目名/ },
  ];
  for (const item of cases) {
    const ctx = makeCtx({ stateFile: item.raw });
    const read = await call(ctx, { action: "get", context: contextFor("sess-1") });
    assert.equal(read.isError, true, `${item.name} 的 get 应当被拒绝`);
    assert.match(read.parsed.error, /拒绝读写/, `${item.name} 的 get 报错不对：${read.parsed.error}`);

    const write = await call(ctx, { action: "update", context: contextFor("sess-1"), patches: [{ op: "add", path: "/mood", value: "x" }] });
    assert.equal(write.isError, true, `${item.name} 的 update 应当被拒绝`);
    assert.equal(ctx.files.get(ctx.statePath), item.raw, `${item.name} 不该被覆盖`);
  }
});

test("访问被拒、错误不明的读失败都算坏账，不当空账", async () => {
  const denied = makeCtx({ stateFile: "{}", stateReadThrows: Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" }) });
  const deniedRead = await call(denied, { action: "get", context: contextFor("sess-1") });
  assert.equal(deniedRead.isError, true);
  assert.match(deniedRead.parsed.error, /读权限被拒/);

  const unknown = makeCtx({ stateFile: "{}", stateReadThrows: new Error("什么鬼错误") });
  const unknownRead = await call(unknown, { action: "get", context: contextFor("sess-1") });
  assert.equal(unknownRead.isError, true);
  assert.match(unknownRead.parsed.error, /错误不明/);

  // 错误不明但宿主 stat 明确说文件不存在：才算空账。
  const absent = makeCtx({ stateReadThrows: new Error("什么鬼错误"), statThrows: Object.assign(new Error("ENOENT: no such file"), { code: "ENOENT" }) });
  const absentRead = await call(absent, { action: "get", context: contextFor("sess-1") });
  assert.equal(absentRead.isError, false);
  assert.deepEqual(absentRead.parsed.variables, {});
});

test("没有 dataDir 直接拒绝，不去猜默认位置", async () => {
  const ctx = makeCtx({ dataDir: null });
  const result = await call(ctx, { action: "get", context: contextFor("sess-1") });
  assert.equal(result.isError, true);
  assert.match(result.parsed.error, /没有给出这个应用的数据目录/);
});

test("已建条目与当前访客对不上时 get 也拒绝，不给可疑状态", async () => {
  const good = {
    sessionId: "sess-1",
    sessionPath: "C:/tmp/sample-role/sess-1.jsonl",
    agentId: "sample-partner",
    characterId: "示例角色.png",
    variables: { mood: "松弛" },
    revision: 1,
    updatedAt: "2026-10-08T00:00:00.000Z",
  };
  const cases = [
    { name: "角色对不上", entry: { ...good, characterId: "别人.png" }, expect: /角色与访客台账对不上/ },
    { name: "伙伴对不上", entry: { ...good, agentId: "partner-a" }, expect: /伙伴与当前会话对不上/ },
    { name: "路径对不上", entry: { ...good, sessionPath: "C:/tmp/other/sess-1.jsonl" }, expect: /会话路径与当前会话对不上/ },
    { name: "会话对不上", entry: { ...good, sessionId: "sess-9" }, expect: /条目 sess-1 与它自己的 sessionId 对不上/ },
    { name: "变量不是对象", entry: { ...good, variables: [] }, expect: /变量不是对象/ },
  ];
  for (const item of cases) {
    const raw = JSON.stringify({ version: 1, entries: { "sess-1": item.entry } });
    const ctx = makeCtx({ stateFile: raw });
    const read = await call(ctx, { action: "get", context: contextFor("sess-1") });
    assert.equal(read.isError, true, `${item.name} 的 get 应当被拒绝`);
    assert.match(read.parsed.error, item.expect, `${item.name} 报错不对：${read.parsed.error}`);

    const write = await call(ctx, { action: "update", context: contextFor("sess-1"), patches: [{ op: "add", path: "/x", value: 1 }] });
    assert.equal(write.isError, true, `${item.name} 的 update 应当被拒绝`);
    assert.equal(ctx.files.get(ctx.statePath), raw, `${item.name} 不该被覆盖`);
  }
});

test("送回酒馆的访客没有可读写状态", async () => {
  const ctx = makeCtx({ visitors: [{ ...VISITOR, status: "departed" }] });
  const result = await call(ctx, { action: "get", context: contextFor("sess-1") });
  assert.equal(result.isError, true);
  assert.match(result.parsed.error, /不是鲜花酿邀请的来访会话/);
});

test("台账里同一会话有多条记录时拒绝，不挑一条", async () => {
  const ctx = makeCtx({ visitors: [VISITOR, { ...VISITOR, characterName: "示例角色（重复登记）" }] });
  const result = await call(ctx, { action: "get", context: contextFor("sess-1") });
  assert.equal(result.isError, true);
  assert.match(result.parsed.error, /多条记录/);
});