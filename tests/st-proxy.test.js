import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStProxyServer } from "../runtime/st-proxy.mjs";

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

test("service proxy asks SillyTavern for identity encoding and relays the full body", async (t) => {
  let receivedEncoding = "";
  const content = `<html>${"x".repeat(20_000)}</html>`;
  const upstream = http.createServer((request, response) => {
    receivedEncoding = request.headers["accept-encoding"] || "";
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(content);
  });
  const upstreamPort = await listen(upstream);
  const proxy = createStProxyServer({ upstreamPort });
  const proxyPort = await listen(proxy);
  t.after(async () => {
    await close(proxy);
    await close(upstream);
  });

  const response = await fetch(`http://127.0.0.1:${proxyPort}/index.html`);
  const body = await response.text();
  assert.equal(response.status, 200);
  assert.equal(receivedEncoding, "identity");
  assert.equal(response.headers.get("content-encoding"), null);
  assert.equal(body, content);
});

test("缩略图遇到条件请求也回完整正文，不发 304 空响应", async (t) => {
  const content = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
  let upstreamSawValidator = "";
  const upstream = http.createServer((request, response) => {
    const validator = request.headers["if-none-match"] || request.headers["if-modified-since"] || "";
    upstreamSawValidator = validator;
    if (validator) {
      response.writeHead(304, { etag: 'W/"abc"' });
      response.end();
      return;
    }
    response.writeHead(200, {
      "content-type": "image/png",
      etag: 'W/"abc"',
      "last-modified": "Wed, 01 Oct 2026 00:00:00 GMT",
      "cache-control": "public, max-age=0",
    });
    response.end(content);
  });
  const upstreamPort = await listen(upstream);
  const proxy = createStProxyServer({ upstreamPort });
  const proxyPort = await listen(proxy);
  t.after(async () => {
    await close(proxy);
    await close(upstream);
  });

  const url = `http://127.0.0.1:${proxyPort}/thumbnail?type=avatar&file=${encodeURIComponent("小花.png")}`;
  const response = await fetch(url, { headers: { "if-none-match": "*" } });
  const body = Buffer.from(await response.arrayBuffer());
  assert.equal(response.status, 200, "带条件头的缩略图请求也必须是 200");
  assert.equal(upstreamSawValidator, "", "条件头不该再转给酒馆");
  assert.deepEqual(body, content);
  assert.equal(response.headers.get("etag"), null);
  assert.equal(response.headers.get("last-modified"), null);
  assert.equal(response.headers.get("cache-control"), "no-store");

  const normal = await fetch(`http://127.0.0.1:${proxyPort}/css/style.css`);
  assert.equal(normal.status, 200);
  assert.equal(normal.headers.get("etag"), 'W/"abc"', "非缩略图资源的缓存头要原样透传");
});

test("service proxy tunnels WebSocket upgrades", async (t) => {  const upstreamSockets = new Set();
  let upstreamSawUpgrade = false;
  const upstream = http.createServer();
  upstream.on("upgrade", (request, socket, head) => {
    upstreamSawUpgrade = request.headers.upgrade === "websocket";
    upstreamSockets.add(socket);
    socket.on("close", () => upstreamSockets.delete(socket));
    socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n");
    if (head.length) socket.write(head);
    socket.on("data", (chunk) => socket.write(chunk));
  });
  const upstreamPort = await listen(upstream);
  const proxy = createStProxyServer({ upstreamPort });
  const proxyPort = await listen(proxy);
  let clientSocket;
  t.after(async () => {
    clientSocket?.destroy();
    for (const socket of upstreamSockets) socket.destroy();
    await close(proxy);
    await close(upstream);
  });

  const upgrade = await new Promise((resolve, reject) => {
    const request = http.request({
      hostname: "127.0.0.1",
      port: proxyPort,
      path: "/ws",
      headers: {
        connection: "Upgrade",
        upgrade: "websocket",
        "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
        "sec-websocket-version": "13",
      },
    });
    request.once("upgrade", (response, socket, head) => resolve({ response, socket, head }));
    request.once("response", () => reject(new Error("Expected a WebSocket upgrade response")));
    request.once("error", reject);
    request.end();
  });
  clientSocket = upgrade.socket;
  assert.equal(upstreamSawUpgrade, true);
  assert.equal(upgrade.response.statusCode, 101);

  const echoed = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("WebSocket echo timed out")), 2000);
    clientSocket.once("data", (chunk) => {
      clearTimeout(timer);
      resolve(chunk);
    });
  });
  clientSocket.write("ping");
  assert.equal((await echoed).toString(), "ping");
});

test("开启皮肤后，HTML 会补上跟随深浅的脚本，主题状态由代理自己应答", async (t) => {
  const stateFile = join(mkdtempSync(join(tmpdir(), "xhn-skin-")), "_hana-skin.json");
  writeFileSync(stateFile, JSON.stringify({ dark: true, theme: "midnight" }));
  const content = "<html><head></head><body>酒馆</body></html>";
  let upstreamHitThemeRoute = false;
  const upstream = http.createServer((request, response) => {
    if (request.url.startsWith("/hana-theme.json")) {
      upstreamHitThemeRoute = true;
      response.writeHead(200, { "content-type": "application/json" });
      response.end('{"dark":false}');
      return;
    }
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(content);
  });
  const upstreamPort = await listen(upstream);
  const proxy = createStProxyServer({ upstreamPort, skinStatePath: stateFile });
  const proxyPort = await listen(proxy);
  t.after(async () => {
    await close(proxy);
    await close(upstream);
  });

  const page = await fetch(`http://127.0.0.1:${proxyPort}/index.html`);
  const body = await page.text();
  assert.match(body, /XIANHUNIANG_THEME_SYNC/);
  assert.match(body, /hana-dark/);
  assert.match(body, /<\/body>/);
  assert.equal(Number(page.headers.get("content-length")), Buffer.byteLength(body));

  const state = await (await fetch(`http://127.0.0.1:${proxyPort}/hana-theme.json?t=1`)).json();
  assert.equal(state.dark, true);
  assert.equal(state.theme, "midnight");
  assert.equal(upstreamHitThemeRoute, false, "主题状态不应再经过 SillyTavern");
});

test("片段头像补丁不依赖皮肤，进入 head 且重复转发不叠加", async (t) => {
  let content = "<html><head><title>fixture</title></head><body>fixture</body></html>";
  const upstream = http.createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(content);
  });
  const upstreamPort = await listen(upstream);
  const proxy = createStProxyServer({ upstreamPort });
  const proxyPort = await listen(proxy);
  t.after(async () => { await close(proxy); await close(upstream); });
  const response = await fetch(`http://127.0.0.1:${proxyPort}/index.html`);
  const patched = await response.text();
  assert.equal((patched.match(/HANABREW_FRAGMENT_IMAGE_URLS/g) || []).length, 1);
  assert.ok(patched.indexOf("HANABREW_FRAGMENT_IMAGE_URLS") < patched.indexOf("</head>"));
  assert.equal(Number(response.headers.get("content-length")), Buffer.byteLength(patched));
  assert.doesNotMatch(patched, /XIANHUNIANG_THEME_SYNC/);
  content = patched;
  assert.equal(await (await fetch(`http://127.0.0.1:${proxyPort}/index.html`)).text(), patched);
});

test("状态文件还没写出来时按浅色回，下一轮轮询会拿到真值", async (t) => {
  const stateFile = join(mkdtempSync(join(tmpdir(), "xhn-skin-")), "_hana-skin.json");
  const upstream = http.createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html" });
    response.end("<html><body></body></html>");
  });
  const upstreamPort = await listen(upstream);
  const proxy = createStProxyServer({ upstreamPort, skinStatePath: stateFile });
  const proxyPort = await listen(proxy);
  t.after(async () => {
    await close(proxy);
    await close(upstream);
  });
  const state = await (await fetch(`http://127.0.0.1:${proxyPort}/hana-theme.json`)).json();
  assert.equal(state.dark, false);
});
