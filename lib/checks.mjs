// Integration self-tests shown in each configuration card: detection, authentication and connectivity,
// each with an actionable fix. Every check is bounded by a timeout and never prints secrets.
import os from 'node:os';
import { run, which } from './proc.mjs';
import { findVSCode, pickMatlab, findMatlabInstalls } from './tools.mjs';

const ok = (name, detail) => ({ name, ok: true, detail });
const ko = (name, detail, fix) => ({ name, ok: false, detail, fix });
const warn = (name, detail, fix) => ({ name, ok: null, detail, fix });

export async function checkTool(app, tool, { folder } = {}) {
  const cfg = app.s.tools[tool] || {};
  const out = [];
  switch (tool) {
    case 'codex': {
      const a = app.agents.codex;
      const bin = a.findBinary();
      out.push(bin ? ok('Codex CLI', bin) : ko('Codex CLI', 'not found', 'npm install -g @openai/codex'));
      out.push(a.state === 'ready' ? ok('app-server', `v${a.version || '?'} · ${a.codexHome}`) : ko('app-server', a.lastError || a.state, 'Press Reconnect'));
      if (a.state === 'ready') {
        try {
          const r = await a.rpc('account/read', {}, 10_000);
          const acc = r?.account;
          out.push(acc ? ok('Sign-in', acc.email || acc.type || 'signed in') : r?.requiresOpenaiAuth === false ? ok('Sign-in', 'custom provider (API key from environment)') : warn('Sign-in', 'not signed in', 'Run “codex login” once in a terminal, or save your provider key under Configuration › API keys'));
        } catch (e) { out.push(warn('Sign-in', e.message)); }
        try { const m = await a.listModels(); out.push(ok('Models', `${m.length} available`)); } catch (e) { out.push(ko('Models', e.message)); }
      }
      break;
    }
    case 'vscode': {
      const exe = findVSCode(cfg.command);
      out.push(exe ? ok('Executable', exe) : ko('Executable', 'not found', 'Install VS Code or set the path to Code.exe'));
      if (exe && !/\.exe$/i.test(exe)) { const r = await run(exe, ['--version'], { timeout: 15_000 }); out.push(r.ok ? ok('Version', r.stdout.split('\n')[0]) : warn('Version', (r.stderr || r.error || '').slice(0, 160))); }
      break;
    }
    case 'matlab': {
      const inst = pickMatlab(cfg);
      const all = findMatlabInstalls();
      out.push(inst ? ok('Executable', `${inst.release} — ${inst.exe}`) : ko('Executable', 'no MATLAB found', 'Set the MATLAB executable path'));
      if (cfg.release && !all.some((i) => i.release.toLowerCase() === cfg.release.toLowerCase())) out.push(ko('Release', `${cfg.release} not installed (found: ${all.map((i) => i.release).join(', ') || 'none'})`, 'Choose an installed release'));
      const sum = await app.configSummary().catch(() => null);
      const mcp = sum?.mcpServers.find((s) => s.name === (cfg.mcpServer || 'matlab'));
      out.push(mcp ? (mcp.enabled ? ok('MATLAB MCP server', mcp.command || mcp.url) : warn('MATLAB MCP server', 'present but disabled', 'Tick MATLAB to enable it')) : warn('MATLAB MCP server', 'not configured', 'Run “Run Agentic Toolkit setup” in this card'));
      break;
    }
    case 'git': {
      const exe = cfg.executable || 'git';
      const v = await run(exe, ['--version'], { timeout: 10_000 });
      out.push(v.ok ? ok('Git', v.stdout.trim()) : ko('Git', 'not found', 'Install Git (Windows: Git for Windows, includes Git Bash)'));
      if (v.ok) {
        const n = await run(exe, ['config', '--global', 'user.name']); const e = await run(exe, ['config', '--global', 'user.email']);
        out.push(n.stdout.trim() && e.stdout.trim() ? ok('Identity', `${n.stdout.trim()} <${e.stdout.trim()}>`) : ko('Identity', 'user.name / user.email not set', 'git config --global user.name "Your Name" && git config --global user.email "you@example.com"'));
        const h = await run(exe, ['config', '--global', 'credential.helper']);
        out.push(h.stdout.trim() ? ok('Credential helper', h.stdout.trim()) : warn('Credential helper', 'none (HTTPS will prompt every time)', 'Git for Windows installs Git Credential Manager; or use SSH keys'));
        if (folder) { const r = await run(exe, ['rev-parse', '--show-toplevel'], { cwd: folder }); out.push(r.ok ? ok('Repository', r.stdout.trim()) : warn('Repository', 'current folder is not a repository', 'Use “Initialise repository” in the Git panel')); }
      }
      break;
    }
    case 'bitbucket': {
      const host = cfg.flavor === 'server' && cfg.baseUrl ? new URL(cfg.baseUrl).hostname : 'bitbucket.org';
      if (which('ssh')) {
        const r = await run('ssh', ['-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', '-o', 'StrictHostKeyChecking=accept-new', `git@${host}`], { timeout: 15_000 });
        const txt = (r.stdout + r.stderr).trim();
        if (/authenticated|logged in as|You can use git/i.test(txt)) out.push(ok('SSH key', txt.split('\n').pop().slice(0, 160)));
        else if (/Permission denied/i.test(txt)) out.push(ko('SSH key', 'Bitbucket refused the key', `ssh-keygen -t ed25519 -C "you@example.com", then add ${os.homedir().replace(/\\/g, '/')}/.ssh/id_ed25519.pub in Bitbucket › Personal settings › SSH keys`));
        else out.push(warn('SSH', txt.slice(0, 160) || 'no answer', 'Check network/VPN, or use HTTPS'));
      } else out.push(warn('SSH', 'ssh not found', 'Use Git Bash or install OpenSSH'));
      if (folder) {
        const rem = await run(cfg.gitExe || 'git', ['remote', 'get-url', 'origin'], { cwd: folder });
        if (rem.ok) {
          const lr = await run('git', ['ls-remote', '--heads', 'origin'], { cwd: folder, timeout: 20_000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
          out.push(lr.ok ? ok('Remote access', rem.stdout.trim()) : ko('Remote access', (lr.stderr || '').trim().split('\n').pop()?.slice(0, 160), 'Check SSH key or sign in once with “git fetch” in Git Bash'));
        } else out.push(warn('Remote', 'no “origin” remote in this folder', 'Git panel › Add remote'));
      }
      break;
    }
    case 'jira': {
      const sum = await app.configSummary().catch(() => null);
      const mcp = sum?.mcpServers.find((s) => s.name === (cfg.serverName || 'jira'));
      out.push(mcp ? ok('MCP entry', `${mcp.name} → ${mcp.url || mcp.command}${mcp.enabled ? '' : ' (disabled)'}`) : ko('MCP entry', 'not configured', 'Fill in this card and press Save'));
      if (mcp) {
        const names = (await app.secrets.list()).map((s) => s.name);
        if (cfg.mode === 'local') out.push(names.includes('JIRA_API_TOKEN') ? ok('API token', 'stored') : ko('API token', 'missing', 'Paste the token in this card and press Save'));
        if (cfg.mode === 'remote' && cfg.auth === 'bearer') out.push(names.includes('JIRA_MCP_TOKEN') ? ok('Bearer token', 'stored') : ko('Bearer token', 'missing'));
        try {
          const st = await app.agents.codex.mcpStatus();
          const s = (Array.isArray(st) ? st : []).find((x) => x.name === mcp.name);
          if (s) out.push(s.toolsError ? ko('Connection', s.toolsError, 'Check the URL, then Sign in') : ok('Connection', `${Object.keys(s.tools || {}).length} tools · auth: ${s.authStatus?.type || s.authStatus || '?'}`));
          else out.push(warn('Connection', 'not started yet', 'Press Reconnect, then test again'));
        } catch (e) { out.push(warn('Connection', e.message)); }
      }
      break;
    }
    default: out.push(ko('Unknown tool', tool));
  }
  return out;
}
