// Local conversation storage for agents that do not keep their own history in a form we can read
// (API providers). One JSON file per conversation: { meta, items, history }.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

export class TranscriptStore {
  constructor(dir) { this.dir = dir; this.cache = new Map(); this.locks = new Map(); }

  file(id) {
    if (!/^[\w-]{8,64}$/.test(id)) throw new Error('Invalid conversation id');
    return path.join(this.dir, `${id}.json`);
  }

  async list() {
    let names = [];
    try { names = (await fsp.readdir(this.dir)).filter((f) => f.endsWith('.json')); } catch { return []; }
    const out = [];
    for (const n of names) { try { out.push((await this.read(n.slice(0, -5))).meta); } catch { /* corrupt file skipped */ } }
    return out;
  }

  async read(id) {
    if (this.cache.has(id)) return this.cache.get(id);
    const data = JSON.parse(await fsp.readFile(this.file(id), 'utf8'));
    data.items ||= []; data.history ||= [];
    this.cache.set(id, data);
    return data;
  }

  async create(meta) {
    const id = crypto.randomUUID();
    const data = { meta: { id, title: '', createdAt: Date.now(), updatedAt: Date.now(), archived: false, ...meta, id }, items: [], history: [] };
    this.cache.set(id, data);
    await this.save(id);
    return data;
  }

  /** Serialised atomic write per conversation. */
  async save(id) {
    const data = this.cache.get(id);
    if (!data) return;
    const prev = this.locks.get(id) || Promise.resolve();
    const job = prev.catch(() => {}).then(async () => {
      await fsp.mkdir(this.dir, { recursive: true });
      const tmp = this.file(id) + '.' + process.pid + '.tmp';
      await fsp.writeFile(tmp, JSON.stringify(data));
      await fsp.rename(tmp, this.file(id));
    });
    this.locks.set(id, job);
    return job;
  }

  async remove(id) { this.cache.delete(id); await fsp.rm(this.file(id), { force: true }); }
  exists(id) { try { return fs.existsSync(this.file(id)); } catch { return false; } }
}
