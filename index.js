import fs from "node:fs";
import path from "node:path";

import { ensureServer, runtimeConfig, runtimeStatus, stopServer } from "./backend/st-runtime.js";
import { applySkin, getSkinStatus, startSkinSync, stopSkinSync, syncSkinNow } from "./backend/tavern-skin.js";
import { listV2Characters } from "./backend/characters.js";
import { inviteCharacterToTeaParty, teaPartyCharacterPreview, teaPartyHome, teaPartyStatus } from "./backend/tea-party.js";
import {
  departVisitor,
  getVisitorPreview,
  inviteCharacter,
  listFlowerVisitors,
  repairVisitor,
  settleVisitor,
  uninviteVisitor,
} from "./backend/visitors.js";
import {
  buildPartnerCard,
  exportPartnerToTavern,
  listExportableAgents,
  readPartnerPersona,
} from "./backend/partner-export.js";

import { createTheaterService } from "./backend/theater-service.js";
import { readLatestReport } from "./backend/theater-reports.js";
import { registerTavernTools } from "./backend/tavern-tools.js";
import { createMigrationService } from "./backend/data-migration.js";
import { createAdminService, registerAdminTools } from "./backend/tavern-admin.js";
import { continuationText, handoffText } from './ui/theater-handoff.js';
// 来访状态工具的注册已按产品决定摘除（鲜花酿不再做「邀请角色来 Hana」，角色出口改到茶话会）。
// 代码、路由、面板、数据与测试全部原样保留。宿主支持邀请来访后，把这一行换回：
// import { registerVisitorStateTools } from './backend/visitor-state.js';

export const name = "xianhuaniang";

export function readManifest() {
  const file = new URL("./manifest.json", import.meta.url);
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

export const version = readManifest().version;

function logFor(ctx) {
  const logger = ctx?.logger ?? ctx?.log;
  return {
    info: (...args) => logger?.info?.(`[${name}]`, ...args),
    warn: (...args) => logger?.warn?.(`[${name}]`, ...args),
  };
}

async function readBody(routeContext) {
  try {
    return (await routeContext.req.json()) || {};
  } catch {
    return {};
  }
}

// UI 只传 SDK 返回的稳定会话编号；后端通过正式 SDK 总线回查元数据。
// 不相信客户端传来的 sessionPath/agentId，不读取聊天正文，不兜底到全局焦点。
export async function resolveWorkbenchScope(ctx, sessionId) {
  if (typeof sessionId !== 'string' || !sessionId.trim()) throw new Error('当前没有 Hana 会话，无法开始或读取测卡。');
  if (!ctx?.bus?.request) throw new Error('宿主未提供会话元数据核对通道。');
  const result = await ctx.bus.request('session:get', { sessionId, scope: 'all' });
  const session = result?.session;
  if (!session || session.sessionId !== sessionId || !session.path) throw new Error('当前会话元数据未获宿主确认；没有执行测卡。');
  return { sessionId: session.sessionId, sessionPath: session.path, agentId: session.agentId || null };
}

export async function workbenchVisitors(ctx) {
  const visitors = await listFlowerVisitors(ctx);
  if (!visitors.length) return visitors;
  try {
    const result = await ctx.bus.request('agent:list', { scope: 'own' });
    if (!Array.isArray(result?.agents)) throw new Error('宿主未返回应用所属伙伴名单');
    const owned = new Set(result.agents.map(agent => agent.id));
    return visitors.map(visitor => ({ ...visitor, available: owned.has(visitor.agentId), unavailableReason: owned.has(visitor.agentId) ? '' : '这份旧档不属于当前应用或受宿主可见性限制，无法入住、送回或修复。修一遍不能改变宿主归属与可见性。' }));
  } catch (error) {
    return visitors.map(visitor => ({ ...visitor, available: false, unavailableReason: `宿主归属未能核实，操作暂不可用：${error?.message || error}` }));
  }
}
async function requireManagedVisitor(ctx, agentId) {
  const visitor = (await workbenchVisitors(ctx)).find(item => item.agentId === agentId);
  if (!visitor || !visitor.available) throw new Error(visitor?.unavailableReason || '这位访客不在当前应用可管理的来访名单里。');
}

export async function apply(ctx) {
  const log = logFor(ctx);
  let unregisterRoutes = null;
  const theater = createTheaterService(ctx);
  const migration = createMigrationService(ctx);
  const admin = createAdminService(ctx);
  const toolCleanups = [];
  const acceptedStarts = new Map();
  try {
    toolCleanups.push(await registerAdminTools(ctx));
    toolCleanups.push(await registerTavernTools(ctx, theater));
    // 来访状态工具（hanabrew-visitor-state）已退役：鲜花酿不再做「邀请角色来 Hana」，
    // 这个工具没有业务前提了。宿主支持邀请来访后，把上面那条 import 和下面这行一起恢复：
    // toolCleanups.push(await registerVisitorStateTools(ctx));
  } catch (error) {
    for (const cleanup of toolCleanups.reverse()) await cleanup();
    await theater.dispose();
    await migration.dispose?.();
    await admin.dispose();
    throw error;
  }

  try {
  if (typeof ctx?.routes?.register === "function") {
    unregisterRoutes = await ctx.routes.register((app) => {
      app.get("/runtime/status", async (routeContext) => routeContext.json({
        ok: true,
        ...await runtimeStatus(ctx),
        config: runtimeConfig(),
      }));

      app.post("/runtime/start", async (routeContext) => {
        try {
          const skin = await applySkin(ctx);
          for (const note of skin.notes || []) log.info(`酒馆皮肤：${note}`);
          startSkinSync(ctx, log);
          const status = await ensureServer(ctx, (level, message) => log[level]?.(message));
          return routeContext.json({ ok: true, ...status });
        } catch (error) {
          log.warn(error?.message || error);
          return routeContext.json({ ok: false, error: error?.message || String(error), ...await runtimeStatus(ctx) }, 503);
        }
      });

      app.post("/runtime/stop", async (routeContext) => {
        const result = await stopServer(ctx, (level, message) => log[level]?.(message));
        return routeContext.json({ ok: true, ...result, ...await runtimeStatus(ctx) });
      });

      app.post('/theater/diag', async (routeContext) => {
        // 诊断专用：记录流内卡实际拿到的宿主身份形状。写入前先尝试一个待修方案：
        // 宿主在卡片 URL 上签的 appSurfaceSession 票据能不能换回这段会话的归属。
        const body = await readBody(routeContext);
        const query = routeContext.req.query('appSurfaceSession') || '';
        const record = {
          at: new Date().toISOString(),
          pathname: routeContext.req.path || '',
          appSurfaceSession: String(query).slice(0, 400),
          probe: body && typeof body === 'object' ? body : {},
        };
        try {
          fs.mkdirSync(ctx.dataDir, { recursive: true });
          fs.appendFileSync(path.join(ctx.dataDir, 'surface-diag.jsonl'), `${JSON.stringify(record)}\n`, 'utf8');
          log.info(`小剧场诊断：${JSON.stringify(record).slice(0, 400)}`);
        } catch (error) {
          log.warn(`小剧场诊断写不下去：${error?.message || error}`);
        }
        return routeContext.json({ ok: true, recorded: true, hasTicket: Boolean(query) });
      });
      // 取出形态的卡片拿不到会话归属：给一个只读的看板入口。
      // 只读本应用自己的成绩单，不接受写入，也不再提供任何提交能力。
      app.get('/theater/latest', async (routeContext) => {
        try { return routeContext.json({ ok: true, report: readLatestReport(ctx.dataDir) }); }
        catch (error) { return routeContext.json({ ok: false, error: error?.message || String(error), report: null }, 500); }
      });
      app.get('/theater/current', async (routeContext) => {
        try {
          const scope = await resolveWorkbenchScope(ctx, routeContext.req.query('sessionId'));
          // active 给流内卡恢复用：对戏跑起来后状态是 running，不在 pending 列表里，
          // 卡片被收回再打开（或宿主重启后重建）时必须能凭它接回正在进行的这一场。
          return routeContext.json({ ok: true, runs: theater.pending(scope), active: theater.active(scope) });
        } catch (error) { return routeContext.json({ ok: false, error: error?.message || '恢复任务未确认。' }, 400); }
      });
      app.post('/theater/submit', async (routeContext) => {
        try {
          const body = await readBody(routeContext);
          const scope = await resolveWorkbenchScope(ctx, body.scope?.sessionId);
          return routeContext.json({ ok: true, ...(await theater.submit({ characterFile: body.characterFile, mode: body.mode, testType: body.testType, pace: body.pace, objective: body.objective }, scope)) });
        } catch (error) { return routeContext.json({ ok: false, error: error?.message || String(error) }, 400); }
      });
      app.post('/theater/handoff', async (routeContext) => {
        try {
          const body = await readBody(routeContext);
          const scope = await resolveWorkbenchScope(ctx, body.scope?.sessionId);
          const run = await theater.progress(body.runId, scope);
          if (!['start', 'continue'].includes(body.mode)) throw new Error('交接方式无效。');
          const key = `${scope.sessionId}:${run.runId}`;
          const send = async () => {
            const result = await ctx.bus.request('session:send', {
              sessionId: scope.sessionId,
              scope: 'all',
              text: body.mode === 'start' ? handoffText(run, run.runId) : continuationText(run),
            });
            if (result?.accepted !== true) throw new Error('宿主没有确认接纳这次交接，不能当作已经送达。');
            return { accepted: true, sessionId: scope.sessionId, runId: run.runId };
          };
          // 并发复用同一次发送；只缓存成功回执，所有失败都可由用户重试。
          // 未确认不等于未发送，前端会提醒先核对主对话，不自动重投。
          let receipt;
          if (body.mode === 'start') {
            for (const [savedKey, saved] of acceptedStarts) if (saved.expiresAt <= Date.now()) acceptedStarts.delete(savedKey);
            if (!acceptedStarts.has(key)) {
              const entry = { promise: null, expiresAt: Infinity };
              entry.promise = send().then(result => {
                entry.expiresAt = Date.now() + 30 * 60 * 1000;
                return result;
              }).catch(error => {
                if (acceptedStarts.get(key) === entry) acceptedStarts.delete(key);
                throw error;
              });
              acceptedStarts.set(key, entry);
            }
            receipt = await acceptedStarts.get(key).promise;
          } else receipt = await send();
          return routeContext.json({ ok: true, ...receipt });
        } catch (error) {
          const message = error?.message || String(error);
          return routeContext.json({ ok: false, error: /APP_CAPABILITY_DENIED|app\/session\.start-turn|app\/sessions\.(read|manage)/u.test(`${error?.code || ''} ${message}`)
            ? '当前交接授权不足。请到 Hana 设置 → 安全 → 应用能力，检查鲜花酿的会话访问与发起回复授权，再重试；任务保留在工作台。'
            : `交接未确认：${message}。消息可能已经排队，请先查看主对话再重试；原任务仍保留。` }, 400);
        }
      });
      app.get('/theater/progress', async (routeContext) => {
        try {
          const scope = await resolveWorkbenchScope(ctx, routeContext.req.query('sessionId'));
          return routeContext.json({ ok: true, ...(await theater.progress(routeContext.req.query('runId'), scope)) });
        } catch (error) { return routeContext.json({ ok: false, error: error?.message || String(error) }, 404); }
      });
      app.post('/theater/control', async (routeContext) => {
        try {
          const body = await readBody(routeContext);
          const scope = await resolveWorkbenchScope(ctx, body.scope?.sessionId);
          return routeContext.json({ ok: true, ...(await theater.control({ runId: body.runId, action: body.action }, scope)) });
        } catch (error) { return routeContext.json({ ok: false, error: error?.message || String(error) }, 400); }
      });
      app.post('/migration/preview', async (routeContext) => {
        try { return routeContext.json({ ok: true, ...(await migration.preview()) }); }
        catch (error) { return routeContext.json({ ok: false, error: error?.message || String(error) }, 400); }
      });
      app.post('/migration/apply', async (routeContext) => {
        try {
          const body = await readBody(routeContext);
          return routeContext.json({ ok: true, report: await migration.apply({ previewId: body.previewId, selections: body.selections, conflicts: body.conflicts, allowSecrets: body.allowSecrets === true }) });
        } catch (error) { return routeContext.json({ ok: false, error: error?.message || String(error) }, 400); }
      });
      app.get('/migration/status', async (routeContext) => {
        try { return routeContext.json({ ok: true, ...(await migration.status()) }); }
        catch (error) { return routeContext.json({ ok: false, error: error?.message || String(error) }, 500); }
      });

      // 邀请酒馆角色来 Hana：列出 v2 酒馆里的角色卡。
      app.get("/workbench/characters", async (routeContext) => {
        try {
          const characters = await listV2Characters(ctx);
          return routeContext.json({ ok: true, characters, dataRoot: runtimeConfig().dataRoot });
        } catch (error) {
          return routeContext.json({ ok: false, error: error?.message || String(error), characters: [] }, 500);
        }
      });

      // 茶话会装没装、通道在不在才是门禁；hasHandler 探测只作提示，结果一并写日志备查。
      app.get("/workbench/tea-party/status", (routeContext) => {
        const status = teaPartyStatus(ctx);
        const line = JSON.stringify({ at: new Date().toISOString(), pid: process.pid, home: teaPartyHome(), ...status });
        // 宿主日志会按内容去重折叠，探测现场另存一份文件，下次排查不用再猜。
        try {
          fs.mkdirSync(ctx.dataDir, { recursive: true });
          fs.appendFileSync(path.join(ctx.dataDir, "tea-party-probe.log"), `${line}\n`, "utf8");
        } catch (error) {
          log.warn(`茶话会探测日志写不下去：${error?.message || error}`);
        }
        log.info(`茶话会状态 ${line}`);
        return routeContext.json({ ok: true, ...status });
      });

      app.post("/workbench/tea-party/preview", async (routeContext) => {
        const body = await readBody(routeContext);
        try {
          return routeContext.json({ ok: true, ...(await teaPartyCharacterPreview(ctx, body.file)) });
        } catch (error) {
          return routeContext.json({ ok: false, error: error?.message || String(error) }, 400);
        }
      });

      app.post("/workbench/tea-party/invite", async (routeContext) => {
        const body = await readBody(routeContext);
        try {
          return routeContext.json({ ok: true, ...(await inviteCharacterToTeaParty(ctx, body.file)) });
        } catch (error) {
          return routeContext.json({ ok: false, error: error?.message || String(error) }, 503);
        }
      });

      // 先看看这张卡：设定摘要、开场白和酒馆里最近的一段对话，确认后再邀请。
      app.post("/workbench/visitor/preview", async (routeContext) => {
        const body = await readBody(routeContext);
        try {
          return routeContext.json({ ok: true, ...(await getVisitorPreview(String(body.file || ""), ctx)) });
        } catch (error) {
          return routeContext.json({ ok: false, error: error?.message || String(error) }, 400);
        }
      });

      app.post("/workbench/invite", async (routeContext) => {
        const body = await readBody(routeContext);
        try {
          const selectedCard = (await listV2Characters(ctx)).find(card => card.file === body.file);
          const existing = (await workbenchVisitors(ctx)).find(visitor => visitor.characterId === body.file || (selectedCard && visitor.name === selectedCard.name));
          if (existing && !existing.available) throw new Error(existing.unavailableReason);
          return routeContext.json({ ok: true, ...(await inviteCharacter(ctx, body.file)) });
        } catch (error) {
          return routeContext.json({ ok: false, error: error?.message || String(error) }, 500);
        }
      });

      // 正在 Hana 做客的访客：只认鲜花酿自己的台账，不会把本家伙伴算进来。
      app.get("/workbench/visitors", async (routeContext) => {
        try {
          return routeContext.json({ ok: true, visitors: await workbenchVisitors(ctx) });
        } catch (error) {
          return routeContext.json({ ok: false, error: error?.message || String(error), visitors: [] }, 500);
        }
      });

      app.post("/workbench/visitors/settle", async (routeContext) => {
        const body = await readBody(routeContext);
        try {
          await requireManagedVisitor(ctx, String(body.agentId || ''));
          return routeContext.json({ ok: true, visitor: await settleVisitor(ctx, String(body.agentId || "")) });
        } catch (error) {
          return routeContext.json({ ok: false, error: error?.message || String(error) }, 500);
        }
      });

      app.post("/workbench/visitors/depart", async (routeContext) => {
        const body = await readBody(routeContext);
        try {
          await requireManagedVisitor(ctx, String(body.agentId || ''));
          return routeContext.json({ ok: true, visitor: await departVisitor(ctx, String(body.agentId || "")) });
        } catch (error) {
          return routeContext.json({ ok: false, error: error?.message || String(error) }, 500);
        }
      });

      app.post("/workbench/visitors/uninvite", async (routeContext) => {
        const body = await readBody(routeContext);
        try {
          await requireManagedVisitor(ctx, String(body.agentId || ''));
          return routeContext.json({ ok: true, visitor: await uninviteVisitor(ctx, String(body.agentId || "")) });
        } catch (error) {
          return routeContext.json({ ok: false, error: error?.message || String(error) }, 500);
        }
      });

      app.post("/workbench/visitors/repair", async (routeContext) => {
        const body = await readBody(routeContext);
        try {
          await requireManagedVisitor(ctx, String(body.agentId || ''));
          return routeContext.json(await repairVisitor(ctx, String(body.agentId || "")));
        } catch (error) {
          return routeContext.json({ ok: false, error: error?.message || String(error) }, 500);
        }
      });

      // 内置酒馆皮肤：薄荷手帐主题 + 跟随 Hana 深浅。
      app.get("/tavern/skin/status", async (routeContext) => {
        try {
          return routeContext.json({ ok: true, ...(await getSkinStatus(ctx)) });
        } catch (error) {
          return routeContext.json({ ok: false, error: error?.message || String(error) }, 500);
        }
      });

      app.post("/tavern/skin/apply", async (routeContext) => {
        try {
          return routeContext.json(await applySkin(ctx));
        } catch (error) {
          return routeContext.json({ ok: false, error: error?.message || String(error) }, 500);
        }
      });

      app.post("/tavern/skin/sync", async (routeContext) => {
        try {
          return routeContext.json({ ok: true, state: await syncSkinNow(ctx) });
        } catch (error) {
          return routeContext.json({ ok: false, error: error?.message || String(error) }, 500);
        }
      });

      // 把 Hana 伙伴带去酒馆：列出可导出的伙伴、预览、写角色卡。
      app.get("/workbench/agents", async (routeContext) => {
        try {
          return routeContext.json({ ok: true, agents: await listExportableAgents(ctx) });
        } catch (error) {
          return routeContext.json({ ok: false, error: error?.message || String(error), agents: [] }, 500);
        }
      });

      app.post("/workbench/export/preview", async (routeContext) => {
        const body = await readBody(routeContext);
        try {
          const [agents, persona] = await Promise.all([
            listExportableAgents(ctx),
            readPartnerPersona(ctx, String(body.agentId || "")),
          ]);
          const partner = agents.find((agent) => agent.id === body.agentId);
          if (!partner) throw new Error("没有找到这位伙伴。");
          const card = buildPartnerCard(partner, persona);
          return routeContext.json({
            ok: true,
            card,
            keptMemoryChars: persona.memory.length,
            dialectChars: (persona.dialect || "").length,
            bookEntries: card.data.character_book?.entries?.length || 0,
          });
        } catch (error) {
          return routeContext.json({ ok: false, error: error?.message || String(error) }, 500);
        }
      });

      app.post("/workbench/export", async (routeContext) => {
        const body = await readBody(routeContext);
        try {
          return routeContext.json(await exportPartnerToTavern(ctx, String(body.agentId || "")));
        } catch (error) {
          return routeContext.json({ ok: false, error: error?.message || String(error) }, 500);
        }
      });
    });
  } else {
    throw new Error('ctx.routes.register 不可用，工作台路由未注册。');
  }
  } catch (error) {
    for (const cleanup of toolCleanups.reverse()) await cleanup();
    await theater.dispose();
    await migration.dispose?.();
    await admin.dispose();
    throw error;
  }

  log.info(`v${version} 已加载，SillyTavern 尚未启动。`);

  // apply 只建立服务与注册工具，不请求受保护的运行时/资料能力。
  // 皮肤安装与同步延后到 /runtime/start 的明确请求。
  return async () => {
    try { await unregisterRoutes?.(); } catch (error) { log.warn(error?.message || error); }
    for (const cleanup of toolCleanups.reverse()) {
      try { await cleanup(); } catch (error) { log.warn(error?.message || error); }
    }
    await theater.dispose();
    await migration.dispose?.();
    await admin.dispose();
    acceptedStarts.clear();
    stopSkinSync();
    await stopServer(ctx, (level, message) => log[level]?.(message));
    log.info("已清理。");
  };
}
