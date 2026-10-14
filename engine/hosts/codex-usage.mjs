// What a Codex session spent, read from its rollout: one running total per session, attributed to its main model.
import fs from 'node:fs';
import { codexTranscript } from './codex-transcript.mjs';

const top = (counts) => Object.entries(counts ?? {}).sort((a, b) => b[1] - a[1]).map(([k]) => k);

export function codexUsage(session, home) {
  // Named failure I-38: summing retained rollouts doubled cumulative totals and substring-matched other sessions.
  const selected = codexTranscript(session, { home });
  if (selected.problem) return null;
  const files = [selected.file];
  const u = { runtime: 'codex', models: {}, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, toolCalls: 0, first: null, last: null };
  for (const f of files) {
    let last = null, native = null;
    for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
      if (!line) continue;
      let e;
      try {
        e = JSON.parse(line);
      } catch {
        continue;
      }
      if (e.timestamp) {
        u.first = u.first && u.first < e.timestamp ? u.first : e.timestamp;
        u.last = u.last && u.last > e.timestamp ? u.last : e.timestamp;
      }
      const p = e.payload ?? e;
      if (p.type === 'token_count' && p.info?.total_token_usage) last = p.info.total_token_usage;
      if (e.type === 'token_usage_record' && (!p.thread_id || p.thread_id === session) && p.thread_token_usage) native = p.thread_token_usage;
      if (p.type === 'function_call' || p.type === 'custom_tool_call') u.toolCalls += 1;
      if (p.model) u.models[p.model] = (u.models[p.model] ?? 0) + 1;
    }
    const total = native ?? last;
    if (total) {
      u.cacheRead = total.cached_input_tokens ?? 0;
      u.cacheWrite = total.cache_write_input_tokens ?? 0;
      // Cached input and reasoning output are subsets of the host's input/output totals, not additional tokens.
      u.input = Math.max(0, (total.input_tokens ?? 0) - u.cacheRead - u.cacheWrite);
      u.output = total.output_tokens ?? 0;
      u.reasoning = total.reasoning_output_tokens ?? 0;
    }
  }
  // Codex reports one running total per session: all of it is attributed to the session's main model.
  const model = top(u.models)[0] ?? 'unknown';
  u.byModel = { [model]: { input: u.input, output: u.output, cacheRead: u.cacheRead, cacheWrite: u.cacheWrite, requests: null } };
  u.transcripts = files;
  return u;
}
