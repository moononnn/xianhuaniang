// 鲜花酿 v2 · 测卡成绩单
//
// 跑完一次测卡后 theater-tasks.json 会被清掉（那是「待办账」，不是档案），
// 逐幕明细只剩酒馆那边的聊天备份，想复盘得靠人肉去捞。这里补一份只读成绩单：
// 跑完落一份 JSON，之后随时能回查「那次到底跑了什么、变量怎么变、报了哪些问题」。
//
// 与变量账本（backend/mvu.js）的分工：
//   账本   只存初始/最终值，供模型快速回查「这次读到变量没有」；
//   成绩单 存全过程：逐幕台词、角色回复、变量前后、体检结论。
// 两者都按会话归属过滤：没有归属就不给读，也不给写。

import fs from "node:fs";
import path from "node:path";

const REPORT_DIR = "theater-reports";
const REPORT_LIMIT = 50;
const REPORT_VERSION = 1;

function reportDir(dataDir) {
  return path.join(dataDir, REPORT_DIR);
}

/** 编号来自工具输入，不能让它决定路径。 */
function safeRunId(runId) {
  const raw = String(runId ?? "").trim();
  if (!/^[A-Za-z0-9_-]{1,120}$/.test(raw)) {
    throw new Error("测卡编号格式不合法，未读写成绩单。");
  }
  return raw;
}

function reportFile(dataDir, runId) {
  return path.join(reportDir(dataDir), `${safeRunId(runId)}.json`);
}

/** 路径比对口径与 theater-service 一致：C 盘入口与 D 盘真实目录可能是同一处（junction）。 */
function pathKey(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  try {
    return fs.realpathSync.native(raw).toLowerCase();
  } catch {
    try {
      return path.resolve(raw).toLowerCase();
    } catch {
      return raw.toLowerCase();
    }
  }
}

/**
 * 归属判定：与 theater-service 的 ownedBy 同一套语义 ——
 * 两边都有的标识必须逐字一致（冲突就拒），且至少有一个标识真的对得上；
 * 只有 agentId 不算归属凭据（同一个伙伴的多个会话共享它）。
 */
function ownedBy(entry, scope = {}) {
  if (!entry) return false;
  const runScope = entry.scope || {};
  if (scope.sessionId && runScope.sessionId && scope.sessionId !== runScope.sessionId) return false;
  if (scope.sessionPath && runScope.sessionPath && pathKey(scope.sessionPath) !== pathKey(runScope.sessionPath)) return false;
  if (scope.agentId && runScope.agentId && scope.agentId !== runScope.agentId) return false;
  const idMatch = Boolean(scope.sessionId && runScope.sessionId && scope.sessionId === runScope.sessionId);
  const pathMatch = Boolean(scope.sessionPath && runScope.sessionPath && pathKey(scope.sessionPath) === pathKey(runScope.sessionPath));
  return idMatch || pathMatch;
}

/** 只留成绩单自己的字段，避免把 scope 里的令牌之类顺手写进文件。 */
function normalizeReport(report = {}) {
  const scope = report.scope || {};
  return {
    reportVersion: REPORT_VERSION,
    runId: safeRunId(report.runId),
    mode: report.mode === "duet" ? "duet" : "scripted",
    status: String(report.status || "done").slice(0, 20),
    characterId: String(report.characterId || "").slice(0, 200),
    characterName: String(report.characterName || "").slice(0, 80),
    testType: String(report.testType || "").slice(0, 40),
    objective: String(report.objective || "").slice(0, 4000),
    chatFile: String(report.chatFile || "").slice(0, 200),
    startedAt: report.startedAt || null,
    finishedAt: report.finishedAt || new Date().toISOString(),
    durationMs: Number.isFinite(report.durationMs) ? report.durationMs : null,
    opening: String(report.opening || ""),
    scenes: Array.isArray(report.scenes) ? report.scenes : [],
    initialVariables: report.initialVariables ?? null,
    finalVariables: report.finalVariables ?? null,
    initialVariableSource: String(report.initialVariableSource || "unavailable"),
    finalVariableSource: String(report.finalVariableSource || "unavailable"),
    mvuAvailable: report.mvuAvailable === true,
    warnings: Array.isArray(report.warnings) ? report.warnings.map((item) => String(item)) : [],
    notes: Array.isArray(report.notes) ? report.notes.map((item) => String(item)) : [],
    error: report.error ? String(report.error).slice(0, 500) : null,
    scope: {
      sessionId: String(scope.sessionId || "").slice(0, 200),
      sessionPath: String(scope.sessionPath || "").slice(0, 400),
      agentId: String(scope.agentId || "").slice(0, 120),
    },
  };
}

function readAll(dataDir) {
  let names = [];
  try {
    names = fs.readdirSync(reportDir(dataDir));
  } catch {
    return [];
  }
  const reports = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(reportDir(dataDir), name), "utf8"));
      if (parsed && typeof parsed === "object" && parsed.runId) reports.push(parsed);
    } catch {
      // 单份坏文件不该让整本历史读不出来。
    }
  }
  return reports.sort((left, right) => String(right.finishedAt || "").localeCompare(String(left.finishedAt || "")));
}

/**
 * 写一份成绩单。可被读取才算写成功：写完立刻回读校验，
 * 免得磁盘写一半留下一个永远读不出来的文件。
 */
export function writeTheaterReport(dataDir, report) {
  if (!dataDir) throw new Error("没有应用数据目录，成绩单无处可写。");
  const entry = normalizeReport(report);
  fs.mkdirSync(reportDir(dataDir), { recursive: true });
  const file = reportFile(dataDir, entry.runId);
  const temp = `${file}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(entry, null, 2), "utf8");
  fs.renameSync(temp, file);
  pruneReports(dataDir);
  return entry;
}

export function readTheaterReport(dataDir, runId, scope) {
  if (!dataDir || !runId || !scope) return null;
  let entry;
  try {
    entry = JSON.parse(fs.readFileSync(reportFile(dataDir, runId), "utf8"));
  } catch {
    return null;
  }
  return ownedBy(entry, scope) ? entry : null;
}

export function listTheaterReports(dataDir, limit = 20, scope) {
  if (!dataDir || !scope || (!scope.sessionId && !scope.sessionPath)) return [];
  const size = Math.max(1, Math.min(REPORT_LIMIT, Number(limit) || 20));
  return readAll(dataDir)
    .filter((entry) => ownedBy(entry, scope))
    .slice(0, size);
}

/**
 * 看板专用：不按会话归属，只取最近一份成绩单。
 * 只有「取出形态」的卡片会走这里：那种形态拿不到归属，提交不了，但过程还能回看。
 * 只读、不提供写入或提交入口，也不枚举其他会话。
 */
export function readLatestReport(dataDir) {
  if (!dataDir) return null;
  return readAll(dataDir)[0] || null;
}

/** 只留最近 REPORT_LIMIT 份；超出的按完成时间从旧到新删。 */
export function pruneReports(dataDir, limit = REPORT_LIMIT) {
  const all = readAll(dataDir);
  const extra = all.slice(limit);
  for (const entry of extra) {
    try {
      fs.rmSync(reportFile(dataDir, entry.runId), { force: true });
    } catch {
      // 删不掉就留着，不影响新的成绩单。
    }
  }
  return extra.length;
}

export const theaterReportDefaults = { dir: REPORT_DIR, limit: REPORT_LIMIT, version: REPORT_VERSION };
