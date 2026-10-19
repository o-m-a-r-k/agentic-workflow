// The attempt ledger (design-0.8 section 7): one hash-chained JSON line per event under
// `<root>/.wf-evidence/attempts/<attempt>/ledger.jsonl`. Stream 5 is its only writer; every other stream appends through
// the contract's `append` facade and reads through `readEvents`, `attemptState` and `listAttempts`.
//
// Each entry is { seq, at, type, actor, data, prev, schema: 2, hash }, hash = sha256 of the canonical JSON of the entry
// without `hash`, prev = the hash before it. 0.7 wrote the same chain without `schema` (schema 1), so a 0.7 ledger reads
// and verifies with the same code, and migration can append a schema 2 `attempt.closed` to it. The chain is unkeyed: it
// finds an edit (a careless hand or a tool), not a forger with shell access (D6).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { EVENTS, PROJECT_LEDGER, SCHEMA, WfError, attemptDir, canonicalJson, ledgerFile } from './contract.mjs';
import { mkdirStateDirectory } from './state-folders.mjs';
import { withFileLock } from './util.mjs';

export { attemptDir };

// The clock every stream-5 module reads. Scenarios set it to make gaps and windows exact; production never does.
let clock = () => new Date();
export const setClock = (fn) => {
  clock = fn ?? (() => new Date());
};
export const nowIso = () => clock().toISOString();
export const nowMs = () => clock().getTime();

const entryHash = (entry) => {
  const { hash, ...rest } = entry;
  return crypto.createHash('sha256').update(canonicalJson(rest)).digest('hex');
};

// An attempt id is one folder name: `<item>.<n>` in 0.8, anything 0.7 used before (a batch id). Never a path.
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
function assertId(attempt) {
  if (typeof attempt !== 'string' || !SAFE_ID.test(attempt) || attempt.includes('..')) throw new WfError(`not an attempt id: \`${attempt}\``);
}

// Entries verified once per file size and modification time, so repeated reads in one process hash nothing twice.
const verified = new Map();

function readFile(root, attempt) {
  assertId(attempt);
  const file = ledgerFile(root, attempt);
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    throw new WfError(`unknown attempt ${attempt}: no ledger at ${file}`);
  }
  const cached = verified.get(file);
  if (cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) return cached.entries;
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  const entries = [];
  let prev = null;
  for (const [i, line] of lines.entries()) {
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      throw new WfError(`${file}: line ${i + 1} is not JSON; the ledger was edited outside wf`);
    }
    if (entry.prev !== prev || entry.hash !== entryHash(entry)) {
      throw new WfError(`${file}: hash chain broken at entry ${entry.seq ?? i + 1}; the ledger was edited outside wf`);
    }
    prev = entry.hash;
    entries.push(entry);
  }
  verified.set(file, { size: stat.size, mtimeMs: stat.mtimeMs, entries });
  return entries;
}

/** Every entry of an attempt's ledger, schema 1 or 2, chain checked. */
export async function readEvents(root, attempt) {
  return readFile(root, attempt).map((e) => structuredClone(e));
}

/** Append one schema 2 event, serialised per attempt. `unless(entries)`, run under the lock, skips it (returns null). */
export async function append(root, attempt, type, data, actor = null, { unless = null } = {}) {
  assertId(attempt);
  // Doubles replace other streams in tests only. A process carrying WF_DOUBLES outside a test would write facts a double
  // invented into a real ledger.
  if (process.env.WF_DOUBLES && process.env.WF_TEST !== '1') throw new WfError('WF_DOUBLES is set outside a test (WF_TEST=1 is not set); the ledger takes no writes from doubled facts. Unset WF_DOUBLES.');
  if (!Object.hasOwn(EVENTS, type)) throw new WfError(`unknown ledger event \`${type}\`; the schema 2 events are: ${Object.keys(EVENTS).join(', ')}`);
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new WfError(`${type}: data must be an object`);
  const missing = EVENTS[type].required.filter((k) => data[k] === undefined);
  if (missing.length) throw new WfError(`${type}: missing required field(s) ${missing.join(', ')}`);
  const file = ledgerFile(root, attempt);
  mkdirStateDirectory(path.dirname(file), { recursive: true });
  return withFileLock(`${file}.lock`, () => {
    const entries = fs.existsSync(file) ? readFile(root, attempt) : [];
    if (!entries.length && type !== 'attempt.started') throw new WfError(`${attempt} has no ledger yet: its first event must be attempt.started, not ${type}`);
    if (entries.length && type === 'attempt.started') throw new WfError(`${attempt} already started (its ledger has ${entries.length} entries)`);
    // Nothing follows the close (L3): an event after it would change a row, a digest or a delivery of a ticket that ended.
    const closed = entries.find((e) => e.type === 'attempt.closed');
    if (unless?.(entries)) return null;
    if (closed) throw new WfError(`${attempt} is already closed (${closed.data?.outcome ?? 'closed'} at ${closed.at}); its ledger takes no ${type} after attempt.closed`, { hint: 'a closed attempt stays closed: `wf start` opens the next attempt of the item' });
    const last = entries.at(-1) ?? null;
    const entry = { seq: (last?.seq ?? 0) + 1, at: nowIso(), type, actor: actor ?? null, data: JSON.parse(JSON.stringify(data)), prev: last?.hash ?? null, schema: SCHEMA };
    entry.hash = entryHash(entry);
    fs.appendFileSync(file, `${JSON.stringify(entry)}\n`);
    verified.delete(file);
    return structuredClone(entry);
  });
}

// `<item>.<n>` → { item, n }; an id without a number (a 0.7 batch) is its own item with n 0.
export function splitId(id) {
  const m = /^(.*)\.(\d+)$/.exec(id);
  return m ? { item: m[1], n: Number(m[2]) } : { item: id, n: 0 };
}

/** Attempt ids in the project (schema 1 and 2), optionally of one item, in attempt-number order. The project ledger of
 * stream 4's project-level decisions (PROJECT_LEDGER) is not an attempt and is never listed. A schema-1 ledger belongs
 * to an item by its folder name or by the item its `admitted` entry recorded (0.7 could name an attempt by `--id`). */
export async function listAttempts(root, { item } = {}) {
  let names = [];
  try {
    names = fs.readdirSync(path.join(root, '.wf-evidence', 'attempts'));
  } catch {
    return [];
  }
  const keyed = names.filter((d) => d !== PROJECT_LEDGER && SAFE_ID.test(d) && fs.existsSync(ledgerFile(root, d))).map((id) => ({ id, ...splitId(id) }));
  const chosen = keyed.filter((x) => item === undefined || x.item === item || admittedItem(root, x.id) === item);
  chosen.sort((a, b) => (a.item < b.item ? -1 : a.item > b.item ? 1 : a.n - b.n));
  return chosen.map((x) => x.id);
}

// The item a schema-1 ledger's first entry (`admitted`) recorded, or null (a schema 2 ledger, or none recorded). Only the
// first line is read; the chain is checked when the ledger itself is read.
function admittedItem(root, id) {
  try {
    const fd = fs.openSync(ledgerFile(root, id), 'r');
    let first;
    try {
      const buf = Buffer.alloc(64 * 1024);
      const n = fs.readSync(fd, buf, 0, buf.length, 0);
      first = buf.subarray(0, n).toString('utf8').split('\n')[0];
    } finally {
      fs.closeSync(fd);
    }
    const e = JSON.parse(first);
    return e.schema === undefined && e.type === 'admitted' && typeof e.data?.item === 'string' ? e.data.item : null;
  } catch {
    return null;
  }
}

// 0.7's terminal events. The first one ends the attempt; anything after it is not part of the ticket.
export const TERMINAL_07 = new Set(['closed', 'abandoned', 'analysis.closed', 'shipped.closed']);
export const DELIVERED_07 = new Set(['delivered', 'batch.member.delivered', 'shipped.closed']);

export const isSchema1 = (entries) => entries.length > 0 && entries[0].schema === undefined;

// A schema 1 ledger folds to what 0.8 needs of it: open or not, how it ended, its item, and its hold.
function fold1(id, entries) {
  const admitted = entries.find((e) => e.type === 'admitted');
  const s = { id, item: admitted?.data?.item ?? splitId(id).item, n: splitId(id).n, schema: 1, open: true, outcome: null, hold: null, closedAt: null };
  let delivered = false;
  for (const e of entries) {
    if (!s.open) break;
    if (DELIVERED_07.has(e.type)) delivered = true;
    if (e.type === 'hold') s.hold = { reason: e.data?.reason ?? '', quote: e.data?.quote ?? e.data?.reason ?? '', at: e.at };
    if (e.type === 'release') s.hold = null;
    if (e.type === 'attempt.closed') {
      s.open = false;
      s.outcome = e.data.outcome;
      s.closedAt = e.at;
    } else if (TERMINAL_07.has(e.type)) {
      s.open = false;
      s.outcome = e.type === 'abandoned' ? 'abandoned' : delivered ? 'shipped' : null;
      s.closedAt = e.at;
      if (e.type === 'shipped.closed') s.hold = null;
    }
  }
  return s;
}

const findingId = (f) => (typeof f === 'string' ? f : f?.id ?? null);

// A schema 2 ledger folds into AttemptState (engine/contract.mjs), plus a few fields telemetry reads (startedAt,
// closedAt, holds, stageEvents, filings).
function fold2(id, entries) {
  const s = {
    id, item: splitId(id).item, n: splitId(id).n, schema: 2, open: true, outcome: null, owner: null, engine: null, adapter: null,
    startedAt: entries[0]?.at ?? null, closedAt: null, closeReason: null, closedRow: null, patchIds: null, outsideStages: null,
    repos: {}, stages: [], criteria: { list: [], areas: [], hash: null, history: [] },
    tests: [], screens: [], handoffs: [], reviews: [], findings: {}, decisions: {}, hold: null, holds: [],
    stageResults: {}, stageEvents: [], landings: [], baseUpdates: [], filings: [],
  };
  const setFinding = (fid, status, review, at) => {
    const f = (s.findings[fid] ??= { id: fid, status, review, history: [] });
    f.status = status;
    f.history.push({ at, status, review });
  };
  for (const e of entries) {
    const d = e.data ?? {};
    switch (e.type) {
      case 'attempt.started':
        Object.assign(s, { item: d.item, n: d.n, repos: d.repos ?? {}, stages: d.stages ?? [], owner: e.actor ?? null, engine: d.engine ?? null, adapter: d.adapter ?? null, startedAt: e.at });
        break;
      case 'criteria.set':
        s.criteria.list = d.criteria;
        s.criteria.areas = d.areas;
        s.criteria.hash = d.hash;
        s.criteria.history.push({ at: e.at, hash: d.hash, previous: d.previous, loosened: d.loosened ?? [], diff: d.diff ?? null, criteria: d.criteria });
        break;
      case 'test.run':
        s.tests.push({ ...d, at: e.at });
        break;
      case 'screens.captured':
        s.screens.push({ ...d, at: e.at });
        break;
      case 'handoff':
        s.handoffs.push({ ...d, at: e.at });
        break;
      case 'review.recorded': {
        s.reviews.push({ ...d, at: e.at });
        for (const f of d.findings ?? []) {
          const fid = findingId(f);
          if (!fid) continue;
          const prior = s.findings[fid];
          s.findings[fid] = { ...(prior ?? {}), ...f, id: fid, status: prior?.status ?? 'open', review: d.review, history: prior?.history ?? [{ at: e.at, status: 'open', review: d.review }] };
        }
        for (const v of d.verified ?? []) {
          const prior = s.findings[v.id];
          const status = v.status === 'fixed' ? 'fixed' : prior?.status === 'fixed' || prior?.status === 'reopened' ? 'reopened' : 'open';
          setFinding(v.id, status, d.review, e.at);
        }
        break;
      }
      case 'finding.filed': {
        // The last event of a finding wins: a pending follow-up is replaced by the one that says done.
        const fid = findingId(d.finding);
        s.filings = [...s.filings.filter((x) => !fid || x.finding !== fid), { ...d, finding: fid, at: e.at }];
        if (fid && d.state === 'done') setFinding(fid, 'filed', s.findings[fid]?.review ?? null, e.at);
        break;
      }
      case 'decision.asked':
        s.decisions[d.id] = { kind: d.kind, question: d.question, options: d.options, refs: d.refs, blocking: d.blocking, id: d.id, askedAt: e.at, answer: null };
        break;
      case 'decision.answered':
        (s.decisions[d.id] ??= { id: d.id, askedAt: null, answer: null }).answer = { id: d.id, choice: d.choice, quote: d.quote, via: d.via, session: d.session, at: e.at };
        break;
      case 'hold':
        s.hold = { reason: d.reason, quote: d.quote, at: e.at };
        s.holds.push({ ...s.hold, releasedAt: null, decision: null });
        break;
      case 'release': {
        s.hold = null;
        const h = s.holds.findLast((x) => !x.releasedAt);
        if (h) Object.assign(h, { releasedAt: e.at, decision: d.decision });
        break;
      }
      case 'base.updated':
        s.baseUpdates.push({ ...d, at: e.at });
        break;
      case 'stage':
        s.stageResults[d.index] = { state: d.state, evidence: d.evidence ?? null, next: d.next ?? null, ...(d.waitedMin !== undefined ? { waitedMin: d.waitedMin } : {}), at: e.at };
        s.stageEvents.push({ ...d, at: e.at });
        break;
      case 'landing':
        s.landings.push({ ...d, at: e.at });
        break;
      case 'attempt.closed':
        Object.assign(s, { open: false, outcome: d.outcome, closeReason: d.reason, closedAt: e.at, closedRow: d.row ?? null, patchIds: d.patchIds ?? null, outsideStages: d.outsideStages === true });
        break;
      default:
        break;
    }
  }
  return s;
}

export const foldEntries = (id, entries) => (isSchema1(entries) ? fold1(id, entries) : fold2(id, entries));

/** The folded state of one attempt. */
export async function attemptState(root, attempt) {
  return foldEntries(attempt, readFile(root, attempt));
}

export const implements08 = { append, readEvents, attemptState, listAttempts };
