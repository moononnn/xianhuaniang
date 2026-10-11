// 宿主给模型循环工具的上下文里没有 sessionId——契约 app-contract 的
// HanaPluginToolExecuteContextV2 只有 sessionPath / messageId / messageText / callToken。
// APPS.md「操作会话」写明：session:send、session:send-custom、session:append-entry、
// session:stage-file 都认这枚短命令牌，宿主负责把它解析成这次调用所在的会话；
// 而 session:get 不认它。所以这里不再拿 session:get 去换稳定 ID：
// 归属判定用 sessionPath 就够（theater-service 的 ownedBy 只要求 sessionId 或
// sessionPath 至少有一个，且逐字段与任务记录比对），发消息的动词才需要 callToken。
//
// 2026-10-10 实机确认的上下文实况：
//   { sessionPath: "C:\\...\\2026-10-10T02-13-14-166Z_....jsonl", messageId: null,
//     messageText: null, callToken: "d5ed92cb724eb8b5c3e5dd1aa27f38ef" }

export async function resolveSessionScope(ctx, context = {}) {
  const sessionPath = text(context.sessionPath || context.sessionRef?.sessionPath, 400);
  const sessionId = text(context.sessionId || context.sessionRef?.sessionId, 200);
  const callToken = text(context.callToken, 200);
  if (!sessionPath && !sessionId && !callToken) {
    throw new Error('宿主没有给这次调用绑定会话标识，未执行酒馆操作。');
  }
  if (!sessionPath && !sessionId) {
    throw new Error('这次调用只有一枚会话令牌、没有可核对的路径或编号，无法确认归属，未执行酒馆操作。');
  }
  return { sessionId, sessionPath, agentId: '', callToken };
}

function text(value, limit) {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, limit) : '';
}

/**
 * 要往当前会话投递内容时用这组字段：优先令牌（宿主自己解析，不猜 id），
 * 有显式编号也一并带上让宿主做归属对账。
 */
export function sessionTarget(scope = {}) {
  const target = { scope: 'all' };
  if (scope.callToken) target.callToken = scope.callToken;
  if (scope.sessionId) target.sessionId = scope.sessionId;
  return target;
}
