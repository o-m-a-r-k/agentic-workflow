import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { listAttempts, readLedger, reduce } from './ledger.mjs';
import { YAML } from './util.mjs';
import { ownerTranscript } from './host-record.mjs';

// The ledger is the event log: every `wf` command appends to it with a timestamp.
// Agent usage is read afterwards from each runtime's own session logs. Measurement only.

function walk(dir, depth = 0, out = []) {
  if (depth > 4 || !fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, depth + 1, out);
    else if (e.name.endsWith('.jsonl')) out.push(p);
  }
  return out;
}

function top(counts) {
  return Object.entries(counts ?? {}).sort((a, b) => b[1] - a[1]).map(([k]) => k);
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
const minutes = (msValue) => Math.round(msValue / 6000) / 10;

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
const realModel = (m) => (m && !String(m).startsWith('<') ? m : null);

// The model of the last assistant message in a transcript, or null.
export function lastModel(entries) {
  for (let i = entries.length - 1; i >= 0; i--) {
    const m = realModel(entries[i].message?.model);
    if (entries[i].type === 'assistant' && m) return m;
  }
  return null;
}

// The last fenced YAML block (```yaml, ```yml or an untagged fence) the agent wrote, or null.
export function lastFencedYaml(entries) {
  let found = null;
  for (const e of entries) {
    if (e.type !== 'assistant') continue;
    const content = e.message?.content;
    const texts = typeof content === 'string' ? [content] : Array.isArray(content) ? content.filter((c) => c.type === 'text').map((c) => c.text ?? '') : [];
    for (const t of texts) for (const m of t.matchAll(/```(?:ya?ml)?[ \t]*\n([\s\S]*?)\n[ \t]*```/g)) found = m[1];
  }
  return found;
}

// Reads Claude Code transcript files. A response split over several lines (one per content block) repeats its usage
// with a growing output count, so each request counts once, at its largest.
function claudeUsageOf(files) {
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

function claudeUsage(session, home) {
  const files = walk(path.join(home, '.claude', 'projects')).filter((f) => path.basename(f, '.jsonl') === session || path.basename(f, '.jsonl') === `agent-${session}`);
  return files.length ? claudeUsageOf(files) : null;
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
  const dir = path.join(home, '.claude', 'projects');
  if (!fs.existsSync(dir)) return null;
  for (const p of fs.readdirSync(dir)) {
    const f = path.join(dir, p, `${session}.jsonl`);
    if (!fs.existsSync(f)) continue;
    const size = fs.statSync(f).size;
    const fd = fs.openSync(f, 'r');
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
    return lastModel(entries);
  }
  return null;
}

// Best effort: the model a Claude subagent ran on, from its transcript. Never throws.
export function subagentModel(home, name, agentType = null, since = null) {
  try {
    const t = subagentTranscripts(home, name, agentType, since)[0];
    return t ? lastModel(readTranscript(t.file)) : null;
  } catch {
    return null;
  }
}

function codexUsage(session, home) {
  // Named failure I-38: summing retained rollouts doubled cumulative totals and substring-matched other sessions.
  const selected = ownerTranscript(`codex:${session}`, home);
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

export function agentUsage(runtime, session, home = os.homedir()) {
  if (!session) return null;
  try {
    if (runtime === 'claude') return claudeUsage(session, home);
    if (runtime === 'codex') return codexUsage(session, home);
  } catch {
    return null;
  }
  return null;
}


// Prices: the table shipped with the plugin (engine/prices.yaml), then the user's, then the project's
// (.workflow/prices.yaml): later files replace a model's entry. A file is `models: { <id prefix>: {...} }`, or (older
// user files) the same map at the top level.
const DEFAULT_PRICES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'prices.yaml');
function priceFile(file) {
  try {
    if (!fs.existsSync(file)) return {};
    const doc = YAML.parse(fs.readFileSync(file, 'utf8')) ?? {};
    const models = doc.models && typeof doc.models === 'object' ? doc.models : doc;
    return Object.fromEntries(Object.entries(models).filter(([, v]) => v && typeof v === 'object' && !Array.isArray(v)));
  } catch {
    return {};
  }
}
export function prices(root = null) {
  const user = path.join(process.env.WF_CONFIG_HOME ?? path.join(os.homedir(), '.config', 'agentic-workflow'), 'prices.yaml');
  return { ...priceFile(DEFAULT_PRICES), ...priceFile(user), ...(root ? priceFile(path.join(root, '.workflow', 'prices.yaml')) : {}) };
}

// The longest key the model id starts with.
export function priceOf(table, model) {
  if (!model) return null;
  const key = Object.keys(table).filter((k) => model === k || model.startsWith(k)).sort((a, b) => b.length - a.length)[0];
  return key ? table[key] : null;
}

const per = (n, price) => ((n ?? 0) * (price ?? 0)) / 1e6;
function modelCost(b, p) {
  return per(b.input, p.input) + per(b.output, p.output) + per(b.cacheRead, p.cacheRead ?? p.input) + per(b.cacheWrite, p.cacheWrite ?? p.input);
}

// { cost, unpriced }: the priced models' cost (null when none is priced) and the models with tokens but no price.
export function costOf(usage, table) {
  let total = null;
  const unpriced = [];
  for (const [model, b] of Object.entries(usage?.byModel ?? {})) {
    const p = priceOf(table, model);
    if (!p) {
      if ((b.input ?? 0) + (b.output ?? 0) + (b.cacheRead ?? 0) + (b.cacheWrite ?? 0) > 0) unpriced.push(model);
      continue;
    }
    total = (total ?? 0) + modelCost(b, p);
  }
  return { cost: total === null ? null : Math.round(total * 10000) / 10000, unpriced };
}

// Sub-agents a handoff's agent started (Claude Code writes `parentAgentId` in each sub-agent's meta file), at any depth.
export function descendants(index, roots) {
  const out = [];
  const seen = new Set(roots);
  let frontier = [...roots];
  while (frontier.length) {
    const next = index.filter((x) => x.parentAgentId && frontier.includes(x.parentAgentId) && !seen.has(x.agentId));
    for (const x of next) {
      seen.add(x.agentId);
      out.push(x);
    }
    frontier = next.map((x) => x.agentId);
  }
  return out;
}

const handoffFiles = (h, index, since) => index
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

const ms = (a, b) => (a && b ? new Date(b) - new Date(a) : null);
const mins = (v) => (v === null || v === undefined ? null : Math.round(v / 6000) / 10);
const hid = (bundle) => (bundle ? path.basename(String(bundle), '.json') : null);
const settledStatus = (st) => ['fixed', 'verified-nonissue'].includes(st);

export const IDLE_REPORT_MINUTES = 30;
export const PHASES = ['planning', 'implementing', 'gating', 'reviewing', 'fixing', 'delivering'];

// Review rounds from the ledger: one per reviewer handoff, with its outcome. `review.round` events (0.5.0 on) carry
// refusals; older ledgers have `review.recorded` only. A round with no outcome is `abandoned` when a later reviewer was
// handed the attempt or the review was accepted, otherwise `open`.
export function reviewRounds(entries, s) {
  const reviewers = s.handoffs.filter((h) => h.role === 'reviewer');
  return reviewers.map((h, i) => {
    const rec = s.reviews.filter((r) => r.handoff === h.bundle);
    const events = s.reviewRounds.filter((r) => r.bundle === h.bundle);
    const refused = events.filter((r) => r.outcome === 'refused');
    const recorded = rec.length > 0;
    const firstRecorded = rec[0]?.at ?? null;
    const later = reviewers[i + 1]?.at ?? null;
    const outcome = recorded ? 'recorded' : refused.length ? 'refused' : later || s.accepted ? 'abandoned' : 'open';
    // Named failure: an eventual closure hid refusal history, and missing early outcomes were called wasted work.
    // Keep legacy outcome/count fields for report@1 consumers; add observed results without inventing history.
    const launchFailed = h.launch?.status === 'failed';
    const result = recorded ? 'recorded' : refused.length ? 'refused' : launchFailed ? (h.session ? 'failed-run' : 'failed-start') : outcome === 'abandoned' ? 'unknown' : 'open';
    const endedAt = firstRecorded ?? refused[0]?.at ?? (launchFailed ? h.launch.finishedAt : null) ?? (outcome === 'abandoned' ? later ?? s.accepted?.at : null);
    const closure = rec[0]?.closure ?? null;
    const findings = (closure?.findings ?? []).map((f) => ({ id: f.id, severity: f.severity ?? null, status: f.status ?? null, category: f.category ?? null }));
    const lastEvent = events.at(-1) ?? null;
    return {
      handoff: hid(h.bundle),
      agent: h.agent,
      agentType: h.agentType ?? null,
      model: rec.at(-1)?.reviewerModel ?? lastEvent?.model ?? h.model ?? null,
      startedAt: h.at,
      endedAt,
      minutes: mins(ms(h.at, endedAt)),
      outcome,
      result,
      resultEvidence: ['recorded', 'refused', 'failed-run', 'failed-start'].includes(result) ? 'recorded-event' : 'no-recorded-outcome',
      launchStatus: h.launch?.status ?? 'unrecorded',
      failedBeforeSession: launchFailed && !h.session,
      refusedFor: refused.map((r) => r.reasonClass),
      tree: h.tree ?? null,
      gatePassedOnTree: Boolean(h.gate),
      openImplementers: h.openImplementers ?? null,
      findings,
      priorFindings: (lastEvent?.priorFindings ?? rec.at(-1)?.closure?.priorFindings ?? []).map((p) => ({ round: p.round ?? null, id: p.id ?? null, status: p.status ?? null, fixedIn: p.fixedIn ?? null })),
    };
  });
}

export function reviewDiagnostics(rounds) {
  return {
    roundsWithRefusal: rounds.filter((r) => r.refusedFor.length > 0).length,
    failedLaunchRounds: rounds.filter((r) => r.launchStatus === 'failed').length,
    failedStartRounds: rounds.filter((r) => r.failedBeforeSession).length,
    unknownOutcomeRounds: rounds.filter((r) => r.result === 'unknown').length,
    refusalReasons: rounds.reduce((counts, r) => { for (const reason of new Set(r.refusedFor)) counts[reason] = (counts[reason] ?? 0) + 1; return counts; }, {}),
  };
}

// Wall-clock time per phase. Each instant gets one phase, by priority: a reviewer round open → reviewing; a gate
// running → gating; before criteria froze → planning; after acceptance → delivering; before the first review round
// ended → implementing; otherwise → fixing (repairs and new work between rounds).
function phases(entries, s, rounds, gateWindows, end) {
  const start = entries[0]?.at;
  const out = Object.fromEntries(PHASES.map((p) => [p, 0]));
  if (!start || !end) return { minutes: out, totalMinutes: 0 };
  const t = (x) => Date.parse(x);
  const frozen = entries.find((e) => e.type === 'criteria.frozen')?.at ?? null;
  const accepted = s.accepted?.at ?? null;
  const firstRoundEnd = rounds.map((r) => r.endedAt).filter(Boolean).sort()[0] ?? null;
  const reviewWins = rounds.map((r) => [t(r.startedAt), t(r.endedAt ?? end)]);
  const gateWins = gateWindows.map((g) => [t(g.startedAt), t(g.endedAt ?? end)]);
  const marks = [...new Set([t(start), t(end), ...[frozen, accepted, firstRoundEnd].filter(Boolean).map(t), ...reviewWins.flat(), ...gateWins.flat()])]
    .filter((x) => !Number.isNaN(x) && x >= t(start) && x <= t(end))
    .sort((a, b) => a - b);
  const inside = (wins, m) => wins.some(([a, b]) => m >= a && m < b);
  for (let i = 1; i < marks.length; i++) {
    const a = marks[i - 1];
    const b = marks[i];
    const m = (a + b) / 2;
    const phase = inside(reviewWins, m) ? 'reviewing'
      : inside(gateWins, m) ? 'gating'
        : frozen && m < t(frozen) ? 'planning'
          : !frozen ? 'planning'
            : accepted && m >= t(accepted) ? 'delivering'
              : !firstRoundEnd || m < t(firstRoundEnd) ? 'implementing'
                : 'fixing';
    out[phase] += b - a;
  }
  return { minutes: Object.fromEntries(Object.entries(out).map(([k, v]) => [k, mins(v)])), totalMinutes: mins(t(end) - t(start)) };
}

function phaseAt(entries, s, rounds, gateWindows, at) {
  const m = Date.parse(at);
  const within = (a, b) => m >= Date.parse(a) && m < Date.parse(b ?? '9999');
  if (rounds.some((r) => within(r.startedAt, r.endedAt))) return 'reviewing';
  if (gateWindows.some((g) => within(g.startedAt, g.endedAt))) return 'gating';
  const frozen = entries.find((e) => e.type === 'criteria.frozen')?.at;
  if (!frozen || m < Date.parse(frozen)) return 'planning';
  if (s.accepted && m >= Date.parse(s.accepted.at)) return 'delivering';
  const firstRoundEnd = rounds.map((r) => r.endedAt).filter(Boolean).sort()[0];
  return !firstRoundEnd || m < Date.parse(firstRoundEnd) ? 'implementing' : 'fixing';
}

// Phases, gate windows and idle gaps from ledger entries alone (any timestamps): what `wf report` derives about time.
export function timeline(entries, { idleMinutes = IDLE_REPORT_MINUTES, state = null, rounds = null } = {}) {
  const s = state ?? reduce(entries);
  const rs = rounds ?? reviewRounds(entries, s);
  const started = entries.filter((e) => e.type === 'gate.started');
  const finished = new Map(entries.filter((e) => e.type === 'gate.finished' || e.type === 'check.finished').map((e) => [e.data.runId, e]));
  const gateWindows = started.filter((e) => (e.data.kind ?? 'gate') === 'gate').map((e) => ({ runId: e.data.runId, startedAt: e.at, endedAt: finished.get(e.data.runId)?.at ?? null }));
  const end = s.closedAt ?? entries.at(-1)?.at ?? null;
  const ph = phases(entries, s, rs, gateWindows, end);
  const idleGaps = [];
  for (let i = 1; i < entries.length; i++) {
    const gap = ms(entries[i - 1].at, entries[i].at);
    if (gap >= idleMinutes * 60000) idleGaps.push({ from: entries[i - 1].at, to: entries[i].at, minutes: mins(gap), after: entries[i - 1].type, before: entries[i].type, phase: phaseAt(entries, s, rs, gateWindows, entries[i - 1].at) });
  }
  idleGaps.sort((a, b) => b.minutes - a.minutes);
  return { end, phases: ph, idleGaps, gateWindows, rounds: rs };
}

export function attemptReport(root, id, table = prices(root), { home = os.homedir(), index, idleMinutes = IDLE_REPORT_MINUTES } = {}) {
  const entries = readLedger(root, id);
  const s = reduce(entries);
  const first = entries[0]?.at;
  const gates = s.gates.filter((g) => !g.carriedFrom);
  const steps = gates.flatMap((g) => g.steps ?? []);
  const ran = steps.filter((x) => ['passed', 'failed', 'interrupted'].includes(x.status));
  const reused = steps.filter((x) => x.status === 'reused');
  let subagents = index;
  const indexNow = () => {
    try {
      subagents ??= subagentIndex(home);
    } catch {
      subagents = [];
    }
    return subagents;
  };
  const counted = new Set();
  const byModel = {};
  const addModels = (usage) => {
    for (const [m, b] of Object.entries(usage?.byModel ?? {})) {
      const t = (byModel[m] ??= { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
      for (const k of ['input', 'output', 'cacheRead', 'cacheWrite']) t[k] += b[k] ?? 0;
    }
  };
  const childSeen = new Set();
  const roles = s.handoffs.map((h) => {
    let usage = agentUsage(h.runtime, h.session, home);
    let files = [];
    if (!usage && h.runtime === 'claude') {
      try {
        files = handoffFiles(h, indexNow(), first);
        if (files.length) {
          usage = claudeUsageOf(files.map((x) => x.file));
          usage.agentType = files[0].agentType;
        }
      } catch {
        usage = null;
      }
    }
    // Sub-agents its agent started (any depth), attributed to this handoff; each transcript counts once per attempt.
    const recorded = s.subagents.filter((c) => c.parentHandoff === hid(h.bundle)).map((c) => c.agentId);
    let children = [];
    try {
      const idx = files.length || recorded.length ? indexNow() : [];
      const found = descendants(idx, files.map((x) => x.agentId));
      children = [...found, ...idx.filter((x) => recorded.includes(x.agentId) && !found.some((y) => y.agentId === x.agentId))].filter((x) => !childSeen.has(x.agentId));
    } catch {}
    for (const c of children) childSeen.add(c.agentId);
    const childRows = children.map((c) => {
      let u = null;
      try {
        u = claudeUsageOf([c.file]);
      } catch {}
      const key = c.file;
      if (u && !counted.has(key)) {
        counted.add(key);
        addModels(u);
      }
      return { agentId: c.agentId, name: c.name, agentType: c.agentType, depth: c.spawnDepth, model: top(u?.models)[0] ?? null, outputTokens: u?.output ?? null, tokens: u ? u.input + u.output + u.cacheRead + u.cacheWrite : null, cost: u ? costOf(u, table).cost : null, unpricedModels: u ? costOf(u, table).unpriced : [] };
    });
    for (const n of recorded) if (!childRows.some((c) => c.agentId === n)) {
      const c = s.subagents.find((x) => x.agentId === n);
      childRows.push({ agentId: n, name: c?.name ?? null, agentType: c?.agentType ?? null, depth: c?.depth ?? null, model: null, outputTokens: null, tokens: null, cost: null, unpricedModels: [] });
    }
    const key = (usage?.transcripts ?? [`${h.runtime}:${h.session}`]).join('|');
    const firstUse = usage && !counted.has(key);
    if (firstUse) {
      counted.add(key);
      addModels(usage);
    }
    const observedEffort = top(usage?.efforts).join('/') || null;
    const priced = usage ? costOf(usage, table) : { cost: null, unpriced: [] };
    return {
      handoff: hid(h.bundle),
      at: h.at,
      role: h.role,
      agent: h.agent,
      runtime: h.runtime,
      session: h.session,
      work: h.work ?? null,
      class: h.class ?? null,
      declaredEffort: h.effort ?? null,
      observedEffort,
      // Shown, never enforced: the runtime may override an agent file's effort.
      effortMismatch: Boolean(h.effort && observedEffort && observedEffort !== h.effort),
      agentType: usage?.agentType ?? h.agentType ?? null,
      model: top(usage?.models)[0] ?? h.model ?? null,
      wallMinutes: usage?.first && usage?.last ? minutes(new Date(usage.last) - new Date(usage.first)) : null,
      // Wall time minus idle gaps of 5 minutes or more; rounds split where the agent was resumed with a new prompt.
      activeMinutes: usage?.first ? minutes(usage.activeMs ?? 0) : null,
      rounds: usage?.rounds?.length ?? null,
      roundDetail: usage?.rounds ?? [],
      // The owner session's model when the handoff was made (what an unpinned agent inherits), from the ledger.
      sessionModel: h.sessionModel ?? null,
      outputTokens: usage ? usage.output : null,
      tokens: usage ? usage.input + usage.output + usage.cacheRead + usage.cacheWrite : null,
      // A transcript shared with an earlier handoff (the same agent resumed) is counted there, not again here.
      sharedTranscript: Boolean(usage && !firstUse),
      cost: priced.cost,
      unpricedModels: priced.unpriced,
      children: childRows,
      childCost: childRows.some((c) => c.cost !== null) ? childRows.reduce((n, c) => n + (c.cost ?? 0), 0) : null,
      usage,
    };
  });
  const tokensByModel = Object.fromEntries(Object.entries(byModel).sort((a, b) => b[1].output - a[1].output).map(([m, b]) => {
    const p = priceOf(table, m);
    return [m, { ...b, total: b.input + b.output + b.cacheRead + b.cacheWrite, cost: p ? Math.round(modelCost(b, p) * 10000) / 10000 : null }];
  }));
  const tokens = Object.values(tokensByModel).reduce((n, b) => n + b.total, 0);
  const priced = Object.values(tokensByModel).filter((b) => b.cost !== null);
  const unpricedModels = Object.entries(tokensByModel).filter(([, b]) => b.cost === null && b.total > 0).map(([m]) => m);
  // Every model seen for this attempt: in agent transcripts and recorded in the ledger at plan, handoff and review.
  const observedModels = [...new Set([
    ...roles.flatMap((r) => Object.keys(r.usage?.models ?? {})),
    ...roles.flatMap((r) => r.children.map((c) => c.model)),
    ...s.handoffs.map((h) => h.sessionModel),
    s.planSource?.model,
    ...s.reviews.map((r) => r.reviewerModel),
  ].filter((m) => realModel(m)))].sort();

  // Review rounds and findings. A finding is one id in one round (a round's closure may be recorded twice: blind,
  // then with prior findings; its own findings cannot change between the two).
  const rounds = reviewRounds(entries, s);
  const recordedRounds = rounds.filter((r) => r.outcome === 'recorded');
  const allFindings = recordedRounds.flatMap((r) => r.findings.map((f) => ({ ...f, round: r.agent })));
  const severity = {};
  for (const f of allFindings) severity[f.severity ?? 'unrated'] = (severity[f.severity ?? 'unrated'] ?? 0) + 1;
  // A finding is settled when its own round marked it fixed or a non-issue, or a later round verified it so.
  const verified = new Set(recordedRounds.flatMap((r) => r.priorFindings.filter((p) => settledStatus(p.status)).map((p) => `${p.round}:${p.id}`)));
  const fixes = s.reviewRounds.flatMap((r) => r.fixes ?? []);
  const fixedIn = (f) => recordedRounds.flatMap((r) => r.priorFindings).find((p) => p.round === f.round && p.id === f.id && p.fixedIn)?.fixedIn ?? fixes.find((x) => x.round === f.round && x.id === f.id)?.commit ?? null;
  const findingRows = allFindings.map((f) => ({ ...f, settled: settledStatus(f.status) || verified.has(`${f.round}:${f.id}`), fixedIn: fixedIn(f) }));

  const tl = timeline(entries, { idleMinutes, state: s, rounds });
  const gateWindows = tl.gateWindows;
  const statusCount = (list, st) => list.filter((g) => g.status === st).length;
  const stops = s.stops.filter((x) => (x.kind ?? 'gate') === 'gate');
  const stopClasses = {};
  for (const x of stops) stopClasses[x.class ?? 'unclassified'] = (stopClasses[x.class ?? 'unclassified'] ?? 0) + 1;
  const failingTests = gates.flatMap((g) => (g.steps ?? []).filter((x) => x.status === 'failed').map((x) => ({ runId: g.runId, step: x.id, source: x.failures?.source ?? null, tests: x.failures?.tests ?? [], total: x.failures?.total ?? null, exitCodes: x.failures?.exitCodes ?? x.exitCodes ?? null, tail: x.failures?.tail ?? null })));

  const { end, phases: ph, idleGaps } = tl;
  const scope = s.scopeChanges.reduce((acc, x) => ({
    amendments: acc.amendments + 1,
    criteriaAdded: acc.criteriaAdded + (x.criteria?.added ?? 0),
    criteriaChanged: acc.criteriaChanged + (x.criteria?.changed ?? 0),
    criteriaDropped: acc.criteriaDropped + (x.criteria?.dropped ?? 0),
    endpoints: acc.endpoints + (x.endpoints ?? 0),
    errorCodes: acc.errorCodes + (x.errorCodes ?? 0),
    repos: acc.repos + (x.repos ?? x.addedRepos?.length ?? 0),
  }), { amendments: 0, criteriaAdded: 0, criteriaChanged: 0, criteriaDropped: 0, endpoints: 0, errorCodes: 0, repos: 0 });
  const frozenCount = entries.find((e) => e.type === 'criteria.frozen')?.data?.criteria?.length ?? null;

  return {
    id,
    item: s.item,
    lane: s.lane,
    phase: s.phase,
    admittedAt: first,
    endedAt: end,
    timeToGateMs: ms(first, gates[0]?.at),
    timeToDeliverMs: ms(first, s.delivery.completedAt),
    timeToCloseMs: ms(first, s.closedAt),
    phases: ph.minutes,
    wallMinutes: ph.totalMinutes,
    idleGaps,
    gateRuns: gates.length,
    gates: {
      started: gateWindows.length || gates.length,
      passed: statusCount(gates, 'passed'),
      failed: statusCount(gates, 'failed'),
      stopped: statusCount(gates, 'stopped'),
      recovered: statusCount(gates, 'recovered'),
      stops: stops.length,
      stopClasses,
      stoppedDuringReview: stops.filter((x) => x.reviewerOpen).length,
      discardedMinutes: Math.round(stops.reduce((n, x) => n + (x.discardedSeconds ?? (x.discardedMinutes ?? 0) * 60), 0) / 6) / 10,
      stepsRun: ran.length,
      stepsReused: reused.length,
      stepsPassed: steps.filter((x) => x.status === 'passed').length,
      stepsFailed: steps.filter((x) => x.status === 'failed').length,
      stepsInterrupted: steps.filter((x) => x.status === 'interrupted').length,
      stepsNotStarted: steps.filter((x) => x.status === 'not-started').length,
    },
    checks: { runs: s.checks.length, passed: statusCount(s.checks, 'passed'), failed: statusCount(s.checks, 'failed'), stopped: statusCount(s.checks, 'stopped') },
    failingTests,
    // Repair rounds: review rounds whose closure raised at least one finding to fix (not a verified non-issue).
    repairRounds: recordedRounds.filter((r) => r.findings.some((f) => f.status !== 'verified-nonissue')).length,
    gateFailures: statusCount(gates, 'failed'),
    stepRuns: ran.length,
    stepReused: reused.length,
    reuseRate: ran.length + reused.length ? reused.length / (ran.length + reused.length) : null,
    gateTimeMs: ran.reduce((n, x) => n + (x.durationMs ?? 0), 0),
    slowestSteps: [...ran].sort((a, b) => (b.durationMs ?? 0) - (a.durationMs ?? 0)).slice(0, 5).map((x) => ({ id: x.id, durationMs: x.durationMs, workers: x.workers })),
    reviewRounds: rounds.length,
    recordedRounds: recordedRounds.length,
    refusedRounds: rounds.filter((r) => r.outcome === 'refused').length,
    ...reviewDiagnostics(rounds),
    abandonedRounds: rounds.filter((r) => r.outcome === 'abandoned').length,
    // Rounds whose review left no recorded closure: refused (the tree moved, provenance, unread documents) or abandoned.
    wastedReviewerRounds: rounds.filter((r) => ['refused', 'abandoned'].includes(r.outcome)).length,
    wastedReviewerMinutes: Math.round(rounds.filter((r) => ['refused', 'abandoned'].includes(r.outcome)).reduce((n, r) => n + (r.minutes ?? 0), 0) * 10) / 10,
    roundsWithGreenGate: rounds.filter((r) => r.gatePassedOnTree).length,
    roundsOnUnsettledTree: rounds.filter((r) => r.openImplementers?.length).length,
    rounds,
    findings: findingRows.length,
    findingsBySeverity: severity,
    findingsOpen: findingRows.filter((f) => !f.settled).length,
    findingList: findingRows,
    // I-26: review findings about something the planner's impact map did not list (a direct measure of planning quality).
    // Counted once per finding per round, like `findings` (a round recorded blind and again with prior findings is one).
    impactGaps: findingRows.filter((f) => f.category === 'impact-gap').length,
    criteria: s.criteria?.length ?? 0,
    criteriaAtFreeze: frozenCount,
    criteriaAmendments: s.criteriaAmendments.length,
    scope,
    implementers: { opened: s.implementers.length, closed: s.implementers.filter((x) => x.closedAt).length, open: s.implementers.filter((x) => !x.closedAt).map((x) => x.agent) },
    holds: s.holds.length,
    roles,
    observedModels,
    tokensByModel,
    tokens,
    subagentTokens: roles.reduce((n, r) => n + r.children.reduce((m, c) => m + (c.tokens ?? 0), 0), 0),
    cost: priced.length ? Math.round(priced.reduce((n, b) => n + b.cost, 0) * 10000) / 10000 : null,
    unpricedModels,
  };
}

export function report(roots, { home = os.homedir(), idleMinutes = IDLE_REPORT_MINUTES } = {}) {
  const rows = [];
  let index = null;
  try {
    index = subagentIndex(home);
  } catch {}
  for (const root of roots) {
    const table = prices(root);
    for (const id of listAttempts(root)) rows.push({ project: path.basename(root), ...attemptReport(root, id, table, { home, index: index ?? [], idleMinutes }) });
  }
  return rows;
}

const HANDOFF_COLS = ['project', 'id', 'handoff', 'role', 'agent', 'runtime', 'work', 'class', 'declaredEffort', 'observedEffort', 'effortMismatch', 'agentType', 'model', 'sessionModel', 'wallMinutes', 'activeMinutes', 'rounds', 'outputTokens', 'cost', 'subagents', 'subagentCost'];
export const handoffRows = (rows) => rows.flatMap((r) => r.roles.map((h) => ({ project: r.project, id: r.id, ...h, subagents: h.children.length, subagentCost: h.childCost })));

const esc = (v) => (v === null || v === undefined ? '' : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));

export function toHandoffCsv(rows) {
  return [HANDOFF_COLS.join(','), ...handoffRows(rows).map((h) => HANDOFF_COLS.map((c) => esc(h[c])).join(','))].join('\n') + '\n';
}

const ATTEMPT_COLS = ['project', 'id', 'item', 'lane', 'phase', 'admittedAt', 'timeToGateMs', 'timeToDeliverMs', 'timeToCloseMs', 'wallMinutes', ...PHASES.map((p) => `${p}Minutes`), 'gateRuns', 'gatesPassed', 'gatesFailed', 'gatesStopped', 'repairRounds', 'reviewRounds', 'refusedRounds', 'roundsWithRefusal', 'failedLaunchRounds', 'failedStartRounds', 'unknownOutcomeRounds', 'wastedReviewerRounds', 'roundsWithGreenGate', 'stepRuns', 'stepReused', 'reuseRate', 'gateTimeMs', 'findings', 'findingsOpen', 'impactGaps', 'criteria', 'criteriaAmendments', 'holds', 'observedModels', 'tokens', 'subagentTokens', 'cost'];
export function toCsv(rows) {
  const flat = (r) => ({ ...r, ...Object.fromEntries(PHASES.map((p) => [`${p}Minutes`, r.phases?.[p] ?? null])), gatesPassed: r.gates?.passed, gatesFailed: r.gates?.failed, gatesStopped: r.gates?.stopped });
  return [ATTEMPT_COLS.join(','), ...rows.map(flat).map((r) => ATTEMPT_COLS.map((c) => esc(Array.isArray(r[c]) ? r[c].join(' ') : r[c])).join(','))].join('\n') + '\n';
}

// `wf report --json`: a stable, versioned shape. Fields are added in minor versions and never renamed or removed
// without a new `schema`; docs/telemetry.md lists every one. Transcript paths and raw usage are left out.
export const REPORT_SCHEMA = 'agentic-workflow/report@1';
export function toJson(rows) {
  return {
    schema: REPORT_SCHEMA,
    generatedAt: new Date().toISOString(),
    attempts: rows.map(({ roles, ...r }) => ({
      ...r,
      roles: roles.map(({ usage, ...h }) => ({ ...h, tokensByModel: usage?.byModel ?? {}, toolCalls: usage?.toolCalls ?? null })),
    })),
  };
}

const num = (v, d = 1) => (v === null || v === undefined ? '-' : Number(v).toFixed(d).replace(/\.0+$/, ''));
// The human summary `wf report` prints: per attempt, where the time went and what the rounds and gates did.
export function toText(rows) {
  if (!rows.length) return 'no attempts';
  const out = [];
  for (const r of rows) {
    out.push(`${r.project}/${r.id}  ${r.item ?? ''}  phase=${r.phase}  wall ${num(r.wallMinutes)} min`);
    out.push(`  phases (min): ${PHASES.map((p) => `${p} ${num(r.phases[p])}`).join(', ')}`);
    const g = r.gates;
    out.push(`  gates: ${g.started} started, ${g.passed} passed, ${g.failed} failed, ${g.stopped} stopped${g.recovered ? `, ${g.recovered} recovered` : ''}; steps ${g.stepsRun} run, ${g.stepsReused} reused, ${g.stepsInterrupted} interrupted; ${num(g.discardedMinutes)} min discarded by stops${g.stoppedDuringReview ? ` (${g.stoppedDuringReview} stopped while a reviewer was open)` : ''}${Object.keys(g.stopClasses).length ? `; stop reasons: ${Object.entries(g.stopClasses).map(([k, v]) => `${k} ${v}`).join(', ')}` : ''}`);
    out.push(`  review: ${r.reviewRounds} handoff(s), ${r.recordedRounds} recorded, ${r.roundsWithRefusal} experienced refusal, ${r.failedLaunchRounds} failed launch(es) (${r.failedStartRounds} before session start), ${r.unknownOutcomeRounds} unknown outcome(s); ${r.roundsWithGreenGate} on a tree with a passing gate; ${r.repairRounds} repair round(s)`);
    if (Object.keys(r.refusalReasons).length) out.push(`  review refusal reasons: ${Object.entries(r.refusalReasons).map(([reason, count]) => `${reason} ${count}`).join(', ')}`);
    out.push(`  findings: ${r.findings}${Object.keys(r.findingsBySeverity).length ? ` (${Object.entries(r.findingsBySeverity).map(([k, v]) => `${k} ${v}`).join(', ')})` : ''}, ${r.findingsOpen} not yet verified fixed`);
    if (r.scope.amendments) out.push(`  scope: ${r.scope.amendments} amendment(s): criteria ${r.criteriaAtFreeze ?? '?'} -> ${r.criteria} (+${r.scope.criteriaAdded}, ${r.scope.criteriaChanged} changed, -${r.scope.criteriaDropped}); endpoints +${r.scope.endpoints}, error codes +${r.scope.errorCodes}, repos +${r.scope.repos}`);
    const models = Object.entries(r.tokensByModel);
    if (models.length) out.push(`  tokens by model: ${models.map(([m, b]) => `${m} ${b.total} (out ${b.output}${b.cost !== null ? `, $${b.cost.toFixed(2)}` : ''})`).join('; ')}`);
    out.push(`  cost: ${r.cost === null ? 'unknown' : `$${r.cost.toFixed(2)}`}${r.unpricedModels.length ? ` (no price for ${r.unpricedModels.join(', ')})` : ''}; sub-agent tokens ${r.subagentTokens}`);
    if (r.failingTests.length) for (const f of r.failingTests.slice(0, 10)) out.push(`  failed ${f.step} (${f.runId}): ${f.tests.length ? `${f.tests.slice(0, 5).join(' | ')}${f.total > 5 ? ` … ${f.total - 5} more` : ''}` : `exit ${(f.exitCodes ?? []).join(',') || '?'}${f.tail?.length ? `: ${f.tail.at(-1)}` : ''}`}`);
    for (const x of r.idleGaps.slice(0, 5)) out.push(`  idle ${num(x.minutes)} min (${x.phase}): ${x.from} -> ${x.to} (after ${x.after})`);
  }
  return out.join('\n');
}

const html = (v) => String(v ?? '—').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

function handoffTable(rows) {
  const hs = handoffRows(rows);
  if (!hs.length) return '';
  const head = ['Attempt', 'Role', 'Agent', 'Work', 'Class', 'Effort declared', 'Effort observed', 'Agent type', 'Model', 'Session model', 'Wall min', 'Active min', 'Rounds', 'Output tokens', 'Cost', 'Sub-agents'];
  const body = hs.map((h) => `<tr><td>${html(h.id)}</td><td>${html(h.role)}</td><td>${html(h.agent)}</td><td>${html(h.work)}</td><td>${html(h.class)}</td><td>${html(h.declaredEffort)}</td><td>${html(h.observedEffort)}${h.effortMismatch ? ' <strong>(differs)</strong>' : ''}</td><td>${html(h.agentType)}</td><td>${html(h.model)}</td><td>${html(h.sessionModel)}</td><td>${html(h.wallMinutes)}</td><td>${html(h.activeMinutes)}</td><td>${html(h.rounds)}</td><td>${html(h.outputTokens)}</td><td>${h.cost === null ? '—' : `$${h.cost.toFixed(2)}`}</td><td>${html(h.subagents)}</td></tr>`).join('\n');
  return `<h2>Agents</h2><table><tr>${head.map((x) => `<th>${x}</th>`).join('')}</tr>${body}</table>`;
}

export function toHtml(rows) {
  const fmt = (v) => (v === null || v === undefined ? '—' : typeof v === 'number' ? (v > 1000 && Number.isInteger(v) ? `${(v / 60000).toFixed(1)} min` : v.toFixed?.(2) ?? v) : v);
  const head = ['Project', 'Attempt', 'Lane', 'Phase', 'To gate', 'To deliver', 'Gate runs', 'Stopped', 'Review handoffs', 'Refusal handoffs', 'Failed launches', 'Unknown outcomes', 'Repairs', 'Reuse', 'Gate time', 'Findings', 'Tokens', 'Cost'];
  const body = rows.map((r) => `<tr><td>${html(r.project)}</td><td>${html(r.id)}</td><td>${html(r.lane)}</td><td>${html(r.phase)}</td><td>${fmt(r.timeToGateMs)}</td><td>${fmt(r.timeToDeliverMs)}</td><td>${r.gateRuns}</td><td>${r.gates.stopped}</td><td>${r.reviewRounds}</td><td>${r.roundsWithRefusal}</td><td>${r.failedLaunchRounds}</td><td>${r.unknownOutcomeRounds}</td><td>${r.repairRounds}</td><td>${r.reuseRate === null ? '—' : `${Math.round(r.reuseRate * 100)}%`}</td><td>${fmt(r.gateTimeMs)}</td><td>${r.findings}</td><td>${r.tokens || '—'}</td><td>${r.cost === null ? '—' : `$${r.cost.toFixed(2)}`}</td></tr>`).join('\n');
  const phaseHead = ['Attempt', ...PHASES];
  const phaseBody = rows.map((r) => `<tr><td>${html(r.id)}</td>${PHASES.map((p) => `<td>${html(r.phases[p])}</td>`).join('')}</tr>`).join('\n');
  return `<!doctype html><meta charset="utf-8"><title>agentic-workflow report</title><style>body{font:14px system-ui;margin:24px;color:#1b2228;background:#fff}table{border-collapse:collapse}td,th{padding:6px 10px;border-bottom:1px solid #ddd;text-align:left;font-variant-numeric:tabular-nums}th{font-size:12px;text-transform:uppercase;color:#5b6770}@media(prefers-color-scheme:dark){body{background:#12171b;color:#e3e8eb}td,th{border-color:#2a343b}}</style><h1>agentic-workflow report</h1><p>${rows.length} attempt(s), generated ${new Date().toISOString()}</p><table><tr>${head.map((h) => `<th>${h}</th>`).join('')}</tr>${body}</table><h2>Minutes per phase</h2><table><tr>${phaseHead.map((h) => `<th>${h}</th>`).join('')}</tr>${phaseBody}</table>${handoffTable(rows)}`;
}
