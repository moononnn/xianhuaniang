// launcher 的诊断开关：dataRoot 里有 _proxy-log 标记文件时打开探针。
// launcher 顶层就 spawn 子进程，测试里直接起一个真的 launcher 不现实（会拉起整个酒馆），
// 所以把「读标记 → 设环境变量」这段抽成可测的函数，launcher 顶层调用它。
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { proxyLogEnabledByMarker } from "../runtime/st-launcher.mjs";

test("没有标记文件时不开探针，也不碰环境变量", () => {
  const dataRoot = mkdtempSync(join(tmpdir(), "hanabrew-marker-"));
  const before = process.env.HANABREW_PROXY_LOG;
  delete process.env.HANABREW_PROXY_LOG;

  const enabled = proxyLogEnabledByMarker(dataRoot);

  assert.equal(enabled, false);
  assert.equal(process.env.HANABREW_PROXY_LOG, before);
  assert.equal(existsSync(join(dataRoot, "_proxy-log")), false, "只读不写：没有标记就不该凭空造一个");
});

test("放了标记文件就开探针", () => {
  const dataRoot = mkdtempSync(join(tmpdir(), "hanabrew-marker-"));
  writeFileSync(join(dataRoot, "_proxy-log"), "", "utf8");

  const enabled = proxyLogEnabledByMarker(dataRoot);

  assert.equal(enabled, true);
  assert.equal(process.env.HANABREW_PROXY_LOG, "1");
});
