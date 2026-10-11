import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { stopServer } from './st-runtime.js';

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
export function createMigrationService(ctx) {
  let busy = false;
  let activeId = '';
  const planDir = path.join(ctx.dataDir, 'migration');
  async function dispatch(action, input = {}) {
    if (busy) throw new Error('数据搬家正在进行，请等待这一次结束。');
    busy = true;
    const id = randomUUID();
    const requestPath = path.join(planDir, id + '.request.json');
    const resultPath = path.join(planDir, id + '.result.json');
    try {
      await fs.mkdir(planDir, { recursive: true });
      if (action === 'apply') await stopServer(ctx);
      await fs.writeFile(requestPath, JSON.stringify({ ...input, action, planDir }), { mode: 0o600 });
      const record = await ctx.runtime.start({ runtime: 'node', entry: 'runtime/migration-worker.mjs', profile: 'local-machine', scope: 'app', args: [requestPath, resultPath] });
      activeId = record?.runtimeId || '';
      if (!activeId) throw new Error('迁移任务没有取得受管编号。');
      const deadline = Date.now() + 5 * 60 * 1000;
      while (Date.now() < deadline) {
        let raw;
        try { raw = await fs.readFile(resultPath, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
        if (raw) {
          const result = JSON.parse(raw);
          if (result.ok !== true || result.data == null) throw new Error(result.error || '数据搬家结果没有确认。');
          return action === 'apply' ? { ...result.data, restartNeeded: true, message: result.data.ok ? '数据已复制；同名文件保留原状。重新打开鲜花酿酒馆即可载入。' : '部分文件未复制，原始数据都保留着。请查看失败项目后重新预览。' } : result.data;
        }
        const state = await ctx.runtime.get?.(activeId);
        if (state?.state === 'failed') throw new Error('数据搬家任务失败，请查看状态；不能当作全部完成。');
        await wait(200);
      }
      throw new Error('数据搬家超时；原数据未删除，请查看已复制记录后重新预览。');
    } finally {
      if (activeId) { try { await ctx.runtime.stop?.(activeId); } catch {} }
      activeId = '';
      busy = false;
      await Promise.all([requestPath, resultPath, resultPath + '.tmp'].map(file => fs.rm(file, { force: true }).catch(() => {})));
    }
  }
  return {
    preview: () => dispatch('preview'),
    apply: input => {
      if (!/^[0-9a-f-]{36}$/iu.test(String(input?.previewId || '')) || !Array.isArray(input?.selections) || !input.selections.length) return Promise.reject(new Error('请先完成迁移预览并选择内容。'));
      if (input.selections.includes('credentials') && input.allowSecrets !== true) return Promise.reject(new Error('迁移连接密钥需要单独明确确认。'));
      if (input.conflicts && input.conflicts !== 'skip') return Promise.reject(new Error('数据搬家不会覆盖已有同名文件。'));
      return dispatch('apply', { previewId: input.previewId, selections: input.selections, conflicts: 'skip', allowSecrets: input.allowSecrets === true });
    },
    async status() {
      let report = null;
      try { report = JSON.parse(await fs.readFile(path.join(planDir, 'last-report.json'), 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw new Error('上次迁移记录无法读取，请不要当作已完成。'); }
      return { busy, report, incomplete: Boolean(report && report.complete !== true) };
    },
    async dispose() { if (activeId) await ctx.runtime.stop?.(activeId); },
  };
}
