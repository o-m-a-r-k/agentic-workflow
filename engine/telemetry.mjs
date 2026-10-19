// Telemetry (design-0.8 section 7): one `wf-ticket@1` row per attempt, rebuilt from the ledger, git and the host
// transcripts, stored in `<user folder>/telemetry/<project>.jsonl`; `wf report` shows medians per project and engine
// version and lists the commits on each base that no attempt covers.
//
// Named failure: fifty tickets were measured by hand because nothing recorded where the time went (most of it idle,
// a sixth of the idle from the plugin stopping agents), and learning (section 8) judges every change against these rows.
import fs from 'node:fs';
import path from 'node:path';
import { CONTRACT_VERSION, WfError, branchName, changedFiles, loadAdapter, sessionActivity, userDir } from './contract.mjs';
import { attemptState, foldEntries, isSchema1, listAttempts, nowMs, readEvents, splitId } from './ledger.mjs';
import { blameToAttempt, commitTime, repoView } from './introduced.mjs';
import { readRefusals, refusalCounts } from './refusals.mjs';
import { legacyRollup, legacyRow } from './legacy07.mjs';
import { matchesAny, run } from './util.mjs';

export const ROW_SCHEMA = 'wf-ticket@1';
// Activity closer than this is one stretch of work (design section 7, `activeMin`). The design's number, not a tuning knob.
export const GAP_MIN = 30;
const REWORK_HOURS = 48;

// ---------------------------------------------------------------------------------------------------------------------
// Time arithmetic
// ---------------------------------------------------------------------------------------------------------------------

export const minutes = (ms) => Math.round(ms / 6000) / 10;
const t = (iso) => (iso ? Date.parse(iso) : NaN);

// Union of [from, to] intervals (ms), clipped to [lo, hi].
export function union(intervals, lo = -Infinity, hi = Infinity) {
  const xs = intervals.map(([a, b]) => [Math.max(a, lo), Math.min(b, hi)]).filter(([a, b]) => Number.isFinite(a) && Number.isFinite(b) && b > a).sort((x, y) => x[0] - y[0]);
  const out = [];
  for (const [a, b] of xs) {
    const last = out.at(-1);
    if (last && a <= last[1]) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out;
}
export const total = (intervals) => intervals.reduce((s, [a, b]) => s + (b - a), 0);

// The parts of [a, b] no interval covers.
function uncovered(a, b, covered) {
  const out = [];
  let cur = a;
  for (const [x, y] of covered) {
    if (y <= cur || x >= b) continue;
    if (x > cur) out.push([cur, x]);
    cur = Math.max(cur, y);
  }
  if (cur < b) out.push([cur, b]);
  return out;
}

// Active time and unexplained gaps from activity points (ms) and the intervals that explain idle time (a pending
// decision, a hold, a stage waiting, a test or review running).
export function activityOf(points, explained, start, end) {
  const ps = [...new Set([start, ...points.filter((p) => p >= start && p <= end), end])].sort((a, b) => a - b);
  const cover = union(explained, start, end);
  let active = 0;
  const gaps = [];
  for (let i = 1; i < ps.length; i++) {
    const gap = ps[i] - ps[i - 1];
    if (gap <= GAP_MIN * 60000) {
      active += gap;
      continue;
    }
    for (const [a, b] of uncovered(ps[i - 1], ps[i], cover)) {
      if (b - a > GAP_MIN * 60000) gaps.push({ from: new Date(a).toISOString(), to: new Date(b).toISOString(), min: minutes(b - a) });
    }
  }
  return { activeMin: minutes(active), unexplainedGaps: gaps };
}

// ---------------------------------------------------------------------------------------------------------------------
// Sessions (host transcripts, stream 4)
// ---------------------------------------------------------------------------------------------------------------------

// A session as 0.8 records it ({ runtime, id }) or as 0.7 did ("runtime:id").
export function asSession(s) {
  if (!s) return null;
  if (typeof s === 'object' && s.runtime && s.id) return { runtime: String(s.runtime), id: String(s.id) };
  if (typeof s === 'string') {
    const i = s.indexOf(':');
    return i > 0 ? { runtime: s.slice(0, i), id: s.slice(i + 1) } : null;
  }
  return null;
}

// Turns, tokens and cost of every session, from the host's transcripts. A session the host cannot read adds nothing.
export async function sessionsActivity(sessions) {
  const seen = new Map();
  for (const s of sessions.map(asSession).filter(Boolean)) seen.set(`${s.runtime}:${s.id}`, s);
  const tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  let cost = null;
  const turns = [];
  for (const s of seen.values()) {
    let a = null;
    try {
      a = await sessionActivity(s);
    } catch {
      a = null;
    }
    if (!a) continue;
    for (const turn of a.turns ?? []) turns.push(t(turn.at));
    for (const k of Object.keys(tokens)) tokens[k] += a.tokens?.[k] ?? 0;
    if (typeof a.cost === 'number') cost = (cost ?? 0) + a.cost;
  }
  return { turns: turns.filter(Number.isFinite), tokens, cost };
}

// ---------------------------------------------------------------------------------------------------------------------
// Git facts
// ---------------------------------------------------------------------------------------------------------------------

const gitOut = (cwd, args, input) => {
  const r = run('git', args, { cwd, allowFail: true, input });
  return r.status === 0 ? r.stdout : null;
};
export const refExists = (cwd, ref) => run('git', ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { cwd, allowFail: true }).status === 0;

// The base ref a repo checkout knows best: the remote-tracking branch when there is one, else the local branch.
export function baseRef(cwd, spec) {
  for (const ref of [`refs/remotes/${spec.remote ?? 'origin'}/${spec.base}`, `refs/heads/${spec.base}`]) if (refExists(cwd, ref)) return ref;
  return null;
}

// sha → patch-id for the non-merge commits `revArgs` names.
export function patchIds(cwd, revArgs) {
  const log = gitOut(cwd, ['log', '-p', '--no-merges', '--format=commit %H', ...revArgs]);
  const out = new Map();
  if (!log) return out;
  const ids = gitOut(cwd, ['patch-id', '--stable'], log) ?? '';
  for (const line of ids.split('\n').filter(Boolean)) {
    const [pid, sha] = line.split(' ');
    out.set(sha, pid);
  }
  return out;
}

// The attempt's own commits on `branch`: everything not reachable from the base it started from or merged in.
export const ownRange = (state, repo, branch) => [branch, ...[state.repos?.[repo]?.baseSha, ...(state.baseUpdates ?? []).filter((u) => u.repo === repo).map((u) => u.to)].filter(Boolean).map((b) => `^${b}`)];

const revList = (cwd, args) => (gitOut(cwd, ['rev-list', ...args]) ?? '').split('\n').filter(Boolean);

// Line authors of a file at a commit: sha per line.
function blameFile(cwd, commit, file) {
  const out = gitOut(cwd, ['blame', '--porcelain', commit, '--', file]);
  if (out === null) return [];
  return out.split('\n').filter((l) => /^[0-9a-f]{40} \d+ \d+/.test(l)).map((l) => l.slice(0, 40));
}

// ---------------------------------------------------------------------------------------------------------------------
// Row values
// ---------------------------------------------------------------------------------------------------------------------

// A row field as one number: dotted paths (`rework.share`), arrays by length, records of numbers by sum, booleans as 0/1.
// null when the row does not hold it.
export function metricValue(row, metric) {
  let v = row;
  for (const k of String(metric).split('.')) v = v == null ? undefined : v[k];
  if (v === undefined || v === null) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (Array.isArray(v)) return v.length;
  if (typeof v === 'object') {
    const nums = Object.values(v).filter((x) => typeof x === 'number');
    return nums.length || !Object.keys(v).length ? nums.reduce((a, b) => a + b, 0) : null;
  }
  return null;
}

export function median(xs) {
  const v = xs.filter((x) => typeof x === 'number' && Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}

// Every row field `wf report` takes a median of.
export const REPORT_METRICS = ['wallMin', 'activeMin', 'unexplainedGaps', 'personWaitMin', 'holdMin', 'stageWaitMin', 'reviews', 'blockingReviews', 'emptyReviews', 'fixRounds', 'testRuns.fast', 'testRuns.full', 'testMin', 'landing.batches', 'landing.bisects', 'diff.product', 'diff.tests', 'diff.other', 'findings.goal', 'findings.regression', 'findings.other', 'findings.filed', 'findings.digested', 'introducedByRepair', 'refusals.count', 'screens', 'rework.lines', 'rework.share', 'rework.commits', 'cost'];

export function emptyRow() {
  return {
    schema: ROW_SCHEMA, project: null, item: null, attempt: null, engine: null, outcome: null, outsideStages: null,
    start: null, end: null, wallMin: null, activeMin: null, unexplainedGaps: null, personWaitMin: null, holdMin: null, stageWaitMin: null,
    reviews: null, blockingReviews: null, emptyReviews: null, fixRounds: null, coverage: null,
    testRuns: null, testMin: null, landing: null, diff: null, findings: null, introducedByRepair: null,
    refusals: null, screens: null, riskTouched: null, rework: null, tokens: null, cost: null,
  };
}

// The project's name and adapter. Without a loadable adapter (a 0.7 project not yet onboarded) the name is the root
// folder's: telemetry stays in the person's user folder, so an old project name never leaves the machine.
export async function projectName(root) {
  try {
    const adapter = await loadAdapter(root);
    return { name: adapter.name, adapter };
  } catch {
    return { name: path.basename(path.resolve(root)), adapter: null };
  }
}

// Stage waits: from a stage's first `waiting`/`pending` result to its next `done`/`skipped` (or the end), per index.
function stageWaits(events, end) {
  const open = new Map();
  const spans = [];
  for (const e of events) {
    const at = t(e.at);
    if (e.state === 'waiting' || e.state === 'pending') {
      if (!open.has(e.index)) open.set(e.index, { from: at, do: e.do });
    } else if (typeof e.waitedMin === 'number') {
      // The stage's own measure of its wait (stream 3) wins over the span between its events.
      spans.push({ do: e.do, from: at - e.waitedMin * 60000, to: at });
      open.delete(e.index);
    } else if (open.has(e.index)) {
      const o = open.get(e.index);
      spans.push({ do: o.do, from: o.from, to: at });
      open.delete(e.index);
    }
  }
  for (const o of open.values()) spans.push({ do: o.do, from: o.from, to: end });
  return spans;
}

// Lines this delivery wrote that a later commit not belonging to its ticket rewrote, 48 hours after delivery.
async function reworkOf(root, state, adapter, deliveredAt) {
  if (!adapter || !Number.isFinite(deliveredAt) || nowMs() < deliveredAt + REWORK_HOURS * 3600000) return null;
  const cutoffIso = new Date(deliveredAt + REWORK_HOURS * 3600000).toISOString();
  const sinceIso = new Date(deliveredAt).toISOString();
  // Every attempt of the item belongs to the ticket.
  const siblings = [];
  for (const id of await listAttempts(root, { item: state.item })) {
    try {
      const s = await attemptState(root, id);
      if (s.schema === 2) siblings.push(s);
    } catch {
      // an unreadable sibling contributes no commits
    }
  }
  let written = 0, rewritten = 0;
  const commits = new Set();
  for (const [repo, r] of Object.entries(state.repos ?? {})) {
    const spec = adapter.repos.find((x) => x.name === repo);
    if (!spec) continue;
    const cwd = path.join(root, spec.path);
    if (!fs.existsSync(cwd)) continue;
    const base = baseRef(cwd, { ...spec, base: r.base ?? spec.base });
    const branch = r.branch ?? branchName(state.id);
    if (!base || !refExists(cwd, branch)) continue;
    const lastBase = [r.baseSha, ...(state.baseUpdates ?? []).filter((u) => u.repo === repo).map((u) => u.to)].filter(Boolean).at(-1);
    if (!lastBase) continue;
    const own = new Set();
    const ownPids = new Set();
    for (const s of siblings) {
      const sr = s.repos?.[repo];
      const sb = sr?.branch ?? branchName(s.id);
      if (!sr?.baseSha || !refExists(cwd, sb)) continue;
      const range = ownRange(s, repo, sb);
      for (const [sha, pid] of patchIds(cwd, range)) {
        own.add(sha);
        ownPids.add(pid);
      }
      for (const sha of revList(cwd, range)) own.add(sha);
    }
    const cutoff = revList(cwd, ['-1', `--before=${cutoffIso}`, base])[0];
    if (!cutoff) continue;
    for (const [sha, pid] of patchIds(cwd, [`--since=${state.startedAt}`, cutoff])) if (ownPids.has(pid)) own.add(sha);
    const numstat = gitOut(cwd, ['diff', '--numstat', lastBase, branch]) ?? '';
    const touched = [];
    for (const line of numstat.split('\n').filter(Boolean)) {
      const [added, , file] = line.split('\t');
      const n = Number(added);
      if (!Number.isFinite(n) || n === 0) continue;
      written += n;
      touched.push(file);
      const surviving = blameFile(cwd, cutoff, file).filter((sha) => own.has(sha)).length;
      rewritten += Math.max(0, n - surviving);
    }
    if (touched.length) {
      for (const sha of (gitOut(cwd, ['log', '--format=%H', `--since=${sinceIso}`, cutoff, '--', ...touched]) ?? '').split('\n').filter(Boolean)) if (!own.has(sha)) commits.add(sha);
    }
  }
  return { lines: rewritten, share: written ? Math.round((rewritten / written) * 1000) / 1000 : 0, commits: commits.size };
}

// The row of a schema 2 attempt.
async function row2(root, attemptId, state, entries) {
  const { name, adapter } = await projectName(root);
  const r = emptyRow();
  const start = t(state.startedAt);
  const end = state.closedAt ? t(state.closedAt) : t(entries.at(-1).at);
  Object.assign(r, { project: name, item: state.item, attempt: attemptId, engine: state.engine, outcome: state.outcome, start: state.startedAt, end: new Date(end).toISOString(), wallMin: minutes(end - start) });
  // D16: a close by patch-id with the delivery stages not done shipped outside the workflow; `attempt.closed` records it.
  r.outsideStages = state.open ? null : state.outsideStages === true;

  // Waits and the intervals that explain idle time.
  const decisions = Object.values(state.decisions).filter((d) => d.askedAt && d.blocking !== false);
  const decisionSpans = decisions.map((d) => [t(d.askedAt), d.answer ? t(d.answer.at) : end]);
  const holdSpans = state.holds.map((h) => [t(h.at), h.releasedAt ? t(h.releasedAt) : end]);
  const stages = stageWaits(state.stageEvents, end);
  const testSpans = state.tests.filter((x) => typeof x.ms === 'number').map((x) => [t(x.at) - x.ms, t(x.at)]);
  // Time a test run waited for the machine-wide lock before it ran (stream 2's `lock.waitedMs`): a wait, counted as `lock`.
  const lockSpans = state.tests.filter((x) => (x.lock?.waitedMs ?? 0) > 0).map((x) => [t(x.at) - (x.ms ?? 0) - x.lock.waitedMs, t(x.at) - (x.ms ?? 0)]);
  const reviewSpans = state.reviews.map((rv) => {
    const h = state.handoffs.findLast((x) => x.role === 'reviewer' && asSession(x.session)?.id === asSession(rv.session)?.id && t(x.at) <= t(rv.at));
    return h ? [t(h.at), t(rv.at)] : null;
  }).filter(Boolean);
  r.personWaitMin = minutes(total(union(decisionSpans, start, end)));
  r.holdMin = minutes(total(union(holdSpans, start, end)));
  r.stageWaitMin = {};
  const waitMs = {};
  for (const s of stages) waitMs[s.do] = (waitMs[s.do] ?? 0) + total(union([[s.from, s.to]], start, end));
  if (lockSpans.length) waitMs.lock = total(union(lockSpans, start, end));
  for (const [k, v] of Object.entries(waitMs)) r.stageWaitMin[k] = minutes(v);

  const sessions = [state.owner, ...state.handoffs.map((h) => h.session), ...state.reviews.map((x) => x.session)];
  const act = await sessionsActivity(sessions);
  const points = [...entries.map((e) => t(e.at)), ...act.turns];
  Object.assign(r, activityOf(points, [...decisionSpans, ...holdSpans, ...stages.map((s) => [s.from, s.to]), ...testSpans, ...lockSpans, ...reviewSpans], start, end));
  r.tokens = act.tokens;
  r.cost = act.cost;

  // Reviews and findings.
  r.reviews = state.reviews.length;
  r.blockingReviews = state.reviews.filter((x) => (x.blockers ?? 0) > 0).length;
  r.emptyReviews = state.reviews.filter((x) => !(x.findings ?? []).length).length;
  r.fixRounds = Math.max(0, ...state.reviews.map((x) => (x.round ?? 1) - 1));
  r.coverage = !state.reviews.length ? null : state.reviews.some((x) => x.coverage === 'unverified') ? 'unverified' : 'complete';
  const all = Object.values(state.findings).filter((f) => f.class);
  r.findings = {
    goal: all.filter((f) => f.class === 'goal').length,
    regression: all.filter((f) => f.class === 'regression').length,
    other: all.filter((f) => f.class === 'other').length,
    filed: state.filings.filter((f) => f.mode === 'file' && f.ticket).length,
    digested: state.filings.filter((f) => f.mode === 'digest').length,
  };
  // Findings that later reviews found on lines a fix round wrote: blamed to this attempt, committed after the first review.
  const firstReview = state.reviews[0];
  r.introducedByRepair = 0;
  if (firstReview) {
    for (const f of all) {
      if (!(f.review > firstReview.review) || !f.location) continue;
      try {
        const b = await blameToAttempt(root, attemptId, f.location);
        if (!b.own || !b.commit) continue;
        const view = await repoView(root, state, f.location.split('/')[0]);
        const when = view ? commitTime(view.cwd, b.commit) : null;
        if (when && t(when) > t(firstReview.at)) r.introducedByRepair++;
      } catch {
        // a line that cannot be blamed is not counted
      }
    }
  }

  // Tests, landing, screens.
  r.testRuns = { fast: state.tests.filter((x) => x.kind === 'fast').length, full: state.tests.filter((x) => x.kind === 'full').length };
  r.testMin = minutes(state.tests.reduce((s, x) => s + (x.ms ?? 0), 0));
  const batches = new Map();
  for (const l of state.landings) batches.set(l.batch, Math.max(batches.get(l.batch) ?? 0, l.bisects ?? 0));
  r.landing = { batches: batches.size, bisects: [...batches.values()].reduce((a, b) => a + b, 0) };
  r.screens = new Set(state.screens.flatMap((x) => (x.images ?? []).map((i) => i.sha256 ?? i.file))).size;
  r.refusals = refusalCounts(readRefusals({ root, attempt: attemptId }));

  // The diff, by kind, and whether it touched a risk path.
  let files = null;
  try {
    files = (await changedFiles(root, attemptId)).files;
  } catch {
    files = null;
  }
  if (files) {
    r.diff = { product: 0, tests: 0, other: 0 };
    for (const f of files) r.diff[f.kind] = (r.diff[f.kind] ?? 0) + (f.added ?? 0) + (f.removed ?? 0);
  } else r.diff = state.closedRow?.diff ?? null;
  const riskGlobs = (adapter?.risk?.paths ?? []).flatMap((p) => p.paths);
  const repoPath = (name) => adapter?.repos.find((x) => x.name === name)?.path ?? name;
  const touchesRisk = files ? files.some((f) => matchesAny(`${repoPath(f.repo)}/${f.path}`, riskGlobs)) : false;
  r.riskTouched = touchesRisk || state.reviews.some((x) => x.seat === 'second') || state.tests.some((x) => x.kind === 'risk-base');

  // Rework, 48 hours after delivery.
  const landed = state.landings.find((l) => l.result === 'landed');
  const deliveredAt = landed ? t(landed.at) : state.outcome === 'shipped' ? t(state.closedAt) : NaN;
  try {
    r.rework = await reworkOf(root, state, adapter, deliveredAt);
  } catch {
    r.rework = null;
  }
  return r;
}

/** The telemetry row of one attempt. */
export async function row(root, attempt) {
  const entries = await readEvents(root, attempt);
  if (isSchema1(entries)) return legacyRow(root, attempt);
  return row2(root, attempt, foldEntries(attempt, entries), entries);
}

// ---------------------------------------------------------------------------------------------------------------------
// The project's rows and `wf report`
// ---------------------------------------------------------------------------------------------------------------------

export const telemetryFile = (project, env = process.env) => path.join(userDir(env), 'telemetry', `${project}.jsonl`);

// Every closed ticket's row in the project (0.8 attempts and 0.7 tickets, batches rolled up), rebuilt and stored in the
// telemetry file. Ledgers that fail their chain are returned as problems, never skipped silently.
export async function projectRows(root) {
  const { name } = await projectName(root);
  const rows = [];
  const problems = [];
  const legacy = [];
  for (const id of await listAttempts(root)) {
    let entries;
    try {
      entries = await readEvents(root, id);
    } catch (error) {
      problems.push({ attempt: id, problem: error.message });
      continue;
    }
    if (isSchema1(entries)) {
      legacy.push(id);
      continue;
    }
    const state = foldEntries(id, entries);
    if (state.open) continue;
    rows.push(await row2(root, id, state, entries));
  }
  if (legacy.length) {
    const roll = await legacyRollup(root, legacy);
    rows.push(...roll.rows);
    problems.push(...roll.problems);
  }
  rows.sort((a, b) => t(a.end) - t(b.end));
  const file = telemetryFile(name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, rows.map((x) => JSON.stringify(x)).join('\n') + (rows.length ? '\n' : ''));
  return { project: name, rows, problems, file };
}

// One attempt's row, written into the telemetry file in place of an earlier row of the same attempt (`wf close`). The
// file lands by rename, so a reader never sees half of it.
export async function writeRow(root, attempt) {
  const r = await row(root, attempt);
  const file = telemetryFile(r.project);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let kept = [];
  try {
    kept = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).filter((line) => {
      try {
        return JSON.parse(line).attempt !== attempt;
      } catch {
        return true;
      }
    });
  } catch {}
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, [...kept, JSON.stringify(r)].join('\n') + '\n');
  fs.renameSync(tmp, file);
  return { row: r, file };
}

const minor = (v) => (/^(\d+\.\d+)/.exec(String(v ?? ''))?.[1] ?? 'unknown');

// Commits on each repo's base, since the first attempt started, that no attempt's branch holds (by sha or patch-id).
export async function uncoveredCommits(root, adapter) {
  const states = [];
  for (const id of await listAttempts(root)) {
    try {
      const entries = await readEvents(root, id);
      const s = foldEntries(id, entries);
      s.startedAt ??= entries[0]?.at;
      if (isSchema1(entries)) s.repos = Object.fromEntries(Object.entries(entries[0].data?.repos ?? {}).map(([k, v]) => [k, { branch: v.branch ?? branchName(id), baseSha: null }]));
      states.push(s);
    } catch {
      // a broken ledger is reported by projectRows
    }
  }
  if (!states.length) return [];
  const since = states.map((s) => s.startedAt).filter(Boolean).sort()[0];
  const out = [];
  for (const spec of adapter.repos) {
    const cwd = path.join(root, spec.path);
    if (!fs.existsSync(cwd)) continue;
    const base = baseRef(cwd, spec);
    if (!base) continue;
    const covered = new Set();
    const pids = new Set();
    for (const s of states) {
      const r = s.repos?.[spec.name];
      if (!r) continue;
      for (const branch of [r.branch ?? branchName(s.id), `refs/remotes/${spec.remote ?? 'origin'}/${r.branch ?? branchName(s.id)}`]) {
        if (!refExists(cwd, branch)) continue;
        const range = r.baseSha ? ownRange(s, spec.name, branch) : [`--since=${s.startedAt}`, branch];
        for (const [sha, pid] of patchIds(cwd, range)) {
          covered.add(sha);
          pids.add(pid);
        }
      }
      for (const l of s.landings ?? []) if (l.repo === spec.name && l.sha) covered.add(l.sha);
    }
    for (const [sha, pid] of patchIds(cwd, [`--since=${since}`, base])) {
      if (covered.has(sha) || pids.has(pid)) continue;
      const subject = (gitOut(cwd, ['show', '-s', '--format=%s', sha]) ?? '').trim();
      out.push({ repo: spec.name, sha, subject });
    }
  }
  return out;
}

const fmt = (v) => (v === null || v === undefined ? '-' : Number.isInteger(v) ? String(v) : v.toFixed(1));

/** `wf report`: medians per project and engine version, ledger problems, uncovered commits. */
export async function cmdReport(ctx) {
  if (!ctx?.root) throw new WfError('no project here: run wf report inside a project (no adapter was found)');
  const { project, rows, problems, file } = await projectRows(ctx.root);
  let adapter = null;
  try {
    adapter = await loadAdapter(ctx.root);
  } catch {
    adapter = null;
  }
  const uncovered = adapter ? await uncoveredCommits(ctx.root, adapter) : null;
  const groups = [];
  for (const engine of [...new Set(rows.map((x) => minor(x.engine)))].sort()) {
    const rs = rows.filter((x) => minor(x.engine) === engine);
    groups.push({ engine, n: rs.length, medians: Object.fromEntries(REPORT_METRICS.map((m) => [m, median(rs.map((x) => metricValue(x, m)))])) });
  }
  const lines = [`${project}: ${rows.length} closed ticket(s); rows in ${file}`];
  if (groups.length) {
    lines.push('', `median ${groups.map((g) => `${g.engine} (n=${g.n})`).join('  ')}`);
    for (const m of REPORT_METRICS) lines.push(`  ${m.padEnd(20)} ${groups.map((g) => fmt(g.medians[m]).padStart(10)).join(' ')}`);
  }
  if (problems.length) lines.push('', 'ledgers that fail their chain (edited outside wf):', ...problems.map((p) => `  ${p.attempt}: ${p.problem}`));
  if (uncovered === null) lines.push('', 'commits no attempt covers: not checked (the adapter could not be loaded)');
  else if (uncovered.length) lines.push('', 'commits on the base that no attempt covers:', ...uncovered.map((c) => `  ${c.repo} ${c.sha.slice(0, 12)} ${c.subject}`));
  else lines.push('', 'commits on the base that no attempt covers: none');
  return { text: lines.join('\n'), data: { project, engine: CONTRACT_VERSION, groups, rows: rows.length, problems, uncovered } };
}

export { splitId };
export const implements08 = { row, writeRow, cmdReport };
