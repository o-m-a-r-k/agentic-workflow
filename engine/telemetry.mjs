import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { listAttempts, readLedger, reduce } from './ledger.mjs';
import { YAML } from './util.mjs';
import { descendants, findHost, optional } from './hosts/index.mjs';
import { readRefusals } from './refusals.mjs';
import { observations, severityLevel } from './review-policy.mjs';
import { introducedFindings } from './introduced.mjs';
import { changedFiles } from './attempt.mjs';

// The ledger is the event log: every `wf` command appends to it with a timestamp.
// Agent usage is read afterwards from each runtime's own session logs. Measurement only.

const minutes = (msValue) => Math.round(msValue / 6000) / 10;
// Real model names only: a harness writes a placeholder such as `<synthetic>` for messages it generated itself.
const realModel = (m) => (m && !String(m).startsWith('<') ? m : null);

function top(counts) {
  return Object.entries(counts ?? {}).sort((a, b) => b[1] - a[1]).map(([k]) => k);
}

export function agentUsage(runtime, session, home = os.homedir()) {
  if (!session) return null;
  try {
    return optional(findHost(runtime), 'usage')?.(session, home) ?? null;
  } catch {
    return null;
  }
}

// Prices: the table shipped with the plugin (engine/prices.yaml), then the user's, then the project's
// (.workflow/prices.yaml): later files replace a model's entry. A file is `models: { <id prefix>: {...} }`, or (older
// user files) the same map at the top level.
const DEFAULT_PRICES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'prices.yaml');
export const userPricesFile = () => path.join(process.env.WF_CONFIG_HOME ?? path.join(os.homedir(), '.config', 'agentic-workflow'), 'prices.yaml');
export const defaultPricesFile = () => DEFAULT_PRICES;
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
  return { ...priceFile(DEFAULT_PRICES), ...priceFile(userPricesFile()), ...(root ? priceFile(path.join(root, '.workflow', 'prices.yaml')) : {}) };
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

const ms = (a, b) => (a && b ? new Date(b) - new Date(a) : null);
const mins = (v) => (v === null || v === undefined ? null : Math.round(v / 6000) / 10);
const hid = (bundle) => (bundle ? path.basename(String(bundle), '.json') : null);
// The size of a handoff's bundle file, or null when the file is gone (an attempt released, or a ledger copied from another machine).
const bundleBytes = (bundle) => {
  try {
    return bundle ? fs.statSync(String(bundle)).size : null;
  } catch {
    return null;
  }
};

// Ledger entries that keep the books and say nothing about when the attempt was worked on. Named failure: `wf report`
// ended an attempt that was never closed at its last ledger entry, and the entry written last is often bookkeeping from
// a later command: adopting an old attempt's files into the manifest made a 6-minute abandoned attempt report 4,403
// minutes. Manifest upkeep (`evidence.*`), lessons and waivers a later attempt files on an earlier one
// (`lesson.recorded`, `lesson.recurred`, `lesson.acknowledged`, `authority.spent`, `discovered.acknowledged`), a models
// refresh, the attempt taking its base branch's adapter (0.7.30: written by whichever command next lists it) and exports
// of the attempt's pages or screenshots can all be written days after the work.
export const BOOKKEEPING_EVENTS = new Set([
  'evidence.baseline', 'evidence.recorded', 'evidence.rebaselined',
  'lesson.recorded', 'lesson.recurred', 'lesson.acknowledged', 'authority.spent', 'discovered.acknowledged',
  'models.refreshed', 'adapter.followed', 'adapter.notFollowed', 'adapter.authored', 'exported', 'screenshots.exported',
]);
export const isActivity = (entry) => !BOOKKEEPING_EVENTS.has(entry.type);
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
      bundleBytes: bundleBytes(h.bundle),
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
  // The attempt ends when it closed or was abandoned, else at its last entry that records work (BOOKKEEPING_EVENTS).
  const over = s.closedAt ?? s.abandoned?.at ?? null;
  const work = entries.filter((e) => isActivity(e) && (!over || e.at <= over));
  const end = over ?? work.at(-1)?.at ?? entries.at(-1)?.at ?? null;
  const ph = phases(entries, s, rs, gateWindows, end);
  const idleGaps = [];
  for (let i = 1; i < work.length; i++) {
    const gap = ms(work[i - 1].at, work[i].at);
    if (gap >= idleMinutes * 60000) idleGaps.push({ from: work[i - 1].at, to: work[i].at, minutes: mins(gap), after: work[i - 1].type, before: work[i].type, phase: phaseAt(entries, s, rs, gateWindows, work[i - 1].at) });
  }
  idleGaps.sort((a, b) => b.minutes - a.minutes);
  return { end, phases: ph, idleGaps, gateWindows, rounds: rs };
}

// Refusals the engine logged against this attempt (engine/refusals.mjs), counted by check id.
export function refusalsOf(rows, project, id) {
  const byId = {};
  let total = 0;
  for (const r of rows) {
    if (r.attempt !== id || (r.project && r.project !== project)) continue;
    byId[r.id] = (byId[r.id] ?? 0) + 1;
    total += 1;
  }
  return { total, byId: Object.fromEntries(Object.entries(byId).sort((a, b) => b[1] - a[1])) };
}

// Strategist events (stream A2 adds `strategy.decided` and `strategy.tripwire`), read from the raw entries so an older
// ledger, or an engine that does not write them yet, counts zero. The tripwire's name is read from whichever field the
// entry carries it in.
export function strategyEvents(entries) {
  const decided = entries.filter((e) => e.type === 'strategy.decided');
  const tripwires = entries.filter((e) => e.type === 'strategy.tripwire');
  const name = (e) => e.data?.tripwire ?? e.data?.name ?? e.data?.id ?? e.data?.signal ?? e.data?.kind ?? null;
  return { decisions: decided.length, tripwires: tripwires.length, fired: [...new Set(tripwires.map(name).filter(Boolean).map(String))] };
}

export function attemptReport(root, id, table = prices(root), { home = os.homedir(), indexes = new Map(), idleMinutes = IDLE_REPORT_MINUTES, refusals = null } = {}) {
  const entries = readLedger(root, id);
  const s = reduce(entries);
  const first = entries[0]?.at;
  const gates = s.gates.filter((g) => !g.carriedFrom);
  const steps = gates.flatMap((g) => g.steps ?? []);
  const ran = steps.filter((x) => ['passed', 'failed', 'interrupted'].includes(x.status));
  const reused = steps.filter((x) => x.status === 'reused');
  // The agents a harness recorded as started under a role (its adapter's index), read once per harness.
  const indexNow = (runtime) => {
    if (!indexes.has(runtime)) {
      try {
        indexes.set(runtime, optional(findHost(runtime), 'agentIndex')?.(home) ?? []);
      } catch {
        indexes.set(runtime, []);
      }
    }
    return indexes.get(runtime);
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
    const host = findHost(h.runtime);
    let usage = agentUsage(h.runtime, h.session, home);
    let agentIds = [];
    const byName = !usage ? optional(host, 'usageByName') : null;
    if (byName) {
      try {
        const found = byName(h, { index: indexNow(h.runtime), since: first });
        if (found) ({ usage, agentIds } = found);
      } catch {
        usage = null;
      }
    }
    // Sub-agents its agent started (any depth), attributed to this handoff; each transcript counts once per attempt.
    const recorded = s.subagents.filter((c) => c.parentHandoff === hid(h.bundle)).map((c) => c.agentId);
    let children = [];
    try {
      const idx = agentIds.length || recorded.length ? indexNow(h.runtime) : [];
      const found = descendants(idx, agentIds);
      children = [...found, ...idx.filter((x) => recorded.includes(x.agentId) && !found.some((y) => y.agentId === x.agentId))].filter((x) => !childSeen.has(x.agentId));
    } catch {}
    for (const c of children) childSeen.add(c.agentId);
    const childRows = children.map((c) => {
      let u = null;
      try {
        u = optional(host, 'agentUsage')?.(c) ?? null;
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
      bundleBytes: bundleBytes(h.bundle),
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
  // Named failure: 58.6% of one project's tokens were from models with no price and the cost line did not say so.
  const unpricedTokens = Object.values(tokensByModel).filter((b) => b.cost === null).reduce((n, b) => n + b.total, 0);
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
  const refused = refusalsOf(refusals ?? readRefusals(), path.basename(root), id);
  const strategy = strategyEvents(entries);
  const reviewerBundles = rounds.map((r) => r.bundleBytes).filter((n) => n !== null);
  let openObservations = 0;
  try {
    openObservations = observations(s).length;
  } catch {}

  return {
    id,
    item: s.item,
    lane: s.lane,
    phase: s.phase,
    shipped: s.shipped ? true : undefined,
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
    // How each reviewer model rates (high, medium, low, unrated) and how often a later reviewer re-rated a finding: what is
    // owed depends on ratings, and models rate differently (second final review of 0.7.0). Measurement only.
    severityByModel: (() => {
      const out = {};
      for (const r of s.reviews ?? []) {
        const model = r.reviewerModel ?? 'unknown';
        for (const f of r.closure?.findings ?? []) {
          const level = severityLevel(f.severity) ?? 'unrated';
          out[model] ??= { high: 0, medium: 0, low: 0, unrated: 0 };
          out[model][level] += 1;
        }
      }
      return out;
    })(),
    rerated: (() => {
      const rank = { low: 0, medium: 1, high: 2 };
      const original = new Map((s.reviews ?? []).flatMap((r) => (r.closure?.findings ?? []).map((f) => [`${r.closure?.reviewer ?? r.reviewer}:${f.id}`, severityLevel(f.severity)])));
      let down = 0, up = 0;
      for (const r of s.reviews ?? []) for (const p of r.closure?.priorFindings ?? []) {
        const to = severityLevel(p.severity);
        const from = original.get(`${p.round}:${p.id}`);
        if (!to || !from || to === from) continue;
        if (rank[to] < rank[from]) down += 1;
        else up += 1;
      }
      return { down, up };
    })(),
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
    unpricedTokens,
    // Share of this attempt's tokens that the cost does not cover (no price for their model); null when there are no tokens.
    unpricedShare: tokens ? Math.round((unpricedTokens / tokens) * 1000) / 1000 : null,
    // 0.7.0: refusals the engine logged against this attempt, by check id (`wf refusals` counts all of them).
    refusalCount: refused.total,
    refusalsById: refused.byId,
    // Size of the largest reviewer bundle handed (each round also carries `bundleBytes`).
    maxReviewerBundleBytes: reviewerBundles.length ? Math.max(...reviewerBundles) : null,
    // Findings the review policy keeps open without blocking (observations the strategist schedules).
    openObservations,
    // 0.7.0: where defects came from, not only where they were found. Each located review finding is traced (git blame on
    // the reviewed tree) to the implementer handoff whose commits contain the cited line; measurement only.
    introduced: (() => {
      try {
        return introducedFindings(s);
      } catch {
        return null;
      }
    })(),
    // 0.7.0: what the plan and the implementers predicted against what happened, so predictions can be calibrated.
    course: {
      expected: s.expect ?? null,
      replans: (s.expectations ?? []).filter((x) => x.source === 'amendment').length,
      actual: {
        rounds: new Set((s.reviews ?? []).map((r) => r.handoff ?? r.reviewer)).size,
        minutes: ph.totalMinutes ?? null,
        files: (() => {
          try {
            return Object.keys(s.repos ?? {}).reduce((n, repo) => n + changedFiles(s, repo).length, 0);
          } catch {
            return null;
          }
        })(),
      },
      implementers: (s.implementerReports ?? []).map((r) => {
        const x = s.implementers.find((i) => i.handoff === r.handoff);
        const took = x?.openedAt && x?.closedAt ? Math.round((Date.parse(x.closedAt) - Date.parse(x.openedAt)) / 60000) : null;
        return { agent: r.agent, expectMinutes: r.expect?.minutes ?? null, tookMinutes: took };
      }),
    },
    strategyDecisions: strategy.decisions,
    strategyTripwires: strategy.tripwires,
    tripwiresFired: strategy.fired,
  };
}

export function report(roots, { home = os.homedir(), idleMinutes = IDLE_REPORT_MINUTES } = {}) {
  const rows = [];
  const indexes = new Map();
  const refusals = readRefusals();
  for (const root of roots) {
    const table = prices(root);
    for (const id of listAttempts(root)) rows.push({ project: path.basename(root), ...attemptReport(root, id, table, { home, indexes, idleMinutes, refusals }) });
  }
  return rows;
}

const HANDOFF_COLS = ['project', 'id', 'handoff', 'role', 'agent', 'runtime', 'work', 'class', 'declaredEffort', 'observedEffort', 'effortMismatch', 'agentType', 'model', 'sessionModel', 'wallMinutes', 'activeMinutes', 'rounds', 'outputTokens', 'cost', 'subagents', 'subagentCost', 'bundleBytes'];
export const handoffRows = (rows) => rows.flatMap((r) => r.roles.map((h) => ({ project: r.project, id: r.id, ...h, subagents: h.children.length, subagentCost: h.childCost })));

const esc = (v) => (v === null || v === undefined ? '' : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));

export function toHandoffCsv(rows) {
  return [HANDOFF_COLS.join(','), ...handoffRows(rows).map((h) => HANDOFF_COLS.map((c) => esc(h[c])).join(','))].join('\n') + '\n';
}

const ATTEMPT_COLS = ['project', 'id', 'item', 'lane', 'phase', 'admittedAt', 'timeToGateMs', 'timeToDeliverMs', 'timeToCloseMs', 'wallMinutes', ...PHASES.map((p) => `${p}Minutes`), 'gateRuns', 'gatesPassed', 'gatesFailed', 'gatesStopped', 'repairRounds', 'reviewRounds', 'refusedRounds', 'roundsWithRefusal', 'failedLaunchRounds', 'failedStartRounds', 'unknownOutcomeRounds', 'wastedReviewerRounds', 'roundsWithGreenGate', 'stepRuns', 'stepReused', 'reuseRate', 'gateTimeMs', 'findings', 'findingsOpen', 'impactGaps', 'criteria', 'criteriaAmendments', 'holds', 'observedModels', 'tokens', 'subagentTokens', 'cost', 'unpricedTokens', 'refusalCount', 'maxReviewerBundleBytes', 'openObservations', 'strategyDecisions', 'strategyTripwires'];
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
    unpriced: unpricedSummary(rows),
    calibration: calibrationSummary(rows),
    attempts: rows.map(({ roles, ...r }) => ({
      ...r,
      roles: roles.map(({ usage, ...h }) => ({ ...h, tokensByModel: usage?.byModel ?? {}, toolCalls: usage?.toolCalls ?? null })),
    })),
  };
}

// How good the predictions were, across attempts: for each predicted quantity, the median of actual / predicted over the
// attempts that predicted it (1 is exact; 2 took twice as long), and the same for implementers' own minutes. Measurement
// for the people and agents who predict; nothing is decided from it (D9). Named failure: predictions were shown per
// ticket and nobody could tell whether they were any good.
export function calibrationSummary(rows) {
  const median = (xs) => {
    const v = xs.filter(Number.isFinite).sort((a, b) => a - b);
    if (!v.length) return null;
    const m = Math.floor(v.length / 2);
    return Math.round((v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2) * 100) / 100;
  };
  const out = {};
  for (const k of ['files', 'rounds', 'minutes']) {
    const ratios = rows.filter((r) => typeof r.course?.expected?.[k] === 'number' && typeof r.course?.actual?.[k] === 'number').map((r) => r.course.actual[k] / r.course.expected[k]);
    out[k] = { attempts: ratios.length, medianActualOverPredicted: median(ratios) };
  }
  const impl = rows.flatMap((r) => (r.course?.implementers ?? []).filter((x) => typeof x.expectMinutes === 'number' && typeof x.tookMinutes === 'number').map((x) => x.tookMinutes / x.expectMinutes));
  out.implementerMinutes = { handoffs: impl.length, medianActualOverPredicted: median(impl) };
  return out;
}

// Models that used tokens and have no price, across the rows, most tokens first. Their tokens are in no cost figure.
export function unpricedSummary(rows) {
  const by = new Map();
  for (const r of rows) {
    for (const [model, b] of Object.entries(r.tokensByModel ?? {})) {
      if (b.cost !== null || !(b.total > 0)) continue;
      const x = by.get(model) ?? { model, tokens: 0, attempts: 0 };
      x.tokens += b.total;
      x.attempts += 1;
      by.set(model, x);
    }
  }
  const all = rows.reduce((n, r) => n + (r.tokens ?? 0), 0);
  return [...by.values()].sort((a, b) => b.tokens - a.tokens).map((x) => ({ ...x, share: all ? Math.round((x.tokens / all) * 1000) / 1000 : null }));
}

// Where a price is added: the shipped table, the user's file, and the project's file.
const priceFileLines = () => [`${userPricesFile()} (yours, every project)`, '<project>/.workflow/prices.yaml (one project)', `${defaultPricesFile()} (the plugin's shipped table)`];
const PRICE_SHAPE = 'models:\n  <model id prefix>: { input: <USD per million tokens>, output: <...>, cacheRead: <...>, cacheWrite: <...> }';

const num = (v, d = 1) => (v === null || v === undefined ? '-' : Number(v).toFixed(d).replace(/\.0+$/, ''));
const bytes = (n) => (n === null || n === undefined ? '-' : n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : n >= 1024 ? `${Math.round(n / 1024)} KB` : `${n} B`);
const pct = (share) => `${Math.round(share * 1000) / 10}%`;
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
    const byModel = Object.entries(r.severityByModel ?? {});
    if (byModel.length) out.push(`  severity by reviewer model: ${byModel.map(([m, c]) => `${m} high ${c.high}, medium ${c.medium}, low ${c.low}${c.unrated ? `, unrated ${c.unrated}` : ''}`).join('; ')}${r.rerated?.down || r.rerated?.up ? `; re-rated by a later reviewer: ${r.rerated.down} down, ${r.rerated.up} up` : ''}`);
    if (r.scope.amendments) out.push(`  scope: ${r.scope.amendments} amendment(s): criteria ${r.criteriaAtFreeze ?? '?'} -> ${r.criteria} (+${r.scope.criteriaAdded}, ${r.scope.criteriaChanged} changed, -${r.scope.criteriaDropped}); endpoints +${r.scope.endpoints}, error codes +${r.scope.errorCodes}, repos +${r.scope.repos}`);
    const models = Object.entries(r.tokensByModel);
    if (models.length) out.push(`  tokens by model: ${models.map(([m, b]) => `${m} ${b.total} (out ${b.output}${b.cost !== null ? `, $${b.cost.toFixed(2)}` : ''})`).join('; ')}`);
    out.push(`  cost: ${r.cost === null ? 'unknown' : `$${r.cost.toFixed(2)}`}${r.unpricedModels.length ? ` (priced models only: ${r.unpricedShare === null ? '' : `${pct(r.unpricedShare)} of the tokens have `}no price for ${r.unpricedModels.join(', ')})` : ''}; sub-agent tokens ${r.subagentTokens}`);
    const intro = Object.entries(r.introduced?.byAgent ?? {});
    if (intro.length) out.push(`  introduced by implementer (located findings traced to its commits): ${intro.map(([a, x]) => `${a} ${x.blocking} blocking, ${x.observations} observation(s)`).join('; ')}${r.introduced.unattributed ? `; ${r.introduced.unattributed} not attributable` : ''}`);
    if (r.course?.expected) out.push(`  predicted: ${Object.entries(r.course.expected).map(([k, v]) => `${k} ${v}`).join(', ')}${r.course.replans ? ` (${r.course.replans} re-plan(s))` : ''}; actual: ${['files', 'rounds', 'minutes'].filter((k) => r.course.actual[k] !== null && r.course.actual[k] !== undefined).map((k) => `${k} ${num(r.course.actual[k], 0)}`).join(', ')}`);
    for (const x of r.course?.implementers ?? []) if (x.expectMinutes !== null) out.push(`  ${x.agent}: expected ${x.expectMinutes} min, took ${x.tookMinutes ?? '?'} min`);
    if (r.refusalCount) out.push(`  refusals: ${r.refusalCount} (${Object.entries(r.refusalsById).slice(0, 8).map(([k, v]) => `${k} ${v}`).join(', ')}${Object.keys(r.refusalsById).length > 8 ? ', …' : ''})`);
    const sized = r.rounds.map((x) => x.bundleBytes).filter((n) => n !== null && n !== undefined);
    if (sized.length) out.push(`  reviewer bundles: ${sized.length} handoff(s), largest ${bytes(Math.max(...sized))}, total ${bytes(sized.reduce((n, x) => n + x, 0))}`);
    if (r.openObservations) out.push(`  observations: ${r.openObservations} open (not blocking; the strategist schedules them)`);
    if (r.strategyDecisions || r.strategyTripwires) out.push(`  strategy: ${r.strategyDecisions} decision(s), ${r.strategyTripwires} tripwire(s) fired${r.tripwiresFired.length ? ` (${r.tripwiresFired.join(', ')})` : ''}`);
    if (r.failingTests.length) for (const f of r.failingTests.slice(0, 10)) out.push(`  failed ${f.step} (${f.runId}): ${f.tests.length ? `${f.tests.slice(0, 5).join(' | ')}${f.total > 5 ? ` … ${f.total - 5} more` : ''}` : `exit ${(f.exitCodes ?? []).join(',') || '?'}${f.tail?.length ? `: ${f.tail.at(-1)}` : ''}`}`);
    for (const x of r.idleGaps.slice(0, 5)) out.push(`  idle ${num(x.minutes)} min (${x.phase}): ${x.from} -> ${x.to} (after ${x.after})`);
  }
  const cal = calibrationSummary(rows);
  const calLines = [...['files', 'rounds', 'minutes'].map((k) => [k, cal[k].attempts, cal[k].medianActualOverPredicted]), ['implementer minutes', cal.implementerMinutes.handoffs, cal.implementerMinutes.medianActualOverPredicted]].filter(([, n]) => n);
  if (calLines.length) out.push('', 'predictions (median of actual / predicted; 1 is exact):', ...calLines.map(([k, n, m]) => `  ${k}: ${m} over ${n} ${k === 'implementer minutes' ? 'handoff(s)' : 'attempt(s)'}`));
  const unpriced = unpricedSummary(rows);
  if (unpriced.length) {
    const share = unpriced.reduce((n, x) => n + (x.share ?? 0), 0);
    out.push('', `unpriced models: ${unpriced.length} model(s), ${pct(share)} of all tokens, are in no cost figure above`);
    for (const x of unpriced) out.push(`  ${x.model}  ${x.tokens} tokens in ${x.attempts} attempt(s)`);
    out.push('  add a price for each (the longest model id prefix wins; a later file replaces an earlier entry), in one of:', ...priceFileLines().map((l) => `    ${l}`), `  shape:\n${PRICE_SHAPE.split('\n').map((l) => `    ${l}`).join('\n')}`);
  }
  return out.join('\n');
}

const html = (v) => String(v ?? '—').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

function handoffTable(rows) {
  const hs = handoffRows(rows);
  if (!hs.length) return '';
  const head = ['Attempt', 'Role', 'Agent', 'Work', 'Class', 'Effort declared', 'Effort observed', 'Agent type', 'Model', 'Session model', 'Wall min', 'Active min', 'Rounds', 'Output tokens', 'Cost', 'Sub-agents', 'Bundle'];
  const body = hs.map((h) => `<tr><td>${html(h.id)}</td><td>${html(h.role)}</td><td>${html(h.agent)}</td><td>${html(h.work)}</td><td>${html(h.class)}</td><td>${html(h.declaredEffort)}</td><td>${html(h.observedEffort)}${h.effortMismatch ? ' <strong>(differs)</strong>' : ''}</td><td>${html(h.agentType)}</td><td>${html(h.model)}</td><td>${html(h.sessionModel)}</td><td>${html(h.wallMinutes)}</td><td>${html(h.activeMinutes)}</td><td>${html(h.rounds)}</td><td>${html(h.outputTokens)}</td><td>${h.cost === null ? '—' : `$${h.cost.toFixed(2)}`}</td><td>${html(h.subagents)}</td><td>${bytes(h.bundleBytes)}</td></tr>`).join('\n');
  return `<h2>Agents</h2><table><tr>${head.map((x) => `<th>${x}</th>`).join('')}</tr>${body}</table>`;
}

export function toHtml(rows) {
  const fmt = (v) => (v === null || v === undefined ? '—' : typeof v === 'number' ? (v > 1000 && Number.isInteger(v) ? `${(v / 60000).toFixed(1)} min` : v.toFixed?.(2) ?? v) : v);
  const head = ['Project', 'Attempt', 'Lane', 'Phase', 'To gate', 'To deliver', 'Gate runs', 'Stopped', 'Review handoffs', 'Refusal handoffs', 'Failed launches', 'Unknown outcomes', 'Repairs', 'Reuse', 'Gate time', 'Findings', 'Observations', 'Engine refusals', 'Largest bundle', 'Tripwires', 'Tokens', 'Cost'];
  const body = rows.map((r) => `<tr><td>${html(r.project)}</td><td>${html(r.id)}</td><td>${html(r.lane)}</td><td>${html(r.phase)}</td><td>${fmt(r.timeToGateMs)}</td><td>${fmt(r.timeToDeliverMs)}</td><td>${r.gateRuns}</td><td>${r.gates.stopped}</td><td>${r.reviewRounds}</td><td>${r.roundsWithRefusal}</td><td>${r.failedLaunchRounds}</td><td>${r.unknownOutcomeRounds}</td><td>${r.repairRounds}</td><td>${r.reuseRate === null ? '—' : `${Math.round(r.reuseRate * 100)}%`}</td><td>${fmt(r.gateTimeMs)}</td><td>${r.findings}</td><td>${r.openObservations}</td><td>${r.refusalCount}</td><td>${bytes(r.maxReviewerBundleBytes)}</td><td>${r.strategyTripwires}</td><td>${r.tokens || '—'}</td><td>${r.cost === null ? '—' : `$${r.cost.toFixed(2)}${r.unpricedModels.length ? ' (partial)' : ''}`}</td></tr>`).join('\n');
  const unpriced = unpricedSummary(rows);
  const unpricedHtml = unpriced.length ? `<h2>Unpriced models</h2><p>These models used tokens and have no price, so their tokens are in no cost above. Add each to one of:</p><ul>${priceFileLines().map((l) => `<li><code>${html(l)}</code></li>`).join('')}</ul><pre>${html(PRICE_SHAPE)}</pre><table><tr><th>Model</th><th>Tokens</th><th>Attempts</th><th>Share of all tokens</th></tr>${unpriced.map((x) => `<tr><td>${html(x.model)}</td><td>${x.tokens}</td><td>${x.attempts}</td><td>${x.share === null ? '—' : pct(x.share)}</td></tr>`).join('')}</table>` : '';
  const phaseHead = ['Attempt', ...PHASES];
  const phaseBody = rows.map((r) => `<tr><td>${html(r.id)}</td>${PHASES.map((p) => `<td>${html(r.phases[p])}</td>`).join('')}</tr>`).join('\n');
  return `<!doctype html><meta charset="utf-8"><title>agentic-workflow report</title><style>body{font:14px system-ui;margin:24px;color:#1b2228;background:#fff}table{border-collapse:collapse}td,th{padding:6px 10px;border-bottom:1px solid #ddd;text-align:left;font-variant-numeric:tabular-nums}th{font-size:12px;text-transform:uppercase;color:#5b6770}@media(prefers-color-scheme:dark){body{background:#12171b;color:#e3e8eb}td,th{border-color:#2a343b}}</style><h1>agentic-workflow report</h1><p>${rows.length} attempt(s), generated ${new Date().toISOString()}</p><table><tr>${head.map((h) => `<th>${h}</th>`).join('')}</tr>${body}</table><h2>Minutes per phase</h2><table><tr>${phaseHead.map((h) => `<th>${h}</th>`).join('')}</tr>${phaseBody}</table>${handoffTable(rows)}${unpricedHtml}`;
}
