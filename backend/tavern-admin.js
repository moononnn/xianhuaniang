import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { ensureServer, runtimeStatus } from './st-runtime.js';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
export function createAdminService(ctx) {
  let tail = Promise.resolve();
  let disposed = false;
  const active = new Set();
  async function perform(input) {
    if (disposed) throw new Error('鲜花酿正在重新加载，请稍后重试。');
    if (!ctx?.dataDir || !ctx.runtime?.start) throw new Error('当前应用没有受管酒馆操作通道。');
    await ensureServer(ctx);
    let ready = false;
    const until = Date.now() + 30000;
    while (Date.now() < until && !disposed) {
      const status = await runtimeStatus(ctx);
      if (status.ready) { ready = true; break; }
      if (status.state === 'failed') throw new Error('酒馆启动失败，请在鲜花酿主页面重试。');
      await sleep(200);
    }
    if (!ready) throw new Error('酒馆尚未就绪，请打开鲜花酿后重试。');
    const dir = path.join(ctx.dataDir, 'admin-jobs');
    await fs.mkdir(dir, { recursive: true });
    const id = randomUUID();
    const requestPath = path.join(dir, id + '.request.json');
    const resultPath = path.join(dir, id + '.result.json');
    let payload = input;
    if (input.area === 'characters' && input.action === 'import' && input.source) {
      const source = input.source;
      if (!['local-file', 'session-file'].includes(source.kind)) throw new Error('请提供已授权的角色卡文件资源。');
      const stat = await ctx.resources.stat(source);
      const size = Number(stat?.size ?? stat?.version?.size);
      if (!stat?.exists || stat.isDirectory || !Number.isFinite(size) || size <= 0 || size > 16 * 1024 * 1024) throw new Error('角色卡文件不存在、为空或超过 16 MB 上限。');
      const result = await ctx.resources.read(source, { encoding: 'base64' });
      const raw = result?.content ?? result?.data ?? result?.body ?? result;
      const bytes = typeof raw === 'string' ? Buffer.from(raw.trim(), 'base64') : raw instanceof Uint8Array ? Buffer.from(raw) : null;
      if (!bytes?.length || bytes.length > 16 * 1024 * 1024) throw new Error('没有读到有效角色卡文件。');
      const fileType = input.fileType || String(source.path || stat?.label || '').split('.').pop().toLowerCase();
      payload = { ...input, source: undefined, importBase64: bytes.toString('base64'), fileType };
    }
    const json = JSON.stringify(payload);
    if (Buffer.byteLength(json) > 24 * 1024 * 1024) throw new Error('酒馆操作资料过大。');
    await fs.writeFile(requestPath, json, { mode: 0o600 });
    let worker;
    try {
      worker = await ctx.runtime.start({
        runtime: 'node', entry: 'runtime/tavern-admin-worker.mjs', profile: 'local-machine', network: 'external',
        // 同上：工具执行期间宿主会无条件注入 callToken，local-machine 拒绝它，
        // 不显式声明 scope: 'app' 就起不来。
        scope: 'app',
        args: [requestPath, resultPath],
      });
      const runtimeId = worker?.runtimeId;
      if (!runtimeId) throw new Error('酒馆操作未拿到任务编号。');
      active.add(runtimeId);
      const deadline = Date.now() + 30000;
      while (Date.now() < deadline && !disposed) {
        let raw;
        try { raw = await fs.readFile(resultPath, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
        if (raw) {
          let result;
          try { result = JSON.parse(raw); } catch { throw new Error('酒馆操作结果损坏，不能确认完成。'); }
          if (result.ok !== true || result.data == null) throw new Error(result.error || '酒馆没有确认操作结果。');
          return result.data;
        }
        const state = await ctx.runtime.get?.(runtimeId);
        if (state?.state === 'failed') throw new Error('酒馆操作任务失败；没有收到保存确认。');
        await sleep(150);
      }
      throw new Error('酒馆操作超时，结果未确认。涉及修改时请先回查，不要直接重复提交。');
    } finally {
      if (worker?.runtimeId) {
        try { await ctx.runtime.stop?.(worker.runtimeId); } catch {}
        active.delete(worker.runtimeId);
      }
      // 只清理由本次调用创建的临时传输文件，不碰用户数据和备份。
      await Promise.all([requestPath, resultPath, resultPath + '.tmp'].map(file => fs.rm(file, { force: true }).catch(() => {})));
    }
  }
  return {
    call(input) {
      const pending = tail.then(() => perform(input));
      tail = pending.catch(() => {});
      return pending;
    },
    async dispose() {
      disposed = true;
      await Promise.all([...active].map(id => ctx.runtime.stop?.(id).catch(() => {})));
    },
  };
}

const obj = { type: 'object', additionalProperties: true };
const schemas = [
  {
    name: 'hanabrew-character',
    description: '鲜花酿应用版角色卡管理：列出、读取、导入新卡、更新或删除。只操作新版酒馆；更新/删除必须先取得明确确认，删除保留聊天记录。导入不会覆盖旧卡。',
    area: 'characters',
    parameters: { type: 'object', properties: { action: { type: 'string', enum: ['list', 'get', 'import', 'update', 'delete'] }, file: { type: 'string', description: '酒馆角色卡 PNG 文件名，不是路径。' }, card: obj, source: { type: 'object', description: '已授权的 local-file 或 session-file 角色卡资源引用。' }, fileType: { type: 'string', enum: ['png', 'json', 'yaml', 'yml'] }, patch: obj, confirm: { type: 'boolean', description: '只有明确确认修改或删除后才传 true。' } }, required: ['action'] },
  },
  {
    name: 'hanabrew-worldbook',
    description: '管理鲜花酿应用版酒馆的世界书：列出、新建、读取、更新、删除。更新或删除前须获得确认，不能覆盖同名新建。',
    area: 'worldbook',
    parameters: { type: 'object', properties: { action: { type: 'string', enum: ['list', 'get', 'create', 'update', 'delete'] }, name: { type: 'string' }, data: obj, confirm: { type: 'boolean' } }, required: ['action'] },
  },
  {
    name: 'hanabrew-settings',
    description: '读取或修改鲜花酿应用版酒馆设置。返回会隐藏密钥；修改先获得确认。密钥和扩展配置在酒馆原界面操作，不由此工具读写。修改后须在酒馆重新载入设置才会影响已打开页面。',
    area: 'settings',
    parameters: { type: 'object', properties: { action: { type: 'string', enum: ['get', 'set'] }, patch: obj, confirm: { type: 'boolean' } }, required: ['action'] },
  },
];
export async function registerAdminTools(ctx) {
  if (!ctx?.tools?.register) throw new Error('宿主没有提供应用工具注册通道。');
  const service = createAdminService(ctx);
  const cleanups = [];
  try {
    for (const spec of schemas) {
      const cleanup = await ctx.tools.register({ name: spec.name, description: spec.description, parameters: spec.parameters,
        execute: async input => {
          try {
            const args = input?.arguments ?? input;
            const result = await service.call({ ...args, area: spec.area });
            return { content: [{ type: 'text', text: JSON.stringify(result) }] };
          } catch (error) {
            return { isError: true, content: [{ type: 'text', text: JSON.stringify({ ok: false, error: error?.message || '酒馆操作失败。' }) }] };
          }
        },
      });
      if (typeof cleanup === 'function') cleanups.push(cleanup);
    }
  } catch (error) {
    for (const cleanup of cleanups) await cleanup();
    await service.dispose();
    throw error;
  }
  return async () => {
    await service.dispose();
    for (const cleanup of cleanups) await cleanup();
  };
}
