// 探针开关走运行时读取，所以这里直接用同一个模块实例，靠环境变量区分开与关。
process.env.HANABREW_PROXY_LOG = "1";
const { createStProxyServer } = await import("../runtime/st-proxy.mjs");

import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve(server.address().port);
    });
  });
}

function close(server) {
  server.closeConnections?.();
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

/** 起一对「代理 + 上游」，上游按 handler 应答。 */
async function pair(t, createServer, handler) {
  const upstream = http.createServer(handler);
  const upstreamPort = await listen(upstream);
  const proxy = createServer({ upstreamPort });
  const proxyPort = await listen(proxy);
  const logs = [];
  const original = console.log;
  console.log = (...args) => { logs.push(args.join(" ")); original(...args); };
  t.after(async () => {
    console.log = original;
    await close(proxy);
    await close(upstream);
  });
  return { proxyPort, logs };
}

test("开启探针时，缩略图请求会记下条件头、来源与回包校验器", async (t) => {
  const { proxyPort, logs } = await pair(t, createStProxyServer, (request, response) => {
    response.writeHead(200, {
      "content-type": "image/png",
      etag: '"abc"',
      "last-modified": "Wed, 21 Oct 2026 07:28:00 GMT",
      "cache-control": "public, max-age=86400",
    });
    response.end(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  });

  const response = await fetch(`http://127.0.0.1:${proxyPort}/thumbnail?type=avatar&file=%E5%B0%8F%E8%8A%B1.png`, {
    headers: { "if-none-match": "*", referer: "http://127.0.0.1:1/_runtime/abc/index.html" },
  });
  await response.arrayBuffer();

  const line = logs.find((item) => item.startsWith("[proxy] GET /thumbnail"));
  assert.ok(line, `没有记到缩略图请求，实际日志：${JSON.stringify(logs)}`);
  assert.match(line, /\/thumbnail\?type=avatar&file=/);
  assert.match(line, /inm=\*/);
  assert.match(line, /ref=http:\/\/127\.0\.0\.1:1\/_runtime\/abc\/index\.html/);
  assert.match(line, /-> 200/);
});

test("探针关掉时一条都不打", async (t) => {
  delete process.env.HANABREW_PROXY_LOG;
  t.after(() => { process.env.HANABREW_PROXY_LOG = "1"; });
  const { proxyPort, logs } = await pair(t, createStProxyServer, (request, response) => {
    response.writeHead(200, { "content-type": "image/png" });
    response.end(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  });

  const response = await fetch(`http://127.0.0.1:${proxyPort}/thumbnail?type=avatar&file=x.png`);
  await response.arrayBuffer();

  assert.deepEqual(logs, [], "默认不该有任何探针输出");
});

test("探针不碰无关路径", async (t) => {
  const { proxyPort, logs } = await pair(t, createStProxyServer, (request, response) => {
    response.writeHead(200, { "content-type": "text/css" });
    response.end("body{}");
  });

  const response = await fetch(`http://127.0.0.1:${proxyPort}/style.css`);
  await response.text();

  assert.deepEqual(logs, [], "静态资源不该进探针日志");
});
