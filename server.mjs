#!/usr/bin/env node
// AI Management APP — local server. © 2026 Jack Salameh. All rights reserved.
// Usage: node server.mjs [--open] [--port N] [--no-agents]
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { App, HttpError } from './lib/app.mjs';
import { defaultDataDir, migrateLegacyDataDir } from './lib/store.mjs';
import { ICON_MIME } from './lib/icons.mjs';
import { openExternal, launchDetached, which } from './lib/proc.mjs';
import { BRAND } from './lib/brand.mjs';
import { installLogRing, backupState } from './lib/support.mjs';
import os from 'node:os';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(ROOT, 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.ico': 'image/x-icon', '.woff2': 'font/woff2' };

export async function createServer({ dataDir = defaultDataDir(), codexHome, port = 0, startAgents = true, token = crypto.randomBytes(24).toString('base64url'), autoQuit = false } = {}) {
  const app = new App({ dataDir, ...(codexHome ? { codexHome } : {}) });
  const clients = new Set();
  app.on('event', (e) => { const data = `data: ${JSON.stringify(e)}\n\n`; for (const c of clients) c.write(data); });
  let actualPort = port;
  const allowedHosts = () => new Set([`127.0.0.1:${actualPort}`, `localhost:${actualPort}`]);

  const routes = {
    'GET /api/health': () => ({ ok: true, name: BRAND.name, version: BRAND.version, agents: Object.fromEntries(Object.entries(app.agents).map(([k, a]) => [k, a.status().state])) }),
    'GET /api/state': () => app.summary(),
    'POST /api/refresh': (b) => app.refresh({ full: b.full !== false }),
    'GET /api/conversation': (q) => app.openConversation(q.key, { limit: q.limit }),
    'GET /api/conversation/older': (q) => app.olderItems(q.key, q.before, q.limit),
    'POST /api/conversation/memory-setup': (b) => app.setupMemory(b.key, b),
    'GET /api/memory/preview': (q) => app.memoryPreview(q.key),
    'POST /api/drafts': (b) => app.setDraft(b.key, b.text),
    'GET /api/search': (q) => app.search(q),
    'GET /api/tools/check': (q) => app.checkTool(q.tool, q.folder),
    'GET /api/about': () => app.about(ROOT),
    'POST /api/about/updates': () => app.checkUpdates(ROOT),
    'POST /api/backups/create': () => app.backupNow(),
    'POST /api/backups/restore': (b) => app.restoreBackup(b.name),
    'GET /api/diagnostics': () => app.diagnostics(ROOT),
    'POST /api/conversation/new': (b) => app.newConversation(b),
    'POST /api/conversation/send': (b) => app.send(b.key, b),
    'POST /api/conversation/stop': (b) => app.stop(b.key),
    'POST /api/conversation/approve': (b) => app.approve(b.key, b.requestKey, b.decision, b.answers),
    'POST /api/conversation/rename': (b) => app.renameConversation(b.key, b.title),
    'POST /api/conversation/move': (b) => app.moveConversation(b.key, b.folder),
    'POST /api/conversation/archive': (b) => app.archiveConversation(b.key),
    'POST /api/conversation/unarchive': (b) => app.unarchiveConversation(b.key),
    'POST /api/conversation/delete': (b) => app.deleteConversation(b.key),
    'POST /api/conversation/options': (b) => app.setConversationOptions(b.key, b),
    'GET /api/memory': (q) => app.readMemory(q.file),
    'POST /api/memory': (b) => app.writeMemory(b.file, b.content, b.version),
    'GET /api/memory/catalog': () => app.memoryCatalog(),
    'POST /api/memory/folder': (b) => app.folderMemory(b.folder),
    'GET /api/fs/list': (q) => app.listDir(q.path),
    'POST /api/folder/add': (b) => app.addFolder(b.path, { create: !!b.create }),
    'POST /api/folder/new': (b) => app.newFolder(b.parent, b.name),
    'POST /api/folder/rename': (b) => app.renameFolder(b.path, b.name),
    'POST /api/folder/trash': (b) => app.trashFolder(b.path),
    'POST /api/folder/restore': (b) => app.restoreFolder(b.id),
    'POST /api/folder/purge': (b) => app.purgeFolder(b.id, b.confirm),
    'POST /api/folder/forget': (b) => app.forgetFolder(b.path),
    'POST /api/reveal': (b) => app.reveal(b.path),
    'POST /api/settings': (b) => app.updateSettings(b),
    'POST /api/tools': (b) => app.updateTool(b.tool, b.patch),
    'GET /api/tools/info': () => app.toolsInfo(),
    'POST /api/tools/vscode': (b) => app.openVSCode(b),
    'POST /api/tools/matlab': (b) => app.openMatlab(b),
    'POST /api/git/status': (b) => app.gitStatus(b),
    'POST /api/git/op': (b) => app.gitOp(b),
    'POST /api/git/diff': (b) => app.gitDiff(b),
    'POST /api/git/log': (b) => app.gitLog(b),
    'POST /api/git/pr': (b) => app.pullRequest(b),
    'GET /api/models': () => app.models(),
    'POST /api/models/add': (b) => app.addModel(b),
    'POST /api/models/import': (b) => app.importModelProfile(b),
    'POST /api/models/remove': (b) => app.removeModel(b.key),
    'POST /api/models/restore': () => app.restoreAgentModels(),
    'POST /api/models/refresh': (b) => app.refreshModels(b.agent),
    'GET /api/config': () => app.configSummary(),
    'POST /api/config/load': (b) => app.loadConfigToml(b.text),
    'GET /api/secrets': () => app.listSecrets(),
    'POST /api/secrets/set': (b) => app.setSecret(b.name, b.value, b.description),
    'POST /api/secrets/remove': (b) => app.removeSecret(b.name),
    'POST /api/jira/configure': (b) => app.configureJira(b),
    'POST /api/jira/login': () => app.jiraLogin(),
    'GET /api/skills': (q) => app.listSkills(q.folder),
    'POST /api/skills/install': (b) => app.installSkill(b),
    'GET /api/plugins': () => app.plugins(),
    'POST /api/plugins/marketplace': (b) => app.addMarketplace(b.source),
    'POST /api/plugins/install': (b) => app.installPlugin(b),
    'POST /api/agent/restart': (b) => app.restartAgent(b.agent || 'codex'),
    'POST /api/agent/stop': (b) => app.stopAgent(b.agent || 'codex'),
    'POST /api/shutdown': () => { setTimeout(() => shutdown(0), 150); return { ok: true }; },
    'GET /api/providers': () => app.providersInfo(),
    'POST /api/providers/save': (b) => app.saveProvider(b),
    'POST /api/providers/remove': (b) => app.removeProvider(b.id),
    'POST /api/providers/test': (b) => app.testProvider(b.id),
    'GET /api/addons': () => app.addonsInfo(),
    'POST /api/addons/install': (b) => app.addonInstall(b),
    'POST /api/skills/preview': (b) => app.previewSkills(b.source),
    'POST /api/icons/fetch': (b) => app.fetchIcons(b.tools),
    'POST /api/icons/upload': (b) => app.uploadIcon(b.tool, b.name, b.data),
    'POST /api/icons/reset': (b) => app.resetIcon(b.tool),
    'GET /api/project': (q) => app.projectOverview(q.folder),
    'GET /api/project/files': (q) => app.listFiles(q.folder, q.sub),
    'GET /api/project/file': (q) => app.readProjectFile(q.folder, q.file),
    'POST /api/attachments': (b) => app.saveAttachment(b),
    'GET /api/conversation/files': (q) => app.conversationFiles(q.key),
    'GET /api/conversation/file': (q) => app.conversationFile(q.key, q.file),
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const security = { 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY' };
    // DNS-rebinding defence: only our own host names are accepted.
    if (!allowedHosts().has(req.headers.host || '')) { res.writeHead(421, security); res.end('Misdirected request'); return; }
    if (!url.pathname.startsWith('/api/')) return serveStatic(url.pathname, res, security);
    // Cross-site defence: API calls need the launch token (header, or query for EventSource) and a same-origin Origin.
    const origin = req.headers.origin;
    if (origin && !allowedHosts().has(origin.replace(/^https?:\/\//, ''))) { res.writeHead(403, security); res.end(); return; }
    const given = req.headers['x-cpm-token'] || url.searchParams.get('token') || '';
    if (!safeEqual(given, token)) { json(res, 401, { error: 'Open the app from its launcher (the session token is missing or expired).' }, security); return; }
    if (url.pathname === '/api/events') {
      res.writeHead(200, { ...security, 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
      res.write(`data: ${JSON.stringify({ type: 'hello' })}\n\n`);
      clients.add(res); clearTimeout(quitTimer);
      const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
      req.on('close', () => { clearInterval(ping); clients.delete(res); scheduleAutoQuit(); });
      return;
    }
    const icon = /^\/api\/icons\/([a-z]+)$/.exec(url.pathname);
    if (icon && req.method === 'GET') {
      const f = app.iconFile(icon[1]);
      if (!f) { res.writeHead(404, security); res.end(); return; }
      try {
        const data = await fsp.readFile(f);
        // A downloaded SVG must never execute in this origin: sandbox it.
        res.writeHead(200, { ...security, 'Content-Type': ICON_MIME[path.extname(f)] || 'application/octet-stream', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox", 'Cache-Control': 'no-cache' });
        res.end(data);
      } catch { res.writeHead(404, security); res.end(); }
      return;
    }
    const handler = routes[`${req.method} ${url.pathname}`];
    if (!handler) { json(res, 404, { error: 'Not found' }, security); return; }
    try {
      let body = {};
      if (req.method === 'POST') {
        if (!/^application\/json/.test(req.headers['content-type'] || '')) { json(res, 415, { error: 'JSON expected' }, security); return; }
        body = await readJson(req);
      }
      const result = await handler(req.method === 'GET' ? Object.fromEntries(url.searchParams) : body);
      json(res, 200, result ?? { ok: true }, security);
    } catch (e) {
      const status = e instanceof HttpError ? e.status : e?.constructor?.name === 'RpcError' || /timed out|not running/.test(e.message) ? 502 : 500;
      if (status === 500) console.error(`[${req.method} ${url.pathname}]`, e);
      json(res, e.code === 'WRITER_LOCK' || e.code === 'BUSY' ? 409 : status, { error: e.message, code: e.code || null }, security);
    }
  });

  async function serveStatic(p, res, security) {
    const rel = p === '/' ? 'index.html' : decodeURIComponent(p).replace(/^\/+/, '');
    const file = path.resolve(PUBLIC, rel);
    if (!file.startsWith(PUBLIC + path.sep)) { res.writeHead(403, security); res.end(); return; }
    try {
      const data = await fsp.readFile(file);
      res.writeHead(200, { ...security, 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache',
        ...(rel === 'index.html' ? { 'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'" } : {}) });
      res.end(data);
    } catch { res.writeHead(404, security); res.end('Not found'); }
  }

  // Closing the app window = quitting: when the last window has been gone for 20 s (a reload reconnects
  // within that time), agents are stopped and the server exits. Only for launcher starts (--open).
  let quitTimer = null;
  function scheduleAutoQuit() {
    if (!autoQuit || clients.size || app.s.settings.quitOnWindowClose === false) return;
    clearTimeout(quitTimer);
    quitTimer = setTimeout(() => { if (!clients.size) { console.log('[app] window closed — stopping agents and exiting'); shutdown(0); } }, +(process.env.CPM_AUTOQUIT_MS || 20_000));
  }

  async function shutdown(code) {
    for (const c of clients) { try { c.write(`data: ${JSON.stringify({ type: 'server.shutdown' })}\n\n`); c.end(); } catch { /* */ } }
    await app.shutdown().catch(() => {});
    try { const lock = JSON.parse(fs.readFileSync(lockFile, 'utf8')); if (lock.pid === process.pid) fs.rmSync(lockFile); } catch { /* */ }
    server.close(); server.closeAllConnections?.();
    if (process.env.CPM_NO_EXIT !== '1') process.exit(code);
  }

  const lockFile = path.join(dataDir, 'instance.json');
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  actualPort = server.address().port;
  await fsp.mkdir(dataDir, { recursive: true });
  await fsp.writeFile(lockFile, JSON.stringify({ pid: process.pid, port: actualPort, token, startedAt: Date.now() }), { mode: 0o600 });
  backupState(dataDir, { reason: 'startup' }).catch(() => {});
  if (startAgents) app.startAgents().catch((e) => console.warn('[agents]', e.message));
  return { app, server, port: actualPort, token, url: `http://127.0.0.1:${actualPort}/#t=${token}`, shutdown };
}

function stablePort() {
  const id = `${os.userInfo().username}@${os.hostname()}`;
  return 47100 + (parseInt(crypto.createHash('sha1').update(id).digest('hex').slice(0, 6), 16) % 800);
}
function safeEqual(a, b) { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); }
function json(res, status, obj, headers = {}) { res.writeHead(status, { ...headers, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); }
function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > 30 * 1024 * 1024) { reject(new HttpError(413, 'Request too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch { reject(new HttpError(400, 'Invalid JSON')); } });
    req.on('error', reject);
  });
}

/** Opens the UI as an app window (Edge/Chrome --app) when possible, otherwise in the default browser. */
export async function openUi(url, mode = 'app') {
  if (mode === 'app') {
    const candidates = process.platform === 'win32'
      ? [path.join(process.env['ProgramFiles(x86)'] || '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'), path.join(process.env.ProgramFiles || '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'), path.join(process.env.ProgramFiles || '', 'Google', 'Chrome', 'Application', 'chrome.exe'), path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'Application', 'chrome.exe')]
      : process.platform === 'darwin'
        ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge']
        : ['google-chrome', 'chromium', 'chromium-browser', 'microsoft-edge'];
    for (const c of candidates) {
      const exe = which(c);
      if (exe) { try { await launchDetached({ command: exe, prefixArgs: [], shell: false }, [`--app=${url}`, '--window-size=1400,900']); return; } catch { /* next */ } }
    }
  }
  await openExternal(url);
}

// ---------------------------------------------------------------- CLI entry
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const portArg = args.indexOf('--port');
  installLogRing();
  const dataDir = defaultDataDir();
  const migrated = migrateLegacyDataDir(dataDir);
  if (migrated) console.log(`Settings imported from ${migrated}`);
  const major = +process.versions.node.split('.')[0];
  if (major < 22) { console.error(`${BRAND.name} needs Node.js 22 or newer (found ${process.version}).`); process.exit(1); }
  // Single instance per OS user: reuse the running server and just open a window.
  try {
    const lock = JSON.parse(fs.readFileSync(path.join(dataDir, 'instance.json'), 'utf8'));
    const r = await fetch(`http://127.0.0.1:${lock.port}/api/health`, { headers: { 'x-cpm-token': lock.token }, signal: AbortSignal.timeout(1500) });
    if (r.ok) {
      const url = `http://127.0.0.1:${lock.port}/#t=${lock.token}`;
      console.log(`${BRAND.name} is already running: ${url}`);
      if (args.includes('--open')) await openUi(url);
      process.exit(0);
    }
  } catch { /* not running */ }
  // A stable per-user port keeps the browser origin constant across restarts (window size, theme cache);
  // if it is taken (e.g. by another user's instance), a free port is used instead.
  const wanted = portArg >= 0 ? +args[portArg + 1] : +(process.env.CPM_PORT || stablePort());
  let srv;
  const autoQuit = args.includes('--open');
  try { srv = await createServer({ dataDir, port: wanted, startAgents: !args.includes('--no-agents'), autoQuit }); }
  catch (e) { if (e.code !== 'EADDRINUSE') throw e; srv = await createServer({ dataDir, port: 0, startAgents: !args.includes('--no-agents'), autoQuit }); }
  console.log(`${BRAND.name} ${BRAND.version} — ${srv.url}`);
  if (args.includes('--open')) await openUi(srv.url, srv.app.s.settings.openMode);
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => srv.shutdown(0));
}
