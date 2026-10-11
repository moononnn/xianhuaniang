import test from 'node:test';
import assert from 'node:assert/strict';
import { registerTavernTools } from '../backend/tavern-tools.js';

async function fixture() {
  const tools = new Map();
  const seen = [];
  let starts = 0;
  let reads = 0;
  // 工具调用的真实上下文形状：契约只给 sessionPath 和 callToken，sessionId 常为空，
  // agentId 恒为空。见 backend/session-scope.js 顶部那段实机确认记录。
  const scope = { sessionId: '', sessionPath: 'L:/sessions/one.jsonl', agentId: '', callToken: 'tok-1' };
  const ctx = {
    tools: { async register(spec) { tools.set(spec.name, spec); return () => tools.delete(spec.name); } },
    runtime: { async start() { starts++; throw new Error('诊断不得启动'); } },
    bus: { async request(type, query) {
      assert.equal(type, 'session:get');
      if (query.sessionId && query.sessionId !== scope.sessionId) throw new Error('会话不存在');
      return { session: { ...scope, path: scope.sessionPath } };
    } },
    resources: { async read() { reads++; throw new Error('诊断不得读取资料'); } },
  };
  const service = { pending(actual) {
    seen.push({ sessionPath: actual.sessionPath, agentId: actual.agentId });
    return Array.from({ length: 30 }, (_, i) => ({ runId: `run-${i}`, mode: 'scripted', status: 'waiting', characterName: '测试角色', updatedAt: 123, scope: { sessionPath: 'PRIVATE' }, objective: 'PRIVATE', scenes: [{ reply: 'PRIVATE' }] }));
  } };
  const cleanup = await registerTavernTools(ctx, service);
  return { tool: tools.get('hanabrew-debug'), cleanup, scope, seen, counts: () => ({ starts, reads }) };
}

test('诊断仅返回宿主确认的当前会话任务摘要，不启动酒馆或读资料', async () => {
  const f = await fixture();
  try {
    const result = await f.tool.execute({ arguments: {}, context: f.scope });
    assert.equal(result.isError, undefined);
    const data = JSON.parse(result.content[0].text);
    assert.equal(data.ok, true);
    assert.equal(data.tasks.length, 20);
    assert.equal(data.runtime.ready, false);
    assert.equal(/PRIVATE|dataRoot|serverUrl|sessionPath/.test(result.content[0].text), false);
    assert.deepEqual(f.counts(), { starts: 0, reads: 0 });
    assert.match(data.note, /未执行模型/);
  } finally { await f.cleanup(); }
});

test('诊断缺宿主上下文时拒绝：参数里自带的 scope 不能替代上下文', async () => {
  const f = await fixture();
  try {
    for (const input of [
      { arguments: { scope: f.scope } },
      { arguments: {} },
    ]) {
      const result = await f.tool.execute(input);
      assert.equal(result.isError, true);
      assert.equal(JSON.parse(result.content[0].text).ok, false);
    }
    assert.deepEqual(f.seen, []);
    assert.deepEqual(f.counts(), { starts: 0, reads: 0 });
  } finally { await f.cleanup(); }
});

test('上下文里的 agentId 不参与归属：伪造值到不了任务筛选', async () => {
  const f = await fixture();
  try {
    // agentId 在契约里恒为空，也不当归属凭据；上下文体带什么都不该影响筛选。
    const result = await f.tool.execute({ arguments: {}, context: { ...f.scope, agentId: 'forged' } });
    assert.equal(result.isError, undefined);
    assert.deepEqual(f.seen, [{ sessionPath: f.scope.sessionPath, agentId: '' }]);
    assert.deepEqual(f.counts(), { starts: 0, reads: 0 });
  } finally { await f.cleanup(); }
});
