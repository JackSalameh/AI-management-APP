// User-managed model list: entries reported by the agent (model/list) plus custom entries
// imported from TOML profiles (e.g. Azure or self-hosted providers). Removing an entry never deletes a file.
import crypto from 'node:crypto';
import { parseToml } from './toml.mjs';

export const DEFAULT_EFFORTS = ['low', 'medium', 'high', 'xhigh'];
const SECRET_FIELDS = ['experimental_bearer_token', 'api_key', 'apiKey', 'token', 'password'];

/** Reads a model profile TOML into a model entry. Literal secrets are dropped and reported. */
export function profileFromToml(text, label) {
  const cfg = parseToml(text);
  const model = cfg.model;
  if (!model || typeof model !== 'string') throw new Error('The file has no top-level `model = "…"` line');
  const provider = typeof cfg.model_provider === 'string' ? cfg.model_provider : null;
  let providerConfig = null; const dropped = [];
  if (provider && cfg.model_providers && cfg.model_providers[provider]) {
    providerConfig = { ...cfg.model_providers[provider] };
    for (const f of SECRET_FIELDS) if (f in providerConfig) { delete providerConfig[f]; dropped.push(`model_providers.${provider}.${f}`); }
  }
  const effort = typeof cfg.model_reasoning_effort === 'string' ? cfg.model_reasoning_effort : null;
  const extras = {};
  for (const k of ['model_reasoning_summary', 'model_verbosity', 'model_context_window', 'service_tier']) if (k in cfg) extras[k] = cfg[k];
  return {
    entry: { id: crypto.randomUUID(), label: label || model, model, provider, providerConfig, effort, efforts: null, extras, source: 'custom' },
    envKey: providerConfig?.env_key || null,
    dropped,
  };
}

/** Merges agent-reported and custom entries into the list shown beside Send. */
export function mergeModels(byAgent, custom, hidden = []) {
  const list = [];
  for (const [agent, models] of Object.entries(byAgent)) {
    for (const m of models || []) { const key = `${agent}:${m.id}`; if (!hidden.includes(key)) list.push({ ...m, agent, key }); }
  }
  for (const c of custom) {
    // A custom entry for a model the account already reports inherits that model's real effort levels.
    const known = (byAgent[c.agent || 'codex'] || []).find((m) => m.model === c.model);
    list.push({ ...c, agent: c.agent || 'codex', key: `custom:${c.id}`, efforts: c.efforts?.length ? c.efforts : known?.efforts?.length ? known.efforts : DEFAULT_EFFORTS, defaultEffort: c.effort || known?.defaultEffort || 'medium' });
  }
  return list;
}

/** Config edits that make the Codex CLI use the same model, provider and effort as the app (shared config.toml). */
export function configEditsFor(entry, effort) {
  const edits = [{ keyPath: 'model', value: entry.model }];
  if (entry.provider) edits.push({ keyPath: 'model_provider', value: entry.provider });
  if (entry.providerConfig && entry.provider) edits.push({ keyPath: `model_providers.${entry.provider}`, value: entry.providerConfig, mergeStrategy: 'upsert' });
  if (effort) edits.push({ keyPath: 'model_reasoning_effort', value: effort });
  for (const [k, v] of Object.entries(entry.extras || {})) edits.push({ keyPath: k, value: v });
  return edits;
}

/** Effort validation (bug #10: Codex accepts any string at write time and fails only at Send). */
export function checkEffort(entry, effort) {
  if (!effort) return null;
  const allowed = entry?.efforts?.length ? entry.efforts : DEFAULT_EFFORTS;
  if (allowed.includes(effort)) return null;
  return `"${effort}" is not available for ${entry?.label || 'this model'}. Choose one of: ${allowed.join(', ')}.`;
}
