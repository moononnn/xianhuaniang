import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  listTheaterReports,
  pruneReports,
  readTheaterReport,
  writeTheaterReport,
} from "../backend/theater-reports.js";

const appDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function tempDir() {
  return fs.mkdtempSync(path.join(path.dirname(appDir), ".theater-reports-"));
}

function cleanupDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 60 });
}

function report(runId, scope, extra = {}) {
  return {
    runId,
    mode: "scripted",
    status: "done",
    characterId: "示例角色.png",
    characterName: "示例角色",
    testType: "mvu",
    objective: "运行时变量",
    scenes: [{ index: 1, user: "在吗", reply: "在。" }],
    warnings: [],
    notes: [],
    scope,
    ...extra,
  };
}

test("成绩单写完能读回，逐幕内容与体检结论都在", () => {
  const dir = tempDir();
  const scope = { sessionId: "s1", sessionPath: "C:/a.jsonl" };
  try {
    writeTheaterReport(dir, report("theater-1-aaaa", scope, {
      warnings: ["第 1 幕写进去的变量没有出现在下一幕的起始值里"],
      notes: ["开局时酒馆还没建立变量"],
      finishedAt: "2026-10-11T00:10:00.000Z",
    }));
    const stored = readTheaterReport(dir, "theater-1-aaaa", scope);
    assert.equal(stored.runId, "theater-1-aaaa");
    assert.equal(stored.scenes.length, 1);
    assert.equal(stored.scenes[0].reply, "在。");
    assert.equal(stored.warnings.length, 1);
    assert.equal(stored.notes.length, 1);
    assert.equal(stored.reportVersion, 1);
  } finally { cleanupDir(dir); }
});

test("令牌之类不进成绩单：只留会话标识", () => {
  const dir = tempDir();
  const scope = { sessionId: "s1", sessionPath: "C:/a.jsonl", agentId: "", callToken: "secret-token" };
  try {
    writeTheaterReport(dir, report("theater-2-bbbb", scope));
    const raw = fs.readFileSync(path.join(dir, "theater-reports", "theater-2-bbbb.json"), "utf8");
    assert.equal(raw.includes("secret-token"), false, "成绩单里不该出现会话令牌");
    assert.equal(JSON.parse(raw).scope.sessionId, "s1");
  } finally { cleanupDir(dir); }
});

test("别的会话读不到、也列不出来", () => {
  const dir = tempDir();
  try {
    writeTheaterReport(dir, report("theater-3-cccc", { sessionId: "s1", sessionPath: "C:/a.jsonl" }));
    assert.equal(readTheaterReport(dir, "theater-3-cccc", { sessionId: "s2", sessionPath: "C:/b.jsonl" }), null);
    assert.deepEqual(listTheaterReports(dir, 10, { sessionId: "s2", sessionPath: "C:/b.jsonl" }), []);
    // 只有 agentId 不算归属凭据，不给读。
    assert.equal(readTheaterReport(dir, "theater-3-cccc", { agentId: "hanako" }), null);
  } finally { cleanupDir(dir); }
});

test("列表按完成时间倒序，只给当前会话的", () => {
  const dir = tempDir();
  const scope = { sessionId: "s1", sessionPath: "C:/a.jsonl" };
  try {
    writeTheaterReport(dir, report("theater-4-older", scope, { finishedAt: "2026-10-11T00:00:00.000Z" }));
    writeTheaterReport(dir, report("theater-4-newer", scope, { finishedAt: "2026-10-11T02:00:00.000Z" }));
    writeTheaterReport(dir, report("theater-4-other", { sessionId: "s9", sessionPath: "C:/z.jsonl" }, { finishedAt: "2026-10-11T03:00:00.000Z" }));
    const listed = listTheaterReports(dir, 10, scope);
    assert.deepEqual(listed.map((entry) => entry.runId), ["theater-4-newer", "theater-4-older"]);
  } finally { cleanupDir(dir); }
});

test("超过上限时删最旧的，保留最近几份", () => {
  const dir = tempDir();
  const scope = { sessionId: "s1", sessionPath: "C:/a.jsonl" };
  try {
    writeTheaterReport(dir, report("theater-5-a", scope, { finishedAt: "2026-10-11T00:00:00.000Z" }));
    writeTheaterReport(dir, report("theater-5-b", scope, { finishedAt: "2026-10-11T01:00:00.000Z" }));
    writeTheaterReport(dir, report("theater-5-c", scope, { finishedAt: "2026-10-11T02:00:00.000Z" }));
    assert.equal(pruneReports(dir, 2), 1);
    assert.equal(readTheaterReport(dir, "theater-5-a", scope), null);
    assert.deepEqual(listTheaterReports(dir, 10, scope).map((entry) => entry.runId), ["theater-5-c", "theater-5-b"]);
  } finally { cleanupDir(dir); }
});

test("编号不合法直接拒，别让它决定路径", () => {
  const dir = tempDir();
  try {
    assert.throws(() => writeTheaterReport(dir, report("../../evil", { sessionId: "s1" })), /编号格式不合法/);
    assert.equal(readTheaterReport(dir, "../../evil", { sessionId: "s1" }), null);
  } finally { cleanupDir(dir); }
});
