import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { installFragmentImageUrls, FRAGMENT_URL_SCRIPT } from '../runtime/st-fragment-urls.mjs';

const base = '/api/apps/example/routes/_runtime/runtime-1/_surface/mount-1/';
const origin = 'http://127.0.0.1:14500';
function fixture(pathname = base + 'index.html', sources = []) {
  const images = sources.map(src => ({
    src, writes: 0,
    getAttribute() { return this.src; },
    setAttribute(name, value) { assert.equal(name, 'src'); this.src = value; this.writes++; },
  }));
  const fragment = { querySelectorAll(selector) { assert.equal(selector, 'img[src]'); return images; } };
  class Range {
    createContextualFragment(...args) { this.args = args; return fragment; }
  }
  return { scope: { location: { pathname, href: origin + pathname }, Range, URL }, images, fragment };
}

test('解析器基线：HTML 片段中的 src 不会触发属性写入', () => {
  const {scope, images} = fixture(undefined, ['/thumbnail?type=avatar&file=card.png']);
  new scope.Range().createContextualFragment('<img>');
  assert.equal(images[0].src, '/thumbnail?type=avatar&file=card.png');
  assert.equal(images[0].writes, 0);
});

test('受管片段头像在插入前补齐前缀，保留中文文件名、查询参数与 hash', () => {
  const source = '/thumbnail?type=avatar&file=%E5%B0%8F%E8%8A%B1.png#avatar';
  const {scope, images, fragment} = fixture(undefined, [source]);
  installFragmentImageUrls(scope);
  const range = new scope.Range();
  assert.equal(range.createContextualFragment('<img>', 'forwarded'), fragment);
  assert.deepEqual(range.args, ['<img>', 'forwarded']);
  assert.equal(images[0].src, origin + base + source.slice(1));
  assert.equal(images[0].writes, 1);
});

test('已改写、相对、外部、data/blob 与空头像保持原样', () => {
  const sources = [base + 'thumbnail?x=1', origin + base + 'thumbnail?x=1', 'img/group.png', '//cdn.example/avatar.png', 'https://cdn.example/avatar.png', 'data:image/png;base64,AA==', 'blob:http://localhost/id', '', null];
  const {scope, images} = fixture(undefined, sources);
  installFragmentImageUrls(scope);
  new scope.Range().createContextualFragment('fragment');
  assert.deepEqual(images.map(image => image.src), sources);
  assert.ok(images.every(image => image.writes === 0));
});

test('直连酒馆完全空转，不改变原生解析函数', () => {
  const {scope, images} = fixture('/index.html', ['/thumbnail?x=1']);
  const native = scope.Range.prototype.createContextualFragment;
  installFragmentImageUrls(scope);
  assert.equal(scope.Range.prototype.createContextualFragment, native);
  new scope.Range().createContextualFragment('fragment');
  assert.equal(images[0].src, '/thumbnail?x=1');
});

test('重复安装只挂一次，重复处理不再写头像地址', () => {
  const {scope, images} = fixture(undefined, ['/thumbnail?x=1']);
  installFragmentImageUrls(scope);
  const wrapped = scope.Range.prototype.createContextualFragment;
  installFragmentImageUrls(scope);
  assert.equal(scope.Range.prototype.createContextualFragment, wrapped);
  const range = new scope.Range();
  range.createContextualFragment('fragment');
  range.createContextualFragment('fragment');
  assert.equal(images[0].writes, 1);
});

test('代理注入的最终脚本可解析并运行，同一实现修正片段', () => {
  const {scope, images} = fixture(undefined, ['/thumbnail?x=1']);
  const body = FRAGMENT_URL_SCRIPT.match(/<script>([\s\S]*?)<\/script>/)[1];
  vm.runInNewContext(body, {window:scope});
  new scope.Range().createContextualFragment('fragment');
  assert.equal(images[0].src, origin + base + 'thumbnail?x=1');
});
