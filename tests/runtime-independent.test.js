import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  rmdirSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { ensureServer, npmCacheDir, runtimeConfig, runtimeStatus, stopServer } from "../backend/st-runtime.js";
import { isDirectRun, resolveBundledEngineDir } from "../runtime/st-launcher.mjs";
import { ensureEngineDependencies, runCommand } from "../runtime/engine-ensure-deps.mjs";

const appRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const engineDir = join(appRoot, "vendor", "sillytavern");

function readyRecord(runtimeId, state = "ready") {
  return { runtimeId, state, runtime: "node", service: { state } };
}

test("npm 缓存目录：走宿主 dataDir，拿不到时也不写进安装目录", () => {
  const stDir = join(engineDir, "vendor", "sillytavern");
  assert.equal(npmCacheDir("D:/plugin-data/xianhuaniang", stDir), join("D:/plugin-data/xianhuaniang", "runtime-deps", "npm-cache"));
  // 退化分支：ctx.dataDir 缺失时原来会落进 vendor/sillytavern，安装目录可能只读、
  // 也会随卸载升级被换掉，缓存被清就等于每次启动重装一遍依赖。
  const fallback = npmCacheDir("", stDir);
  assert.ok(!fallback.startsWith(engineDir), "缓存不能落进安装目录：" + fallback);
  assert.match(fallback, /xianhuaniang[\\/]npm-cache$/);
});

test("runtimeConfig resolves the App-owned real vendor engine and preserves the v2 data root", () => {
  const config = runtimeConfig();
  assert.equal(config.stDir, realpathSync.native(engineDir));
  assert.equal(existsSync(join(config.stDir, "server.js")), true);
  assert.equal(existsSync(join(config.stDir, "package-lock.json")), true);
  for (const name of ['JS-Slash-Runner', 'ST-Prompt-Template']) {
    assert.equal(existsSync(join(config.stDir, 'public', 'scripts', 'extensions', 'third-party', name, 'manifest.json')), true);
  }
  assert.match(config.dataRoot, /xianhuaniang[\\/]st-data$/i);
});

test("direct-run guard resolves a Windows directory junction and reports CLI errors", (t) => {
  const aliasRoot = mkdtempSync(join(tmpdir(), "hanabrew-runtime-link-"));
  const alias = join(aliasRoot, "runtime-link");
  try {
    symlinkSync(join(appRoot, "runtime"), alias, process.platform === "win32" ? "junction" : "dir");
  } catch (error) {
    rmSync(aliasRoot, { recursive: true, force: true });
    throw new Error(`Unable to create the runtime path alias used by this test: ${error.message}`);
  }
  t.after(() => {
    rmdirSync(alias);
    rmdirSync(aliasRoot);
  });

  const entry = join(alias, "st-launcher.mjs");
  assert.equal(isDirectRun(entry), true);
  const result = spawnSync(process.execPath, [entry], { encoding: "utf8", timeout: 10_000 });
  assert.equal(result.status, 2);
  assert.match(`${result.stdout}${result.stderr}`, /缺少 st-dir 或 data-root/u);
});

test("launcher rejects any engine path outside its own vendor directory", (t) => {
  const other = mkdtempSync(join(tmpdir(), "hanabrew-unbundled-engine-"));
  t.after(() => rmSync(other, { recursive: true, force: true }));
  assert.throws(() => resolveBundledEngineDir(other), /outside this App's vendor directory/u);
});

test("concurrent starts share one managed runtime start and refresh its public record", async () => {
  let releaseStart;
  let starts = 0;
  let gets = 0;
  let stops = 0;
  let startOptions;
  const ctx = {
    runtime: {
      start(options) {
        starts += 1;
        startOptions = options;
        return new Promise((resolve) => { releaseStart = resolve; });
      },
      async get(id) {
        gets += 1;
        assert.equal(id, "rt-independent-start");
        return readyRecord(id);
      },
      async stop(id) {
        stops += 1;
        assert.equal(id, "rt-independent-start");
      },
    },
  };

  const first = ensureServer(ctx, () => {});
  const second = ensureServer(ctx, () => {});
  assert.equal(starts, 1);
  releaseStart(readyRecord("rt-independent-start", "starting"));
  const [left, right] = await Promise.all([first, second]);
  assert.equal(left.ready, true);
  assert.equal(right.runtimeId, left.runtimeId);
  assert.equal(gets, 1);
  assert.equal(startOptions.runtime, "node");
  assert.equal(startOptions.profile, "local-machine");
  assert.equal(startOptions.network, "external");
  assert.equal(startOptions.service.readyMarker, "HANABREW_V2_ST_READY");
  assert.equal(startOptions.args[startOptions.args.indexOf("--st-dir") + 1], runtimeConfig().stDir);
  assert.deepEqual(await stopServer(ctx, () => {}), { stopped: true });
  assert.equal(stops, 1);
  assert.equal((await runtimeStatus(ctx)).runtimeId, "");
});

test("stop waits for an in-flight start; a failed stop retains the runtime for retry", async () => {
  let releaseStart;
  let stopAttempts = 0;
  const ctx = {
    runtime: {
      start() { return new Promise((resolve) => { releaseStart = resolve; }); },
      async get(id) { return readyRecord(id); },
      async stop() {
        stopAttempts += 1;
        if (stopAttempts === 1) throw new Error("managed stop failed");
      },
    },
  };

  const starting = ensureServer(ctx, () => {});
  const stopping = stopServer(ctx, () => {});
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(stopAttempts, 0);
  releaseStart(readyRecord("rt-independent-stop", "starting"));
  await starting;
  await assert.rejects(stopping, /managed stop failed/u);
  assert.equal((await runtimeStatus(ctx)).runtimeId, "rt-independent-stop");
  assert.deepEqual(await stopServer(ctx, () => {}), { stopped: true });
  assert.equal(stopAttempts, 2);
});

test("failed start clears the in-flight state so a later start can retry", async () => {
  let attempts = 0;
  const ctx = {
    runtime: {
      async start() {
        attempts += 1;
        if (attempts === 1) throw new Error("managed start failed");
        return readyRecord("rt-independent-retry");
      },
      async get(id) { return readyRecord(id); },
      async stop() {},
    },
  };
  await assert.rejects(ensureServer(ctx, () => {}), /managed start failed/u);
  assert.equal((await ensureServer(ctx, () => {})).ready, true);
  assert.equal(attempts, 2);
  await stopServer(ctx, () => {});
});

test("a missing host runtime record clears the stale ready state and permits restart", async () => {
  let starts = 0;
  let removed = false;
  const ctx = { runtime: {
    async start() { starts += 1; removed = false; return readyRecord(`rt-missing-${starts}`); },
    async get(id) { return removed ? null : readyRecord(id); },
    async stop() {},
  } };
  await ensureServer(ctx);
  removed = true;
  assert.equal((await runtimeStatus(ctx)).running, false);
  await ensureServer(ctx);
  assert.equal(starts, 2);
  await stopServer(ctx);
});

test("dependency installer skips only a matching lock marker", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "hanabrew-deps-skip-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const lock = JSON.stringify({ lockfileVersion: 3, packages: {} });
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "test-engine" }));
  writeFileSync(join(root, "package-lock.json"), lock);
  const modules = join(root, "node_modules");
  mkdirSync(modules);
  writeFileSync(join(modules, ".package-lock.json"), "{}");
  const digest = createHash("sha256").update(readFileSync(join(root, "package-lock.json"))).digest("hex");
  writeFileSync(join(modules, ".hanabrew-lock-sha256"), digest);

  const result = await ensureEngineDependencies(root);
  assert.equal(result.skipped, true);
});

test("dependency command runner reports nonzero exit and timeout", async () => {
  await assert.rejects(
    runCommand(process.execPath, ["-e", "process.exit(9)"], { cwd: tmpdir(), timeoutMs: 5000 }),
    /exit 9/u,
  );
  await assert.rejects(
    runCommand(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { cwd: tmpdir(), timeoutMs: 100 }),
    /timed out/u,
  );
});

