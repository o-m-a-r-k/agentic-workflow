// 0.7 (schema 1) ledgers on the 0.8 telemetry row (design-0.8 section 7), so 0.7 and 0.8 compare on the same fields.
//
//   - The end of an attempt is its first terminal event (closed, abandoned, analysis.closed, shipped.closed, or the
//     schema 2 attempt.closed migration appends); anything after it is not part of the ticket.
//   - A batch is not a ticket. Its gate, its wait and its delivery count in every member's row (`legacy.deliveredVia`).
//   - The project name is the one telemetry already uses (the adapter's, else the root folder's); rows stay in the user
//     folder and never reach a repository.
// Fields 0.7 did not record (finding classes, refusals per attempt, screens, the risk tier, the diff by kind, rework)
// are null, never zero.
import { WfError } from './contract.mjs';
import { DELIVERED_07, TERMINAL_07, isSchema1, listAttempts, readEvents, splitId } from './ledger.mjs';
import { activityOf, asSession, emptyRow, minutes, projectName, sessionsActivity, total, union } from './telemetry.mjs';

const t = (iso) => (iso ? Date.parse(iso) : NaN);
const SETTLED = new Set(['fixed', 'verified-nonissue', 'moved', 'waived', 'notADefect', 'not-a-defect']);

const isTerminal = (e) => TERMINAL_07.has(e.type) || e.type === 'attempt.closed';
const isBatch = (entries) => entries[0]?.data?.lane === 'batch' || entries.some((e) => e.type === 'batch.members');

// The entries up to and including the first terminal event.
export function untilTerminal(entries) {
  const i = entries.findIndex(isTerminal);
  return i < 0 ? entries : entries.slice(0, i + 1);
}

function outcomeOf(cut) {
  const last = cut.at(-1);
  if (!last || !isTerminal(last)) return null;
  if (last.type === 'attempt.closed') return last.data?.outcome ?? null;
  if (last.type === 'abandoned') return 'abandoned';
  return cut.some((e) => DELIVERED_07.has(e.type)) ? 'shipped' : null;
}

// Spans between an opening event and its closing one, matched by a key (or in order when the key is absent).
function spans(cut, opens, closes, keyOf, end) {
  const open = [];
  const out = [];
  for (const e of cut) {
    if (opens.includes(e.type)) open.push({ key: keyOf(e), from: t(e.at) });
    else if (closes.includes(e.type)) {
      const k = keyOf(e);
      const i = k == null ? 0 : open.findIndex((o) => o.key === k);
      if (i >= 0 && open[i]) out.push([open.splice(i, 1)[0].from, t(e.at)]);
    }
  }
  for (const o of open) out.push([o.from, end]);
  return out;
}

const gateSpans = (cut, end) => spans(cut, ['gate.started'], ['gate.finished', 'gate.stopped'], (e) => e.data?.runId ?? null, end);

async function readBatch(root, id, cache) {
  if (cache.has(id)) return cache.get(id);
  let cut = null;
  try {
    cut = untilTerminal(await readEvents(root, id));
  } catch {
    cut = null;
  }
  cache.set(id, cut);
  return cut;
}

async function rowOf(root, attempt, entries, project, batchCache) {
  if (isBatch(entries)) throw new WfError(`${attempt} is a 0.7 batch, not a ticket: its gate and delivery count in its members' rows`);
  const cut = untilTerminal(entries);
  const admitted = cut.find((e) => e.type === 'admitted');
  const start = t(admitted?.at ?? cut[0].at);
  const end = t(cut.at(-1).at);
  const r = emptyRow();
  Object.assign(r, {
    project, item: admitted?.data?.item ?? splitId(attempt).item, attempt, engine: admitted?.data?.engineVersion ?? null,
    outcome: outcomeOf(cut), start: new Date(start).toISOString(), end: new Date(end).toISOString(), wallMin: minutes(end - start),
  });

  // The batches this attempt joined, read up to their own end.
  const joined = [...new Set(cut.filter((e) => e.type === 'batch.joined').map((e) => e.data?.batch).filter(Boolean))];
  const deliveredVia = cut.find((e) => e.type === 'batch.member.delivered')?.data?.batch ?? null;
  const batches = [];
  for (const b of joined) {
    const bc = await readBatch(root, b, batchCache);
    if (bc) batches.push({ id: b, cut: bc, end: t(bc.at(-1).at) });
  }

  // Waits.
  const decisionSpans = spans(cut, ['decision.created'], ['decision.approved', 'decision.withdrawn'], (e) => e.data?.id ?? e.data?.decision ?? null, end);
  const holdSpans = spans(cut, ['hold'], ['release', 'shipped.closed'], () => null, end);
  const landWait = spans(cut, ['batch.joined'], ['batch.member.delivered', 'batch.ejected'], (e) => e.data?.batch ?? null, end);
  const deployWait = spans(cut, ['deployment.owed'], ['deployment.closed'], () => null, end);
  r.personWaitMin = minutes(total(union(decisionSpans, start, end)));
  r.holdMin = minutes(total(union(holdSpans, start, end)));
  r.stageWaitMin = {};
  if (landWait.length) r.stageWaitMin.land = minutes(total(union(landWait, start, end)));
  if (deployWait.length) r.stageWaitMin['confirm-deployed'] = minutes(total(union(deployWait, start, end)));

  // Tests: the attempt's own gates (light when it deferred the heavy steps), and each batch gate as a full run.
  const ownGates = gateSpans(cut, end);
  const batchGates = batches.flatMap((b) => gateSpans(b.cut, b.end));
  const light = admitted?.data?.deferHeavy === true;
  r.testRuns = { fast: light ? ownGates.length : 0, full: (light ? 0 : ownGates.length) + batchGates.length };
  r.testMin = minutes(total(ownGates) + total(batchGates));
  r.landing = { batches: joined.length, bisects: batches.reduce((s, b) => s + b.cut.filter((e) => e.type === 'batch.ejected').length, 0) };

  // Activity: ledger events, transcript turns, and what explains idle time.
  const handoffs = cut.filter((e) => e.type === 'handoff');
  const sessions = [admitted?.actor, ...cut.map((e) => e.actor), ...handoffs.map((h) => (h.data?.session ? { runtime: h.data.runtime, id: h.data.session } : null))].map(asSession).filter(Boolean);
  const act = await sessionsActivity(sessions);
  const points = [...cut.map((e) => t(e.at)), ...act.turns];
  Object.assign(r, activityOf(points, [...decisionSpans, ...holdSpans, ...landWait, ...deployWait, ...ownGates, ...batchGates], start, end));
  r.tokens = act.tokens;
  r.cost = act.cost;

  // Reviews.
  const reviews = cut.filter((e) => e.type === 'review.recorded');
  const blocking = (e) => {
    const c = e.data?.closure ?? {};
    const open = (c.findings ?? []).filter((f) => !SETTLED.has(f?.status));
    return c.verdict ? c.verdict !== 'approve' : open.length > 0;
  };
  r.reviews = reviews.length;
  r.blockingReviews = reviews.filter(blocking).length;
  r.emptyReviews = reviews.filter((e) => !(e.data?.closure?.findings ?? []).length).length;
  const firstReview = reviews[0] ? t(reviews[0].at) : null;
  r.fixRounds = firstReview === null ? 0 : handoffs.filter((h) => h.data?.role === 'implementer' && t(h.at) > firstReview).length;
  r.legacy = { deliveredVia, batches: joined, lane: admitted?.data?.lane ?? null, terminal: cut.at(-1).type };
  return r;
}

/** The row of one 0.7 attempt (a batch member includes its batch's gate, wait and delivery). */
export async function legacyRow(root, attempt) {
  const entries = await readEvents(root, attempt);
  if (!isSchema1(entries)) throw new WfError(`${attempt} is not a 0.7 ledger`);
  return rowOf(root, attempt, entries, (await projectName(root)).name, new Map());
}

/** Every 0.7 attempt of the project (or `ids`): rows of the closed tickets, batches rolled into their members, and the
 * open and held attempts. */
export async function legacyRollup(root, ids = null) {
  const { name } = await projectName(root);
  const out = { project: name, tickets: [], rows: [], open: [], held: [], batches: [], terminal: {}, deliveredVia: {}, problems: [] };
  const cache = new Map();
  for (const id of ids ?? (await listAttempts(root))) {
    let entries;
    try {
      entries = await readEvents(root, id);
    } catch (error) {
      out.problems.push({ attempt: id, problem: error.message });
      continue;
    }
    if (!isSchema1(entries)) continue;
    const cut = untilTerminal(entries);
    const ended = isTerminal(cut.at(-1));
    if (ended) out.terminal[id] = cut.at(-1).at;
    if (isBatch(entries)) {
      out.batches.push(id);
      continue;
    }
    if (!ended) {
      out.open.push(id);
      const holds = cut.filter((e) => e.type === 'hold').length;
      const releases = cut.filter((e) => e.type === 'release').length;
      if (holds > releases) out.held.push(id);
      continue;
    }
    const r = await rowOf(root, id, entries, name, cache);
    out.rows.push(r);
    if (r.legacy.deliveredVia) out.deliveredVia[id] = r.legacy.deliveredVia;
  }
  out.tickets = [...new Set(out.rows.map((r) => r.item))].sort();
  return out;
}
