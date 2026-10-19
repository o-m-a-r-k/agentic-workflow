import { mkdirStateDirectory } from './state-folders.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { ENGINE_VERSION, SCHEMA_VERSION, WfError, canonical, now, refuse, sha256, withFileLock } from './util.mjs';
import { expectOf } from './expectations.mjs';
import { ownerRuntime } from './hosts/index.mjs';
import { prepareWrite, recordingTransaction, touch, verifyLevel, withEvidenceTransaction, writeAnchor, writeNoFollow } from './evidence.mjs';

// Opens an attempt for this process: verifies its evidence (chain, anchor, every recorded file) once, refusing on any
// difference. Every command that reads or writes an attempt goes through here (`openState`, the first `append`).
let opening = false;
export function openEvidence(root, id) {
  if (opening) return;
  opening = true;
  try {
    const problems = touch(root, id, append);
    if (problems.length) throw refuse(`the evidence of ${id} does not match what wf recorded (${problems.length} problem(s)); it was changed outside wf:\n  - ${problems.slice(0, 10).join('\n  - ')}${problems.length > 10 ? `\n  … ${problems.length - 10} more` : ''}`, `find out what changed it (a tool, a gate step, a person) and restore the files; \`wf verify --attempt ${id}\` lists every problem`);
  } finally {
    opening = false;
  }
}

// Evidence layout: <root>/.wf-evidence/attempts/<attemptId>/ledger.jsonl (+ gate/, review/, tracker/ ...).
export const evidenceRoot = (root) => path.join(root, '.wf-evidence');
export const attemptsDir = (root) => path.join(evidenceRoot(root), 'attempts');
export const attemptDir = (root, id) => path.join(attemptsDir(root), id);
const ledgerFile = (root, id) => path.join(attemptDir(root, id), 'ledger.jsonl');

// Each entry carries the previous entry's hash, so an accidental or careless edit breaks the chain.
// The chain is unkeyed: it detects editing mistakes, not a deliberate forger with shell access.
function entryHash(entry) {
  const { hash, ...rest } = entry;
  return sha256(canonical(rest));
}

// The last entry, verified: a full chain check runs once per ledger size, then appends only read the tail.
const verified = new Map();
function lastEntry(root, id) {
  const file = ledgerFile(root, id);
  const size = fs.statSync(file).size;
  const cached = verified.get(file);
  if (cached && cached.size === size) return cached.entry;
  const entries = readLedger(root, id);
  return entries.at(-1) ?? null;
}

export function readLedger(root, id) {
  return withEvidenceTransaction(root, id, () => readLedgerLocked(root, id));
}
function readLedgerLocked(root, id) {
  const file = ledgerFile(root, id);
  if (!fs.existsSync(file)) throw new WfError(`unknown attempt ${id}`);
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  const entries = [];
  let prev = null;
  // Named failure (0.7.0): every read hashed every entry (9 seconds on a 96 MB ledger). Every entry's link to the one before
  // it is checked always, and its own hash in full by the commands that verify everything (accept, deliver, verify, doctor,
  // export) and for the last entry, which the anchor binds; `wf verify` finds an edited middle entry.
  const everyHash = verifyLevel() === 'full';
  for (const [i, line] of lines.entries()) {
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      throw new WfError(`${file}: line ${i + 1} is not JSON; the ledger was edited by hand`);
    }
    if (entry.prev !== prev || ((everyHash || i === lines.length - 1) && entry.hash !== entryHash(entry))) {
      throw new WfError(`${file}: hash chain broken at entry ${entry.seq ?? i + 1}; the ledger was edited by hand`);
    }
    prev = entry.hash;
    entries.push(entry);
  }
  verified.set(file, { size: fs.statSync(file).size, entry: entries.at(-1) ?? null });
  return entries;
}

// Appends are serialised per attempt, so concurrent commands never interleave or fork the chain.
export function append(root, id, type, data = {}, actor = null) {
  return withEvidenceTransaction(root, id, () => appendLocked(root, id, type, data, actor));
}
function appendLocked(root, id, type, data, actor) {
  const file = ledgerFile(root, id);
  // A re-baseline is the one entry appended to an attempt that does not verify: `wf verify --accept-changes` has just
  // checked its chain and anchor and shown the owner every difference.
  if (type !== 'evidence.rebaselined') openEvidence(root, id);
  prepareWrite(file);
  mkdirStateDirectory(path.dirname(file), { recursive: true });
  return withFileLock(`${file}.lock`, () => {
    const last = fs.existsSync(file) ? lastEntry(root, id) : null;
    const entry = { seq: (last?.seq ?? 0) + 1, at: now(), type, actor, data, prev: last?.hash ?? null };
    entry.hash = entryHash(entry);
    writeNoFollow(file, `${JSON.stringify(entry)}\n`, { append: true });
    verified.set(file, { size: fs.statSync(file).size, entry });
    writeAnchor(root, id, entry);
    return entry;
  });
}

// Evidence a command writes and the ledger entry that records it are one transaction, sealed before it ends. Named failure
// (I-109): the files were written first, outside any transaction, and entered in the manifest when the process ended, so a
// `wf status` run in between was refused with "extra file (not written by wf)"; a handoff that failed after its write left
// the file behind. A reader now sees none of it or all. Every write of a file into an attempt's evidence goes through here
// (`prepareWrite` refuses one made elsewhere; engine/evidence.mjs, `recordingTransaction`). `fn` is synchronous: do any waiting
// (a connector, a network answer) first and pass the result in, so the lock is held only for the writes. The attempt is opened
// first (verified, its files noted: `openEvidence`), so a file this process writes is one it created and records, never one that
// was already there unrecorded.
export const recordedTogether = (root, id, fn) => recordingTransaction(root, id, append, () => {
  openEvidence(root, id);
  return fn();
});

export function createAttempt(root, id, data, actor) {
  if (fs.existsSync(ledgerFile(root, id))) throw refuse(`attempt ${id} already exists`);
  return append(root, id, 'admitted', { ...data, schemaVersion: SCHEMA_VERSION, engineVersion: ENGINE_VERSION }, actor);
}

export function listAttempts(root) {
  const dir = attemptsDir(root);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((d) => fs.existsSync(ledgerFile(root, d)));
}

// A pending `delivered` attach action, limited to the files a `delivery.narrowed` entry kept.
// One file per kept sha256, the first in recorded order: the same capture copied to two paths (a spec's evidence folder
// and the runner's attachment folder) would otherwise be owed twice, once under a title the ticket never got.
export const keptFiles = (files, keep) => {
  const seen = new Set();
  return files.filter((f) => keep.includes(f.sha256) && !seen.has(f.sha256) && seen.add(f.sha256));
};
// 0.7.26 (I-182): a capture the owner chose from the verified ones joins after the set's own kept files (`added`, recorded with
// the entry so a replay needs no gate).
const narrowAttach = (a, narrowed) => (narrowed && a.event === 'delivered' && a.op === 'attach' ? { ...a, files: keptFiles([...a.files, ...(narrowed.added ?? [])], narrowed.keep) } : a);

// A split moves findings (`<reviewer>:<id>`) to a sibling attempt: in this attempt's closures they read as `moved`, which
// every open-finding check treats as settled. The ledger's closure is never changed, only the derived view.
function withMoved(s, closure) {
  const moved = s.strategy?.moved?.findings;
  if (!moved?.length || !Array.isArray(closure?.findings)) return closure;
  return { ...closure, findings: closure.findings.map((f) => (moved.includes(`${closure.reviewer}:${f?.id}`) ? { ...f, status: 'moved' } : f)) };
}

// Derived state. Everything a command decides is computed from the ledger, never stored separately.
export function reduce(entries) {
  const s = {
    id: null,
    item: null,
    lane: null,
    intent: null,
    // `wf intent implementation`: an analysis attempt upgraded in place (from, to, reason).
    intentChanges: [],
    // 0.7.31 (I-216, D67): what an analysis attempt found (`wf analysis record`, the latest last) and its close (engine/analysis.mjs).
    analyses: [],
    analysisClosed: null,
    owner: null,
    originRuntime: null,
    runtimePreference: null,
    owners: [],
    ownerTransfers: 0,
    phase: 'admitted',
    repos: {},
    addedRepos: [],
    discovered: [],
    // 0.7.31 (I-217, D65): product decisions the person made outside the engine (`wf decide`), with their basis and words.
    productDecisions: [],
    implementerReports: [],
    scopeDecisions: [],
    adapterBase: null,
    adapter: null,
    deliveryAdapterBase: null,
    // 0.7.30 (I-151, D60): the commit the attempt reads its adapter at once it followed the base branch (null: its admission
    // base), every follow, and the latest tip it could not take with why (engine/adapter-follow.mjs).
    adapterPin: null,
    adapterFollows: [],
    adapterHeld: null,
    adapterOwnHeld: null,
    // Second review of 0.7.30: each change the attempt authored to a file it follows ({ file, change, commit }).
    adapterAuthored: [],
    // 0.7.30 (I-201, D62): the attempt this one ports to another branch, what the port applied, and the branches this attempt
    // is also delivered to (engine/targets.mjs).
    portOf: null,
    port: null,
    alsoTargets: [],
    adapterRepins: [],
    criteria: null,
    // How many criteria the plan froze with: `wf signals` shows the amendments against it.
    criteriaAtFreeze: null,
    // What the plan expects (files, review rounds, minutes to delivery; engine/expectations.mjs) and every statement of it:
    // the plan's, then each re-plan's (`wf criteria amend`). Shown against what happened; never a limit.
    expect: null,
    expectations: [],
    criteriaAmendments: [],
    validations: [],
    plan: null,
    planSource: null,
    impact: null,
    work: null,
    // When each work item id first appeared (the plan's or an amendment's): an unscoped implementer handed before 0.7.0
    // covers the items that existed when it was handed (`unstartedWork`, engine/lifecycle.mjs).
    workIntroduced: {},
    workAmended: {},
    roles: { planner: [], implementer: [], reviewer: [], tester: [], strategist: [] },
    handoffs: [],
    gates: [],
    checks: [],
    flaky: [],
    exports: [],
    review: null,
    reviews: [],
    reviewParts: [],
    baseMerges: [],
    // 0.7.34 (I-233): base merges made by hand, classified when a command first saw them (`base.observed`), and the number the
    // next base merge of either list takes (`base:<n>`, in ledger order).
    baseObserved: [],
    baseCount: 0,
    accepted: null,
    holds: [],
    delivery: { repos: {}, integrating: {}, completedAt: null },
    // 0.7.27 (I-196, D42): the deployment confirmation a project's delivery waits for after the merge (engine/deployment-step.mjs):
    // why it is owed, each observation of the deployment (the latest decides), the test there and the person's closing without it.
    deployment: null,
    tracker: { pending: [], done: [] },
    batch: null,
    batchOf: null,
    // True while batchOf names a batch a `wf split` reserved: the batch attempt itself is created by `wf batch create`.
    batchPending: false,
    deferHeavy: false,
    reopenedFrom: null,
    stops: [],
    reviewsRefused: [],
    // 0.7.29 (I-154): each time `wf accept` refused the latest review, its reasons; the next evidence review is handed them.
    acceptanceRefusals: [],
    planRefusals: [],
    gateOverrides: [],
    reviewOverrides: [],
    // Reserved owner decisions confirmed with `wf approve` (engine/approve.mjs).
    decisions: [],
    // The strategist's decisions and what they left behind (engine/strategy.mjs, engine/split.mjs). `nextRound` is
    // 'delta' after a delta-review decision until the next reviewer handoff consumes it (engine/review-policy.mjs
    // roundMode reads it); `tripwires` the owner escalations the engine refused on; `moved` lists what a split took out
    // of this attempt's open set; `toTicket` the observations a ticket decision queued.
    strategy: { decisions: [], tripwires: [], nextRound: null, toTicket: [], outcomes: {}, moved: { work: [], criteria: [], findings: [], discovered: [] } },
    splits: [],
    splitFrom: null,
    admittedAt: null,
    // Telemetry events (measurement only; nothing is decided from them).
    reviewRounds: [],
    implementers: [],
    scopeChanges: [],
    subagents: [],
    closedAt: null,
    abandoned: null,
    schemaVersion: null,
    engineVersion: null,
  };
  for (const e of entries) {
    const d = e.data;
    if (e.type === 'admitted' && !s.admittedAt) s.admittedAt = e.at;
    // A reserved decision (engine/approve.mjs) is spent by the action event that records it (`decision: <id>`, `decisions:
    // [<id>]`, `source.decision`, `authority.decision`): one approval, one action. Named failure (0.7.0 review): a key that
    // repeats (a second hold, an owner changing back) reused the first approval.
    if (!e.type.startsWith('decision.')) {
      for (const ref of [d?.decision, ...(Array.isArray(d?.decisions) ? d.decisions : []), d?.source?.decision, d?.authority?.decision]) {
        // An escalation is an answer about the course, not a one-use permission: the items recorded under it never use it up
        // (independent review of 0.7.23: the first item left under the person's answer showed it "(used)" and unwithdrawable).
        const spent = typeof ref === 'string' ? s.decisions.find((y) => y.id === ref && y.approved && !y.spent && y.kind !== 'escalation') : null;
        if (spent) spent.spent = { at: e.at, by: e.type };
      }
    }
    switch (e.type) {
      case 'admitted':
        Object.assign(s, {
          id: d.id,
          item: d.item,
          lane: d.lane,
          intent: d.intent,
          ...(typeof d.autoItem === 'boolean' ? { autoItem: d.autoItem } : {}),
          owner: e.actor,
          originRuntime: d.originRuntime ?? ownerRuntime(e.actor),
          owners: [e.actor],
          repos: d.repos,
          adapterBase: d.adapterBase,
          adapter: d.adapter ?? null,
          batch: d.batch ?? null,
          deferHeavy: d.deferHeavy ?? false,
          reopenedFrom: d.reopenedFrom ?? null,
          portOf: d.port?.of ?? null,
          port: d.port ?? null,
          alsoTargets: (d.alsoTargets ?? []).map((t) => ({ ...t, at: e.at, by: e.actor })),
          issue: d.issue ?? null,
          schemaVersion: d.schemaVersion,
          engineVersion: d.engineVersion,
        });
        break;
      case 'intent.changed':
        s.intent = d.to;
        s.intentChanges.push({ from: d.from, to: d.to, reason: d.reason, at: e.at, by: e.actor });
        break;
      case 'owner.adopted':
        s.runtimePreference = null;
        s.owner = e.actor;
        s.ownerTransfers += 1;
        if (!s.owners.includes(e.actor)) s.owners.push(e.actor);
        break;
      case 'criteria.frozen':
        // A second freeze re-plans an analysis attempt upgraded to implementation (I-127): it replaces the first.
        s.plansFrozen = (s.plansFrozen ?? 0) + 1;
        s.planFrozenAt = e.at;
        s.criteria = d.criteria;
        s.criteriaAtFreeze = d.criteria?.length ?? null;
        s.plan = d.plan ?? null;
        s.planSource = d.source ?? null;
        s.expect = expectOf(d.plan?.expect);
        s.expectations = s.expect ? [{ at: e.at, source: 'plan', amendment: null, reason: null, expect: s.expect }] : [];
        s.work = d.work ?? null;
        for (const w of s.work ?? []) s.workIntroduced[w.id] ??= e.at;
        // I-26: the planner's survey and impact map, with what each query returned when the plan was frozen. A sibling
        // attempt a split created carries its parent's addenda (`wf split`).
        s.impact = d.impact ? { ...d.impact, addenda: d.impact.addenda ?? [], owed: null } : null;
        if (s.phase === 'admitted') s.phase = 'planned';
        break;
      // A review observation fixed elsewhere: ticketed (a raw tracker readback) or moved to a sibling attempt (0.7.0).
      case 'scope.decided': // an owner choice recorded before 0.7.0 (the extra-scope flow); only ignore and ticket still settle a finding
      case 'scope.ticketed':
      case 'scope.moved':
      case 'scope.fixed':
      case 'scope.waived':
      case 'scope.deferred':
      case 'scope.notADefect': // 0.7.32 (D71): a finding closed as not a defect by the person's answer
        s.scopeDecisions.push({ ...d, at: e.at });
        break;
      // 0.7.28 (I-207): the person's "fix all", recorded once (engine/cli.mjs `wf scope fix-all`).
      case 'scope.fixAll':
        s.fixAll ??= { words: d.words, at: e.at, by: e.actor, ...(d.via ? { via: d.via } : {}), ...(d.message ? { message: d.message } : {}) };
        break;
      case 'criteria.amended':
        s.criteria = d.criteria;
        // Third review of 0.7.31: each work item an amendment restated (its definition changed), when and in what words, so the
        // course can tell a re-handoff of amended work (planned by the amendment) from one nobody planned (engine/signals.mjs).
        for (const w of d.work ?? []) {
          const before = (s.work ?? []).find((x) => x.id === w.id);
          if (!before || JSON.stringify(before) !== JSON.stringify(w)) (s.workAmended[w.id] ??= []).push({ at: e.at, amendment: s.criteriaAmendments.length + 1, why: [w.why, w.summary, w.text].filter((x) => typeof x === 'string').join(' '), criteria: Array.isArray(w.criteria) ? w.criteria : [] });
        }
        if (d.work) s.work = d.work;
        for (const w of d.work ?? []) s.workIntroduced[w.id] ??= e.at;
        s.criteriaAmendments.push({ at: e.at, reason: d.reason, by: e.actor, changes: d.changes ?? null, impact: d.impact ? true : d.impactOwed ? 'owed' : null, engine: d.engine ?? null, ...(d.withdrewAcceptance === true ? { withdrewAcceptance: true } : {}) });
        // Named failure (I-107): an amendment on an accepted attempt left the acceptance standing, so `wf deliver` shipped a
        // criterion no review had mapped to evidence. The engine that writes the amendment decides (D13: from 0.7.4, for
        // every attempt) and records the decision in the event; an amendment written before that carries no
        // flag, so folding an older ledger again changes nothing. As `validation.added` does, it reopens the attempt.
        if (d.withdrewAcceptance === true) {
          s.accepted = null;
          s.phase = 'implementing';
        }
        // I-120: plan sections an amendment restates replace the frozen ones; what they replaced stays in `planHistory`.
        if (d.plan && typeof d.plan === 'object') {
          (s.planHistory ??= []).push({ at: e.at, amendment: s.criteriaAmendments.length, reason: d.reason, replaced: Object.fromEntries(Object.keys(d.plan).map((k) => [k, s.plan?.[k] ?? null])) });
          s.plan = { ...(s.plan ?? {}), ...d.plan };
        }
        // A re-plan states its own expectation; the earlier ones stay in `expectations`.
        if (expectOf(d.expect)) {
          s.expect = expectOf(d.expect);
          s.expectations.push({ at: e.at, source: 'amendment', amendment: s.criteriaAmendments.length, reason: d.reason, expect: s.expect });
        }
        // I-26: an amendment that adds scope owes an impact update before the next implementer handoff.
        if (d.impact) {
          s.impact ??= { survey: null, impact: null, results: {}, addenda: [], owed: null };
          s.impact.addenda.push({ ...d.impact, at: e.at, amendment: s.criteriaAmendments.length });
          s.impact.owed = null;
        } else if (d.impactOwed) {
          s.impact ??= { survey: null, impact: null, results: {}, addenda: [], owed: null };
          s.impact.owed = { amendment: s.criteriaAmendments.length, reason: d.reason, scope: d.impactOwed };
        }
        break;
      case 'validation.added':
        s.validations.push({ ...d, at: e.at });
        s.accepted = null;
        s.phase = 'implementing';
        break;
      // I-102: supplemental steps re-pinned at a later commit. They leave the record they were registered in (a record left
      // with no step goes) and form a new one at the new commit, so the pin, the digest and the gate order read exactly as
      // after a registration; `validationCorrections` keeps both pins, the reason and who corrected.
      case 'validation.corrected': {
        const fixed = new Set(d.steps.map((x) => x.id));
        s.validations = s.validations.map((v) => ({ ...v, steps: v.steps.filter((x) => !fixed.has(x.id)) })).filter((v) => v.steps.length);
        s.validations.push({ commit: d.commit, steps: d.steps, criteria: d.criteria, reason: d.reason, tree: d.tree, correctedFrom: d.from, at: e.at });
        (s.validationCorrections ??= []).push({ ...d, at: e.at, by: e.actor });
        s.accepted = null;
        s.phase = 'implementing';
        break;
      }
      // 0.7.29 (I-204): the checks a batch's members registered or corrected, carried into the batch when it is assembled
      // (engine/validation.mjs `carriedValidations`). Each record names the members it came from (`carriedFrom`); nothing
      // else changes: the batch has just been created and no review or gate has seen it.
      case 'validation.carried':
        for (const r of d.records ?? []) s.validations.push({ ...r, at: e.at });
        if (d.notCarried?.length) s.validationsNotCarried = d.notCarried;
        break;
      // I-94: captures the owner brought in with `wf captures import`, bound to the tree they were made on; the gate's
      // `screenshots` reads them as its own for that tree (engine/captures.mjs).
      case 'captures.imported':
        (s.captureImports ??= []).push({ ...d, at: e.at, by: e.actor });
        break;
      case 'models.refreshed':
        s.runtimeAdapterBase = d.to;
        (s.modelRefreshes ??= []).push({ ...d, at: e.at, by: e.actor });
        break;
      case 'handoff':
        if (d.runtimeSelected === true && typeof d.runtimeSelectionOwner === 'string' && d.runtimeAuthority) s.runtimePreference = { runtime: d.runtime, owner: d.runtimeSelectionOwner, authority: d.runtimeAuthority };
        s.handoffs.push({ ...d, at: e.at, by: e.actor });
        if (!(s.roles[d.role] ??= []).includes(d.agent)) s.roles[d.role].push(d.agent);
        // A delta-review decision applies to the next reviewer round only.
        if (d.role === 'reviewer') s.strategy.nextRound = null;
        if (d.role === 'implementer' && ['admitted', 'planned'].includes(s.phase)) s.phase = 'implementing';
        break;
      case 'agent.launch.requested': {
        const h = s.handoffs.find((h) => h.bundle === d.handoff);
        if (h) h.launch = { ...d, requestedAt: e.at, status: 'starting' };
        break;
      }
      case 'agent.launch.spawned': {
        const h = s.handoffs.find((h) => h.bundle === d.handoff);
        if (h?.launch) h.launch = { ...h.launch, pid: d.pid, out: d.out, err: d.err, spawnedAt: e.at };
        break;
      }
      case 'agent.launch.started': {
        const h = s.handoffs.find((h) => h.bundle === d.handoff);
        if (h?.launch) { h.session = d.session; h.launch = { ...h.launch, session: d.session, status: 'running', startedAt: e.at }; }
        break;
      }
      // 0.7.30 (I-153): a launch the model's capacity ended, resumed (its session continued, or started again when none had
      // begun): the new process, running again, no longer failed.
      case 'agent.launch.resumed': {
        const h = s.handoffs.find((h) => h.bundle === d.handoff);
        if (h?.launch) {
          const { failure, exitCode, finishedAt, ...kept } = h.launch;
          h.launch = { ...kept, pid: d.pid, out: d.out ?? kept.out, err: d.err ?? kept.err, spawnedAt: e.at, status: h.session ? 'running' : 'starting', resumes: d.resume ?? (kept.resumes ?? 0) + 1 };
        }
        break;
      }
      // Second review of 0.7.30 (I-153): a launch stopped at capacity that the owner settled with `wf handoff close`.
      case 'agent.launch.settled': {
        const h = s.handoffs.find((h) => h.bundle === d.handoff);
        if (h?.launch) h.launch = { ...h.launch, settled: { at: e.at, by: e.actor, reason: d.reason ?? null } };
        break;
      }
      case 'agent.launch.finished': {
        const h = s.handoffs.find((h) => h.bundle === d.handoff);
        if (h?.launch) h.launch = { ...h.launch, status: d.status, exitCode: d.exitCode, finishedAt: e.at, ...(d.failure ? { failure: d.failure } : {}) };
        break;
      }
      case 'gate.finished':
        s.gates.push({ ...d, at: e.at });
        s.phase = d.status === 'passed' ? 'gated' : 'implementing';
        break;
      // `wf check`: light steps only, recorded for reuse, never a gate (acceptance and delivery read `gates` only).
      case 'check.finished':
        s.checks.push({ ...d, at: e.at });
        break;
      case 'gate.flaky':
        s.flaky.push(...d.flaky.map((f) => ({ ...f, at: e.at })));
        break;
      case 'exported':
        s.exports.push({ ...d, at: e.at });
        break;
      case 'gate.stopped':
        s.stops.push({ ...d, at: e.at, reason: d.reason, class: d.class ?? null, runId: d.runId ?? null, discardedMinutes: d.discardedMinutes ?? null });
        break;
      // A review round whose closure was refused because the tree changed during it (I-23): the round is over.
      case 'review.refused':
        s.reviewsRefused.push({ ...d, at: e.at });
        break;
      // 0.7.29 (I-154): why `wf accept` refused the latest review (engine/lifecycle.mjs `acceptReview`).
      case 'acceptance.refused':
        (s.acceptanceRefusals ??= []).push({ ...d, at: e.at, by: e.actor });
        break;
      // A plan `wf plan` refused (I-84, I-87): its kept report and the validator's message, handed to the next planner.
      case 'plan.refused':
        s.planRefusals.push({ ...d, at: e.at });
        break;
      // 0.7.22 (D28): a planning panel's draft, merge or verdict.
      case 'plan.panel':
        (s.panel ??= []).push({ ...d, at: e.at, by: e.actor });
        break;
      // A gate the owner started out of the order of work (I-27), with the reason it was recorded under.
      case 'gate.override':
        s.gateOverrides.push({ ...d, at: e.at, by: e.actor });
        break;
      // A reviewer handed the tree while an implementer handoff was open (I-23), with the reason it was recorded under.
      case 'review.override':
        s.reviewOverrides.push({ ...d, at: e.at, by: e.actor });
        break;
      // One per `wf review` outcome on a reviewer handoff: recorded (blind or with prior findings) or refused.
      case 'review.round':
        s.reviewRounds.push({ ...d, at: e.at });
        break;
      case 'implementer.opened':
        s.implementers.push({ handoff: d.handoff, agent: d.agent, work: d.work ?? null, heads: d.heads ?? null, openedAt: e.at, closedAt: null, outcome: null });
        break;
      case 'product.decided':
        s.productDecisions.push({ ...d, at: e.at, by: e.actor });
        break;
      case 'product.withdrawn': {
        const x = s.productDecisions.find((y) => y.id === d.id);
        if (x) x.withdrawn = { reason: d.reason, at: e.at, by: e.actor };
        break;
      }
      case 'implementer.report':
        (s.implementerReports ??= []).push({ handoff: d.handoff, agent: d.agent, at: e.at, summary: d.summary, approach: d.approach, expect: expectOf(d.expect), ran: d.ran, proofs: d.proofs, left: d.left, ...(d.replan ? { replan: d.replan } : {}), ...(d.premises ? { premises: d.premises } : {}), ...(d.premiseFailed ? { premiseFailed: d.premiseFailed } : {}) });
        break;
      case 'implementer.closed': {
        const x = s.implementers.filter((y) => y.agent === d.agent && !y.closedAt).at(-1);
        if (x) Object.assign(x, { closedAt: e.at, outcome: d.outcome ?? 'done', closedHeads: d.heads ?? null, commits: d.commits ?? null, ...(d.closedBy ? { closedBy: d.closedBy } : {}) });
        break;
      }
      case 'scope.changed': {
        s.scopeChanges.push({ ...d, at: e.at });
        // Third review of 0.7.31: what the amendment says it changes in the contract (`scope.endpoints`, `scope.errorCodes`).
        const a = s.criteriaAmendments[(d.amendment ?? 0) - 1];
        if (a) a.scope = { endpoints: d.endpoints ?? null, errorCodes: d.errorCodes ?? null, names: [...(d.stated?.endpoints ?? []), ...(d.stated?.errorCodes ?? [])] };
        break;
      }
      case 'subagents.attributed':
        for (const c of d.children ?? []) if (!s.subagents.some((y) => y.agentId === c.agentId)) s.subagents.push({ ...c, parentHandoff: d.handoff, at: e.at });
        break;
      case 'review.part.recorded':
        s.reviewParts.push({ ...d, at: e.at });
        break;
      case 'review.recorded':
        s.review = { ...d, at: e.at, closure: withMoved(s, d.closure) };
        s.reviews.push({ reviewer: d.closure?.reviewer ?? null, mode: d.mode ?? null, at: e.at, reviewerModel: d.reviewerModel ?? null, handoff: d.handoff ?? null, covered: d.covered ?? null, ...(d.discoveredHanded ? { discoveredHanded: d.discoveredHanded } : {}), ...(d.recordedBy ? { recordedBy: d.recordedBy } : {}), ...(d.partial ? { partial: true } : {}), revealed: d.revealed ?? false, closure: withMoved(s, d.closure), provenance: d.provenance ?? null, identity: d.identity ?? null, reads: d.reads ?? null, raw: d.raw ?? null, tree: d.tree });
        break;
      case 'base.merged':
        s.baseMerges.push({ ...d, at: e.at, n: (s.baseCount += 1) });
        // 0.7.26 (I-183): a base merged into an attempt whose delivery had started moved the commit the acceptance names (the one
        // the pending integration was opened for), so the engine that writes the event decides and records it
        // (`withdrewAcceptance`), as an amendment does (I-107): folding an older ledger changes nothing.
        if (d.withdrewAcceptance === true) {
          s.accepted = null;
          s.phase = 'implementing';
        }
        break;
      // 0.7.34 (I-233): a base merge the engine classified when it first saw it (made by hand, or recorded by `wf base merge`
      // before its facts were): the facts join the recorded merge, or the merge is listed as one the attempt holds.
      case 'base.observed': {
        const known = [...s.baseMerges, ...s.baseObserved].find((m) => m.repo === d.repo && (m.merge === d.merge || m.headAfter === d.merge));
        if (known) {
          const { repo: _r, ref: _f, from: _a, to: _b, ...facts } = d;
          Object.assign(known, facts, { observedAt: e.at });
        }
        else s.baseObserved.push({ ...d, at: e.at, n: (s.baseCount += 1) });
        break;
      }
      case 'review.accepted':
        s.accepted = { ...d, at: e.at };
        s.phase = 'accepted';
        break;
      case 'hold':
        s.holds.push({ reason: d.reason, at: e.at, by: e.actor, released: null, decision: d.decision ?? null });
        break;
      case 'release':
        for (const h of s.holds) if (!h.released) h.released = e.at;
        break;
      case 'repo.delivered':
        s.delivery.repos[d.repo] = d;
        break;
      // What the delivery adapter last reported for a repo it has not delivered yet (I-20): the integrate result and the
      // observed state. A later `wf deliver` asks the adapter again with it, and the delivery output shows it.
      case 'repo.integrating':
        s.delivery.integrating[d.repo] = { ...d, at: e.at };
        break;
      // 0.7.30 (I-151, D60): the attempt took the adapter committed on its base branch. The engine that writes the event decides
      // what the delivery reads (a delivery started under another adapter kind keeps its pin), whether the execution pin moves
      // with it and whether the acceptance is withdrawn, so an older ledger folds as it did.
      case 'adapter.followed':
        s.adapterPin = d.to;
        s.adapterHeld = null;
        s.adapterFollows.push({ ...d, at: e.at });
        s.deliveryAdapterBase = d.delivery?.mode === 'kept' ? d.delivery.pin : null;
        if (d.runtime === true) s.runtimeAdapterBase = null;
        if (d.withdrewAcceptance === true) {
          s.accepted = null;
          s.phase = 'implementing';
        }
        break;
      case 'targets.added':
        for (const t of d.targets ?? []) s.alsoTargets.push({ ...t, reason: d.reason ?? null, at: e.at, by: e.actor });
        break;
      case 'adapter.authored':
        for (const c of d.changes ?? []) if (!s.adapterAuthored.some((a) => a.file === c.file && a.change === c.change)) s.adapterAuthored.push({ ...c, at: e.at });
        break;
      case 'adapter.notFollowed':
        s.adapterHeld = { tip: d.tip, ref: d.ref, why: d.why, at: e.at };
        // Review of 0.7.30: the attempt's own change on the base branch holds its pin for good.
        if (Array.isArray(d.own) && d.own.length) s.adapterOwnHeld = { paths: d.own, tip: d.tip, at: e.at };
        break;
      // I-21: the owner re-pinned the delivery adapter of an attempt that has not delivered everything to the adapter now
      // committed on the base branch. Only delivery reads it. Since 0.7.30 the attempt follows its base branch by itself
      // (above); a re-pin is left for a delivery whose adapter kind changed half way.
      case 'adapter.repinned':
        s.deliveryAdapterBase = d.to;
        s.adapterRepins.push({ from: d.from, to: d.to, reason: d.reason, changed: d.changed ?? [], delivered: d.delivered ?? {}, at: e.at, by: e.actor });
        break;
      case 'delivered':
        s.delivery.completedAt = e.at;
        s.phase = 'handoff-pending';
        break;
      // 0.7.27 (I-196, D42): the delivery waits after its tracker handoff until the deployment is confirmed and the fix tested where
      // it runs. `owed` says why (the label, or every ticket), where it deploys and who checks it (the delivery adapter, or the agent).
      case 'deployment.owed':
        s.deployment = { owed: { where: d.where, label: d.label ?? null, check: d.check ?? 'agent', ...(d.commits ? { commits: d.commits } : {}), at: e.at }, observations: [], tested: null, closed: null };
        break;
      case 'deployment.observed':
        (s.deployment ??= { owed: null, observations: [], tested: null, closed: null }).observations.push({ state: d.state, source: d.source, observed: d.observed ?? null, evidence: d.evidence ?? null, repos: d.repos ?? null, at: e.at, by: e.actor });
        break;
      case 'deployment.tested':
        (s.deployment ??= { owed: null, observations: [], tested: null, closed: null }).tested = { result: d.result, text: d.text, at: e.at, by: e.actor };
        break;
      // The person's decision to close the delivery without a confirmed deployment: the ticket is left where the delivery put it.
      case 'deployment.closed':
        (s.deployment ??= { owed: null, observations: [], tested: null, closed: null }).closed = { reason: d.reason, decision: d.decision ?? null, last: d.last ?? null, at: e.at, by: e.actor };
        break;
      // The delivered screenshot set (with titles and proposed captions), recorded at delivery, and the owner's
      // acknowledgement that each was shown in the chat with its caption (or, for an empty set, the statement why).
      case 'delivery.screenshots':
        s.delivery.screenshots = { screenshots: d.screenshots ?? [], none: d.none ?? null, at: e.at };
        break;
      // `wf delivery narrow`: the owner kept a subset of a delivered set an over-broad glob filled. The set, and the
      // pending `delivered` attach action whichever came first in the ledger, both derive from the kept list.
      case 'delivery.narrowed': {
        const keep = new Set(d.keep ?? []);
        const added = Array.isArray(d.added) ? d.added : [];
        if (s.delivery.screenshots) s.delivery.screenshots = { ...s.delivery.screenshots, screenshots: keptFiles([...s.delivery.screenshots.screenshots, ...added], [...keep]) };
        s.delivery.narrowed = { from: d.from, to: d.to, dropped: d.dropped, added, reason: d.reason, legacy: d.legacy === true, keep: [...keep], raw: d.raw ?? null, at: e.at, by: e.actor };
        s.tracker.pending = s.tracker.pending.map((a) => narrowAttach(a, s.delivery.narrowed));
        break;
      }
      case 'delivery.shown':
        s.delivery.shown = { screenshots: d.screenshots ?? [], none: d.none ?? null, auto: d.auto === true, anomalies: d.anomalies ?? null, raw: d.raw ?? null, at: e.at, by: e.actor };
        if (!d.auto) s.delivery.shownRecords = (s.delivery.shownRecords ?? 0) + 1;
        break;
      // The owner's plain-language summary for the delivered comment (the latest one counts).
      case 'delivery.summary':
        // 0.7.17: the owner's tester wording per known-limit item, kept across summaries until replaced.
        s.delivery.summary = { text: d.text, sha256: d.sha256, raw: d.raw ?? null, at: e.at, by: e.actor, ...((d.lines ?? s.delivery.summary?.lines) ? { lines: d.lines ?? s.delivery.summary.lines } : {}) };
        s.delivery.summaries = (s.delivery.summaries ?? 0) + 1;
        break;
      // `wf export screenshots` (and closing): viewable copies of the delivered set outside the evidence.
      case 'screenshots.exported':
        s.delivery.exported = { dir: d.dir, files: d.files ?? [], at: e.at };
        break;
      // Lessons (engine/lessons.mjs): recorded for this attempt, waived with a reason, or recurring.
      case 'lesson.recorded':
        (s.lessons ??= { recorded: [], waived: null, recurred: [] }).recorded.push({ id: d.id, for: d.for ?? null, at: e.at, by: e.actor });
        break;
      case 'lesson.waived':
        (s.lessons ??= { recorded: [], waived: null, recurred: [] }).waived = { reason: d.reason, at: e.at, by: e.actor };
        break;
      case 'lesson.acknowledged':
        ((s.lessons ??= { recorded: [], waived: null, recurred: [] }).acknowledged ??= []).push({ lesson: d.lesson, ack: d.ack, line: d.line, repo: d.repo, commit: d.commit, at: e.at });
        break;
      case 'lesson.recurred':
        (s.lessons ??= { recorded: [], waived: null, recurred: [] }).recurred.push({ id: d.id, recurrence: d.recurrence, why: d.why ?? null, at: e.at });
        break;
      // 0.7.9 (D19): the classifier's labels at acceptance (findings and lessons to the lesson describing the same mistake),
      // and lessons merged into one in this attempt.
      case 'lessons.labelled':
        (s.learning ??= []).push({ ...d, at: e.at });
        break;
      case 'lesson.merged':
        ((s.lessons ??= { recorded: [], waived: null, recurred: [] }).merged ??= []).push({ id: d.id, merged: d.merged ?? [], at: e.at, by: e.actor });
        break;
      // The discovered-issue ledger (I-18): every issue found during the ticket, fixed or deferred in the owner's words.
      case 'discovered.added':
        s.discovered.push({ id: d.id, summary: d.summary, kind: d.kind ?? 'defect', severity: d.severity ?? null, invariant: d.invariant ?? null, scope: d.scope ?? null, where: d.where ?? null, foundBy: d.foundBy ?? null, ...(d.family ? { family: d.family } : {}), blockedBy: d.blockedBy ?? null, anchor: d.anchor ?? null, ...(d.movedFrom ? { movedFrom: d.movedFrom } : {}), ...(d.raisedOn ? { raisedOn: d.raisedOn } : {}), at: e.at, by: e.actor, status: 'open', fixed: null, deferred: null });
        break;
      // Review of 0.7.31 (L3): a reviewer's line on the premise behind an issue, whatever its verdict.
      case 'discovered.premise': {
        const x = s.discovered.find((y) => y.id === d.id);
        if (x) (x.premises ??= []).push({ reviewer: d.reviewer ?? null, verdict: d.verdict ?? null, premise: d.premise, evidence: d.evidence ?? null, at: e.at });
        break;
      }
      case 'discovered.rated': {
        const x = s.discovered.find((y) => y.id === d.id);
        if (x) {
          x.rated = [...(x.rated ?? []), { from: d.from ?? null, to: d.severity, by: e.actor, at: e.at, reason: d.reason ?? null, decision: d.decision ?? null }];
          x.severity = d.severity;
        }
        break;
      }
      case 'discovered.closed': {
        const x = s.discovered.find((y) => y.id === d.id);
        if (!x) break;
        x.status = d.outcome;
        delete x.claim;
        if (d.outcome === 'fixed') x.fixed = { repo: d.repo, commit: d.commit, evidence: d.evidence ?? null, ...(d.reconciled ? { reconciled: d.reconciled } : {}), ...(d.beforeRecord ? { beforeRecord: true } : {}), ...(d.verifiedBy ? { verifiedBy: d.verifiedBy } : {}), at: e.at, by: e.actor };
        // 0.7.27 (I-188): the claim stays as recorded; why it is not a defect, and who said so, are kept beside it.
        else if (d.outcome === 'not-a-defect') x.notADefect = { reason: d.reason, evidence: d.evidence ?? null, source: d.source ?? null, ...(d.personDirected ? { personDirected: d.personDirected } : {}), attributedTo: d.attributedTo ?? null, at: e.at, by: e.actor };
        else x.deferred = { decision: d.decision, source: d.source ?? null, attributedTo: d.attributedTo ?? null, at: e.at, by: e.actor };
        break;
      }
      // 0.7.19: a high defect fixed before it was recorded waits for a reviewer's verification of that commit.
      case 'discovered.claimed': {
        const x = s.discovered.find((y) => y.id === d.id);
        if (x) x.claim = { repo: d.repo, commit: d.commit, evidence: d.evidence ?? null, at: e.at, by: e.actor };
        break;
      }
      // The owner saw each deferral at delivery and acknowledged it (second security review of 0.4.5).
      case 'discovered.acknowledged':
        for (const id of d.ids ?? []) {
          const x = s.discovered.find((y) => y.id === id);
          if (x?.deferred) x.deferred.acknowledged = { at: e.at, by: e.actor };
        }
        break;
      // A repo added to the running attempt by an owner amendment (I-19): it is part of the change from then on.
      case 'repo.added':
        s.repos[d.repo] = d.entry;
        s.addedRepos.push({ repo: d.repo, reason: d.reason, base: d.entry.base, at: e.at, by: e.actor });
        break;
      case 'reopen.reason':
        s.reopenReason = d.reason;
        break;
      // The evidence manifest: every file wf wrote into this attempt's evidence, with its sha256, size and mode.
      case 'evidence.recorded':
      case 'evidence.baseline':
        s.evidenceFiles = (s.evidenceFiles ?? 0) + (d.files?.length ?? 0);
        if (e.type === 'evidence.baseline') s.evidenceBaseline = { at: e.at, files: d.files?.length ?? 0 };
        break;
      // `wf verify --accept-changes`: the owner accepted changed, added or removed evidence files, with a reason.
      case 'evidence.rebaselined':
        (s.rebaselines ??= []).push({ at: e.at, by: e.actor, reason: d.reason, changes: d.changes ?? [] });
        break;
      // A gate run's steps as each finished: what a dead runner's run is recovered from (never its progress file).
      case 'gate.started':
        (s.gateRuns ??= {})[d.runId] = { kind: d.kind ?? 'gate', steps: [] };
        break;
      case 'gate.step':
        ((s.gateRuns ??= {})[d.runId] ??= { kind: 'gate', steps: [] }).steps.push(...(d.steps ?? [d.step]).filter(Boolean));
        break;
      case 'batch.member.delivered':
        s.delivery.completedAt = e.at;
        s.delivery.viaBatch = d.batch;
        s.phase = 'handoff-pending';
        break;
      case 'batch.members':
        s.batch = { members: d.members, heads: { ...(s.batch?.heads ?? {}), ...(d.heads ?? {}) } };
        // 0.7.29 (I-204): an ejected member's carried checks leave with it (its change is no longer in the batch's tree). A
        // check another member carried too stays, pinned at that member's commit.
        if (d.ejected) {
          s.validations = s.validations.map((v) => {
            if (!v.carriedFrom) return v;
            const left = v.carriedFrom.filter((c) => c.attempt !== d.ejected);
            return left.length === v.carriedFrom.length ? v : { ...v, carriedFrom: left, commit: left[0]?.commit ?? v.commit };
          }).filter((v) => !v.carriedFrom || v.carriedFrom.length);
        }
        break;
      case 'batch.joined':
        s.batchOf = d.batch;
        s.batchPending = d.pending === true;
        break;
      case 'batch.ejected':
        s.batchOf = null;
        s.batchPending = false;
        break;
      // The strategist's recorded decision (engine/strategy.mjs): the action, its prediction and why it was handed.
      case 'strategy.decided': {
        const id = d.id ?? `S${s.strategy.decisions.length + 1}`;
        s.strategy.decisions.push({ id, at: e.at, by: e.actor, action: d.action, rationale: d.rationale, prediction: d.prediction ?? null, items: d.items ?? [], split: d.split ?? null, model: d.model ?? null, strategist: d.strategist ?? null, handoff: d.handoff ?? null, handedBecause: d.handedBecause ?? null, escalation: d.escalation ?? null, roundsAtDecision: d.roundsAtDecision ?? null, signals: d.signals ?? null, ...(d.course ? { course: d.course } : {}), ...(d.expect ? { expect: d.expect } : {}), ...(d.premise ? { premise: d.premise } : {}) });
        // 0.7.28 (I-210): a strategist's own expectation (continue with a new expectation) is what the course is compared with next.
        if (expectOf(d.expect)) {
          s.expect = { ...(s.expect ?? {}), ...expectOf(d.expect) };
          s.expectations.push({ at: e.at, source: 'strategy', amendment: null, decision: id, reason: d.rationale ?? null, expect: expectOf(d.expect) });
        }
        for (const o of d.outcomes ?? []) s.strategy.outcomes[o.decision] = { status: o.status, observed: o.observed ?? null, at: e.at };
        if (d.action === 'delta-review') s.strategy.nextRound = 'delta';
        // A model decision: the next handoffs of that role run at the class it names (engine/models.mjs).
        if (d.action === 'model' && d.model?.role && d.model?.class) s.strategy.classFor = { ...(s.strategy.classFor ?? {}), [d.model.role]: d.model.class };
        if (d.action === 'ticket') s.strategy.toTicket.push({ decision: id, items: d.items ?? [], at: e.at });
        break;
      }
      // The owner escalation the engine saw fire and refused on (measurement for the report).
      case 'strategy.tripwire':
        if (!s.strategy.tripwires.some((t) => t.id === d.tripwire && t.key === d.key)) s.strategy.tripwires.push({ id: d.tripwire, key: d.key, summary: d.summary ?? null, at: e.at });
        break;
      // `wf split` on the parent: what moved to which sibling attempts. Moved obligations leave this attempt's open set.
      case 'split.performed': {
        const m = d.moved ?? {};
        s.splits.push({ id: d.id, at: e.at, by: e.actor, reason: d.reason, siblings: d.siblings ?? [], moved: m, batch: d.batch ?? null });
        const gone = (key) => new Set(m[key] ?? []);
        if (gone('criteria').size) s.criteria = (s.criteria ?? []).filter((c) => !gone('criteria').has(c.id));
        if (gone('work').size && s.work) s.work = s.work.filter((w) => !gone('work').has(w.id));
        if (gone('discovered').size) s.discovered = s.discovered.filter((x) => !gone('discovered').has(x.id));
        for (const key of Object.keys(s.strategy.moved)) s.strategy.moved[key].push(...(m[key] ?? []));
        if (m.findings?.length) {
          if (s.review) s.review = { ...s.review, closure: withMoved(s, s.review.closure) };
          s.reviews = s.reviews.map((r) => ({ ...r, closure: withMoved(s, r.closure) }));
        }
        break;
      }
      // `wf split` on a sibling attempt: where its obligations came from.
      case 'split.created':
        s.splitFrom = { attempt: d.from, split: d.split, items: d.items ?? [], reason: d.reason, at: e.at, intentChanges: d.intentChanges ?? [] };
        break;
      case 'tracker.pending':
        // 0.7.23 (I-178): a batch has no ticket, so its derived state never owes a tracker step. A 0.7.20 engine queued one
        // (it excluded the quick lane only), and the owner was told to do it for the batch's own id; the event stays in the
        // chain, and a relaxation applies to every attempt (D7). The same holds for an attempt that owns its item (a numbered
        // quick fix, engine/tracker.mjs ownItem): an older engine could queue its `integrating` step.
        if (s.lane === 'batch' || (typeof s.autoItem === 'boolean' ? s.autoItem : /^QF-\d+$/.test(String(s.item ?? '')))) break;
        s.tracker.pending.push(...d.actions.map((a) => narrowAttach({ ...a, event: d.event }, s.delivery.narrowed)));
        s.tracker.pendingAt = { ...(s.tracker.pendingAt ?? {}), [d.event]: e.at };
        break;
      case 'tracker.recorded':
        s.tracker.pending = s.tracker.pending.filter((a) => a.event !== d.event);
        s.tracker.done.push({ event: d.event, at: e.at, capture: d.capture, provenance: d.provenance ?? null, verified: d.verified ?? null, ...(d.mode ? { mode: d.mode, readAt: d.readAt ?? null, comment: d.comment ?? null } : {}), ...(d.host ? { host: d.host } : {}), ...(Array.isArray(d.labels) ? { labels: d.labels } : {}), ...(Array.isArray(d.routed) && d.routed.length ? { routed: d.routed } : {}), extraLines: d.extraLines ?? [], ...(d.attachments ? { attachments: d.attachments } : {}) });
        break;
      case 'decision.created':
        // 0.7.11: a decision may carry the person's words for it: a plain question, a plain label and what follows for each
        // choice, and a recommendation (engine/approve.mjs). 0.7.23 (D29): the agent's context and technical line, the plain
        // line per item it names, and the items an escalation's choices decide.
        s.decisions.push({ id: d.id, kind: d.kind, key: d.key, summary: d.summary, choices: d.choices, ...(d.plain ? { plain: d.plain } : {}), ...(d.labels ? { labels: d.labels } : {}), ...(d.then ? { then: d.then } : {}), ...(d.recommend ? { recommend: d.recommend } : {}), ...(d.context ? { context: d.context } : {}), ...(d.technical ? { technical: d.technical } : {}), ...(d.items ? { items: d.items } : {}), ...(d.settles ? { settles: d.settles } : {}), ...(d.personDirected ? { personDirected: d.personDirected } : {}), createdAt: e.at, by: e.actor, approved: null, ...(d.what ? { what: d.what } : {}) });
        break;
      case 'decision.approved': {
        const x = s.decisions.find((y) => y.id === d.id);
        // 0.7.27 (D41): an answer the agent read carries the words it relied on (`quote`) and the person's whole message; the
        // message it answered is kept for every chat or panel answer.
        if (x) x.approved = { choice: d.choice, at: e.at, via: d.via, ...(d.words ? { words: d.words } : {}), ...(d.reply ? { reply: d.reply } : {}), ...(d.quote ? { quote: d.quote, message: d.message ?? null } : {}), ...(d.question ? { question: d.question } : {}) };
        break;
      }
      // A question withdrawn by the owner (0.7.8): its subject changed, so it is no longer asked; it never granted anything.
      case 'decision.withdrawn': {
        const x = s.decisions.find((y) => y.id === d.id);
        if (x) x.withdrawn = { reason: d.reason ?? null, at: e.at, by: e.actor };
        break;
      }
      case 'closed':
        s.closedAt = e.at;
        s.phase = 'done';
        break;
      case 'abandoned':
        s.abandoned = { reason: d.reason, at: e.at };
        s.phase = 'abandoned';
        break;
      // 0.7.31 (I-216, D67): an analysis attempt's findings, and its close once what follows is decided.
      case 'analysis.recorded':
        s.analyses.push({ ...d, at: e.at, by: e.actor });
        break;
      case 'analysis.closed':
        s.analysisClosed = { reason: d.reason, analysis: d.analysis ?? null, at: e.at, by: e.actor };
        s.closedAt = e.at;
        s.phase = 'done';
        break;
      // I-116: closed as it shipped, outside the workflow's acceptance (the person's decision); its hold ends with it.
      case 'shipped.closed':
        s.shipped = { reason: d.reason, at: e.at, decision: d.decision ?? null, repos: d.repos ?? {}, open: d.open ?? null };
        s.phase = 'done';
        for (const h of s.holds) if (!h.released) h.released = { at: e.at, by: e.actor, decision: d.decision ?? null, closedAsShipped: true };
        break;
      default:
        break;
    }
  }
  s.activeHold = s.holds.find((h) => !h.released) ?? null;
  s.lastGate = s.gates.at(-1) ?? null;
  return s;
}

export const loadState = (root, id) => reduce(readLedger(root, id));

export function assertSchema(state) {
  if (state.schemaVersion > SCHEMA_VERSION) {
    throw refuse(`attempt ${state.id} was created by engine ${state.engineVersion} (schema ${state.schemaVersion}); this engine reads up to schema ${SCHEMA_VERSION}`, `update agentic-workflow to ${state.engineVersion} or later`);
  }
  if (state.schemaVersion < SCHEMA_VERSION - 1) {
    throw refuse(`attempt ${state.id} uses schema ${state.schemaVersion}; this engine reads schema ${SCHEMA_VERSION - 1} and ${SCHEMA_VERSION}`, `finish it with agentic-workflow ${state.engineVersion}`);
  }
}
