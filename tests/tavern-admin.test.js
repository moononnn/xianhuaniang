import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { executeAdmin, redact, safeName } from '../runtime/tavern-admin-worker.mjs';
import { registerAdminTools, createAdminService } from '../backend/tavern-admin.js';
import { stopServer } from '../backend/st-runtime.js';

const response = data => ({ ok: true, status: 200, text: async () => typeof data === 'string' ? data : JSON.stringify(data) });
function mock(items) {
  const calls = [];
  const fetcher = async (url, options) => { calls.push({ url, options }); if (!items.length) throw new Error('未预期的请求'); return response(items.shift()); };
  return { calls, fetcher };
}
test('密钥递归隐藏，不丢普通设置', () => {
  assert.deepEqual(redact({ model: 'selected', nested: { api_key: 'hidden', token: 'hidden', theme: 'mint' } }), { model: 'selected', nested: { api_key: '[已隐藏]', token: '[已隐藏]', theme: 'mint' } });
});
test('文件名拒绝穿越、空值和非PNG角色路径', () => {
  for (const value of ['', '../a.png', 'a/b.png', 'C:\\a.png', '..']) assert.throws(() => safeName(value, true));
  assert.throws(() => safeName('a.json', true));
  assert.equal(safeName('角色.png', true), '角色.png');
});
test('列角色只使用新版端口，输出轻量列表', async () => {
  const m = mock([[{ avatar: 'a.png', name: '角色', description: '设定', unrelated: 'ignored' }]]);
  const result = await executeAdmin({ area: 'characters', action: 'list' }, m.fetcher);
  assert.equal(result.characters[0].file, 'a.png');
  assert.equal(result.characters[0].unrelated, undefined);
  assert.equal(m.calls[0].url, 'http://127.0.0.1:18511/api/characters/all');
});
test('角色导入使用原生multipart并要求返回文件名', async () => {
  const m = mock([{ file_name: 'new' }]);
  const r = await executeAdmin({ area: 'characters', action: 'import', card: { spec: 'chara_card_v3', data: { name: 'new' } } }, m.fetcher);
  assert.equal(r.file, 'new.png');
  assert.equal(m.calls[0].options.body.get('file_type'), 'json');
  const bad = mock([{}]);
  await assert.rejects(executeAdmin({ area: 'characters', action: 'import', card: { name: 'new' } }, bad.fetcher), /文件名/);
});
test('角色更新拒绝覆盖目标字段与污染对象，修改后回查', async () => {
  await assert.rejects(executeAdmin({ area: 'characters', action: 'update', file: 'a.png', patch: { description: 'new' } }), /确认/);
  const m = mock(['OK', { description: 'new' }]);
  const r = await executeAdmin({ area: 'characters', action: 'update', file: 'a.png', patch: { description: 'new' }, confirm: true }, m.fetcher);
  assert.equal(r.ok, true);
  assert.equal(JSON.parse(m.calls[0].options.body).avatar, 'a.png');
  await assert.rejects(executeAdmin({ area: 'characters', action: 'update', file: 'a.png', patch: { avatar: 'b.png' }, confirm: true }, mock([]).fetcher), /资料字段/);
  await assert.rejects(executeAdmin({ area: 'characters', action: 'import', card: JSON.parse('{"__proto__":{"x":1}}') }, mock([]).fetcher), /不安全/);
  await assert.rejects(executeAdmin({ area: 'characters', action: 'update', file: 'a.png', patch: { description: 'new' }, confirm: true }, mock(['OK', { description: 'old' }]).fetcher), /无法确认/);
});
test('删除角色须确认、永不删除聊天、必须回查', async () => {
  await assert.rejects(executeAdmin({ area: 'characters', action: 'delete', file: 'a.png' }), /明确确认/);
  const m = mock(['OK', []]);
  assert.equal((await executeAdmin({ area: 'characters', action: 'delete', file: 'a.png', confirm: true }, m.fetcher)).chatsRetained, true);
  assert.equal(JSON.parse(m.calls[0].options.body).delete_chats, false);
  await assert.rejects(executeAdmin({ area: 'characters', action: 'delete', file: 'a.png', confirm: true }, mock(['OK', [{ avatar: 'a.png' }]]).fetcher), /无法确认/);
});
test('世界书创建不覆盖同名，保存回查匹配', async () => {
  const data = { entries: { 0: { content: 'story' } } };
  await assert.rejects(executeAdmin({ area: 'worldbook', action: 'create', name: 'book', data }, mock([[{ file_id: 'book' }]]).fetcher), /同名/);
  assert.equal((await executeAdmin({ area: 'worldbook', action: 'create', name: 'book', data }, mock([[], { ok: true }, data]).fetcher)).ok, true);
  await assert.rejects(executeAdmin({ area: 'worldbook', action: 'update', name: 'book', data }, mock([[{ file_id: 'book' }]]).fetcher), /确认/);
});
test('设置读回脱敏，更新保留原字段并检查实际落盘', async () => {
  const old = { model: 'old', api_key: 'private', theme: 'mint' };
  assert.equal((await executeAdmin({ area: 'settings', action: 'get' }, mock([{ settings: JSON.stringify(old) }]).fetcher)).settings.api_key, '[已隐藏]');
  const m = mock([{ settings: JSON.stringify(old) }, { ok: true }, { settings: JSON.stringify({ ...old, model: 'new' }) }]);
  const r = await executeAdmin({ area: 'settings', action: 'set', patch: { model: 'new' }, confirm: true }, m.fetcher);
  assert.equal(r.settings.api_key, '[已隐藏]');
  assert.equal(JSON.parse(m.calls[1].options.body).theme, 'mint');
  await assert.rejects(executeAdmin({ area: 'settings', action: 'set', patch: { api_key: 'new' }, confirm: true }, mock([{ settings: JSON.stringify(old) }]).fetcher), /密钥/);
  await assert.rejects(executeAdmin({ area: 'settings', action: 'set', patch: { nested: { api_key: 'new' } }, confirm: true }, mock([{ settings: JSON.stringify(old) }]).fetcher), /密钥/);
});
test('HTTP失败、空正文及非JSON不冒充成功', async () => {
  const input = { area: 'characters', action: 'get', file: 'a.png' };
  await assert.rejects(executeAdmin(input, async () => ({ ok: false, status: 503, text: async () => 'secret error body' })), /HTTP 503/);
  await assert.rejects(executeAdmin(input, mock(['<html>login</html>']).fetcher), /有效数据/);
  await assert.rejects(executeAdmin(input, mock(['']).fetcher), /有效角色资料/);
});
test('工具注册返回错误标记，不把失败写成成功', async () => {
  const registered = [];
  const ctx = { tools: { register: async spec => { registered.push(spec); return () => {}; } } };
  const dispose = await registerAdminTools(ctx);
  assert.equal(registered.length, 3);
  const result = await registered[0].execute({ action: 'list' });
  assert.equal(result.isError, true);
  await dispose();
});
test('受管操作结果必须有效，临时文件仅清自身任务', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hanabrew-admin-test-'));
  const ctx = { dataDir: dir, runtime: {
    async start(spec) {
      if (spec.entry === 'runtime/tavern-admin-worker.mjs') {
        const resultPath = spec.args[1];
        await fs.writeFile(resultPath, JSON.stringify({ ok: true, data: { characters: [] } }));
        return { runtimeId: 'job' };
      }
      return { runtimeId: 'st', state: 'ready', service: { state: 'ready' } };
    },
    async get(id) { return { runtimeId: id, state: 'ready', service: { state: 'ready' } }; }, async stop() {},
  } };
  const service = createAdminService(ctx);
  try {
    const r = await service.call({ area: 'characters', action: 'list' });
    assert.deepEqual(r, { characters: [] });
    assert.deepEqual(await fs.readdir(path.join(dir, 'admin-jobs')), []);
  } finally { await service.dispose(); await stopServer(ctx); await fs.rm(dir, { recursive: true, force: true }); }
});
