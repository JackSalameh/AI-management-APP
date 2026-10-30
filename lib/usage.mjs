// Token usage in one shape for every AI: input (not served from cache), output, cache read, cache write,
// reasoning (part of output), plus the context window when the agent reports it.
// Sources and field names (verified):
//  - Codex app-server thread/tokenUsage/updated: { total, last, modelContextWindow } with TokenUsageBreakdown
//    { inputTokens (includes cached), cachedInputTokens, cacheWriteInputTokens, outputTokens, reasoningOutputTokens, totalTokens }
//  - Codex rollout files: event_msg token_count → info.total_token_usage / last_token_usage (snake_case), model_context_window
//  - Claude Code / Anthropic: usage { input_tokens (not cached), cache_read_input_tokens, cache_creation_input_tokens, output_tokens }
//  - OpenAI-compatible: usage { prompt_tokens (includes cached), prompt_tokens_details.cached_tokens, completion_tokens,
//    completion_tokens_details.reasoning_tokens }
//  - Gemini: usageMetadata { promptTokenCount (includes cached), cachedContentTokenCount, candidatesTokenCount, thoughtsTokenCount }
import fs from 'node:fs';
import readline from 'node:readline';

export const ZERO = Object.freeze({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 });
const n = (v) => (Number.isFinite(+v) ? +v : 0);
export const total = (u) => (u ? u.input + u.output + u.cacheRead + u.cacheWrite : 0);

export function add(a, b) {
  if (!a) return b ? { ...b } : null;
  if (!b) return { ...a };
  return { input: a.input + b.input, output: a.output + b.output, cacheRead: a.cacheRead + b.cacheRead, cacheWrite: a.cacheWrite + b.cacheWrite, reasoning: a.reasoning + b.reasoning };
}

export function fromCodexBreakdown(b) {
  if (!b) return null;
  const cached = n(b.cachedInputTokens ?? b.cached_input_tokens);
  return { input: Math.max(0, n(b.inputTokens ?? b.input_tokens) - cached), cacheRead: cached, cacheWrite: n(b.cacheWriteInputTokens ?? b.cache_write_input_tokens), output: n(b.outputTokens ?? b.output_tokens), reasoning: n(b.reasoningOutputTokens ?? b.reasoning_output_tokens) };
}
export function fromAnthropic(u) {
  if (!u) return null;
  return { input: n(u.input_tokens), cacheRead: n(u.cache_read_input_tokens), cacheWrite: n(u.cache_creation_input_tokens), output: n(u.output_tokens), reasoning: 0 };
}
export function fromOpenAI(u) {
  if (!u) return null;
  const cached = n(u.prompt_tokens_details?.cached_tokens);
  return { input: Math.max(0, n(u.prompt_tokens) - cached), cacheRead: cached, cacheWrite: 0, output: n(u.completion_tokens), reasoning: n(u.completion_tokens_details?.reasoning_tokens) };
}
export function fromGemini(m) {
  if (!m) return null;
  const cached = n(m.cachedContentTokenCount);
  return { input: Math.max(0, n(m.promptTokenCount) - cached), cacheRead: cached, cacheWrite: 0, output: n(m.candidatesTokenCount) + n(m.thoughtsTokenCount), reasoning: n(m.thoughtsTokenCount) };
}

/** Codex: the thread's running total, the last request and the context window. */
export function fromCodexThread(tu) {
  if (!tu) return null;
  const last = fromCodexBreakdown(tu.last);
  return { total: fromCodexBreakdown(tu.total), last, contextWindow: tu.modelContextWindow ?? null, contextUsed: last ? last.input + last.cacheRead + last.cacheWrite : null };
}

/** Reads a whole Codex rollout or Claude Code session file (streamed; only usage lines are parsed). */
export async function usageFromFile(file, kind) {
  if (!file || !fs.existsSync(file)) return null;
  const rl = readline.createInterface({ input: fs.createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
  let codex = null, sum = null, last = null, turns = 0;
  const seen = new Set();
  for await (const line of rl) {
    if (kind === 'codex') {
      if (!line.includes('"token_count"')) continue;
      let o; try { o = JSON.parse(line); } catch { continue; }
      const info = o.payload?.info;
      if (info?.total_token_usage) codex = { total: fromCodexBreakdown(info.total_token_usage), last: fromCodexBreakdown(info.last_token_usage), contextWindow: info.model_context_window ?? null };
    } else {
      if (!line.includes('"usage"')) continue;
      let o; try { o = JSON.parse(line); } catch { continue; }
      const m = o.message;
      if (o.type !== 'assistant' || !m?.usage) continue;
      const id = m.id || o.uuid; // one API message is written in several lines with the same usage
      if (seen.has(id)) continue;
      seen.add(id);
      last = fromAnthropic(m.usage); sum = add(sum, last); turns++;
    }
  }
  if (kind === 'codex') return codex && { ...codex, contextUsed: codex.last ? codex.last.input + codex.last.cacheRead + codex.last.cacheWrite : null, source: 'history' };
  return sum && { total: sum, last, contextWindow: null, contextUsed: last ? last.input + last.cacheRead + last.cacheWrite : null, requests: turns, source: 'history' };
}
