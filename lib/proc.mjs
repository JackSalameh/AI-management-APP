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
export function openExternal(target) {
  if (isWin) return launchDetached({ command: 'rundll32.exe', prefixArgs: [], shell: false }, ['url.dll,FileProtocolHandler', target]);
  if (process.platform === 'darwin') return launchDetached({ command: 'open', prefixArgs: [], shell: false }, [target]);
  return launchDetached({ command: 'xdg-open', prefixArgs: [], shell: false }, [target]);
}
