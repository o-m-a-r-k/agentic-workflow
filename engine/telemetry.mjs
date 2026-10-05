import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { listAttempts, readLedger, reduce } from './ledger.mjs';
import { YAML } from './util.mjs';

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

// Reads Claude Code transcript files. A response split over several lines (one per content block) repeats its usage
// with a growing output count, so each request counts once, at its largest.
function claudeUsageOf(files) {
  const u = { runtime: 'claude', models: {}, efforts: {}, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, toolCalls: 0, first: null, last: null, transcripts: files };
  const requests = new Map();
  for (const f of files) {
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
      const m = e.message;
      if (m?.usage) {
        const key = e.requestId ?? `${f}:${e.uuid ?? requests.size}`;
        const prev = requests.get(key);
        if (!prev || (m.usage.output_tokens ?? 0) >= (prev.usage.output_tokens ?? 0)) requests.set(key, { usage: m.usage, model: m.model, effort: e.effort ?? null });
      }
      if (Array.isArray(m?.content)) u.toolCalls += m.content.filter((c) => c.type === 'tool_use').length;
    }
  }
  for (const r of requests.values()) {
    if (r.model) u.models[r.model] = (u.models[r.model] ?? 0) + 1;
    if (r.effort) u.efforts[r.effort] = (u.efforts[r.effort] ?? 0) + 1;
    u.input += r.usage.input_tokens ?? 0;
    u.output += r.usage.output_tokens ?? 0;
    u.cacheRead += r.usage.cache_read_input_tokens ?? 0;
    u.cacheWrite += r.usage.cache_creation_input_tokens ?? 0;
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
function subagentIndex(home) {
  const out = [];
  for (const f of walk(path.join(home, '.claude', 'projects'))) {
    if (path.basename(path.dirname(f)) !== 'subagents') continue;
    const meta = f.replace(/\.jsonl$/, '.meta.json');
    try {
      const m = JSON.parse(fs.readFileSync(meta, 'utf8'));
      if (m?.name) out.push({ file: f, name: m.name, agentType: m.agentType ?? null });
    } catch {}
  }
  return out;
}

function subagentUsage(h, index, since) {
  // Same name and agent type, and active after the attempt was admitted: an older run under a reused name is not it.
  const files = index
    .filter((x) => x.name === h.agent && (h.agentType ? x.agentType === h.agentType : /^wf-/.test(x.agentType ?? '')))
    .map((x) => x.file)
    .filter((f) => {
      try {
        return !since || fs.statSync(f).mtime >= new Date(since);
      } catch {
        return false;
      }
    });
  if (!files.length) return null;
  const u = claudeUsageOf(files);
  u.agentType = index.find((x) => x.file === files[0]).agentType;
  return u;
}

function codexUsage(session, home) {
  const files = walk(path.join(home, '.codex', 'sessions')).filter((f) => f.includes(session));
  if (!files.length) return null;
  const u = { runtime: 'codex', models: {}, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, toolCalls: 0, first: null, last: null };
  for (const f of files) {
    let last = null;
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
      if (p.type === 'function_call' || p.type === 'custom_tool_call') u.toolCalls += 1;
      if (p.model) u.models[p.model] = (u.models[p.model] ?? 0) + 1;
    }
    if (last) {
      u.input += last.input_tokens ?? 0;
      u.cacheRead += last.cached_input_tokens ?? 0;
      u.output += last.output_tokens ?? 0;
      u.reasoning += last.reasoning_output_tokens ?? 0;
    }
  }
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

const top = (counts) => Object.entries(counts ?? {}).sort((a, b) => b[1] - a[1]).map(([k]) => k);

function prices() {
  const file = path.join(process.env.WF_CONFIG_HOME ?? path.join(os.homedir(), '.config', 'agentic-workflow'), 'prices.yaml');
  if (!fs.existsSync(file)) return {};
  return YAML.parse(fs.readFileSync(file, 'utf8')) ?? {};
}

function cost(usage, table) {
  const model = Object.keys(usage.models)[0];
  const p = table[model];
  if (!p) return null;
  const per = (n, price) => (n * (price ?? 0)) / 1e6;
  return per(usage.input, p.input) + per(usage.output + (usage.reasoning ?? 0), p.output) + per(usage.cacheRead, p.cacheRead ?? p.input) + per(usage.cacheWrite, p.cacheWrite ?? p.input);
}

const ms = (a, b) => (a && b ? new Date(b) - new Date(a) : null);

export function attemptReport(root, id, table = prices(), { home = os.homedir(), index } = {}) {
  const entries = readLedger(root, id);
  const s = reduce(entries);
  const first = entries[0]?.at;
  const at = (type) => entries.find((e) => e.type === type)?.at ?? null;
  const gates = s.gates.filter((g) => !g.carriedFrom);
  const steps = gates.flatMap((g) => g.steps ?? []);
  const ran = steps.filter((x) => ['passed', 'failed', 'interrupted'].includes(x.status));
  const reused = steps.filter((x) => x.status === 'reused');
  let subagents = index;
  const roles = s.handoffs.map((h) => {
    let usage = agentUsage(h.runtime, h.session, home);
    if (!usage && h.runtime === 'claude') {
      try {
        subagents ??= subagentIndex(home);
        usage = subagentUsage(h, subagents, first);
      } catch {
        usage = null;
      }
    }
    const observedEffort = top(usage?.efforts).join('/') || null;
    return {
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
      wallMinutes: usage?.first && usage?.last ? Math.round((new Date(usage.last) - new Date(usage.first)) / 6000) / 10 : null,
      outputTokens: usage ? usage.output : null,
      usage,
      cost: usage ? cost(usage, table) : null,
    };
  });
  // A repair round continues the same agent, so several handoffs can share one transcript: count each once.
  const counted = new Set();
  const tokens = roles.reduce((n, r) => {
    if (!r.usage) return n;
    const key = (r.usage.transcripts ?? [`${r.runtime}:${r.session}`]).join('|');
    if (counted.has(key)) return n;
    counted.add(key);
    return n + r.usage.input + r.usage.output + r.usage.cacheRead + r.usage.cacheWrite;
  }, 0);
  return {
    id,
    item: s.item,
    lane: s.lane,
    phase: s.phase,
    admittedAt: first,
    timeToGateMs: ms(first, gates[0]?.at),
    timeToDeliverMs: ms(first, s.delivery.completedAt),
    timeToCloseMs: ms(first, s.closedAt),
    gateRuns: gates.length,
    repairRounds: gates.filter((g) => g.status === 'failed').length,
    stepRuns: ran.length,
    stepReused: reused.length,
    reuseRate: ran.length + reused.length ? reused.length / (ran.length + reused.length) : null,
    gateTimeMs: ran.reduce((n, x) => n + (x.durationMs ?? 0), 0),
    slowestSteps: [...ran].sort((a, b) => (b.durationMs ?? 0) - (a.durationMs ?? 0)).slice(0, 5).map((x) => ({ id: x.id, durationMs: x.durationMs, workers: x.workers })),
    findings: s.review?.closure.findings.length ?? 0,
    criteria: s.criteria?.length ?? 0,
    criteriaAmendments: s.criteriaAmendments.length,
    holds: s.holds.length,
    roles,
    tokens,
    cost: roles.some((r) => r.cost !== null) ? roles.reduce((n, r) => n + (r.cost ?? 0), 0) : null,
  };
}

export function report(roots, { home = os.homedir() } = {}) {
  const rows = [];
  let index = null;
  try {
    index = subagentIndex(home);
  } catch {}
  for (const root of roots) for (const id of listAttempts(root)) rows.push({ project: path.basename(root), ...attemptReport(root, id, prices(), { home, index: index ?? [] }) });
  return rows;
}

const HANDOFF_COLS = ['project', 'id', 'role', 'agent', 'runtime', 'work', 'class', 'declaredEffort', 'observedEffort', 'effortMismatch', 'agentType', 'model', 'wallMinutes', 'outputTokens', 'cost'];
export const handoffRows = (rows) => rows.flatMap((r) => r.roles.map((h) => ({ project: r.project, id: r.id, ...h })));

const esc = (v) => (v === null || v === undefined ? '' : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));

export function toHandoffCsv(rows) {
  return [HANDOFF_COLS.join(','), ...handoffRows(rows).map((h) => HANDOFF_COLS.map((c) => esc(h[c])).join(','))].join('\n') + '\n';
}

export function toCsv(rows) {
  const cols = ['project', 'id', 'item', 'lane', 'phase', 'admittedAt', 'timeToGateMs', 'timeToDeliverMs', 'timeToCloseMs', 'gateRuns', 'repairRounds', 'stepRuns', 'stepReused', 'reuseRate', 'gateTimeMs', 'findings', 'criteria', 'criteriaAmendments', 'holds', 'tokens', 'cost'];
  return [cols.join(','), ...rows.map((r) => cols.map((c) => esc(r[c])).join(','))].join('\n') + '\n';
}

const html = (v) => String(v ?? '—').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

function handoffTable(rows) {
  const hs = handoffRows(rows);
  if (!hs.length) return '';
  const head = ['Attempt', 'Role', 'Agent', 'Work', 'Class', 'Effort declared', 'Effort observed', 'Agent type', 'Model', 'Wall min', 'Output tokens'];
  const body = hs.map((h) => `<tr><td>${html(h.id)}</td><td>${html(h.role)}</td><td>${html(h.agent)}</td><td>${html(h.work)}</td><td>${html(h.class)}</td><td>${html(h.declaredEffort)}</td><td>${html(h.observedEffort)}${h.effortMismatch ? ' <strong>(differs)</strong>' : ''}</td><td>${html(h.agentType)}</td><td>${html(h.model)}</td><td>${html(h.wallMinutes)}</td><td>${html(h.outputTokens)}</td></tr>`).join('\n');
  return `<h2>Agents</h2><table><tr>${head.map((x) => `<th>${x}</th>`).join('')}</tr>${body}</table>`;
}

export function toHtml(rows) {
  const fmt = (v) => (v === null || v === undefined ? '—' : typeof v === 'number' ? (v > 1000 && Number.isInteger(v) ? `${(v / 60000).toFixed(1)} min` : v.toFixed?.(2) ?? v) : v);
  const head = ['Project', 'Attempt', 'Lane', 'Phase', 'To gate', 'To deliver', 'Gate runs', 'Repairs', 'Reuse', 'Gate time', 'Findings', 'Tokens', 'Cost'];
  const body = rows.map((r) => `<tr><td>${r.project}</td><td>${r.id}</td><td>${r.lane}</td><td>${r.phase}</td><td>${fmt(r.timeToGateMs)}</td><td>${fmt(r.timeToDeliverMs)}</td><td>${r.gateRuns}</td><td>${r.repairRounds}</td><td>${r.reuseRate === null ? '—' : `${Math.round(r.reuseRate * 100)}%`}</td><td>${fmt(r.gateTimeMs)}</td><td>${r.findings}</td><td>${r.tokens || '—'}</td><td>${r.cost === null ? '—' : `$${r.cost.toFixed(2)}`}</td></tr>`).join('\n');
  return `<!doctype html><meta charset="utf-8"><title>agentic-workflow report</title><style>body{font:14px system-ui;margin:24px;color:#1b2228;background:#fff}table{border-collapse:collapse}td,th{padding:6px 10px;border-bottom:1px solid #ddd;text-align:left;font-variant-numeric:tabular-nums}th{font-size:12px;text-transform:uppercase;color:#5b6770}@media(prefers-color-scheme:dark){body{background:#12171b;color:#e3e8eb}td,th{border-color:#2a343b}}</style><h1>agentic-workflow report</h1><p>${rows.length} attempt(s), generated ${new Date().toISOString()}</p><table><tr>${head.map((h) => `<th>${h}</th>`).join('')}</tr>${body}</table>${handoffTable(rows)}`;
}
