// Claude Code's own records: its transcript files, the sub-agent index beside them, and what they say about a role (the
// model it ran on, the usage it spent, the agents it started). Everything here reads a layout Claude Code writes under
// ~/.claude/projects; the adapter (claude.mjs) exposes it to the workflow as data.
import fs from 'node:fs';
import path from 'node:path';
import { isSafeName, maxTranscriptBytes, settleTranscript } from './safe-file.mjs';
import { descendants } from './turns.mjs';

export const LABEL = 'Claude Code';

const folders = (dir) => {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => path.join(dir, e.name));
  } catch {
    return [];
  }
};

// The session files Claude Code keeps: ~/.claude/projects/<encoded cwd>/<session id>.jsonl, and under
// <session>/subagents/ one agent-<id>.jsonl per sub-agent (found by name through its .meta.json, not here).
// `subagent`: the id may be a sub-agent's, whose file is the nested agent-<id>.jsonl.
export function transcriptFile(session, { home, cap = maxTranscriptBytes(), subagent = false }) {
  if (!isSafeName(session)) return { problem: `the session id \`${session}\` is not a plain name; no transcript is read` };
  const base = path.join(home, '.claude', 'projects');
  let baseReal;
  try {
    baseReal = fs.realpathSync.native(base);
  } catch {
    return { problem: `no ${LABEL} transcript store on this machine (${base})`, gone: true };
  }
  const candidates = folders(base).map((d) => path.join(d, `${session}.jsonl`));
  if (subagent) {
    const nested = (dir, depth) => {
      for (const d of folders(dir)) {
        const f = path.join(d, `agent-${session}.jsonl`);
        if (fs.lstatSync(f, { throwIfNoEntry: false })) candidates.push(f);
        if (depth < 3) nested(d, depth + 1);
      }
    };
    for (const d of folders(base)) nested(d, 1);
  }
  return settleTranscript({ runtime: 'claude', session, candidates, base, baseReal, cap });
}

function walk(dir, depth = 0, out = []) {
  if (depth > 4 || !fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, depth + 1, out);
    else if (e.name.endsWith('.jsonl')) out.push(p);
  }
  return out;
}

// Wall time counts an agent that sat idle (waiting on a monitor, or finished and later resumed) as working: one agent
// measured 185 wall minutes for about 21 active. Active time sums the gaps between consecutive transcript entries,
// leaving out gaps of IDLE_GAP_MS or more.
export const IDLE_GAP_MS = 5 * 60000;
export function activeMs(timestamps) {
  const t = timestamps.map((x) => Date.parse(x)).filter((x) => !Number.isNaN(x)).sort((a, b) => a - b);
  let n = 0;
  for (let i = 1; i < t.length; i++) if (t[i] - t[i - 1] < IDLE_GAP_MS) n += t[i] - t[i - 1];
  return n;
}
export const minutes = (msValue) => Math.round(msValue / 6000) / 10;

// A fresh prompt (not a tool result) after the first one is a resume of the same agent: a new round.
const isPrompt = (e) => e.type === 'user' && !e.isMeta && (typeof e.message?.content === 'string' || (Array.isArray(e.message?.content) && e.message.content.some((c) => c.type === 'text') && !e.message.content.some((c) => c.type === 'tool_result')));

export function readTranscript(file) {
  const out = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line) continue;
    try {
      out.push(JSON.parse(line));
    } catch {}
  }
  return out;
}

// Real model names only: Claude Code writes `<synthetic>` for messages it generated itself.
export const realModel = (m) => (m && !String(m).startsWith('<') ? m : null);

// The model of the last assistant message in raw transcript entries, or null.
export function lastModelOf(entries) {
  for (let i = entries.length - 1; i >= 0; i--) {
    const m = realModel(entries[i].message?.model);
    if (entries[i].type === 'assistant' && m) return m;
  }
  return null;
}

// Reads Claude Code transcript files. A response split over several lines (one per content block) repeats its usage
// with a growing output count, so each request counts once, at its largest.
export function claudeUsageOf(files) {
  const u = { runtime: 'claude', models: {}, byModel: {}, efforts: {}, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, toolCalls: 0, first: null, last: null, activeMs: 0, rounds: [], transcripts: files };
  const requests = new Map();
  for (const f of files) {
    const stamps = [];
    let round = null;
    const closeRound = () => {
      if (round?.stamps.length) u.rounds.push({ startedAt: round.stamps[0], wallMinutes: minutes(Date.parse(round.stamps.at(-1)) - Date.parse(round.stamps[0])), activeMinutes: minutes(activeMs(round.stamps)) });
    };
    for (const e of readTranscript(f)) {
      if (isPrompt(e) && round?.stamps.length) {
        closeRound();
        round = null;
      }
      if (e.timestamp) {
        u.first = u.first && u.first < e.timestamp ? u.first : e.timestamp;
        u.last = u.last && u.last > e.timestamp ? u.last : e.timestamp;
        stamps.push(e.timestamp);
        (round ??= { stamps: [] }).stamps.push(e.timestamp);
      }
      const m = e.message;
      if (m?.usage) {
        const key = e.requestId ?? `${f}:${e.uuid ?? requests.size}`;
        const prev = requests.get(key);
        if (!prev || (m.usage.output_tokens ?? 0) >= (prev.usage.output_tokens ?? 0)) requests.set(key, { usage: m.usage, model: m.model, effort: e.effort ?? null });
      }
      if (Array.isArray(m?.content)) u.toolCalls += m.content.filter((c) => c.type === 'tool_use').length;
    }
    closeRound();
    u.activeMs += activeMs(stamps);
  }
  for (const r of requests.values()) {
    if (realModel(r.model)) u.models[r.model] = (u.models[r.model] ?? 0) + 1;
    if (r.effort) u.efforts[r.effort] = (u.efforts[r.effort] ?? 0) + 1;
    u.input += r.usage.input_tokens ?? 0;
    u.output += r.usage.output_tokens ?? 0;
    u.cacheRead += r.usage.cache_read_input_tokens ?? 0;
    u.cacheWrite += r.usage.cache_creation_input_tokens ?? 0;
    // Per model, so a transcript that switched model is priced per request at the right rate.
    const b = (u.byModel[realModel(r.model) ?? 'unknown'] ??= { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, requests: 0 });
    b.input += r.usage.input_tokens ?? 0;
    b.output += r.usage.output_tokens ?? 0;
    b.cacheRead += r.usage.cache_read_input_tokens ?? 0;
    b.cacheWrite += r.usage.cache_creation_input_tokens ?? 0;
    b.requests += 1;
  }
  return u;
}

export function claudeUsage(session, home) {
  const found = transcriptFile(session, { home, cap: Infinity, subagent: true });
  return found.file ? claudeUsageOf([found.file]) : null;
}

// Subagents started by the owner have no session id of their own. Claude Code writes each one as
// <session>/subagents/agent-<id>.jsonl beside a .meta.json holding the name it was started with (the --agent id)
// and its agent type. Read once per report.
export function subagentIndex(home) {
  const out = [];
  for (const f of walk(path.join(home, '.claude', 'projects'))) {
    if (path.basename(path.dirname(f)) !== 'subagents') continue;
    const meta = f.replace(/\.jsonl$/, '.meta.json');
    try {
      const m = JSON.parse(fs.readFileSync(meta, 'utf8'));
      // An agent started without a name is listed with `name: null` (review provenance can still identify it by its
      // start line); every lookup by name skips it.
      // agentId is the file's own id; parentAgentId names the agent that started it (absent for the owner's own).
      if (m && typeof m === 'object') out.push({ file: f, agentId: path.basename(f, '.jsonl').replace(/^agent-/, ''), name: typeof m.name === 'string' && m.name ? m.name : null, agentType: m.agentType ?? null, parentAgentId: typeof m.parentAgentId === 'string' ? m.parentAgentId : null, spawnDepth: Number.isInteger(m.spawnDepth) ? m.spawnDepth : null, description: typeof m.description === 'string' ? m.description : null });
    } catch {}
  }
  return out;
}

// Transcripts of the Claude Code subagent started under this name (and agent type, when known), newest first.
export function subagentTranscripts(home, name, agentType = null, since = null) {
  return subagentIndex(home)
    .filter((x) => x.name === name && (!agentType || x.agentType === agentType))
    .map((x) => ({ ...x, mtime: fs.statSync(x.file).mtimeMs }))
    .filter((x) => !since || x.mtime >= Date.parse(since))
    .sort((a, b) => b.mtime - a.mtime);
}

// The model the owner's own session runs on right now: what an agent whose class pins no model inherits.
// Session transcripts sit at ~/.claude/projects/<project>/<session>.jsonl; only the tail is read.
export function sessionModel(home, session) {
  if (!session) return null;
  const found = transcriptFile(session, { home, cap: Infinity });
  if (!found.file) return null;
  const size = fs.statSync(found.file).size;
  const fd = fs.openSync(found.file, 'r');
  const len = Math.min(size, 512 * 1024);
  const buf = Buffer.alloc(len);
  fs.readSync(fd, buf, 0, len, size - len);
  fs.closeSync(fd);
  const entries = buf.toString('utf8').split('\n').slice(size > len ? 1 : 0).flatMap((l) => {
    try {
      return [JSON.parse(l)];
    } catch {
      return [];
    }
  });
  return lastModelOf(entries);
}

// Best effort: the model a Claude subagent ran on, from its transcript. Never throws.
export function subagentModel(home, name, agentType = null, since = null) {
  try {
    const t = subagentTranscripts(home, name, agentType, since)[0];
    return t ? lastModelOf(readTranscript(t.file)) : null;
  } catch {
    return null;
  }
}

export const handoffFiles = (h, index, since) => index
  .filter((x) => x.name === h.agent && (h.agentType ? x.agentType === h.agentType : /^wf-/.test(x.agentType ?? '')))
  .filter((x) => {
    try {
      return !since || fs.statSync(x.file).mtime >= new Date(since);
    } catch {
      return false;
    }
  });

// The sub-agents of the Claude Code agent started under this name: what `wf handoff close` records in the ledger.
export function childAgents(home, name, agentType = null, since = null) {
  const index = subagentIndex(home);
  const mine = handoffFiles({ agent: name, agentType }, index, since).map((x) => x.agentId);
  return descendants(index, mine).map((x) => ({ agentId: x.agentId, name: x.name, agentType: x.agentType, parentAgentId: x.parentAgentId, depth: x.spawnDepth, description: x.description }));
}


// The assistant's turns of a transcript in the shape every adapter returns (hosts/index.mjs): its text parts and model.
export function assistantTurns(entries) {
  return entries.filter((e) => e.type === 'assistant').map((e) => {
    const content = e.message?.content;
    const texts = typeof content === 'string' ? [content] : Array.isArray(content) ? content.filter((c) => c.type === 'text').map((c) => c.text ?? '') : [];
    return { role: 'assistant', at: e.timestamp ?? null, texts, model: realModel(e.message?.model) };
  });
}
