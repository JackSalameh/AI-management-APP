// Official tool icons are not shipped with the app. On request, each vendor's own website icon is
// downloaded to the user's data folder (or the user uploads an image). Served with a sandbox CSP so a
// downloaded SVG can never run script in the app's origin.
import fsp from 'node:fs/promises';
import path from 'node:path';
import { listZip, readEntry, pickLogomark } from './unzip.mjs';

export const ICON_SOURCES = {
  vscode: 'https://code.visualstudio.com/',
  git: 'https://git-scm.com/',
  matlab: 'https://www.mathworks.com/products/matlab.html',
  jira: 'https://jira.atlassian.com/',
  bitbucket: 'https://bitbucket.org/',
  codex: 'https://openai.com/',
  claude: 'https://claude.ai/',
};
// Official image files tried before the page icon (brand/download pages of each vendor).
// Official logo packs (ZIP) published by the vendor; the isolated logomark is extracted.
// Source: https://atlassian.design/foundations/logos (app logos include isolated logomarks).
export const ICON_ZIPS = {
  bitbucket: ['https://atlassian.design/assets/c0c41a4db0da/logos/bitbucket_app.zip'],
  jira: ['https://atlassian.design/assets/c0c41a4db0da/logos/jira_app.zip'],
};
// Bump when the sources above change, so already-downloaded icons are fetched again once.
export const ICON_SET_VERSION = 2;
export const ICON_DIRECT = {
  vscode: ['https://code.visualstudio.com/assets/branding/code-stable.png'],
  git: ['https://git-scm.com/images/logos/downloads/Git-Icon-1788C.svg', 'https://git-scm.com/images/logos/downloads/Git-Icon-1788C.png'],
};
const EXT = { 'image/svg+xml': '.svg', 'image/png': '.png', 'image/x-icon': '.ico', 'image/vnd.microsoft.icon': '.ico', 'image/jpeg': '.jpg', 'image/webp': '.webp' };
export const ICON_MIME = Object.fromEntries(Object.entries(EXT).map(([m, e]) => [e, m]));

/** Picks the best icon link from a page: SVG first, then the largest PNG/apple-touch icon, then /favicon.ico. */
export function pickIconLinks(html, pageUrl) {
  const links = [];
  for (const m of String(html).matchAll(/<link\b[^>]*>/gi)) {
    const tag = m[0];
    const rel = /rel\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1]?.toLowerCase() || '';
    const href = /href\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1];
    if (!href || !/(^|\s)(icon|shortcut icon|apple-touch-icon|mask-icon)(\s|$)/.test(rel)) continue;
    const sizes = /sizes\s*=\s*["'](\d+)x\d+["']/i.exec(tag)?.[1];
    const type = /type\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1] || '';
    let url; try { url = new URL(href, pageUrl).href; } catch { continue; }
    const svg = /svg/.test(type) || /\.svg(\?|$)/i.test(url);
    links.push({ url, score: (svg && !/mask-icon/.test(rel) ? 10000 : 0) + (+sizes || (/apple-touch/.test(rel) ? 180 : 32)) });
  }
  links.sort((a, b) => b.score - a.score);
  links.push({ url: new URL('/favicon.ico', pageUrl).href, score: 0 });
  return links.map((l) => l.url);
}

/** pages: optional override, e.g. the user's own Jira site (its icon is the Jira logo). */
export async function downloadIcon(tool, dir, { page: pageOverride } = {}) {
  const page = pageOverride || ICON_SOURCES[tool];
  if (!page) throw new Error('Unknown tool');
  let html = '';
  try { const r = await fetch(page, { signal: AbortSignal.timeout(12_000), headers: { 'user-agent': 'Mozilla/5.0 AI-Management-App' } }); html = await r.text(); } catch { /* fall back to /favicon.ico */ }
  if (!pageOverride) for (const zipUrl of ICON_ZIPS[tool] || []) {
    try {
      const r = await fetch(zipUrl, { signal: AbortSignal.timeout(20_000) });
      if (!r.ok) continue;
      const buf = Buffer.from(await r.arrayBuffer());
      const entry = pickLogomark(listZip(buf));
      if (!entry) continue;
      const ext = path.extname(entry.name).toLowerCase();
      await fsp.mkdir(dir, { recursive: true });
      for (const e of new Set(Object.values(EXT))) await fsp.rm(path.join(dir, tool + e), { force: true });
      await fsp.writeFile(path.join(dir, tool + ext), readEntry(buf, entry));
      return { tool, file: tool + ext, from: `${zipUrl}#${entry.name}` };
    } catch { /* fall back to the next source */ }
  }
  for (const url of [...(pageOverride ? [] : ICON_DIRECT[tool] || []), ...pickIconLinks(html, page)]) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(12_000) });
      if (!r.ok) continue;
      const type = (r.headers.get('content-type') || '').split(';')[0].trim();
      const ext = EXT[type] || path.extname(new URL(url).pathname).toLowerCase();
      if (!Object.values(EXT).includes(ext)) continue;
      const buf = Buffer.from(await r.arrayBuffer());
      if (!buf.length || buf.length > 1_000_000) continue;
      await fsp.mkdir(dir, { recursive: true });
      for (const e of new Set(Object.values(EXT))) await fsp.rm(path.join(dir, tool + e), { force: true });
      const name = `${tool}${ext}`;
      await fsp.writeFile(path.join(dir, name), buf);
      return { tool, file: name, from: url };
    } catch { /* try next */ }
  }
  throw new Error(`No icon could be downloaded for ${tool} (${page}). You can upload one instead.`);
}

export async function saveUploadedIcon(tool, name, base64, dir) {
  if (!/^[a-z]+$/.test(tool)) throw new Error('Invalid tool');
  const ext = path.extname(String(name)).toLowerCase();
  if (!Object.values(EXT).includes(ext)) throw new Error('Use an SVG, PNG, ICO, JPG or WebP image');
  const buf = Buffer.from(String(base64), 'base64');
  if (!buf.length || buf.length > 1_000_000) throw new Error('Image must be smaller than 1 MB');
  await fsp.mkdir(dir, { recursive: true });
  for (const e of new Set(Object.values(EXT))) await fsp.rm(path.join(dir, tool + e), { force: true });
  await fsp.writeFile(path.join(dir, tool + ext), buf);
  return { tool, file: tool + ext };
}
