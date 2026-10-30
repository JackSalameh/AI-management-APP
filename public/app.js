// Codex Projects Management — client. © 2026 Jack Salameh. All rights reserved.
import { icon, toolIcon, setLogos, agentIconName, FLAGS } from './icons.js';
import { t, setLang, getLang, LANGS } from './i18n.js';
import { renderMarkdown, esc, diffHtml, highlightCode } from './markdown.js';

// ------------------------------------------------------------------ bootstrap & API
const TOKEN = (() => {
  const m = /[#&]t=([\w-]+)/.exec(location.hash);
  try {
    if (m) { sessionStorage.setItem('cpm.token', m[1]); history.replaceState(null, '', location.pathname); return m[1]; }
    return sessionStorage.getItem('cpm.token') || '';
  } catch { return m ? m[1] : ''; }
})();

class ApiError extends Error { constructor(msg, code, status) { super(msg); this.code = code; this.status = status; } }
async function api(path, body) {
  let r;
  try {
    r = await fetch(path, { method: body === undefined ? 'GET' : 'POST', headers: { 'x-cpm-token': TOKEN, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  } catch { throw new ApiError(t('disconnected'), 'NETWORK', 0); }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new ApiError(j.error || `HTTP ${r.status}`, j.code, r.status);
  return j;
}
const q = (p) => '?' + new URLSearchParams(p).toString();

const store = {
  get(k, d) { try { const v = localStorage.getItem('cpm.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('cpm.' + k, JSON.stringify(v)); } catch { /* storage unavailable */ } },
};

// ------------------------------------------------------------------ state
const S = {
  sum: null,              // /api/state
  conv: null,             // open conversation { key, record, items, running, pending, memory }
  itemIdx: new Map(),
  compose: { modelKey: null, effort: null, mode: null },
  search: '', showArchived: false, showTrash: false,
  selFolder: null,
  git: { st: null, out: '', sel: new Set(), busy: false, msg: '' },
  banner: null,
  sending: false,
  conn: 'ok',             // 'ok' | 'lost' — browser ↔ app server (rec. 1)
  phase: {},              // key -> queued | running | approval | completed | failed | interrupted (rec. 6)
  ack: {},                // key -> { model, effort, provider } acknowledged by Codex
  usage: {},              // key -> token usage
  treeSig: '',
  turnsDone: {},          // key -> count of completed turns (guards the Send/complete race)
};
const convByKey = () => new Map((S.sum?.conversations || []).map((c) => [c.key, c]));
const pk = (p) => (/^[A-Za-z]:|^\\\\/.test(p || '') ? String(p).toLowerCase() : String(p || ''));
const settings = () => S.sum?.settings || {};
let saveSettingsTimer;
function patchSettings(patch, now = false) {
  Object.assign(S.sum.settings, patch);
  clearTimeout(saveSettingsTimer);
  const go = () => api('/api/settings', patch).catch(() => {});
  if (now) go(); else saveSettingsTimer = setTimeout(go, 300);
}

// ------------------------------------------------------------------ DOM helpers
// replaceChildren/append turn null into the text "null"; conditional children are common here, so drop them.
for (const m of ['replaceChildren', 'append', 'prepend']) {
  const orig = Element.prototype[m];
  Element.prototype[m] = function (...kids) { return orig.apply(this, kids.flat().filter((k) => k != null && k !== false)); };
}
function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'html') el.innerHTML = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat(Infinity)) if (c != null && c !== false) el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return el;
}
const ib = (name, tip, onclick, extra = {}) => h('button', { class: `ibtn ${extra.class || ''}`, 'data-tip': tip, 'aria-label': tip, onclick, html: icon(name), type: 'button', ...(extra.attrs || {}) });
function toast(msg, err = false, ms = 4200) {
  const el = h('div', { class: `toast ${err ? 'err' : ''}` }, msg);
  document.getElementById('toasts').append(el);
  setTimeout(() => el.remove(), err ? ms * 1.6 : ms);
}
const fail = (e) => toast(e.message || String(e), true);
async function copyText(s) { try { await navigator.clipboard.writeText(s); toast(t('copied')); } catch { prompt('', s); } }
const fmtTime = (ms) => { if (!ms) return ''; const d = new Date(ms); const now = new Date(); return d.toDateString() === now.toDateString() ? d.toLocaleTimeString(getLang(), { hour: '2-digit', minute: '2-digit' }) : d.toLocaleDateString(getLang(), { day: 'numeric', month: 'short' }); };
const effortLabel = (e) => { const k = `effort.${e}`; const s = t(k); return s === k ? e : s; };

// ------------------------------------------------------------------ menus & dialogs
let openMenuEl = null;
function closeMenu() { openMenuEl?.remove(); openMenuEl = null; }
function showMenu(anchor, items) {
  closeMenu();
  const m = h('div', { class: 'menu', role: 'menu' });
  for (const it of items) {
    if (it === '-') { m.append(h('hr')); continue; }
    if (!it || it.hidden) continue;
    m.append(h('button', { class: `${it.danger ? 'danger' : ''} ${it.cls || ''}`, onclick: () => { closeMenu(); it.run(); }, html: (it.html || icon(it.icon || 'chevron')) + `<span>${esc(it.label)}</span>` }));
  }
  document.body.append(m);
  const r = anchor.getBoundingClientRect ? anchor.getBoundingClientRect() : { left: anchor.x, bottom: anchor.y, top: anchor.y, right: anchor.x };
  const w = m.offsetWidth, hh = m.offsetHeight;
  m.style.left = Math.max(6, Math.min(r.left, innerWidth - w - 6)) + 'px';
  m.style.top = (r.bottom + hh + 6 > innerHeight ? Math.max(6, r.top - hh - 4) : r.bottom + 4) + 'px';
  openMenuEl = m;
}
document.addEventListener('mousedown', (e) => { if (openMenuEl && !openMenuEl.contains(e.target)) closeMenu(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { closeMenu(); [...document.querySelectorAll('.overlay')].pop()?.__close?.(); } });

/** Modal that closes on outside click and Escape (requirement). */
function modal({ title, body, foot, cls = '', onClose }) {
  const ov = h('div', { class: 'overlay' });
  const close = () => { ov.remove(); onClose?.(); };
  ov.__close = close;
  const dlg = h('div', { class: `dialog ${cls}`, role: 'dialog', 'aria-modal': 'true' },
    h('div', { class: 'dlg-head' }, h('h2', {}, title), ib('close', t('close'), close)),
    h('div', { class: 'dlg-body' }, body),
    foot ? h('div', { class: 'dlg-foot' }, foot) : null);
  ov.addEventListener('mousedown', (e) => { if (e.target === ov) close(); });
  ov.append(dlg); document.body.append(ov);
  setTimeout(() => dlg.querySelector('input:not([type=checkbox]),textarea,select')?.focus(), 30);
  return { close, dlg };
}
function ask({ title, label, value = '', okLabel = t('ok'), help, password = false, validate }) {
  return new Promise((resolve) => {
    let done = false;
    const input = h('input', { type: password ? 'password' : 'text', value, class: 'input', autocomplete: 'off', spellcheck: 'false' });
    const err = h('div', { class: 'help', style: { color: 'var(--danger)' } });
    const ok = () => { const v = input.value.trim(); const e = validate?.(v); if (e) { err.textContent = e; return; } done = true; m.close(); resolve(v); };
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') ok(); });
    const m = modal({ title, body: h('div', {}, help ? h('p', { class: 'help' }, help) : null, h('label', { class: 'field' }, h('span', {}, label), input), err), foot: [h('button', { class: 'btn', onclick: () => m.close() }, t('cancel')), h('button', { class: 'btn primary', onclick: ok }, okLabel)], onClose: () => { if (!done) resolve(null); } });
    setTimeout(() => { input.focus(); input.select(); }, 40);
  });
}
function confirmBox({ title, text, okLabel = t('ok'), danger = false }) {
  return new Promise((resolve) => {
    let done = false;
    const m = modal({ title, body: h('p', {}, text), foot: [h('button', { class: 'btn', onclick: () => m.close() }, t('cancel')), h('button', { class: `btn ${danger ? 'danger' : 'primary'}`, onclick: () => { done = true; m.close(); resolve(true); } }, okLabel)], onClose: () => { if (!done) resolve(false); } });
  });
}

// ------------------------------------------------------------------ theme & language
function applyTheme() {
  const th = settings().theme || 'system';
  const dark = th === 'dark' || (th === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  store.set('theme', th); try { localStorage.setItem('cpm.theme', th); } catch { /* */ }
}
matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', applyTheme);

// ------------------------------------------------------------------ shell
const $ = {};
function buildShell() {
  const app = document.getElementById('app');
  app.innerHTML = '';
  $.top = h('header', { class: 'topbar' });
  $.side = h('aside', { class: 'sidebar' });
  $.main = h('main', { class: 'main' });
  $.gitp = h('aside', { class: 'gitpanel hidden' });
  $.filesp = h('aside', { class: 'gitpanel filespanel hidden' });
  $.body = h('div', { class: 'body' }, $.side, $.main, $.gitp, $.filesp);
  app.append($.top, $.body);
}

async function renderTop() {
  const sum = S.sum, tools = sum.tools;
  // One pill for every AI the user can reach (CLI agents + API services).
  const agents = Object.entries(sum.agents).filter(([, a]) => a.state !== 'missing');
  const readyN = agents.filter(([, a]) => ['ready', 'idle'].includes(a.state)).length;
  const worst = agents.some(([, a]) => a.state === 'error') ? 'error' : agents.some(([, a]) => a.state === 'starting') ? 'starting' : readyN ? 'ready' : 'missing';
  const pill = h('button', { class: 'agent-pill', style: { border: 0, cursor: 'pointer' }, 'data-tip': agents.map(([, a]) => `${a.label}: ${t(a.state) || a.state}`).join(' · ') || t('accounts'), onclick: (e) => showMenu(e.currentTarget, [
    ...agents.map(([id, a]) => ({ label: `${a.label} — ${t(a.state) || a.state}`, html: `<span class="dot ${a.state}" style="margin:0 5px"></span>`, run: () => (id === 'codex' ? reconnect() : openSettings('accounts')) })),
    '-',
    { label: t('reconnect') + ' (Codex)', icon: 'refresh', run: reconnect },
    { label: t('accounts'), icon: 'key', run: () => openSettings('accounts') },
    { label: t('addons'), icon: 'puzzle', run: openAddons },
  ]) }, h('span', { class: `dot ${worst}` }), `AI · ${t('agentsReady', { n: readyN })}`);
  const toolBtn = async (id, label, onclick) => {
    const on = tools[id]?.enabled;
    const b = h('button', { class: `ibtn ${on ? '' : 'off'}`, 'data-tip': `${label}${on ? '' : ' — ' + t('enabled').toLowerCase() + ': ✕'}`, 'aria-label': label, html: await toolIcon(id), onclick: on ? onclick : () => openSettings('tools', id) });
    return b;
  };
  // Jira and Bitbucket open their panel once connected, otherwise the Connections menu (no need to tick them first).
  const connBtn = async (id, label, open) => h('button', { class: 'ibtn', 'data-tip': label, 'aria-label': label, html: await toolIcon(id), onclick: () => open().catch?.(fail) });
  const curFolder = () => S.conv?.record?.cwd || S.selFolder;
  const needFolder = (fn) => () => { const f = curFolder(); if (!f) { toast(t('openFolder'), true); return; } fn(f); };
  const buttons = await Promise.all([
    toolBtn('vscode', 'VS Code', needFolder((f) => api('/api/tools/vscode', S.conv ? { key: S.conv.key } : { folder: f }).catch(fail))),
    toolBtn('matlab', 'MATLAB', needFolder((f) => api('/api/tools/matlab', S.conv ? { key: S.conv.key } : { folder: f }).then((r) => toast(`MATLAB ${r.release}${r.connecting ? ' — ' + t('mcpConnecting') : ''}`)).catch(fail))),
    toolBtn('git', t('gitPanel'), () => toggleGit()),
    connBtn('bitbucket', 'Bitbucket', openBitbucketPanel),
    connBtn('jira', 'Jira', openJiraPanel),
  ]);
  const lang = getLang();
  $.top.replaceChildren(
    h('div', { class: 'brand' }, h('div', { class: 'mark', html: icon('logo') }), h('span', {}, sum.brand.name)),
    pill,
    h('div', { class: 'spacer' }),
    ...buttons,
    h('div', { class: 'sep' }),
    h('button', { class: 'langsel', 'data-tip': t('language'), onclick: (e) => showMenu(e.currentTarget, Object.entries(LANGS).map(([k, v]) => ({ label: v.name, html: FLAGS[k], cls: 'flagopt', run: () => changeLang(k) }))), html: FLAGS[lang] + `<span>${lang.toUpperCase()}</span>` }),
    ib(document.documentElement.dataset.theme === 'dark' ? 'sun' : 'moon', t('theme'), () => { patchSettings({ theme: document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark' }, true); applyTheme(); renderTop(); }),
    ib('search', t('searchAll') + ' (Ctrl+K)', () => openSearch()),
    ib('plug', t('connections'), () => openConnections()),
    ib('puzzle', t('addons'), () => openAddons()),
    h('button', { class: 'langsel', 'data-tip': t('simpleHelp'), onclick: () => { const m = (settings().uiMode || 'simple') === 'simple' ? 'pro' : 'simple'; patchSettings({ uiMode: m }, true); document.body.classList.toggle('mode-simple', m === 'simple'); renderAll(); } }, (settings().uiMode || 'simple') === 'simple' ? t('simpleMode') : t('proMode')),
    ib('gear', t('configuration'), () => openSettings()),
    ib('power', t('shutdown'), quitApp),
  );
}

/** Quit = stop every agent (ends account connections), stop the server, close the window. */
async function quitApp() {
  if (!await confirmBox({ title: t('shutdown'), text: t('quitOnClose'), okLabel: t('shutdown'), danger: true })) return;
  toast(t('closing'));
  await api('/api/shutdown', {}).catch(() => {});
  es?.close();
  window.close(); // works for the app window opened by the launcher
  setTimeout(showClosed, 300); // a normal browser tab may refuse to close itself
}

function changeLang(l) { setLang(l); patchSettings({ lang: l }, true); renderAll(); }

// ------------------------------------------------------------------ explorer
function isExpanded(p, depth) {
  const ex = settings().expanded || {};
  const k = pk(p);
  if (k in ex) return !!ex[k];
  const within = (p2) => { if (!p2) return false; const a = pk(p2); const sep = k.includes('\\') ? '\\' : '/'; return a === k || a.startsWith(k.endsWith(sep) ? k : k + sep); };
  if (within(S.conv?.record?.cwd) || within(S.selFolder)) return true;
  return depth <= 1;
}
function setExpanded(p, v) { const ex = { ...(settings().expanded || {}) }; ex[pk(p)] = v; patchSettings({ expanded: ex }); }

function renderSidebar() {
  const convs = convByKey();
  const head = h('div', { class: 'side-head' },
    h('h2', {}, t('explorer')),
    ib('chatPlus', t('newChat'), () => newConversation()),
    ib('folderPlus', t('newFolder'), () => newFolder(S.selFolder || S.conv?.record?.cwd)),
    ib('folderOpen', t('openFolder'), () => openFolderFlow()),
    ib('refresh', t('refresh'), () => api('/api/refresh', {}).then((s) => { S.sum = s; renderSidebar(); }).catch(fail)),
    ib('sidebar', t('hideFolders'), () => toggleSidebar(true)),
  );
  const search = h('input', { placeholder: t('search'), value: S.search, oninput: (e) => { S.search = e.target.value; renderTree(); } });
  $.tree = h('div', { class: 'tree', role: 'tree' });
  const foot = h('div', { class: 'side-foot' },
    h('button', { class: `btn small ${S.showArchived ? 'primary' : ''}`, onclick: () => { S.showArchived = !S.showArchived; S.showTrash = false; renderSidebar(); }, html: icon('archive') + t('archived') }),
    h('button', { class: `btn small ${S.showTrash ? 'primary' : ''}`, onclick: () => { S.showTrash = !S.showTrash; S.showArchived = false; renderSidebar(); }, html: icon('trash') + `${t('trash')}${S.sum.trash.length ? ` (${S.sum.trash.length})` : ''}` }),
  );
  $.side.replaceChildren(head, h('div', { class: 'side-search', html: icon('search') }, search), $.tree, foot);
  renderTree(convs);
}

function renderTree(convs = convByKey()) {
  const tree = $.tree; tree.replaceChildren();
  if (S.showTrash) return renderTrash(tree);
  if (S.showArchived) return renderArchived(tree, convs);
  const term = S.search.trim().toLowerCase();
  const matches = (key) => { const c = convs.get(key); return c && (!term || c.title.toLowerCase().includes(term) || (c.cwd || '').toLowerCase().includes(term)); };
  const visible = (node) => !term || node.conversations.some(matches) || node.children.some(visible) || node.name.toLowerCase().includes(term);
  const walk = (node, depth, parent) => {
    if (!visible(node)) return;
    const open = term ? true : isExpanded(node.path, depth);
    const pad = 4 + depth * 14;
    const row = h('div', { class: `row folder ${open ? 'open' : ''} ${S.project && pk(S.project.folder) === pk(node.path) && !S.conv ? 'selected' : ''}`, role: 'treeitem', style: { paddingLeft: pad + 'px' }, title: node.path,
      onclick: (e) => { S.selFolder = node.path; if (e.target.closest('.twisty') || depth === 0) { setExpanded(node.path, !open); renderTree(); return; } if (!open) setExpanded(node.path, true); openProject(node.path); },
      oncontextmenu: (e) => { e.preventDefault(); folderMenu(e.target.closest('.row'), node); },
      ondragover: (e) => { if (e.dataTransfer.types.includes('cpm/conv')) { e.preventDefault(); row.classList.add('drop'); } },
      ondragleave: () => row.classList.remove('drop'),
      ondrop: (e) => { row.classList.remove('drop'); const key = e.dataTransfer.getData('cpm/conv'); if (key) api('/api/conversation/move', { key, folder: node.path }).then(afterChange).catch(fail); } },
    h('span', { class: 'twisty', html: icon('chevron') }),
    h('span', { class: 'kind', html: icon(depth === 0 ? 'drive' : open ? 'folderOpen' : 'folder') }),
    h('span', { class: 'label' }, node.name),
    node.total ? h('span', { class: 'count' }, node.total) : null,
    depth > 0 ? h('button', { class: 'ibtn rowbtn', 'data-tip': t('projectHub'), html: icon('home'), onclick: (e) => { e.stopPropagation(); openProject(node.path); } }) : null,
    h('button', { class: 'ibtn rowbtn', 'data-tip': t('newChatHere'), html: icon('plus'), onclick: (e) => { e.stopPropagation(); newConversation(node.path); } }),
    h('button', { class: 'ibtn rowbtn', 'data-tip': '⋯', html: icon('more'), onclick: (e) => { e.stopPropagation(); folderMenu(e.currentTarget, node); } }));
    tree.append(row);
    if (!open) return;
    for (const child of node.children) walk(child, depth + 1, node);
    for (const key of node.conversations) {
      const c = convs.get(key);
      if (!c || !matches(key)) continue;
      const sel = S.conv?.key === key;
      tree.append(h('div', { class: `row conv ${sel ? 'selected' : ''}`, role: 'treeitem', style: { paddingLeft: pad + 18 + 'px' }, draggable: 'true', title: `${c.title}\n${c.cwd}`,
        ondragstart: (e) => e.dataTransfer.setData('cpm/conv', key),
        onclick: () => openConversation(key),
        oncontextmenu: (e) => { e.preventDefault(); convMenu(e.target.closest('.row'), c); } },
      h('span', { class: 'kind', html: c.running ? '<span class="dot running" style="margin:0 4px"></span>' : icon(c.agent === 'claude' ? 'bot' : 'chat') }),
      h('span', { class: 'label' }, c.title),
      h('span', { class: 'count' }, fmtTime(c.updatedAt)),
      h('button', { class: 'ibtn rowbtn', 'data-tip': '⋯', html: icon('more'), onclick: (e) => { e.stopPropagation(); convMenu(e.currentTarget, c); } })));
    }
    if (!node.conversations.length && !node.children.length && depth > 0) tree.append(h('div', { class: 'empty-note', style: { paddingLeft: pad + 36 + 'px' } }, t('emptyFolder')));
    void parent;
  };
  for (const r of S.sum.tree) walk(r, 0, null);
  if (!S.sum.tree.length) tree.append(h('div', { class: 'empty-note' }, t('noConversations')));
}

function renderArchived(tree, convs) {
  const list = [...convs.values()].filter((c) => c.archived);
  if (!list.length) { tree.append(h('div', { class: 'empty-note' }, '—')); return; }
  for (const c of list) {
    tree.append(h('div', { class: 'row conv', style: { paddingLeft: '8px' }, title: c.cwd, onclick: () => openConversation(c.key) },
      h('span', { class: 'kind', html: icon('archive') }), h('span', { class: 'label' }, c.title),
      h('button', { class: 'ibtn rowbtn show', 'data-tip': t('unarchive'), html: icon('restore'), onclick: (e) => { e.stopPropagation(); api('/api/conversation/unarchive', { key: c.key }).then(afterChange).catch(fail); } }),
      h('button', { class: 'ibtn rowbtn show', 'data-tip': t('delete'), html: icon('trash'), onclick: (e) => { e.stopPropagation(); deleteConversation(c); } })));
  }
}

function renderTrash(tree) {
  if (!S.sum.trash.length) { tree.append(h('div', { class: 'empty-note' }, '—')); return; }
  for (const it of S.sum.trash) {
    const name = it.originalPath.split(/[\\/]/).filter(Boolean).pop();
    tree.append(h('div', { class: 'row', style: { paddingLeft: '8px' }, title: it.originalPath },
      h('span', { class: 'kind', html: icon('folder') }), h('span', { class: 'label' }, name),
      h('button', { class: 'ibtn rowbtn show', 'data-tip': t('restore'), html: icon('restore'), onclick: () => api('/api/folder/restore', { id: it.id }).then(afterChange).catch(fail) }),
      h('button', { class: 'ibtn rowbtn show', 'data-tip': t('erase'), html: icon('trash'), onclick: async () => {
        const v = await ask({ title: t('erase'), label: t('name'), help: t('confirmErase', { name }), okLabel: t('erase') });
        if (v != null) api('/api/folder/purge', { id: it.id, confirm: v }).then(afterChange).catch(fail);
      } })));
  }
}

function folderMenu(anchor, node) {
  const isRoot = /^[A-Za-z]:\\?$/.test(node.path) || node.path === '/' || /^\\\\[^\\]+\\[^\\]+$/.test(node.path);
  showMenu(anchor, [
    { label: t('newChatHere'), icon: 'chatPlus', run: () => newConversation(node.path) },
    { label: t('newFolderHere'), icon: 'folderPlus', run: () => newFolder(node.path) },
    '-',
    { label: t('folderContext'), icon: 'fileText', run: () => openFolderMemory(node.path, 'context') },
    { label: t('folderInstructions'), icon: 'book', run: () => openFolderMemory(node.path, 'instructions') },
    '-',
    { label: t('renameOnDisk'), icon: 'edit', hidden: isRoot, run: () => renameFolder(node) },
    { label: t('revealFolder'), icon: 'folderOpen', run: () => api('/api/reveal', { path: node.path }).catch(fail) },
    { label: t('copyPath'), icon: 'copy', run: () => copyText(node.path) },
    { label: t('forget'), icon: 'close', hidden: !node.pinned, run: () => api('/api/folder/forget', { path: node.path }).then(afterChange).catch(fail) },
    '-',
    { label: t('moveToTrash'), icon: 'trash', danger: true, hidden: isRoot, run: async () => { if (await confirmBox({ title: t('moveToTrash'), text: node.path, okLabel: t('moveToTrash'), danger: true })) api('/api/folder/trash', { path: node.path }).then(afterChange).catch(fail); } },
  ]);
}

function convMenu(anchor, c) {
  showMenu(anchor, [
    { label: t('rename'), icon: 'edit', run: () => renameConversation(c) },
    { label: t('moveTo'), icon: 'folder', run: async () => { const f = await pickFolder(c.cwd); if (f) api('/api/conversation/move', { key: c.key, folder: f }).then(afterChange).catch(fail); } },
    { label: t('revealFolder'), icon: 'folderOpen', run: () => api('/api/reveal', { path: c.cwd }).catch(fail) },
    '-',
    { label: c.archived ? t('unarchive') : t('archive'), icon: 'archive', run: () => api(c.archived ? '/api/conversation/unarchive' : '/api/conversation/archive', { key: c.key }).then(afterChange).catch(fail) },
    { label: t('delete'), icon: 'trash', danger: true, run: () => deleteConversation(c) },
  ]);
}

async function deleteConversation(c) {
  if (!await confirmBox({ title: t('delete'), text: `“${c.title}”`, okLabel: t('delete'), danger: true })) return;
  try { await api('/api/conversation/delete', { key: c.key }); if (S.conv?.key === c.key) { S.conv = null; } await afterChange(); } catch (e) { fail(e); }
}

async function renameConversation(c) {
  const v = await ask({ title: t('rename'), label: t('title'), value: c.title });
  if (v) { await api('/api/conversation/rename', { key: c.key, title: v }).catch(fail); await afterChange(); }
}

async function renameFolder(node) {
  const cur = node.path.split(/[\\/]/).filter(Boolean).pop();
  const v = await ask({ title: t('renameOnDisk'), label: t('name'), value: cur });
  if (!v || v === cur) return;
  try { const r = await api('/api/folder/rename', { path: node.path, name: v }); if (S.selFolder === node.path) S.selFolder = r.path; await afterChange(); } catch (e) { fail(e); }
}

async function newFolder(parent) {
  if (!parent) { const f = await pickFolder(); if (!f) return; parent = f; }
  const v = await ask({ title: t('newFolder'), label: t('name'), help: parent });
  if (!v) return;
  try { const r = await api('/api/folder/new', { parent, name: v }); S.selFolder = r.path; setExpanded(parent, true); await afterChange(); } catch (e) { fail(e); }
}

async function openFolderFlow() {
  const f = await pickFolder();
  if (!f) return;
  try { const r = await api('/api/folder/add', { path: f, create: true }); S.selFolder = r.path; await afterChange(); } catch (e) { fail(e); }
}

/** Available AIs for a new conversation: installed CLI agents and configured API services. */
function availableAgents() {
  return Object.entries(S.sum.agents).filter(([, a]) => ['ready', 'idle', 'starting', 'stopped', 'error'].includes(a.state) && !(a.kind === 'api' && a.state === 'stopped')).map(([id, a]) => ({ id, label: a.label, cap: S.sum.capabilities?.[id] || {} }));
}

/** One window: choose the AI, then title, context and instructions (the memory files are optional). */
async function newConversation(folder, opts = {}) {
  folder = folder || S.selFolder || S.conv?.record?.cwd;
  if (!folder) { folder = await pickFolder(); if (!folder) return; }
  const agents = availableAgents();
  let agent = agents.find((a) => a.id === (opts.agent || settings().defaultAgent))?.id || agents[0]?.id;
  if (!agent) { toast(t('accounts'), true); openSettings('accounts'); return; }
  const cards = h('div', { class: 'agent-cards' });
  const drawCards = async () => cards.replaceChildren(...await Promise.all(agents.map(async (a) => {
    const [ik, fb] = agentIconName(a.id);
    return h('button', { class: `agent-card ${a.id === agent ? 'on' : ''}`, type: 'button', onclick: () => { agent = a.id; drawCards(); },
      html: `${await toolIcon(ik, fb)}<span><strong>${esc(a.label)}</strong><small>${esc(a.cap.files ? t('canEdit') : t('chatOnly'))}</small></span>` });
  })));
  await drawCards();
  const title = h('input', { class: 'input', placeholder: t('untitled') });
  const ctx = h('textarea', { class: 'input', rows: 5, placeholder: 'e.g. Optical bench X1191 — 5 MP camera, 3.45 µm pixels. Goal: focal length within ±0.5 %.' });
  const ins = h('textarea', { class: 'input', rows: 5, placeholder: 'e.g. Explain before acting. Use MATLAB. Report values with uncertainty.' });
  const mem = h('input', { type: 'checkbox' });
  const sync = () => { if ((ctx.value.trim() || ins.value.trim()) && !mem.dataset.touched) mem.checked = true; };
  const relTo = (base, f) => { const b = base.replace(/[\\/]+$/, ''); return f.toLowerCase().startsWith(b.toLowerCase()) ? f.slice(b.length + 1) : f; };
  ctx.addEventListener('input', sync); ins.addEventListener('input', sync); mem.addEventListener('change', () => { mem.dataset.touched = '1'; });
  const go = async () => {
    btn.disabled = true;
    try {
      const m = defaultModelFor(agent);
      const r = await api('/api/conversation/new', { agent, folder, title: title.value.trim() || undefined, modelKey: m?.key, effort: chooseEffort(m) });
      patchSettings({ defaultAgent: agent }, true);
      const typed = ctx.value.trim() || ins.value.trim();
      if (!has || (mem.checked && typed)) await api('/api/conversation/memory-setup', { key: r.key, enable: mem.checked, title: title.value.trim(), context: ctx.value, instructions: ins.value });
      dlg.close();
      await loadState(false);
      await openConversation(r.key, { quiet: true });
      if (opts.prompt && $.input) { $.input.value = opts.prompt; $.input.dispatchEvent(new Event('input')); }
      setTimeout(() => $.input?.focus(), 60);
    } catch (e) { btn.disabled = false; fail(e); }
  };
  const btn = h('button', { class: 'btn primary', onclick: go }, t('create'));
  // Context/instructions already in this folder (or its parents) are loaded; otherwise offer to create them.
  let found = { files: [] };
  try { found = await api('/api/memory/discover' + q({ folder })); } catch { /* folder not created yet */ }
  const has = found.files.some((f) => f.current);
  if (!has && settings().askMemory !== false) { mem.checked = true; mem.dataset.touched = ''; }
  const dlg = modal({ title: t('newChatTitle'), cls: 'mid', body: h('div', {},
      h('div', { class: 'help' }, folder),
      h('div', { class: 'field' }, h('span', {}, t('chooseAI')), cards),
      field(t('titleOptional'), title),
      found.files.length ? h('div', { class: 'banner info mem-found' }, h('span', { html: icon('book') }), h('div', {}, h('div', {}, t('memFoundFiles')), ...found.files.map((f) => h('div', { class: 'mono' }, '✓ ' + relTo(folder, f.file))))) : null,
      has ? null : h('div', { class: 'banner warn mem-none' }, h('span', { html: icon('info') }), h('div', {}, found.files.length ? t('memNoneHere') : t('memNoneFound'))),
      h('details', { class: 'mem-details', open: !has || (settings().uiMode || 'simple') === 'pro' ? true : null }, h('summary', {}, has ? t('memAddTo') : t('memSetupTitle')),
        h('p', { class: 'help' }, has ? t('memAddHelp') : t('memSetupIntro')), field(t('contextBox'), ctx), field(t('instructionsBox'), ins),
        h('label', { class: 'check' }, mem, h('span', {}, has ? t('memAppend') : t('withMemory'))))),
    foot: [h('button', { class: 'btn', onclick: () => dlg.close() }, t('cancel')), btn] });
  setTimeout(() => title.focus(), 40);
}

function toggleSidebar(hidden) { patchSettings({ sidebarHidden: hidden }); $.body.classList.toggle('side-hidden', hidden); renderMain(); }

// ------------------------------------------------------------------ folder picker
function pickFolder(start) {
  return new Promise((resolve) => {
    let cur = null, done = false;
    const pathEl = h('div', { class: 'picker-path' });
    const list = h('div', { class: 'picker-list' });
    const typed = h('input', { class: 'input', placeholder: S.sum.platform === 'win32' ? 'D:\\X1191\\New topic' : '/home/me/projects/new-topic', spellcheck: 'false' });
    const load = async (p) => {
      try {
        const r = await api('/api/fs/list' + q({ path: p || '' }));
        cur = r.path; pathEl.textContent = r.path || '—';
        list.replaceChildren(
          ...(r.parent != null ? [h('button', { onclick: () => load(r.parent), html: icon('chevron', 'rot') + '<span>..</span>' })] : []),
          ...r.dirs.map((d) => h('button', { ondblclick: () => load(d.path), onclick: (e) => { list.querySelectorAll('button').forEach((b) => b.style.background = ''); e.currentTarget.style.background = 'var(--accent-soft)'; cur = d.path; pathEl.textContent = d.path; }, html: icon(r.path ? 'folder' : 'drive') + `<span>${esc(d.name)}</span>` })),
        );
      } catch (e) { fail(e); }
    };
    const finish = (v) => { done = true; m.close(); resolve(v); };
    const m = modal({ title: t('folderPicker'), cls: 'mid', body: h('div', {}, pathEl, list, h('label', { class: 'field' }, h('span', {}, t('newFolderPath')), typed)),
      foot: [h('button', { class: 'btn', onclick: () => m.close() }, t('cancel')), h('button', { class: 'btn primary', onclick: () => { const v = typed.value.trim() || cur; if (v) finish(v); } }, t('choose'))],
      onClose: () => { if (!done) resolve(null); } });
    load(start || S.selFolder || '');
  });
}

// ------------------------------------------------------------------ models
function modelsFor(agent) { return (S.sum.models || []).filter((m) => m.agent === agent); }
function defaultModelFor(agent, prefer) {
  const list = modelsFor(agent);
  return list.find((m) => m.key === prefer) || list.find((m) => m.key === settings().lastModelKey) || list.find((m) => m.isDefault) || list[0] || null;
}
function chooseEffort(model, prefer) {
  if (!model) return prefer || null;
  const list = model.efforts?.length ? model.efforts : ['low', 'medium', 'high'];
  for (const e of [prefer, settings().modelEfforts?.[model.key], model.defaultEffort, 'medium']) if (e && list.includes(e)) return e;
  return list[0];
}

// ------------------------------------------------------------------ conversation
async function openConversation(key, { quiet = false, limit, isNew = false, focusText } = {}) {
  S.project = null;
  try {
    const data = await api('/api/conversation' + q({ key, ...(limit ? { limit } : {}) }));
    const keepCompose = quiet && S.conv?.key === key;
    S.conv = data; S.itemIdx = new Map(data.items.map((i) => [i.id, i]));
    if (!data.draft) S.conv.draft = store.get('draft.' + key, '');
    S.selFolder = data.record.cwd;
    if (!keepCompose) {
      const m = defaultModelFor(data.record.agent, data.record.modelKey);
      S.compose = { modelKey: m?.key || null, effort: chooseEffort(m, data.record.effort), mode: data.record.actionMode || settings().defaultActionMode || 'ask' };
      S.banner = null; S.git.st = null;
    }
    renderSidebar(); renderMain(); if (settings().gitPanelOpen) loadGit(); if (S.filesOpen) { S.files = null; loadFiles(); }
    if (focusText) highlightText(focusText);
    if (isNew) memorySetupDialog(key, { isNew: true });
    else if (!quiet && data.record.memoryState === 'ask' && settings().askMemory !== false) askMemoryForExisting(key);
  } catch (e) { fail(e); }
}

function highlightText(text) {
  const needle = text.toLowerCase();
  const els = [...($.streamInner?.querySelectorAll('.msg-user, .msg-agent') || [])];
  const el = els.reverse().find((x) => x.textContent.toLowerCase().includes(needle));
  if (!el) return;
  el.scrollIntoView({ block: 'center' });
  el.classList.add('flash'); setTimeout(() => el.classList.remove('flash'), 2600);
}

// ------------------------------------------------------------------ memory setup (opt-in context & instructions)
async function askMemoryForExisting(key) {
  const dont = h('input', { type: 'checkbox' });
  let answered = false;
  const rec = S.conv?.key === key ? S.conv.record : {};
  const searched = rec.memoryFound?.searched || [];
  const m = modal({ title: t('memAskExisting'), body: h('div', {},
    h('p', {}, t('memNoneHere')),
    (rec.memoryFound?.files || []).length ? h('div', { class: 'banner info' }, h('div', {}, h('div', {}, t('memFromParents')), ...rec.memoryFound.files.map((f) => h('div', { class: 'mono' }, '✓ ' + f.file)))) : null,
    searched.length ? h('details', {}, h('summary', { class: 'help', style: { cursor: 'pointer' } }, t('memSearched')), ...searched.map((d) => h('div', { class: 'mono help' }, d))) : null,
    h('p', {}, t('memAskText')), h('label', { class: 'check' }, dont, h('span', {}, t('dontAskAgain')))),
    foot: [
      h('button', { class: 'btn', onclick: async () => { answered = true; m.close(); if (dont.checked) patchSettings({ askMemory: false }, true); await api('/api/conversation/memory-setup', { key, enable: false }).catch(fail); if (S.conv?.key === key) S.conv.record.memoryState = 'declined'; } }, t('noThanks')),
      h('button', { class: 'btn primary', onclick: () => { answered = true; m.close(); memorySetupDialog(key, { isNew: false }); } }, t('yesCreate'))],
    onClose: () => { void answered; } });
}

/** Window with the conversation name and two independent boxes (context / instructions). */
function memorySetupDialog(key, { isNew }) {
  const rec = S.conv?.key === key ? S.conv.record : convByKey().get(key) || {};
  const title = h('input', { class: 'input', value: rec.title && rec.title !== t('untitled') && rec.title !== 'New conversation' ? rec.title : '', placeholder: t('untitled') });
  const ctx = h('textarea', { class: 'input', rows: 7, placeholder: 'e.g. Optical bench X1191 — 5 MP camera, 3.45 µm pixels. Calibration images in ./calib. Goal: focal length within ±0.5 %.' });
  const ins = h('textarea', { class: 'input', rows: 7, placeholder: 'e.g. Explain the method before running code. Use MATLAB. Report values with uncertainty. Ask before deleting files.' });
  let done = false;
  const finish = async (enable) => {
    done = true;
    try {
      const r = await api('/api/conversation/memory-setup', { key, enable, title: title.value.trim(), context: enable ? ctx.value : '', instructions: enable ? ins.value : '' });
      m.close();
      if (r.warnings?.length) toast(r.warnings.join('\n'));
      await loadState(false);
      if (S.conv?.key === key) { await refreshMemoryInfo(); renderMain(); if (r.files && Object.keys(r.files).length) toast(t('memCreated', { files: Object.values(r.files).map((f) => f.split(/[\\/]/).pop()).join(', ') })); }
      setTimeout(() => $.input?.focus(), 60);
    } catch (e) { done = false; fail(e); }
  };
  const m = modal({ title: t('memSetupTitle'), cls: 'mid', body: h('div', {}, h('p', { class: 'help' }, t('memSetupIntro')),
      field(t('title'), title), field(t('contextBox'), ctx), field(t('instructionsBox'), ins)),
    foot: [h('button', { class: 'btn', onclick: () => finish(false) }, isNew ? t('skipNoFiles') : t('noThanks')), h('button', { class: 'btn primary', onclick: () => finish(true) }, t('createFiles'))],
    onClose: () => { if (!done && isNew && title.value.trim()) api('/api/conversation/rename', { key, title: title.value.trim() }).then(() => loadState(false)).catch(() => {}); } });
  setTimeout(() => title.focus(), 40);
}

// ------------------------------------------------------------------ search (rec. 4)
function flatFolders(nodes, depth = 0, out = []) { for (const n of nodes) { out.push({ path: n.path, label: '  '.repeat(depth) + n.name }); if (depth < 4) flatFolders(n.children, depth + 1, out); } return out; }
function openSearch() {
  const qi = h('input', { class: 'input', placeholder: t('searchPlaceholder'), spellcheck: 'false' });
  const folder = h('select', { class: 'input' }, h('option', { value: '' }, t('anyFolder')), ...flatFolders(S.sum.tree).map((f) => h('option', { value: f.path }, f.label)));
  const days = h('select', { class: 'input' }, ...[['', t('anyTime')], ['7', t('last7')], ['30', t('last30')], ['90', t('last90')]].map(([v, l]) => h('option', { value: v }, l)));
  const list = h('div', { class: 'list search-results' });
  let timer, seq = 0;
  const run = async () => {
    const my = ++seq;
    if (qi.value.trim().length < 2) { list.replaceChildren(); return; }
    list.replaceChildren(h('div', { class: 'li help' }, '…'));
    try {
      const r = await api('/api/search' + q({ q: qi.value, folder: folder.value, days: days.value }));
      if (my !== seq) return;
      if (!r.results.length) { list.replaceChildren(h('div', { class: 'li help' }, t('noResults'))); return; }
      const kindLabel = { title: t('inTitle'), user: t('inUser'), agent: t('inAgent'), memory: t('inMemory') };
      list.replaceChildren(...r.results.map((x) => h('button', { class: 'li search-hit', onclick: () => { m.close(); if (x.kind === 'memory' && x.file) openMemoryEditor(x.file, x.fileName); else if (x.key) openConversation(x.key, { limit: 5000, focusText: x.match || qi.value.split(/\s+/)[0] }); } },
        h('span', { class: 'badge' }, kindLabel[x.kind] || x.kind),
        h('div', { class: 'grow' }, h('div', {}, x.title || x.fileName || ''), h('div', { class: 'sub', html: markTerms(x.snippet, qi.value) }), h('div', { class: 'sub' }, `${x.cwd || ''} · ${fmtTime(x.updatedAt)}`)))));
    } catch (e) { list.replaceChildren(h('div', { class: 'li help' }, e.message)); }
  };
  qi.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(run, 250); });
  folder.onchange = run; days.onchange = run;
  const m = modal({ title: t('searchAll'), cls: 'mid', body: h('div', {}, qi, h('div', { class: 'inline' }, field(t('openFolder'), folder), field(t('created'), days)), list) });
  setTimeout(() => qi.focus(), 40);
}
function markTerms(text, query) {
  let html = esc(text);
  for (const term of query.split(/\s+/).filter((x) => x.length > 1)) html = html.replace(new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), (mm) => `<mark>${mm}</mark>`);
  return html;
}
document.addEventListener('keydown', (e) => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k' && S.sum) { e.preventDefault(); openSearch(); } });

// ------------------------------------------------------------------ memory workspace (rec. 5)
async function openMemoryWorkspace() {
  if (!S.conv) return;
  const key = S.conv.key;
  const body = h('div');
  const draw = async () => {
    let p;
    try { p = await api('/api/memory/preview' + q({ key })); } catch (e) { body.replaceChildren(h('div', { class: 'errorbox' }, e.message)); return; }
    const exclude = new Set(p.parts.filter((x) => !x.included && x.file).map((x) => x.file));
    const setExclude = async () => { await api('/api/conversation/options', { key, exclude: [...exclude] }).catch(fail); draw(); };
    const pinInput = h('input', { class: 'input', placeholder: t('pinPlaceholder') });
    const addPin = async () => { const v = pinInput.value.trim(); if (!v) return; await api('/api/conversation/options', { key, pins: [...p.pins, v] }).catch(fail); draw(); };
    pinInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') addPin(); });
    const tag = (c) => c === 'changed' ? h('span', { class: 'kindtag update' }, t('changed')) : c === 'new' ? h('span', { class: 'kindtag add' }, t('isNew')) : c === 'same' ? h('span', { class: 'kindtag' }, t('unchanged')) : null;
    body.replaceChildren(
      p.memoryState !== 'enabled' ? h('div', { class: 'banner info' }, h('span', { html: icon('info') }), h('span', {}, t('memoryOff')), h('span', { class: 'x' }, h('button', { class: 'btn small primary', onclick: () => { mm.close(); memorySetupDialog(key, { isNew: false }); } }, t('createMemory')))) : null,
      h('div', { class: 'banner ' + (p.willSend ? 'info' : '') }, h('span', { html: icon(p.willSend ? 'send' : 'check') }), h('span', {}, `${p.willSend ? t('willSendNext') : t('notResent')} · ${t('tokensApprox', { n: p.totalTokens })}`)),
      h('h3', {}, t('pins')),
      h('div', { class: 'list' }, ...(p.pins.length ? p.pins.map((pin, i) => h('div', { class: 'li' }, h('span', { html: icon('tag') }), h('div', { class: 'grow' }, pin), h('button', { class: 'btn small', onclick: async () => { await api('/api/conversation/options', { key, pins: p.pins.filter((_, j) => j !== i) }).catch(fail); draw(); } }, t('remove'))))
        : [h('div', { class: 'li help' }, '—')])),
      h('div', { class: 'inline' }, h('div', { class: 'field' }, pinInput), h('button', { class: 'btn', style: { marginBottom: '4px' }, onclick: addPin, html: icon('tag') + t('addPin') })),
      h('h3', {}, t('sharedContext')),
      h('div', { class: 'list' }, ...p.parts.filter((x) => x.file).map((x) => {
        const cb = h('input', { type: 'checkbox', checked: x.included, onchange: (e) => { if (e.target.checked) exclude.delete(x.file); else exclude.add(x.file); setExclude(); } });
        const diff = x.diff?.length ? h('details', {}, h('summary', { class: 'help', style: { cursor: 'pointer' } }, t('diff')), h('pre', { class: 'codeblock', html: x.diff.map((d) => `<span class="${d.op === '+' ? 'd-add' : d.op === '-' ? 'd-del' : ''}">${d.op === '=' ? ' ' : d.op} ${esc(d.line)}</span>`).join('\n') })) : null;
        return h('div', { class: 'li', style: { alignItems: 'flex-start' } }, h('label', { class: 'check', style: { margin: '2px 0' }, 'data-tip': t('include') }, cb),
          h('div', { class: 'grow' }, h('div', {}, x.label, ' ', tag(x.changed)), h('div', { class: 'sub' }, `${x.file} · ${x.chars} chars · ${t('tokensApprox', { n: x.tokens })}${x.truncated ? ' · truncated' : ''}`), diff),
          h('button', { class: 'btn small', onclick: () => openMemoryEditor(x.file, x.label).then(() => {}) }, t('edit')));
      })),
      p.found?.searched?.length ? h('details', {}, h('summary', { class: 'help', style: { cursor: 'pointer' } }, t('memSearched')), ...p.found.searched.map((d) => h('div', { class: 'mono help' }, d))) : null,
      p.warnings?.length ? h('div', { class: 'help' }, p.warnings.join('\n')) : null);
  };
  const mm = modal({ title: t('memoryWorkspace'), cls: 'mid', body, onClose: () => refreshMemoryInfo() });
  draw();
}

function renderMain() {
  const hidden = !!settings().sidebarHidden;
  $.body.classList.toggle('side-hidden', hidden);
  if (!S.conv && S.project) return renderProject(hidden);
  if (!S.conv) return renderWelcome(hidden);
  const r = S.conv.record;
  const showBtn = hidden ? ib('sidebarOpen', t('showFolders'), () => toggleSidebar(false)) : null;
  const titleEl = h('h1', { title: r.title, ondblclick: () => inlineRename(titleEl) }, r.title || t('untitled'));
  const loc = h('div', { class: 'loc' },
    h('button', { 'data-tip': t('revealFolder'), onclick: () => api('/api/reveal', { path: r.cwd }).catch(fail) }, r.cwd || '—'),
    r.rolloutName ? [' ', h('button', { 'data-tip': t('rollout'), onclick: () => r.rollout && api('/api/reveal', { path: r.rollout }).catch(fail) }, `(${r.rolloutName})`)] : null);
  $.status = h('div', { class: 'status-chip-wrap' });
  const mf = r.memoryFound?.files || [];
  const short = (f) => (f.current ? '' : f.folder.split(/[\\/]/).filter(Boolean).pop() + '/') + f.file.split(/[\\/]/).pop();
  const membar = h('div', { class: 'membar' }, h('span', { html: icon('book') }),
    mf.length ? [h('span', { class: 'help' }, t('memLoaded')), ...mf.map((f) => h('button', { class: 'chip small', title: f.file, onclick: () => openMemoryEditor(f.file, short(f)) }, short(f)))]
      : [h('span', { class: 'help' }, t('memNone')), h('button', { class: 'chip small', onclick: () => memorySetupDialog(S.conv.key, { isNew: false }) }, '+ ' + t('createFiles'))]);
  const head = h('div', { class: 'conv-head' }, showBtn,
    h('div', { class: 'conv-title' }, titleEl, loc, membar), $.status,
    ib('file', t('files'), () => toggleFiles(), { class: S.filesOpen ? 'active' : '' }),
    ib('search', t('searchAll'), () => openSearch()),
    ib('eye', t('memoryWorkspace'), () => openMemoryWorkspace()),
    ib('history', t('checkpoints'), () => openCheckpoints()),
    r.agent !== 'codex' ? h('span', { class: 'badge', html: icon('bot') + esc(S.sum.agents[r.agent]?.label || r.agent) }) : null,
    ib('edit', t('rename'), () => inlineRename(titleEl)),
    ib('more', '⋯', (e) => convMenu(e.currentTarget, { ...convByKey().get(S.conv.key), key: S.conv.key, title: r.title, cwd: r.cwd })));
  $.stream = h('div', { class: 'stream' });
  $.streamInner = h('div', { class: 'stream-inner' });
  $.stream.append($.streamInner);
  $.stream.addEventListener('click', onStreamClick);
  $.main.replaceChildren(head, $.stream, renderComposer());
  renderStream(true);
  renderStatus();
}

function currentPhase() {
  if (!S.conv) return null;
  if (S.conv.pending?.length) return 'approval';
  if (S.conv.running) return S.phase[S.conv.key] === 'queued' ? 'queued' : 'running';
  return S.phase[S.conv.key] || null;
}
function renderStatus() {
  if (!$.status || !S.conv) return;
  const ph = currentPhase();
  const ack = S.ack[S.conv.key], use = S.usage[S.conv.key];
  const cls = { queued: 'starting', running: 'running', approval: 'starting', completed: 'ready', failed: 'error', interrupted: '' }[ph] || '';
  const tip = ack ? `${t('ackLabel')}: ${ack.model || '?'}${ack.effort ? ' · ' + effortLabel(ack.effort) : ''}${ack.provider ? ' · ' + ack.provider : ''}` : '';
  $.status.replaceChildren(
    ph ? h('span', { class: `agent-pill status-${ph}`, 'data-tip': tip || t('status.' + ph) }, h('span', { class: `dot ${cls}` }), t('status.' + ph)) : null,
    ack ? h('span', { class: 'badge', 'data-tip': tip }, `${ack.model || ''}${ack.effort ? ' · ' + effortLabel(ack.effort) : ''}`) : null,
    use ? h('span', { class: 'badge', 'data-tip': t('tokens') }, `${fmtNum(use)} ${t('tokens')}`) : null);
}
const fmtNum = (u) => { const n = typeof u === 'number' ? u : u?.total?.totalTokens ?? u?.totalTokens ?? u?.total_tokens ?? u?.last?.totalTokens ?? null; return n == null ? '—' : n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n); };

/** Icon button showing the official tool icon when available (filled in asynchronously). */
function tib(tool, tip, onclick) {
  const b = ib(tool, tip, onclick);
  toolIcon(tool).then((html) => { b.innerHTML = html; });
  return b;
}

function inlineRename(titleEl) {
  const cur = S.conv.record.title;
  const inp = h('input', { value: cur });
  titleEl.replaceChildren(inp); inp.focus(); inp.select();
  let finished = false;
  const done = async (save) => {
    if (finished) return; finished = true;
    const v = inp.value.trim();
    if (save && v && v !== cur) { try { await api('/api/conversation/rename', { key: S.conv.key, title: v }); S.conv.record.title = v; await loadState(false); } catch (e) { fail(e); } }
    titleEl.textContent = S.conv.record.title || t('untitled');
    renderSidebar();
  };
  inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') done(true); if (e.key === 'Escape') done(false); });
  inp.addEventListener('blur', () => done(true));
}

// ------------------------------------------------------------------ project hub: everything about one folder in one place
async function openProject(folder) {
  S.conv = null; S.project = { folder, data: null, sub: '', preview: null };
  patchSettings({ activeConversation: null });
  renderSidebar(); renderMain();
  try { S.project.data = await api('/api/project' + q({ folder })); S.project.files = S.project.data.files; } catch (e) { S.project.error = e.message; }
  if (S.project?.folder === folder) renderMain();
}

function renderProject(hidden) {
  const P = S.project, d = P.data;
  const head = h('div', { class: 'conv-head' }, hidden ? ib('sidebarOpen', t('showFolders'), () => toggleSidebar(false)) : null,
    h('div', { class: 'conv-title' }, h('h1', {}, d?.name || P.folder.split(/[\\/]/).filter(Boolean).pop()), h('div', { class: 'loc' }, P.folder)),
    h('button', { class: 'btn primary', onclick: () => newConversation(P.folder), html: icon('chatPlus') + t('newChat') }),
    ib('folderOpen', t('openInExplorer'), () => api('/api/reveal', { path: P.folder }).catch(fail)));
  const body = h('div', { class: 'stream' }, h('div', { class: 'hub' }));
  const grid = body.firstChild;
  if (P.error) grid.append(h('div', { class: 'errorbox' }, P.error));
  else if (!d) grid.append(h('div', { class: 'help' }, '…'));
  else {
    const convCard = h('section', { class: 'card hub-convs' }, h('h3', { html: icon('chat') + esc(t('conversations')) + ` <span class="badge">${d.conversations.length}</span>` }),
      d.conversations.length ? h('div', { class: 'list' }, ...d.conversations.slice(0, 30).map((c) => h('button', { class: 'li hub-link', onclick: () => openConversation(c.key) },
        h('span', { html: icon(c.running ? 'spark' : 'chat') }), h('div', { class: 'grow' }, h('div', {}, c.title), h('div', { class: 'sub' }, `${S.sum.agents[c.agent]?.label || c.agent} · ${fmtTime(c.updatedAt)}`)))))
        : h('div', { class: 'quickstart' }, h('p', { class: 'help' }, t('emptyFolder')), h('div', { class: 'chips' }, ...allPrompts().slice(0, 4).map((p) => h('button', { class: 'chip', onclick: () => newConversation(P.folder, { prompt: p.text }) }, p.text)))));
    const memCard = h('section', { class: 'card' }, h('h3', { html: icon('book') + esc(t('sharedContext')) }),
      h('div', { class: 'inline' },
        h('button', { class: 'btn', onclick: () => openFolderMemory(P.folder, 'context'), html: icon('fileText') + t('folderContext') + (d.memory.context ? '' : ' +') }),
        h('button', { class: 'btn', onclick: () => openFolderMemory(P.folder, 'instructions'), html: icon('book') + t('folderInstructions') + (d.memory.instructions ? '' : ' +') })));
    const gitCard = d.git ? h('section', { class: 'card' }, h('h3', { html: icon('branch') + 'Git' }),
      h('div', { class: 'gp-branch' }, h('strong', {}, d.git.branch || '—'), d.git.upstream ? h('span', { class: 'badge' }, d.git.upstream) : null, d.git.ahead ? h('span', { class: 'badge' }, `↑${d.git.ahead}`) : null, d.git.behind ? h('span', { class: 'badge' }, `↓${d.git.behind}`) : null),
      h('p', { class: 'help' }, t('changesCount', { n: d.git.changes })), h('button', { class: 'btn small', onclick: () => openGit() }, t('gitPanel'))) : null;
    const skillCard = h('section', { class: 'card' }, h('h3', { html: icon('puzzle') + esc(t('skillsHere')) }),
      d.skills.length ? h('div', { class: 'chips' }, ...d.skills.map((n) => h('span', { class: 'chip static' }, n))) : h('p', { class: 'help' }, '—'),
      h('button', { class: 'btn small', onclick: () => openAddons('skills', P.folder), html: icon('plus') + t('addSkill') }));
    const filesCard = h('section', { class: 'card hub-files' }, h('h3', { html: icon('folder') + esc(t('files')) }), renderFiles());
    const readme = h('section', { class: 'card hub-readme' }, h('h3', { html: icon('fileText') + 'README' }), d.readme ? h('div', { class: 'msg-agent', html: renderMarkdown(d.readme) }) : h('p', { class: 'help' }, t('noReadme')));
    grid.append(convCard, specCard(P.folder, d), filesCard, memCard, skillCard, gitCard, readme);
  }
  $.main.replaceChildren(head, body);
}

// ------------------------------------------------------------------ Spec Kit card (spec → plan → tasks → implement)
function specCard(folder, d) {
  const sp = d.spec;
  const card = h('section', { class: 'card hub-spec' }, h('h3', { html: icon('list') + esc(t('specDriven')) }));
  if (!sp?.initialized) {
    const agentSel = select([['codex', 'Codex'], ['claude', 'Claude Code']], settings().defaultAgent === 'claude' ? 'claude' : 'codex', () => {});
    card.append(h('p', { class: 'help' }, t('specIntro')),
      d.specifyInstalled
        ? h('div', { class: 'toolbar' }, agentSel, h('button', { class: 'btn small primary', onclick: async () => { try { await api('/api/spec/init', { folder, agent: agentSel.value }); toast(t('specSettingUp')); } catch (e) { fail(e); } } }, t('specSetUp')))
        : h('button', { class: 'btn small', onclick: () => openAddons('workflows', folder) }, t('specInstall')));
    return card;
  }
  const run = (phase, feature) => async () => {
    const needs = { specify: t('specWhat'), constitution: t('specPrinciples'), clarify: null, plan: t('specTech'), tasks: null, analyze: null, checklist: t('specChecklistOn'), implement: null, converge: null }[phase];
    let args = '';
    if (needs) { args = await ask({ title: `Spec Kit — ${phase}`, label: needs, value: '' }); if (args == null) return; }
    const conv = S.conv?.record?.cwd === folder ? S.conv.key : (d.conversations[0]?.key || null);
    try {
      const r = await api('/api/spec/phase', conv ? { key: conv, phase, args } : { folder, phase, args });
      if (conv) { if (S.conv?.key !== conv) await openConversation(conv, { quiet: true }); promptToAI(r.text); }
      else newConversation(folder, { prompt: r.text });
    } catch (e) { fail(e); }
  };
  card.append(
    h('div', { class: 'help' }, `${t('specIntegration')}: ${sp.integration || '—'}${sp.constitution ? ` · ${t('specConstitution')}: ${sp.constitution.filled ? '✓' : t('specToWrite')}` : ''}`),
    h('div', { class: 'chips' }, ...['constitution', 'specify', 'clarify', 'plan', 'tasks', 'analyze', 'implement'].map((p) => h('button', { class: 'chip small', onclick: run(p) }, `${PHASE_ICON[p]} ${t('ph_' + p)}`))),
    sp.features.length ? h('div', { class: 'list' }, ...sp.features.slice().reverse().map((f) => h('div', { class: 'li' },
      h('div', { class: 'grow' }, h('div', {}, f.name, sp.current && sp.current.endsWith(f.name) ? h('span', { class: 'badge', style: { marginLeft: '6px' } }, t('current')) : null),
        h('div', { class: 'sub' }, ['spec', 'plan', 'tasks'].map((k) => `${f[k] ? '✓' : '·'} ${k}`).join('  ')),
        f.progress?.total ? h('div', { class: 'progress', title: `${f.progress.done}/${f.progress.total}` }, h('div', { style: { width: `${Math.round((100 * f.progress.done) / f.progress.total)}%` } })) : null),
      ...['spec', 'plan', 'tasks'].filter((k) => f[k]).map((k) => h('button', { class: 'btn small', onclick: () => openMemoryEditorOrPreview(f[k], `${f.name}/${k}.md`) }, k)),
      f.next !== 'done' ? h('button', { class: 'btn small primary', onclick: run(f.next) }, `${t('next')}: ${t('ph_' + f.next)}`) : h('span', { class: 'badge ok' }, '✓'))))
      : h('p', { class: 'help' }, t('specNoFeature')));
  return card;
}
const PHASE_ICON = { constitution: '§', specify: '①', clarify: '?', plan: '②', tasks: '③', analyze: '⚖', implement: '④' };
async function openMemoryEditorOrPreview(file, label) {
  try { const r = await api('/api/project/file' + q({ folder: S.project?.folder || S.selFolder, file })); modal({ title: label, cls: 'wide', body: h('div', { class: 'msg-agent', html: renderMarkdown(r.text || '') }) }); } catch (e) { fail(e); }
}

function renderFiles() {
  const P = S.project, f = P.files;
  const wrap = h('div');
  if (!f) return wrap;
  const go = async (sub) => { try { P.files = await api('/api/project/files' + q({ folder: P.folder, sub })); P.preview = null; renderMain(); } catch (e) { fail(e); } };
  const rel = f.rel || '';
  wrap.append(h('div', { class: 'files-path' }, rel ? h('button', { class: 'btn small', onclick: () => go(rel.split(/[\\/]/).slice(0, -1).join('/')), html: icon('chevron', 'rot180') + t('up') }) : null, h('code', {}, rel || '.')),
    h('div', { class: 'list files-list' }, ...f.entries.slice(0, 300).map((e) => h('button', { class: 'li hub-link', onclick: async () => {
      if (e.dir) return go(rel ? `${rel}/${e.name}` : e.name);
      try { P.preview = await api('/api/project/file' + q({ folder: P.folder, file: e.path })); renderMain(); } catch (err) { fail(err); }
    } }, h('span', { html: icon(e.dir ? 'folder' : 'file') }), h('div', { class: 'grow' }, e.name), h('span', { class: 'sub' }, e.dir ? '' : `${e.size < 1024 ? e.size + ' B' : Math.round(e.size / 1024) + ' KB'} · ${fmtTime(e.mtime)}`)))));
  if (P.preview) {
    const pv = P.preview;
    const ext = (pv.path.split('.').pop() || '').toLowerCase();
    wrap.append(h('div', { class: 'codeblock' }, h('div', { class: 'codebar' }, h('span', {}, pv.path.split(/[\\/]/).pop()),
      S.sum.tools.vscode.enabled ? h('button', { class: 'copy', onclick: () => api('/api/tools/vscode', { folder: P.folder, file: pv.path }).catch(fail) }, 'VS Code') : null),
      pv.text != null ? (ext === 'md' ? h('div', { class: 'msg-agent', style: { padding: '8px 12px' }, html: renderMarkdown(pv.text) }) : h('pre', { html: highlightCode(pv.text.slice(0, 200000), ext) }))
        : h('p', { class: 'help', style: { padding: '8px 12px' } }, pv.binary ? t('binaryFile') : t('tooLargeFile'))));
  }
  return wrap;
}

function renderWelcome(hidden) {
  const cx = S.sum.agents.codex;
  const recent = (S.sum.conversations || []).filter((c) => !c.archived).slice(0, 6);
  $.main.replaceChildren(h('div', { class: 'welcome' }, h('div', { class: 'card' },
    hidden ? h('div', { style: { textAlign: 'left' } }, ib('sidebarOpen', t('showFolders'), () => toggleSidebar(false))) : null,
    h('div', { class: 'mark', html: icon('logo') }),
    h('h1', {}, t('welcomeTitle')),
    h('p', {}, t('welcomeText')),
    cx.state === 'error' || cx.state === 'missing' ? h('div', { class: 'banner err' }, h('span', { html: icon('warn') }), h('span', {}, cx.error || t('setupCodex'))) : null,
    h('div', { class: 'actions' },
      h('button', { class: 'btn primary', onclick: () => newConversation(), html: icon('chatPlus') + t('newChat') }),
      h('button', { class: 'btn', onclick: openFolderFlow, html: icon('folderOpen') + t('openFolder') }),
      cx.state !== 'ready' ? h('button', { class: 'btn', onclick: reconnect, html: icon('refresh') + t('reconnect') }) : null),
    recent.length ? h('div', { class: 'recent' }, ...recent.map((c) => h('button', { onclick: () => openConversation(c.key), html: icon('chat') + `<span>${esc(c.title)}</span><small>${esc(c.cwd.split(/[\\/]/).filter(Boolean).slice(-2).join(' › '))} · ${fmtTime(c.updatedAt)}</small>` }))) : null,
    h('p', { class: 'help', style: { marginTop: '28px' } }, S.sum.brand.copyright))));
}

// ---------- stream rendering
function nearBottom() { const s = $.stream; return !s || s.scrollHeight - s.scrollTop - s.clientHeight < 140; }
function scrollBottom(force) { if ($.stream && (force || nearBottom())) $.stream.scrollTop = $.stream.scrollHeight; }

function renderStream(force) {
  if (!$.streamInner || !S.conv) return;
  const stick = force || nearBottom();
  $.streamInner.replaceChildren();
  if (S.conv.offset > 0) $.streamInner.append(h('button', { class: 'btn small', style: { alignSelf: 'center' }, onclick: loadEarlier, html: icon('history') + `${esc(t('showEarlier'))} (${S.conv.offset})` }));
  for (const it of S.conv.items) { const el = itemEl(it); if (el) $.streamInner.append(el); }
  for (const p of S.conv.pending || []) $.streamInner.append(approvalEl(p));
  if (!S.conv.items.length && !S.conv.running) $.streamInner.append(h('div', { class: 'quickstart' }, h('div', { class: 'help' }, t('quickStart')),
    h('div', { class: 'chips' }, ...allPrompts().slice(0, 6).map((p) => h('button', { class: 'chip', onclick: () => usePrompt(p.text) }, p.text)))));
  if (S.conv.running) $.streamInner.append(h('div', { class: 'thinking', id: 'thinking', html: '<span class="dots"><span></span><span></span><span></span></span>' + esc(t('running')) }));
  if (stick) requestAnimationFrame(() => scrollBottom(true));
}

async function loadEarlier() {
  try {
    const before = S.conv.offset;
    const r = await api('/api/conversation/older' + q({ key: S.conv.key, before, limit: 120 }));
    const h0 = $.stream.scrollHeight;
    S.conv.items = [...r.items, ...S.conv.items]; S.conv.offset = r.offset;
    for (const i of r.items) S.itemIdx.set(i.id, i);
    renderStream(false);
    $.stream.scrollTop = $.stream.scrollHeight - h0;
  } catch (e) { fail(e); }
}

function itemEl(it) {
  let el;
  switch (it.kind) {
    case 'user':
      el = h('div', { class: 'msg-user' }, it.text);
      if (it.context) el.append(h('details', { class: 'ctx-chip ctx' }, h('summary', { html: icon('book') + esc(t('sharedContext')) }), h('pre', {}, it.context)));
      break;
    case 'agent': el = h('div', { class: 'msg-agent', html: renderMarkdown(it.text) }); break;
    case 'plan': el = h('div', { class: 'msg-agent', html: '<p><strong>Plan</strong></p>' + renderMarkdown(it.text) }); break;
    case 'reasoning': return null; // private reasoning stays hidden, like the CLI
    case 'command': {
      const running = it.status === 'inProgress';
      const code = it.exitCode;
      const badge = running ? '<span class="exit run">…</span>' : code == null ? (it.status === 'declined' ? `<span class="exit bad">${esc(t('decline'))}</span>` : '') : `<span class="exit ${code === 0 ? 'ok' : 'bad'}">${t('exit')} ${code}</span>`;
      el = h('details', { class: 'work', open: running || (code != null && code !== 0) ? true : null },
        h('summary', { html: icon('terminal') + `<span class="cmd">${esc(it.command)}</span>${badge}${it.durationMs ? `<span class="badge">${(it.durationMs / 1000).toFixed(1)} s</span>` : ''}` }),
        h('pre', { class: 'term', html: `<span class="p">$ ${esc(it.command)}</span>\n${esc(it.output || '')}` }));
      break;
    }
    case 'fileChange':
      el = h('details', { class: 'work', open: true },
        h('summary', { html: icon('file') + `<span class="cmd">${esc(t('filesChanged'))} · ${it.changes.length}</span>${it.status === 'declined' ? `<span class="exit bad">${esc(t('decline'))}</span>` : it.status === 'failed' ? '<span class="exit bad">failed</span>' : ''}` }),
        ...it.changes.map((c) => h('div', { class: 'filechg' },
          h('div', { class: 'fname', html: `<span class="kindtag ${esc(c.kind)}">${esc(c.kind)}</span><span>${esc(c.path)}${c.movePath ? ' → ' + esc(c.movePath) : ''}</span>` }),
          c.diff ? h('pre', { html: diffHtml(c.diff) }) : null)));
      break;
    case 'tool':
      el = h('details', { class: 'work' },
        h('summary', { html: icon(it.server === 'web' ? 'globe' : 'tool') + `<span class="cmd">${esc(it.server)} · ${esc(it.tool)}</span>${it.failed ? '<span class="exit bad">error</span>' : it.status === 'inProgress' ? '<span class="exit run">…</span>' : ''}` }),
        it.args ? h('pre', { html: highlightCode(JSON.stringify(it.args, null, 2), 'json') }) : null,
        it.output ? h('pre', { class: 'term' }, it.output.slice(0, 20000)) : null);
      break;
    case 'error': el = h('div', { class: 'errorbox' }, it.text); break;
    case 'notice': el = h('div', { class: 'notice' }, it.text); break;
    default: return null;
  }
  el.dataset.id = it.id;
  return el;
}

function approvalEl(p) {
  const titles = { command: 'approvalCommand', fileChange: 'approvalFile', permissions: 'approvalPerm', question: 'approvalQuestion', elicitation: 'approvalQuestion' };
  const send = (decision, answers) => api('/api/conversation/approve', { key: S.conv.key, requestKey: p.requestKey, decision, answers }).then(() => { S.conv.pending = S.conv.pending.filter((x) => x.requestKey !== p.requestKey); renderStream(); }).catch(fail);
  const box = h('div', { class: 'approval', 'data-req': p.requestKey },
    h('h4', { html: icon('shield') + esc(t(titles[p.kind] || 'approvalCommand')) }),
    p.command ? h('code', {}, Array.isArray(p.command) ? p.command.join(' ') : p.command) : null,
    p.cwd ? h('div', { class: 'help' }, p.cwd) : null,
    p.reason ? h('div', {}, p.reason) : null,
    p.message ? h('div', {}, p.message) : null,
    p.permissions ? h('pre', {}, JSON.stringify(p.permissions, null, 2)) : null);
  if (p.kind === 'question' && Array.isArray(p.questions)) {
    const inputs = {};
    for (const qn of p.questions) {
      const inp = qn.options?.length ? h('select', { class: 'input' }, ...qn.options.map((o) => h('option', { value: o.label ?? o.value ?? o }, o.label ?? o.value ?? o))) : h('input', { class: 'input', type: qn.isSecret ? 'password' : 'text' });
      inputs[qn.id] = inp;
      box.append(h('label', { class: 'field' }, h('span', {}, qn.header ? `${qn.header} — ${qn.question}` : qn.question), inp));
    }
    box.append(h('div', { class: 'actions' }, h('button', { class: 'btn primary small', onclick: () => send('accept', Object.fromEntries(Object.entries(inputs).map(([k, v]) => [k, v.value]))) }, t('answer')), h('button', { class: 'btn small', onclick: () => send('cancel') }, t('cancel'))));
  } else {
    box.append(h('div', { class: 'actions' },
      h('button', { class: 'btn primary small', onclick: () => send('accept') }, t('allow')),
      p.kind !== 'elicitation' ? h('button', { class: 'btn small', onclick: () => send('acceptForSession') }, t('allowSession')) : null,
      h('button', { class: 'btn small', onclick: () => send('decline') }, t('decline')),
      h('button', { class: 'btn small danger', onclick: () => send('cancel') }, t('cancelTurn'))));
  }
  return box;
}

function onStreamClick(e) {
  const b = e.target.closest('[data-copy]');
  if (b) { const code = b.closest('.codeblock')?.querySelector('code'); if (code) copyText(code.textContent); }
}

/** Incremental update for streamed items (only the affected element is redrawn). */
function upsertItem(it) {
  if (!S.conv) return;
  const prev = S.itemIdx.get(it.id);
  if (prev) Object.assign(prev, it); else { S.conv.items.push(it); S.itemIdx.set(it.id, it); }
  const cur = S.itemIdx.get(it.id);
  const old = $.streamInner?.querySelector(`[data-id="${CSS.escape(it.id)}"]`);
  const el = itemEl(cur);
  const stick = nearBottom();
  if (old && el) { if (old.tagName === 'DETAILS' && el.tagName === 'DETAILS' && !old.open && cur.status !== 'inProgress') el.open = false; old.replaceWith(el); }
  else if (el && $.streamInner) { const anchor = $.streamInner.querySelector('.approval, #thinking'); $.streamInner.insertBefore(el, anchor); }
  if (stick) scrollBottom(true);
}
const deltaQueue = new Map(); let deltaRaf = 0;
function applyDelta(itemId, field, delta) {
  const it = S.itemIdx.get(itemId);
  if (!it) { const n = { id: itemId, kind: field === 'output' ? 'command' : 'agent', text: '', output: '', status: 'inProgress', command: '' }; n[field] = delta; S.conv.items.push(n); S.itemIdx.set(itemId, n); }
  else it[field] = (it[field] || '') + delta;
  deltaQueue.set(itemId, true);
  if (!deltaRaf) deltaRaf = requestAnimationFrame(() => { deltaRaf = 0; for (const id of deltaQueue.keys()) upsertItem(S.itemIdx.get(id)); deltaQueue.clear(); });
}

// ---------- composer
function renderComposer() {
  const r = S.conv.record;
  const draftKey = 'draft.' + S.conv.key;
  const ta = h('textarea', { rows: 2, placeholder: t('placeholder'), spellcheck: 'true' });
  ta.value = S.conv.draft || store.get(draftKey, '');
  const autosize = () => { ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight, 260) + 'px'; };
  ta.addEventListener('input', () => { S.conv.draft = ta.value; saveDraft(S.conv.key, ta.value); autosize(); });
  ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); } });
  $.input = ta; setTimeout(autosize, 0);

  const models = modelsFor(r.agent);
  const mark = (m) => (m.source === 'custom' ? ` · ${m.provider || 'TOML'}` : m.source === 'history' ? ` · ${t('usedBefore')}` : m.source === 'typed' ? ` · ${t('typedByYou')}` : '');
  const modelSel = h('select', { class: 'sel', 'data-tip': `${t('model')} — ${t('modelsFromAccount')}`, 'data-tip-pos': 'up', onchange: async (e) => {
    if (e.target.value === '__refresh') {
      e.target.disabled = true;
      try { const r = await api('/api/models/refresh', { agent: S.conv.record.agent }); S.sum.models = r.models; const res = r.results[S.conv.record.agent]; toast(res?.ok ? t('modelsFound', { n: res.count }) : res?.error || '—', !res?.ok); } catch (err) { fail(err); }
      renderMain(); return;
    }
    const m = models.find((x) => x.key === e.target.value); S.compose.modelKey = m.key; S.compose.effort = chooseEffort(m, S.compose.effort); patchSettings({ lastModelKey: m.key }); refreshEffort();
  } },
    ...models.map((m) => h('option', { value: m.key, selected: m.key === S.compose.modelKey }, (m.isDefault ? '★ ' : '') + m.label + mark(m))),
    h('option', { value: '__refresh' }, `↻ ${t('detectModels')}`));
  const effortSel = h('select', { class: 'sel', 'data-tip': t('effort'), 'data-tip-pos': 'up', onchange: (e) => { S.compose.effort = e.target.value; const m = models.find((x) => x.key === S.compose.modelKey); if (m) patchSettings({ modelEfforts: { ...(settings().modelEfforts || {}), [m.key]: e.target.value } }); } });
  const refreshEffort = () => {
    const m = models.find((x) => x.key === S.compose.modelKey);
    const list = m?.efforts?.length ? m.efforts : [];
    effortSel.replaceChildren(...list.map((e) => h('option', { value: e, selected: e === S.compose.effort }, effortLabel(e))));
    effortSel.classList.toggle('hidden', !list.length);
  };
  refreshEffort();
  const modes = S.sum.actionModes || ['default', 'ask', 'project', 'readonly', 'full'];
  const modeSel = h('select', { class: 'sel', 'data-tip': t(`modeHelp.${S.compose.mode}`), 'data-tip-pos': 'up', onchange: (e) => { S.compose.mode = e.target.value; modeSel.dataset.tip = t(`modeHelp.${e.target.value}`); api('/api/conversation/options', { key: S.conv.key, actionMode: e.target.value }).catch(fail); } },
    ...modes.map((m) => h('option', { value: m, selected: m === S.compose.mode }, `${m === 'full' ? '⚠ ' : ''}${t('mode.' + m)}`)));
  const cap = S.sum.capabilities?.[r.agent] || {};
  if (!cap.files) modeSel.classList.add('hidden');
  const mem = S.conv.memory || {};
  const memBtn = (iconName, tip, file, folderKind) => ib(iconName, tip, () => file ? openMemoryEditor(file, tip) : folderKind ? openFolderMemory(r.cwd, folderKind) : toast('—'), { attrs: { 'data-tip-pos': 'up' }, class: 'pro-only' });
  // ---- attachments: button, drag & drop, paste
  S.attach ||= {};
  const list = (S.attach[S.conv.key] ||= []);
  const chips = h('div', { class: 'attach-chips' });
  const drawChips = () => chips.replaceChildren(...list.map((a, i) => h('span', { class: 'attach-chip' }, h('span', { html: icon(a.kind === 'image' ? 'eye' : 'file') }), a.uploading ? `${a.name} — ${t('uploading')}` : a.name,
    h('button', { 'data-tip': t('removeAttachment'), html: icon('close'), onclick: () => { list.splice(i, 1); drawChips(); } }))));
  const addFiles = async (files) => {
    for (const f of [...files].slice(0, 10)) {
      const entry = { name: f.name, kind: f.type.startsWith('image/') ? 'image' : 'text', uploading: true }; list.push(entry); drawChips();
      try {
        const data = await new Promise((res, rej) => { const rd = new FileReader(); rd.onload = () => res(String(rd.result).split(',')[1] || ''); rd.onerror = rej; rd.readAsDataURL(f); });
        Object.assign(entry, await api('/api/attachments', { key: S.conv.key, name: f.name || 'pasted.png', data }), { uploading: false });
      } catch (e) { list.splice(list.indexOf(entry), 1); fail(e); }
      drawChips();
    }
  };
  const fileInput = h('input', { type: 'file', multiple: true, style: { display: 'none' }, onchange: (e) => { addFiles(e.target.files); e.target.value = ''; } });
  ta.addEventListener('paste', (e) => { const fl = [...(e.clipboardData?.files || [])]; if (fl.length) { e.preventDefault(); addFiles(fl); } });
  drawChips();
  const linkCount = (mem.links || []).length;
  $.sendBtn = h('button', { class: `sendbtn ${S.conv.running ? 'stop' : ''}`, 'data-tip': S.conv.running ? t('stop') : t('send'), 'data-tip-pos': 'up', html: icon(S.conv.running ? 'stop' : 'send'), onclick: () => (S.conv.running ? stopTurn() : send()) });

  const gitOn = S.sum.tools.git.enabled;
  const g = (name, tip, fn) => ib(name, tip, fn, { attrs: { 'data-tip-pos': 'up' } });
  const gitbar = gitOn ? h('div', { class: 'gitbar' },
    h('span', { class: 'lbl', html: icon('branch') + esc(S.git.st?.branch || 'Git') }),
    g('commit', t('commit'), () => { openGit(); setTimeout(() => document.getElementById('gp-msg')?.focus(), 200); }),
    g('fetch', t('fetch'), () => gitOp('fetch')),
    g('pull', t('pull'), () => gitOp('pull')),
    g('push', t('push'), () => gitOp('push')),
    g('pr', t('pr'), () => gitPR()),
    g('branch', t('newBranch'), () => gitBranchCreate()),
    g('merge', t('merge'), () => gitPickBranch('merge')),
    g('rebase', t('rebase'), () => gitPickBranch('rebase')),
    g('stash', t('stash'), () => gitOp('stash')),
    g('history', t('log'), () => gitLog()),
    g('more', t('gitPanel'), () => toggleGit())) : null;

  const banner = composerBanner();
  const box = h('div', { class: 'inputbox' }, chips, ta,
      h('div', { class: 'controls' },
        ib('paperclip', t('attach'), () => fileInput.click(), { attrs: { 'data-tip-pos': 'up' } }), fileInput,
        modelSel, effortSel, modeSel,
        ib('spark', t('prompts'), (e) => promptMenu(e.currentTarget), { attrs: { 'data-tip-pos': 'up' } }),
        h('span', { class: 'sep pro-only' }),
        memBtn('fileText', t('folderContext'), mem.folder?.context, 'context'),
        memBtn('book', t('folderInstructions'), mem.folder?.instructions, 'instructions'),
        memBtn('chat', t('convContext'), mem.conversation?.context),
        memBtn('list', t('convInstructions'), mem.conversation?.instructions),
        ib('link', `${t('linkContexts')}${linkCount ? ` (${linkCount})` : ''}`, openLinkDialog, { class: `pro-only ${linkCount ? 'active' : ''}`, attrs: { 'data-tip-pos': 'up' } }),
        h('span', { class: 'grow' }),
        $.sendBtn));
  box.addEventListener('dragover', (e) => { if (e.dataTransfer?.types?.includes('Files')) { e.preventDefault(); box.classList.add('drop'); } });
  box.addEventListener('dragleave', () => box.classList.remove('drop'));
  box.addEventListener('drop', (e) => { if (e.dataTransfer?.files?.length) { e.preventDefault(); box.classList.remove('drop'); addFiles(e.dataTransfer.files); } });
  return h('div', { class: 'composer' }, h('div', { class: 'composer-inner' }, banner, box, gitbar ? h('div', { class: 'pro-only' }, gitbar) : null));
}

// ------------------------------------------------------------------ prompts (quick start)
function allPrompts() {
  const builtIn = ['p_explain', 'p_review', 'p_tests', 'p_plan', 'p_summarize', 'p_doc'].map((k) => ({ text: t(k), builtIn: true }));
  return [...(settings().prompts || []).map((text) => ({ text })), ...builtIn];
}
function usePrompt(text) { if (!$.input) return; $.input.value = $.input.value ? `${$.input.value}\n${text}` : text; $.input.dispatchEvent(new Event('input')); $.input.focus(); }
function promptMenu(anchor) {
  showMenu(anchor, [...allPrompts().map((p) => ({ label: p.text.length > 70 ? p.text.slice(0, 68) + '…' : p.text, icon: p.builtIn ? 'spark' : 'tag', run: () => usePrompt(p.text) })), '-',
    { label: t('promptAdd'), icon: 'plus', run: async () => { const v = await ask({ title: t('promptAdd'), label: t('promptText') }); if (v) patchSettings({ prompts: [v, ...(settings().prompts || [])].slice(0, 100) }, true); } }]);
}

/**
 * One banner, chosen by cause (rec. 1): browser disconnected from the app → agent process down → last send error.
 * Every case keeps the draft and offers the matching recovery action.
 */
function composerBanner() {
  const cx = S.sum.agents[S.conv?.record?.agent || 'codex'];
  let b = null;
  if (S.conn === 'lost') b = { kind: 'err', text: t('connLost'), actions: [{ label: t('retryNow'), run: () => { connectEvents(); loadState(false); } }] };
  else if (cx && !['ready', 'idle'].includes(cx.state)) b = { kind: 'warn', text: `${t('agentStopped')}${cx.error ? '\n' + cx.error : ''}`, actions: [{ label: t('reconnect'), run: reconnect }] };
  else if (S.banner) b = S.banner;
  if (!b) return null;
  return h('div', { class: `banner ${b.kind}` }, h('span', { html: icon(b.kind === 'info' ? 'info' : 'warn') }), h('span', { style: { whiteSpace: 'pre-wrap' } }, b.text),
    h('span', { class: 'x', style: { display: 'flex', gap: '6px', alignItems: 'center', flexWrap: 'wrap' } }, b.extra || null, ...(b.actions || []).map((a, i) => h('button', { class: `btn small${b.extra && i === 0 ? ' primary' : ''}`, onclick: a.run }, a.label)),
      b === S.banner ? ib('close', t('close'), () => { S.banner = null; renderMain(); }) : null));
}

let draftTimer;
function saveDraft(key, text) {
  store.set('draft.' + key, text);
  clearTimeout(draftTimer);
  draftTimer = setTimeout(() => api('/api/drafts', { key, text }).catch(() => {}), 500);
}

async function send() {
  if (!S.conv || S.sending) return;
  const text = $.input.value.trim();
  if (!text) return;
  S.sending = true; $.sendBtn.disabled = true;
  const key = S.conv.key;
  const doneBefore = S.turnsDone[key] || 0;
  S.phase[key] = 'queued'; renderStatus();
  try {
    const attachments = (S.attach?.[key] || []).filter((a) => !a.uploading && a.path).map(({ path, kind }) => ({ path, kind }));
    const r = await api('/api/conversation/send', { key, text, modelKey: S.compose.modelKey, effort: S.compose.effort, actionMode: S.compose.mode, attachments });
    if (S.attach) S.attach[key] = [];
    clearTimeout(draftTimer); store.set('draft.' + key, ''); S.conv.draft = ''; $.input.value = ''; $.input.style.height = 'auto';
    // A fast turn can complete before this response arrives: only mark running if it has not finished yet.
    const finished = (S.turnsDone[key] || 0) > doneBefore;
    if (!finished) { S.conv.running = true; if (S.phase[key] === 'queued') S.phase[key] = 'running'; }
    S.banner = r.warnings?.length ? { kind: 'warn', text: `${t('memoryWarn')}\n${r.warnings.join('\n')}` } : r.askMemoryUpdate ? memoryUpdateBanner(key, r.promptsSinceMemoryAsk) : null;
    renderMain();
  } catch (e) {
    // The draft is kept in every failure case; the banner offers the matching recovery.
    delete S.phase[key];
    S.banner = e.code === 'WRITER_LOCK' ? { kind: 'err', text: t('writerLock'), actions: [{ label: t('retrySend'), run: () => { S.banner = null; send(); } }] }
      : e.code === 'NETWORK' ? { kind: 'err', text: t('connLost'), actions: [{ label: t('retrySend'), run: () => { S.banner = null; send(); } }] }
      : { kind: 'err', text: e.message };
    renderMain();
  } finally { S.sending = false; if ($.sendBtn) $.sendBtn.disabled = false; }
}
/** Every 5–10 prompts: update the context/instructions files automatically (by the AI) or manually (editor)? */
function memoryUpdateBanner(key, n) {
  const remember = h('input', { type: 'checkbox' });
  const answer = async (choice) => {
    S.banner = null; renderMain();
    try {
      const r = await api('/api/memory/update', { key, choice, remember: remember.checked });
      if (remember.checked) { const st = settings(); st.memoryUpdateMode = choice === 'later' ? 'ask' : choice; }
      if (choice === 'auto') toast(r.queued ? t('memUpdQueued') : t('memUpdating'));
      if (choice === 'manual') openMemoryWorkspace();
    } catch (e) { fail(e); }
  };
  return { kind: 'info', text: t('memUpdAsk', { n }), extra: h('label', { class: 'check', style: { margin: 0 } }, remember, h('span', {}, t('rememberChoice'))),
    actions: [{ label: t('memUpdAuto'), run: () => answer('auto') }, { label: t('memUpdManual'), run: () => answer('manual') }, { label: t('later'), run: () => answer('later') }] };
}
/** Desktop notification when the window is in the background (opt-in, Configuration › General). */
function notifyDesktop(key, text) {
  if (!document.hidden || settings().notify === false || typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
  try {
    const n = new Notification(convByKey().get(key)?.title || S.sum.brand.name, { body: text, tag: key, silent: false });
    n.onclick = () => { window.focus(); if (key && S.conv?.key !== key) openConversation(key); n.close(); };
  } catch { /* unsupported */ }
}

/** Checkpoints: files as they were before each message; preview what changed, restore. */
async function openCheckpoints() {
  if (!S.conv) return;
  const key = S.conv.key;
  const body = h('div', {}, h('p', { class: 'help' }, '…'));
  const draw = async () => {
    let r; try { r = await api('/api/checkpoints' + q({ key })); } catch (e) { body.replaceChildren(h('div', { class: 'errorbox' }, e.message)); return; }
    if (!r.checkpoints.length) { body.replaceChildren(h('p', { class: 'help' }, r.enabled ? t('cpNone') : t('cpOff'))); return; }
    body.replaceChildren(h('p', { class: 'help' }, t('cpIntro')), h('div', { class: 'list' }, ...r.checkpoints.map((c) => {
      const detail = h('div', { class: 'sub' });
      return h('div', { class: 'li', style: { alignItems: 'flex-start' } }, h('span', { html: icon(c.safety ? 'shield' : 'history') }),
        h('div', { class: 'grow' }, h('div', {}, c.safety ? c.label : `${t('cpBefore')} “${c.label}”`), h('div', { class: 'sub' }, fmtTime(c.at)), detail),
        h('button', { class: 'btn small', onclick: async () => {
          detail.textContent = '…';
          try { const p = await api('/api/checkpoints/preview', { key, id: c.id }); detail.textContent = !p.changed.length && !p.deleted.length && !p.created.length ? t('cpSame') : [p.changed.length ? `${t('cpChanged')}: ${p.changed.join(', ')}` : '', p.deleted.length ? `${t('cpDeleted')}: ${p.deleted.join(', ')}` : '', p.created.length ? `${t('cpCreated')}: ${p.created.join(', ')}` : ''].filter(Boolean).join('\n'); detail.style.whiteSpace = 'pre-wrap'; }
          catch (e) { detail.textContent = e.message; }
        } }, t('preview')),
        h('button', { class: 'btn small primary', onclick: async () => {
          let p; try { p = await api('/api/checkpoints/preview', { key, id: c.id }); } catch (e) { fail(e); return; }
          const rm = h('input', { type: 'checkbox' });
          const ok = await new Promise((resolve) => { let done = false; const m = modal({ title: t('cpRestore'), body: h('div', {}, h('p', {}, t('cpRestoreQ', { n: p.changed.length + p.deleted.length })), p.created.length ? h('label', { class: 'check' }, rm, h('span', {}, t('cpRemoveCreated', { files: p.created.join(', ') }))) : null, h('p', { class: 'help' }, t('cpSafety'))), foot: [h('button', { class: 'btn', onclick: () => m.close() }, t('cancel')), h('button', { class: 'btn primary', onclick: () => { done = true; m.close(); resolve(true); } }, t('cpRestore'))], onClose: () => { if (!done) resolve(false); } }); });
          if (!ok) return;
          try { const res = await api('/api/checkpoints/restore', { key, id: c.id, removeCreated: rm.checked }); toast(t('cpRestored', { n: res.restored.length + res.removed.length })); draw(); if (S.filesOpen) loadFiles(); if (settings().gitPanelOpen) loadGit(); } catch (e) { fail(e); }
        } }, t('cpRestore')));
    })));
  };
  modal({ title: t('checkpoints'), cls: 'mid', body });
  draw();
}

async function stopTurn() { try { await api('/api/conversation/stop', { key: S.conv.key }); } catch (e) { fail(e); } }

// ------------------------------------------------------------------ memory files
async function openFolderMemory(folder, kind) {
  try { const r = await api('/api/memory/folder', { folder }); openMemoryEditor(r[kind], `${t(kind === 'context' ? 'folderContext' : 'folderInstructions')} — ${folder.split(/[\\/]/).filter(Boolean).pop()}`); }
  catch (e) { fail(e); }
}
async function openMemoryEditor(file, title) {
  let cur;
  try { cur = await api('/api/memory' + q({ file })); } catch (e) { fail(e); return; }
  const ta = h('textarea', { class: 'editor', spellcheck: 'false' }); ta.value = cur.content;
  const status = h('span', { class: 'help', style: { marginRight: 'auto', alignSelf: 'center' } }, file);
  const save = async () => {
    try { cur = await api('/api/memory', { file, content: ta.value, version: cur.version }); toast(t('saved')); m.close(); if (S.conv) refreshMemoryInfo(); }
    catch (e) { if (e.status === 409) { status.textContent = t('conflict'); status.style.color = 'var(--danger)'; } else fail(e); }
  };
  const reload = async () => { cur = await api('/api/memory' + q({ file })); ta.value = cur.content; status.textContent = file; status.style.color = ''; };
  const m = modal({ title, cls: 'wide', body: ta, foot: [status, h('button', { class: 'btn', onclick: reload, html: icon('refresh') + t('reload') }), h('button', { class: 'btn', onclick: () => m.close() }, t('cancel')), h('button', { class: 'btn primary', onclick: save }, t('save'))] });
  ta.addEventListener('keydown', (e) => { if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); save(); } });
}
function fmtSize(n) { n = +n || 0; return n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB` : `${(n / 1048576).toFixed(1)} MB`; }
async function refreshMemoryInfo() { try { const d = await api('/api/conversation' + q({ key: S.conv.key })); S.conv.memory = d.memory; S.conv.record = d.record; } catch { /* */ } }

async function openLinkDialog() {
  let cat;
  try { cat = await api('/api/memory/catalog'); } catch (e) { fail(e); return; }
  const own = new Set([S.conv.memory?.conversation?.context, S.conv.memory?.conversation?.instructions, S.conv.memory?.folder?.context, S.conv.memory?.folder?.instructions].filter(Boolean));
  const linked = new Set((S.conv.memory?.links || []).map((l) => l.file));
  const boxes = [];
  const list = h('div', { class: 'list' }, ...cat.filter((c) => !own.has(c.file)).map((c) => {
    const cb = h('input', { type: 'checkbox', checked: linked.has(c.file) }); boxes.push([cb, c]);
    return h('label', { class: 'li check', style: { margin: 0 } }, cb, h('div', { class: 'grow' }, h('div', {}, c.label), h('div', { class: 'sub' }, c.folder)), h('span', { class: 'badge', html: icon(c.group === 'folder' ? 'folder' : 'chat') }));
  }));
  const m = modal({ title: t('linkContexts'), cls: 'mid', body: h('div', {}, h('p', { class: 'help' }, t('linkHelp')), cat.length ? list : h('p', {}, '—')),
    foot: [h('button', { class: 'btn', onclick: () => m.close() }, t('cancel')), h('button', { class: 'btn primary', onclick: async () => {
      const links = boxes.filter(([cb]) => cb.checked).map(([, c]) => ({ label: c.label, file: c.file }));
      try { await api('/api/conversation/options', { key: S.conv.key, links }); await refreshMemoryInfo(); m.close(); renderMain(); } catch (e) { fail(e); }
    } }, t('apply'))] });
}

// ------------------------------------------------------------------ git
function gitTarget() { return S.conv ? { key: S.conv.key } : S.selFolder ? { folder: S.selFolder } : null; }
function toggleGit() { if (settings().gitPanelOpen) { patchSettings({ gitPanelOpen: false }); $.gitp.classList.add('hidden'); } else openGit(); }
function openGit() { if (S.filesOpen) { S.filesOpen = false; $.filesp.classList.add('hidden'); } patchSettings({ gitPanelOpen: true }); $.gitp.classList.remove('hidden'); loadGit(); }
async function loadGit() {
  const tgt = gitTarget();
  if (!tgt) { renderGit(); return; }
  try { S.git.st = await api('/api/git/status', tgt); } catch (e) { S.git.st = { repo: false, error: e.message }; }
  renderGit();
}
async function gitOp(op, args = {}) {
  const tgt = gitTarget(); if (!tgt) return;
  S.git.busy = true; renderGit();
  try {
    const r = await api('/api/git/op', { ...tgt, op, args });
    S.git.out = `$ git ${op}\n${r.output || (r.ok ? 'OK' : '')}${r.hint ? '\n\n' + r.hint : ''}`;
    if (!r.ok) toast(r.hint || r.output.split('\n').slice(-2).join('\n') || 'git failed', true); else toast(`git ${op} ✓`);
  } catch (e) { S.git.out = e.message; fail(e); }
  S.git.busy = false;
  await loadGit();
  if (S.conv) { const gb = document.querySelector('.gitbar .lbl'); if (gb && S.git.st?.branch) gb.innerHTML = icon('branch') + esc(S.git.st.branch); }
}
/** Bitbucket Cloud remote + connected account → create the pull request through the API; otherwise open the website. */
async function gitPRSmart(st) {
  const isBB = (st?.remotes || []).some((r) => /bitbucket\.org[:/]/.test(r.url || ''));
  const info = isBB ? (S.connInfo || await loadConnections()) : null;
  if (isBB && info?.bitbucket?.connected) { const tg = gitTarget(); if (tg) return prFromFolder(tg.folder || S.conv?.record?.cwd || S.selFolder); }
  return gitPR();
}
async function gitPR() {
  const tgt = gitTarget(); if (!tgt) return;
  const target = await ask({ title: t('pr'), label: 'Target branch', value: S.sum.tools.bitbucket.defaultBranch || 'main' });
  if (target == null) return;
  try { const r = await api('/api/git/pr', { ...tgt, target }); S.git.out = r.url; toast(r.url); } catch (e) { fail(e); }
}
async function gitBranchCreate() { const v = await ask({ title: t('newBranch'), label: t('name'), value: 'feature/' }); if (v) gitOp('branch-create', { branch: v }); }
async function gitPickBranch(op) {
  const tgt = gitTarget(); if (!tgt) return;
  if (!S.git.st) await loadGit();
  const branches = (S.git.st?.branches || []).filter((b) => !b.current);
  if (!branches.length) { const v = await ask({ title: t(op), label: t('branch') }); if (v) gitOp(op, { branch: v }); return; }
  showMenu(document.querySelector('.gitbar') || $.top, branches.map((b) => ({ label: `${t(op === 'switch' ? 'switchBranch' : op)} ← ${b.name}`, icon: b.remote ? 'globe' : 'branch', run: () => gitOp(op, { branch: b.name }) })));
}
async function gitLog() {
  const tgt = gitTarget(); if (!tgt) return;
  try {
    const r = await api('/api/git/log', { ...tgt, n: 50 });
    modal({ title: t('log'), cls: 'mid', body: h('div', { class: 'list' }, ...r.log.map((c) => h('div', { class: 'li' }, h('code', {}, c.hash), h('div', { class: 'grow' }, h('div', {}, c.subject), h('div', { class: 'sub' }, `${c.author} · ${c.date}${c.refs ? ' · ' + c.refs : ''}`)), h('button', { class: 'btn small', onclick: async () => { if (await confirmBox({ title: 'Revert', text: `${c.hash} ${c.subject}` })) gitOp('revert', { commit: c.hash }); } }, 'Revert')))) });
  } catch (e) { fail(e); }
}

function renderGit() {
  const open = !!settings().gitPanelOpen;
  $.gitp.classList.toggle('hidden', !open);
  if (!open) return;
  const st = S.git.st;
  const head = h('div', { class: 'gp-head' }, h('h3', { html: icon('branch') + esc(t('gitPanel')) }), ib('refresh', t('refresh'), loadGit), ib('close', t('close'), toggleGit));
  const body = h('div', { class: 'gp-body' });
  if (!gitTarget()) body.append(h('p', { class: 'help' }, t('welcomeText')));
  else if (!st) body.append(h('p', { class: 'help' }, '…'));
  else if (!st.repo) body.append(h('p', {}, st.hint || t('notRepo')), st.error && !/not a git repository/i.test(st.error) ? h('pre', { class: 'gp-out' }, st.error) : null, h('button', { class: 'btn primary', onclick: () => gitOp('init') }, t('initRepo')));
  else {
    const remote = st.remotes?.[0];
    body.append(h('div', { class: 'gp-branch' }, icon('branch') ? h('span', { html: icon('branch') }) : null, h('strong', {}, st.branch || '(detached)'),
      st.upstream ? h('span', { class: 'badge' }, st.upstream) : null,
      st.ahead ? h('span', { class: 'badge' }, `↑${st.ahead} ${t('ahead')}`) : null,
      st.behind ? h('span', { class: 'badge' }, `↓${st.behind} ${t('behind')}`) : null));
    if (remote) body.append(h('div', { class: 'help' }, `${remote.name}: ${remote.url}`));
    if (st.state) body.append(h('div', { class: 'state-banner' }, h('strong', {}, st.state), ...(st.state === 'rebase' ? [
      h('button', { class: 'btn small', onclick: () => gitOp('rebase-continue') }, t('continue')), h('button', { class: 'btn small', onclick: () => gitOp('rebase-skip') }, t('skip')), h('button', { class: 'btn small danger', onclick: () => gitOp('rebase-abort') }, t('abort'))]
      : st.state === 'merge' ? [h('button', { class: 'btn small danger', onclick: () => gitOp('merge-abort') }, t('abort'))] : [])));
    // changes
    body.append(h('div', { class: 'gp-section' }, `${t('changes')} (${st.files.length})`));
    if (!st.files.length) body.append(h('div', { class: 'help' }, t('noChanges')));
    else {
      const files = h('div', { class: 'gp-files' }, ...st.files.map((f) => {
        const code = f.conflict ? 'U' : f.untracked ? '?' : (f.index !== '.' ? f.index : f.worktree);
        const cb = h('input', { type: 'checkbox', checked: S.git.sel.has(f.path), onchange: (e) => { if (e.target.checked) S.git.sel.add(f.path); else S.git.sel.delete(f.path); const cbtn = document.getElementById('gp-commit'); if (cbtn) cbtn.innerHTML = icon('commit') + esc(t('commit')) + (S.git.sel.size ? ` (${S.git.sel.size})` : ''); } });
        return h('div', { class: 'gp-file', title: f.path, ondblclick: () => showDiff(f) }, cb, h('span', { class: `st ${code}` }, code), h('span', { class: 'fp' }, f.path), f.staged ? h('span', { class: 'badge' }, 'S') : null);
      }));
      const sel = () => [...S.git.sel].filter((p) => st.files.some((f) => f.path === p));
      body.append(files, h('div', { style: { display: 'flex', gap: '5px', flexWrap: 'wrap' } },
        h('button', { class: 'btn small', onclick: () => { st.files.forEach((f) => S.git.sel.add(f.path)); renderGit(); } }, '☑'),
        h('button', { class: 'btn small', onclick: () => { S.git.sel.clear(); renderGit(); } }, '☐'),
        h('button', { class: 'btn small', onclick: () => gitOp('stage', { files: sel() }) }, t('stage')),
        h('button', { class: 'btn small', onclick: () => gitOp('unstage', { files: sel() }) }, t('unstage')),
        h('button', { class: 'btn small danger', onclick: async () => { const f = sel(); if (f.length && await confirmBox({ title: t('discard'), text: f.join('\n'), danger: true, okLabel: t('discard') })) gitOp('discard', { files: f }); } }, t('discard'))));
      const msg = h('textarea', { id: 'gp-msg', class: 'input', rows: 3, placeholder: t('commitMessage'), style: { height: 'auto', padding: '7px 9px' }, oninput: (e) => { S.git.msg = e.target.value; } }); msg.value = S.git.msg;
      body.append(msg, h('button', { id: 'gp-commit', class: 'btn primary', disabled: S.git.busy, onclick: async () => {
        const files = sel();
        await gitOp('commit', { message: S.git.msg, files, includeStaged: !files.length });
        if (!S.git.out.includes('error') && !S.git.out.includes('fatal')) { S.git.msg = ''; S.git.sel.clear(); renderGit(); }
      }, html: icon('commit') + t('commit') + (S.git.sel.size ? ` (${S.git.sel.size})` : '') }));
    }
    // actions
    const a = (iconName, label, fn) => h('button', { class: 'btn', onclick: fn, disabled: S.git.busy, html: icon(iconName) + `<span>${esc(label)}</span>` });
    body.append(h('div', { class: 'gp-section' }, t('remote')), h('div', { class: 'gp-grid' },
      a('fetch', t('fetch'), () => gitOp('fetch')), a('pull', t('pull'), () => gitOp('pull')), a('rebase', t('pullRebase'), () => gitOp('pull', { rebase: true })),
      a('push', t('push'), () => gitOp('push')), a('pr', t('pr'), () => gitPRSmart(st)), a('plus', t('addRemote'), async () => { const u = await ask({ title: t('addRemote'), label: 'URL', help: 'git@bitbucket.org:team/repo.git' }); if (u) gitOp('remote-add', { name: st.remotes?.length ? 'upstream' : 'origin', url: u }); }),
      a('upload', t('publishDots'), async () => { const tg = gitTarget(); if (!tg) return; const info = await loadConnections(); publishFlow(tg.folder || S.conv?.record?.cwd || S.selFolder, info.git); }),
      a('key', t('gitAccounts'), () => openConnections('git'))));
    body.append(h('div', { class: 'gp-section' }, t('branch')), h('div', { class: 'gp-grid' },
      a('branch', t('newBranch'), gitBranchCreate), a('chevron', t('switchBranch'), () => gitPickBranch('switch')), a('merge', t('merge'), () => gitPickBranch('merge')),
      a('rebase', t('rebase'), () => gitPickBranch('rebase')), a('trash', t('deleteBranch'), () => gitPickBranch('branch-delete')), a('tag', t('tag'), async () => { const v = await ask({ title: t('tag'), label: t('name'), value: 'v' }); if (v) gitOp('tag', { tag: v }); })));
    body.append(h('div', { class: 'gp-section' }, t('stash')), h('div', { class: 'gp-grid' },
      a('stash', t('stash'), async () => { const v = await ask({ title: t('stash'), label: t('commitMessage') }); if (v != null) gitOp('stash', { message: v }); }),
      a('restore', t('stashPop'), () => gitOp('stash-pop')), a('list', t('stashList'), () => gitOp('stash-list')),
      a('history', t('log'), gitLog)));
  }
  if (S.git.out) body.append(h('pre', { class: 'gp-out' }, S.git.out));
  $.gitp.replaceChildren(head, body);
}
async function showDiff(f) {
  const tgt = gitTarget();
  try { const r = await api('/api/git/diff', { ...tgt, file: f.path, staged: f.staged && f.worktree === '.' }); modal({ title: f.path, cls: 'wide', body: h('pre', { class: 'codeblock', html: diffHtml(r.diff || '(no textual diff — new or binary file)') }) }); } catch (e) { fail(e); }
}

// ------------------------------------------------------------------ files of the conversation
function toggleFiles() {
  S.filesOpen = !S.filesOpen;
  if (S.filesOpen && settings().gitPanelOpen) { patchSettings({ gitPanelOpen: false }); $.gitp.classList.add('hidden'); }
  $.filesp.classList.toggle('hidden', !S.filesOpen);
  if (S.filesOpen) loadFiles();
  renderMain();
}
async function loadFiles() {
  if (!S.conv) { S.files = null; return renderFilesPanel(); }
  const key = S.conv.key;
  try { const r = await api('/api/conversation/files' + q({ key })); if (S.conv?.key === key) S.files = r; } catch (e) { S.files = { error: e.message }; }
  renderFilesPanel();
}
function renderFilesPanel() {
  $.filesp.classList.toggle('hidden', !S.filesOpen);
  if (!S.filesOpen) return;
  const F = S.files, cwd = F?.cwd || S.conv?.record?.cwd || '';
  const rel = (p) => (cwd && p.toLowerCase().startsWith(cwd.toLowerCase()) ? p.slice(cwd.length).replace(/^[\\/]/, '') : p);
  const row = (f, sub, extra) => h('button', { class: 'li hub-link', title: f.path, onclick: () => previewConvFile(f) },
    h('span', { html: icon(f.exists === false ? 'warn' : 'file') }), h('div', { class: 'grow' }, h('div', { class: 'fp-name' }, f.label || rel(f.path)), h('div', { class: 'sub' }, sub)), extra || null);
  const section = (title, list, render) => [h('div', { class: 'gp-section' }, `${title} (${list.length})`), list.length ? h('div', { class: 'list' }, ...list.map(render)) : h('div', { class: 'help' }, '—')];
  const body = h('div', { class: 'gp-body' });
  if (!F) body.append(h('div', { class: 'help' }, '…'));
  else if (F.error) body.append(h('div', { class: 'errorbox' }, F.error));
  else body.append(
    ...section(t('filesChanged'), F.changed, (f) => row(f, `${f.kinds.join(', ')} · ${f.edits}× ${f.exists === false ? '· ' + t('fileMissing') : ''}`, h('span', { class: 'badge' }, f.kinds.includes('add') ? 'A' : f.kinds.includes('delete') ? 'D' : 'M'))),
    ...section(t('filesRead'), F.read, (f) => row(f, `${f.times}× ${f.exists === false ? '· ' + t('fileMissing') : ''}`)),
    ...section(t('attachments'), F.attachments, (f) => row({ ...f, label: f.name }, fmtTime(f.at))),
    ...section(t('memoryFiles'), F.memory, (f) => row(f, `${f.loaded ? t('loadedEachMsg') + ' · ' : ''}${fmtTime(f.mtime)}`, f.loaded ? h('span', { class: 'badge ok' }, '✓') : null)),
    ...section(t('folderFiles'), F.folder || [], (f) => f.dir
      ? h('div', { class: 'li fdir', style: { paddingLeft: `${8 + f.depth * 14}px` }, html: icon('folder') + `<span>${esc(f.rel.split(/[\\/]/).pop())}</span>` })
      : h('button', { class: 'li hub-link', title: f.path, style: { paddingLeft: `${8 + f.depth * 14}px` }, onclick: () => previewConvFile(f) }, h('span', { html: icon('file') }), h('div', { class: 'grow fp-name' }, f.rel.split(/[\\/]/).pop()), f.memory ? h('span', { class: 'badge ok', 'data-tip': t('loadedEachMsg') }, '✓') : h('span', { class: 'sub' }, fmtSize(f.size)))),
    h('button', { class: 'btn', onclick: () => openProject(cwd), html: icon('folder') + t('browseFolder') }));
  $.filesp.replaceChildren(h('div', { class: 'gp-head' }, h('h3', { html: icon('file') + esc(t('files')) }), ib('refresh', t('refresh'), loadFiles), ib('close', t('close'), toggleFiles)), body);
}
async function previewConvFile(f) {
  let r;
  try { r = await api('/api/conversation/file' + q({ key: S.conv.key, file: f.path })); } catch (e) { fail(e); return; }
  const ext = (f.path.split('.').pop() || '').toLowerCase();
  const content = r.text != null ? (ext === 'md' ? h('div', { class: 'msg-agent', style: { padding: '4px 2px' }, html: renderMarkdown(r.text) }) : h('pre', { class: 'codeblock', html: highlightCode(r.text.slice(0, 200000), ext) })) : h('p', { class: 'help' }, r.binary ? t('binaryFile') : t('tooLargeFile'));
  const tabs = h('div', { class: 'inline' });
  const area = h('div', {}, content);
  if (f.lastDiff) {
    tabs.append(h('button', { class: 'btn small', onclick: () => area.replaceChildren(content) }, t('preview')), h('button', { class: 'btn small', onclick: () => area.replaceChildren(h('pre', { class: 'codeblock', html: diffHtml(f.lastDiff) })) }, t('changesHere')));
  }
  const isMem = /(CONTEXT|INSTRUCTIONS)\.md$/.test(f.path) || f.memory || f.loaded;
  modal({ title: f.label || f.path.split(/[\\/]/).pop(), cls: 'wide', body: h('div', {}, h('div', { class: 'help' }, f.path), tabs, area),
    foot: [isMem ? h('button', { class: 'btn', onclick: () => openMemoryEditor(f.path, f.label || f.path) }, t('edit')) : null,
      S.sum.tools.vscode.enabled ? h('button', { class: 'btn', onclick: () => api('/api/tools/vscode', { key: S.conv.key, file: f.path }).catch(fail) }, 'VS Code') : null,
      h('button', { class: 'btn', onclick: () => api('/api/reveal', { path: f.path }).catch(fail) }, t('openInExplorer'))].filter(Boolean) });
}

// ------------------------------------------------------------------ Connections (Jira, Bitbucket, Git, MATLAB)
async function loadConnections() { try { S.connInfo = await api('/api/connections'); } catch { S.connInfo = null; } return S.connInfo; }
const linkOut = (href, label) => h('a', { class: 'help', href, target: '_blank', rel: 'noopener noreferrer' }, `${label} ↗`);
const statusPill = (ok, text) => h('div', { class: `mcp-status ${ok ? 'ok' : 'warn'}` }, h('span', { class: `dot ${ok ? 'ready' : 'starting'}` }), h('span', {}, text));
const busy = async (btn, out, fn) => { btn.disabled = true; out.textContent = '…'; out.className = 'help'; try { await fn(); } catch (e) { out.textContent = e.message; out.className = 'errorbox'; } btn.disabled = false; };

async function openConnections(tab = 'jira') {
  const nav = h('nav'), section = h('section');
  const tabs = [['jira', 'Jira'], ['bitbucket', 'Bitbucket'], ['git', 'Git'], ['matlab', 'MATLAB']];
  const show = async (id) => {
    tab = id;
    nav.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.tab === id));
    section.replaceChildren(h('div', { class: 'help' }, '…'));
    const info = await loadConnections();
    if (!info) { section.replaceChildren(h('div', { class: 'errorbox' }, t('connLost'))); return; }
    section.replaceChildren(...await CONN_TABS[id](info, () => show(id), m));
  };
  for (const [id, label] of tabs) nav.append(h('button', { 'data-tab': id, onclick: () => show(id), html: (await toolIcon(id)) + `<span>${esc(label)}</span>` }));
  const m = modal({ title: t('connections'), cls: 'wide conn', body: h('div', { class: 'settings' }, nav, section) });
  show(tab);
}

const CONN_TABS = {
  async jira(info, redraw, dlg) {
    const J = info.jira;
    const site = h('input', { class: 'input', value: J.site || '', placeholder: 'https://yourcompany.atlassian.net', spellcheck: 'false' });
    const email = h('input', { class: 'input', value: J.email || '', placeholder: 'you@company.com', spellcheck: 'false' });
    const token = h('input', { class: 'input', type: 'password', autocomplete: 'new-password', placeholder: J.connected ? `•••••• (${t('keySaved')})` : '' });
    const mcp = h('input', { type: 'checkbox', checked: true });
    const out = h('div', { class: 'help' });
    const connect = h('button', { class: 'btn primary', onclick: () => busy(connect, out, async () => {
      const r = await api('/api/connections/jira', { site: site.value.trim(), email: email.value.trim(), token: token.value.trim() || undefined, mcp: mcp.checked });
      token.value = ''; toast(t('connectedAs', { name: r.user })); redraw(); renderTop();
    }) }, J.connected ? t('reconnect') : t('connect'));
    return [h('h3', {}, 'Jira'),
      J.connected ? statusPill(true, t('connectedAs', { name: `${J.user || J.email} · ${J.site.replace(/^https?:\/\//, '')}` })) : h('div', { class: 'banner info' }, h('span', { html: icon('info') }), h('span', {}, t('jiraConnectIntro'))),
      J.connected ? h('div', { class: 'inline' }, h('button', { class: 'btn primary', onclick: () => { dlg.close(); openJiraPanel(); }, html: icon('list') + t('openJira') }), h('a', { class: 'btn', href: J.site, target: '_blank', rel: 'noopener noreferrer' }, `${J.site.replace(/^https?:\/\//, '')} ↗`)) : null,
      J.mcp ? mcpStatusLine(J.mcp.name, `Jira ↔ ${t('aiAgents')}`) : null,
      h('details', { open: !J.connected }, h('summary', { class: 'gp-section', style: { cursor: 'pointer' } }, J.connected ? t('changeConnection') : t('connectJira')),
        field(t('jiraSite'), site), field(t('email'), email), field(t('atlTokenLabel'), token),
        h('div', { class: 'inline' }, linkOut('https://id.atlassian.com/manage-profile/security/api-tokens', t('createToken'))),
        h('label', { class: 'check' }, mcp, h('span', {}, t('alsoMcp'))),
        h('div', { class: 'inline' }, connect), out,
        h('details', {}, h('summary', { class: 'help', style: { cursor: 'pointer' } }, t('jiraAiOnly')),
          h('p', { class: 'help' }, t('jiraAiOnlyHelp')),
          h('button', { class: 'btn small', onclick: (e) => busy(e.currentTarget, out, async () => { const r = await api('/api/atlassian/connect', { purpose: 'jira', mode: 'oauth' }); out.textContent = r.notes.join(' · '); }) }, t('atlOauth'))))];
  },

  async bitbucket(info, redraw, dlg) {
    const B = info.bitbucket;
    const email = h('input', { class: 'input', value: B.email || '', placeholder: 'you@company.com', spellcheck: 'false' });
    const token = h('input', { class: 'input', type: 'password', autocomplete: 'new-password', placeholder: B.connected ? `•••••• (${t('keySaved')})` : '' });
    const mcp = h('input', { type: 'checkbox', checked: true }), forGit = h('input', { type: 'checkbox', checked: true });
    const out = h('div', { class: 'help' });
    const connect = h('button', { class: 'btn primary', onclick: () => busy(connect, out, async () => {
      const r = await api('/api/connections/bitbucket', { email: email.value.trim(), token: token.value.trim(), mcp: mcp.checked, useForGit: forGit.checked });
      token.value = ''; toast(t('connectedAs', { name: r.user })); redraw(); renderTop();
    }) }, B.connected ? t('reconnect') : t('connect'));
    return [h('h3', {}, 'Bitbucket Cloud'),
      B.connected ? statusPill(true, t('connectedAs', { name: `${B.user || B.email}${B.workspace ? ' · ' + B.workspace : ''}` })) : h('div', { class: 'banner info' }, h('span', { html: icon('info') }), h('span', {}, t('bbConnectIntro'))),
      B.connected ? h('div', { class: 'inline' }, h('button', { class: 'btn primary', onclick: () => { dlg.close(); openBitbucketPanel(); }, html: icon('pr') + t('openBitbucket') })) : null,
      B.mcp ? mcpStatusLine(B.mcp.name, `Bitbucket ↔ ${t('aiAgents')}`) : null,
      h('details', { open: !B.connected }, h('summary', { class: 'gp-section', style: { cursor: 'pointer' } }, B.connected ? t('changeConnection') : t('connectBitbucket')),
        field(t('email'), email), field(t('atlTokenLabel'), token),
        h('p', { class: 'help' }, t('bbTokenHelp')), linkOut('https://id.atlassian.com/manage-profile/security/api-tokens', t('createToken')),
        h('label', { class: 'check' }, mcp, h('span', {}, t('alsoMcp'))),
        h('label', { class: 'check' }, forGit, h('span', {}, t('alsoGit'))),
        h('div', { class: 'inline' }, connect), out),
      h('p', { class: 'help' }, t('bbServerNoMcp'))];
  },

  async git(info, redraw) {
    const G = info.git;
    if (!G.available) return [h('h3', {}, 'Git'), h('div', { class: 'errorbox' }, t('gitMissing')), linkOut('https://git-scm.com/downloads', 'git-scm.com')];
    // identity
    const name = h('input', { class: 'input', value: G.identity.name, placeholder: 'Jack Salameh' });
    const mail = h('input', { class: 'input', value: G.identity.email, placeholder: 'you@example.com' });
    const idOut = h('div', { class: 'help' });
    const idBtn = h('button', { class: 'btn small', onclick: () => busy(idBtn, idOut, async () => { await api('/api/git/identity', { name: name.value, email: mail.value }); idOut.textContent = '✓'; }) }, t('save'));
    // accounts
    const accList = h('div', { class: 'list' }, ...(G.accounts.length ? G.accounts.map((a) => h('div', { class: 'li' },
      h('span', { html: icon(a.auth === 'ssh' ? 'key' : 'shield') }),
      h('div', { class: 'grow' }, h('div', {}, `${a.label} — ${a.name || a.username || ''}`), h('div', { class: 'sub' }, `${a.host} · ${a.auth === 'token' ? t('httpsToken') : a.auth === 'ssh' ? 'SSH' : t('systemCred')}${a.verified ? ' · ✓' : ''}`)),
      ['github', 'gitlab', 'bitbucket'].includes(a.provider) && a.auth === 'token' ? h('button', { class: 'btn small', onclick: () => openRepoPicker(a) }, t('myRepos')) : null,
      h('button', { class: 'btn small', onclick: async () => { if (await confirmBox({ title: t('confirm'), text: t('removeAccountQ', { name: `${a.label} ${a.host}` }), danger: true })) { await api('/api/git/account/remove', { id: a.id }).catch(fail); redraw(); } } }, t('remove'))))
      : [h('div', { class: 'li help' }, t('noGitAccounts'))]));
    // add account
    const prov = select(Object.entries(G.hosts).map(([k, v]) => [k, v.label]), 'github', () => sync());
    const host = h('input', { class: 'input', placeholder: 'git.mycompany.com', spellcheck: 'false' });
    const apiBase = h('input', { class: 'input', placeholder: 'https://git.mycompany.com/api/v4', spellcheck: 'false' });
    const user = h('input', { class: 'input', spellcheck: 'false' });
    const email = h('input', { class: 'input', placeholder: 'you@company.com', spellcheck: 'false' });
    const token = h('input', { class: 'input', type: 'password', autocomplete: 'new-password' });
    const method = select([['token', t('httpsToken')], ['ssh', t('sshKey')], ['system', t('systemCred')]], 'token', () => sync());
    const tokLink = h('div');
    const sshBox = h('div');
    const fHost = field(t('server'), host), fApi = field(t('apiUrlOpt'), apiBase), fUser = field(t('userName'), user), fMail = field(t('email'), email), fTok = field(t('accessToken'), token);
    const sync = () => {
      const p = G.hosts[prov.value];
      fHost.classList.toggle('hidden', !!p.host); fApi.classList.toggle('hidden', prov.value !== 'gitlab' && prov.value !== 'other');
      fUser.classList.toggle('hidden', !(prov.value === 'other' || prov.value === 'azure') || method.value !== 'token');
      fMail.classList.toggle('hidden', prov.value !== 'bitbucket' || method.value !== 'token');
      fTok.classList.toggle('hidden', method.value !== 'token');
      tokLink.replaceChildren(method.value === 'token' && p.tokenUrl ? linkOut(p.tokenUrl, t('createToken')) : document.createTextNode(''));
      sshBox.replaceChildren(...(method.value === 'ssh' ? sshPanel(G, p, host) : []));
    };
    sync();
    const addOut = h('div', { class: 'help' });
    const addBtn = h('button', { class: 'btn primary', onclick: () => busy(addBtn, addOut, async () => {
      const r = await api('/api/git/account', { provider: prov.value, host: host.value.trim() || undefined, apiBase: apiBase.value.trim() || undefined, username: user.value.trim() || undefined, email: email.value.trim() || undefined, token: token.value.trim() || undefined, auth: method.value });
      token.value = ''; toast(`${t('connected')}: ${r.account.name || r.account.host}`); redraw();
    }) }, t('connect'));
    // clone + publish
    const url = h('input', { class: 'input', placeholder: 'https://github.com/owner/repo.git  ·  git@bitbucket.org:ws/repo.git', spellcheck: 'false' });
    const cloneOut = h('div', { class: 'help' });
    const cloneBtn = h('button', { class: 'btn', onclick: () => busy(cloneBtn, cloneOut, async () => { await cloneFlow(url.value.trim()); cloneOut.textContent = ''; }) }, t('cloneDots'));
    const testBtn = h('button', { class: 'btn', onclick: () => busy(testBtn, cloneOut, async () => { const r = await api('/api/git/remote/test', { url: url.value.trim() }); cloneOut.textContent = `${r.ok ? '✓' : '✕'} ${r.output}${r.hint ? '\n' + r.hint : ''}`; }) }, t('test'));
    const folder = S.conv?.record?.cwd || S.selFolder;
    return [h('h3', {}, 'Git'),
      h('div', { class: 'gp-section' }, t('gitIdentity')), h('p', { class: 'help' }, t('gitIdentityHelp')),
      h('div', { class: 'inline' }, field(t('name'), name), field(t('email'), mail), idBtn), idOut,
      h('div', { class: 'gp-section' }, t('gitAccounts')), accList,
      h('details', { open: !G.accounts.length }, h('summary', { class: 'help', style: { cursor: 'pointer' } }, '+ ' + t('addGitAccount')),
        field(t('host'), prov), fHost, fApi, field(t('signInWith'), method), fUser, fMail, fTok, tokLink, sshBox, h('div', { class: 'inline' }, addBtn), addOut),
      h('div', { class: 'gp-section' }, t('cloneRepo')), url, h('div', { class: 'inline' }, cloneBtn, testBtn), cloneOut,
      folder ? h('div', {}, h('div', { class: 'gp-section' }, t('publishFolder')), h('p', { class: 'help' }, folder), h('button', { class: 'btn', onclick: () => publishFlow(folder, G) }, t('publishDots'))) : null];
  },

  async matlab(info) {
    const T = S.sum.tools;
    if (!T.matlab.enabled) return [h('h3', {}, 'MATLAB'), h('p', { class: 'help' }, t('matlabOff')), h('button', { class: 'btn', onclick: () => openSettings('tools', 'matlab') }, t('configuration'))];
    return [h('h3', {}, 'MATLAB'), matlabMcpBox(T)];
  },
};

function sshPanel(G, p, hostInput) {
  const out = h('div', { class: 'help' });
  const keyBox = h('pre', { class: 'codeblock', style: { whiteSpace: 'pre-wrap', wordBreak: 'break-all' } }, G.ssh?.key || '—');
  const gen = h('button', { class: 'btn small', onclick: () => busy(gen, out, async () => { const r = await api('/api/git/ssh-key', { create: true, email: G.identity.email }); keyBox.textContent = r.key; out.textContent = r.file; }) }, G.ssh ? t('showKey') : t('createKey'));
  const copy = h('button', { class: 'btn small', onclick: () => navigator.clipboard?.writeText(keyBox.textContent).then(() => toast(t('copied'))) }, t('copy'));
  const test = h('button', { class: 'btn small', onclick: () => busy(test, out, async () => { const r = await api('/api/git/ssh-test', { host: p.host || hostInput.value.trim() }); out.textContent = `${r.ok ? '✓' : '✕'} ${r.output}`; }) }, t('test'));
  return [h('p', { class: 'help' }, t('sshHelp')), keyBox, h('div', { class: 'inline' }, gen, copy, p.sshUrl ? linkOut(p.sshUrl, t('addKeyOnSite')) : null, test), out];
}

async function openRepoPicker(acc) {
  const qi = h('input', { class: 'input', placeholder: t('search') });
  const list = h('div', { class: 'list', style: { maxHeight: '55vh', overflow: 'auto' } }, h('div', { class: 'li help' }, '…'));
  const load = async () => {
    try {
      const r = await api('/api/git/account/repos' + q({ id: acc.id, q: qi.value.trim() }));
      list.replaceChildren(...(r.repos.length ? r.repos.map((x) => h('div', { class: 'li' }, h('span', { html: icon(x.private ? 'shield' : 'globe') }),
        h('div', { class: 'grow' }, h('div', {}, x.name), h('div', { class: 'sub' }, `${x.defaultBranch || ''} · ${fmtTime(Date.parse(x.updated))}`)),
        h('button', { class: 'btn small primary', onclick: () => { m.close(); cloneFlow(x.https || x.ssh); } }, t('cloneDots')),
        x.web ? h('a', { class: 'btn small', href: x.web, target: '_blank', rel: 'noopener noreferrer' }, '↗') : null)) : [h('div', { class: 'li help' }, t('noResults'))]));
    } catch (e) { list.replaceChildren(h('div', { class: 'errorbox' }, e.message)); }
  };
  let timer; qi.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(load, 300); });
  const m = modal({ title: `${acc.label} — ${t('myRepos')}`, cls: 'mid', body: h('div', {}, qi, list) });
  load();
}

async function cloneFlow(url) {
  if (!url) throw new Error(t('pasteRepoUrl'));
  const parent = await pickFolder();
  if (!parent) return;
  const name = await ask({ title: t('cloneRepo'), label: t('folderName'), value: url.split(/[/:]/).pop().replace(/\.git$/, '') });
  if (!name) return;
  toast(t('cloning'));
  const r = await api('/api/git/clone', { url, parent, name });
  toast(`✓ ${r.folder}`);
  await loadState(false);
  openProject(r.folder);
}

async function publishFlow(folder, G) {
  const accs = G.accounts.filter((a) => ['github', 'gitlab', 'bitbucket'].includes(a.provider) && a.auth === 'token');
  const mode = select([['url', t('pasteRepoUrl')], ...accs.map((a) => [a.id, t('createOn', { site: `${a.label} (${a.name || a.host})` })])], accs[0]?.id || 'url', () => sync());
  const url = h('input', { class: 'input', placeholder: 'https://…/repo.git', spellcheck: 'false' });
  const name = h('input', { class: 'input', value: folder.split(/[\\/]/).filter(Boolean).pop().replace(/\s+/g, '-') });
  const priv = h('input', { type: 'checkbox', checked: true });
  const fUrl = field(t('repoUrl'), url), fName = field(t('repoName'), name), fPriv = h('label', { class: 'check' }, priv, h('span', {}, t('privateRepo')));
  const sync = () => { const u = mode.value === 'url'; fUrl.classList.toggle('hidden', !u); fName.classList.toggle('hidden', u); fPriv.classList.toggle('hidden', u); };
  sync();
  const out = h('div', { class: 'help' });
  const go = h('button', { class: 'btn primary', onclick: () => busy(go, out, async () => {
    const r = await api('/api/git/publish', mode.value === 'url' ? { folder, url: url.value.trim() } : { folder, accountId: mode.value, name: name.value.trim(), isPrivate: priv.checked });
    out.textContent = `${r.pushed ? '✓ ' + t('pushed') : r.note || r.output || ''} — ${r.remote}${r.hint ? '\n' + r.hint : ''}`;
    if (S.git) S.git.st = null;
  }) }, t('publish'));
  modal({ title: t('publishFolder'), cls: 'mid', body: h('div', {}, h('p', { class: 'help' }, folder), h('p', { class: 'help' }, t('publishHelp')), field(t('destination'), mode), fUrl, fName, fPriv, out), foot: [go] });
}

/** Puts a prompt in the composer of the open conversation, or starts a new conversation with it. */
function promptToAI(text, folder) {
  if (S.conv && $.input) { $.input.value = `${$.input.value ? $.input.value + '\n\n' : ''}${text}`; $.input.dispatchEvent(new Event('input')); $.input.focus(); toast(t('promptReady')); return; }
  newConversation(folder || S.selFolder, { prompt: text });
}

// ------------------------------------------------------------------ Jira panel
async function openJiraPanel() {
  const info = S.connInfo || await loadConnections();
  if (!info?.jira?.connected) return openConnections('jira');
  const preset = select([['mine', t('jqlMine')], ['reported', t('jqlReported')], ['watching', t('jqlWatching')], ['recent', t('jqlRecent')]], 'mine', () => load());
  const project = h('select', { class: 'input' }, h('option', { value: '' }, t('allProjects')));
  project.onchange = () => load();
  const qi = h('input', { class: 'input', placeholder: t('jiraSearchPh') });
  const list = h('div', { class: 'list jira-list' }), detail = h('div', { class: 'jira-detail' }, h('p', { class: 'help' }, t('pickIssue')));
  const jqlLine = h('div', { class: 'sub mono' });
  let timer;
  qi.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(load, 350); });
  async function load() {
    list.replaceChildren(h('div', { class: 'li help' }, '…'));
    try {
      const r = await api('/api/jira/search', { preset: preset.value, project: project.value || undefined, text: qi.value.trim() || undefined });
      jqlLine.textContent = r.jql;
      list.replaceChildren(...(r.issues.length ? r.issues.map((i) => h('button', { class: 'li hub-link', onclick: () => openIssue(i.key) },
        h('span', { class: `badge st-${i.statusCategory}` }, i.status), h('div', { class: 'grow' }, h('div', {}, `${i.key} · ${i.summary}`), h('div', { class: 'sub' }, `${i.type} · ${i.priority} · ${i.assignee || t('unassigned')} · ${fmtTime(Date.parse(i.updated))}`))))
        : [h('div', { class: 'li help' }, t('noResults'))]));
    } catch (e) { list.replaceChildren(h('div', { class: 'errorbox' }, e.message)); }
  }
  async function openIssue(key) {
    detail.replaceChildren(h('div', { class: 'help' }, '…'));
    let i; try { i = await api('/api/jira/issue' + q({ key })); } catch (e) { detail.replaceChildren(h('div', { class: 'errorbox' }, e.message)); return; }
    const out = h('div', { class: 'help' });
    const tr = select([['', t('changeStatus')], ...i.transitions.map((x) => [x.id, `${x.name}${x.to && x.to !== x.name ? ' → ' + x.to : ''}`])], '', () => {});
    const com = h('textarea', { class: 'input', rows: 3, placeholder: t('addComment') });
    const act = (body, msg) => (e) => busy(e.currentTarget, out, async () => { await api('/api/jira/act', { key, ...body }); toast(msg); openIssue(key); load(); });
    const aiText = `Jira issue ${i.key} — ${i.summary}\nStatus: ${i.status} · Type: ${i.type} · Priority: ${i.priority}\n\nDescription:\n${i.description || '(none)'}\n\n${i.comments.length ? 'Latest comments:\n' + i.comments.slice(-5).map((c) => `- ${c.author}: ${c.text}`).join('\n') + '\n\n' : ''}Help me work on this issue in this folder: propose a plan, then carry it out step by step.`;
    detail.replaceChildren(
      h('h3', {}, `${i.key} · ${i.summary}`),
      h('div', { class: 'chips' }, ...[i.status, i.type, i.priority, i.assignee || t('unassigned'), ...i.labels].filter(Boolean).map((v) => h('span', { class: 'chip static small' }, v))),
      h('div', { class: 'inline' },
        h('button', { class: 'btn primary small', onclick: () => { m.close(); promptToAI(aiText); }, html: icon('spark') + t('workWithAI') }),
        h('button', { class: 'btn small', onclick: act({ action: 'assign' }, t('assignedToYou')) }, t('assignToMe')),
        h('a', { class: 'btn small', href: i.url, target: '_blank', rel: 'noopener noreferrer' }, `${t('openInJira')} ↗`)),
      h('div', { class: 'gp-section' }, t('description')), h('div', { class: 'jira-text' }, i.description || '—'),
      i.subtasks.length ? h('div', {}, h('div', { class: 'gp-section' }, t('subtasks')), ...i.subtasks.map((s) => h('button', { class: 'li hub-link', onclick: () => openIssue(s.key) }, `${s.key} · ${s.summary} (${s.status})`))) : null,
      h('div', { class: 'gp-section' }, `${t('comments')} (${i.comments.length})`),
      ...i.comments.map((c) => h('div', { class: 'jira-comment' }, h('div', { class: 'sub' }, `${c.author} · ${fmtTime(Date.parse(c.created))}`), h('div', { class: 'jira-text' }, c.text))),
      com, h('div', { class: 'toolbar' }, h('button', { class: 'btn small', onclick: (e) => { if (com.value.trim()) act({ action: 'comment', text: com.value }, t('commentAdded'))(e); } }, t('addComment')),
        h('span', { class: 'grow' }), tr, h('button', { class: 'btn small', onclick: (e) => { if (tr.value) act({ action: 'transition', transition: tr.value }, t('statusChanged'))(e); } }, t('apply'))), out);
  }
  const createBtn = h('button', { class: 'btn small', html: icon('plus') + t('newIssue'), onclick: () => createIssueDialog(project.value, (k) => { load(); openIssue(k); }) });
  const m = modal({ title: 'Jira', cls: 'wide jira-panel', body: h('div', {},
    h('div', { class: 'toolbar' }, preset, project, qi, createBtn), jqlLine,
    h('div', { class: 'split' }, list, detail)) });
  load();
  api('/api/jira/projects').then((r) => project.append(...r.projects.map((p) => h('option', { value: p.key }, `${p.key} — ${p.name}`)))).catch(() => {});
}

async function createIssueDialog(proj, done) {
  let projects = []; try { projects = (await api('/api/jira/projects')).projects; } catch (e) { fail(e); return; }
  const p = select(projects.map((x) => [x.key, `${x.key} — ${x.name}`]), proj || projects[0]?.key, () => {});
  const type = select([['Task', 'Task'], ['Bug', 'Bug'], ['Story', 'Story']], 'Task', () => {});
  const sum = h('input', { class: 'input' }), desc = h('textarea', { class: 'input', rows: 5 });
  const out = h('div', { class: 'help' });
  const go = h('button', { class: 'btn primary', onclick: () => busy(go, out, async () => { const r = await api('/api/jira/create', { project: p.value, type: type.value, summary: sum.value, description: desc.value }); m.close(); toast(`✓ ${r.key}`); done?.(r.key); }) }, t('create'));
  const m = modal({ title: t('newIssue'), cls: 'mid', body: h('div', {}, field(t('project'), p), field(t('type'), type), field(t('summary'), sum), field(t('description'), desc), out), foot: [go] });
}

// ------------------------------------------------------------------ Bitbucket panel
async function openBitbucketPanel() {
  const info = S.connInfo || await loadConnections();
  if (!info?.bitbucket?.connected) return openConnections('bitbucket');
  const ws = h('select', { class: 'input' });
  const qi = h('input', { class: 'input', placeholder: t('searchRepos') });
  const repos = h('div', { class: 'list jira-list' }), detail = h('div', { class: 'jira-detail' }, h('p', { class: 'help' }, t('pickRepo')));
  let timer; qi.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(loadRepos, 350); });
  ws.onchange = () => loadRepos();
  async function loadRepos() {
    repos.replaceChildren(h('div', { class: 'li help' }, '…'));
    try {
      const r = await api('/api/bitbucket/repos' + q({ workspace: ws.value, q: qi.value.trim() }));
      repos.replaceChildren(...(r.repos.length ? r.repos.map((x) => h('button', { class: 'li hub-link', onclick: () => openRepo(x) }, h('span', { html: icon(x.private ? 'shield' : 'globe') }),
        h('div', { class: 'grow' }, h('div', {}, x.name), h('div', { class: 'sub' }, `${x.mainBranch || ''} · ${fmtTime(Date.parse(x.updated))}`)))) : [h('div', { class: 'li help' }, t('noResults'))]));
    } catch (e) { repos.replaceChildren(h('div', { class: 'errorbox' }, e.message)); }
  }
  async function openRepo(x, state = 'OPEN') {
    const st = select([['OPEN', t('prOpen')], ['MERGED', t('prMerged')], ['DECLINED', t('prDeclined')]], state, (v) => openRepo(x, v));
    const prs = h('div', { class: 'list' }, h('div', { class: 'li help' }, '…'));
    detail.replaceChildren(h('h3', {}, x.fullName), h('p', { class: 'help' }, x.description || ''),
      h('div', { class: 'inline' }, h('button', { class: 'btn small primary', onclick: () => cloneFlow(x.clone.https || x.clone.ssh).catch(fail) }, t('cloneDots')),
        h('a', { class: 'btn small', href: x.url, target: '_blank', rel: 'noopener noreferrer' }, 'bitbucket.org ↗'), st),
      h('div', { class: 'gp-section' }, t('pullRequests')), prs);
    try {
      const r = await api('/api/bitbucket/prs' + q({ workspace: x.workspace, repo: x.slug, state }));
      prs.replaceChildren(...(r.prs.length ? r.prs.map((p) => h('button', { class: 'li hub-link', onclick: () => openPr(x, p.id) }, h('span', { class: 'badge' }, `#${p.id}`),
        h('div', { class: 'grow' }, h('div', {}, p.title), h('div', { class: 'sub' }, `${p.author} · ${p.source} → ${p.destination} · ${p.comments} 💬${p.approvals.length ? ' · ✓ ' + p.approvals.join(', ') : ''}`)))) : [h('div', { class: 'li help' }, t('noResults'))]));
    } catch (e) { prs.replaceChildren(h('div', { class: 'errorbox' }, e.message)); }
  }
  async function openPr(x, id) {
    detail.replaceChildren(h('div', { class: 'help' }, '…'));
    let p; try { p = await api('/api/bitbucket/pr' + q({ workspace: x.workspace, repo: x.slug, id })); } catch (e) { detail.replaceChildren(h('div', { class: 'errorbox' }, e.message)); return; }
    const out = h('div', { class: 'help' });
    const com = h('textarea', { class: 'input', rows: 3, placeholder: t('addComment') });
    const act = (action, extra = {}) => (e) => busy(e.currentTarget, out, async () => { await api('/api/bitbucket/pr/act', { workspace: x.workspace, repo: x.slug, id, action, ...extra }); toast('✓'); openPr(x, id); });
    const review = `Review pull request #${p.id} "${p.title}" (${p.source} → ${p.destination}) of ${x.fullName}.\n${p.description ? 'Description: ' + p.description + '\n' : ''}\nDiff:\n\`\`\`diff\n${p.diff.slice(0, 60000)}\n\`\`\`\nList bugs, risks and improvements by severity, with file and line.`;
    detail.replaceChildren(h('h3', {}, `#${p.id} · ${p.title}`), h('div', { class: 'sub' }, `${p.author} · ${p.source} → ${p.destination} · ${p.state}`),
      h('div', { class: 'inline' },
        h('button', { class: 'btn small primary', onclick: () => { m.close(); promptToAI(review); }, html: icon('spark') + t('reviewWithAI') }),
        h('button', { class: 'btn small', onclick: act('approve') }, t('approve')),
        h('button', { class: 'btn small', onclick: async (e) => { if (await confirmBox({ title: t('merge'), text: t('mergeQ', { src: p.source, dst: p.destination }) })) act('merge')(e); } }, t('merge')),
        h('button', { class: 'btn small', onclick: async (e) => { if (await confirmBox({ title: t('decline'), text: t('declineQ'), danger: true })) act('decline')(e); } }, t('decline')),
        h('a', { class: 'btn small', href: p.url, target: '_blank', rel: 'noopener noreferrer' }, '↗'), h('button', { class: 'btn small', onclick: () => openRepo(x) }, '← ' + t('pullRequests'))),
      p.description ? h('div', { class: 'jira-text' }, p.description) : null,
      h('pre', { class: 'codeblock', style: { maxHeight: '40vh', overflow: 'auto' }, html: diffHtml(p.diff || '(no diff)') }),
      com, h('button', { class: 'btn small', onclick: (e) => { if (com.value.trim()) act('comment', { text: com.value })(e); } }, t('addComment')), out);
  }
  const folder = S.conv?.record?.cwd || S.selFolder;
  const prBtn = folder ? h('button', { class: 'btn small', html: icon('pr') + t('prFromFolder'), onclick: () => prFromFolder(folder) }) : null;
  const m = modal({ title: 'Bitbucket', cls: 'wide jira-panel', body: h('div', {}, h('div', { class: 'toolbar' }, ws, qi, prBtn), h('div', { class: 'split' }, repos, detail)) });
  try {
    const w = await api('/api/bitbucket/workspaces');
    ws.replaceChildren(...w.workspaces.map((x) => h('option', { value: x.slug, selected: x.slug === w.current }, x.name || x.slug)));
    loadRepos();
  } catch (e) { repos.replaceChildren(h('div', { class: 'errorbox' }, e.message)); }
}

async function prFromFolder(folder) {
  const title = await ask({ title: t('pr'), label: t('prTitle') });
  if (!title) return;
  const dst = await ask({ title: t('pr'), label: t('targetBranch'), value: S.sum.tools.bitbucket.defaultBranch || 'main' });
  if (dst == null) return;
  try { const r = await api('/api/bitbucket/pr/from-folder', { folder, title, destination: dst || undefined }); toast(`✓ #${r.id} ${r.title}`); if (r.url) window.open(r.url, '_blank', 'noopener'); } catch (e) { fail(e); }
}

// ------------------------------------------------------------------ Jira
async function jiraAction() {
  const keyv = await ask({ title: 'Jira', label: 'Issue key (e.g. PROJ-123)', validate: (v) => (/^[A-Z][A-Z0-9_]+-\d+$/.test(v) ? null : 'PROJ-123') });
  if (!keyv) return;
  if (!S.conv) { toast(t('newChat'), true); return; }
  $.input.value = `${$.input.value ? $.input.value + '\n\n' : ''}Using the Jira tools, fetch issue ${keyv}: summarise its status, description, acceptance criteria and open sub-tasks, then propose next steps for this folder.`;
  $.input.dispatchEvent(new Event('input')); $.input.focus();
}

// ------------------------------------------------------------------ settings dialog
async function openSettings(tab = 'general', focusTool) {
  const tabs = [['general', 'gear'], ['accounts', 'bot'], ['appearance', 'eye'], ['models', 'cpu'], ['keys', 'key'], ['tools', 'tool'], ['skills', 'puzzle'], ['configToml', 'fileText'], ['about', 'info']];
  if (tab === 'agents') tab = 'accounts';
  const nav = h('nav');
  const section = h('section');
  const show = async (name) => {
    nav.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.tab === name));
    section.replaceChildren(h('p', { class: 'help' }, '…'));
    try { section.replaceChildren(...[].concat(await SETTINGS[name](focusTool))); } catch (e) { section.replaceChildren(h('div', { class: 'errorbox' }, e.message)); }
  };
  for (const [name, ic] of tabs) nav.append(h('button', { 'data-tab': name, onclick: () => show(name), html: icon(ic) + `<span>${esc(t(name))}</span>` }));
  // Single instance: re-opening (e.g. after an action inside a tab) replaces the dialog instead of stacking it.
  if (S.settingsModal) { const prev = S.settingsModal; S.settingsModal = null; prev.close(); }
  const m = modal({ title: t('configuration'), cls: 'wide', body: h('div', { class: 'settings' }, nav, section), onClose: () => { if (S.settingsModal === m) { S.settingsModal = null; loadState(); } } });
  S.settingsModal = m;
  show(tab);
}

const field = (label, input, help) => h('label', { class: 'field' }, h('span', {}, label), input, help ? h('div', { class: 'help' }, help) : null);
const checkbox = (label, checked, onchange) => h('label', { class: 'check' }, h('input', { type: 'checkbox', checked, onchange: (e) => onchange(e.target.checked) }), h('span', {}, label));
const sw = (checked, onchange, tip) => h('label', { class: 'switch', 'data-tip': tip }, h('input', { type: 'checkbox', checked, onchange: (e) => onchange(e.target.checked) }), h('span'));
const select = (opts, value, onchange) => h('select', { class: 'input', onchange: (e) => onchange(e.target.value) }, ...opts.map(([v, l]) => h('option', { value: v, selected: v === value }, l)));
const input = (value, onchange, attrs = {}) => h('input', { class: 'input', value: value ?? '', spellcheck: 'false', onchange: (e) => onchange(e.target.value), ...attrs });
function readFileAsDataUrl(accept) {
  return new Promise((resolve) => {
    const inp = h('input', { type: 'file', accept, style: { display: 'none' } });
    inp.onchange = () => { const f = inp.files[0]; if (!f) return resolve(null); const r = new FileReader(); r.onload = () => resolve({ name: f.name, data: String(r.result).split(',')[1] || '' }); r.readAsDataURL(f); };
    document.body.append(inp); inp.click(); setTimeout(() => inp.remove(), 60_000);
  });
}

/** Add or edit an API service: choose a preset, paste the key, test. */
function providerDialog(existing) {
  const presets = S.sum.presets || [];
  const preset = select(presets.map((p) => [p.preset, p.label]), existing?.preset || 'openai', (v) => fill(v));
  const label = h('input', { class: 'input' }), baseUrl = h('input', { class: 'input', spellcheck: 'false' }), keyName = h('input', { class: 'input', spellcheck: 'false' });
  const key = h('input', { class: 'input', type: 'password', autocomplete: 'new-password', placeholder: existing?.keySaved ? '•••••• (' + t('keySaved') + ')' : '' });
  const models = h('input', { class: 'input', spellcheck: 'false', value: (existing?.models || []).join(', ') });
  const link = h('a', { target: '_blank', rel: 'noopener noreferrer' });
  const result = h('div', { class: 'help' });
  const fill = (id) => { const p = presets.find((x) => x.preset === id); if (!p) return; if (!existing || existing.preset !== id) { label.value = p.label; baseUrl.value = p.baseUrl; keyName.value = p.keyName || ''; } link.href = p.site || '#'; link.textContent = p.site ? `${t('getKey')} ↗` : ''; };
  if (existing) { label.value = existing.label; baseUrl.value = existing.baseUrl; keyName.value = existing.keyName || ''; }
  fill(existing?.preset || 'openai');
  const save = async () => {
    btn.disabled = true; result.textContent = '…';
    try {
      const r = await api('/api/providers/save', { id: existing?.id, preset: preset.querySelector('select')?.value || preset.value, label: label.value, baseUrl: baseUrl.value, keyName: keyName.value, key: key.value || undefined, models: models.value.split(',').map((x) => x.trim()).filter(Boolean) });
      key.value = '';
      if (r.test.ok) { result.textContent = `✓ ${r.test.models} models — ${r.test.sample.join(', ')}`; await loadState(false); setTimeout(() => { m.close(); openSettings('accounts'); }, 900); }
      else { result.textContent = `✕ ${r.test.error}`; result.style.color = 'var(--danger)'; await loadState(false); }
    } catch (e) { result.textContent = e.message; result.style.color = 'var(--danger)'; }
    btn.disabled = false;
  };
  const btn = h('button', { class: 'btn primary', onclick: save }, `${t('save')} & ${t('test')}`);
  const m = modal({ title: existing ? existing.label : t('addProvider'), cls: 'mid', body: h('div', {}, field(t('service'), preset), link, field(t('name'), label), field(t('baseUrlLabel'), baseUrl), field(t('keyName'), keyName), field(t('apiKey'), key), field(t('modelsOptional'), models), result),
    foot: [h('button', { class: 'btn', onclick: () => m.close() }, t('cancel')), btn] });
}

// ------------------------------------------------------------------ add-ons (agents, gateways, connectors, skill packs)
async function installAddon(id, extra = {}) {
  try { const r = await api('/api/addons/install', { id, ...extra }); if (r.opened) toast(r.opened); else toast(`${t('install')}…`); return r; } catch (e) { fail(e); return null; }
}

async function openAddons(category = 'agents', folder) {
  let info;
  try { info = await api('/api/addons'); } catch (e) { fail(e); return; }
  const cats = ['agents', 'workflows', 'gateways', 'connectors', 'skills'];
  const nav = h('nav'), section = h('section'), log = h('div', { class: 'jobs' });
  const show = (cat) => {
    category = cat;
    nav.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.cat === cat));
    section.replaceChildren(h('div', { class: 'cards' }, ...info.catalog.filter((c) => c.category === cat).map((c) => addonCard(c, folder))), h('h3', { style: { marginTop: '16px' } }, t('jobs')), log);
    if (cat === 'skills') section.prepend(skillBox(folder));
  };
  for (const c of cats) nav.append(h('button', { 'data-cat': c, onclick: () => show(c), html: icon({ agents: 'bot', workflows: 'list', gateways: 'globe', connectors: 'plug', skills: 'puzzle' }[c]) + `<span>${esc(t('cat_' + c))}</span>` }));
  const drawJobs = () => log.replaceChildren(...(S.jobs || []).slice().reverse().map((j) => h('details', { class: 'work', open: j.status === 'running' || j.status === 'failed' ? true : null },
    h('summary', { html: `${icon(j.status === 'done' ? 'check' : j.status === 'failed' ? 'warn' : 'refresh')}<span class="cmd">${esc(j.title)}</span><span class="exit ${j.status === 'done' ? 'ok' : j.status === 'failed' ? 'bad' : 'run'}">${esc(j.status)}</span>` }),
    h('pre', { class: 'term' }, j.log || '…'))));
  S.jobs = info.jobs; S.onJobs = drawJobs; drawJobs();
  const m = modal({ title: t('addons'), cls: 'wide', body: h('div', { class: 'settings' }, nav, section), onClose: () => { S.onJobs = null; loadState(false); } });
  S.addonsRefresh = async () => { try { info = await api('/api/addons'); if (document.body.contains(section)) show(category); } catch { /* */ } };
  show(category);
  void m;
}

function addonCard(c, folder) {
  const status = c.installed === true ? h('span', { class: 'badge ok' }, t('installed')) : c.running ? h('span', { class: 'badge ok' }, t('running')) : null;
  const tokenInput = c.mcp?.tokenName ? h('input', { class: 'input', type: 'password', autocomplete: 'new-password', placeholder: `${t('token')} (${c.mcp.tokenName})` }) : null;
  const action = c.skills ? h('button', { class: 'btn small', onclick: () => { const box = document.getElementById('skill-src'); if (box) { box.value = c.skills; box.dispatchEvent(new Event('change')); } } }, t('open'))
    : h('button', { class: 'btn primary small', onclick: async () => {
      let f = folder;
      if (c.mcp?.needsFolder && !f) { f = await pickFolder(); if (!f) return; }
      await installAddon(c.id, { token: tokenInput?.value || undefined, folder: f });
    } }, c.external ? t('open') + ' ↗' : c.start && c.installed ? t('start') : t('install'));
  return h('div', { class: 'card' },
    h('div', { class: 'card-head', html: `${icon({ agents: 'bot', workflows: 'list', gateways: 'globe', connectors: 'plug', skills: 'puzzle' }[c.category])}<h4>${esc(c.name)}</h4>` }, status),
    h('p', { class: 'help' }, c.description), h('div', { class: 'help' }, c.vendor, ' · ', h('a', { href: c.site, target: '_blank', rel: 'noopener noreferrer' }, new URL(c.site).hostname)),
    c.mcp?.tokenHelp ? h('div', { class: 'help' }, h('a', { href: c.mcp.tokenHelp, target: '_blank', rel: 'noopener noreferrer' }, `${t('getKey')} ↗`)) : null,
    tokenInput, h('div', { style: { marginTop: '8px' } }, action));
}

/** Skill installer: paste a GitHub link (or choose a pack) → see the skills inside → tick → install. */
function skillBox(folder) {
  const src = h('input', { class: 'input', id: 'skill-src', placeholder: 'https://github.com/owner/repo  ·  owner/repo  ·  C:\\path\\to\\skill', spellcheck: 'false' });
  const scope = select([['global', t('scopeGlobal')], ...(folder || S.conv?.record?.cwd || S.selFolder ? [['folder', `${t('scopeFolder')} — ${folder || S.conv?.record?.cwd || S.selFolder}`]] : [])], folder ? 'folder' : 'global', () => {});
  const list = h('div', { class: 'list' });
  const out = h('div', { class: 'help' });
  let found = [];
  const preview = async () => {
    const v = src.value.trim(); if (!v) return;
    list.replaceChildren(h('div', { class: 'li help' }, '…'));
    if (!/github\.com|^[\w.-]+\/[\w.-]+$/.test(v)) { list.replaceChildren(h('div', { class: 'li help' }, v)); found = null; return; }
    try { const r = await api('/api/skills/preview', { source: v }); found = r.skills; list.replaceChildren(...(found.length ? found.map((sk) => h('label', { class: 'li check', style: { margin: 0 } }, h('input', { type: 'checkbox', value: sk.name, checked: found.length <= 3 }), h('div', { class: 'grow' }, h('div', {}, sk.name), h('div', { class: 'sub' }, sk.description)))) : [h('div', { class: 'li help' }, t('noResults'))])); }
    catch (e) { list.replaceChildren(h('div', { class: 'li help' }, e.message)); }
  };
  src.addEventListener('change', preview);
  src.addEventListener('keydown', (e) => { if (e.key === 'Enter') preview(); });
  return h('div', { class: 'card', style: { marginBottom: '14px' } }, h('div', { class: 'card-head', html: icon('puzzle') + `<h4>${esc(t('addSkill'))}</h4>` }),
    field(t('installFrom'), src), h('button', { class: 'btn small', onclick: preview }, t('preview')), h('div', { class: 'help', style: { marginTop: '8px' } }, t('pickSkills')), list, field(t('scope'), scope),
    h('button', { class: 'btn primary', onclick: async (e) => {
      const select_ = [...list.querySelectorAll('input:checked')].map((i) => i.value);
      const btn = e.currentTarget; btn.disabled = true;
      try {
        const r = await api('/api/skills/install', { source: src.value.trim(), scope: scope.querySelector('select')?.value || 'global', folder: folder || S.conv?.record?.cwd || S.selFolder, select: found === null ? undefined : select_ });
        out.textContent = r.kind === 'plugin' ? r.message : r.results.map((x) => `${x.status === 'installed' ? '✓' : '•'} ${x.name} (${x.status})`).join('   ');
      } catch (err) { out.textContent = err.message; }
      btn.disabled = false;
    } }, t('installSelected')), out);
}

function readFileAsText(accept) {
  return new Promise((resolve) => {
    const inp = h('input', { type: 'file', accept, style: { display: 'none' } });
    inp.onchange = () => { const f = inp.files[0]; if (!f) return resolve(null); const r = new FileReader(); r.onload = () => resolve({ name: f.name, text: r.result }); r.readAsText(f); };
    document.body.append(inp); inp.click(); setTimeout(() => inp.remove(), 60_000);
  });
}

const SETTINGS = {
  general() {
    const s = settings();
    return [h('h3', {}, t('general')),
      field(t('theme'), select([['system', t('system')], ['light', t('light')], ['dark', t('dark')]], s.theme || 'system', (v) => { patchSettings({ theme: v }, true); applyTheme(); renderTop(); })),
      field(t('language'), select(Object.entries(LANGS).map(([k, v]) => [k, v.name]), getLang(), (v) => changeLang(v))),
      field(t('defaultMode'), select((S.sum.actionModes || []).map((m) => [m, t('mode.' + m)]), s.defaultActionMode || 'ask', (v) => patchSettings({ defaultActionMode: v }, true)), t(`modeHelp.${s.defaultActionMode || 'ask'}`)),
      field(t('openMode'), select([['app', t('openApp')], ['browser', t('openBrowser')]], s.openMode || 'app', (v) => patchSettings({ openMode: v }, true))),
      field(t('uiMode'), select([['simple', t('simpleMode')], ['pro', t('proMode')]], s.uiMode || 'simple', (v) => { patchSettings({ uiMode: v }, true); document.body.classList.toggle('mode-simple', v === 'simple'); renderAll(); }), t('simpleHelp')),
      checkbox(t('quitOnClose'), s.quitOnWindowClose !== false, (v) => patchSettings({ quitOnWindowClose: v }, true)),
      checkbox(t('syncConfig'), s.syncConfig !== false, (v) => patchSettings({ syncConfig: v }, true)),
      checkbox(t('transcriptCopy'), s.transcriptCopy !== false, (v) => patchSettings({ transcriptCopy: v }, true)),
      checkbox(t('cpSetting'), s.checkpoints !== false, (v) => patchSettings({ checkpoints: v }, true)),
      checkbox(t('notifySetting'), s.notify !== false && typeof Notification !== 'undefined' && Notification.permission === 'granted', async (v) => { if (v && typeof Notification !== 'undefined' && Notification.permission !== 'granted') { const p = await Notification.requestPermission().catch(() => 'denied'); if (p !== 'granted') { toast(t('notifyDenied'), true); return; } } patchSettings({ notify: v }, true); }),
      h('h3', {}, t('memUpdTitle')),
      field(t('memUpdEvery'), select([['0', t('never')], ...[5, 6, 7, 8, 9, 10].map((n) => [String(n), t('everyN', { n })])], String(s.memoryAskEvery ?? 7), (v) => patchSettings({ memoryAskEvery: +v }, true))),
      field(t('memUpdMode'), select([['ask', t('memModeAsk')], ['auto', t('memModeAuto')], ['manual', t('memModeManual')]], s.memoryUpdateMode || 'ask', (v) => patchSettings({ memoryUpdateMode: v }, true)), t('memUpdHelp'))];
  },

  models() {
    const wrap = h('div');
    const draw = () => {
      const list = S.sum.models;
      wrap.replaceChildren(h('h3', {}, t('models')),
        h('div', { class: 'list' }, ...list.map((m) => h('div', { class: 'li' }, h('span', { html: icon(m.agent === 'claude' ? 'bot' : 'cpu') }),
          h('div', { class: 'grow' }, h('div', {}, m.label, m.isDefault ? h('span', { class: 'badge', style: { marginLeft: '6px' } }, 'default') : null), h('div', { class: 'sub' }, `${m.agent} · ${m.model}${m.provider ? ' · ' + m.provider : ''} · ${(m.efforts || []).map(effortLabel).join(', ')}`)),
          h('button', { class: 'btn small', onclick: () => api('/api/models/remove', { key: m.key }).then(reload).catch(fail) }, t('remove'))))),
        h('div', { class: 'inline', style: { marginTop: '10px' } },
          h('button', { class: 'btn', html: icon('upload') + t('importToml'), onclick: async () => {
            const f = await readFileAsText('.toml'); if (!f) return;
            const label = await ask({ title: t('importToml'), label: t('name'), value: f.name.replace(/\.toml$/i, '') });
            if (label == null) return;
            try {
              const r = await api('/api/models/import', { text: f.text, label });
              if (r.dropped?.length) toast(`Secrets removed from the profile: ${r.dropped.join(', ')}. Save them under ${t('keys')}.`);
              if (r.envKey && !r.envKeySaved) toast(`${r.envKey}: ${t('saveKey')} → ${t('keys')}`);
              reload();
            } catch (e) { fail(e); }
          } }),
          h('button', { class: 'btn', html: icon('plus') + t('addModel'), onclick: addModelDialog }),
          S.sum.models && h('button', { class: 'btn', html: icon('eye') + t('restoreModels'), onclick: () => api('/api/models/restore', {}).then(reload).catch(fail) })));
    };
    const reload = async () => { await loadState(false); draw(); };
    draw();
    return wrap;
  },

  async accounts() {
    const info = await api('/api/providers');
    const cli = await Promise.all(info.cli.map(async (a) => {
      const [ik, fb] = agentIconName(a.id);
      const addon = { codex: 'codex-cli', claude: 'claude-code' }[a.id];
      return h('div', { class: 'card' },
        h('div', { class: 'card-head', html: `${await toolIcon(ik, fb)}<h4>${esc(a.label)}</h4><span class="agent-pill"><span class="dot ${a.state}"></span>${esc(a.installed ? t(a.state) || a.state : t('notInstalled'))}</span>` }),
        h('p', { class: 'help' }, t('canEdit') + '. ' + t('signInHint')),
        a.error && a.installed ? h('div', { class: 'help', style: { color: 'var(--danger)' } }, a.error) : null,
        !a.installed ? h('button', { class: 'btn primary small', onclick: () => installAddon(addon), html: icon('download') + t('install') }) : null,
        field(t('agentPath'), input((settings().agentBins || {})[a.id] || '', (v) => patchSettings({ agentBins: { ...(settings().agentBins || {}), [a.id]: v } }, true), { placeholder: a.id })),
        a.id === 'codex' ? h('div', { class: 'inline' }, h('button', { class: 'btn small', onclick: reconnect, html: icon('refresh') + t('reconnect') }), checkPanel('codex')) : null);
    }));
    const apiCards = info.api.map((p) => h('div', { class: 'li' }, h('span', { html: icon('api') }),
      h('div', { class: 'grow' }, h('div', {}, p.label), h('div', { class: 'sub' }, `${p.baseUrl} · ${p.keyName ? (p.keySaved ? t('keySaved') : t('noKey')) : '—'}${p.models?.length ? ' · ' + p.models.join(', ') : ''}`)),
      h('button', { class: 'btn small', onclick: async (e) => { const btn = e.currentTarget; btn.disabled = true; try { const r = await api('/api/providers/test', { id: p.id }); toast(`${p.label}: ✓ ${r.models} — ${r.sample.join(', ')}`); } catch (err) { fail(err); } btn.disabled = false; } }, t('test')),
      h('button', { class: 'btn small', onclick: () => providerDialog(p) }, t('edit')),
      h('button', { class: 'btn small danger', onclick: async () => { if (await confirmBox({ title: t('remove'), text: p.label, danger: true })) { await api('/api/providers/remove', { id: p.id }).catch(fail); await loadState(false); openSettings('accounts'); } } }, t('remove'))));
    return [h('h3', {}, t('cliAgents')), h('div', { class: 'cards' }, ...cli),
      h('h3', { style: { marginTop: '20px' } }, t('apiProviders')),
      h('div', { class: 'list' }, ...(apiCards.length ? apiCards : [h('div', { class: 'li help' }, '—')])),
      h('div', { class: 'inline', style: { marginTop: '10px' } }, h('button', { class: 'btn primary', onclick: () => providerDialog(), html: icon('plus') + t('addProvider') }),
        h('button', { class: 'btn', onclick: () => openAddons('gateways'), html: icon('puzzle') + 'OmniRoute / Ollama…' }))];
  },

  async appearance() {
    const tools = ['vscode', 'matlab', 'git', 'bitbucket', 'jira', 'codex', 'claude'];
    const names = { vscode: 'VS Code', matlab: 'MATLAB', git: 'Git', bitbucket: 'Bitbucket', jira: 'Jira', codex: 'Codex / OpenAI', claude: 'Claude' };
    const out = h('div', { class: 'help' });
    const rows = await Promise.all(tools.map(async (tl) => h('div', { class: 'li' }, h('span', { class: 'iconbox', html: await toolIcon(tl, agentIconName(tl)[1] === 'api' ? tl : agentIconName(tl)[1]) }), h('div', { class: 'grow' }, names[tl]),
      h('button', { class: 'btn small', onclick: async () => { const f = await readFileAsDataUrl('image/*,.svg,.ico'); if (!f) return; try { const r = await api('/api/icons/upload', { tool: tl, name: f.name, data: f.data }); S.sum.icons = r.icons; setLogos(S.sum.logos, S.sum.icons, TOKEN); renderTop(); openSettings('appearance'); } catch (e) { fail(e); } } }, t('upload')),
      S.sum.icons?.[tl] ? h('button', { class: 'btn small', onclick: async () => { const r = await api('/api/icons/reset', { tool: tl }); S.sum.icons = r.icons; setLogos(S.sum.logos, S.sum.icons, TOKEN); renderTop(); openSettings('appearance'); } }, t('reset')) : null)));
    return [h('h3', {}, t('appearance')),
      field(t('theme'), select([['system', t('system')], ['light', t('light')], ['dark', t('dark')]], settings().theme || 'system', (v) => { patchSettings({ theme: v }, true); applyTheme(); renderTop(); })),
      field(t('uiMode'), select([['simple', t('simpleMode')], ['pro', t('proMode')]], settings().uiMode || 'simple', (v) => { patchSettings({ uiMode: v }, true); document.body.classList.toggle('mode-simple', v === 'simple'); renderAll(); }), t('simpleHelp')),
      h('h3', { style: { marginTop: '18px' } }, t('officialIcons')), h('p', { class: 'help' }, t('fetchIconsHelp')),
      checkbox(t('autoIcons'), settings().autoIcons !== false, (v) => patchSettings({ autoIcons: v }, true)),
      h('button', { class: 'btn primary', html: icon('download') + t('fetchIcons'), onclick: async (e) => {
        const btn = e.currentTarget; btn.disabled = true; out.textContent = '…';
        try { const r = await api('/api/icons/fetch', {}); S.sum.icons = r.icons; setLogos(S.sum.logos, S.sum.icons, TOKEN); renderTop(); out.textContent = r.results.map((x) => `${x.ok ? '✓' : '✕'} ${x.tool}${x.ok ? '' : ' — ' + x.error}`).join('   '); setTimeout(() => openSettings('appearance'), 1500); }
        catch (err) { out.textContent = err.message; }
        btn.disabled = false;
      } }), out,
      h('div', { class: 'list', style: { marginTop: '10px' } }, ...rows)];
  },

  async keys() {
    const r = await api('/api/secrets');
    const name = h('input', { class: 'input', placeholder: 'AZURE_OPENAI_API_KEY', spellcheck: 'false', autocomplete: 'off' });
    const value = h('input', { class: 'input', type: 'password', autocomplete: 'new-password' });
    return [h('h3', {}, t('keys')), h('p', { class: 'help' }, t('keysHelp', { protection: r.protection })),
      r.backend === 'file' ? h('div', { class: 'banner warn' }, h('span', { html: icon('warn') }), h('span', {}, r.protection)) : null,
      h('div', { class: 'list' }, ...(r.secrets.length ? r.secrets.map((s) => h('div', { class: 'li' }, h('span', { html: icon('key') }), h('div', { class: 'grow' }, h('code', {}, s.name), h('div', { class: 'sub' }, `${s.description || ''} ${fmtTime(s.updatedAt)}`)), h('button', { class: 'btn small danger', onclick: () => api('/api/secrets/remove', { name: s.name }).then(() => openSettings('keys')).catch(fail) }, t('remove')))) : [h('div', { class: 'li help' }, '—')])),
      h('div', { class: 'inline', style: { marginTop: '8px' } }, field(t('keyName'), name), field(t('keyValue'), value),
        h('button', { class: 'btn primary', style: { marginBottom: '4px' }, onclick: async () => {
          try { await api('/api/secrets/set', { name: name.value.trim().toUpperCase(), value: value.value }); value.value = ''; toast(t('saved')); await api('/api/agent/restart', { agent: 'codex' }).catch(() => {}); openSettings('keys'); } catch (e) { fail(e); }
        } }, t('saveKey')))];
  },

  agents() {
    const s = settings();
    const bins = { ...(s.agentBins || {}) };
    return [h('h3', {}, t('agents')), h('div', { class: 'cards' }, ...Object.entries(S.sum.agents).map(([id, a]) => h('div', { class: 'card' },
      h('div', { class: 'card-head', html: icon(id === 'codex' ? 'terminal' : 'bot') + `<h4>${esc(a.label)}</h4><span class="agent-pill"><span class="dot ${a.state}"></span>${esc(t(a.state) || a.state)}</span>` }),
      a.error ? h('div', { class: 'help', style: { color: 'var(--danger)' } }, a.error) : null,
      a.version ? h('div', { class: 'help' }, `v${a.version}${a.codexHome ? ' · ' + a.codexHome : ''}`) : null,
      field(t('agentPath'), input(bins[id] || '', (v) => { bins[id] = v; patchSettings({ agentBins: bins }, true); }, { placeholder: id === 'codex' ? 'codex' : 'claude' })),
      id === 'codex' ? h('div', { class: 'inline' }, h('button', { class: 'btn', onclick: reconnect, html: icon('refresh') + t('reconnect') }), h('button', { class: 'btn', onclick: () => api('/api/agent/stop', { agent: 'codex' }).then(loadState).catch(fail), html: icon('stop') + t('quitAgent') })) : null,
      id === 'codex' ? checkPanel('codex') : null)))];
  },

  async tools(focus) {
    const info = await api('/api/tools/info');
    const T = S.sum.tools;
    const upd = (tool, patch) => api('/api/tools', { tool, patch }).then((r) => { S.sum.tools = r.tools; (r.warnings || []).forEach((w) => toast(w)); renderTop(); }).catch(fail);
    const card = async (id, title, help, ...content) => h('div', { class: 'card', id: `card-${id}`, style: focus === id ? { borderColor: 'var(--accent)' } : null },
      h('div', { class: 'card-head', html: (await toolIcon(id)) + `<h4>${esc(title)}</h4>` }, sw(T[id].enabled, (v) => upd(id, { enabled: v }), t('enabled'))),
      h('p', { class: 'help' }, help), ...content, checkPanel(id));
    const jira = T.jira;
    const jmode = h('select', { class: 'input' }, h('option', { value: 'remote', selected: jira.mode !== 'local' }, t('jiraRemote')), h('option', { value: 'local', selected: jira.mode === 'local' }, t('jiraLocal')));
    const jurl = input(jira.url, () => {}, { placeholder: 'https://…/mcp' });
    const jauth = h('select', { class: 'input' }, h('option', { value: 'oauth', selected: jira.auth !== 'bearer' }, t('authOauth')), h('option', { value: 'bearer', selected: jira.auth === 'bearer' }, t('authBearer')));
    const jtok = h('input', { class: 'input', type: 'password', autocomplete: 'new-password', placeholder: '••••' });
    const jsite = input(jira.site, () => {}, { placeholder: 'https://company.atlassian.net' });
    const jmail = input(jira.email, () => {});
    const jcmd = input(jira.command || 'uvx', () => {});
    const jargs = input(Array.isArray(jira.args) ? jira.args.join(' ') : (jira.args || 'mcp-atlassian'), () => {});
    const remoteBox = h('div', {}, field(t('endpoint'), jurl), field('Auth', jauth));
    const localBox = h('div', {}, field(t('site'), jsite), field(t('email'), jmail), h('div', { class: 'inline' }, field(t('commandLine'), jcmd), field(t('args'), jargs)));
    const syncJ = () => { remoteBox.classList.toggle('hidden', jmode.value !== 'remote'); localBox.classList.toggle('hidden', jmode.value !== 'local'); };
    jmode.onchange = syncJ; syncJ();
    const matlabRel = select([['', t('autodetect')], ...info.matlab.installs.map((i) => [i.release, `${i.release} — ${i.exe}`])], T.matlab.release || '', (v) => upd('matlab', { release: v }));
    return [h('h3', {}, t('tools')), h('div', { class: 'cards' },
      await card('vscode', 'VS Code', t('vscodeHelp'),
        h('div', { class: 'help' }, info.vscode.found ? `✓ ${info.vscode.found}` : '✕ not found'),
        field(t('path'), input(T.vscode.command, (v) => upd('vscode', { command: v }), { placeholder: 'Code.exe / code' }))),
      await card('matlab', 'MATLAB', t('matlabHelp'),
        field(t('release'), matlabRel),
        field(t('path'), input(T.matlab.executable, (v) => upd('matlab', { executable: v }), { placeholder: 'C:\\Program Files\\MATLAB\\R2026a\\bin\\matlab.exe' })),
        checkbox(t('initSimulink'), T.matlab.initSimulink, (v) => upd('matlab', { initSimulink: v })),
        checkbox(t('shareSession'), T.matlab.shareSession !== false, (v) => upd('matlab', { shareSession: v })),
        h('button', { class: 'btn', onclick: () => { const f = S.conv?.record?.cwd || S.selFolder; if (!f) return toast(t('openFolder'), true); api('/api/tools/matlab', { folder: f, setup: true }).then((r) => toast(`MATLAB ${r.release}`)).catch(fail); } }, t('runSetup')),
        matlabMcpBox(T)),
      await card('git', 'Git', t('gitHelp'), h('div', { class: 'help' }, info.git.available ? '✓ git' : '✕ git not found'), field(t('path'), input(T.git.executable, (v) => upd('git', { executable: v }), { placeholder: 'git' }))),
      await card('bitbucket', 'Bitbucket', t('bitbucketHelp'),
        field('Type', select([['cloud', t('flavorCloud')], ['server', t('flavorServer')]], T.bitbucket.flavor, (v) => upd('bitbucket', { flavor: v }))),
        field(t('baseUrl'), input(T.bitbucket.baseUrl, (v) => upd('bitbucket', { baseUrl: v }))),
        field(t('defaultBranch'), input(T.bitbucket.defaultBranch, (v) => upd('bitbucket', { defaultBranch: v }), { placeholder: 'main' })),
        h('div', { class: 'hint' }, 'SSH: ssh-keygen -t ed25519 -C "you@example.com" → add ~/.ssh/id_ed25519.pub to Bitbucket › Personal settings › SSH keys → ssh -T git@bitbucket.org'),
        T.bitbucket.flavor === 'server' ? h('p', { class: 'help' }, t('bbServerNoMcp')) : atlassianBox('bitbucket', T)),
      await card('jira', 'Jira', t('jiraHelp'),
        atlassianBox('jira', T),
        h('details', {}, h('summary', { class: 'help', style: { cursor: 'pointer' } }, t('jiraOther')),
        field('Mode', jmode), remoteBox, localBox, field(t('token'), jtok),
        h('div', { class: 'inline' },
          h('button', { class: 'btn primary', onclick: async () => {
            try {
              const r = await api('/api/jira/configure', { mode: jmode.value, url: jurl.value, auth: jauth.value, token: jtok.value || undefined, site: jsite.value, email: jmail.value, command: jcmd.value, args: jargs.value });
              jtok.value = ''; toast(t('saved'));
              if (r.needsLogin) { await api('/api/jira/login', {}).catch(fail); }
              await loadState(false); renderTop();
            } catch (e) { fail(e); }
          } }, t('save')),
          h('button', { class: 'btn', onclick: () => api('/api/jira/login', {}).then(() => toast(t('signIn'))).catch(fail) }, t('signIn')))),
        h('details', {}, h('summary', { class: 'help', style: { cursor: 'pointer' } }, t('askManager')), h('div', { class: 'hint' }, t('jiraChecklist')), h('button', { class: 'btn small', style: { marginTop: '6px' }, onclick: () => copyText(t('jiraChecklist')), html: icon('copy') + t('copyPath').split(' ')[0] }))))];
  },

  async skills() {
    const folder = S.conv?.record?.cwd || S.selFolder || '';
    const [sk, pl] = await Promise.all([api('/api/skills' + q({ folder })).catch((e) => ({ skills: [], error: e.message })), api('/api/plugins').catch((e) => ({ marketplaces: [], error: e.message }))]);
    const src = h('input', { class: 'input', placeholder: 'https://github.com/owner/repo/tree/main/skills/name · owner/repo · C:\\path\\to\\skill', spellcheck: 'false' });
    const scope = select([['global', t('scopeGlobal')], ['folder', `${t('scopeFolder')}${folder ? ' — ' + folder : ''}`]], 'global', () => {});
    const replace = h('input', { type: 'checkbox' });
    const out = h('div');
    const mkt = h('input', { class: 'input', placeholder: 'owner/repo', spellcheck: 'false' });
    return [h('h3', {}, t('skills')),
      field(t('installFrom'), src), field(t('scope'), scope), h('label', { class: 'check' }, replace, h('span', {}, 'Replace existing (a backup is kept)')),
      h('button', { class: 'btn primary', onclick: async (e) => {
        const btn = e.currentTarget; btn.disabled = true;
        try {
          const r = await api('/api/skills/install', { source: src.value, scope: scope.value, folder, replace: replace.checked });
          if (r.kind === 'plugin') { mkt.value = r.source; toast(r.message); }
          else out.replaceChildren(h('div', { class: 'list' }, ...r.results.map((x) => h('div', { class: 'li' }, h('span', {}, x.status === 'installed' ? '✓' : '•'), h('div', { class: 'grow' }, h('div', {}, x.name), h('div', { class: 'sub' }, x.path)), h('span', { class: 'badge' }, x.status)))));
        } catch (err) { fail(err); }
        btn.disabled = false;
      } }, t('install')), out,
      h('h3', { style: { marginTop: '18px' } }, `Skills (${sk.skills.length})`),
      sk.error ? h('div', { class: 'help' }, sk.error) : null,
      h('div', { class: 'list' }, ...sk.skills.map((s) => h('div', { class: 'li' }, h('span', { html: icon('puzzle') }), h('div', { class: 'grow' }, h('div', {}, s.name), h('div', { class: 'sub' }, s.description || s.path)), h('span', { class: 'badge' }, s.scope)))),
      h('h3', { style: { marginTop: '18px' } }, 'Plugins'),
      h('div', { class: 'inline' }, field(t('addMarketplace'), mkt), h('button', { class: 'btn', style: { marginBottom: '4px' }, onclick: () => api('/api/plugins/marketplace', { source: mkt.value }).then(() => openSettings('skills')).catch(fail) }, t('add'))),
      pl.error ? h('div', { class: 'help' }, pl.error) : null,
      ...pl.marketplaces.map((m) => pluginBlock(m))];
  },

  async configToml() {
    const c = await api('/api/config').catch((e) => ({ error: e.message }));
    return [h('h3', {}, 'config.toml'), c.error ? h('div', { class: 'errorbox' }, c.error) : h('div', { class: 'list' },
      ...[['File', c.file], [t('model'), c.model], ['Provider', c.provider], [t('effort'), c.effort], ['Approval', c.approvalPolicy], ['Sandbox', c.sandbox], ['MCP', (c.mcpServers || []).map((m) => `${m.enabled ? '●' : '○'} ${m.name}`).join('   ')]].map(([k, v]) => h('div', { class: 'li' }, h('div', { style: { width: '110px', color: 'var(--muted)' } }, k), h('div', { class: 'grow' }, h('code', {}, v ?? '—'))))),
      h('p', { class: 'help', style: { marginTop: '12px' } }, t('loadTomlHelp')),
      h('button', { class: 'btn', html: icon('upload') + t('loadToml'), onclick: async () => {
        const f = await readFileAsText('.toml'); if (!f) return;
        if (!await confirmBox({ title: t('loadToml'), text: `${f.name} → ${c.file}` })) return;
        try { const r = await api('/api/config/load', { text: f.text }); toast(`${t('saved')}${r.backup ? ' · backup: ' + r.backup : ''}`); if (r.inlineSecretWarnings?.length) toast(`Literal secrets in: ${r.inlineSecretWarnings.join(', ')} — prefer ${t('keys')}.`, true); openSettings('configToml'); } catch (e) { fail(e); }
      } })];
  },

  async about() {
    const b = S.sum.brand;
    const a = await api('/api/about');
    const upd = h('div', { class: 'help' });
    const rows = [[t('version'), a.app], ['Node.js', a.node], ['Codex', a.codex || '—'], ['OS', a.platform], ['Git', a.git ? `${a.git.branch} · ${a.git.head}` : '—'], ['Data', a.dataDir], ['CODEX_HOME', a.codexHome]];
    return [h('h3', {}, b.name), h('p', { class: 'help' }, `${b.author} · ${b.copyright}`),
      h('div', { class: 'list' }, ...rows.map(([k, v]) => h('div', { class: 'li' }, h('div', { style: { width: '110px', color: 'var(--muted)' } }, k), h('div', { class: 'grow' }, h('code', {}, v))))),
      h('div', { class: 'inline', style: { marginTop: '10px' } },
        h('button', { class: 'btn', html: icon('download') + t('checkUpdates'), onclick: async () => { upd.textContent = '…'; try { const r = await api('/api/about/updates', {}); upd.replaceChildren(!r.supported ? r.message : r.error ? r.error : r.behind ? h('div', {}, t('updateAvailable', { n: r.behind }), h('pre', { class: 'codeblock' }, r.commits.join('\n')), h('code', {}, r.command)) : t('upToDate')); } catch (e) { upd.textContent = e.message; } } }),
        h('button', { class: 'btn', html: icon('download') + t('exportDiagnostics'), onclick: async () => {
          try { const d = await api('/api/diagnostics'); const blob = new Blob([JSON.stringify(d, null, 2)], { type: 'application/json' }); const url = URL.createObjectURL(blob); const link = h('a', { href: url, download: `cpm-diagnostics-${new Date().toISOString().slice(0, 10)}.json` }); document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 5000); } catch (e) { fail(e); }
        } })),
      upd, h('p', { class: 'help' }, t('diagnosticsHelp')),
      h('h3', {}, t('backups')),
      h('button', { class: 'btn', html: icon('archive') + t('createBackup'), onclick: () => api('/api/backups/create', {}).then(() => openSettings('about')).catch(fail) }),
      h('div', { class: 'list', style: { marginTop: '8px' } }, ...(a.backups.length ? a.backups.slice(0, 15).map((x) => h('div', { class: 'li' }, h('span', { html: icon('archive') }), h('div', { class: 'grow' }, h('div', {}, new Date(x.at).toLocaleString(getLang())), h('div', { class: 'sub' }, x.name)),
        h('button', { class: 'btn small', onclick: async () => { if (await confirmBox({ title: t('restoreBackup'), text: x.name })) api('/api/backups/restore', { name: x.name }).then(() => { toast(t('saved')); loadState(true); }).catch(fail); } }, t('restoreBackup')))) : [h('div', { class: 'li help' }, '—')]))];
  },
};

function pluginBlock(m) {
  const row = (p) => h('div', { class: 'li' },
    h('div', { class: 'grow' }, h('div', {}, p.name), h('div', { class: 'sub' }, p.description)),
    p.installed ? h('span', { class: 'badge' }, '✓')
      : h('button', { class: 'btn small', onclick: () => api('/api/plugins/install', { marketplacePath: m.path, pluginName: p.name }).then(() => openSettings('skills')).catch(fail) }, t('install')));
  return h('div', { style: { marginTop: '8px' } }, h('div', { class: 'gp-section', style: { margin: '6px 0' } }, m.name), h('div', { class: 'list' }, ...m.plugins.map(row)));
}

/** "Connection to the agents (MCP)" block: live status, connect, refresh. */
function mcpStatusLine(name, label) {
  const line = h('div', { class: 'mcp-status help' }, '…');
  const draw = (c) => {
    const cls = c.ok ? 'ok' : c.state === 'needs-login' || c.state === 'waiting' ? 'warn' : 'bad';
    line.className = `mcp-status ${cls}`;
    line.replaceChildren(h('span', { class: `dot ${c.ok ? 'ready' : cls === 'warn' ? 'starting' : 'error'}` }), h('span', {}, `${label || c.name || name}: ${t('mcp_' + (c.state || 'missing'))}${c.detail ? ' — ' + c.detail : ''}`),
      h('button', { class: 'copy', 'data-tip': t('refresh'), html: icon('refresh'), onclick: () => { if (c.name || name) name = c.name || name; return (label === 'MATLAB' ? api('/api/matlab/mcp/connect', {}) : api('/api/mcp/connection' + q({ name, wait: 8 }))).then(draw).catch(fail); } }));
  };
  if (name) api('/api/mcp/connection' + q({ name })).then(draw).catch(() => draw({ state: 'missing' })); else draw({ state: 'missing' });
  line.draw = draw;
  return line;
}

function atlassianBox(purpose, T) {
  const cfg = T[purpose];
  const name = purpose === 'bitbucket' ? 'atlassian-bitbucket' : (T.jira.serverName || 'atlassian');
  const modes = purpose === 'bitbucket' ? [['token', t('atlToken')], ['service', t('atlService')]] : [['oauth', t('atlOauth')], ['token', t('atlToken')], ['service', t('atlService')]];
  const mode = select(modes, cfg.mcpMode || modes[0][0], () => sync());
  const email = h('input', { class: 'input', value: cfg.email || '', placeholder: 'you@company.com', spellcheck: 'false' });
  const token = h('input', { class: 'input', type: 'password', autocomplete: 'new-password', placeholder: cfg.mcpMode && cfg.mcpMode !== 'oauth' ? '•••••• (' + t('keySaved') + ')' : '' });
  const emailF = field(t('email'), email), tokenF = field(t('atlTokenLabel'), token);
  const status = mcpStatusLine(cfg.mcpName || name);
  const notes = h('div', { class: 'help' });
  const sync = () => { emailF.classList.toggle('hidden', mode.value !== 'token'); tokenF.classList.toggle('hidden', mode.value === 'oauth'); };
  sync();
  return h('div', { class: 'mcp-box' }, h('div', { class: 'gp-section' }, t('mcpConnection')),
    h('p', { class: 'help' }, purpose === 'bitbucket' ? t('bbMcpHelp') : t('jiraMcpHelp')),
    field(t('atlAuth'), mode), emailF, tokenF,
    h('div', { class: 'inline' }, h('button', { class: 'btn primary small', onclick: async (e) => {
      const btn = e.currentTarget; btn.disabled = true; notes.textContent = '…';
      try { const r = await api('/api/atlassian/connect', { purpose, mode: mode.value, email: email.value.trim(), token: token.value.trim() || undefined }); token.value = ''; notes.textContent = r.notes.join(' · '); status.draw(r.connection); S.sum.tools = (await api('/api/state')).tools; renderTop(); }
      catch (err) { notes.textContent = err.message; }
      btn.disabled = false;
    } }, t('connect')),
      h('a', { class: 'help', href: 'https://id.atlassian.com/manage-profile/security/api-tokens', target: '_blank', rel: 'noopener noreferrer' }, `${t('getKey')} ↗`)),
    status, notes);
}

function matlabMcpBox(T) {
  const box = h('div', { class: 'mcp-box' }, h('div', { class: 'gp-section' }, t('mcpConnection')), h('div', { class: 'help' }, '…'));
  (async () => {
    let info; try { info = await api('/api/matlab/mcp'); } catch (e) { box.append(h('div', { class: 'errorbox' }, e.message)); return; }
    const status = mcpStatusLine(info.inCodex ? info.name : null, 'MATLAB');
    const notes = h('div', { class: 'help' });
    const show = (r) => { status.draw(r); notes.textContent = (r.notes || []).join(' · '); };
    // The only question: which agent(s) will use MATLAB. The server definition is copied as is.
    const picked = new Set(info.agents.length ? info.agents : ['codex']);
    const agentBox = (id, label, disabled) => h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: picked.has(id), disabled, 'data-agent': id, onchange: (e) => { e.target.checked ? picked.add(id) : picked.delete(id); } }), h('span', {}, label));
    const where = { codex: 'Codex · config.toml', claude: 'Claude Code · ~/.claude.json', imported: t('mcpImported'), json: 'JSON', binary: t('mcpDetected') };
    const srcList = info.sources.length
      ? h('div', { class: 'hint' }, ...info.sources.map((x, i) => h('div', {}, `${i === 0 ? '★ ' : ''}${where[x.from]}: ${x.command || ''} ${(x.args || []).join(' ')}`)))
      : h('div', { class: 'errorbox' }, t('mcpNotFound'));
    const connect = async (e) => {
      if (!picked.size) return toast(t('pickAgent'), true);
      const btn = e.currentTarget; btn.disabled = true; notes.textContent = '…';
      try { show(await api('/api/matlab/mcp/connect', { agents: [...picked] })); } catch (err) { notes.textContent = err.message; }
      btn.disabled = false;
    };
    const paste = h('textarea', { class: 'input', rows: 4, placeholder: '{ "mcpServers": { "matlab": { "command": "…\\\\matlab-mcp-server.exe", "args": [ … ] } } }', spellcheck: 'false' });
    const doImport = async (body) => { notes.textContent = '…'; try { show(await api('/api/matlab/mcp/import', { ...body, agents: [...picked] })); } catch (e) { notes.textContent = e.message; } };
    box.replaceChildren(h('div', { class: 'gp-section' }, t('mcpConnection')), h('p', { class: 'help' }, t('matlabMcpHelp')),
      info.askAgent ? h('div', { class: 'banner info' }, t('matlabWhichAgent')) : null,
      h('div', { class: 'field' }, h('span', {}, t('matlabAgents')), h('div', { class: 'inline' }, agentBox('codex', 'Codex'), agentBox('claude', 'Claude Code', !info.claudeInstalled))),
      h('div', { class: 'help' }, t('mcpSources')), srcList,
      checkbox(t('connectOnLaunch'), T.matlab.connectMcp !== false, (v) => api('/api/tools', { tool: 'matlab', patch: { connectMcp: v } }).then((r) => { S.sum.tools = r.tools; }).catch(fail)),
      h('div', { class: 'inline' }, h('button', { class: 'btn primary small', onclick: connect }, t('copyAndConnect'))),
      h('details', {}, h('summary', { class: 'help', style: { cursor: 'pointer' } }, t('mcpImportJson')),
        ...info.jsons.map((f) => h('button', { class: 'btn small', style: { margin: '2px 4px 2px 0' }, onclick: () => doImport({ file: f }) }, f.split(/[\\/]/).slice(-2).join('/'))),
        paste,
        h('div', { class: 'inline' }, h('button', { class: 'btn small', onclick: () => doImport({ text: paste.value }) }, t('importJson')),
          h('button', { class: 'btn small', onclick: async () => { const f = await readFileAsText('.json'); if (f) { paste.value = f.text; doImport({ text: f.text }); } } }, t('chooseFile')))),
      h('details', {}, h('summary', { class: 'help', style: { cursor: 'pointer' } }, t('matlabSetupHow')), h('pre', { class: 'hint' }, 'setupAgenticToolkit("install")\n→ 3 (Both) → Y\n→ Configure your coding agent: Y → 1 Claude Code / 3 Codex\n→ 1 Globally → 3 (Both) → all → all → Y\n\n' + t('matlabEachSession') + '\naddpath(fullfile(getenv("USERPROFILE"), ".matlab", "agentic-toolkits", "simulink"))\nsatk_initialize\nshareMATLABSession')),
      status, notes);
  })();
  return box;
}

/** "Test" button + results list for one integration (rec. 7). */
function checkPanel(tool) {
  const out = h('div', { class: 'checks' });
  const btn = h('button', { class: 'btn small', html: icon('check') + t('testConnection'), onclick: async () => {
    btn.disabled = true; out.replaceChildren(h('div', { class: 'help' }, t('checksRunning')));
    try {
      const r = await api('/api/tools/check' + q({ tool, folder: S.conv?.record?.cwd || S.selFolder || '' }));
      out.replaceChildren(...r.checks.map((c) => h('div', { class: `check-row ${c.ok === true ? 'ok' : c.ok === false ? 'bad' : 'warn'}` },
        h('span', { class: 'mark' }, c.ok === true ? '✓' : c.ok === false ? '✕' : '!'),
        h('div', { class: 'grow' }, h('strong', {}, c.name), ' ', h('span', {}, c.detail || ''),
          c.fix ? h('div', { class: 'fix' }, h('span', {}, `${t('fix')}: `), h('code', {}, c.fix), ' ', h('button', { class: 'copy', onclick: () => copyText(c.fix), html: icon('copy') })) : null))));
    } catch (e) { out.replaceChildren(h('div', { class: 'errorbox' }, e.message)); }
    btn.disabled = false;
  } });
  return h('div', { style: { marginTop: '10px' } }, btn, out);
}

// ------------------------------------------------------------------ onboarding (rec. 8)
function openOnboarding() {
  let step = 0;
  const body = h('div'), foot = h('div', { style: { display: 'flex', gap: '8px', width: '100%' } });
  const steps = [
    () => [h('h3', {}, t('onbLang')), h('div', { class: 'inline' }, ...Object.entries(LANGS).map(([k, v]) => h('button', { class: `btn ${getLang() === k ? 'primary' : ''}`, html: FLAGS[k] + esc(v.name), onclick: () => { changeLang(k); draw(); } }))),
      field(t('theme'), select([['system', t('system')], ['light', t('light')], ['dark', t('dark')]], settings().theme || 'system', (v) => { patchSettings({ theme: v }, true); applyTheme(); renderTop(); }))],
    () => [h('h3', {}, t('uiMode')), h('p', { class: 'help' }, t('simpleHelp')), h('div', { class: 'inline' }, ...[['simple', t('simpleMode')], ['pro', t('proMode')]].map(([v, l]) => h('button', { class: `btn ${(settings().uiMode || 'simple') === v ? 'primary' : ''}`, onclick: () => { patchSettings({ uiMode: v }, true); document.body.classList.toggle('mode-simple', v === 'simple'); renderAll(); draw(); } }, l)))],
    () => [h('h3', {}, t('accounts')), h('p', { class: 'help' }, t('cliAgents')), h('div', { class: 'list' }, ...['codex', 'claude'].map((id) => { const a = S.sum.agents[id]; return h('div', { class: 'li' }, h('span', { class: `dot ${a.state}` }), h('div', { class: 'grow' }, a.label), a.state === 'missing' ? h('button', { class: 'btn small primary', onclick: () => installAddon({ codex: 'codex-cli', claude: 'claude-code' }[id]) }, t('install')) : h('span', { class: 'badge' }, t('installed'))); })),
      h('p', { class: 'help', style: { marginTop: '10px' } }, t('apiProviders')), h('button', { class: 'btn', onclick: () => providerDialog(), html: icon('plus') + t('addProvider') }), h('p', { class: 'help' }, t('signInHint'))],
    () => [h('h3', {}, t('onbFolder')), h('p', { class: 'help' }, t('welcomeText')), h('button', { class: 'btn primary', html: icon('folderOpen') + t('openFolder'), onclick: openFolderFlow })],
    () => [h('h3', {}, t('onbTools')), ...['vscode', 'matlab', 'git', 'bitbucket', 'jira'].map((id) => checkbox({ vscode: 'VS Code', matlab: 'MATLAB', git: 'Git', bitbucket: 'Bitbucket', jira: 'Jira' }[id], S.sum.tools[id].enabled, (v) => api('/api/tools', { tool: id, patch: { enabled: v } }).then((r) => { S.sum.tools = r.tools; renderTop(); }).catch(fail))), h('p', { class: 'help' }, t('onbDone'))],
  ];
  const draw = () => {
    body.replaceChildren(h('div', { class: 'help' }, `${step + 1} / ${steps.length}`), ...steps[step]());
    foot.replaceChildren(h('button', { class: 'btn', style: { marginRight: 'auto' }, onclick: () => finish() }, t('close')),
      step ? h('button', { class: 'btn', onclick: () => { step--; draw(); } }, t('back')) : null,
      step < steps.length - 1 ? h('button', { class: 'btn primary', onclick: () => { step++; draw(); } }, t('next')) : h('button', { class: 'btn primary', onclick: () => finish() }, t('finish')));
  };
  const finish = () => { patchSettings({ onboarded: true }, true); S.sum.onboarded = true; m.close(); };
  const m = modal({ title: t('onboardingTitle'), cls: 'mid', body, foot, onClose: () => patchSettings({ onboarded: true }, true) });
  draw();
}

async function addModelDialog() {
  const agent = select([['codex', 'Codex'], ['claude', 'Claude Code']], 'codex', () => {});
  const label = h('input', { class: 'input', placeholder: 'GPT-5.4 (Azure)' });
  const model = h('input', { class: 'input', placeholder: 'gpt-5.4' });
  const provider = h('input', { class: 'input', placeholder: 'openai / azure / …' });
  const efforts = h('input', { class: 'input', value: 'low, medium, high, xhigh' });
  const m = modal({ title: t('addModel'), body: h('div', {}, field(t('agent'), agent), field(t('name'), label), field(t('model'), model), field('model_provider', provider), field(t('effort'), efforts, 'comma-separated')),
    foot: [h('button', { class: 'btn', onclick: () => m.close() }, t('cancel')), h('button', { class: 'btn primary', onclick: async () => {
      try { await api('/api/models/add', { label: label.value, model: model.value, provider: provider.value, efforts: efforts.value.split(',').map((s) => s.trim()).filter(Boolean), agent: agent.value }); m.close(); await loadState(false); openSettings('models'); } catch (e) { fail(e); }
    } }, t('add'))] });
}

// ------------------------------------------------------------------ live events
let es = null, esRetry = 0;
function connectEvents() {
  es?.close();
  es = new EventSource('/api/events?token=' + encodeURIComponent(TOKEN));
  es.onopen = () => { const was = S.conn; S.conn = 'ok'; esRetry = 0; if (was === 'lost') { loadState(false); if (S.conv) openConversation(S.conv.key, { quiet: true }); } };
  es.onerror = () => { esRetry++; if (esRetry >= 2 && S.conn !== 'lost') { S.conn = 'lost'; if (S.conv) renderMain(); } };
  es.onmessage = (m) => { try { onEvent(JSON.parse(m.data)); } catch (e) { console.error(e); } };
}

let stateTimer;
function softReload() { clearTimeout(stateTimer); stateTimer = setTimeout(() => loadState(false), 400); }

function onEvent(e) {
  const isActive = S.conv && e.key === S.conv.key;
  switch (e.type) {
    case 'agent.status': if (S.sum) {
      const was = S.sum.agents[e.agent]?.state; S.sum.agents[e.agent] = e.status; renderTop();
      const up = (st) => ['ready', 'idle'].includes(st);
      if (!S.conv) renderMain();
      else if (up(was) !== up(e.status.state)) { const c = document.querySelector('.composer'); if (c) { const keep = $.input?.value; c.replaceWith(renderComposer()); if (keep != null) $.input.value = keep; } }
    } break;
    case 'turn.started':
      S.phase[e.key] = 'running';
      if (isActive) { S.conv.running = true; renderMain(); }
      markRunning(e.key, true); break;
    case 'turn.ack': S.ack[e.key] = { model: e.model, effort: e.effort, provider: e.provider }; if (isActive) renderStatus(); break;
    case 'usage': if (e.key) { S.usage[e.key] = e.usage; if (isActive) renderStatus(); } break;
    case 'turn.completed':
      notifyDesktop(e.key, e.status === 'failed' ? t('notifyFailed') : t('notifyDone'));
      S.phase[e.key] = e.status === 'failed' ? 'failed' : e.status === 'interrupted' ? 'interrupted' : 'completed';
      S.turnsDone[e.key] = (S.turnsDone[e.key] || 0) + 1;
      markRunning(e.key, false);
      if (isActive) {
        S.conv.running = false;
        if (e.status === 'failed' && e.error) { S.conv.items.push({ id: 'err-' + Date.now(), kind: 'error', text: e.error }); }
        renderMain();
        setTimeout(async () => { if (S.conv?.key === e.key && !S.conv.running) { const d = await api('/api/conversation' + q({ key: e.key })).catch(() => null); if (d && S.conv?.key === e.key && !S.conv.running) { S.conv.items = d.items; S.itemIdx = new Map(d.items.map((i) => [i.id, i])); S.conv.record = d.record; S.conv.memory = d.memory; renderStream(); refreshHeader(); } } }, 600);
        if (settings().gitPanelOpen) loadGit();
      }
      softReload(); break;
    case 'item.started': case 'item.completed': if (isActive) upsertItem(e.item); break;
    case 'item.delta': if (isActive) applyDelta(e.itemId, e.field, e.delta); break;
    case 'approval.request': notifyDesktop(e.key, t('status.approval'));
      if (isActive) { S.conv.pending = [...(S.conv.pending || []).filter((p) => p.requestKey !== e.requestKey), e]; renderStream(); renderStatus(); } else toast(`${t('status.approval')} — ${convByKey().get(e.key)?.title || ''}`); break;
    case 'approval.resolved': if (isActive && S.conv.pending?.some((p) => p.requestKey === e.requestKey)) { S.conv.pending = S.conv.pending.filter((p) => p.requestKey !== e.requestKey); renderStream(); renderStatus(); } break;
    case 'error': if (isActive) toast(e.message, !e.willRetry); break;
    case 'warning': toast(e.message); break;
    case 'conversation.updated': softReload(); break;
    case 'server.shutdown': showClosed(); break;
    case 'job.update': { S.jobs = [...(S.jobs || []).filter((j) => j.id !== e.job.id), e.job]; S.onJobs?.(); if (e.job.status !== 'running') { toast(`${e.job.title}: ${e.job.status}`, e.job.status === 'failed'); S.addonsRefresh?.(); loadState(false); } break; }
    case 'addons.changed': S.addonsRefresh?.(); break;
    case 'icons.updated': S.sum.icons = e.icons; setLogos(S.sum.logos, S.sum.icons, TOKEN); renderTop(); if (S.conv || S.project) renderMain(); break;
    case 'files.changed': if (isActive && S.filesOpen) loadFiles(); break;
    case 'spec.changed': if (S.project && e.folder && S.project.folder.toLowerCase() === e.folder.toLowerCase()) openProject(S.project.folder); break;
    case 'memory.updated': if (e.key === S.conv?.key) { if (e.error) toast(e.error, true); else if (e.files?.length) toast(t('memUpdDone', { files: e.files.map((f) => f.split(/[\\/]/).pop()).join(', ') })); refreshMemoryInfo().then(() => renderMain()); } break;
    case 'mcp.connection': toast(`${e.label || e.name}: ${t('mcp_' + e.state)}${e.detail ? ' — ' + e.detail : ''}`, !e.ok && e.state !== 'needs-login' && e.state !== 'waiting'); break;
    default: break;
  }
}
function refreshHeader() { const h1 = $.main.querySelector('.conv-title h1'); if (h1 && S.conv) h1.textContent = S.conv.record.title || t('untitled'); }
function markRunning(key, v) { const c = S.sum?.conversations.find((x) => x.key === key); if (c) { c.running = v; renderTree(); } }

function showClosed() { es?.close(); window.close(); if (document.querySelector('.fullscreen-msg')) return; document.body.append(h('div', { class: 'fullscreen-msg' }, h('div', {}, h('div', { class: 'mark', style: { margin: '0 auto 12px', width: '48px', height: '48px', borderRadius: '13px', background: 'var(--accent)', color: 'var(--on-accent)', display: 'grid', placeItems: 'center' }, html: icon('logo') }), h('p', {}, t('closedWindow'))))); }

// ------------------------------------------------------------------ load & render
async function loadState(full = true) {
  try { S.sum = await api('/api/state'); } catch (e) { if (e.status === 401) return noToken(); fail(e); return; }
  setLogos(S.sum.logos, S.sum.icons, TOKEN);
  document.title = S.sum.brand.name;
  document.body.classList.toggle('mode-simple', (settings().uiMode || 'simple') === 'simple');
  if (full) { setLang(settings().lang || 'en'); applyTheme(); }
  renderTop();
  // Rebuild the Explorer only when what it shows changed (rec. 3).
  const sig = JSON.stringify([S.sum.tree, S.sum.conversations.map((c) => [c.key, c.title, c.running, c.archived, Math.floor((c.updatedAt || 0) / 60000)]), S.sum.trash.length, getLang()]);
  if (full || sig !== S.treeSig) { S.treeSig = sig; renderSidebar(); }
  if (S.conv && !S.sum.conversations.some((c) => c.key === S.conv.key)) { S.conv = null; renderMain(); }
  else if (!S.conv) renderMain();
}
async function afterChange() { await loadState(false); if (S.conv) { const k = S.conv.key; if (S.sum.conversations.some((c) => c.key === k)) await openConversation(k, { quiet: true }); else { S.conv = null; renderMain(); } } else renderMain(); }
async function reconnect() { try { await api('/api/agent/restart', { agent: 'codex' }); toast(`Codex · ${t('ready')}`); S.banner = null; await loadState(false); if (S.conv) openConversation(S.conv.key, { quiet: true }); } catch (e) { fail(e); } }
function renderAll() { renderTop(); renderSidebar(); renderMain(); renderGit(); }
function noToken() { document.getElementById('app').replaceChildren(h('div', { class: 'fullscreen-msg' }, h('div', {}, h('h2', {}, 'Codex Projects Management'), h('p', {}, 'Open the app from its launcher. (The session token is missing or expired.)')))); }

(async function main() {
  if (!TOKEN) return noToken();
  buildShell();
  await loadState(true);
  if (!S.sum) return;
  const last = settings().activeConversation;
  if (last && S.sum.conversations.some((c) => c.key === last)) await openConversation(last);
  if (settings().gitPanelOpen) loadGit();
  connectEvents();
  if (!S.sum.onboarded) openOnboarding();
  window.addEventListener('beforeunload', () => es?.close());
  // Pick up conversations created elsewhere (e.g. in a terminal) with a cheap incremental refresh.
  setInterval(() => { if (document.visibilityState === 'visible' && S.conn === 'ok') api('/api/refresh', { full: false }).then((r) => { if (r.changed) loadState(false); }).catch(() => {}); }, 60_000);
})();
