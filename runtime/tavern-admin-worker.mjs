import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { safeName } from '../backend/tavern-validation.js';
export { safeName } from '../backend/tavern-validation.js';

const BAD_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const SENSITIVE = /api.?key|token|secret|password|passwd|credential|cookie|authorization/i;
export function redact(value, key = '') {
  if (SENSITIVE.test(key)) return '[已隐藏]';
  if (Array.isArray(value)) return value.map(item => redact(item));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([k]) => !BAD_KEYS.has(k)).map(([k, v]) => [k, redact(v, k)]));
  return value;
}
function plain(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('资料必须是一个对象。');
  const visit = item => {
    if (!item || typeof item !== 'object') return;
    for (const [key, val] of Object.entries(item)) { if (BAD_KEYS.has(key)) throw new Error('资料包含不安全字段。'); visit(val); }
  };
  visit(value);
  return value;
}

export async function executeAdmin(input, fetcher = fetch) {
  const server = 'http://127.0.0.1:18511';
  const request = async (endpoint, body, multipart = false) => {
    const response = await fetcher(server + endpoint, {
      method: 'POST', headers: multipart ? {} : { 'Content-Type': 'application/json' },
      body: multipart ? body : JSON.stringify(body), signal: AbortSignal.timeout(20000),
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`酒馆操作失败（HTTP ${response.status}）。请检查酒馆是否已启动及所选项目是否存在。`);
    if (!text.trim()) return { ok: true };
    let result;
    try { result = JSON.parse(text); } catch { if (text.trim() === 'OK') return { ok: true }; throw new Error('酒馆没有返回有效数据，操作结果无法确认。'); }
    if (result?.error || result?.ok === false) throw new Error('酒馆拒绝了本次操作，修改未确认。');
    return result;
  };
  const action = String(input.action || '');
  if (input.area === 'characters') {
    if (action === 'list') {
      const all = await request('/api/characters/all', {});
      if (!Array.isArray(all)) throw new Error('酒馆角色列表格式不正确。');
      return { characters: all.map(c => ({ file: c.avatar, name: c.name, description: String(c.description || c.data?.description || '').slice(0, 500), tags: c.tags || c.data?.tags || [] })) };
    }
    if (action === 'get') {
      const character = await request('/api/characters/get', { avatar_url: safeName(input.file, true) });
      if (!character?.name) throw new Error('酒馆没有返回有效角色资料。');
      return { character };
    }
    if (action === 'import') {
      const form = new FormData();
      const fileType = input.fileType || 'json';
      if (!['png', 'json', 'yaml', 'yml'].includes(fileType)) throw new Error('角色卡只接受 PNG、JSON 或 YAML。');
      const bytes = input.importBase64 ? Buffer.from(input.importBase64, 'base64') : Buffer.from(JSON.stringify(plain(input.card)), 'utf8');
      if (!bytes.length || bytes.length > 16 * 1024 * 1024) throw new Error('角色卡为空或超过 16 MB 上限。');
      form.append('avatar', new Blob([bytes], { type: fileType === 'png' ? 'image/png' : 'application/octet-stream' }), `character.${fileType}`);
      form.append('file_type', fileType);
      const result = await request('/api/characters/import', form, true);
      if (!result.file_name) throw new Error('酒馆没有确认角色卡导入文件名。');
      return { ok: true, file: `${result.file_name}.png` };
    }
    if (action === 'update') {
      if (input.confirm !== true) throw new Error('更新已有角色卡前，请先向你确认修改内容。');
      const file = safeName(input.file, true);
      const patch = plain(input.patch);
      const allowed = new Set(['name', 'description', 'personality', 'scenario', 'first_mes', 'mes_example', 'creator_notes', 'system_prompt', 'post_history_instructions', 'tags', 'alternate_greetings', 'character_book', 'extensions', 'data']);
      if (Object.keys(patch).some(key => !allowed.has(key))) throw new Error('更新只能包含角色卡资料字段。');
      const result = await request('/api/characters/merge-attributes', { ...patch, avatar: file });
      const check = await request('/api/characters/get', { avatar_url: file });
      const matches = (expected, actual) => Object.entries(expected).every(([key, val]) => val && typeof val === 'object' && !Array.isArray(val) ? matches(val, actual?.[key] || {}) : JSON.stringify(val) === JSON.stringify(actual?.[key]));
      if (!matches(patch, check) && !matches(patch, check.data || {})) throw new Error('角色卡回查与修改内容不一致，保存结果无法确认。');
      return { ok: true, file, result: redact(result), character: check };
    }
    if (action === 'delete') {
      if (input.confirm !== true) throw new Error('删除角色卡须先获得明确确认；此操作保留聊天记录。');
      const file = safeName(input.file, true);
      await request('/api/characters/delete', { avatar_url: file, delete_chats: false });
      const all = await request('/api/characters/all', {});
      if (!Array.isArray(all) || all.some(c => c.avatar === file)) throw new Error('角色卡删除结果无法确认。');
      return { ok: true, file, chatsRetained: true };
    }
  }
  if (input.area === 'worldbook') {
    if (action === 'list') {
      const books = await request('/api/worldinfo/list', {});
      if (!Array.isArray(books)) throw new Error('酒馆没有返回有效世界书列表。');
      return { books };
    }
    const name = safeName(input.name);
    if (action === 'get') {
      const books = await request('/api/worldinfo/list', {});
      if (!Array.isArray(books) || !books.some(b => b.file_id === name)) throw new Error('找不到这本世界书。');
      const book = await request('/api/worldinfo/get', { name });
      if (!book?.entries || typeof book.entries !== 'object') throw new Error('酒馆没有返回有效世界书资料。');
      return { name, book };
    }
    if (action === 'create' || action === 'update') {
      const data = plain(input.data);
      if (!data.entries || typeof data.entries !== 'object') throw new Error('世界书需要 entries 条目。');
      const books = await request('/api/worldinfo/list', {});
      if (!Array.isArray(books)) throw new Error('无法确认世界书列表。');
      const exists = books.some(b => b.file_id === name);
      if (action === 'create' && exists) throw new Error('同名世界书已存在，请改名或明确选择更新。');
      if (action === 'update' && (!exists || input.confirm !== true)) throw new Error('更新前须确认已有世界书及修改内容。');
      await request('/api/worldinfo/edit', { name, data });
      const check = await request('/api/worldinfo/get', { name });
      if (JSON.stringify(check) !== JSON.stringify(data)) throw new Error('世界书回查与提交内容不一致，不能确认保存完成。');
      return { ok: true, name };
    }
    if (action === 'delete') {
      if (input.confirm !== true) throw new Error('删除世界书须先获得明确确认。');
      await request('/api/worldinfo/delete', { name });
      const books = await request('/api/worldinfo/list', {});
      if (!Array.isArray(books) || books.some(b => b.file_id === name)) throw new Error('世界书删除结果无法确认。');
      return { ok: true, name };
    }
  }
  if (input.area === 'chats' && action === 'history') {
    const avatar = safeName(input.characterFile, true);
    const chatFile = safeName(input.chatFile).replace(/\.jsonl$/iu, '');
    const limit = Math.max(1, Math.min(80, Math.floor(Number(input.limit) || 40)));
    const history = await request('/api/chats/get', { avatar_url: avatar, file_name: chatFile });
    if (input.allowUninitialized === true && history && typeof history === 'object' && !Array.isArray(history) && Object.keys(history).length === 0) return { messages: [], totalMessages: null, historyAvailable: false, pendingCreation: true, warning: '这段新聊尚未获得可读取的历史；这里只显示角色卡开场白，发送后再核对真实记录。' };
    if (!Array.isArray(history)) throw new Error('酒馆没有返回有效聊天记录，未当作空记录。');
    const rows = history.filter(row => typeof row?.is_user === 'boolean' && typeof row.mes === 'string');
    return { historyAvailable: true, messages: rows.slice(-limit).map(row => ({ name: String(row.name || ''), role: row.is_user ? 'user' : 'assistant', content: row.mes.slice(0, 8000), truncated: row.mes.length > 8000 })), totalMessages: rows.length, truncated: rows.length > limit };
  }
  if (input.area === 'settings') {
    const read = async () => {
      const result = await request('/api/settings/get', {});
      return plain(typeof result.settings === 'string' ? JSON.parse(result.settings) : result.settings);
    };
    const settings = await read();
    if (action === 'get') return { settings: redact(settings) };
    if (action === 'set') {
      const patch = plain(input.patch);
      if (input.confirm !== true) throw new Error('修改酒馆设置前须先获得确认。');
      const rejectSensitivePatch = value => {
        if (!value || typeof value !== 'object') return;
        for (const [key, item] of Object.entries(value)) {
          if (SENSITIVE.test(key) || key === 'extension_settings') throw new Error('密钥与扩展设置请在酒馆原设置界面操作。');
          rejectSensitivePatch(item);
        }
      };
      rejectSensitivePatch(patch);
      const changed = { ...settings, ...patch };
      await request('/api/settings/save', changed);
      const check = await read();
      if (Object.entries(patch).some(([k, v]) => JSON.stringify(check[k]) !== JSON.stringify(v))) throw new Error('酒馆设置回查未匹配，保存结果无法确认。');
      return { ok: true, reloadNeeded: true, settings: redact(check) };
    }
  }
  throw new Error('不支持的酒馆操作。');
}

export async function runWorker(requestPath, resultPath) {
  let output;
  try {
    const stat = await fs.stat(requestPath);
    if (stat.size > 24 * 1024 * 1024) throw new Error('酒馆操作请求过大。');
    const input = JSON.parse(await fs.readFile(requestPath, 'utf8'));
    output = { ok: true, data: await executeAdmin(input) };
  } catch (error) { output = { ok: false, error: error?.message || '酒馆操作失败。' }; }
  const temp = resultPath + '.tmp';
  await fs.writeFile(temp, JSON.stringify(output), { mode: 0o600 });
  await fs.rename(temp, resultPath);
  console.log('HANABREW_ADMIN_DONE');
}
const direct = process.argv[1] && await fs.realpath(process.argv[1]).catch(() => '') === await fs.realpath(fileURLToPath(import.meta.url));
if (direct) {
  const [requestPath, resultPath] = process.argv.slice(2);
  if (!requestPath || !resultPath || path.dirname(path.resolve(requestPath)) !== path.dirname(path.resolve(resultPath))) throw new Error('操作任务路径无效。');
  await runWorker(requestPath, resultPath);
}
