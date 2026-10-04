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

function claudeUsage(session) {
  const base = path.join(os.homedir(), '.claude', 'projects');
  const files = walk(base).filter((f) => path.basename(f, '.jsonl') === session || path.basename(f, '.jsonl') === `agent-${session}`);
  if (!files.length) return null;
  const u = { runtime: 'claude', models: {}, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, toolCalls: 0, first: null, last: null };
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
        u.models[m.model] = (u.models[m.model] ?? 0) + 1;
        u.input += m.usage.input_tokens ?? 0;
        u.output += m.usage.output_tokens ?? 0;
        u.cacheRead += m.usage.cache_read_input_tokens ?? 0;
        u.cacheWrite += m.usage.cache_creation_input_tokens ?? 0;
      }
      if (Array.isArray(m?.content)) u.toolCalls += m.content.filter((c) => c.type === 'tool_use').length;
    }
  }
  return u;
}

function codexUsage(session) {
  const files = walk(path.join(os.homedir(), '.codex', 'sessions')).filter((f) => f.includes(session));
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

export function agentUsage(runtime, session) {
  if (!session) return null;
  try {
    if (runtime === 'claude') return claudeUsage(session);
    if (runtime === 'codex') return codexUsage(session);
  } catch {
    return null;
  }
  return null;
}

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

export function attemptReport(root, id, table = prices()) {
  const entries = readLedger(root, id);
  const s = reduce(entries);
  const first = entries[0]?.at;
  const at = (type) => entries.find((e) => e.type === type)?.at ?? null;
  const gates = s.gates.filter((g) => !g.carriedFrom);
  const steps = gates.flatMap((g) => g.steps ?? []);
  const ran = steps.filter((x) => ['passed', 'failed', 'interrupted'].includes(x.status));
  const reused = steps.filter((x) => x.status === 'reused');
  const roles = s.handoffs.map((h) => {
    const usage = agentUsage(h.runtime, h.session);
    return { role: h.role, agent: h.agent, runtime: h.runtime, session: h.session, usage, cost: usage ? cost(usage, table) : null };
  });
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
    tokens: roles.reduce((n, r) => n + (r.usage ? r.usage.input + r.usage.output + r.usage.cacheRead + r.usage.cacheWrite : 0), 0),
    cost: roles.some((r) => r.cost !== null) ? roles.reduce((n, r) => n + (r.cost ?? 0), 0) : null,
  };
}

export function report(roots) {
  const rows = [];
  for (const root of roots) for (const id of listAttempts(root)) rows.push({ project: path.basename(root), ...attemptReport(root, id) });
  return rows;
}

export function toCsv(rows) {
  const cols = ['project', 'id', 'item', 'lane', 'phase', 'admittedAt', 'timeToGateMs', 'timeToDeliverMs', 'timeToCloseMs', 'gateRuns', 'repairRounds', 'stepRuns', 'stepReused', 'reuseRate', 'gateTimeMs', 'findings', 'criteria', 'criteriaAmendments', 'holds', 'tokens', 'cost'];
  const esc = (v) => (v === null || v === undefined ? '' : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
  return [cols.join(','), ...rows.map((r) => cols.map((c) => esc(r[c])).join(','))].join('\n') + '\n';
}

export function toHtml(rows) {
  const fmt = (v) => (v === null || v === undefined ? '—' : typeof v === 'number' ? (v > 1000 && Number.isInteger(v) ? `${(v / 60000).toFixed(1)} min` : v.toFixed?.(2) ?? v) : v);
  const head = ['Project', 'Attempt', 'Lane', 'Phase', 'To gate', 'To deliver', 'Gate runs', 'Repairs', 'Reuse', 'Gate time', 'Findings', 'Tokens', 'Cost'];
  const body = rows.map((r) => `<tr><td>${r.project}</td><td>${r.id}</td><td>${r.lane}</td><td>${r.phase}</td><td>${fmt(r.timeToGateMs)}</td><td>${fmt(r.timeToDeliverMs)}</td><td>${r.gateRuns}</td><td>${r.repairRounds}</td><td>${r.reuseRate === null ? '—' : `${Math.round(r.reuseRate * 100)}%`}</td><td>${fmt(r.gateTimeMs)}</td><td>${r.findings}</td><td>${r.tokens || '—'}</td><td>${r.cost === null ? '—' : `$${r.cost.toFixed(2)}`}</td></tr>`).join('\n');
  return `<!doctype html><meta charset="utf-8"><title>agentic-workflow report</title><style>body{font:14px system-ui;margin:24px;color:#1b2228;background:#fff}table{border-collapse:collapse}td,th{padding:6px 10px;border-bottom:1px solid #ddd;text-align:left;font-variant-numeric:tabular-nums}th{font-size:12px;text-transform:uppercase;color:#5b6770}@media(prefers-color-scheme:dark){body{background:#12171b;color:#e3e8eb}td,th{border-color:#2a343b}}</style><h1>agentic-workflow report</h1><p>${rows.length} attempt(s), generated ${new Date().toISOString()}</p><table><tr>${head.map((h) => `<th>${h}</th>`).join('')}</tr>${body}</table>`;
}
