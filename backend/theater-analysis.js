// 鲜花酿 v2 · 测卡结果体检
//
// runner 采回来的逐幕数据很容易「看起来跑通」：回复正常，变量也读到了值。
// 但账本里仍可能藏着几类脏数据，最典型的是某一幕写进去的变更没有继承到下一幕
// （画面往前走，账本往回退），以及时间字段被改回过去。
//
// 这里只做纯逻辑判断：不连浏览器、不读文件、不碰酒馆，方便直接跑单测。
//
// 判定原则：
//   - 能确定的问题进 warnings；
//   - 只能说明情况的进 notes（例如「开局基准还没建立」，它不是故障）；
//   - 解析不出来（这张卡没按 MVU 格式回 patch）就跳过，不把「读不懂」报成「有问题」。

import { applyJsonPatch, extractJsonPatch } from "./mvu.js";

// 卡里常见格式：2026/08/27-21:30，也容忍 2026-08-27 21:30 / 2026/08/27T21:30。
const TIME_PATTERN = /^(\d{4})[/-](\d{1,2})[/-](\d{1,2})[-\sT]+(\d{1,2}):(\d{2})$/;

/** 把 stat_data 里的时间字符串解成可比较的时刻；不是时间就返回 null。 */
export function parseTimeValue(value) {
  const match = TIME_PATTERN.exec(String(value ?? "").trim());
  if (!match) return null;
  const [, year, month, day, hour, minute] = match;
  const ms = Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute));
  return Number.isFinite(ms) ? ms : null;
}

/** 扁平化成「世界.当前时间」→ 值。只展到叶子，数组与 null 都当叶子值处理。 */
export function flattenVariables(statData, prefix = "", out = {}) {
  if (!statData || typeof statData !== "object" || Array.isArray(statData)) return out;
  for (const [key, value] of Object.entries(statData)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === "object" && !Array.isArray(value)) flattenVariables(value, path, out);
    else out[path] = value;
  }
  return out;
}

function shortValue(value) {
  if (value === null || value === undefined) return "空";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

/**
 * 这一幕回复里声明的变量结果：把回复里的 patch 叠在本幕起始值上。
 * 抽不到 patch 就返回 null（= 无从判断），不是「没有变化」。
 */
export function declaredVariables(scene) {
  const patches = extractJsonPatch(scene?.reply);
  if (!patches.length) return null;
  const before = scene?.variablesBefore && typeof scene.variablesBefore === "object" ? scene.variablesBefore : {};
  try {
    return applyJsonPatch(before, patches);
  } catch {
    return null;
  }
}

function sameValue(left, right) {
  if (left === right) return true;
  if (left === null || left === undefined || right === null || right === undefined) return false;
  if (typeof left === "object" || typeof right === "object") return JSON.stringify(left) === JSON.stringify(right);
  return String(left) === String(right);
}

/**
 * 逐幕体检。
 *
 * 返回 { warnings, notes }：
 *   warnings 是确定的问题（变更没被继承、时间倒流、全程读不到变量）；
 *   notes 是「不算故障但必须说清楚」的情况（开局基准还没建立之类）。
 */
export function analyzeTheaterRun({
  scenes,
  initialVariables = null,
  finalVariables = null,
  initialVariableSource = "unavailable",
  finalVariableSource = "unavailable",
  mvuAvailable = null,
} = {}) {
  const list = Array.isArray(scenes) ? scenes : [];
  const warnings = [];
  const notes = [];

  if (finalVariables === null || finalVariables === undefined) {
    if (finalVariableSource === "unavailable" && initialVariableSource === "unavailable") {
      warnings.push("这次全程没有读到变量：酒馆一次都没回传 stat_data，变量变化无法核对（可能是助手脚本没启用，或这张卡没有变量协议）。");
    } else {
      warnings.push("测卡结束时没有读到变量，最后一幕的变量变化无法确认。");
    }
    return { warnings, notes };
  }

  if (initialVariables === null || initialVariables === undefined) {
    notes.push("开局时酒馆还没建立变量（第一幕是在没有基准值的情况下生成的）。最终值可信，但起点值缺失，别把这次的最终值当成「从初始值涨上来的结果」。");
  }

  if (mvuAvailable !== true) {
    notes.push("整个过程没有检测到 MVU 运行环境，读到的变量来自楼层静态数据。");
  }

  // 1) 逐幕核对：这一幕声明的变更，有没有被下一幕的起始值继承。
  //    最后一幕拿测卡结束时的最终值收口。
  for (let index = 0; index < list.length; index += 1) {
    const scene = list[index] || {};
    const declared = declaredVariables(scene);
    if (!declared) continue;
    const next = index + 1 < list.length
      ? list[index + 1]?.variablesBefore
      : finalVariables;
    if (!next || typeof next !== "object") continue;
    const declaredFlat = flattenVariables(declared);
    const nextFlat = flattenVariables(next);
    const lost = [];
    for (const [path, value] of Object.entries(declaredFlat)) {
      if (!Object.hasOwn(nextFlat, path)) {
        lost.push(`${path}（声明 ${shortValue(value)}，下一幕读不到）`);
      } else if (!sameValue(value, nextFlat[path])) {
        lost.push(`${path}（声明 ${shortValue(value)}，实际读到 ${shortValue(nextFlat[path])}）`);
      }
    }
    if (lost.length) {
      warnings.push(`第 ${scene.index ?? index + 1} 幕写进去的变量没有出现在下一幕的起始值里：${lost.join("、")}。这一幕的变更可能被覆盖了，账本要以后面的实测值为准。`);
    }
  }

  // 2) 时间字段不能倒退：同一路径按幕序排，后一幕比前一幕早就是脏数据。
  const timeline = [];
  list.forEach((scene, index) => {
    const source = declaredVariables(scene) || scene?.variablesAfter;
    const flat = flattenVariables(source);
    for (const [path, value] of Object.entries(flat)) {
      const ms = parseTimeValue(value);
      if (ms === null) continue;
      timeline.push({ index: scene?.index ?? index + 1, path, raw: String(value), ms });
    }
  });
  for (let i = 1; i < timeline.length; i += 1) {
    const previous = timeline[i - 1];
    const current = timeline[i];
    if (current.path !== previous.path || current.ms >= previous.ms) continue;
    warnings.push(`时间倒流：第 ${current.index} 幕把 ${current.path} 从 ${previous.raw} 改回了 ${current.raw}，比第 ${previous.index} 幕还早。`);
  }

  return { warnings, notes };
}
