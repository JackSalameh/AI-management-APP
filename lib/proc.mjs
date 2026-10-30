// Process helpers: executable discovery and safe spawning on Windows, macOS and Linux.
import { spawn, execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const isWin = process.platform === 'win32';

/** Finds an executable on PATH (honours PATHEXT on Windows). Returns an absolute path or null. */
export function which(cmd, env = process.env) {
  if (!cmd) return null;
  if (path.isAbsolute(cmd) || cmd.includes('/') || cmd.includes('\\')) return fileExists(cmd) ? cmd : null;
  const dirs = (env.PATH || env.Path || '').split(path.delimiter).filter(Boolean);
  const exts = isWin ? (env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').map((e) => e.toLowerCase()) : [''];
  for (const d of dirs) {
    for (const e of (isWin && path.extname(cmd) ? [''] : exts)) {
      const p = path.join(d, cmd + e);
      if (fileExists(p)) return p;
    }
  }
  return null;
}

export function fileExists(p) {
  try { return fs.statSync(p).isFile(); } catch { return false; }
}

/**
 * Turns a launcher into something `spawn` can run without a shell.
 * Since Node 20 (CVE-2024-27980) `.cmd`/`.bat` files cannot be spawned without `shell: true`.
 * For npm shims we run the package's JS entry with the current Node instead (bug #11 of v1).
 * Returns { command, prefixArgs, shell }.
 */
export function resolveLaunch(exePath, { npmPackage, jsEntry } = {}) {
  if (!exePath) return null;
  const ext = path.extname(exePath).toLowerCase();
  if (isWin && (ext === '.cmd' || ext === '.bat' || ext === '.ps1' || ext === '')) {
    if (npmPackage && jsEntry) {
      const dir = path.dirname(exePath);
      const candidates = [
        path.join(dir, 'node_modules', ...npmPackage.split('/'), jsEntry),
        path.join(dir, '..', 'lib', 'node_modules', ...npmPackage.split('/'), jsEntry),
      ];
      for (const c of candidates) if (fileExists(c)) return { command: process.execPath, prefixArgs: [c], shell: false };
    }
    if (ext === '.cmd' || ext === '.bat') return { command: exePath, prefixArgs: [], shell: true };
  }
  return { command: exePath, prefixArgs: [], shell: false };
}

/** Quote one argument for cmd.exe when shell:true is unavoidable. Rejects characters cmd cannot escape safely. */
export function quoteCmdArg(a) {
  const s = String(a);
  if (/["%!^&|<>\r\n]/.test(s)) throw new Error(`Unsupported character in argument for a Windows shell launch: ${s}`);
  return /[\s()]/.test(s) || s === '' ? `"${s}"` : s;
}

export function spawnResolved(launch, args, opts = {}) {
  if (launch.shell) {
    const line = [quoteCmdArg(launch.command), ...[...launch.prefixArgs, ...args].map(quoteCmdArg)].join(' ');
    return spawn(line, { ...opts, shell: true, windowsHide: true });
  }
  return spawn(launch.command, [...launch.prefixArgs, ...args], { ...opts, windowsHide: true });
}

/** Runs a command and collects output. Never uses a shell. */
export function run(cmd, args, { cwd, env, timeout = 60_000, input, maxBuffer = 20 * 1024 * 1024 } = {}) {
  return new Promise((resolve) => {
    const child = execFile(cmd, args, { cwd, env, timeout, maxBuffer, windowsHide: true, encoding: 'utf8' }, (error, stdout, stderr) => {
      resolve({ ok: !error, code: error ? (typeof error.code === 'number' ? error.code : 1) : 0, stdout: stdout || '', stderr: stderr || '', error: error && !stderr ? error.message : null });
    });
    if (input != null) { child.stdin.end(input); }
  });
}

/** Starts a GUI program detached from the server so closing the app does not close it. */
export function launchDetached(launch, args, opts = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try { child = spawnResolved(launch, args, { ...opts, detached: true, stdio: 'ignore' }); } catch (e) { reject(e); return; }
    child.once('error', reject);
    child.once('spawn', () => { child.unref(); resolve(child.pid); });
  });
}

/** Opens a URL or a folder with the OS default handler. */
/** Runs a resolved launch (shell only when the Windows .cmd shim requires it) and collects its output. */
export function runResolved(launch, args, { timeout = 30_000, env } = {}) {
  return new Promise((resolve) => {
    let out = '', err = '', done = false;
    const child = spawnResolved(launch, args, { env: env || process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    const finish = (code) => { if (done) return; done = true; clearTimeout(timer); resolve({ ok: code === 0, code, stdout: out, stderr: err }); };
    const timer = setTimeout(() => { try { child.kill(); } catch { /* gone */ } finish(124); }, timeout);
    child.stdout.on('data', (d) => { out += d; }); child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => { err += e.message; finish(1); });
    child.on('close', (code) => finish(code ?? 1));
  });
}

/**
 * Opens a visible terminal window that runs one command (for interactive sign-ins such as `claude auth login`).
 * Arguments are fixed strings from the app; paths are checked for characters a shell could interpret.
 * CPM_TERMINAL_INLINE=1 (tests) runs the command directly, without a window.
 */
export function openInTerminal(launch, args, title = 'AI Management APP') {
  const parts = [launch.command, ...launch.prefixArgs, ...args];
  for (const p of parts) if (/["%!^&|<>`$\r\n]/.test(String(p))) throw new Error(`Unsupported character in: ${p}`);
  if (process.env.CPM_TERMINAL_INLINE === '1') return launchDetached({ command: launch.command, prefixArgs: launch.prefixArgs, shell: false }, args);
  if (isWin) {
    const q = (x) => (/[\s()]/.test(x) ? `"${x}"` : x);
    const line = `/c start "${title.replace(/"/g, '')}" cmd /k "${parts.map(q).join(' ')}"`;
    return new Promise((resolve, reject) => {
      const c = spawn('cmd.exe', [line], { windowsVerbatimArguments: true, detached: true, stdio: 'ignore', windowsHide: false });
      c.on('error', reject); c.unref(); resolve();
    });
  }
  const sh = parts.map((x) => `'${String(x).replace(/'/g, "'\\''")}'`).join(' ');
  if (process.platform === 'darwin') return launchDetached({ command: 'osascript', prefixArgs: [], shell: false }, ['-e', `tell application "Terminal" to do script "${sh.replace(/"/g, '\\"')}"`, '-e', 'tell application "Terminal" to activate']);
  for (const term of [['x-terminal-emulator', '-e'], ['gnome-terminal', '--'], ['konsole', '-e'], ['xterm', '-e']]) {
    if (which(term[0])) return launchDetached({ command: term[0], prefixArgs: [], shell: false }, [term[1], 'bash', '-lc', `${sh}; exec bash`]);
  }
  throw new Error(`No terminal found. Run this in a terminal: ${parts.join(' ')}`);
}

export function openExternal(target) {
  if (process.env.CPM_NO_BROWSER === '1') return Promise.resolve(); // tests
  if (isWin) return launchDetached({ command: 'rundll32.exe', prefixArgs: [], shell: false }, ['url.dll,FileProtocolHandler', target]);
  if (process.platform === 'darwin') return launchDetached({ command: 'open', prefixArgs: [], shell: false }, [target]);
  return launchDetached({ command: 'xdg-open', prefixArgs: [], shell: false }, [target]);
}
