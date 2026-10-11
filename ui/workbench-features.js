// 工作台的内部业务页：沿用宿主功能面板，不生成第二张卡。
export { handoffText } from './theater-handoff.js';
// 测卡与代笔的选卡、提交与逐幕过程都在对话里那张卡上，工作台不再承担：
// 工作台只留一份「怎么用」的静态说明，不再读会话、不再提交任务、不再轮询进度。
// activeScope / theaterRequest / handoffText 是纯函数，留给迁移中的配方接入复用。
export function activeScope(active) {
  if (!active?.sessionId || !active?.sessionPath) throw new Error('当前没有绑定的 Hana 会话。请先在宿主选择一段对话，再回来开始。');
  return { sessionId: active.sessionId, sessionPath: active.sessionPath, agentId: active.agentId || null };
}
export function theaterRequest(input) {
  if (!input.characterFile) throw new Error('先选一张可用的角色卡。');
  if (!['scripted', 'duet'].includes(input.mode)) throw new Error('测卡模式无效。');
  return { characterFile: input.characterFile, mode: input.mode, testType: input.testType, pace: input.pace, objective: String(input.objective || '').trim() };
}
export function visitorAvailability(visitor) {
  const reason = visitor.unavailableReason || visitor.visibilityReason || '';
  return { available: !reason && visitor.available !== false, reason: reason || (visitor.available === false ? '宿主未开放这份旧档，无法在应用内操作。' : '') };
}
export const MIGRATION_LABELS = { characters: '角色卡', chats: '聊天', worlds: '世界书', themes: '主题', presets: '预设', media: '媒体', settings: '设置', credentials: '连接凭据（敏感）' };
export function migrationRequest(preview, choices) {
  if (!preview?.previewId || !preview.available) throw new Error('旧版资料未就绪，请重新预览。');
  const selections = choices.filter(c => c.checked && Object.hasOwn(MIGRATION_LABELS, c.category)).map(c => c.category);
  if (!selections.length) throw new Error('还没有选择资料。');
  return { previewId: preview.previewId, selections, conflicts: 'skip', allowSecrets: selections.includes('credentials') };
}
export function initWorkbenchFeatures({ hana, call, post, say, show, guard, action }) {
  const $ = id => document.getElementById(id);
  let migration = null;
  let migrationChoices = [];
  const text = (tag, content, className = '') => {
    const node = document.createElement(tag); node.textContent = content; node.className = className; return node;
  };
  const article = (title, description) => {
    const node = text('article', '', 'item'); node.append(text('h2', title));
    if (description) node.append(text('p', description)); return node;
  };
  const row = (...buttons) => { const node = text('div', '', 'row'); node.append(...buttons); return node; };
  const preview = (node, content) => { node.textContent = content; node.hidden = false; };
  const notes = result => (result.notes || []).join('；');
  function bind(id, task) { $(id).addEventListener('click', () => guard(task)); }

  async function openVisitors() {
    show($('visitorPanel')); $('visitorList').replaceChildren(); $('visitorCharacters').replaceChildren();
    const data = await call('/workbench/visitors');
    if (!data.visitors.length) $('visitorList').append(text('p', '暂时没有正在做客的访客。', 'group-title'));
    for (const visitor of data.visitors) {
      const availability = visitorAvailability(visitor);
      const item = article(visitor.name, `${visitor.residence ? '已住下来' : '正在做客'} · ${visitor.sessionTitle || '独立来访会话'}`);
      item.append(text('p', availability.reason || '宿主可见性由 Hana 管理，入住只改变来访人格与台账，不会公开伙伴。'));
      const buttons = [];
      if (visitor.sessionId) buttons.push(action('打开来访会话', async () => {
        if (!hana.sessions?.focus) throw new Error('当前 SDK 没有会话打开接口。');
        await hana.sessions.focus({ sessionId: visitor.sessionId }); say('已切到来访会话。');
      }, true));
      const operate = (label, operation, confirmText) => {
        const button = action(label, async () => {
          if (!window.confirm(confirmText)) return;
          say(`正在为${visitor.name}${label}…`);
          const result = await post(`/workbench/visitors/${operation}`, { agentId: visitor.agentId });
          const record = result.visitor || result;
          say(`${label}请求已返回${notes(record) ? `：${notes(record)}` : '。'}${operation === 'repair' ? '修复不会改变宿主可见性；头像与人格分别以实际回执为准。' : ''}`);
          await openVisitors();
          say(`${label}已处理${notes(record) ? `，仍有未完成项：${notes(record)}` : '。'}${operation === 'settle' ? '入住不会改变宿主公开列表。' : ''}`);
        }, true);
        button.disabled = !availability.available; button.title = availability.reason; buttons.push(button);
      };
      if (!visitor.residence) operate('住下来', 'settle', `让${visitor.name}住下来？会按当前角色卡更新常驻人格，宿主可见性不会改变。`);
      operate(visitor.residence ? '请回去' : '送回酒馆', visitor.residence ? 'uninvite' : 'depart', `送${visitor.name}回去？会归档来访会话并退役访客，保留资料，不写回酒馆。`);
      operate('修一遍', 'repair', `按当前角色卡重写${visitor.name}的访客人格、资料和头像？不会修复宿主可见性限制。`);
      item.append(row(...buttons)); $('visitorList').append(item);
    }
    const cards = await call('/workbench/characters');
    for (const card of cards.characters) {
      const item = article(card.name, card.description || '这张卡没有简介。');
      const pane = text('pre', '', 'preview'); pane.hidden = true;
      const inspect = action('先看看', async () => {
        if (!pane.hidden) { pane.hidden = true; return; }
        say('正在预览角色设定与来访续接信息…');
        const result = await post('/workbench/visitor/preview', { file: card.file });
        // 不展开私人聊天正文，后端只给邀请时的续接统计。
        const c = result.character || {};
        preview(pane, `名字：${c.name || card.name}\n\n设定：${c.description || '（空）'}\n\n性格：${c.personality || '（空）'}\n\n开场：${c.firstMessage || '（空）'}\n\n最近剧情：${result.history?.messageCount || 0} 条用于延续来访；这里不展开聊天正文。`);
        say('已预览。邀请会创建独立来访会话，不改变公开助手列表。');
      }, true);
      const invite = action('邀请来 Hana', async () => {
        if (!window.confirm(`邀请${card.name}来 Hana？将复制角色人格，并读取对应酒馆最近剧情用于独立来访；不会改变原卡或酒馆聊天。`)) return;
        say(`正在邀请${card.name}…`);
        const result = await post('/workbench/invite', { file: card.file });
        await openVisitors();
        say(`${result.name}的独立来访会话已创建。人格${result.persona ? '已写入' : '未写入'}，头像${result.avatar ? '已写入' : '未写入'}，开场${result.opening ? '已写入' : '未写入'}；公开列表可见性没有改变。`);
      });
      const oldVisitor = data.visitors.find(visitor => (visitor.characterId === card.file || visitor.name === card.name) && !visitorAvailability(visitor).available);
      if (card.unavailableReason) { inspect.disabled = true; invite.disabled = true; item.append(text('p', card.unavailableReason)); }
      else if (oldVisitor) { invite.disabled = true; item.append(text('p', oldVisitor.unavailableReason || '对应旧档受宿主限制，无法从这里重新邀请。')); }
      item.append(row(inspect, invite), pane); $('visitorCharacters').append(item);
    }
    say('来访名单已更新。茶话会邀请仍保留原入口。');
  }

  // 只展示怎么用：不发任何请求、不读当前会话、不创建任务。
  async function openTheaterGuide() {
    show($('theaterPanel'));
    say('测卡和代笔都在对话里那张卡上完成，这里只讲怎么开口。');
  }
  // 按迁移服务 categories/files 契约选择分类；同名始终跳过，凭据单独明确授权。
  async function scanMigration() {
    migration = null; migrationChoices = []; $('migrationApply').disabled = true; $('migrationResult').hidden = true;
    $('migrationPreview').replaceChildren(); say('正在预览旧版资料与同名冲突，不会写入…');
    migration = await post('/migration/preview');
    renderMigration(); say('预览完成。确认勾选后才导入，源资料不删除。');
  }
  function renderMigration() {
    const holder = $('migrationPreview'); holder.replaceChildren();
    if (!migration.previewId || !Array.isArray(migration.categories) || !Array.isArray(migration.files)) throw new Error('迁移预览契约未匹配，未启用导入。');
    if (!migration.available) { holder.append(article('旧版资料不可用', migration.message || '没有找到可迁移的源资料。')); return; }
    for (const summary of migration.categories) {
      const category = summary.category;
      if (!Object.hasOwn(MIGRATION_LABELS, category)) continue;
      const field = document.createElement('fieldset'); field.append(text('legend', MIGRATION_LABELS[category]));
      const line = document.createElement('label'); const checkbox = document.createElement('input'); checkbox.type = 'checkbox';
      checkbox.checked = !['settings', 'credentials'].includes(category) && summary.selectedByDefault === true && summary.count > 0;
      checkbox.disabled = !summary.count;
      line.append(checkbox, document.createTextNode(` 导入这类资料 · ${summary.count || 0} 项 · 同名 ${summary.conflicts || 0} 项跳过`)); field.append(line);
      if (category === 'settings') field.append(text('p', '仅明确勾选才导入设置；同名设置已有时保持新版原状，不覆盖。', 'group-title'));
      if (category === 'credentials') field.append(text('p', '敏感：复制连接凭据，可能含服务密钥。仅明确勾选才授权复制，不显示任何密钥；同名仍跳过。', 'group-title'));
      const files = migration.files.filter(file => file.category === category);
      if (files.length) {
        const details = document.createElement('details'); details.append(text('summary', '查看文件与冲突'));
        for (const file of files) details.append(text('p', `${file.file} · ${file.size || 0} 字节${file.conflict ? ' · 新版同名已存在，跳过' : ' · 可导入'}`, 'group-title'));
        field.append(details);
      }
      migrationChoices.push({ category, checkbox }); holder.append(field);
    }
    if (migration.warnings?.length) holder.append(article('需要留意', migration.warnings.join('\n')));
    $('migrationApply').disabled = !migration.categories.some(item => item.count > 0 && Object.hasOwn(MIGRATION_LABELS, item.category));
  }
  function showMigrationReport(result) {
    preview($('migrationResult'), `${result.message || '迁移请求已返回'}\n\n已导入 ${(result.copied || []).length} 项；跳过 ${(result.skipped || []).length} 项；失败 ${(result.failed || []).length} 项。\n${(result.failed || []).map(item => `${item.file}：${item.error}`).join('\n')}\n${result.restartNeeded ? '请在鲜花酿主页面重新打开酒馆；没有自动重启。' : ''}`);
  }
  bind('migrationScan', scanMigration);
  bind('migrationStatus', async () => {
    const status = await call('/migration/status');
    if (status.report) showMigrationReport(status.report);
    say(status.busy ? '资料正在搬家，请等本次任务结束。' : status.incomplete ? '上次迁移有未完成项，请查看失败记录后重新预览。' : status.report ? '上次迁移记录已读取。' : '还没有迁移记录。');
  });
  bind('migrationApply', async () => {
    if (!migration?.previewId) throw new Error('先重新预览资料。');
    const input = migrationRequest(migration, migrationChoices.map(c => ({ category: c.category, checked: c.checkbox.checked })));
    if (!window.confirm(`导入所选 ${input.selections.length} 类资料？同名始终跳过，不覆盖新版。${input.allowSecrets ? '本次明确授权复制敏感连接凭据。' : ''}复制前会停止新版酒馆（不会重启 Hana），旧版源资料保留；完成后需重新打开酒馆。`)) return;
    say('正在停止新版酒馆并导入所选资料，源资料不会删除…');
    let result;
    try {
      const payload = await post('/migration/apply', input);
      result = payload.report || payload;
      showMigrationReport(result);
    } catch (error) {
      throw new Error(`迁移没有确认完成：${error.message}。先点「查看上次结果」，核对已复制项目后重新预览，不要直接重复提交。`);
    } finally { migration = null; $('migrationApply').disabled = true; }
    say(result.complete ? '所选资料迁移完成，同名保持原状；请重新打开酒馆。' : '迁移有未完成项，请查看失败信息；重新预览后再决定重试。');
  });
  bind('cardLab', openTheaterGuide);
  bind('migrationManager', async () => { show($('migrationPanel')); await scanMigration(); });
  document.querySelectorAll('[data-workbench-back]').forEach(button => button.addEventListener('click', () => { show(); say('挑一个入口吧。'); }));
}
