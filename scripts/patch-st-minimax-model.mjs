#!/usr/bin/env node
// 鲜花酿 · 内嵌 SillyTavern 补丁脚本（幂等，可重复执行）
//
// 为什么需要：酒馆引擎是上游 SillyTavern 1.19.0 的原样副本，它把各家模型下拉写死在
// public/index.html 里。MiniMax 官方后来出了 M3.1-Flash-Preview（仅 M Plan / MiniMax Code 提供），
// 上游没跟上，酒馆里就选不到。升级或重装引擎会覆盖补丁，所以这里留一个可重放的脚本，
// 装完 / 升级后跑一次即可恢复。
//
// 用法：
//   node scripts/patch-st-minimax-model.mjs
//   node scripts/patch-st-minimax-model.mjs --check   只检查不修改
//
// 注意：这是有意保留的分发版改动。发布时不要清理 vendor 里的这行，
// 也不要因为它改动了上游文件就当成脏改动回滚。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TARGET = path.join(APP_ROOT, 'vendor', 'sillytavern', 'public', 'index.html');

const NEW_MODEL = 'MiniMax-M3.1-Flash-Preview';
const ANCHOR = '<option value="MiniMax-M2.7">MiniMax-M2.7</option>';

function main() {
  const checkOnly = process.argv.includes('--check');
  if (!fs.existsSync(TARGET)) {
    console.error(`找不到酒馆页面：${TARGET}`);
    process.exitCode = 1;
    return;
  }
  const html = fs.readFileSync(TARGET, 'utf8');
  if (html.includes(`value="${NEW_MODEL}"`)) {
    console.log(`已经打过补丁：${NEW_MODEL} 已在模型列表里。`);
    return;
  }
  if (!html.includes(ANCHOR)) {
    console.error('没找到 MiniMax-M2.7 这个锚点选项，上游结构可能变了，请人工确认。');
    process.exitCode = 1;
    return;
  }
  if (checkOnly) {
    console.log('尚未打补丁，需要补。');
    process.exitCode = 1;
    return;
  }
  fs.writeFileSync(TARGET, html.replace(ANCHOR, `<option value="${NEW_MODEL}">${NEW_MODEL}</option>\n        ${ANCHOR}`), 'utf8');
  console.log(`已补上 ${NEW_MODEL}，现在酒馆的 MiniMax 模型列表里能选到它了。`);
}

main();