// Minimal JSON-RPC 2.0 peer over newline-delimited JSON (the transport used by `codex app-server`).
import { EventEmitter } from 'node:events';
import readline from 'node:readline';

export class RpcError extends Error {
  constructor(error, method) {
    super(error?.message || 'RPC error');
    this.code = error?.code; this.data = error?.data; this.method = method;
  }
}

export class JsonRpcPeer extends EventEmitter {
  constructor(child, { requestTimeoutMs = 120_000, log = () => {} } = {}) {
    super();
    this.child = child; this.nextId = 1; this.pending = new Map(); this.timeout = requestTimeoutMs; this.log = log;
    this.closed = false;
    const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
    rl.on('line', (line) => this.#onLine(line));
    child.on('exit', (code, signal) => this.#close(new Error(`Agent process exited (${signal || code})`)));
    child.on('error', (e) => this.#close(e));
    child.stdin.on('error', () => {});
  }

  #onLine(line) {
    if (!line.trim()) return;
    let msg;
    try { msg = JSON.parse(line); } catch { this.log('non-JSON line: ' + line.slice(0, 200)); return; }
    if (msg.id != null && msg.method) { this.emit('request', msg); return; }
    if (msg.id != null) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id); clearTimeout(p.timer);
      if (msg.error) p.reject(new RpcError(msg.error, p.method)); else p.resolve(msg.result);
      return;
    }
    if (msg.method) this.emit('notification', msg);
  }

  #close(err) {
    if (this.closed) return;
    this.closed = true;
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(err); }
    this.pending.clear();
    this.emit('close', err);
  }

  #write(obj) {
    if (this.closed) throw new Error('Agent process is not running');
    this.child.stdin.write(JSON.stringify(obj) + '\n');
  }

  request(method, params, timeoutMs = this.timeout) {
    return new Promise((resolve, reject) => {
      if (this.closed) { reject(new Error('Agent process is not running')); return; }
      const id = this.nextId++;
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`${method} timed out after ${Math.round(timeoutMs / 1000)} s`)); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, method });
      try { this.#write({ id, method, params }); } catch (e) { clearTimeout(timer); this.pending.delete(id); reject(e); }
    });
  }

  notify(method, params) { this.#write(params === undefined ? { method } : { method, params }); }
  respond(id, result) { this.#write({ id, result }); }
  respondError(id, message, code = -32000) { this.#write({ id, error: { code, message } }); }
}
