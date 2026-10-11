import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  applySkin,
  bundledThemePath,
  getSkinStatus,
  isThemeActive,
  isThemeInstalled,
  readHanaTheme,
  readSkinState,
  syncSkinNow,
  writeSkinState,
  extractSkinCss,
  extractPalette,
  PALETTE_KEYS,
} from "../backend/tavern-skin.js";

const THEME = "薄荷手帐 · 简约";

function makeCtx({ files = {}, appData, hanaHome } = {}) {
  const posix = (value) => String(value).replace(/\\/g, "/");
  const store = new Map(Object.entries(files).map(([key, value]) => [posix(key), value]));
  return {
    dataDir: appData,
    resources: {
      async read(ref) {
        const key = posix(ref.path);
        if (!store.has(key)) throw new Error("not found");
        return { content: store.get(key) };
      },
      async write(ref, bytes) {
        store.set(posix(ref.path), Buffer.from(bytes).toString("utf8"));
        return { ok: true };
      },
      async stat(ref) {
        if (!store.has(posix(ref.path))) throw new Error("not found");
        return { ok: true };
      },
    },
    store,
    hanaHome,
  };
}

async function withEnv({ appData, hanaHome }, run) {
  const previousApp = process.env.APPDATA;
  const previousHome = process.env.HANA_HOME;
  process.env.APPDATA = appData;
  process.env.HANA_HOME = hanaHome;
  try {
    return await run();
  } finally {
    if (previousApp === undefined) delete process.env.APPDATA;
    else process.env.APPDATA = previousApp;
    if (previousHome === undefined) delete process.env.HANA_HOME;
    else process.env.HANA_HOME = previousHome;
  }
}

function uniqueRoot(label) {
  return join(tmpdir(), `xhn-skin-${label}-${Date.now()}-${Math.random().toString(16).slice(2, 6)}`);
}

test("只把 Hana 的暗色主题算成深色", async () => {
  const hanaHome = uniqueRoot("hana");
  await withEnv({ appData: uniqueRoot("appdata"), hanaHome }, async () => {
  const ctx = makeCtx({
    hanaHome,
    files: { [join(hanaHome, "user", "preferences.json")]: JSON.stringify({ appearance: { theme: "midnight" } }) },
  });
  assert.deepEqual(await readHanaTheme(ctx), { dark: true, theme: "midnight" });

  const light = makeCtx({
    hanaHome,
    files: { [join(hanaHome, "user", "preferences.json")]: JSON.stringify({ appearance: { theme: "xiaohua-mint" } }) },
  });
  assert.deepEqual(await readHanaTheme(light), { dark: false, theme: "xiaohua-mint" });

  const broken = makeCtx({ hanaHome, files: { [join(hanaHome, "user", "preferences.json")]: "{ 坏掉的 json" } });
  assert.deepEqual(await readHanaTheme(broken), { dark: false, theme: "" }, "读不到就按浅色，不猜");

  const missing = makeCtx({ hanaHome, files: {} });
  assert.deepEqual(await readHanaTheme(missing), { dark: false, theme: "" });
  });
});

test("主题没装过时安装并启用；用户已经选了别的主题就不抢", async () => {
  const appData = uniqueRoot("appdata");
  const stData = join(appData, "xianhuaniang", "st-data");
  const hanaHome = uniqueRoot("hana");
  const themePath = join(stData, "default-user", "themes", `${THEME}.json`);
  const settingsPath = join(stData, "default-user", "settings.json");

  await withEnv({ appData, hanaHome }, async () => {
  const first = makeCtx({
    hanaHome,
    files: {
      [settingsPath]: JSON.stringify({ power_user: {} }),
      [bundledThemePath()]: JSON.stringify({ name: THEME, custom_css: "/* 薄荷手帐 */" }),
      [join(hanaHome, "user", "preferences.json")]: JSON.stringify({ appearance: { theme: "warm-paper" } }),
    },
  });
  const applied = await applySkin(first);
  assert.equal(applied.ok, true);
  assert.equal(await isThemeInstalled(first), true);
  assert.equal(await isThemeActive(first), true);
  assert.match(first.store.get(themePath.replace(/\\/g, "/")), /薄荷手帐/);
  // 装主题的同时把当前深浅写给酒馆（自带主题没配色字段，所以没动 paletteApplied）
  assert.deepEqual(await readSkinState(first), { dark: false, theme: "warm-paper", paletteApplied: false });

  const second = makeCtx({
    hanaHome,
    files: {
      [settingsPath]: JSON.stringify({ power_user: { theme: "midnight" } }),
      [bundledThemePath()]: JSON.stringify({ name: THEME }),
    },
  });
  const kept = await applySkin(second);
  assert.match(kept.notes.join(" "), /没有替你改/);
  assert.equal(await isThemeActive(second), false, "用户选了午夜主题就不抢");
  });
});

test("皮肤 CSS 会写进酒馆自定义样式；用户自己写了就不塞", async () => {
  const appData = uniqueRoot("appdata");
  const stData = join(appData, "xianhuaniang", "st-data");
  const hanaHome = uniqueRoot("hana");
  const settingsPath = join(stData, "default-user", "settings.json");
  const bundled = JSON.stringify({ name: THEME, custom_css: "/* 薄荷手帐 */\nbody { color: red; }" });

  await withEnv({ appData, hanaHome }, async () => {
  const fresh = makeCtx({
    hanaHome,
    files: { [settingsPath]: JSON.stringify({ power_user: {} }), [bundledThemePath()]: bundled },
  });
  const applied = await applySkin(fresh);
  assert.match(applied.notes.join(" "), /皮肤样式已写进酒馆/);
  const written = JSON.parse(fresh.store.get(settingsPath.replace(/\\/g, "/")));
  assert.match(written.power_user.custom_css, /鲜花酿/);
  assert.match(written.power_user.custom_css, /color: red/);

  const mine = makeCtx({
    hanaHome,
    files: {
      [settingsPath]: JSON.stringify({ power_user: { custom_css: "/* 我自己写的 */" } }),
      [bundledThemePath()]: bundled,
    },
  });
  const kept = await applySkin(mine);
  assert.match(kept.notes.join(" "), /已经有你自己的内容/);
  const untouched = JSON.parse(mine.store.get(settingsPath.replace(/\\/g, "/")));
  assert.equal(untouched.power_user.custom_css, "/* 我自己写的 */");
  });
});

test("主题配色会搬进酒馆设置；搬过一次就不再盖用户手调的颜色", async () => {
  const appData = uniqueRoot("appdata");
  const stData = join(appData, "xianhuaniang", "st-data");
  const hanaHome = uniqueRoot("hana");
  const settingsPath = join(stData, "default-user", "settings.json");
  const bundled = JSON.stringify({
    name: THEME,
    blur_tint_color: "rgba(255, 252, 244, 0.92)",
    main_text_color: "rgba(78, 106, 94, 1)",
    chat_width: 60,
    italics_text_color: "rgba(200, 150, 140, 0.95)",
    custom_css: "/* 薄荷手帐 */",
  });

  await withEnv({ appData, hanaHome }, async () => {
  const first = makeCtx({
    hanaHome,
    files: {
      [settingsPath]: JSON.stringify({ power_user: { blur_tint_color: "rgba(23, 23, 23, 1)" } }),
      [bundledThemePath()]: bundled,
    },
  });
  const applied = await applySkin(first);
  assert.match(applied.notes.join(" "), /配色已同步/);
  const written = JSON.parse(first.store.get(settingsPath.replace(/\\/g, "/")));
  assert.equal(written.power_user.blur_tint_color, "rgba(255, 252, 244, 0.92)", "上一套主题的黑要被换掉");
  assert.equal(written.power_user.chat_width, 60);
  assert.equal(written.power_user.italics_text_color, undefined, "字段名两边不一致就不硬塞");
  assert.equal(applied.state.paletteApplied, true);

  // 用户手调过颜色之后，第二次应用不覆盖
  const second = makeCtx({
    hanaHome,
    files: {
      [settingsPath]: JSON.stringify({ power_user: { theme: THEME, blur_tint_color: "rgba(1, 2, 3, 1)" } }),
      [bundledThemePath()]: bundled,
      [join(stData, "_hana-skin.json")]: JSON.stringify({ dark: false, theme: "", paletteApplied: true }),
    },
  });
  await applySkin(second);
  const kept = JSON.parse(second.store.get(settingsPath.replace(/\\/g, "/")));
  assert.equal(kept.power_user.blur_tint_color, "rgba(1, 2, 3, 1)", "搬过一次就交还给你");
  });
});

test("主题文件坏了就取不到皮肤 CSS，不硬塞", () => {
  assert.equal(extractSkinCss("{ 坏掉的 json"), "");
  assert.equal(extractSkinCss(""), "");
  assert.equal(extractSkinCss(JSON.stringify({ name: "x" })), "");
  assert.equal(extractSkinCss(JSON.stringify({ custom_css: "/* 皮 */" })), "/* 皮 */");
  assert.equal(extractPalette("{ 坏掉的 json")["blur_tint_color"], undefined);
  assert.deepEqual(extractPalette(JSON.stringify({ blur_tint_color: "a", 不认识: 1 })), { blur_tint_color: "a" });
  assert.ok(PALETTE_KEYS.includes("blur_tint_color") && PALETTE_KEYS.includes("main_text_color"));
});

test("状态与宿主对得上才算同步成功", async () => {
  const appData = uniqueRoot("appdata");
  const hanaHome = uniqueRoot("hana");
  const prefs = join(hanaHome, "user", "preferences.json");
  await withEnv({ appData, hanaHome }, async () => {
    const ctx = makeCtx({ hanaHome, files: { [prefs]: JSON.stringify({ appearance: { theme: "midnight" } }) } });

    await writeSkinState(ctx, { dark: false, theme: "warm-paper" });
    assert.equal((await getSkinStatus(ctx)).inSync, false);

    await syncSkinNow(ctx);
    const status = await getSkinStatus(ctx);
    assert.equal(status.hana.dark, true);
    assert.equal(status.tavern.dark, true);
    assert.equal(status.inSync, true);
    assert.equal(status.installed, false, "没装主题就说没装");
    assert.match(status.themeName, /薄荷手帐/);
  });
});
