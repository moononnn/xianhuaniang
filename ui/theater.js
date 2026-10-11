// 鲜花酿 · 小剧场（流内卡：选择页与过程页）
//
// 与旧版插件版的差别只有三处，都是通道不同、业务没变：
//   1. 取数走 hana.api.fetch（旧版是插件页裸 fetch）
//   2. 角色卡列表读 App 自己的 /workbench/characters（旧版读插件 backend）
//   3. 提交拆成 submit 建任务 + handoff 送回对话两步（后端本来就两步）
//
// 会话身份：流内卡的 route 由宿主拼装，不带任何查询参数，所以不能像旧版那样
// 从 URL 读 sessionId。这里优先取宿主给 iframe 盖章的来源会话；拿不到就把提交
// 按钮锁掉并说明原因，绝不猜一个会话发过去。
import { hana } from './assets/sdk.js';

hana.ready();

const api = hana?.api;
const $ = id => document.getElementById(id);

const TESTS = {
  mvu: { label: 'MVU 变量', note: '检查变量是否按条件变化', items: [] },
  duet: {
    label: '代笔对戏',
    note: '你定方向，小花替你开口',
    items: [
      ['自由发展', '普通回合自动继续，重大剧情才停下来问你'],
      ['慢慢推进', '节奏放缓但连续推进，关键剧情才停下来问你'],
      ['保持克制', '每轮保留方向控制，敏感变化前先停下来'],
    ],
  },
  persona: { label: '人设稳定', note: '检查说话方式和行为边界', items: [['日常回应', '检查普通聊天中的语气与行为'], ['情绪波动', '检查压力或安慰场景'], ['原则冲突', '检查核心设定是否稳定']] },
  opening: { label: '开场白', note: '检查第一幕是否自然接住', items: [['初次见面', '检查开场白与第一句回应'], ['续接开场', '检查开场情境能否自然延续']] },
  worldbook: { label: '世界书', note: '检查设定是否被正确触发', items: [['关键词触发', '检查相关设定是否出现'], ['设定冲突', '检查多条设定同时出现时的优先级']] },
  scene: { label: '场景逻辑', note: '检查事件推进是否合理', items: [['关系推进', '检查事件后的态度变化'], ['冲突处理', '检查矛盾升级与收束'], ['日常互动', '检查场景细节和连续性']] },
  boundary: { label: '边界情况', note: '检查冲突、拒绝和异常输入', items: [['拒绝请求', '检查角色拒绝是否符合人设'], ['异常输入', '检查突然转向时能否稳住'], ['沉默冷场', '检查角色如何处理停顿']] },
};
const TEST_ORDER = ['mvu', 'duet', 'persona', 'opening', 'worldbook', 'scene', 'boundary'];

let characters = [];
let selectedCharacter = '';
let selectedTest = 'mvu';
let selectedDetail = '';
let activeProgress = null;
let pollTimer = null;
let pollFailures = 0;
let pollInFlight = false;
let waitingSince = 0;
const WAITING_TIMEOUT_MS = 5 * 60 * 1000;

function escapeText(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function formatText(value) { return escapeText(value).replace(/\r?\n/g, '<br>'); }
function showStatus(message, isError) {
  const status = $('status');
  status.textContent = message || '';
  status.className = 'status' + (isError ? ' error' : '');
}
function setSelected(selector, attr, value) {
  document.querySelectorAll(selector).forEach(el => el.classList.toggle('selected', el.getAttribute(attr) === value));
}
function currentCharacter() {
  return characters.find(c => c.file === selectedCharacter) || characters[0] || null;
}

async function call(path, init = {}) {
  if (!api?.fetch) throw new Error('这个卡片没有拿到 Hana App 请求桥接，请重新打开小剧场。');
  const response = await api.fetch(path, init);
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.ok === false) {
    const error = new Error(data.error || `请求失败（${response.status}）`);
    error.status = response.status;
    throw error;
  }
  return data;
}
const post = (path, body) => call(path, { method: 'POST', body: JSON.stringify(body || {}) });

// 流内卡刚挂载时 hana.surface.getContext() 会返回 null，宿主随后用
// onContextChanged 补发一次带 originSessionId 的上下文。所以身份要缓存起来，
// 之后每次读都拿缓存，不能只看那一瞬间的同步取值。
let surfaceCtxCache = null;

/** 流内形态下宿主盖章的会话身份：只认盖章的值，取不到就说取不到。 */
function surfaceSessionId() {
  const query = new URLSearchParams(location.search);
  if (query.get('sessionId')) return query.get('sessionId');
  const surface = surfaceContext();
  if (!surface) return '';
  return surface.originSessionId || surface.sessionId
    || (surface.embeddedSessionId ? surface.embeddedSessionId : '')
    || '';
}
/** 已经定下来的归属会话：定了就不漂移，轮询和提交都读它。 */
const sessionGate = { id: '', source: '', form: '' };

function currentSessionId() {
  return sessionGate.id || surfaceSessionId();
}
function surfaceContext() {
  try {
    const live = hana?.surface?.getContext?.() || null;
    if (live) surfaceCtxCache = live;
  } catch { /* 取不到就用缓存 */ }
  return surfaceCtxCache;
}
/**
 * 会话身份的获取顺序：宿主盖章 > 取出的卡片按当前活跃对话 > 拿不到就报实话。
 *
 * 取出（detached）形态下实测宿主不再盖章归属：上下文里
 * originSessionId / embeddedSessionId 都是 null，只有
 * viewState.viewKind = "detached"。这种形态下卡片已经不属于任何一段对话，
 * 只能按用户此刻正在看的那段对话归属，所以走 hana.sessions.getActive() ，
 * 并在界面上写明，免得当成“它自己知道”默默送错地方。
 */
/**
 * 会话身份探测留痕：宿主到底是回空、还是明确拒绝、还是一直没回，全记下来。
 * 这里原来是空 catch，界面只剩一句“没绑定到对话”，真正的原因被吞掉了，
 * 取出形态下没法判断卡在哪一道门。
 */
let sessionProbe = null;
function noteProbe(patch) {
  sessionProbe = Object.assign({ at: new Date().toISOString() }, sessionProbe || {}, patch);
}
function clipProbe(value) {
  try {
    const text = JSON.stringify(value ?? null);
    if (typeof text !== 'string') return '[unserializable]';
    return text.length > 1500 ? `${text.slice(0, 1500)}…` : text;
  } catch { return '[unserializable]'; }
}

async function resolveSessionIdentity() {
  const direct = surfaceSessionId();
  if (direct) return { id: direct, source: 'surface', form: 'stamped' };
  const surface = surfaceContext();
  const viewKind = surface?.viewState?.viewKind || (surface ? '(no-view-state)' : '(no-context)');
  const hasGetActive = Boolean(hana?.sessions?.getActive);
  noteProbe({
    viewKind,
    hasGetActive,
    originSessionId: surface?.originSessionId ?? null,
    embeddedSessionId: surface?.embeddedSessionId ?? null,
  });
  // 不限形态：只要拿不到盖章身份就问一次。取出形态宿主只给 viewState=detached，
  // 重载后残留的卡片甚至会完全不给上下文；这两种情况都得问，不能只在 detached 时才问。
  if (hasGetActive) {
    noteProbe({ getActive: 'pending' });
    try {
      const active = await hana.sessions.getActive();
      noteProbe({ getActive: 'resolved', result: clipProbe(active) });
      const id = String(active?.sessionId || active?.originSessionId || active?.activeSessionId || active?.id || '');
      // detached 才是真·取出形态；没盖章又没上下文时只是兜底，不能对用户说“你取出来了”。
      if (id) return { id, source: 'active', form: viewKind === 'detached' ? 'detached' : 'unverified' };
    } catch (error) {
      noteProbe({ getActive: 'error', errorCode: error?.code ?? null, errorMessage: String(error?.message || error) });
    }
  }
  return { id: '', source: '' };
}

let gateBusy = false;
/**
 * 卡片被收回再打开、或宿主重启后重建时，URL 里的 runId 会丢，卡片就迷路回到选角色页。
 * 身份一到手就问后端要当前会话还在跑的那一场，有就直接接回过程页。
 * 问不到就照常停在选角色页，不拿猜测冒充恢复。
 */
let resumeAttempted = false;
async function tryResumeActive() {
  if (resumeAttempted || activeProgress) return;
  if (new URLSearchParams(location.search).get('runId')) return;
  const sessionId = currentSessionId();
  if (!sessionId) return;
  resumeAttempted = true;
  try {
    const query = new URLSearchParams({ sessionId });
    const data = await call(`/theater/current?${query.toString()}`);
    const active = data && data.active;
    if (!active || !active.runId) return;
    const nextUrl = new URL(location.href);
    nextUrl.searchParams.set('runId', active.runId);
    history.replaceState(null, '', nextUrl.toString());
    if (active.characterFile) selectedCharacter = active.characterFile;
    enterChat(active);
    if (!['done', 'ended', 'error'].includes(active.status)) startPolling();
  } catch { /* 问不到就往选择页走 */ }
}
/**
 * 会话身份到手就把提交按钮解锁、撤掉占位提示。
 * 宿主补发身份的时机不固定（可能晚几秒，可能只有 onContextChanged 那一次），
 * 所以解锁逻辑单独抽出来，订阅回调和兜底轮询都走它，谁先到谁解锁。
 */
async function applySessionGate() {
  if (sessionGate.id) return true;
  if (gateBusy) return false;
  gateBusy = true;
  try {
    const { id, source, form } = await resolveSessionIdentity();
    if (!id) return false;
    sessionGate.id = id;
    sessionGate.source = source;
    sessionGate.form = form || '';
    const button = $('handoff');
    if (button && button.disabled) button.disabled = false;
    // 身份到手才问得了「当前会话还有没有在跑的对戏」，恢复也挂在这一步。
    tryResumeActive().catch(() => { /* 恢复不了就停在选择页 */ });
    const status = $('status');
    if (status && !status.classList.contains('error')) {
      const placeholder = /正在向宿主确认/.test(status.textContent || '');
      if (source === 'active' && placeholder) {
        showStatus(sessionGate.form === 'detached'
          ? '这张卡是取出来的形态，已按你当前正在看的对话归属；要测别处就先切到那段对话再点。'
          : '宿主没有给这张卡盖章归属，已按你此刻正在看的那段对话来算；要测别处就先切到那段对话再点。', false);
      } else if (placeholder) {
        showStatus('', false);
      }
    }
    return true;
  } finally {
    gateBusy = false;
  }
}

function watchSurfaceContext(onChange) {
  if (!hana?.surface?.onContextChanged) return;
  try {
    hana.surface.onContextChanged(ctx => {
      if (ctx) surfaceCtxCache = ctx;
      applySessionGate();
      try { onChange(ctx); } catch { /* 身份到手后的收尾失败不阻塞页面 */ }
    });
  } catch (error) {
    showStatus(`没法向宿主订阅这张卡的会话身份：${error?.message || error}`, true);
  }
}
const scope = () => ({ sessionId: currentSessionId() });

// 诊断：卡片 URL 里自带宿主签的 surface 票据（明文里带 sessionId），
// 但 surface context 是 null。把所有可能的取法一次试完回传，避免再来回重启。
function ticketClaims() {
  const search = new URLSearchParams(location.search);
  const raw = (location.pathname.match(/_surface\/([^/]+)\//) || [])[1]
    || search.get('appSurfaceSession') || '';
  let json = null;
  try {
    const b64 = raw.replace(/-/g, '+').replace(/_/g, '/');
    json = JSON.parse(atob(b64.split('.')[0]));
  } catch { /* 解不开就如实记 null */ }
  return { raw: String(raw).slice(0, 120), claims: json };
}

async function readSurfaceDiag(reason) {
  const search = new URLSearchParams(location.search);
  const ticket = ticketClaims();
  const report = {
    reason,
    pathname: location.pathname,
    queryKeys: Array.from(search.keys()),
    ticketClaims: ticket.claims,
    surfaceContext: surfaceContext(),
    sessionProbe: sessionProbe ? { ...sessionProbe } : null,
    apiKeys: Object.keys(hana || {}),
    surfaceKeys: hana?.surface ? Object.keys(hana.surface) : [],
    sessionsKeys: hana?.sessions ? Object.keys(hana.sessions) : [],
    stateKeys: hana?.state ? Object.keys(hana.state) : [],
    hostKeys: hana?.host ? Object.keys(hana.host) : [],
  };
  // 候选一：用票据里的 id 问宿主这张卡属于哪段对话。
  if (ticket.claims && hana?.surfaces?.get) {
    try {
      const handle = await hana.surfaces.get({ surfaceId: ticket.claims.sessionId });
      report.surfacesGet = handle ? JSON.parse(JSON.stringify(handle)) : null;
    } catch (error) {
      report.surfacesGetError = String(error?.message || error);
    }
  }
  // 身份订阅由 watchSurfaceContext 独占：这里只读它填好的缓存，
  // 不再自己注册第二个订阅，免得两个回调互相顶掉或者被一处 off 连坐取消。
  report.contextLater = surfaceContext() ? JSON.parse(JSON.stringify(surfaceContext())) : null;
  function emit() {
    report.contextLater = surfaceContext() ? JSON.parse(JSON.stringify(surfaceContext())) : null;
    const node = $('diag');
    if (node) node.textContent = JSON.stringify(report, null, 2);
    post('/theater/diag', report).catch(() => { /* 诊断回传失败不影响页面 */ });
  }
  emit();
  // 订阅类结果会晚到，再补报一次。
  setTimeout(emit, 4500);
  return report;
}

function renderDetails() {
  const config = TESTS[selectedTest];
  let items = config.items.slice();
  if (selectedTest === 'mvu') items = [['运行时变量', '从真实 ST 临时聊天读取 stat_data，读不到会明确标成不可用']];
  $('detail-label').textContent = '3 · ' + (selectedTest === 'mvu' ? '选择要检查的变量' : config.label);
  $('details').innerHTML = items.map(item => {
    const value = Array.isArray(item) ? item[0] : item;
    const note = Array.isArray(item) ? `<small>${escapeText(item[1])}</small>` : '';
    return `<button type="button" class="choice" data-detail="${escapeText(value)}"><span>${escapeText(value)}</span>${note}</button>`;
  }).join('');
  selectedDetail = items.length ? (Array.isArray(items[0]) ? items[0][0] : items[0]) : '';
  setSelected('[data-detail]', 'data-detail', selectedDetail);
  if ($('handoff')) $('handoff').textContent = selectedTest === 'duet' ? '发给小花开始对戏' : '发给小花开始测试';
}

function renderCharacters() {
  const holder = $('characters');
  holder.replaceChildren();
  if (!characters.length) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = '酒馆里还没有角色卡，请先导入或创建一张。';
    holder.append(empty);
    return;
  }
  for (const character of characters) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'choice character-choice' + (character.file === selectedCharacter ? ' selected' : '');
    button.setAttribute('data-character', character.file);
    const title = document.createElement('span');
    title.textContent = character.name || character.file;
    const note = document.createElement('small');
    note.textContent = character.description ? '可测人设与场景' : '可测人设与场景';
    button.append(title, note);
    holder.append(button);
  }
}

function valueText(value) {
  if (value === null || value === undefined) return '未读取';
  if (typeof value === 'object') { try { return JSON.stringify(value); } catch { return String(value); } }
  return String(value);
}
function duetNeedsCheckpoint(progress) { return Boolean(progress && progress.needsUserCheckpoint); }
function duetHasRoom(progress) {
  if (!progress) return true;
  const max = Number(progress.maxAutoRounds || 0);
  if (!max) return true;
  return Number(progress.autoRoundsSinceCheckpoint || 0) < max;
}
function duetAutoContinue(progress) { return !duetNeedsCheckpoint(progress) && duetHasRoom(progress); }
function renderChanges(changes) {
  if (!Array.isArray(changes) || !changes.length) return '';
  return '<div class="scene-note">变量变化：' + changes.map(change =>
    `<span>${escapeText(change.key)}：${escapeText(valueText(change.before))} → ${escapeText(valueText(change.after))}</span>`).join(' · ') + '</div>';
}
function messageHtml(author, content, kind, pending) {
  return '<article class="message ' + kind + '">' +
    '<div class="message-meta"><span>' + escapeText(author) + '</span></div>' +
    '<div class="message-body' + (pending ? ' pending' : '') + '">' + (pending ? escapeText(content) : formatText(content)) + '</div>' +
    '</article>';
}
function renderChat(progress) {
  if (!progress) return;
  const list = $('chat-list');
  const wasNearBottom = !list || list.scrollHeight - list.scrollTop - list.clientHeight < 48;
  const oldScrollTop = list ? list.scrollTop : 0;
  const characterName = progress.characterName || (currentCharacter() && currentCharacter().name) || '角色卡';
  const isDuet = progress.mode === 'duet' || progress.testType === 'duet';
  // 取出形态只能回看：没有会话归属，提交不了，所以文案和按钮都按只读处理。
  const isBoard = progress.board === true;
  $('chat-title').textContent = characterName + (isBoard ? ' · 过程回看' : isDuet ? ' · 代笔对戏' : ' · 测试过程');
  const duetText = (progress.paceLabel ? `当前节奏：${progress.paceLabel}。` : '') + (duetNeedsCheckpoint(progress)
    ? '这一小节已推进到安全上限，回主对话决定下一步。'
    : duetAutoContinue(progress)
      ? '普通回合会自动继续，到了关键剧情再回主对话请你拍板。'
      : '每轮保留方向控制，出现敏感变化前会先停下来。');
  $('chat-description').textContent = isBoard
    ? '这是这张卡最近一次跑完的过程回看。它是取出来的形态，和对话断了联系，只能看，不能发起新的测卡。要开始新的，把卡片放回对话里，或在对话里直接说「帮我测一下这张角色卡」。'
    : isDuet ? duetText : '这里显示小花实际发出的测试台词和角色卡的逐幕回复。判断、问题和建议会在主对话里说明。';
  $('chat-eyebrow').textContent = isBoard ? '鲜花酿 · 取出回看'
    : progress.status === 'done' ? '鲜花酿 · 测试完成'
    : progress.status === 'ended' ? '鲜花酿 · 对戏结束'
    : progress.status === 'error' ? (isDuet ? '鲜花酿 · 对戏未完成' : '鲜花酿 · 测卡未完成')
    : isDuet ? '鲜花酿 · 代笔对戏' : '鲜花酿 · 实时测卡';
  const scenes = Array.isArray(progress.scenes) ? progress.scenes : [];
  const html = [];
  if (progress.opening) html.push(messageHtml(characterName, progress.opening, 'from-character', false));
  scenes.forEach(scene => {
    html.push(messageHtml((isDuet ? '小花代笔 · 第 ' : '小花 · 第 ') + scene.index + ' 幕', scene.user || '', 'from-tester', false));
    html.push(messageHtml(characterName, scene.reply || '（角色没有返回可见正文）', 'from-character', false));
    html.push(renderChanges(scene.variableChanges));
  });
  const active = progress.activeScene;
  const activeIndex = active && Number(active.index);
  if (active && !scenes.some(scene => Number(scene.index) === activeIndex)) {
    html.push(messageHtml((isDuet ? '小花代笔 · 第 ' : '小花 · 第 ') + active.index + ' 幕', active.user || '', 'from-tester', false));
    html.push(messageHtml(characterName, '正在生成这一幕的回复…', 'from-character', true));
  }
  if (!html.length) {
    const emptyText = progress.status === 'waiting' ? '小花正在准备测试台词…'
      : progress.status === 'waiting_for_direction' && isDuet
        ? (duetNeedsCheckpoint(progress) ? '这一小节先停在这里，等你决定下一步…'
          : scenes.length && duetAutoContinue(progress) ? '小花会按当前节奏继续推进…' : '等你告诉小花，这场戏接下来往哪边走…')
        : progress.status === 'error' ? '这次测试没有留下可显示的过程。' : '正在连接真实 SillyTavern…';
    html.push('<div class="chat-empty">' + emptyText + '</div>');
  }
  list.innerHTML = html.join('');
  let state = isDuet ? (duetAutoContinue(progress) ? '按当前节奏推进中' : '等待你的方向') : '等待开始';
  if (progress.status === 'running') {
    state = active
      ? (isDuet ? (duetAutoContinue(progress) ? '自动推进第 ' : '正在等角色回应第 ') : '正在测试第 ') + active.index + ' 幕'
      : '正在准备真实酒馆…';
  }
  if (progress.status === 'waiting_for_direction' && isDuet) {
    state = scenes.length
      ? (duetNeedsCheckpoint(progress) ? '这一小节已暂停，等你决定下一步'
        : duetAutoContinue(progress) ? '普通回合会自动继续，关键剧情再等你拍板' : '等你决定下一步怎么演')
      : '等你给这场戏一句方向';
  }
  if (progress.status === 'interrupted') state = isDuet ? '这场对戏被宿主重启打断了，回主对话决定接着推还是结束它' : '这次测卡被重启打断了，回主对话决定下一步';
  if (progress.status === 'done') state = '测试过程已完成，结论在主对话里';
  if (progress.status === 'ended') state = '这场对戏已结束，临时聊天已清理';
  if (progress.status === 'error') state = (isDuet ? '对戏未完成：' : '测试未完成：') + (progress.error || '真实测卡失败');
  $('chat-status').textContent = state;
  $('chat-status').className = 'chat-status' + (!isBoard && progress.status === 'error' ? ' error' : '');
  if (isBoard) $('chat-status').textContent = '这里是回看，不是实时过程；结论和判断在主对话那边。';
  $('chat-reopen').hidden = !isBoard && progress.status !== 'error';
  $('chat-end').hidden = isBoard || !isDuet || ['ended', 'done'].includes(progress.status);
  if (wasNearBottom) list.scrollTop = list.scrollHeight;
  else list.scrollTop = oldScrollTop;
}
function enterChat(progress) {
  activeProgress = progress;
  pollFailures = 0;
  waitingSince = progress.status === 'waiting' ? Date.now() : 0;
  document.body.setAttribute('data-mode', 'chat');
  $('selection-screen').hidden = true;
  $('chat-screen').hidden = false;
  renderChat(progress);
}
function stopPolling() { if (pollTimer) clearInterval(pollTimer); pollTimer = null; }

/**
 * 取出形态的看板。这种形态拿不到会话归属，宿主也不给活跃对话（实测），
 * 所以提交不了；但最近一次跑完的过程还能回看。
 * 只读应用自己的成绩单，不依赖会话身份，也不给任何写入或提交入口。
 */
async function renderBoard() {
  try {
    const data = await call('/theater/latest');
    const report = data && data.report;
    if (!report) {
      showStatus('这张卡是取出来的，没法发起新的测卡；应用里暂时也没有可回看的测试过程。要开始，请把卡片放回对话里，或在对话里直接说「帮我测一下这张角色卡」。', true);
      return;
    }
    enterChat(Object.assign({}, report, { board: true }));
  } catch (error) {
    showStatus(`取出形态的过程回看没读出来：${error.message || error}。要开始新的测卡，请把卡片放回对话里。`, true);
  }
}
function reopenSelection() {
  stopPolling();
  activeProgress = null;
  waitingSince = 0;
  const nextUrl = new URL(location.href);
  nextUrl.searchParams.delete('runId');
  history.replaceState(null, '', nextUrl.toString());
  document.body.removeAttribute('data-mode');
  $('selection-screen').hidden = false;
  $('chat-screen').hidden = true;
  $('handoff').disabled = false;
  showStatus('可以重新选择角色卡和测试方式。', false);
}

async function endDuet() {
  if (!activeProgress || !activeProgress.runId) return;
  if (!window.confirm('结束这场代笔对戏？临时聊天会被清理，卡片里的过程会保留。')) return;
  const button = $('chat-end');
  button.disabled = true;
  try {
    const payload = await post('/theater/control', { runId: activeProgress.runId, action: 'end', scope: scope() });
    activeProgress = payload;
    renderChat(payload);
    stopPolling();
  } catch (error) {
    showStatus(error.message || '结束对戏失败，请稍后重试。', true);
  } finally {
    button.disabled = false;
  }
}

async function pollProgress() {
  if (!activeProgress || !activeProgress.runId || pollInFlight) return;
  if (activeProgress.board === true) return;
  if (activeProgress.status === 'waiting' && waitingSince && Date.now() - waitingSince > WAITING_TIMEOUT_MS) {
    activeProgress = Object.assign({}, activeProgress, { status: 'error', error: '小花还没有开始这次测卡，请重新打开小剧场重试。' });
    stopPolling();
    renderChat(activeProgress);
    return;
  }
  pollInFlight = true;
  try {
    const query = new URLSearchParams({ runId: activeProgress.runId, sessionId: currentSessionId() });
    const payload = await call(`/theater/progress?${query.toString()}`);
    pollFailures = 0;
    if (payload.status !== 'waiting') waitingSince = 0;
    activeProgress = payload;
    renderChat(payload);
    if (['done', 'ended', 'error'].includes(payload.status)) stopPolling();
  } catch (error) {
    if (!activeProgress || ['done', 'ended', 'error'].includes(activeProgress.status)) return;
    if (error.status === 404) {
      activeProgress = Object.assign({}, activeProgress, { status: 'error', error: '这次测试记录已过期或 Hana 刚刚重启，请重新打开小剧场。' });
      stopPolling();
      renderChat(activeProgress);
      return;
    }
    pollFailures += 1;
    if (pollFailures >= 8) {
      activeProgress = Object.assign({}, activeProgress, { status: 'error', error: '暂时无法读取测试过程，请重新打开小剧场重试。' });
      stopPolling();
      renderChat(activeProgress);
      return;
    }
    $('chat-status').textContent = '暂时读不到测试过程，正在重试…';
  } finally {
    pollInFlight = false;
  }
}
function startPolling() {
  stopPolling();
  pollFailures = 0;
  if (activeProgress && activeProgress.status === 'waiting' && !waitingSince) waitingSince = Date.now();
  pollProgress();
  pollTimer = setInterval(pollProgress, 650);
}

async function sendToHana() {
  const character = currentCharacter();
  if (!character) { showStatus('酒馆里还没有可测试的角色卡。', true); return; }
  if (!currentSessionId()) {
    readSurfaceDiag('submit-without-session');
    showStatus(surfaceContext()?.viewState?.viewKind === 'detached'
      ? '这张卡取出来之后没绑定到任何对话。请切到你想测的那段对话再点一次，或者在对话里直接说「帮我测一下这张角色卡」。'
      : '这张卡没有绑定到当前对话，无法把测试目标送回去。请在对话里直接说「帮我测一下这张角色卡」。', true);
    return;
  }
  const button = $('handoff');
  const isDuet = selectedTest === 'duet';
  button.disabled = true;
  button.textContent = '正在交给小花…';
  showStatus('正在建立测试过程…', false);
  try {
    const created = await post('/theater/submit', {
      characterFile: character.file,
      mode: isDuet ? 'duet' : 'scripted',
      testType: selectedTest,
      pace: isDuet ? selectedDetail : '',
      objective: selectedDetail,
      scope: scope(),
    });
    const runId = created.runId;
    if (!runId) throw new Error('测试任务没有拿到编号。');
    // 建任务与送回对话分两步：第二步没确认就如实说没确认，不假装已经发起。
    await post('/theater/handoff', { runId, mode: 'start', scope: scope() });
    const nextUrl = new URL(location.href);
    nextUrl.searchParams.set('runId', runId);
    history.replaceState(null, '', nextUrl.toString());
    enterChat(Object.assign({}, created, {
      mode: isDuet ? 'duet' : 'scripted',
      status: isDuet ? 'waiting_for_direction' : 'waiting',
      scenes: [],
      opening: '',
      activeScene: null,
    }));
    startPolling();
  } catch (error) {
    const uncertain = /timeout|aborted|超时/i.test(String(error?.message || error));
    if (uncertain) {
      showStatus('交接状态暂时无法确认，可能已经送达；请先看主对话，不要重复点击。', true);
      button.textContent = '已提交，等待确认…';
      return;
    }
    showStatus(error.message || '交接失败，请直接在当前对话里说测试目标。', true);
    button.disabled = false;
    button.textContent = isDuet ? '发给小花开始对戏' : '发给小花开始测试';
  }
}

// 测试方式的按钮是 boot() 里才生成的，而这段代码在脚本顶部就跑完了：
// querySelectorAll 那一瞬它们还不存在，取到的是空集合，结果一个监听都没绑上，
// 于是七种测试方式里只有默认选中的那个看着是亮着的，其余全点不动。
// 跟下面几组一样改成事件委托，绑在容器上，按钮什么时候生成都不影响。
$('tests').addEventListener('click', event => {
  const el = event.target.closest('[data-test]');
  if (!el) return;
  selectedTest = el.getAttribute('data-test');
  setSelected('[data-test]', 'data-test', selectedTest);
  renderDetails();
});
$('details').addEventListener('click', event => {
  const el = event.target.closest('[data-detail]');
  if (!el) return;
  selectedDetail = el.getAttribute('data-detail');
  setSelected('[data-detail]', 'data-detail', selectedDetail);
});
$('characters').addEventListener('click', event => {
  const el = event.target.closest('[data-character]');
  if (!el) return;
  selectedCharacter = el.getAttribute('data-character');
  setSelected('[data-character]', 'data-character', selectedCharacter);
  renderDetails();
});
$('handoff').addEventListener('click', sendToHana);
$('chat-reopen').addEventListener('click', reopenSelection);
$('chat-end').addEventListener('click', endDuet);

async function boot() {
  const testHolder = $('tests');
  testHolder.innerHTML = TEST_ORDER.map(id =>
    `<button type="button" class="choice${id === selectedTest ? ' selected' : ''}" data-test="${id}"><span>${TESTS[id].label}</span><small>${TESTS[id].note}</small></button>`).join('');
  renderDetails();
  readSurfaceDiag('boot');
  if (!currentSessionId()) {
    $('handoff').disabled = true;
    showStatus('正在向宿主确认这张卡属于哪段对话…', false);
  }
  // 身份是异步补发的：到手就把提交按钮解锁，并撤掉占位提示。
  watchSurfaceContext(() => {});
  // 兜底轮询：有的形态下宿主只在订阅回调里补发一次，有的则是延迟到 getContext()
  // 才肯返回，取出的形态还得等 sessions.getActive()。都走一遍，最多等十秒。
  let gateTries = 0;
  const gateTimer = setInterval(async () => {
    gateTries += 1;
    const done = await applySessionGate();
    if (done || gateTries >= 20) {
      clearInterval(gateTimer);
      if (!done && !currentSessionId()) {
        // 兜底失败也留一份证据：不然只知道“没拿到”，不知道是哪道门卡的。
        readSurfaceDiag('gate-failed');
        showStatus('这张卡取出来之后跟对话断了联系，没法发起新的测卡。下面给你看最近一次跑完的过程；要开始新的，把卡片放回对话里，或在对话里直接说「帮我测一下这张角色卡」。', true);
        renderBoard();
      }
    }
  }, 500);
  try {
    const data = await call('/workbench/characters');
    characters = (data.characters || []).map(card => ({ file: card.file, name: card.name, description: card.description }));
    selectedCharacter = characters.length ? characters[0].file : '';
  } catch (error) {
    characters = [];
    showStatus(`角色卡列表读取失败：${error.message || error}`, true);
  }
  renderCharacters();
  const runId = new URLSearchParams(location.search).get('runId');
  if (!runId) return;
  try {
    const query = new URLSearchParams({ runId, sessionId: currentSessionId() });
    const progress = await call(`/theater/progress?${query.toString()}`);
    if (progress.characterFile) selectedCharacter = progress.characterFile;
    enterChat(progress);
    if (!['done', 'ended', 'error'].includes(progress.status)) startPolling();
  } catch {
    showStatus('这次测试记录已过期，请重新选择目标。', true);
  }
}

boot();
