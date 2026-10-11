import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { readManifest, apply } from "../index.js";

const root = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.dirname(root);

 test("manifest declares one embedded v2 host card", () => {
  const manifest = readManifest();
  assert.equal(manifest.manifestVersion, 2);
  assert.equal(manifest.id, "xianhuaniang");
  assert.equal(manifest.entry, "index.js");
  assert.equal(manifest.version, JSON.parse(fs.readFileSync(path.join(appDir, "package.json"), "utf8")).version);
  const mainCard = manifest.contributes.cards.find((card) => card.id === "workspace");
  assert.ok(mainCard, "主卡 workspace 必须仍然声明");
  assert.equal(mainCard.title, "鲜花酿");
  assert.match(mainCard.description, /打开即进入酒馆/);
  assert.deepEqual(manifest.capabilities, [
    "app/runtime.execute",
    "app/runtime.local-machine",
    "app/runtime.network",
    "app/resources.read",
    "app/resources.write",
    "app/agents.read",
    "app/agents.manage",
    "app/sessions.manage",
    "app/sessions.read",
    "app/session.start-turn",
    "app/services.call",
    "app/tools.expose-to-model",
  ]);
  assert.equal(manifest.contributes.cards.length, 2);
  assert.equal(mainCard.siteNavEntry, true);
  assert.ok(fs.existsSync(path.join(appDir, "ui", "assets", "sdk.js")));
  assert.ok(fs.existsSync(path.join(appDir, "runtime", "st-launcher.mjs")));
  assert.ok(fs.existsSync(path.join(appDir, "runtime", "st-proxy.mjs")));
  const launcher = fs.readFileSync(path.join(appDir, "runtime", "st-launcher.mjs"), "utf8");
  assert.match(launcher, /createStProxyServer/);
  assert.match(launcher, /String\(upstreamPort\)/);
  assert.equal(fs.existsSync(path.join(appDir, "ui", "tavern.html")), false);
  for (const card of manifest.contributes.cards) {
    assert.ok(fs.existsSync(path.join(appDir, "ui", card.face.image)));
    assert.ok(fs.existsSync(path.join(appDir, "ui", card.route.slice(1))));
  }
  assert.equal(mainCard.route, "/workspace.html");
  // 流内小剧场卡：本体是 ui/theater.html，声明走 messageRenderers 映射到自定义消息。
  const theaterCard = manifest.contributes.cards.find((card) => card.id === "theater");
  assert.ok(theaterCard, "小剧场卡必须声明");
  assert.equal(theaterCard.route, "/theater.html");
  assert.equal(theaterCard.siteNavEntry, undefined, "小剧场是流内卡，不进页面导航");
  assert.deepEqual(manifest.contributes.messageRenderers, [{ customType: "theater", cardId: "theater" }]);
  const theaterHtml = fs.readFileSync(path.join(appDir, "ui", "theater.html"), "utf8");
  assert.match(theaterHtml, /src="\.\/theater\.js"/);
  const theaterJs = fs.readFileSync(path.join(appDir, "ui", "theater.js"), "utf8");
  assert.match(theaterJs, /import \{ hana \} from '\.\/assets\/sdk\.js'/);
  assert.match(theaterJs, /hana\.ready\(\)/);
  // 流内卡的 route 由宿主拼装、不带查询参数，会话身份只能取宿主盖章的来源会话；
  // 取不到就锁提交按钮，不许猜一个会话发过去。
  assert.match(theaterJs, /hana\?\.surface\?\.getContext\?\.\(\)/);
  assert.match(theaterJs, /这张卡没有绑定到当前对话/);
  // 取出形态只给看板：读应用自己的成绩单，提交入口不给。
  assert.match(theaterJs, /\/theater\/latest/);
  assert.match(theaterJs, /renderBoard\(\)/);
  assert.match(theaterHtml, /要留在对话里才能发起测卡/);
  // 旧版是插件页裸 fetch 拼 /api/plugins/hanabrew，App 版一律走 SDK 桥接。
  assert.doesNotMatch(theaterJs, /api\/plugins|pluginSurfaceSession|X-Hana-Plugin-Surface-Session/);
  // 测试方式的按钮由 boot() 生成；脚本顶部直接 querySelectorAll('[data-test]') 会取到空集合，
  // 七个选项里只有默认那个看着是选中的，剩下全点不动（2026-10-11 实机就是这个现象）。
  assert.doesNotMatch(theaterJs, /document\.querySelectorAll\('\[data-test\]'\)/);
  assert.match(theaterJs, /\$\('tests'\)\.addEventListener\('click'/);
  const card = mainCard;
  assert.equal(card.fpFullPanel, true);
  assert.deepEqual(card.functionPanel, { id: "workbench", label: "鲜花酿工作台", route: "/workbench.html" });
  assert.ok(fs.existsSync(path.join(appDir, "ui", "workbench.html")));
  const workspaceHtml = fs.readFileSync(path.join(appDir, "ui", "workspace.html"), "utf8");
  assert.match(workspaceHtml, /import \{ hana \} from "\.\/assets\/sdk\.js"/);
  assert.match(workspaceHtml, /hana\.ready\(\)/);
  assert.match(workspaceHtml, /<iframe id="frame" title="SillyTavern"/);
  assert.doesNotMatch(workspaceHtml, /<aside|grid-template-columns|id="inviteCharacter"|id="exportPartner"|id="cardLab"/);
  assert.doesNotMatch(workspaceHtml, /进入我的酒馆|id="openTavern"|id="back"/);
  assert.match(workspaceHtml, /id="retry"/);
  assert.match(workspaceHtml, /launchTavern\(\);/);
  // 酒馆 iframe 优先走 Hana 受管运行时路径，裸回环地址只作兜底。
  assert.match(workspaceHtml, /const managedUrl = data\.runtimeId && api\?\.url/);
  assert.match(workspaceHtml, /api\.url\(`_runtime\/\$\{encodeURIComponent\(data\.runtimeId\)\}\/index\.html\?hanaLaunch=/);
  assert.match(workspaceHtml, /new URL\("index\.html\?hanaLaunch=" \+ Date\.now\(\), data\.serverUrl\)/);
  assert.match(workspaceHtml, /if \(!frameUrl\) throw new Error/);
  assert.match(workspaceHtml, /frame\.addEventListener\("load"/);
  assert.doesNotMatch(workspaceHtml, /window\.open|打开独立窗口/);
  const workbenchHtml = fs.readFileSync(path.join(appDir, "ui", "workbench.html"), "utf8");
  assert.match(workbenchHtml, /import \{ hana \} from "\.\/assets\/sdk\.js"/);
  const workbenchScript = workbenchHtml.match(/<script type="module">([\s\S]*?)<\/script>/)?.[1] || "";
  const checkedScript = workbenchScript.replace(/\s*import \{ hana \} from "\.\/assets\/sdk\.js";\s*hana\.ready\(\);/u, "");
  assert.doesNotThrow(() => new vm.Script(checkedScript), "工作台内联脚本必须能解析");
  assert.match(workbenchHtml, /hana\.ready\(\)/);
  assert.match(workbenchHtml, /邀请酒馆角色到茶话会/);
  assert.match(workbenchHtml, /setTeaPartyAvailability/);
  assert.match(workbenchHtml, /character\.unavailableReason/);
  assert.doesNotMatch(workbenchHtml, /需要先安装并启用茶话会/, "笼统的旧文案应当已经删掉");
  assert.doesNotMatch(workbenchHtml, /还没有安装茶话会/, "目录探测在 App 沙箱里不可信，不能再拿它判未安装");
  assert.doesNotMatch(workbenchHtml, /app\/services\.provide/, "探测失灵时不再把用户引去开一个可能已开着的权限");
  assert.match(workbenchHtml, /鲜花酿没能拿到应用间通道/);
  assert.match(workbenchHtml, /\/workbench\/tea-party\/preview/);
  assert.match(workbenchHtml, /\/workbench\/tea-party\/invite/);
  assert.match(workbenchHtml, /酒馆聊天记录/);
  assert.doesNotMatch(workbenchHtml, /plugin_private|请先用旧版「花酿」工作台/);
  assert.match(workbenchHtml, /visitorList/);
  assert.doesNotMatch(workbenchHtml, /agent:list/);
  assert.match(workbenchHtml, /把伙伴带去酒馆/);
  assert.match(workbenchHtml, /测卡|小剧场/);
  assert.doesNotMatch(workbenchHtml, /进入我的酒馆|grid-template-columns/);
  const stHtml = fs.readFileSync(path.join(appDir, "vendor", "sillytavern", "public", "index.html"), "utf8");
  // 受管路径适配：不能再依赖静态 <base> 事后改 href（对解析/预加载太晚），
  // 改为头部注入 importmap + 改写 script/link/img 的绝对地址。
  assert.doesNotMatch(stHtml, /<base id="hana-v2-base"/);
  assert.match(stHtml, /importmap/);
  assert.match(stHtml, /_surface/);
  assert.match(stHtml, /patchUrlProp/);
  assert.match(stHtml, /nativeSetAttribute/);
});

test("ensureServer reads runtimeId from the flat runtime record", async () => {
  const { ensureServer, runtimeStatus, stopServer } = await import("../backend/st-runtime.js");
  const ctx = {
    runtime: {
      async start() {
        return { runtimeId: "rt_probe", state: "ready", runtime: "node", service: { state: "ready" } };
      },
      async get() {
        return { runtimeId: "rt_probe", state: "ready", runtime: "node", service: { state: "ready" } };
      },
      async stop() {},
    },
  };
  const status = await ensureServer(ctx, () => {});
  // 旧写法 result?.runtime || result 会把 "node" 字符串当成运行时对象，runtimeId 取空。
  assert.equal(status.runtimeId, "rt_probe");
  assert.equal((await runtimeStatus(ctx)).runtimeId, "rt_probe");
  assert.equal((await runtimeStatus(ctx)).running, true);
  const stopped = await stopServer(ctx, () => {});
  assert.equal(stopped.stopped, true);
  assert.equal((await runtimeStatus(ctx)).runtimeId, "");
});

test("runtime status refreshes the host record until the managed service is ready", async () => {
  const { ensureServer, runtimeStatus, stopServer } = await import("../backend/st-runtime.js");
  let reads = 0;
  const ctx = {
    runtime: {
      async start() {
        return { runtimeId: "rt_starting", state: "starting", runtime: "node", service: { state: "starting" } };
      },
      async get() {
        reads++;
        return { runtimeId: "rt_starting", state: "ready", runtime: "node", service: { state: "ready" } };
      },
      async stop() {},
    },
  };
  try {
    const initial = await ensureServer(ctx, () => {});
    assert.equal(initial.ready, true);
    assert.equal(initial.state, "ready");
    assert.equal(reads, 1);
    const current = await runtimeStatus(ctx);
    assert.equal(current.ready, true);
    assert.equal(current.serviceState, "ready");
  } finally {
    await stopServer(ctx, () => {});
  }
});

test("entry imports and apply registers runtime routes", async (t) => {
  const logs = [];
  const routes = [];
  const dataDir = fs.mkdtempSync(path.join(tmpdir(), 'hanabrew-apply-test-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const cleanup = await apply({
    dataDir,
    tools: { register: async () => () => {} },
    logger: { info: (...messages) => logs.push(messages.join(" ")), warn: () => {} },
    routes: {
      register(registerer) {
        registerer({
          get: (path) => routes.push(`GET ${path}`),
          post: (path) => routes.push(`POST ${path}`),
        });
        return () => {};
      },
    },
  });
  assert.equal(typeof cleanup, "function");
  assert.deepEqual(routes, [
    "GET /runtime/status",
    "POST /runtime/start",
    "POST /runtime/stop",
    "POST /theater/diag",
    "GET /theater/latest",
    "GET /theater/current",
    "POST /theater/submit",
    "POST /theater/handoff",
    "GET /theater/progress",
    "POST /theater/control",
    "POST /migration/preview",
    "POST /migration/apply",
    "GET /migration/status",
    "GET /workbench/characters",
    "GET /workbench/tea-party/status",
    "POST /workbench/tea-party/preview",
    "POST /workbench/tea-party/invite",
    "POST /workbench/visitor/preview",
    "POST /workbench/invite",
    "GET /workbench/visitors",
    "POST /workbench/visitors/settle",
    "POST /workbench/visitors/depart",
    "POST /workbench/visitors/uninvite",
    "POST /workbench/visitors/repair",
    "GET /tavern/skin/status",
    "POST /tavern/skin/apply",
    "POST /tavern/skin/sync",
    "GET /workbench/agents",
    "POST /workbench/export/preview",
    "POST /workbench/export",
  ]);
  await cleanup();
  assert.equal(logs.some((message) => message.includes("已清理")), true);
});
