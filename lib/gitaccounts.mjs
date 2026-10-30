// Git hosting accounts: who you are (user.name / user.email), how Git authenticates (HTTPS token kept in the OS
// keychain and handed to Git through a per-command credential helper, or an SSH key), and which repositories
// your account can see (to clone them in one click).
import { checkBaseUrl, HttpApiError } from './atlassian.mjs';

export const GIT_HOSTS = {
  github: { label: 'GitHub', host: 'github.com', api: process.env.CPM_GITHUB_API || 'https://api.github.com', tokenUrl: 'https://github.com/settings/tokens?type=beta', sshUrl: 'https://github.com/settings/ssh/new', user: 'x-access-token' },
  gitlab: { label: 'GitLab', host: 'gitlab.com', api: 'https://gitlab.com/api/v4', tokenUrl: 'https://gitlab.com/-/user_settings/personal_access_tokens', sshUrl: 'https://gitlab.com/-/user_settings/ssh_keys', user: 'oauth2' },
  bitbucket: { label: 'Bitbucket Cloud', host: 'bitbucket.org', api: process.env.CPM_BITBUCKET_API || 'https://api.bitbucket.org', tokenUrl: 'https://id.atlassian.com/manage-profile/security/api-tokens', sshUrl: 'https://bitbucket.org/account/settings/ssh-keys/', user: 'x-bitbucket-api-token-auth' },
  azure: { label: 'Azure DevOps', host: 'dev.azure.com', api: null, tokenUrl: 'https://dev.azure.com/', sshUrl: 'https://dev.azure.com/', user: 'pat' },
  other: { label: 'Other (company server)', host: null, api: null, tokenUrl: null, sshUrl: null, user: null },
};

export const HOST_RE = /^[a-z0-9.-]+(:\d+)?$/i;
export const secretNameFor = (id) => `GIT_TOKEN_${String(id).toUpperCase().replace(/[^A-Z0-9]/g, '_')}`.slice(0, 63);

/**
 * `-c` options that make Git use the stored token for one host, for this command only. The token is read from
 * an environment variable by the helper, so it never appears in a command line, a log or a config file.
 */
export function credentialArgs(accounts) {
  const args = [], env = {};
  accounts.forEach((a, i) => {
    if (!a.host || !a.token) return;
    const key = `credential.https://${a.host}.helper`;
    env[`CPM_GIT_U${i}`] = a.username; env[`CPM_GIT_P${i}`] = a.token;
    args.push('-c', `${key}=`, '-c', `${key}=!f() { test "$1" = get || exit 0; echo "username=$CPM_GIT_U${i}"; echo "password=$CPM_GIT_P${i}"; }; f`);
  });
  return { args, env };
}

async function get(base, path, headers) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20_000);
  try {
    const r = await fetch(base + path, { headers: { Accept: 'application/json', 'User-Agent': 'ai-management-app', ...headers }, signal: ctrl.signal });
    const raw = await r.text();
    if (!r.ok) throw new HttpApiError(r.status === 401 || r.status === 403 ? 400 : 502, `${r.status} ${raw.slice(0, 200)}${r.status === 401 ? ' — the token is wrong or expired.' : ''}`);
    return JSON.parse(raw || '{}');
  } catch (e) { if (e instanceof HttpApiError) throw e; throw new HttpApiError(502, `Cannot reach ${new URL(base).host}: ${e.cause?.code || e.message}`); } finally { clearTimeout(timer); }
}

/** Checks the token and returns the account name. */
export async function whoAmI(acc) {
  const p = GIT_HOSTS[acc.provider];
  const api = acc.apiBase ? checkBaseUrl(acc.apiBase) : p?.api;
  if (!api) return { name: acc.username || '', verified: false };
  if (acc.provider === 'github') { const u = await get(api, '/user', { Authorization: `Bearer ${acc.token}` }); return { name: u.login, verified: true }; }
  if (acc.provider === 'gitlab') { const u = await get(api, '/user', { 'PRIVATE-TOKEN': acc.token }); return { name: u.username, verified: true }; }
  if (acc.provider === 'bitbucket') { const u = await get(api, '/2.0/user', { Authorization: `Basic ${Buffer.from(`${acc.email}:${acc.token}`).toString('base64')}` }); return { name: u.username || u.display_name, verified: true }; }
  return { name: acc.username || '', verified: false };
}

/** Repositories the account can see, most recently updated first. */
export async function listRepos(acc, q = '') {
  const p = GIT_HOSTS[acc.provider];
  const api = acc.apiBase ? checkBaseUrl(acc.apiBase) : p?.api;
  const match = (n) => !q || n.toLowerCase().includes(String(q).toLowerCase());
  if (acc.provider === 'github') {
    const r = await get(api, '/user/repos?per_page=100&sort=updated&affiliation=owner,collaborator,organization_member', { Authorization: `Bearer ${acc.token}` });
    return r.filter((x) => match(x.full_name)).map((x) => ({ name: x.full_name, private: x.private, updated: x.updated_at, https: x.clone_url, ssh: x.ssh_url, web: x.html_url, defaultBranch: x.default_branch }));
  }
  if (acc.provider === 'gitlab') {
    const r = await get(api, `/projects?membership=true&order_by=last_activity_at&per_page=100${q ? `&search=${encodeURIComponent(q)}` : ''}`, { 'PRIVATE-TOKEN': acc.token });
    return r.map((x) => ({ name: x.path_with_namespace, private: x.visibility !== 'public', updated: x.last_activity_at, https: x.http_url_to_repo, ssh: x.ssh_url_to_repo, web: x.web_url, defaultBranch: x.default_branch }));
  }
  if (acc.provider === 'bitbucket') {
    const auth = { Authorization: `Basic ${Buffer.from(`${acc.email}:${acc.token}`).toString('base64')}` };
    const ws = await get(api, '/2.0/user/permissions/workspaces?pagelen=50', auth);
    const out = [];
    for (const w of (ws.values || []).slice(0, 10)) {
      const r = await get(api, `/2.0/repositories/${encodeURIComponent(w.workspace.slug)}?role=member&pagelen=50&sort=-updated_on`, auth);
      for (const x of r.values || []) if (match(x.full_name)) {
        const cl = Object.fromEntries((x.links?.clone || []).map((c) => [c.name, c.href.replace(/^https:\/\/[^@/]+@/, 'https://')]));
        out.push({ name: x.full_name, private: x.is_private, updated: x.updated_on, https: cl.https, ssh: cl.ssh, web: x.links?.html?.href, defaultBranch: x.mainbranch?.name });
      }
    }
    return out.sort((a, b) => String(b.updated).localeCompare(String(a.updated)));
  }
  throw new HttpApiError(400, `Listing repositories is not available for ${p?.label || acc.provider}; paste the clone URL instead.`);
}

/** Validates a clone URL (https or ssh form) and returns the host. */
export function parseRemote(url) {
  const u = String(url || '').trim();
  let m = /^https:\/\/(?:[^@/\s]+@)?([^/\s]+)\/\S+$/.exec(u);
  if (m) return { host: m[1].toLowerCase(), kind: 'https', url: u.replace(/^https:\/\/[^@/]+@/, 'https://') };
  m = /^(?:ssh:\/\/)?git@([^:/\s]+)[:/]\S+$/.exec(u);
  if (m) return { host: m[1].toLowerCase(), kind: 'ssh', url: u };
  // Local or network-share repositories (file://…, /srv/repo.git, D:\\repos\\x.git, \\\\server\\share\\x.git).
  if (/^file:\/\/\S+$/.test(u) || /^(\/|[A-Za-z]:[\\/]|\\\\)[^\n]*$/.test(u)) return { host: null, kind: 'local', url: u };
  throw new HttpApiError(400, 'Use an https://… or git@host:… repository address');
}
