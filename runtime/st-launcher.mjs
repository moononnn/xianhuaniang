import { spawn } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureEngineDependencies } from "./engine-ensure-deps.mjs";
import { createStProxyServer } from "./st-proxy.mjs";

function value(name, fallback = "") {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? String(process.argv[index + 1] || fallback) : fallback;
}

function pathKey(path) {
  const normalized = resolve(path);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

export function isDirectRun(entryPath = process.argv[1], modulePath = fileURLToPath(import.meta.url)) {
  if (!entryPath) return false;
  try {
    return pathKey(realpathSync.native(entryPath)) === pathKey(realpathSync.native(modulePath));
  } catch {
    return false;
  }
}

export function resolveBundledEngineDir(requestedPath) {
  const launcherPath = realpathSync.native(fileURLToPath(import.meta.url));
  const appRoot = realpathSync.native(resolve(dirname(launcherPath), ".."));
  const expectedPath = resolve(appRoot, "vendor", "sillytavern");
  const expectedRealPath = realpathSync.native(expectedPath);
  if (pathKey(expectedRealPath) !== pathKey(expectedPath)) {
    throw new Error("The bundled engine directory must be a real App-owned directory, not a link.");
  }

  const requestedRealPath = realpathSync.native(resolve(requestedPath));
  if (pathKey(requestedRealPath) !== pathKey(expectedRealPath)) {
    throw new Error("Refusing to launch an engine outside this App's vendor directory.");
  }
  return expectedRealPath;
}

/**
 * A marker file in dataRoot enables compact proxy diagnostics without changing the engine.
 * The marker is read by the managed launcher, never created automatically.
 */
export function proxyLogEnabledByMarker(dataRoot) {
  if (!existsSync(join(dataRoot, "_proxy-log"))) return false;
  process.env.HANABREW_PROXY_LOG = "1";
  return true;
}

async function reportStartupFailure(error, marker = "HANABREW_V2_ST_FAILED") {
  await new Promise((resolveWrite) => process.stderr.write(`SillyTavern launcher failed: ${error?.message || error}\n`, resolveWrite));
  await new Promise((resolveWrite) => process.stdout.write(`${marker}\n`, resolveWrite));
  process.exitCode = 1;
}

async function runLauncher() {
  const requestedStDir = value("st-dir");
  const dataRoot = value("data-root");
  const servicePort = Number(value("port", "18511"));
  const upstreamPort = Number(value("upstream-port", String(servicePort + 1)));

  if (!requestedStDir || !dataRoot) {
    console.error("v2 ST launcher 缺少 st-dir 或 data-root。");
    process.exitCode = 2;
    return;
  }
  if (!Number.isInteger(servicePort) || !Number.isInteger(upstreamPort)
    || servicePort < 1 || upstreamPort < 1 || servicePort > 65535
    || upstreamPort > 65535 || servicePort === upstreamPort) {
    console.error("v2 ST launcher 的代理端口或酒馆端口无效。");
    process.exitCode = 2;
    return;
  }

  const stDir = resolveBundledEngineDir(requestedStDir);
  if (proxyLogEnabledByMarker(dataRoot)) {
    console.log("HANABREW_PROXY_LOG=1（发现 _proxy-log 标记文件）");
  }

  try {
    await ensureEngineDependencies(stDir, {
      cacheDir: value('npm-cache', join(stDir, '.npm-cache')),
      onStatus: (state) => process.stdout.write(`HANABREW_V2_ST_DEPS_${state}\n`),
      onOutput: (stream, chunk) => process[stream === "stderr" ? "stderr" : "stdout"].write(chunk),
    });
  } catch (error) {
    await reportStartupFailure(error, "HANABREW_V2_ST_DEPS_FAILED");
    return;
  }

  const proxy = createStProxyServer({ upstreamPort, skinStatePath: join(dataRoot, "_hana-skin.json") });
  await new Promise((resolveListen, reject) => {
    const onError = (error) => reject(error);
    proxy.once("error", onError);
    proxy.listen(servicePort, "127.0.0.1", () => {
      proxy.off("error", onError);
      resolveListen();
    });
  });

  const child = spawn(process.execPath, [
    "server.js",
    "--port", String(upstreamPort),
    "--listen", "false",
    "--disableCsrf", "true",
    "--whitelist", "false",
    "--dataRoot", dataRoot,
    "--browserLaunchEnabled", "false",
  ], {
    cwd: stDir,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });

  let ready = false;
  let probe = "";
  let stopping = false;
  const forward = (chunk, error = false) => {
    const text = String(chunk);
    (error ? process.stderr : process.stdout).write(text);
    if (ready) return;
    probe = (probe + text.replace(/\u001b\[[0-9;]*m/gu, "")).slice(-512);
    if (/Go to:\s*https?:\/\/[^\s]+\//u.test(probe)) {
      ready = true;
      process.stdout.write("HANABREW_V2_ST_READY\n");
    }
  };

  const closeProxy = (exitCode) => {
    proxy.closeConnections();
    if (proxy.listening) proxy.close(() => process.exit(exitCode));
    else process.exit(exitCode);
  };

  child.stdout.on("data", (chunk) => forward(chunk));
  child.stderr.on("data", (chunk) => forward(chunk, true));
  child.once("error", (error) => {
    console.error("v2 ST child failed to start:", error.message);
    closeProxy(1);
  });
  child.once("exit", (code, signal) => {
    closeProxy(typeof code === "number" ? code : (signal ? 1 : 0));
  });

  const stop = () => {
    if (stopping) return;
    stopping = true;
    proxy.closeConnections();
    if (proxy.listening) proxy.close();
    try { child.kill("SIGTERM"); } catch {}
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
}

if (isDirectRun()) {
  runLauncher().catch((error) => reportStartupFailure(error));
}
