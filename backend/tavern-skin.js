// 鲜花酿 v2 · 内置酒馆皮肤：小花薄荷手帐 + 跟随 Hana 深浅
//
// 两件事：
//  1) 把自带主题「薄荷手帐 · 简约」装进 v2 酒馆的用户主题目录（缺失才写，不覆盖用户改动），
//     并在用户还没选过主题时把它设为当前主题。
//  2) 每 2 秒读 Hana 宿主主题，把 { dark, theme } 写进 v2 自己的数据目录；
//     酒馆前端轮询同源 /hana-theme.json 切 hana-dark class（由 st-proxy 应答，不经过 ST）。
//
// 为什么用静态文件而不是 ST settings：
// ST 前端保存设置时会把 power_user 整份写回，页面加载时的旧快照会把我们写进去的
// hanaDark 顶掉，后端再补回去 → 一会黑一会白的拉锯。静态文件不碰 settings，根除抖动。
//
// 为什么 v2 自己写、而不是复用 v1 花酿那份：
// v1 把它写在共享的 ST public 目录里，v1/v2 同时跑会互相覆盖；v2 的酒馆走自己的代理，
// 状态文件放自己的 dataRoot，两边彻底隔离。

import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { runtimeConfig } from "./st-runtime.js";

const THEME_NAME = "薄荷手帐 · 简约";
const THEME_FILE = `${THEME_NAME}.json`;
const SKIN_STATE_FILE = "_hana-skin.json";
/** 写进酒馆自定义样式时的标记，用来认出「这一段是皮肤塞的」。 */
const SKIN_MARK = "/* 鲜花酿 · 薄荷手帐皮肤 */";
const SYNC_INTERVAL_MS = 2000;

/** 宿主内置主题里目前只有这两个是暗色。 */
const HANA_DARK_THEMES = new Set(["midnight", "midnight-contrast"]);

let timer = null;
let lastDark = null;
let lastTheme = "";
let log = () => {};

function appDir() {
  return fileURLToPath(new URL("..", import.meta.url)).replace(/[\\/]+$/, "");
}

/** 自带主题文件的位置（导出给测试用）。 */
export function bundledThemePath() {
  return join(appDir(), "theme", THEME_FILE);
}

function dataRoot() {
  return runtimeConfig().dataRoot;
}

function userRoot() {
  return join(dataRoot(), "default-user");
}

function themeDir() {
  return join(userRoot(), "themes");
}

function settingsPath() {
  return join(userRoot(), "settings.json");
}

function skinStatePath() {
  return join(dataRoot(), SKIN_STATE_FILE);
}

function hanaPreferencesPath() {
  return join(process.env.HANA_HOME || join(process.env.USERPROFILE || "", ".hanako"), "user", "preferences.json");
}

async function readText(ctx, path) {
  try {
    const result = await ctx.resources.read({ kind: "local-file", path });
    return String(result?.content || "");
  } catch {
    return "";
  }
}

async function writeText(ctx, path, content) {
  await ctx.resources.write({ kind: "local-file", path }, Buffer.from(content, "utf8"));
}

async function exists(ctx, path) {
  try {
    await ctx.resources.stat({ kind: "local-file", path });
    return true;
  } catch {
    return false;
  }
}

/** 读 Hana 宿主当前主题。读不到就按浅色算，不猜。 */
export async function readHanaTheme(ctx) {
  const raw = await readText(ctx, hanaPreferencesPath());
  if (!raw) return { dark: false, theme: "" };
  try {
    const prefs = JSON.parse(raw);
    const theme = String(prefs?.appearance?.theme || "");
    return { dark: HANA_DARK_THEMES.has(theme), theme };
  } catch {
    return { dark: false, theme: "" };
  }
}

/** 把主题状态写给酒馆前端轮询读取。 */
export async function writeSkinState(ctx, state) {
  const payload = `${JSON.stringify({ ...state, updatedAt: Date.now() })}\n`;
  await writeText(ctx, skinStatePath(), payload);
  return state;
}

export async function readSkinState(ctx) {
  const raw = await readText(ctx, skinStatePath());
  if (!raw) return { dark: false, theme: "" };
  try {
    const parsed = JSON.parse(raw);
    return { dark: Boolean(parsed?.dark), theme: String(parsed?.theme || ""), paletteApplied: Boolean(parsed?.paletteApplied) };
  } catch {
    return { dark: false, theme: "" };
  }
}

/** 主题文件是否已装进酒馆。 */
export async function isThemeInstalled(ctx) {
  return exists(ctx, join(themeDir(), THEME_FILE));
}

/** 酒馆当前是否正在用这套主题。 */
export async function isThemeActive(ctx) {
  const raw = await readText(ctx, settingsPath());
  if (!raw) return false;
  try {
    return JSON.parse(raw)?.power_user?.theme === THEME_NAME;
  } catch {
    return false;
  }
}

async function readSettings(ctx) {
  const raw = await readText(ctx, settingsPath());
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** 从主题文件里取出皮肤 CSS。 */
export function extractSkinCss(raw) {
  if (!raw) return "";
  try {
    return String(JSON.parse(raw)?.custom_css || "");
  } catch {
    return "";
  }
}

/**
 * 主题文件里能直接搬进酒馆设置（power_user）的字段。
 * ST 启动只从 power_user 取色（public/scripts/power-user.js 的 applyThemeColor），
 * 主题 JSON 里的颜色字段只有你在 ST 面板里点一次才会被抄过去；不抄就是上一套主题的旧颜色。
 * 字段名两边一致才搬，对不上的（斜体等）不硬塞。
 */
export const PALETTE_KEYS = [
  "main_text_color",
  "quote_text_color",
  "underline_text_color",
  "blur_tint_color",
  "chat_tint_color",
  "user_mes_blur_tint_color",
  "bot_mes_blur_tint_color",
  "border_color",
  "shadow_color",
  "shadow_width",
  "font_scale",
  "noShadows",
  "chat_width",
];

/** 从主题文件里取出要搬进 power_user 的配色字段。 */
export function extractPalette(raw) {
  if (!raw) return {};
  let theme = null;
  try {
    theme = JSON.parse(raw);
  } catch {
    return {};
  }
  const out = {};
  for (const key of PALETTE_KEYS) {
    if (theme?.[key] !== undefined) out[key] = theme[key];
  }
  return out;
}

/**
 * 装主题并（用户没选过主题时）启用它，顺手把皮肤 CSS 塞进酒馆自定义样式。
 * 用户已经选了别的主题就只装不启，不抢用户的口味。
 *
 * 为什么必须写 power_user.custom_css：
 * ST 只在启动时从 power_user.custom_css 取样式（public/scripts/power-user.js），
 * 主题文件里的 custom_css 只是模板，选主题不会套用。所以「装了主题还是默认皮」就是这么来的。
 */
export async function applySkin(ctx) {
  const notes = [];
  let bundled = null;
  if (!(await isThemeInstalled(ctx))) {
    bundled = await readText(ctx, bundledThemePath());
    if (!bundled) throw new Error("鲜花酿缺少自带的主题文件。");
    await writeText(ctx, join(themeDir(), THEME_FILE), bundled);
    notes.push("主题已装进酒馆");
  } else {
    notes.push("主题已经在酒馆里");
  }

  const settings = await readSettings(ctx);
  let paletteDone = false;
  if (settings) {
    if (!settings.power_user || typeof settings.power_user !== "object") settings.power_user = {};
    let dirty = false;
    if (!settings.power_user.theme) {
      settings.power_user.theme = THEME_NAME;
      dirty = true;
      notes.push("已设为当前主题，重开酒馆生效");
    } else if (settings.power_user.theme !== THEME_NAME) {
      notes.push(`你在酒馆里选的是「${settings.power_user.theme}」，这次没有替你改`);
    } else {
      notes.push("已经是当前主题");
    }

    if (bundled === null) bundled = await readText(ctx, bundledThemePath());

    // 配色只搬一次：搬过之后你手调过的颜色我们不再动。
    const state = await readSkinState(ctx);
    if (!state.paletteApplied) {
      const palette = extractPalette(bundled);
      const keys = Object.keys(palette);
      if (keys.length) {
        for (const key of keys) settings.power_user[key] = palette[key];
        dirty = true;
        paletteDone = true;
        notes.push(`配色已同步 ${keys.length} 项，底色不再是上一套主题的黑`);
      }
    }

    const skin = extractSkinCss(bundled);
    const current = typeof settings.power_user.custom_css === "string" ? settings.power_user.custom_css : "";
    if (skin && !current) {
      settings.power_user.custom_css = `${SKIN_MARK}\n${skin}`;
      dirty = true;
      notes.push("皮肤样式已写进酒馆，重开酒馆生效");
    } else if (!skin) {
      notes.push("自带主题里没有皮肤样式");
    } else if (current.includes(SKIN_MARK)) {
      notes.push("皮肤样式已经在酒馆里");
    } else {
      notes.push("酒馆自定义样式里已经有你自己的内容，这次没替你塞皮肤");
    }

    if (dirty) await writeText(ctx, settingsPath(), `${JSON.stringify(settings, null, 4)}\n`);
  } else {
    notes.push("酒馆还没有生成设置，等它先开一次");
  }

  const hana = await readHanaTheme(ctx);
  const previous = await readSkinState(ctx);
  await writeSkinState(ctx, { ...hana, paletteApplied: Boolean(previous.paletteApplied) || paletteDone });
  return { ok: true, themeName: THEME_NAME, notes, state: { ...hana, paletteApplied: Boolean(previous.paletteApplied) || paletteDone } };
}

/** 深浅同步一轮：只有变了才写文件。 */
export async function syncSkinNow(ctx) {
  const state = await readHanaTheme(ctx);
  await writeSkinState(ctx, state);
  lastDark = state.dark;
  lastTheme = state.theme;
  return state;
}

async function syncOnce(ctx) {
  const state = await readHanaTheme(ctx);
  if (state.dark === lastDark && state.theme === lastTheme) return state;
  await writeSkinState(ctx, state);
  lastDark = state.dark;
  lastTheme = state.theme;
  log("info", `[xianhuniang-skin] 宿主主题 ${state.theme || "(未设置)"}${state.dark ? " · 深色" : " · 浅色"}`);
  return state;
}

/** 启动深浅跟随。酒馆没在跑也照写，状态文件随时是最新的。 */
export function startSkinSync(ctx, logger = {}) {
  log = (level, message) => logger[level]?.(message);
  if (timer) return;
  lastDark = null;
  lastTheme = "";
  syncOnce(ctx).catch(() => {});
  timer = setInterval(() => { syncOnce(ctx).catch(() => {}); }, SYNC_INTERVAL_MS);
  if (typeof timer.unref === "function") timer.unref();
}

export function stopSkinSync() {
  if (timer) clearInterval(timer);
  timer = null;
  lastDark = null;
  lastTheme = "";
}

export function isSkinSyncRunning() {
  return Boolean(timer);
}

export async function getSkinStatus(ctx) {
  const hana = await readHanaTheme(ctx);
  const state = await readSkinState(ctx);
  return {
    themeName: THEME_NAME,
    installed: await isThemeInstalled(ctx),
    active: await isThemeActive(ctx),
    following: isSkinSyncRunning(),
    hana,
    tavern: state,
    inSync: hana.dark === state.dark && hana.theme === state.theme,
  };
}
