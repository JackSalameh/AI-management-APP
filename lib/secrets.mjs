// Secrets (API keys, tokens) stored with the operating system's protection and handed to agents
// as environment variables. Names are environment-variable names, e.g. OPENAI_API_KEY, JIRA_API_TOKEN.
//   Windows: DPAPI (CurrentUser) ciphertext in <dataDir>/secrets.json
//   macOS:   login Keychain (security CLI)
//   Linux:   Secret Service (secret-tool) when available, else a 0600 file (permissions only — reported to the UI)
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { run, which } from './proc.mjs';
import { BRAND } from './brand.mjs';

export const NAME_RE = /^[A-Z_][A-Z0-9_]{1,63}$/;
const SERVICE = BRAND.slug;

export class Secrets {
  constructor(dataDir, platform = process.platform) {
    this.file = path.join(dataDir, 'secrets.json');
    this.platform = platform;
    this.backend = platform === 'win32' ? 'dpapi' : platform === 'darwin' ? 'keychain' : (which('secret-tool') ? 'secret-service' : 'file');
  }

  async #index() { try { return JSON.parse(await fsp.readFile(this.file, 'utf8')); } catch { return {}; } }
  async #saveIndex(idx) { await fsp.mkdir(path.dirname(this.file), { recursive: true }); await fsp.writeFile(this.file, JSON.stringify(idx, null, 2), { mode: 0o600 }); try { fs.chmodSync(this.file, 0o600); } catch { /* windows */ } }

  describe() {
    const protection = { dpapi: 'Windows DPAPI (your Windows account)', keychain: 'macOS Keychain', 'secret-service': 'Secret Service keyring', file: 'File readable only by your user account (no keyring found)' }[this.backend];
    return { backend: this.backend, protection };
  }

  async list() {
    const idx = await this.#index();
    return Object.entries(idx).map(([name, v]) => ({ name, updatedAt: v.updatedAt, description: v.description || '' }));
  }

  async set(name, value, description = '') {
    if (!NAME_RE.test(name)) throw new Error('Secret names must look like environment variables, e.g. AZURE_OPENAI_API_KEY');
    if (!value) throw new Error('Value is empty');
    const idx = await this.#index();
    const entry = { updatedAt: Date.now(), description };
    if (this.backend === 'dpapi') entry.blob = await dpapi('Protect', value);
    else if (this.backend === 'keychain') {
      const r = await run('security', ['add-generic-password', '-U', '-s', SERVICE, '-a', name, '-w', value]);
      if (!r.ok) throw new Error(`Keychain: ${r.stderr.trim()}`);
    } else if (this.backend === 'secret-service') {
      const r = await run('secret-tool', ['store', `--label=${BRAND.name} ${name}`, 'service', SERVICE, 'account', name], { input: value });
      if (!r.ok) throw new Error(`Secret Service: ${r.stderr.trim()}`);
    } else entry.value = Buffer.from(value, 'utf8').toString('base64');
    idx[name] = entry;
    await this.#saveIndex(idx);
  }

  async get(name) {
    const idx = await this.#index();
    const e = idx[name];
    if (!e) return null;
    if (this.backend === 'dpapi') return e.blob ? dpapi('Unprotect', e.blob) : null;
    if (this.backend === 'keychain') { const r = await run('security', ['find-generic-password', '-s', SERVICE, '-a', name, '-w']); return r.ok ? r.stdout.replace(/\n$/, '') : null; }
    if (this.backend === 'secret-service') { const r = await run('secret-tool', ['lookup', 'service', SERVICE, 'account', name]); return r.ok ? r.stdout : null; }
    return e.value ? Buffer.from(e.value, 'base64').toString('utf8') : null;
  }

  async remove(name) {
    const idx = await this.#index();
    if (this.backend === 'keychain') await run('security', ['delete-generic-password', '-s', SERVICE, '-a', name]);
    if (this.backend === 'secret-service') await run('secret-tool', ['clear', 'service', SERVICE, 'account', name]);
    delete idx[name];
    await this.#saveIndex(idx);
  }

  /** All secrets as an env object for agent processes. Failures are reported, not thrown. */
  async env() {
    const out = {}, errors = [];
    for (const { name } of await this.list()) {
      try { const v = await this.get(name); if (v != null) out[name] = v; } catch (e) { errors.push(`${name}: ${e.message}`); }
    }
    return { env: out, errors };
  }
}

/** Windows DPAPI through PowerShell; the secret travels on stdin, never on the command line. */
async function dpapi(op, input) {
  const script = op === 'Protect'
    ? "Add-Type -AssemblyName System.Security; $t=[Console]::In.ReadToEnd(); [Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect([Text.Encoding]::UTF8.GetBytes($t),$null,'CurrentUser'))"
    : "Add-Type -AssemblyName System.Security; $t=[Console]::In.ReadToEnd().Trim(); [Text.Encoding]::UTF8.GetString([Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String($t),$null,'CurrentUser'))";
  const r = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], { input });
  if (!r.ok) throw new Error(`DPAPI ${op} failed: ${(r.stderr || r.error || '').trim().slice(0, 200)}`);
  return op === 'Protect' ? r.stdout.trim() : r.stdout.replace(/\r?\n$/, '');
}
