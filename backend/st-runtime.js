import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const APP_ROOT = realpathSync.native(fileURLToPath(new URL("../", import.meta.url)));
const DEFAULT_PORT = 18511;
function samePath(left, right) {
  const a = resolve(left);
  const b = resolve(right);
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function engineDirectory() {
  const expected = resolve(APP_ROOT, "vendor", "sillytavern");
  const actual = realpathSync.native(expected);
  if (!samePath(actual, expected)) {
    throw new Error("App 内置酒馆引擎必须位于 vendor/sillytavern 实目录，不能指向链接目标。");
  }
  return actual;
}
/**
 * v2 酒馆的数据根。
 * App 子进程可能拿不到完整环境变量（宿主只保证 PATH/HOME/TMPDIR/LANG），
 * APPDATA 整个不存在时就回退到 os.homedir() 拼出的同一位置：
 * 两条路指向的都是 %APPDATA%\xianhuaniang\st-data，不会把已有角色卡和聊天记录挪走。
 */
function dataRoot() {
  const roaming = process.env.APPDATA || join(homedir(), "AppData", "Roaming");
  return join(roaming, "xianhuaniang", "st-data");
}
const LAUNCHER_ENTRY = "runtime/st-launcher.mjs";

let runtime = null;
let starting = null;
let stopping = null;

export function runtimeConfig() {
  return {
    stDir: engineDirectory(),
    dataRoot: dataRoot(),
    defaultPort: DEFAULT_PORT,
    serverUrl: `http://127.0.0.1:${DEFAULT_PORT}/`,
  };
}

export async function runtimeStatus(ctx) {
  if (runtime?.runtimeId && typeof ctx?.runtime?.get === "function") {
    const current = await ctx.runtime.get(runtime.runtimeId);
    runtime = current || null;
  }
  const state = runtime?.state || "stopped";
  const serviceState = runtime?.service?.state || "";
  const running = Boolean(runtime && state !== "stopped" && state !== "failed");
  const ready = state === "ready" && serviceState === "ready";
  return {
    running,
    ready,
    starting: Boolean(starting) || (running && !ready),
    runtimeId: runtime?.runtimeId || "",
    state,
    serviceState,
    port: DEFAULT_PORT,
    serverUrl: ready ? `http://127.0.0.1:${DEFAULT_PORT}/` : "",
    dataRoot: dataRoot(),
  };
}

export async function ensureServer(ctx, log = () => {}) {
  if (typeof ctx?.runtime?.start !== "function") {
    throw new Error("当前 Hana 不支持受管本机运行时，请升级 Hana。");
  }
  if (stopping) await stopping;
  if (starting) return starting;

  const operation = (async () => {
    if (runtime?.runtimeId) {
      const status = await runtimeStatus(ctx);
      if (status.running) return status;
      runtime = null;
    }

    const config = runtimeConfig();
    let startAccepted = false;
    try {
      const result = await ctx.runtime.start({
        runtime: "node",
        entry: LAUNCHER_ENTRY,
        profile: "local-machine",
        network: "external",
        // 同上：工具执行期间宿主会无条件注入 callToken，local-machine 拒绝它，
        // 不显式声明 scope: "app" 就起不来。
        scope: "app",
        args: ["--st-dir", config.stDir, "--data-root", config.dataRoot, "--port", String(DEFAULT_PORT), "--npm-cache", join(ctx.dataDir || config.stDir, 'runtime-deps', 'npm-cache')],
        service: { port: DEFAULT_PORT, readyMarker: "HANABREW_V2_ST_READY" },
      });
      // runtimeId is on the returned record; `runtime` is usually the string "node".
      runtime = result && typeof result.runtime === "object" ? result.runtime : result;
      if (!runtime?.runtimeId) throw new Error("受管酒馆运行时已启动，但没有拿到 runtimeId。");
      startAccepted = true;
      const status = await runtimeStatus(ctx);
      log("info", status.ready ? `受管 SillyTavern 已就绪：${status.serverUrl}` : "受管 SillyTavern 正在启动。");
      return status;
    } catch (error) {
      if (!startAccepted) runtime = null;
      throw error;
    }
  })();

  starting = operation;
  try {
    return await operation;
  } finally {
    if (starting === operation) starting = null;
  }
}

export async function stopServer(ctx, log = () => {}) {
  if (stopping) return stopping;
  const operation = (async () => {
    if (starting) {
      try { await starting; } catch { return { stopped: false }; }
    }
    const current = runtime;
    if (!current?.runtimeId || typeof ctx?.runtime?.stop !== "function") {
      return { stopped: false };
    }
    await ctx.runtime.stop(current.runtimeId);
    if (runtime?.runtimeId === current.runtimeId) runtime = null;
    log("info", "受管 SillyTavern 已停止。");
    return { stopped: true };
  })();

  stopping = operation;
  try {
    return await operation;
  } finally {
    if (stopping === operation) stopping = null;
  }
}
