import test from "node:test";
import assert from "node:assert/strict";

import {
  analyzeTheaterRun,
  declaredVariables,
  flattenVariables,
  parseTimeValue,
} from "../backend/theater-analysis.js";

function replyWithPatch(patches) {
  return [
    "他停了一下。",
    "",
    "<UpdateVariable>",
    "<Analysis>",
    "- test fixture",
    "</Analysis>",
    "<JSONPatch>",
    JSON.stringify(patches, null, 2),
    "</JSONPatch>",
    "</UpdateVariable>",
  ].join("\n");
}

function scene(index, { before = null, after = null, patches = null, reply = null } = {}) {
  return {
    index,
    user: `第 ${index} 幕`,
    reply: reply ?? (patches ? replyWithPatch(patches) : "（这张卡没按 MVU 格式回 patch）"),
    variableSource: "chat.message.variables",
    variablesBefore: before,
    variablesAfter: after,
    variableChanges: [],
  };
}

function replace(path, value) {
  return { op: "replace", path, value };
}

/** Synthetic regression sample: a declared change is lost on the next turn, and time moves backwards. */
function sampleRun() {
  const opening = { 世界: { 当前时间: "2030/01/01-21:30", 当前地点: "测试地点" }, 关系: { 好感度: 35, 信任度: 25, 关系阶段: "初始" } };
  const meeting = { 世界: { 当前时间: "2030/01/01-22:05", 当前地点: "测试地点" }, 关系: { 好感度: 38, 信任度: 33, 关系阶段: "初始" } };
  const morning = { 世界: { 当前时间: "2030/01/02-09:55", 当前地点: "测试地点" }, 关系: { 好感度: 40, 信任度: 40, 关系阶段: "初始" } };
  const caught = { 世界: { 当前时间: "2030/01/02-10:05", 当前地点: "测试地点" }, 关系: { 好感度: 37, 信任度: 22, 关系阶段: "初始" } };
  return {
    initialVariables: null,
    initialVariableSource: "unavailable",
    finalVariables: { 世界: { 当前时间: "2030/01/02-10:20", 当前地点: "测试地点" }, 关系: { 好感度: 38, 信任度: 27, 关系阶段: "初始" } },
    finalVariableSource: "chat.message.variables",
    mvuAvailable: true,
    scenes: [
      scene(1, {
        before: null,
        after: opening,
        patches: [replace("/世界/当前时间", "2030/01/02-09:06"), replace("/关系/好感度", 37), replace("/关系/信任度", 31)],
      }),
      scene(2, {
        before: opening,
        after: meeting,
        patches: [
          replace("/世界/当前时间", "2030/01/01-22:05"),
          replace("/世界/当前地点", "测试地点"),
          replace("/关系/好感度", 38),
          replace("/关系/信任度", 33),
        ],
      }),
      scene(3, {
        before: meeting,
        after: morning,
        patches: [
          replace("/世界/当前时间", "2030/01/02-09:55"),
          replace("/世界/当前地点", "测试地点"),
          replace("/关系/好感度", 40),
          replace("/关系/信任度", 40),
        ],
      }),
      scene(4, {
        before: morning,
        after: caught,
        patches: [replace("/世界/当前时间", "2030/01/02-10:05"), replace("/关系/好感度", 37), replace("/关系/信任度", 22)],
      }),
      scene(5, {
        before: caught,
        after: { 世界: { 当前时间: "2030/01/02-10:20", 当前地点: "测试地点" }, 关系: { 好感度: 38, 信任度: 27, 关系阶段: "初始" } },
        patches: [replace("/世界/当前时间", "2030/01/02-10:20"), replace("/关系/好感度", 38), replace("/关系/信任度", 27)],
      }),
    ],
  };
}

test("parseTimeValue 只认真正的时间写法", () => {
  assert.notEqual(parseTimeValue("2026/08/27-21:30"), null);
  assert.notEqual(parseTimeValue("2026-08-27 21:30"), null);
  assert.notEqual(parseTimeValue("2026/08/27T21:30"), null);
  assert.equal(parseTimeValue("办公室"), null);
  assert.equal(parseTimeValue("21:30"), null);
  assert.equal(parseTimeValue(null), null);
});

test("flattenVariables 展到叶子，数组与 null 当值处理", () => {
  assert.deepEqual(
    flattenVariables({ 世界: { 当前时间: "x" }, 关系: { 好感度: 3 }, 标签: ["a"] }),
    { "世界.当前时间": "x", "关系.好感度": 3, "标签": ["a"] },
  );
  assert.deepEqual(flattenVariables(null), {});
});

test("declaredVariables 把回复里的 patch 叠在本幕起始值上；抽不到就返回 null", () => {
  const withPatch = scene(1, { before: { 好感度: 1 }, patches: [replace("/关系/好感度", 4)] });
  assert.deepEqual(declaredVariables(withPatch), { 好感度: 1, 关系: { 好感度: 4 } });
  assert.equal(declaredVariables(scene(1, { before: { 好感度: 1 } })), null);
});

test("变量逐幕连续时不报问题", () => {
  const result = analyzeTheaterRun({
    initialVariables: { 好感度: 1 },
    originalValue: undefined,
    finalVariables: { 好感度: 5 },
    initialVariableSource: "chat.message.variables",
    finalVariableSource: "chat.message.variables",
    mvuAvailable: true,
    scenes: [
      scene(1, { before: { 好感度: 1 }, after: { 好感度: 1 }, patches: [replace("/好感度", 4)] }),
      scene(2, { before: { 好感度: 4 }, after: { 好感度: 4 }, patches: [replace("/好感度", 5)] }),
    ],
  });
  assert.deepEqual(result.warnings, []);
  assert.deepEqual(result.notes, []);
});

test("样例中的变量变更未继承且时间倒流时，两条都要报出来", () => {
  const result = analyzeTheaterRun(sampleRun());
  assert.equal(result.warnings.length, 2, `期望两条问题，实际：${JSON.stringify(result.warnings)}`);
  assert.match(result.warnings[0], /第 1 幕写进去的变量没有出现在下一幕/);
  assert.match(result.warnings[0], /好感度/);
  assert.match(result.warnings[1], /时间倒流/);
  assert.match(result.warnings[1], /2030\/01\/02-09:06/);
  assert.match(result.warnings[1], /2030\/01\/01-22:05/);
  // 开局基准还没建立是「情况说明」，不是故障。
  assert.equal(result.notes.length, 1);
  assert.match(result.notes[0], /开局时酒馆还没建立变量/);
});

test("全程读不到变量时只报一条，且不拿空对象冒充", () => {
  const result = analyzeTheaterRun({
    initialVariables: null,
    finalVariables: null,
    initialVariableSource: "unavailable",
    finalVariableSource: "unavailable",
    mvuAvailable: false,
    scenes: [scene(1, { before: null, after: null })],
  });
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], /全程没有读到变量/);
});

test("卡片没按 MVU 格式回复时跳过，不把读不懂报成有问题", () => {
  const result = analyzeTheaterRun({
    initialVariables: { 好感度: 1 },
    finalVariables: { 好感度: 1 },
    initialVariableSource: "chat.message.variables",
    finalVariableSource: "chat.message.variables",
    mvuAvailable: true,
    scenes: [scene(1, { before: { 好感度: 1 }, after: { 好感度: 1 } })],
  });
  assert.deepEqual(result.warnings, []);
});
