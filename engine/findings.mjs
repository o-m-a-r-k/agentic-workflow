// The findings rule (design section 2, D92). Stream 1.
//
// Every finding is `goal` (the ticket's work, fixed in the ticket at any severity), `regression` (something this change
// broke, anywhere) or `other` (anything else). `goal` and `regression` block the merge at every severity. `other` is
// refused on a line this attempt's commits wrote (named failure: repairs created 41% of later defects), then searched for
// in the tracker and filed per `ticketing.followUps`; a high one, or one on a risk path, also goes to the person as a
// priority question in the digest. It never holds the ticket.
//
// Finding ids (`F<n>`) are unique per item across its attempts, and the status of each is folded from the item's
// reviews: a reviewer's `verified` marks a listed finding fixed or open; open after fixed is a reopen.
import { WfError, ask, blameToAttempt, fileFollowUp, marker, parseLocation, refusal } from './contract.mjs';
import { rootPath } from './base.mjs';
import { matchesAny } from './util.mjs';

export const CLASSES = ['goal', 'regression', 'other'];
export const SEVERITIES = ['low', 'medium', 'high', 'critical'];
export const blocking = (f) => f.class !== 'other' && (f.status === 'open' || f.status === 'reopened');

// The shape a reviewer writes. Throws WfError naming every problem.
export function checkFinding(f, repos, i) {
  const problems = [];
  const at = `finding ${i + 1}`;
  if (!f || typeof f !== 'object') return [`${at} is not an object`];
  const loc = parseLocation(f.location);
  if (!loc) problems.push(`${at}: location \`${f.location}\` is not <repo>/<path>:<line>`);
  else if (!repos.includes(loc.repo)) problems.push(`${at}: repo \`${loc.repo}\` is not part of this attempt (${repos.join(', ')})`);
  if (!CLASSES.includes(f.class)) problems.push(`${at}: class \`${f.class}\` is not one of ${CLASSES.join(', ')}`);
  if (!SEVERITIES.includes(f.severity)) problems.push(`${at}: severity \`${f.severity}\` is not one of ${SEVERITIES.join(', ')}`);
  for (const k of ['what', 'why']) if (typeof f[k] !== 'string' || !f[k].trim()) problems.push(`${at}: \`${k}\` is empty`);
  return problems;
}

// `other` on a line this attempt wrote is refused (stream 5 blames the line against the merge-base).
export async function refuseOtherOwn(root, attempt, findings) {
  const own = [];
  for (const f of findings) {
    if (f.class !== 'other') continue;
    const b = await blameToAttempt(root, attempt, f.location);
    if (b?.own) own.push(`${f.location} (commit ${String(b.commit ?? '').slice(0, 10)})`);
  }
  if (own.length) {
    throw refusal('finding:other-own', `class \`other\` on line(s) this attempt wrote: ${own.join(', ')}`, 'a defect in a line this change wrote is this ticket\'s work: class it `goal` (or `regression`) and record the review again');
  }
}

// The item's findings and rounds, folded from its attempts' schema 2 events in order.
// history: [{ id, events }]. waived: Set of finding ids the person waived.
export function foldFindings(history, waived = new Set()) {
  const findings = {};
  const rounds = new Map();
  for (const a of history) {
    for (const e of a.events) {
      if (e.type === 'review.recorded') {
        const d = e.data;
        const r = rounds.get(d.round) ?? { round: d.round, tree: d.tree, attempt: a.id, reviews: [], reopened: [], blockers: 0, seats: [] };
        for (const f of d.findings) findings[f.id] = { ...f, status: 'open', attempt: a.id, review: d.review, round: d.round, history: [{ at: e.at, status: 'open', review: d.review }], changes: [] };
        for (const v of d.verified ?? []) {
          const f = findings[v.id];
          if (!f) continue;
          if (v.status === 'fixed' && f.status !== 'fixed') f.status = 'fixed';
          else if (v.status === 'open' && f.status === 'fixed') {
            f.status = 'reopened';
            r.reopened.push(v.id);
          }
          for (const k of ['severity', 'class']) {
            if (v[k] && v[k] !== f[k]) {
              f.changes.push({ field: k, from: f[k], to: v[k], round: d.round });
              f[k] = v[k];
            }
          }
          f.history.push({ at: e.at, status: f.status, review: d.review });
        }
        r.blockers = d.blockers;
        r.reviews.push(d.review);
        r.seats.push(d.seat);
        rounds.set(d.round, r);
      } else if (e.type === 'finding.filed') {
        const f = findings[e.data.finding];
        if (f && f.class === 'other' && e.data.state === 'done') f.status = 'filed';
      }
    }
  }
  for (const id of waived) if (findings[id] && blocking(findings[id])) findings[id].status = 'waived';
  return { findings, rounds: [...rounds.values()].sort((a, b) => a.round - b.round) };
}

export const blockersOf = (findings) => Object.values(findings).filter(blocking);
export const nextFindingNumber = (findings) => Math.max(0, ...Object.keys(findings).map((id) => Number(/^F(\d+)$/.exec(id)?.[1] ?? 0))) + 1;

export function riskPathsOf(adapter, rootFile) {
  return (adapter.risk?.paths ?? []).filter((r) => matchesAny(rootFile, r.paths ?? []));
}

const locationRoot = (adapter, location) => {
  const loc = parseLocation(location);
  const spec = adapter.repos.find((r) => r.name === loc?.repo);
  return loc ? rootPath(spec, loc.path) : '';
};

// File one `other` finding (stream 3 searches first and files per followUps), and ask the priority question when it is
// high or on a risk path. Returns the `finding.filed` payload.
// An attempt started with `--no-tracker` files nothing: its `other` findings stay in the ledger (mode off).
export async function fileOther(root, attempt, f, adapter, { noTracker = false } = {}) {
  const mode = noTracker ? 'off' : adapter.ticketing?.followUps?.mode ?? 'off';
  const high = ['high', 'critical'].includes(f.severity);
  const onRisk = riskPathsOf(adapter, locationRoot(adapter, f.location)).length > 0;
  const priority = high || onRisk;
  const res = noTracker ? { state: 'done', value: null } : await fileFollowUp(root, attempt, f);
  const data = {
    finding: f.id,
    mode,
    state: res?.state === 'pending' ? 'pending' : 'done',
    marker: res?.marker ?? marker(attempt, `finding:${f.id}`),
    ticket: res?.state === 'done' ? res.value?.id ?? null : null,
    duplicateOf: res?.state === 'done' ? res.value?.duplicateOf ?? null : null,
    priority,
  };
  if (priority) {
    await ask(root, attempt, {
      kind: 'priority-other',
      question: `A finding outside this ticket is ${[high ? f.severity : null, onRisk ? 'on a risk path' : null].filter(Boolean).join(' and ')}: ${f.location}: ${f.what}. ${data.ticket ? `Filed as ${data.ticket}.` : data.duplicateOf ? `Already tracked as ${data.duplicateOf}.` : 'Not filed as a ticket.'} Schedule it?`,
      options: ['schedule it', 'leave it'],
      refs: [f.id],
      blocking: false,
    });
  }
  return { data, pending: res?.state === 'pending' ? res.operation ?? null : null };
}

export function assertFindings(findings, repos) {
  const problems = (findings ?? []).flatMap((f, i) => checkFinding(f, repos, i));
  if (!Array.isArray(findings)) problems.unshift('`findings` must be a list');
  if (problems.length) throw new WfError(`the review cannot be recorded:\n  ${problems.join('\n  ')}`);
}
