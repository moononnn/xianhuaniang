import http from "node:http";
import net from "node:net";
import { readFileSync } from "node:fs";
import { FRAGMENT_URL_SCRIPT } from "./st-fragment-urls.mjs";

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

/** 酒馆里负责跟随 Hana 深浅的脚本。宿主主题的静态文件由本代理应答，不经过 SillyTavern。 */
const THEME_SYNC_SCRIPT = `<!-- XIANHUNIANG_THEME_SYNC -->
<script>
// 鲜花酿 · 跟随 Hana 深浅：轮询同源 /hana-theme.json，切 hana-dark class。
// 代理层直接应答这个地址，所以不经过 ST 的设置系统，前端保存设置碰不到它。
(function () {
  var KEY = "hana-dark";
  var lastDark = null;
  function applyDark(dark) {
    dark = !!dark;
    if (dark === lastDark) return;
    lastDark = dark;
    document.documentElement.classList.toggle(KEY, dark);
    if (document.body) document.body.classList.toggle(KEY, dark);
    else document.addEventListener("DOMContentLoaded", function () { document.body.classList.toggle(KEY, dark); });
  }
  function poll() {
    try {
      fetch("/hana-theme.json?t=" + Date.now(), { method: "GET", cache: "no-store" })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (j) { if (j) applyDark(j.dark); })
        .catch(function () {});
    } catch (e) {}
  }
  poll();
  setInterval(poll, 2000);
})();
</script>
<!-- /XIANHUNIANG_THEME_SYNC -->`;

/**
 * 缩略图这类小图最怕条件请求。SillyTavern 的 /thumbnail 路由对
 * `If-None-Match: *` 和 `If-Modified-Since` 一律回 304 空正文，而浏览器硬刷新
 * 正好会带这些头。一旦客户端手上没有可用的缓存正文，<img> 就只拿到一个空响应，
 * 永远裂着，而且每刷一次精确复现一次——强刷治不好，因为它本身就是触发条件。
 *
 * 代理层把这类请求的条件头摘掉，再把回包标成不缓存、不带校验器，让缩略图每次都
 * 拿到完整的 200 正文。文件都很小（几十 KB，本机回环），不缓存没有代价。
 */
const ALWAYS_FRESH_PATH = /^\/thumbnail(?:\/|$)/i;
const CONDITIONAL_HEADERS = new Set([
  "if-none-match",
  "if-modified-since",
  "if-unmodified-since",
  "if-match",
  "if-range",
]);

function upstreamHeaders(headers, host, port, path = "") {
  const next = { ...headers, host: `${host}:${port}`, "accept-encoding": "identity" };
  if (ALWAYS_FRESH_PATH.test(path)) {
    for (const key of Object.keys(next)) {
      if (CONDITIONAL_HEADERS.has(key.toLowerCase())) delete next[key];
    }
  }
  return next;
}

/** 回包侧同样收口：去掉校验器，标成 no-store，浏览器从此不会再拿条件头来问。 */
function markAlwaysFresh(headers, path) {
  if (!ALWAYS_FRESH_PATH.test(path)) return headers;
  const next = { ...headers };
  for (const key of Object.keys(next)) {
    const lower = key.toLowerCase();
    if (lower === "etag" || lower === "last-modified" || lower === "expires") delete next[key];
  }
  next["cache-control"] = "no-store";
  return next;
}

/**
 * 诊断探针。代理只跑在本机回环上，日志走子进程 stdout，会落进 Hana 日志文件。
 * 只在 HANABREW_PROXY_LOG=1 时开，平时零输出。记的是「谁要了什么、拿回什么」，
 * 用于分辨裂图到底出在这一层、Hana 托管代理那一层，还是更上面的浏览器缓存。
 * 开关每次现读，不在模块加载时定死：排查到一半想开日志，不必重启代理。
 */
const PROXY_LOG_PATH = /^\/(?:thumbnail|api\/(?:characters|chats)|characters\/|hana-theme)/iu;

function logRequest(request, requestPath) {
  if (process.env.HANABREW_PROXY_LOG !== "1" || !PROXY_LOG_PATH.test(requestPath)) return null;
  return {
    method: request.method,
    path: requestPath,
    inm: request.headers["if-none-match"] || "",
    ims: request.headers["if-modified-since"] || "",
    ref: request.headers.referer || "",
  };
}

function logResponse(entry, statusCode, headers) {
  if (!entry) return;
  console.log(
    `[proxy] ${entry.method} ${entry.path} | inm=${entry.inm || "-"} ims=${entry.ims || "-"}`
    + ` | ref=${entry.ref || "-"} | -> ${statusCode}`
    + ` etag=${headers?.etag || "-"} lm=${headers?.["last-modified"] || "-"} cc=${headers?.["cache-control"] || "-"}`,
  );
}

function responseHeaders(headers) {
  const connectionTokens = new Set(
    String(headers.connection || "")
      .split(",")
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean),
  );
  return Object.fromEntries(
    Object.entries(headers).filter(([name]) => {
      const key = name.toLowerCase();
      return !HOP_BY_HOP.has(key) && !connectionTokens.has(key);
    }),
  );
}

function headerLines(headers) {
  return Object.entries(headers).flatMap(([name, value]) =>
    Array.isArray(value) ? value.map((item) => `${name}: ${item}`) : [`${name}: ${value}`],
  );
}

function isHtml(headers) {
  return String(headers["content-type"] || "").toLowerCase().includes("text/html");
}

export function createStProxyServer({ upstreamHost = "127.0.0.1", upstreamPort, skinStatePath = "" }) {
  if (!Number.isInteger(upstreamPort) || upstreamPort < 1 || upstreamPort > 65535) {
    throw new TypeError("upstreamPort must be a valid TCP port");
  }

  const sockets = new Set();
  const server = http.createServer((request, response) => {
    const requestPath = String(request.url || "/");
    const path = requestPath.split("?")[0];

    // 酒馆前端轮询的主题状态：由代理直接应答，v1/v2 互不覆盖。
    if (path === "/hana-theme.json" && skinStatePath) {
      let payload = '{"dark":false,"theme":""}';
      try {
        payload = readFileSync(skinStatePath, "utf8").trim() || payload;
      } catch {
        // 状态文件还没写出来时按浅色回，前端下一轮会拿到真值。
      }
      response.writeHead(200, {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
      });
      response.end(payload);
      return;
    }

    const logEntry = logRequest(request, requestPath);
    const upstream = http.request({
      hostname: upstreamHost,
      port: upstreamPort,
      method: request.method,
      path: requestPath,
      headers: upstreamHeaders(request.headers, upstreamHost, upstreamPort, path),
    }, (upstreamResponse) => {
      const head = markAlwaysFresh(responseHeaders(upstreamResponse.headers), path);
      logResponse(logEntry, upstreamResponse.statusCode, head);
      if (!isHtml(upstreamResponse.headers)) {
        response.writeHead(upstreamResponse.statusCode || 502, head);
        upstreamResponse.on("error", (error) => response.destroy(error));
        upstreamResponse.pipe(response);
        return;
      }
      // 先补 HTML 片段头像地址，再按需补主题同步；不修改酒馆安装目录。
      const chunks = [];
      let size = 0;
      upstreamResponse.on("data", (chunk) => {
        size += chunk.length;
        if (size > 8 * 1024 * 1024) {
          // 超大 HTML 不改写，直接原样转发，避免为了注入脚本把内存吃满。
          response.writeHead(upstreamResponse.statusCode || 200, head);
          chunks.forEach((item) => response.write(item));
          upstreamResponse.pipe(response);
          return;
        }
        chunks.push(chunk);
      });
      upstreamResponse.on("end", () => {
        if (response.writableEnded) return;
        const html = Buffer.concat(chunks).toString("utf8");
        const withImages = html.includes("HANABREW_FRAGMENT_IMAGE_URLS")
          ? html
          : html.replace(/<\/head>/iu, `${FRAGMENT_URL_SCRIPT}\n</head>`);
        const patched = !skinStatePath || withImages.includes("THEME_SYNC")
          ? withImages
          : withImages.replace("</body>", `${THEME_SYNC_SCRIPT}\n</body>`);
        const buffer = Buffer.from(patched, "utf8");
        delete head["content-length"];
        response.writeHead(upstreamResponse.statusCode || 200, {
          ...head,
          "content-length": String(buffer.length),
        });
        response.end(buffer);
      });
      upstreamResponse.on("error", (error) => {
        if (!response.headersSent) {
          response.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
          response.end("SillyTavern upstream unavailable");
        } else {
          response.destroy(error);
        }
      });
    });

    upstream.on("error", (error) => {
      if (response.destroyed) return;
      if (!response.headersSent) {
        response.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
        response.end("SillyTavern upstream unavailable");
      } else {
        response.destroy(error);
      }
    });
    request.on("aborted", () => upstream.destroy());
    response.on("close", () => {
      if (!response.writableEnded) upstream.destroy();
    });
    request.pipe(upstream);
  });

  server.on("upgrade", (request, clientSocket, head) => {
    const upstream = net.connect(upstreamPort, upstreamHost);
    upstream.once("connect", () => {
      const headers = upstreamHeaders(request.headers, upstreamHost, upstreamPort);
      const requestLine = `${request.method} ${request.url || "/"} HTTP/${request.httpVersion}`;
      upstream.write(`${requestLine}\r\n${headerLines(headers).join("\r\n")}\r\n\r\n`);
      if (head.length) upstream.write(head);
      clientSocket.pipe(upstream);
      upstream.pipe(clientSocket);
    });
    const destroyBoth = () => {
      clientSocket.destroy();
      upstream.destroy();
    };
    upstream.on("error", destroyBoth);
    clientSocket.on("error", () => upstream.destroy());
    clientSocket.on("close", () => upstream.destroy());
    upstream.on("close", () => clientSocket.destroy());
  });

  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  server.closeConnections = () => {
    for (const socket of sockets) socket.destroy();
  };
  return server;
}
