// Direct REST access to Jira Cloud and Bitbucket Cloud with the user's own API token, so the app can list,
// read and act on issues, repositories and pull requests itself. The same credentials also feed the agents'
// Atlassian MCP connection (lib/app.mjs connectAtlassian). Tokens never leave the OS keychain except as the
// Authorization header of these requests.

const TIMEOUT = 20_000;

export class HttpApiError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

/** Only https, except loopback (tests, local proxies). */
export function checkBaseUrl(u) {
  let url; try { url = new URL(String(u || '')); } catch { throw new HttpApiError(400, 'Invalid URL'); }
  const loop = /^(127\.0\.0\.1|localhost|\[::1\])$/.test(url.hostname);
  if (url.protocol !== 'https:' && !(loop && url.protocol === 'http:')) throw new HttpApiError(400, 'The address must start with https://');
  return url.origin + url.pathname.replace(/\/+$/, '');
}

async function call(base, auth, method, p, body, { text = false } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT);
  let res;
  try {
    res = await fetch(base + p, {
      method, signal: ctrl.signal,
      headers: { Authorization: auth, Accept: text ? 'text/plain' : 'application/json', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (e) {
    throw new HttpApiError(502, e.name === 'AbortError' ? `No answer from ${new URL(base).host} after ${TIMEOUT / 1000} s` : `Cannot reach ${new URL(base).host}: ${e.cause?.code || e.message}`);
  } finally { clearTimeout(timer); }
  const raw = await res.text();
  if (!res.ok) {
    let msg = raw.slice(0, 300);
    try { const j = JSON.parse(raw); msg = j.errorMessages?.join(' ') || Object.values(j.errors || {}).join(' ') || j.error?.message || j.message || msg; } catch { /* not JSON */ }
    const hint = res.status === 401 ? ' — check the e-mail and API token (Configuration › Connections).' : res.status === 403 ? ' — your token lacks the permission (scope) for this action.' : '';
    throw new HttpApiError(res.status === 401 || res.status === 403 ? 400 : 502, `${res.status} ${msg}${hint}`);
  }
  if (text) return raw;
  return raw ? JSON.parse(raw) : {};
}

/** Atlassian Document Format → plain text (paragraphs, lists, code, mentions). */
export function adfToText(node) {
  if (!node) return '';
  if (typeof node === 'string') return node;
  const kids = (node.content || []).map(adfToText);
  switch (node.type) {
    case 'text': return node.text || '';
    case 'hardBreak': return '\n';
    case 'mention': return node.attrs?.text || '@user';
    case 'emoji': return node.attrs?.text || '';
    case 'paragraph': case 'heading': return kids.join('') + '\n';
    case 'listItem': return '• ' + kids.join('').trim() + '\n';
    case 'codeBlock': return '```\n' + kids.join('') + '\n```\n';
    case 'inlineCard': return node.attrs?.url || '';
    default: return kids.join('');
  }
}
export const textToAdf = (t) => ({ type: 'doc', version: 1, content: String(t || '').split(/\n{2,}/).map((p) => ({ type: 'paragraph', content: p ? [{ type: 'text', text: p }] : [] })) });

// ------------------------------------------------------------------ Jira Cloud (REST v3)
const ISSUE_FIELDS = ['summary', 'status', 'priority', 'assignee', 'updated', 'issuetype', 'project'];
const slimIssue = (i, site) => ({
  key: i.key, id: i.id, summary: i.fields?.summary || '', status: i.fields?.status?.name || '', statusCategory: i.fields?.status?.statusCategory?.key || '',
  priority: i.fields?.priority?.name || '', assignee: i.fields?.assignee?.displayName || '', type: i.fields?.issuetype?.name || '',
  project: i.fields?.project?.key || '', updated: i.fields?.updated || '', url: `${site}/browse/${i.key}`,
});

export class JiraClient {
  constructor(site, auth) { this.site = checkBaseUrl(site); this.auth = auth; }
  #c(m, p, b) { return call(this.site, this.auth, m, p, b); }
  async myself() { const u = await this.#c('GET', '/rest/api/3/myself'); return { accountId: u.accountId, name: u.displayName, email: u.emailAddress || null }; }
  async search(jql, max = 50) {
    const r = await this.#c('POST', '/rest/api/3/search/jql', { jql, fields: ISSUE_FIELDS, maxResults: Math.min(+max || 50, 100) });
    return (r.issues || []).map((i) => slimIssue(i, this.site));
  }
  async issue(key) {
    if (!/^[A-Z][A-Z0-9_]+-\d+$/.test(key)) throw new HttpApiError(400, 'Issue key like PROJ-123');
    const i = await this.#c('GET', `/rest/api/3/issue/${key}?fields=${[...ISSUE_FIELDS, 'description', 'comment', 'subtasks', 'reporter', 'labels'].join(',')}`);
    const [tr] = await Promise.all([this.#c('GET', `/rest/api/3/issue/${key}/transitions`).catch(() => ({ transitions: [] }))]);
    return {
      ...slimIssue(i, this.site), description: adfToText(i.fields?.description).trim(), reporter: i.fields?.reporter?.displayName || '', labels: i.fields?.labels || [],
      subtasks: (i.fields?.subtasks || []).map((s) => ({ key: s.key, summary: s.fields?.summary, status: s.fields?.status?.name })),
      comments: (i.fields?.comment?.comments || []).slice(-30).map((c) => ({ id: c.id, author: c.author?.displayName || '', created: c.created, text: adfToText(c.body).trim() })),
      transitions: (tr.transitions || []).map((t) => ({ id: t.id, name: t.name, to: t.to?.name || '' })),
    };
  }
  async comment(key, text) { if (!String(text || '').trim()) throw new HttpApiError(400, 'Comment is empty'); await this.#c('POST', `/rest/api/3/issue/${key}/comment`, { body: textToAdf(text) }); return { ok: true }; }
  async transition(key, id) { if (!/^\d+$/.test(String(id))) throw new HttpApiError(400, 'Choose a status'); await this.#c('POST', `/rest/api/3/issue/${key}/transitions`, { transition: { id: String(id) } }); return { ok: true }; }
  async assignToMe(key) { const me = await this.myself(); await this.#c('PUT', `/rest/api/3/issue/${key}/assignee`, { accountId: me.accountId }); return { ok: true }; }
  async projects() { const r = await this.#c('GET', '/rest/api/3/project/search?maxResults=100&orderBy=lastIssueUpdatedTime'); return (r.values || []).map((p) => ({ key: p.key, name: p.name })); }
  async create({ project, summary, type = 'Task', description }) {
    if (!/^[A-Z][A-Z0-9_]+$/.test(project || '')) throw new HttpApiError(400, 'Choose a project');
    if (!String(summary || '').trim()) throw new HttpApiError(400, 'Summary is required');
    const r = await this.#c('POST', '/rest/api/3/issue', { fields: { project: { key: project }, summary: String(summary).trim().slice(0, 250), issuetype: { name: type }, ...(description ? { description: textToAdf(description) } : {}) } });
    return { key: r.key, url: `${this.site}/browse/${r.key}` };
  }
}

// ------------------------------------------------------------------ Bitbucket Cloud (REST 2.0)
const slimRepo = (r) => ({
  slug: r.slug, name: r.name, fullName: r.full_name, workspace: r.workspace?.slug || r.full_name?.split('/')[0], private: !!r.is_private,
  updated: r.updated_on, mainBranch: r.mainbranch?.name || null, description: r.description || '', url: r.links?.html?.href || '',
  clone: Object.fromEntries((r.links?.clone || []).map((c) => [c.name, c.href.replace(/^https:\/\/[^@/]+@/, 'https://')])),
});
const slimPr = (p) => ({
  id: p.id, title: p.title, state: p.state, author: p.author?.display_name || '', source: p.source?.branch?.name || '', destination: p.destination?.branch?.name || '',
  updated: p.updated_on, comments: p.comment_count || 0, url: p.links?.html?.href || '', description: p.description || '',
  approvals: (p.participants || []).filter((x) => x.approved).map((x) => x.user?.display_name),
});
const SLUG = /^[A-Za-z0-9_.-]{1,100}$/;
const slug = (v, what) => { if (!SLUG.test(String(v || ''))) throw new HttpApiError(400, `Invalid ${what}`); return v; };

export class BitbucketClient {
  constructor(auth, base = process.env.CPM_BITBUCKET_API || 'https://api.bitbucket.org') { this.base = checkBaseUrl(base); this.auth = auth; }
  #c(m, p, b, o) { return call(this.base, this.auth, m, p, b, o); }
  async user() { const u = await this.#c('GET', '/2.0/user'); return { name: u.display_name, username: u.username || u.nickname, accountId: u.account_id }; }
  async workspaces() { const r = await this.#c('GET', '/2.0/user/permissions/workspaces?pagelen=100'); return (r.values || []).map((v) => ({ slug: v.workspace?.slug, name: v.workspace?.name })).filter((w) => w.slug); }
  async repos(ws, q) {
    const query = q ? `&q=${encodeURIComponent(`name ~ "${String(q).replace(/"/g, '')}"`)}` : '';
    const r = await this.#c('GET', `/2.0/repositories/${slug(ws, 'workspace')}?role=member&pagelen=50&sort=-updated_on${query}`);
    return (r.values || []).map(slimRepo);
  }
  async pullRequests(ws, repo, state = 'OPEN') {
    if (!['OPEN', 'MERGED', 'DECLINED'].includes(state)) state = 'OPEN';
    const r = await this.#c('GET', `/2.0/repositories/${slug(ws, 'workspace')}/${slug(repo, 'repository')}/pullrequests?state=${state}&pagelen=50`);
    return (r.values || []).map(slimPr);
  }
  async pullRequest(ws, repo, id) {
    const p = `/2.0/repositories/${slug(ws, 'workspace')}/${slug(repo, 'repository')}/pullrequests/${+id}`;
    const [pr, diff] = await Promise.all([this.#c('GET', p), this.#c('GET', `${p}/diff`, undefined, { text: true }).catch(() => '')]);
    return { ...slimPr(pr), diff: diff.slice(0, 400_000) };
  }
  async createPullRequest(ws, repo, { title, source, destination, description }) {
    if (!String(title || '').trim()) throw new HttpApiError(400, 'Title is required');
    const r = await this.#c('POST', `/2.0/repositories/${slug(ws, 'workspace')}/${slug(repo, 'repository')}/pullrequests`, {
      title: String(title).trim(), description: description || '', source: { branch: { name: String(source) } }, ...(destination ? { destination: { branch: { name: String(destination) } } } : {}), close_source_branch: true,
    });
    return slimPr(r);
  }
  async prAction(ws, repo, id, action, text) {
    const p = `/2.0/repositories/${slug(ws, 'workspace')}/${slug(repo, 'repository')}/pullrequests/${+id}`;
    if (action === 'approve') await this.#c('POST', `${p}/approve`, {});
    else if (action === 'unapprove') await this.#c('DELETE', `${p}/approve`);
    else if (action === 'comment') { if (!String(text || '').trim()) throw new HttpApiError(400, 'Comment is empty'); await this.#c('POST', `${p}/comments`, { content: { raw: String(text) } }); }
    else if (action === 'merge') await this.#c('POST', `${p}/merge`, { merge_strategy: 'merge_commit', close_source_branch: true });
    else if (action === 'decline') await this.#c('POST', `${p}/decline`, {});
    else throw new HttpApiError(400, 'Unknown action');
    return { ok: true };
  }
}
