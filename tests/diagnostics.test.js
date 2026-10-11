import test from 'node:test';
import assert from 'node:assert/strict';
import { registerTavernTools } from '../backend/tavern-tools.js';

async function fixture() {
  const tools = new Map();
  let starts = 0;
  let reads = 0;
  const scope = { sessionId: 's1', sessionPath: 'L:/sessions/one.jsonl', agentId: 'p1' };
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
    assert.deepEqual(actual, scope);
    return Array.from({ length: 30 }, (_, i) => ({ runId: `run-${i}`, mode: 'scripted', status: 'waiting', characterName: '测试角色', updatedAt: 123, scope: { sessionPath: 'PRIVATE' }, objective: 'PRIVATE', scenes: [{ reply: 'PRIVATE' }] }));
  } };
  const cleanup = await registerTavernTools(ctx, service);
  return { tool: tools.get('hanabrew-debug'), cleanup, scope, counts: () => ({ starts, reads }) };
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

test('诊断缺宿主上下文或身份冲突时拒绝，参数里的scope不能替代上下文', async () => {
  const f = await fixture();
  try {
    for (const input of [
      { arguments: { scope: f.scope } },
      { arguments: {}, context: { ...f.scope, agentId: 'forged' } },
      { arguments: {}, context: { ...f.scope, sessionId: 'other' } },
    ]) {
      const result = await f.tool.execute(input);
      assert.equal(result.isError, true);
      assert.equal(JSON.parse(result.content[0].text).ok, false);
    }
    assert.deepEqual(f.counts(), { starts: 0, reads: 0 });
  } finally { await f.cleanup(); }
});
