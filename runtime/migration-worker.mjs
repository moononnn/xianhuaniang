import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID, createHash } from 'node:crypto';
import { constants, createReadStream } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const CATEGORIES = {
  characters: ['characters'], chats: ['chats', 'group chats', 'groups'], worlds: ['worlds'],
  themes: ['themes'], presets: ['OpenAI Settings', 'TextGen Settings', 'KoboldAI Settings', 'NovelAI Settings', 'Instruct', 'Context', 'Sysprompt'],
  media: ['backgrounds', 'User Avatars', 'user', 'assets'], settings: ['settings.json'], credentials: ['secrets.json'],
};
const MAX_FILES = 50000;
const MAX_AGE = 30 * 60 * 1000;
function under(root, relative) {
  const destination = path.resolve(root, relative);
  const rel = path.relative(root, destination);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('迁移文件路径超出数据目录。');
  return destination;
}
async function checkedRoot(root, create = false) {
  if (create) await fs.mkdir(root, { recursive: true });
  const stat = await fs.lstat(root);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('数据目录不能是链接或非目录。');
  return await fs.realpath(root);
}
async function noLinks(root, relative) {
  const full = under(root, relative);
  let cursor = root;
  for (const part of path.relative(root, full).split(path.sep)) {
    cursor = path.join(cursor, part);
    let stat;
    try { stat = await fs.lstat(cursor); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
    if (stat.isSymbolicLink()) throw new Error('迁移拒绝链接文件或链接目录。');
  }
}
async function digest(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
async function atomic(file, data) {
  const temp = file + '.tmp';
  await fs.writeFile(temp, JSON.stringify(data), { mode: 0o600 });
  await fs.rename(temp, file);
}
export async function buildPreview({ sourceRoot, targetRoot, planDir }) {
  let source;
  try { source = await checkedRoot(sourceRoot); } catch (error) { if (error.code === 'ENOENT') return { previewId: '', available: false, categories: [], files: [], message: '没有找到旧版酒馆数据。' }; throw error; }
  const target = await checkedRoot(targetRoot, true);
  if (source === target) throw new Error('旧版和新版不能使用同一个数据目录。');
  await fs.mkdir(planDir, { recursive: true });
  const files = [];
  async function walk(relative, category) {
    const file = under(source, relative);
    let stat;
    try { stat = await fs.lstat(file); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
    if (stat.isSymbolicLink()) throw new Error('旧数据包含链接，请先手动处理后再迁移。');
    if (stat.isDirectory()) {
      for (const entry of await fs.readdir(file)) await walk(path.join(relative, entry), category);
      return;
    }
    if (!stat.isFile()) return;
    if (files.length >= MAX_FILES) throw new Error('旧数据超过单次迁移文件上限，请分批处理。');
    await noLinks(target, relative);
    const destination = under(target, relative);
    const targetStat = await fs.stat(destination).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    files.push({ category, relative, size: stat.size, mtimeMs: stat.mtimeMs, conflict: Boolean(targetStat) });
  }
  for (const [category, paths] of Object.entries(CATEGORIES)) for (const name of paths) await walk(name, category);
  const previewId = randomUUID();
  const plan = { previewId, createdAt: Date.now(), sourceRoot: source, targetRoot: target, files };
  await atomic(path.join(planDir, previewId + '.json'), plan);
  const categories = Object.keys(CATEGORIES).map(id => {
    const group = files.filter(f => f.category === id);
    return { id, category: id, count: group.length, bytes: group.reduce((total, f) => total + f.size, 0), conflicts: group.filter(f => f.conflict).length, sensitive: id === 'credentials', selectedByDefault: !['credentials', 'settings'].includes(id) };
  });
  return { previewId, available: true, categories, files: files.map(({ category, relative, size, conflict }) => ({ category, file: relative, size, conflict })), conflictPolicy: 'skip', expiresAt: plan.createdAt + MAX_AGE };
}
export async function applyPreview({ previewId, selections, conflicts = 'skip', allowSecrets = false, planDir, sourceRoot, targetRoot }) {
  if (!/^[0-9a-f-]{36}$/iu.test(String(previewId || ''))) throw new Error('迁移预览编号无效。');
  if (conflicts !== 'skip') throw new Error('迁移只跳过同名文件，不覆盖现有数据。');
  if (!Array.isArray(selections) || !selections.length || selections.some(s => !Object.hasOwn(CATEGORIES, s))) throw new Error('请至少选择一类有效迁移内容。');
  if (selections.includes('credentials') && allowSecrets !== true) throw new Error('迁移连接密钥需要单独明确确认。');
  const planFile = path.join(planDir, previewId + '.json');
  const plan = JSON.parse(await fs.readFile(planFile, 'utf8'));
  if (plan.previewId !== previewId || Date.now() - plan.createdAt > MAX_AGE) throw new Error('迁移预览已过期，请重新预览。');
  const source = await checkedRoot(sourceRoot);
  const target = await checkedRoot(targetRoot, true);
  if (plan.sourceRoot !== source || plan.targetRoot !== target || source === target) throw new Error('迁移数据目录已变化，请重新预览。');
  const report = { previewId, copied: [], skipped: [], failed: [], sourceUntouched: true, startedAt: Date.now() };
  for (const file of plan.files.filter(f => selections.includes(f.category))) {
    try {
      if (!Object.hasOwn(CATEGORIES, file.category) || !CATEGORIES[file.category].some(base => file.relative === base || file.relative.startsWith(base + path.sep))) throw new Error('迁移计划包含无效文件类别。');
      await noLinks(source, file.relative); await noLinks(target, file.relative);
      const from = under(source, file.relative), to = under(target, file.relative);
      const stat = await fs.lstat(from);
      if (!stat.isFile() || stat.size !== file.size || stat.mtimeMs !== file.mtimeMs) throw new Error('源文件在预览后变化，请重新预览。');
      const existing = await fs.lstat(to).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
      if (existing) { report.skipped.push(file.relative); continue; }
      await fs.mkdir(path.dirname(to), { recursive: true });
      await noLinks(target, file.relative);
      const before = await digest(from);
      try { await fs.copyFile(from, to, constants.COPYFILE_EXCL); } catch (error) { if (error.code === 'EEXIST') { report.skipped.push(file.relative); continue; } throw error; }
      const afterStat = await fs.stat(from);
      const copiedHash = await digest(to);
      const after = await digest(from);
      if (afterStat.size !== stat.size || afterStat.mtimeMs !== stat.mtimeMs || before !== copiedHash || before !== after) {
        // 仅撤销本次新建且没有被其他程序修改的副本，不删除原始或已存在的文件。
        if (copiedHash === await digest(to)) await fs.rm(to);
        throw new Error('复制期间文件变化，本项未确认；请停止聊天后重试。');
      }
      report.copied.push(file.relative);
    } catch (error) { report.failed.push({ file: file.relative, error: error?.message || '复制失败。' }); }
    await atomic(path.join(planDir, 'last-report.json'), { ...report, complete: false });
  }
  report.complete = true;
  report.ok = report.failed.length === 0;
  report.finishedAt = Date.now();
  await atomic(path.join(planDir, 'last-report.json'), report);
  return report;
}
export async function worker(input) {
  const roaming = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  const sourceRoot = path.join(roaming, 'hanabrew', 'st-data', 'default-user');
  const targetRoot = path.join(roaming, 'hanabrew-v2-dev', 'st-data', 'default-user');
  const planDir = input.planDir;
  if (input.action === 'preview') return buildPreview({ sourceRoot, targetRoot, planDir });
  if (input.action === 'apply') return applyPreview({ ...input, sourceRoot, targetRoot, planDir });
  throw new Error('不支持的迁移动作。');
}
const direct = process.argv[1] && await fs.realpath(process.argv[1]).catch(() => '') === await fs.realpath(fileURLToPath(import.meta.url));
if (direct) {
  const [requestPath, resultPath] = process.argv.slice(2);
  if (!requestPath || !resultPath || path.dirname(path.resolve(requestPath)) !== path.dirname(path.resolve(resultPath))) throw new Error('迁移任务路径无效。');
  let result;
  try { result = { ok: true, data: await worker(JSON.parse(await fs.readFile(requestPath, 'utf8'))) }; }
  catch (error) { result = { ok: false, error: error?.message || '迁移失败。' }; }
  await atomic(resultPath, result);
  console.log('HANABREW_MIGRATION_DONE');
}
