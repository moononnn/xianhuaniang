import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const ENGINE_INSTALL_TIMEOUT_MS = 10 * 60 * 1000;
const INSTALL_MARKER = ".hanabrew-lock-sha256";

function stopProcessTree(child) {
  if (process.platform === "win32" && child.pid) {
    const killer = spawn("taskkill.exe", ["/pid", String(child.pid), "/t", "/f"], {
      windowsHide: true,
      stdio: "ignore",
    });
    killer.once("error", () => { try { child.kill("SIGTERM"); } catch {} });
    killer.unref?.();
    return;
  }
  try { child.kill("SIGTERM"); } catch {}
}

export function runCommand(command, args, {
  cwd,
  timeoutMs = ENGINE_INSTALL_TIMEOUT_MS,
  shell = false,
  env = process.env,
  onOutput = () => {},
} = {}) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return Promise.reject(new TypeError("timeoutMs must be a positive finite number"));
  }

  return new Promise((resolve, reject) => {
    let child;
    let timedOut = false;
    let settled = false;
    let timer;
    const finish = (error = null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve();
    };

    try {
      child = spawn(command, args, {
        cwd,
        shell,
        env,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      finish(new Error(`Unable to start dependency installer: ${error.message}`));
      return;
    }

    child.stdout?.on("data", (chunk) => onOutput("stdout", chunk));
    child.stderr?.on("data", (chunk) => onOutput("stderr", chunk));
    child.once("error", (error) => finish(new Error(`Unable to start dependency installer: ${error.message}`)));
    child.once("close", (code, signal) => {
      if (timedOut) {
        finish(new Error(`npm ci timed out after ${timeoutMs} ms.`));
      } else if (code !== 0) {
        const detail = signal ? `, signal ${signal}` : "";
        finish(new Error(`npm ci failed (exit ${code ?? "unknown"}${detail}).`));
      } else {
        finish();
      }
    });

    timer = setTimeout(() => {
      timedOut = true;
      stopProcessTree(child);
      finish(new Error(`npm ci timed out after ${timeoutMs} ms.`));
    }, timeoutMs);
  });
}

export async function ensureEngineDependencies(engineDir, {
  timeoutMs = ENGINE_INSTALL_TIMEOUT_MS,
  cacheDir = join(engineDir, '.npm-cache'),
  onStatus = () => {},
  onOutput = () => {},
} = {}) {
  const packagePath = join(engineDir, "package.json");
  const lockPath = join(engineDir, "package-lock.json");
  if (!existsSync(packagePath) || !existsSync(lockPath)) {
    throw new Error("The bundled engine is missing package.json or package-lock.json.");
  }

  const lockHash = createHash("sha256").update(readFileSync(lockPath)).digest("hex");
  const modulesDir = join(engineDir, "node_modules");
  const markerPath = join(modulesDir, INSTALL_MARKER);
  if (existsSync(modulesDir) && lstatSync(modulesDir).isSymbolicLink()) {
    throw new Error("Refusing to install engine dependencies through a node_modules link.");
  }

  if (existsSync(join(modulesDir, ".package-lock.json"))
    && existsSync(markerPath)
    && readFileSync(markerPath, "utf8").trim() === lockHash) {
    onStatus("READY");
    return { skipped: true, lockHash };
  }

  onStatus("INSTALLING");
  const windows = process.platform === "win32";
  await runCommand(windows ? "npm.cmd" : "npm", ["ci", "--no-audit", "--no-fund"], {
    cwd: engineDir,
    timeoutMs,
    shell: windows,
    env: { ...process.env, npm_config_cache: cacheDir, NPM_CONFIG_CACHE: cacheDir },
    onOutput,
  });

  if (!existsSync(join(modulesDir, ".package-lock.json"))) {
    throw new Error("npm ci exited successfully but did not create node_modules/.package-lock.json.");
  }
  writeFileSync(markerPath, `${lockHash}\n`, "utf8");
  onStatus("READY");
  return { skipped: false, lockHash };
}
