// 鲜花酿 v2 · 模型可调用的酒馆工具
//
// 分两批：
//   本文件           测卡 / 代笔对戏 / 常规聊天 / 测卡变量回查（核心真实链路）；
//   tavern-admin.js  角色卡、世界书、设置（由 App 入口独立注册，不在此重复注册）。
//
// 契约：
//   - 工具名统一挂在 hanabrew-* 命名空间下。宿主不做 App 前缀重写，重名会让整个应用 failed，
//     所以宁可全部带前缀，也不要与别的 App 的工具撞名。
//   - 每个工具 execute 只吃一个 input，上下文在 input.context（sessionPath / agentId）。
//   - 失败一律返回 isError + 人话原因，不许把没跑通写成成功。
//   - 缺任一前置条件（酒馆没起、浏览器没有、酒馆没配模型）都如实报错。

import { createTheaterService } from "./theater-service.js";
import { resolveSessionScope, sessionTarget } from './session-scope.js';
import { runtimeStatus } from './st-runtime.js';

function ok(data) {
  return { content: [{ type: "text", text: JSON.stringify(data) }] };
}

function fail(error) {
  return {
    isError: true,
    content: [{ type: "text", text: JSON.stringify({ ok: false, error: error?.message || String(error) }) }],
  };
}

const stringParam = (description) => ({ type: "string", description });
const turnsParam = {
  type: "array",
  description: "逐幕测试台词，1~12 条。每条是一句玩家输入，交给真实酒馆按世界书/EJS/MVU 跑出回复。",
  items: { type: "string" },
};

export async function registerTavernTools(ctx, service) {
  if (!ctx?.tools?.register) throw new Error("宿主没有提供应用工具注册通道。");
  // service 可以由宿主传进来复用；没传就自己建一个，并在清理时一并dispose。
  const ownsService = !service;
  const theater = service || createTheaterService(ctx);
  const cleanups = [];

  const specs = [
    {
      name: "hanabrew-open-theater",
      description: "把鲜花酿「小剧场」卡片开到当前对话里：用户在卡里选角色卡、测试方式和测试重点，提交后卡片逐幕展示真实测卡或代笔对戏的过程。用户说「帮我测卡」「帮我测一下这张角色卡」「试演一下这个角色」「看看这张卡的变量有没有生效」时先调它，不要自己编测试台词直接跑工具。",
      parameters: { type: "object", additionalProperties: false, properties: {} },
      run: async (_args, scope) => {
        // 只把卡片铺到对话里，不起新回合：会话空闲且显式 triggerTurn=false 时
        // 不需要 app/session.start-turn，卡片出现本身也不算"已发起测卡"。
        // 会话身份走 callToken：宿主自己把这枚令牌解析成这次调用所在的会话。
        const result = await ctx.bus.request("session:send-custom", {
          ...sessionTarget(scope),
          customType: "theater",
          content: "角色卡体检卡片已开在这里。选好角色卡、测试方式和测试重点后，点「发给小花开始测试」，我会按卡片里的选择真实跑测卡。",
          display: true,
          triggerTurn: false,
        });
        return {
          ok: true,
          entryId: result?.entryId ?? null,
          next: "等用户在卡片里选完再设计测试台词；不要在没有选择时自行调用 hanabrew-card-test。",
        };
      },
    },
    {
      name: "hanabrew-debug",
      description: "检查鲜花酿应用版的运行状态及当前会话的测卡任务。只读、不启动酒馆，不读取全局日志、密钥或其他会话；不是模型连通或真实生成成功的证明。",
      parameters: { type: "object", additionalProperties: false, properties: {} },
      run: async (_args, scope) => {
        const status = await runtimeStatus(ctx);
        const tasks = theater.pending(scope).slice(0, 20).map(task => ({
          runId: task.runId, mode: task.mode, status: task.status,
          characterName: task.characterName, updatedAt: task.updatedAt,
        }));
        return { ok: true, runtime: {
          running: status.running, ready: status.ready, starting: status.starting,
          state: status.state, serviceState: status.serviceState,
        }, tasks, note: "仅检查运行与当前会话任务状态，未执行模型连通或真实生成测试。" };
      },
    },
    {
      name: "hanabrew-card-test",
      description: "在真实 SillyTavern 前端里测一张角色卡：自己拆测试台词，逐幕执行真正的 Generate()，世界书、EJS、MVU 和酒馆扩展按实际流程参与。拿到 running 且 finished=false 时不要下结论，也不要重复发起：任务在后台继续，跑完会自动回到这个对话（拿 hanabrew-test-result 取过程和变量）。变量读不到会明确写进 warnings，不会假装测过。酒馆没起或没配模型会直接失败。",
      parameters: {
        type: "object",
        properties: {
          runId: stringParam("卡片传回的测卡编号。有就传，测卡过程会写回这张卡片；没有会自己认领同会话的待测目标。"),
          characterFile: stringParam("酒馆角色卡 PNG 文件名（不是路径）。"),
          characterName: stringParam("角色卡名字；只知道名字时用它。"),
          turns: turnsParam,
          timeoutMs: { type: "number", description: "单幕等待上限，默认 120000。改大之前先想清楚。", default: 120000 },
        },
        required: ["turns"],
      },
      run: (args, scope) => theater.startRun(args, scope),
    },
    {
      name: "hanabrew-test-result",
      description: "查一次真实测卡的结果：还在跑就给当前进度（跑到第几幕、已完成的逐幕内容），跑完给完整过程（逐幕测试台词、角色回复、变量前后值）、体检结论和备注。用户问「测卡跑完了吗」「上次测卡结果」，或收到测卡完成回报时用它；不要用它重新发起测卡，也只能查当前对话里的测卡。",
      parameters: {
        type: "object",
        properties: {
          runId: stringParam("测卡编号；留空列当前会话最近几份成绩单。"),
          limit: { type: "number", description: "不带 runId 时返回几条，默认 5。", default: 5 },
        },
      },
      run: (args, scope) => theater.report(args?.runId, scope, args?.limit),
    },
    {
      name: "hanabrew-duet-start",
      description: "开始一场驻留的代笔对戏：在真实酒馆里开一个隔离临时聊天，选中角色并读回开场白与初始变量。之后用 hanabrew-duet-turn 逐轮推进，hanabrew-duet-end 结束并清理临时聊天。同一时间只能有一场。",
      parameters: {
        type: "object",
        properties: {
          runId: stringParam("卡片传回的对戏编号。有就传，对戏会接在卡片那次请求上。"),
          characterFile: stringParam("酒馆角色卡 PNG 文件名（不是路径）。"),
          characterName: stringParam("角色卡名字。"),
          pace: { type: "string", enum: ["free", "slow", "restrained"], description: "推进节奏。free=自由发展、slow=慢慢推进、restrained=保持克制。" },
          objective: stringParam("这场对戏要写到什么方向（卡片里用户填的目标）。"),
        },
      },
      run: (args, scope) => theater.duetStart(args, scope),
    },
    {
      name: "hanabrew-duet-turn",
      description: "让代笔对戏推进一轮：把玩家台词原样发进真实酒馆。跑得快就直接返回这一轮的角色回复与变量前后值；返回 `turnPending: true` 说明这一轮还在后台生成，不要重复发起，跑完会自动回到这个对话。只推进一轮，不要一次预写多轮。",
      parameters: {
        type: "object",
        properties: {
          duetId: stringParam("hanabrew-duet-start 返回的对戏编号。"),
          playerMessage: stringParam("这一轮要发送的玩家台词。"),
          checkpoint: { type: "boolean", description: "用户已确认方向时传 true，重置自动推进计数；到上限后必须先确认才能继续。", default: false },
          runId: stringParam("可选：卡片传回的对戏编号，等同 duetId。"),
          sceneIndex: { type: "number", description: "第几幕，默认按已有幕数 +1。", default: 1 },
        },
        required: ["duetId", "playerMessage"],
      },
      run: (args, scope) => theater.duetTurn(args, scope),
    },
    {
      name: "hanabrew-duet-end",
      description: "结束代笔对戏并清掉它创建的临时聊天记录，不碰角色正式聊天。对戏已结束或已失效时也照常清理。",
      parameters: {
        type: "object",
        properties: { duetId: stringParam("要结束的对戏编号。") },
        required: ["duetId"],
      },
      run: (args, scope) => theater.duetEnd(args, scope),
    },
    {
      name: "hanabrew-chat",
      description: "和酒馆里的角色正常聊天（走角色自己的正式聊天，不建临时聊天、不删任何记录）。返回角色回复和这次读到的变量；读不到变量会写明来源不可用。用户想「去酒馆找 TA 说句话」时用它，而不是测卡。",
      parameters: {
        type: "object",
        properties: {
          characterFile: stringParam("酒馆角色卡 PNG 文件名（不是路径）。"),
          characterName: stringParam("角色卡名字。"),
          message: stringParam("要发给角色的内容。"),
          chatId: stringParam("续哪一路聊天；留空用该角色当前聊天。"),
        },
        required: ["message"],
      },
      run: (args, scope) => theater.chat(args, scope),
    },
    {
      name: "hanabrew-test-variables",
      description: "回查当前对话里某次真实测卡或对戏读到的变量账本：初始值、最终值、变量来源和是否检测到 MVU。initial/final 为 null 表示酒馆当时没回传变量，不是「没有变量」。只能回查当前会话的记录。",
      parameters: {
        type: "object",
        properties: {
          runId: stringParam("测卡或对戏编号；留空返回当前会话最近的记录。"),
          limit: { type: "number", description: "不带 runId 时返回几条，默认 20。", default: 20 },
        },
      },
      run: (args, scope) => {
        const runId = String(args?.runId || "").trim();
        return runId
          ? { variables: theater.variables(runId, scope) }
          : { history: theater.variablesHistory(args?.limit, scope) };
      },
    },
  ];

  try {
    for (const spec of specs) {
      const cleanup = await ctx.tools.register({
        name: spec.name,
        description: spec.description,
        parameters: spec.parameters,
        execute: async (input) => {
          try {
            const args = input?.arguments ?? input ?? {};
            const scope = await resolveSessionScope(ctx, input?.context);
            return ok(await spec.run(args, scope));
          } catch (error) {
            return fail(error);
          }
        },
      });
      if (typeof cleanup === "function") cleanups.push(cleanup);
    }
  } catch (error) {
    for (const cleanup of cleanups) await cleanup();
    if (ownsService) await theater.dispose();
    throw error;
  }

  return async () => {
    for (const cleanup of cleanups) await cleanup();
    if (ownsService) await theater.dispose();
  };
}