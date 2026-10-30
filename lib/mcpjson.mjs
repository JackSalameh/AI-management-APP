// MCP server definitions written in the common JSON formats, used "as is":
//   { "mcpServers": { "<name>": { … } } }   (Claude Desktop/Code, Cursor, MathWorks toolkits)
//   { "servers":    { "<name>": { … } } }   (VS Code .vscode/mcp.json)
//   { "mcp": { "servers": { … } } }          (VS Code settings.json)
//   { "command": …, "args": … } | { "url": … } (a single entry)
// Entries are converted to Codex config.toml form without changing command, args, env, cwd, url or headers,
// except that header values that look like credentials are moved to the OS keychain (env_http_headers).

export function parseMcpJson(text, nameHint = 'server') {
  let j;
  try { j = JSON.parse(String(text).replace(/^﻿/, '')); } catch (e) { throw new Error(`Not valid JSON: ${e.message}`); }
  const table = j?.mcpServers || j?.servers || j?.mcp?.servers || j?.context_servers;
  const raw = table && typeof table === 'object' ? Object.entries(table) : (j && (j.command || j.url || j.httpUrl || j.serverUrl)) ? [[nameHint, j]] : [];
  if (!raw.length) throw new Error('No MCP server found (expected "mcpServers", "servers" or a single entry with "command" or "url").');
  return raw.map(([name, e]) => {
    if (!e || typeof e !== 'object') throw new Error(`Entry "${name}" is not an object`);
    const url = e.url || e.httpUrl || e.serverUrl || null;
    const type = e.type || (url ? (/\/sse\/?$/.test(url) ? 'sse' : 'http') : 'stdio');
    if (!url && !e.command) throw new Error(`Entry "${name}" has neither "command" nor "url"`);
    return {
      name: safeName(name), type, command: e.command || null, args: Array.isArray(e.args) ? e.args.map(String) : [],
      env: e.env && typeof e.env === 'object' ? Object.fromEntries(Object.entries(e.env).map(([k, v]) => [k, String(v)])) : {},
      cwd: e.cwd || null, url, headers: e.headers && typeof e.headers === 'object' ? Object.fromEntries(Object.entries(e.headers).map(([k, v]) => [k, String(v)])) : {},
      original: e,
    };
  });
}

export function safeName(n) { return String(n).replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'server'; }

const SECRET_HEADER = /^(authorization|x-api-key|api-key|x-auth-token|cookie)$/i;
const SECRET_ENV = /(token|secret|password|api[_-]?key|auth)/i;

/**
 * Codex form of an entry. Returns { value, secrets } where secrets are { name, value } pairs to store in the
 * keychain; the config only references them (env_http_headers / env_vars), so no credential reaches config.toml.
 */
export function toCodexEntry(entry, { enabled = true } = {}) {
  const secrets = [];
  const envName = (suffix) => `MCP_${entry.name.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_${suffix.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`;
  if (entry.url) {
    const value = { url: entry.url, enabled };
    const plain = {}, fromEnv = {};
    for (const [k, v] of Object.entries(entry.headers || {})) {
      const ref = /^\$\{?([A-Z_][A-Z0-9_]*)\}?$/.exec(v.trim()) || /^(?:Bearer|Basic)\s+\$\{?([A-Z_][A-Z0-9_]*)\}?$/.exec(v.trim());
      if (ref && /^\$\{?[A-Z_]/.test(v.trim())) { fromEnv[k] = ref[1]; continue; }
      if (SECRET_HEADER.test(k)) { const n = envName(k); secrets.push({ name: n, value: v }); fromEnv[k] = n; } else plain[k] = v;
    }
    if (Object.keys(plain).length) value.http_headers = plain;
    if (Object.keys(fromEnv).length) value.env_http_headers = fromEnv;
    return { value, secrets };
  }
  const value = { command: entry.command, args: entry.args, enabled };
  const env = {}, envVars = [];
  for (const [k, v] of Object.entries(entry.env || {})) {
    if (SECRET_ENV.test(k) && v && !/^\$\{?[A-Z_]/.test(v)) { secrets.push({ name: k, value: v }); envVars.push(k); } else env[k] = v;
  }
  if (Object.keys(env).length) value.env = env;
  if (envVars.length) value.env_vars = envVars;
  if (entry.cwd) value.cwd = entry.cwd;
  return { value, secrets };
}
