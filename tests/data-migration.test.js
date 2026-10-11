import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { buildPreview, applyPreview } from '../runtime/migration-worker.mjs';
import { createMigrationService } from '../backend/data-migration.js';

async function fixture(run) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hanabrew-migration-test-'));
  const sourceRoot = path.join(dir, 'old'), targetRoot = path.join(dir, 'new'), planDir = path.join(dir, 'plans');
  await fs.mkdir(sourceRoot); await fs.mkdir(targetRoot); await fs.mkdir(planDir);
  const write = async (root, file, data = 'original') => { const full = path.join(root, file); await fs.mkdir(path.dirname(full), { recursive: true }); await fs.writeFile(full, data); };
  try { await run({ dir, sourceRoot, targetRoot, planDir, write }); } finally { await fs.rm(dir, { recursive: true, force: true }); }
}
test('迁移预览只列白名单与体积，设置密钥默认不选', async () => fixture(async f => {
  await f.write(f.sourceRoot, 'characters/a.png'); await f.write(f.sourceRoot, 'chats/a/1.jsonl', 'private chat');
  await f.write(f.sourceRoot, 'secrets.json', '{"api_key":"private"}');
  await f.write(f.sourceRoot, 'extensions/custom/code.js', 'ignored');
  const p = await buildPreview(f);
  assert.equal(p.files.length, 3);
  assert.equal(p.categories.find(c => c.id === 'credentials').selectedByDefault, false);
  assert.equal(p.categories.find(c => c.id === 'settings').selectedByDefault, false);
  assert.doesNotMatch(JSON.stringify(p), /private chat|api_key|code.js/);
}));
test('复制不覆盖冲突、不删除源，重复执行跳过现有文件', async () => fixture(async f => {
  await f.write(f.sourceRoot, 'characters/a.png', 'old'); await f.write(f.sourceRoot, 'worlds/b.json', 'book');
  await f.write(f.targetRoot, 'characters/a.png', 'current');
  const p = await buildPreview(f);
  const input = { ...f, previewId: p.previewId, selections: ['characters', 'worlds'] };
  const r = await applyPreview(input);
  assert.equal(r.ok, true); assert.deepEqual(r.copied, [path.join('worlds', 'b.json')]);
  assert.equal(await fs.readFile(path.join(f.targetRoot, 'characters/a.png'), 'utf8'), 'current');
  assert.equal(await fs.readFile(path.join(f.sourceRoot, 'characters/a.png'), 'utf8'), 'old');
  const again = await applyPreview(input); assert.equal(again.copied.length, 0); assert.equal(again.skipped.length, 2);
}));
test('源变化报告部分失败，其他类别正常复制并记录', async () => fixture(async f => {
  await f.write(f.sourceRoot, 'characters/a.png'); await f.write(f.sourceRoot, 'worlds/b.json');
  const p = await buildPreview(f);
  await f.write(f.sourceRoot, 'characters/a.png', 'changed after preview');
  const r = await applyPreview({ ...f, previewId: p.previewId, selections: ['characters', 'worlds'] });
  assert.equal(r.ok, false); assert.equal(r.failed.length, 1); assert.equal(r.copied.length, 1);
  const report = JSON.parse(await fs.readFile(path.join(f.planDir, 'last-report.json'), 'utf8'));
  assert.equal(report.complete, true); assert.equal(report.ok, false);
}));
test('不允许覆盖、路径穿越或未明确确认的密钥复制', async () => fixture(async f => {
  await f.write(f.sourceRoot, 'secrets.json', '{}');
  const p = await buildPreview(f);
  await assert.rejects(applyPreview({ ...f, previewId: '../wrong', selections: ['characters'] }), /编号/);
  await assert.rejects(applyPreview({ ...f, previewId: p.previewId, selections: ['credentials'] }), /单独明确确认/);
  await assert.rejects(applyPreview({ ...f, previewId: p.previewId, selections: ['credentials'], allowSecrets: true, conflicts: 'overwrite' }), /不覆盖/);
  assert.equal((await applyPreview({ ...f, previewId: p.previewId, selections: ['credentials'], allowSecrets: true })).copied.length, 1);
}));
test('预览过期与目录变化拒绝执行', async () => fixture(async f => {
  await f.write(f.sourceRoot, 'worlds/a.json');
  const p = await buildPreview(f); const file = path.join(f.planDir, p.previewId + '.json');
  const plan = JSON.parse(await fs.readFile(file, 'utf8')); plan.createdAt = Date.now() - 31 * 60 * 1000;
  await fs.writeFile(file, JSON.stringify(plan));
  await assert.rejects(applyPreview({ ...f, previewId: p.previewId, selections: ['worlds'] }), /过期/);
}));
test('同一数据根目录不允许迁移', async () => fixture(async f => {
  await assert.rejects(buildPreview({ ...f, targetRoot: f.sourceRoot }), /同一个/);
}));
test('目录链接被拒绝，不把其他目录当来源', async () => fixture(async f => {
  const outside = path.join(f.dir, 'outside'); await fs.mkdir(outside);
  await fs.symlink(outside, path.join(f.sourceRoot, 'characters'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(buildPreview(f), /链接/);
}));
test('损坏状态不能报已完成；没有状态是空记录', async () => fixture(async f => {
  const service = createMigrationService({ dataDir: f.dir, runtime: {} });
  assert.equal((await service.status()).report, null);
  await fs.mkdir(path.join(f.dir, 'migration')); await fs.writeFile(path.join(f.dir, 'migration', 'last-report.json'), '{broken');
  await assert.rejects(service.status(), /无法读取/);
}));
