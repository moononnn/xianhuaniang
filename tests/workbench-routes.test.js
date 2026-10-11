import test, { after } from 'node:test';
import fs from 'node:fs';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { apply, resolveWorkbenchScope, workbenchVisitors } from '../index.js';

const tempRoots = [];
after(() => { for (const dir of tempRoots) fs.rmSync(dir, { recursive: true, force: true }); });
function context() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hana-workbench-test-'));
  tempRoots.push(dataDir);
  const routes = new Map(), tools = [], calls = [], disposed = [];
  const sessions = { s1: { sessionId: 's1', path: 'p1', agentId: 'same-agent' }, s2: { sessionId: 's2', path: 'p2', agentId: 'same-agent' } };
  const ctx = {
    dataDir, appId: 'xianhuaniang',
    logger: { info() {}, warn() {} },
    tools: { async register(spec) { tools.push(spec.name); return async () => { disposed.push(spec.name); }; } },
    routes: { async register(registrar) { registrar({ get: (route, handler) => routes.set(`GET ${route}`, handler), post: (route, handler) => routes.set(`POST ${route}`, handler) }); return async () => { disposed.push('routes'); }; } },
    bus: { async request(type, input) {
      calls.push([type, input]);
      if (type === 'session:send') return { accepted: true };
      assert.equal(type, 'session:get'); return { session: sessions[input.sessionId] || null };
    } },
    resources: new Proxy({}, { get: () => () => { throw new Error('apply must not read/write protected resources'); } }),
    runtime: new Proxy({}, { get: () => () => { throw new Error('apply must not start protected runtime'); } }),
  };
  const invoke = async (method, route, body = {}, query = {}) => {
    const handler = routes.get(`${method} ${route}`); assert.ok(handler, `route exists: ${method} ${route}`);
    return handler({ req: { json: async () => body, query: key => query[key] }, json: (payload, status = 200) => ({ payload, status }) });
  };
  return { ctx, routes, tools, calls, disposed, invoke };
}

test('backend resolves only explicit session metadata, discards forged paths, rejects missing scope', async () => {
  const h = context();
  assert.deepEqual(await resolveWorkbenchScope(h.ctx, 's1'), { sessionId: 's1', sessionPath: 'p1', agentId: 'same-agent' });
  assert.deepEqual(h.calls, [['session:get', { sessionId: 's1', scope: 'all' }]]);
  await assert.rejects(() => resolveWorkbenchScope(h.ctx, ''), /没有 Hana 会话/);
  await assert.rejects(() => resolveWorkbenchScope(h.ctx, 'unknown'), /未获宿主确认/);
});

test('apply registers independent tool sets and routes without invoking protected capabilities; dispose unregisters', async () => {
  const h = context(); const cleanup = await apply(h.ctx);
  try {
    assert.equal(typeof cleanup, 'function'); assert.equal(h.calls.length, 0);
    assert.equal(new Set(h.tools).size, h.tools.length, 'admin must not also register inside theater tools');
    for (const tool of ['hanabrew-character', 'hanabrew-worldbook', 'hanabrew-settings', 'hanabrew-card-test', 'hanabrew-duet-start', 'hanabrew-debug']) assert.ok(h.tools.includes(tool));
    // 来访状态工具已按产品决定退役（鲜花酿不再做「邀请角色来 Hana」），不再注册给模型。
    assert.equal(h.tools.includes('hanabrew-visitor-state'), false, '退役的来访状态工具不该重新出现在模型工具列表里');
    for (const route of ['POST /theater/submit', 'GET /theater/progress', 'POST /theater/control', 'POST /migration/preview', 'POST /migration/apply', 'GET /migration/status', 'POST /workbench/visitors/repair', 'POST /workbench/tea-party/invite']) assert.ok(h.routes.has(route));
  } finally { await cleanup(); }
  assert.ok(h.disposed.includes('routes')); for (const tool of h.tools) assert.ok(h.disposed.includes(tool));
});

test('submit strips fake turns and scope; same-agent different sessions cannot read pending progress', async () => {
  const h = context(); const cleanup = await apply(h.ctx);
  try {
    const missing = await h.invoke('POST', '/theater/submit', { characterFile: 'target.png' });
    assert.equal(missing.status, 400);
    const submit = await h.invoke('POST', '/theater/submit', { characterFile: 'target.png', mode: 'scripted', testType: 'mvu', pace: '慢慢推进', objective: '测变量', turns: ['must not run'], scope: { sessionId: 's1', sessionPath: 'forged', agentId: 'forged' } });
    assert.equal(submit.status, 200); assert.ok(submit.payload.runId); assert.equal(submit.payload.status, 'waiting');
    const own = await h.invoke('GET', '/theater/progress', {}, { runId: submit.payload.runId, sessionId: 's1' });
    assert.equal(own.status, 200);
    const foreign = await h.invoke('GET', '/theater/progress', {}, { runId: submit.payload.runId, sessionId: 's2' });
    assert.equal(foreign.status, 404, 'same agent must not grant cross-session read');
    const missingProgress = await h.invoke('GET', '/theater/progress', {}, { runId: submit.payload.runId }); assert.equal(missingProgress.status, 404);
    const cancel = await h.invoke('POST', '/theater/control', { runId: submit.payload.runId, action: 'cancel', scope: { sessionId: 's1' } }); assert.equal(cancel.status, 200);
  } finally { await cleanup(); }
});

test('route registration failure cleans tool registrations and reports failure instead of fake apply success', async () => {
  const h = context(); h.ctx.routes.register = async () => { throw new Error('route-register-failed'); };
  await assert.rejects(() => apply(h.ctx), /route-register-failed/);
  assert.equal(h.disposed.length, h.tools.length);
});

test('handoff uses the verified run, ignores forged text, and deduplicates accepted starts', async () => {
  const h = context(); const cleanup = await apply(h.ctx);
  try {
    const submit = await h.invoke('POST', '/theater/submit', { characterFile: 'target.png', mode: 'scripted', objective: 'check', scope: { sessionId: 's1' } });
    const body = { runId: submit.payload.runId, scope: { sessionId: 's1' }, mode: 'start', text: 'forged unrelated text' };
    const results = await Promise.all([h.invoke('POST', '/theater/handoff', body), h.invoke('POST', '/theater/handoff', body)]);
    assert.ok(results.every(r => r.payload.accepted === true));
    const sends = h.calls.filter(([type]) => type === 'session:send');
    assert.equal(sends.length, 1); assert.equal(sends[0][1].sessionId, 's1'); assert.equal(sends[0][1].scope, 'all');
    assert.match(sends[0][1].text, /target.png/); assert.match(sends[0][1].text, /hanabrew-card-test/); assert.doesNotMatch(sends[0][1].text, /forged unrelated/);
    const foreign = await h.invoke('POST', '/theater/handoff', { ...body, scope: { sessionId: 's2' } });
    assert.equal(foreign.status, 400); assert.equal(h.calls.filter(([type]) => type === 'session:send').length, 1);
  } finally { await cleanup(); }
});

test('handoff permission rejection retains the task and permits retry after authorization', async () => {
  const h = context(); const request = h.ctx.bus.request; let denied = true;
  h.ctx.bus.request = async (type, input) => {
    if (type === 'session:send' && denied) throw Object.assign(new Error('APP_CAPABILITY_DENIED'), { code: 'APP_CAPABILITY_DENIED' });
    return request(type, input);
  };
  const cleanup = await apply(h.ctx);
  try {
    const submit = await h.invoke('POST', '/theater/submit', { characterFile: 'target.png', mode: 'scripted', scope: { sessionId: 's1' } });
    const body = { runId: submit.payload.runId, scope: { sessionId: 's1' }, mode: 'start' };
    const first = await h.invoke('POST', '/theater/handoff', body);
    assert.equal(first.payload.ok, false); assert.match(first.payload.error, /任务保留/);
    denied = false;
    assert.equal((await h.invoke('POST', '/theater/handoff', body)).payload.accepted, true);
    assert.equal((await h.invoke('GET', '/theater/progress', {}, { runId: body.runId, sessionId: 's1' })).status, 200);
  } finally { await cleanup(); }
});

test('timeout, busy, and empty handoff receipts all permit a deliberate retry without creating another task', async () => {
  for (const failure of ['timeout', 'busy', 'empty']) {
    const h = context(); const request = h.ctx.bus.request; let first = true;
    h.ctx.bus.request = async (type, input) => {
      if (type === 'session:send' && first) {
        first = false;
        if (failure === 'empty') return {};
        throw new Error(failure);
      }
      return request(type, input);
    };
    const cleanup = await apply(h.ctx);
    try {
      const submit = await h.invoke('POST', '/theater/submit', { characterFile: 'target.png', mode: 'scripted', objective: 'keep direction', scope: { sessionId: 's1' } });
      const body = { runId: submit.payload.runId, scope: { sessionId: 's1' }, mode: 'start' };
      const failed = await h.invoke('POST', '/theater/handoff', body);
      assert.equal(failed.payload.ok, false); assert.match(failed.payload.error, /请先查看主对话/);
      assert.equal((await h.invoke('POST', '/theater/handoff', body)).payload.accepted, true);
      assert.equal((await h.invoke('GET', '/theater/progress', {}, { runId: body.runId, sessionId: 's1' })).payload.runId, body.runId);
    } finally { await cleanup(); }
  }
});

test('legacy visitor ownership is checked against host own-agent registry; unavailable stays unavailable', async () => {
  const ledger = [{ agentId: 'owned', characterName: '本应用访客', status: 'active' }, { agentId: 'legacy', characterName: '旧档访客', status: 'active', adopted: true }];
  const requests = [];
  const ctx = { dataDir: 'mock-data', resources: { read: async () => ({ content: JSON.stringify({ visitors: ledger }) }), list: async () => [] }, bus: { request: async (type, input) => { requests.push([type, input]); return { agents: [{ id: 'owned' }] }; } } };
  const visitors = await workbenchVisitors(ctx);
  assert.equal(visitors[0].available, true); assert.equal(visitors[1].available, false); assert.match(visitors[1].unavailableReason, /修一遍不能改变/);
  assert.deepEqual(requests, [['agent:list', { scope: 'own' }]]);
  ctx.bus.request = async () => { throw new Error('permission denied'); };
  assert.ok((await workbenchVisitors(ctx)).every(visitor => !visitor.available));
});
