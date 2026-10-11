import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { activeScope, theaterRequest, handoffText, visitorAvailability, migrationRequest, initWorkbenchFeatures } from '../ui/workbench-features.js';

const html = fs.readFileSync(new URL('../ui/workbench.html', import.meta.url), 'utf8');
const source = fs.readFileSync(new URL('../ui/workbench-features.js', import.meta.url), 'utf8');

test('workbench keeps one function-panel document and exposes only available entries', () => {
  assert.doesNotMatch(html + source, /测卡示例还在迁移|cards\.open|window\.open|<aside/);
  for (const id of ['cardLab', 'migrationManager']) assert.match(html, new RegExp(`id="${id}"`));
  assert.doesNotMatch(html, /id="visitorManager"/);
  assert.match(html, /更多工具<\/span><span class="hint">2 项/);
  assert.match(source, /bind\('cardLab', openTheaterGuide\)/);
  assert.doesNotMatch(source, /bind\('visitorManager', openVisitors\)/);
  assert.match(html, /茶话会/);
  assert.match(html, /\.row \{[^}]+flex-wrap: nowrap/);
  assert.match(html, /prefers-reduced-motion/);
  assert.match(html, /section\.inert = on/);
  const script = html.match(/<script type="module">([\s\S]*?)<\/script>/)[1].replace(/import \{ hana \} from "\.\/assets\/sdk\.js";/, '');
  assert.doesNotThrow(() => new vm.Script(script));
});

test('only an explicit SDK active session can create scope', () => {
  for (const input of [null, {}, { sessionId: 's' }, { sessionPath: 'p' }]) assert.throws(() => activeScope(input), /没有绑定/);
  assert.deepEqual(activeScope({ sessionId: 's', sessionPath: 'p', agentId: 'a', title: 'private' }), { sessionId: 's', sessionPath: 'p', agentId: 'a' });
});

test('UI submit uses target fields, never asks people to supply turns or reads transcripts', () => {
  const input = theaterRequest({ characterFile: 'target.png', mode: 'scripted', testType: 'mvu', pace: '保持克制', objective: '  看变量  ', turns: ['fake'] });
  assert.deepEqual(input, { characterFile: 'target.png', mode: 'scripted', testType: 'mvu', pace: '保持克制', objective: '看变量' });
  assert.throws(() => theaterRequest({ mode: 'scripted' }), /先选/);
  assert.match(handoffText(input, 'r1'), /hanabrew-card-test/);
  assert.match(handoffText(input, 'r1'), /真实 turns/);
  assert.match(handoffText({ ...input, mode: 'duet' }, 'r2'), /hanabrew-duet-start/);
  assert.doesNotMatch(source, /history\.messages|session:history|api\/plugins|bus\.request/);
});

test('host visibility restrictions cannot be unlocked by UI loading or repair', () => {
  assert.deepEqual(visitorAvailability({ unavailableReason: '旧档不属于本应用' }), { available: false, reason: '旧档不属于本应用' });
  assert.equal(visitorAvailability({ available: false }).available, false);
  assert.equal(visitorAvailability({}).available, true);
  assert.match(source, /修复不会改变宿主可见性/);
});

test('migration uses categories and only skip policy; credentials require explicit selection', () => {
  const preview = { previewId: 'p1', available: true };
  assert.deepEqual(migrationRequest(preview, [{ category: 'characters', checked: true }, { category: 'settings', checked: false }, { category: 'credentials', checked: false }]), { previewId: 'p1', selections: ['characters'], conflicts: 'skip', allowSecrets: false });
  assert.equal(migrationRequest(preview, [{ category: 'credentials', checked: true }]).allowSecrets, true);
  assert.throws(() => migrationRequest({ ...preview, available: false }, [{ category: 'chats', checked: true }]), /未就绪/);
  assert.throws(() => migrationRequest(preview, [{ category: 'extensions', checked: true }]), /没有选择/);
  assert.doesNotMatch(source, /conflicts: 'overwrite'/);
  assert.match(source, /!\['settings', 'credentials'\]\.includes\(category\)/);
});

// 小型 DOM 替身只覆盖真实业务交互，不把字符串匹配当作点击验证。
class Node {
  constructor(tag = 'div') { this.tag = tag; this.children = []; this.listeners = {}; this.hidden = false; this.disabled = false; this.value = ''; this.checked = false; this.textContent = ''; this.scrollHeight = 0; this.scrollTop = 0; this.clientHeight = 0; }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children = nodes; }
  addEventListener(name, callback) { this.listeners[name] = callback; }
  async click() { if (!this.disabled) return this.listeners.click?.(); }
}
function harness({ active = { sessionId: 's1', sessionPath: 'p1', agentId: 'a' }, chat = true, response = {} } = {}) {
  const elements = new Map();
  const node = id => { if (!elements.has(id)) elements.set(id, new Node()); return elements.get(id); };
  const selected = name => {
    const walk = element => {
      if (element.name === name && element.checked) return element;
      for (const child of element.children || []) { const result = walk(child); if (result) return result; }
      return null;
    };
    for (const element of elements.values()) { const found = walk(element); if (found) return found; }
    return null;
  };
  globalThis.document = { getElementById: node, createElement: tag => new Node(tag), createTextNode: text => ({ textContent: text }), querySelectorAll: () => [], querySelector: selector => selected(selector.match(/name="([^"]+)"/)[1]) };
  globalThis.window = { confirm: () => true, addEventListener: () => {} };
  const requests = [], statuses = [], sends = [], timers = [];
  const oldTimer = globalThis.setTimeout;
  globalThis.setTimeout = callback => { timers.push(callback); return 1; };
  const call = async route => {
    requests.push(['GET', route]);
    if (route.startsWith('/theater/current')) return response['/theater/current'] || { runs: [] };
    if (route === '/workbench/characters') return { characters: [{ name: '测试角色', file: 'card.png' }] };
    if (route === '/workbench/visitors') return { visitors: [{ name: '访客', agentId: 'a1', unavailableReason: '宿主拒绝旧档' }] };
    if (route.startsWith('/theater/progress')) return { runId: 'r', mode: 'scripted', status: 'done', scenes: [{ index: 1, user: '<script>test</script>', reply: '真实回复', variablesAfter: null }] };
    return {};
  };
  const post = async (route, input) => {
    requests.push(['POST', route, input]);
    if (route === '/theater/handoff') {
      if (!chat) throw new Error('交接请求被宿主拒绝');
      sends.push(input);
      return response[route] || { accepted: true };
    }
    return response[route] || { runId: 'r', mode: input.mode, status: 'waiting' };
  };
  let changed;
  let activeReads = 0;
  const hana = { sessions: { getActive: async () => { activeReads += 1; return active; }, onActiveChanged: callback => { changed = callback; } } };
  const say = message => statuses.push(message);
  const guard = async task => { try { await task(); } catch (error) { say(error.message); } };
  const action = (label, task) => { const button = new Node('button'); button.textContent = label; button.addEventListener('click', () => guard(task)); return button; };
  initWorkbenchFeatures({ hana, call, post, say, show: () => {}, guard, action });
  return { node, selected, requests, statuses, sends, changed, activeReads: () => activeReads, setActive: next => { active = next; }, cleanup: () => { globalThis.setTimeout = oldTimer; delete globalThis.document; delete globalThis.window; } };
}
const descendants = node => [node, ...(node.children || []).flatMap(child => descendants(child))];

test('clicking card lab only opens the guide: no request, no session read, no task', async () => {
  const h = harness();
  try {
    await h.node('cardLab').click();
    assert.deepEqual(h.requests, [], '说明入口不该发任何请求');
    assert.equal(h.activeReads(), 0, '说明入口不该读当前会话');
    assert.equal(h.changed, undefined, '不再订阅会话变化');
    assert.equal(h.sends.length, 0);
    assert.match(h.statuses.at(-1), /测卡/);
  } finally { h.cleanup(); }
});

test('the guide needs no active session and creates no pending job', async () => {
  const missing = harness({ active: null });
  try {
    await missing.node('cardLab').click();
    assert.equal(missing.requests.length, 0);
    assert.equal(missing.activeReads(), 0);
    assert.equal(missing.requests.some(([method]) => method === 'POST'), false);
    assert.doesNotMatch(missing.statuses.at(-1), /没有绑定|错误/);
  } finally { missing.cleanup(); }
});

test('the theater panel keeps only the guide: old controls and polling are gone', async () => {
  assert.doesNotMatch(html, /theaterRefresh|theaterContinue|theaterEnd|theaterReset|theaterProgress|theaterSelection|theaterTranscript|theaterObjective/);
  assert.doesNotMatch(source, /\/theater\/(submit|handoff|progress|current|control)/);
  assert.doesNotMatch(source, /onActiveChanged|setTimeout/);
  assert.match(html, /id="cardLab"[\s\S]*?测卡与代笔怎么用[\s\S]*?回到对话里说需求/);
});

test('the guide only explains how to start: nothing is picked, submitted or tracked here', async () => {
  const panel = html.match(/<section class="panel" id="theaterPanel"[\s\S]*?<\/section>/)[0];
  for (const phrase of ['帮我测一下这张角色卡', '看看角色卡变量有没有生效', '帮我代笔对戏']) assert.match(panel, new RegExp(phrase));
  assert.match(panel, /这页只讲怎么开口/);
  assert.doesNotMatch(panel, /配方/);
  assert.match(panel, /怎么用/);
  assert.match(panel, /结论和需要你拍板的关键选择/);
  assert.match(panel, /不会在这里创建、取消或清理任务/);
  // 不拿「代码还在」当「后台在跑」，也不对没出现的东西猜具体原因。
  assert.doesNotMatch(panel, /仍然在跑|还在路上|暂时没出现|说明它/);
  assert.doesNotMatch(panel, /启动|复制|http/);
});

test('visit-management entry is hidden while its implementation and panel remain', () => {
  assert.doesNotMatch(html, /id="visitorManager"/);
  assert.match(html, /id="visitorPanel"/);
  assert.match(source, /async function openVisitors\(\)/);
  assert.match(source, /call\('\/workbench\/visitors'\)/);
  assert.match(source, /post\('\/workbench\/invite'/);
});

test('migration renders conflicts and sensitive categories unchecked by default', async () => {
  const h = harness({ response: { '/migration/preview': { previewId: 'p', available: true, categories: [
    { category: 'characters', count: 1, conflicts: 1, selectedByDefault: true },
    { category: 'settings', count: 1, selectedByDefault: true }, { category: 'credentials', count: 1, selectedByDefault: true },
  ], files: [{ category: 'characters', file: 'same.png', conflict: true }] }, '/migration/apply': { ok: true, complete: true, copied: [], skipped: ['same.png'], failed: [], restartNeeded: true } } });
  try {
    await h.node('migrationManager').click();
    const checkboxes = descendants(h.node('migrationPreview')).filter(node => node.type === 'checkbox');
    assert.deepEqual(checkboxes.map(node => node.checked), [true, false, false]);
    await h.node('migrationApply').click();
    const request = h.requests.find(([, route]) => route === '/migration/apply')[2];
    assert.deepEqual(request.selections, ['characters']); assert.equal(request.allowSecrets, false); assert.equal(request.conflicts, 'skip');
    assert.match(h.node('migrationResult').textContent, /没有自动重启/); assert.equal(h.node('migrationApply').disabled, true);
  } finally { h.cleanup(); }
});
