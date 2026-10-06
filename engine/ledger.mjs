import fs from 'node:fs';
import path from 'node:path';
import { ENGINE_VERSION, SCHEMA_VERSION, WfError, canonical, now, refuse, sha256, withFileLock } from './util.mjs';
import { prepareWrite, touch, writeAnchor, writeNoFollow } from './evidence.mjs';

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
  const file = ledgerFile(root, id);
  if (!fs.existsSync(file)) throw new WfError(`unknown attempt ${id}`);
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  const entries = [];
  let prev = null;
  for (const [i, line] of lines.entries()) {
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      throw new WfError(`${file}: line ${i + 1} is not JSON; the ledger was edited by hand`);
    }
    if (entry.prev !== prev || entry.hash !== entryHash(entry)) {
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
  const file = ledgerFile(root, id);
  // A re-baseline is the one entry appended to an attempt that does not verify: `wf verify --accept-changes` has just
  // checked its chain and anchor and shown the owner every difference.
  if (type !== 'evidence.rebaselined') openEvidence(root, id);
  prepareWrite(file);
  fs.mkdirSync(path.dirname(file), { recursive: true });
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
const narrowAttach = (a, narrowed) => (narrowed && a.event === 'delivered' && a.op === 'attach' ? { ...a, files: keptFiles(a.files, narrowed.keep) } : a);

// Derived state. Everything a command decides is computed from the ledger, never stored separately.
export function reduce(entries) {
  const s = {
    id: null,
    item: null,
    lane: null,
    intent: null,
    owner: null,
    owners: [],
    phase: 'admitted',
    repos: {},
    adapterBase: null,
    criteria: null,
    criteriaAmendments: [],
    plan: null,
    planSource: null,
    work: null,
    roles: { planner: [], implementer: [], reviewer: [], tester: [] },
    handoffs: [],
    gates: [],
    checks: [],
    flaky: [],
    exports: [],
    review: null,
    reviews: [],
    baseMerges: [],
    accepted: null,
    holds: [],
    delivery: { repos: {}, completedAt: null },
    tracker: { pending: [], done: [] },
    batch: null,
    batchOf: null,
    deferHeavy: false,
    reopenedFrom: null,
    stops: [],
    closedAt: null,
    abandoned: null,
    schemaVersion: null,
    engineVersion: null,
  };
  for (const e of entries) {
    const d = e.data;
    switch (e.type) {
      case 'admitted':
        Object.assign(s, {
          id: d.id,
          item: d.item,
          lane: d.lane,
          intent: d.intent,
          owner: e.actor,
          owners: [e.actor],
          repos: d.repos,
          adapterBase: d.adapterBase,
          batch: d.batch ?? null,
          deferHeavy: d.deferHeavy ?? false,
          reopenedFrom: d.reopenedFrom ?? null,
          issue: d.issue ?? null,
          schemaVersion: d.schemaVersion,
          engineVersion: d.engineVersion,
        });
        break;
      case 'owner.adopted':
        s.owner = e.actor;
        if (!s.owners.includes(e.actor)) s.owners.push(e.actor);
        break;
      case 'criteria.frozen':
        s.criteria = d.criteria;
        s.plan = d.plan ?? null;
        s.planSource = d.source ?? null;
        s.work = d.work ?? null;
        if (s.phase === 'admitted') s.phase = 'planned';
        break;
      case 'criteria.amended':
        s.criteria = d.criteria;
        if (d.work) s.work = d.work;
        s.criteriaAmendments.push({ at: e.at, reason: d.reason, by: e.actor, changes: d.changes ?? null });
        break;
      case 'handoff':
        s.handoffs.push({ ...d, at: e.at, by: e.actor });
        if (!s.roles[d.role].includes(d.agent)) s.roles[d.role].push(d.agent);
        if (d.role === 'implementer' && ['admitted', 'planned'].includes(s.phase)) s.phase = 'implementing';
        break;
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
        s.stops.push({ at: e.at, reason: d.reason });
        break;
      case 'review.recorded':
        s.review = { ...d, at: e.at };
        s.reviews.push({ reviewer: d.closure?.reviewer ?? null, at: e.at, reviewerModel: d.reviewerModel ?? null, handoff: d.handoff ?? null, revealed: d.revealed ?? false, closure: d.closure, provenance: d.provenance ?? null, reads: d.reads ?? null, raw: d.raw ?? null, tree: d.tree });
        break;
      case 'base.merged':
        s.baseMerges.push({ ...d, at: e.at });
        break;
      case 'review.accepted':
        s.accepted = { ...d, at: e.at };
        s.phase = 'accepted';
        break;
      case 'hold':
        s.holds.push({ reason: d.reason, at: e.at, by: e.actor, released: null });
        break;
      case 'release':
        for (const h of s.holds) if (!h.released) h.released = e.at;
        break;
      case 'repo.delivered':
        s.delivery.repos[d.repo] = d;
        break;
      case 'delivered':
        s.delivery.completedAt = e.at;
        s.phase = 'handoff-pending';
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
        if (s.delivery.screenshots) s.delivery.screenshots = { ...s.delivery.screenshots, screenshots: keptFiles(s.delivery.screenshots.screenshots, [...keep]) };
        s.delivery.narrowed = { from: d.from, to: d.to, dropped: d.dropped, reason: d.reason, legacy: d.legacy === true, keep: [...keep], raw: d.raw ?? null, at: e.at, by: e.actor };
        s.tracker.pending = s.tracker.pending.map((a) => narrowAttach(a, s.delivery.narrowed));
        break;
      }
      case 'delivery.shown':
        s.delivery.shown = { screenshots: d.screenshots ?? [], none: d.none ?? null, auto: d.auto === true, anomalies: d.anomalies ?? null, raw: d.raw ?? null, at: e.at, by: e.actor };
        if (!d.auto) s.delivery.shownRecords = (s.delivery.shownRecords ?? 0) + 1;
        break;
      // The owner's plain-language summary for the delivered comment (the latest one counts).
      case 'delivery.summary':
        s.delivery.summary = { text: d.text, sha256: d.sha256, raw: d.raw ?? null, at: e.at, by: e.actor };
        s.delivery.summaries = (s.delivery.summaries ?? 0) + 1;
        break;
      // `wf export screenshots` (and closing): viewable copies of the delivered set outside the evidence.
      case 'screenshots.exported':
        s.delivery.exported = { dir: d.dir, files: d.files ?? [], at: e.at };
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
        break;
      case 'batch.joined':
        s.batchOf = d.batch;
        break;
      case 'batch.ejected':
        s.batchOf = null;
        break;
      case 'tracker.pending':
        s.tracker.pending.push(...d.actions.map((a) => narrowAttach({ ...a, event: d.event }, s.delivery.narrowed)));
        break;
      case 'tracker.recorded':
        s.tracker.pending = s.tracker.pending.filter((a) => a.event !== d.event);
        s.tracker.done.push({ event: d.event, at: e.at, capture: d.capture, ...(d.attachments ? { attachments: d.attachments } : {}) });
        break;
      case 'closed':
        s.closedAt = e.at;
        s.phase = 'done';
        break;
      case 'abandoned':
        s.abandoned = { reason: d.reason, at: e.at };
        s.phase = 'abandoned';
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
