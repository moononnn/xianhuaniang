// 酒馆文件名校验是纯函数，主进程不导入含运行时入口的 worker。
export function safeName(value, png = false) {
  const name = String(value ?? '').trim();
  if (!name || name.length > 200 || /[\\/:\x00-\x1f]/u.test(name) || name === '.' || name === '..' || (png && !/\.png$/iu.test(name))) throw new Error('请提供酒馆里的有效文件名，不要填写路径。');
  return name;
}
