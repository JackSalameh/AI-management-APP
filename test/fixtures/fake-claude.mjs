#!/usr/bin/env node
// Minimal stand-in for the Claude Code CLI: only the `mcp` sub-commands used by the app.
import fs from 'node:fs';
import path from 'node:path';
const file = path.join(process.env.CLAUDE_CONFIG_DIR, '.claude.json');
const read = () => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; } };
const write = (j) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(j, null, 2)); };
const [cmd, sub, ...rest] = process.argv.slice(2);
// `claude auth status --json` / `claude auth login` (signed-in state kept in a marker file)
const marker = path.join(process.env.CLAUDE_CONFIG_DIR, '.fake-signed-in');
if (cmd === 'auth' && sub === 'status') { const on = fs.existsSync(marker); console.log(JSON.stringify(on ? { loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty' } : { loggedIn: false, authMethod: 'none' })); process.exit(on ? 0 : 1); }
if (cmd === 'auth' && sub === 'login') { fs.mkdirSync(path.dirname(marker), { recursive: true }); fs.writeFileSync(marker, rest.join(' ')); console.log('Login successful.'); process.exit(0); }
// `claude -p --output-format stream-json …`: one turn; the reply reports the gateway variables it was given.
if (process.argv.includes('-p')) {
  let input = ''; process.stdin.setEncoding('utf8');
  for await (const d of process.stdin) input += d;
  const argv = process.argv; const model = argv.includes('--model') ? argv[argv.indexOf('--model') + 1] : '-';
  const e = process.env;
  const text = `BASE=${e.ANTHROPIC_BASE_URL || '-'} TOKEN=${e.ANTHROPIC_AUTH_TOKEN || '-'} MODEL=${e.ANTHROPIC_MODEL || '-'} ARG=${model} DISCOVERY=${e.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY || '-'} IN=${input.trim().split('\n').pop()}`;
  const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
  out({ type: 'assistant', message: { id: 'msg-1', role: 'assistant', model, content: [{ type: 'text', text }] } });
  out({ type: 'result', is_error: false, usage: { input_tokens: 5, output_tokens: 7, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } });
  process.exit(0);
}
if (cmd !== 'mcp') { process.stdout.write('Usage: claude [options]\n  --effort <level>  (low, medium, high, xhigh, max)\n'); process.exit(0); }
const args = rest.filter((a, i) => a !== '-s' && rest[i - 1] !== '-s');
const j = read(); j.mcpServers ||= {};
if (sub === 'remove') { delete j.mcpServers[args[0]]; write(j); process.exit(0); }
if (sub === 'add-json') { j.mcpServers[args[0]] = JSON.parse(args[1]); write(j); console.log(`Added stdio MCP server ${args[0]} to user config`); process.exit(0); }
if (sub === 'get') { const e = j.mcpServers[args[0]]; if (!e) { console.error('No MCP server found'); process.exit(1); } console.log(`${args[0]}:\n  Scope: User config\n  Status: ✓ Connected\n  Command: ${e.command}`); process.exit(0); }
process.exit(1);
