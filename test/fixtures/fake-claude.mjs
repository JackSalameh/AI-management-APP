#!/usr/bin/env node
// Minimal stand-in for the Claude Code CLI: only the `mcp` sub-commands used by the app.
import fs from 'node:fs';
import path from 'node:path';
const file = path.join(process.env.CLAUDE_CONFIG_DIR, '.claude.json');
const read = () => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; } };
const write = (j) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(j, null, 2)); };
const [cmd, sub, ...rest] = process.argv.slice(2);
if (cmd !== 'mcp') { process.stdout.write('Usage: claude [options]\n  --effort <level>  (low, medium, high, xhigh, max)\n'); process.exit(0); }
const args = rest.filter((a, i) => a !== '-s' && rest[i - 1] !== '-s');
const j = read(); j.mcpServers ||= {};
if (sub === 'remove') { delete j.mcpServers[args[0]]; write(j); process.exit(0); }
if (sub === 'add-json') { j.mcpServers[args[0]] = JSON.parse(args[1]); write(j); console.log(`Added stdio MCP server ${args[0]} to user config`); process.exit(0); }
if (sub === 'get') { const e = j.mcpServers[args[0]]; if (!e) { console.error('No MCP server found'); process.exit(1); } console.log(`${args[0]}:\n  Scope: User config\n  Status: ✓ Connected\n  Command: ${e.command}`); process.exit(0); }
process.exit(1);
