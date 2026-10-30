// API provider presets. "kind" selects the wire format:
//   openai    — POST {baseUrl}/chat/completions (OpenAI and every OpenAI-compatible service or gateway)
//   anthropic — POST {baseUrl}/v1/messages
//   gemini    — POST {baseUrl}/v1beta/models/{model}:streamGenerateContent?alt=sse
// keyName is the environment-variable name under which the key is stored (Configuration › API keys).
export const PRESETS = [
  { preset: 'openai', label: 'OpenAI (API)', kind: 'openai', baseUrl: 'https://api.openai.com/v1', keyName: 'OPENAI_API_KEY', site: 'https://platform.openai.com/api-keys' },
  { preset: 'anthropic', label: 'Anthropic (API)', kind: 'anthropic', baseUrl: 'https://api.anthropic.com', keyName: 'ANTHROPIC_API_KEY', site: 'https://console.anthropic.com/settings/keys' },
  { preset: 'google', label: 'Google Gemini (API)', kind: 'gemini', baseUrl: 'https://generativelanguage.googleapis.com', keyName: 'GEMINI_API_KEY', site: 'https://aistudio.google.com/apikey' },
  { preset: 'mistral', label: 'Mistral', kind: 'openai', baseUrl: 'https://api.mistral.ai/v1', keyName: 'MISTRAL_API_KEY', site: 'https://console.mistral.ai/api-keys' },
  { preset: 'openrouter', label: 'OpenRouter', kind: 'openai', baseUrl: 'https://openrouter.ai/api/v1', keyName: 'OPENROUTER_API_KEY', site: 'https://openrouter.ai/keys' },
  { preset: 'deepseek', label: 'DeepSeek', kind: 'openai', baseUrl: 'https://api.deepseek.com/v1', keyName: 'DEEPSEEK_API_KEY', site: 'https://platform.deepseek.com/api_keys' },
  { preset: 'groq', label: 'Groq', kind: 'openai', baseUrl: 'https://api.groq.com/openai/v1', keyName: 'GROQ_API_KEY', site: 'https://console.groq.com/keys' },
  { preset: 'xai', label: 'xAI (Grok)', kind: 'openai', baseUrl: 'https://api.x.ai/v1', keyName: 'XAI_API_KEY', site: 'https://console.x.ai' },
  { preset: 'azure', label: 'Azure OpenAI', kind: 'openai', baseUrl: 'https://YOUR-RESOURCE.openai.azure.com/openai/v1', keyName: 'AZURE_OPENAI_API_KEY', authHeader: 'api-key', site: 'https://portal.azure.com' },
  { preset: 'omniroute', label: 'OmniRoute (local gateway)', kind: 'openai', baseUrl: 'http://localhost:20128/v1', keyName: 'OMNIROUTE_API_KEY', keyOptional: true, local: true, site: 'http://localhost:20128' },
  { preset: 'ollama', label: 'Ollama (local models)', kind: 'openai', baseUrl: 'http://localhost:11434/v1', keyName: '', keyOptional: true, local: true, site: 'https://ollama.com/download' },
  { preset: 'lmstudio', label: 'LM Studio (local models)', kind: 'openai', baseUrl: 'http://localhost:1234/v1', keyName: '', keyOptional: true, local: true, site: 'https://lmstudio.ai' },
  { preset: 'custom', label: 'Other OpenAI-compatible service', kind: 'openai', baseUrl: 'https://', keyName: 'CUSTOM_API_KEY', keyOptional: true },
];

export const presetById = (id) => PRESETS.find((p) => p.preset === id);

/** Validates and normalises a provider definition coming from the UI. */
export function normalizeProvider(p, existingIds = []) {
  const base = presetById(p.preset) || presetById('custom');
  const out = {
    id: p.id || slug(p.label || base.label, existingIds),
    preset: base.preset, kind: ['openai', 'anthropic', 'gemini'].includes(p.kind) ? p.kind : base.kind,
    label: String(p.label || base.label).slice(0, 80),
    baseUrl: String(p.baseUrl || base.baseUrl).trim().replace(/\/+$/, ''),
    keyName: p.keyName === '' ? '' : String(p.keyName ?? base.keyName).trim().toUpperCase(),
    authHeader: p.authHeader || base.authHeader || null,
    models: Array.isArray(p.models) ? p.models.map(String).filter(Boolean).slice(0, 500) : [],
    enabled: p.enabled !== false,
  };
  if (!/^https?:\/\/[^/\s]+/.test(out.baseUrl) || /YOUR-RESOURCE/.test(out.baseUrl)) throw new Error('Enter the service URL (it must start with http:// or https://)');
  if (!/^https:\/\//.test(out.baseUrl) && !/^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/.test(out.baseUrl)) throw new Error('Use https:// (plain http:// is only accepted for services on this computer)');
  if (out.keyName && !/^[A-Z_][A-Z0-9_]{1,63}$/.test(out.keyName)) throw new Error('Key name must look like an environment variable, e.g. MISTRAL_API_KEY');
  return out;
}

function slug(label, existing) {
  const base = String(label).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30) || 'provider';
  let id = base, n = 2;
  while (existing.includes(id)) id = `${base}-${n++}`;
  return id;
}
