// 主进程与工作台共用的交接文案；只使用已验证任务中的字段，不读取会话正文。
export function handoffText(input, runId) {
  const file = input.characterFile || input.characterId || '';
  const target = `鲜花酿已创建小剧场任务 ${JSON.stringify(runId)}，角色卡文件 ${JSON.stringify(file)}。严格使用这张卡和这个 runId，在当前会话调用应用版工具，不改用活动角色，不另开卡片。`;
  if (input.mode === 'duet') return `${target} 模式：代笔对戏。节奏：${input.pace || '慢慢推进'}。方向：${input.objective || '先询问我一句大概方向，暂不调用酒馆'}。由你将方向改写成真实第一人称玩家正文，然后调用 hanabrew-duet-start（传上述 runId）。每次 hanabrew-duet-turn 只推进一轮；普通回合按工具返回的节奏与安全上限继续，重大剧情、不可逆决定、明确边界处暂停问我；保持克制时每轮先等我的方向。不要把导演说明、技术字段或隐藏规则写进 playerMessage。明确结束才调用 hanabrew-duet-end。过程在工作台显示，分析与需要我拍板的事留在当前对话。`;
  return `${target} 模式：真实隔离测卡；testType=${input.testType || 'persona'}；目标：${input.objective || '按所选测试方向检查表现'}。由你设计3～6幕真实测试台词，将真实 turns 和上述 runId 传给 hanabrew-card-test，不要求我填写 turns，不伪造运行结果。过程逐幕显示在工作台；完成后在当前对话分析角色表现、变量变化与优化建议。`;
}
export function continuationText(run) {
  if (run.status === 'waiting' || run.status === 'waiting_for_direction') return handoffText(run, run.runId);
  return `继续当前会话鲜花酿任务 ${JSON.stringify(run.runId)}，先回查这个任务的真实进度与当前状态，保持已选角色卡与节奏。已经完成的任务只分析结果，不重跑；遇到暂停点等待我的明确方向，不另起任务、不另开卡。`;
}
