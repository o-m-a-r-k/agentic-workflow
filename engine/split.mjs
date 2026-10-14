// `wf split`: move obligations of a running attempt into sibling attempts of the same delivery batch (0.7.0, D1).
//
// Named failure: a ticket that had outgrown itself could not be contracted. Agents proposed splitting it three times
// and the proposals were lost, because "split" was neither a command nor a record: the only choices were to keep
// growing the one attempt or to abandon it. Placement is not obligation (D1): a split changes where an obligation is
// worked, never whether it is owed. The parent and its siblings become members of one batch, so the parent cannot
// deliver without them (`wf deliver` on a member refuses; `wf batch create` assembles the batch once every member is
// accepted, and delivers them together).
//
// What a split moves is obligations, not code: a sibling starts from the current base, so only work that has no code
// yet moves (an unstarted work item, a criterion, an observation, a discovered issue). Findings that block stay with
// the attempt that caused them.
import { actor, entry, nextAttemptId } from './attempt.mjs';
import { roleClass, trustedAdapter } from './config.mjs';
import { append, listAttempts, loadState } from './ledger.mjs';
import { blockingOpen, classifyFinding } from './review-policy.mjs';
import { refuse } from './util.mjs';

const text = (v) => (typeof v === 'string' ? v.trim() : '');

// Every open finding of the recorded rounds, as `reviewer:id`, with whether the review policy says it blocks.
function openFindings(state) {
  const last = new Map();
  for (const r of state.reviews ?? []) last.set(r.handoff ?? `reviewer:${r.reviewer}`, r);
  const out = [];
  for (const r of last.values()) {
    const view = { ...state, review: { closure: r.closure } };
    const blocking = new Set(blockingOpen(view).map((f) => f.id));
    for (const f of r.closure?.findings ?? []) {
      if (['fixed', 'verified-nonissue', 'moved'].includes(f.status)) continue;
      out.push({ ref: `${r.reviewer}:${f.id}`, id: f.id, finding: f, blocking: blocking.has(f.id), onAttemptLines: Boolean(classifyFinding(state, f).onAttemptLines) });
    }
  }
  return out;
}

// The items a split names, resolved against the attempt and checked. Returns what moves and what the sibling carries;
// refuses (id `split:*`) when an item cannot move, naming why.
export function resolveSplitItems(root, state, items) {
  if (state.intent !== 'implementation') throw refuse(`${state.id} is an ${state.intent} attempt; only an implementation attempt splits`, null, { id: 'split:not-implementation' });
  if (!state.criteria) throw refuse(`${state.id} has no frozen criteria yet; there is nothing to split`, null, { id: 'split:no-plan' });
  if (state.accepted || ['handoff-pending', 'done', 'abandoned'].includes(state.phase)) throw refuse(`${state.id} is ${state.accepted ? 'accepted' : state.phase}; a split is for an attempt still being worked`, null, { id: 'split:closed' });
  if (state.activeHold) throw refuse(`${state.id} is on hold: "${state.activeHold.reason}"`, null, { id: 'split:hold' });
  if (state.batchOf && !state.batchPending) throw refuse(`${state.id} is a member of ${state.batchOf}, which is assembled; eject it first (\`wf batch eject\`)`, null, { id: 'split:in-batch' });
  const wanted = [...new Set((Array.isArray(items) ? items : String(items ?? '').split(',')).map((x) => String(x).trim()).filter(Boolean))];
  if (!wanted.length) throw refuse('--items names what moves: work item ids, criterion ids, observation ids (`reviewer:F1`) or discovered ids', null, { id: 'split:no-items' });
  const findings = openFindings(state);
  const work = [];
  const criteria = [];
  const found = [];
  const discovered = [];
  const problems = [];
  for (const t of wanted) {
    const w = (state.work ?? []).find((x) => x.id === t);
    if (w) {
      work.push(w.id);
      continue;
    }
    if ((state.criteria ?? []).some((c) => c.id === t)) {
      criteria.push(t);
      continue;
    }
    const d = (state.discovered ?? []).find((x) => x.id === t);
    if (d) {
      if (d.status !== 'open') problems.push(`${t} is ${d.status}, not open`);
      else discovered.push(t);
      continue;
    }
    const matches = findings.filter((f) => f.ref === t || (!t.includes(':') && f.id === t));
    if (matches.length === 1) {
      // The fix lives where the code is: a finding on a line this attempt changed is fixed here (a sibling starts from the
      // base and has no such line); one on code the attempt did not change may move (refusal audit of 0.7.0).
      if (matches[0].onAttemptLines) problems.push(`${matches[0].ref} is on a line this attempt changed: its fix lives in this attempt's branch (a sibling starts from the base); fix it here, or ticket it by the severity rule (\`wf scope ticket\`)`);
      else found.push(matches[0].ref);
    } else if (matches.length > 1) problems.push(`${t} names ${matches.length} findings (${matches.map((m) => m.ref).join(', ')}); name one as reviewer:id`);
    else problems.push(`${t} is not a work item, criterion, open finding or open discovered issue of ${state.id}`);
  }
  // A work item moves with the criteria it builds; a criterion that a work item covers moves only with that item.
  const started = (state.work ?? []).filter((w) => work.includes(w.id) && state.handoffs.some((h) => h.role === 'implementer' && h.work === w.id));
  for (const w of started) problems.push(`work item ${w.id} already has an implementer (${state.handoffs.filter((h) => h.role === 'implementer' && h.work === w.id).map((h) => h.agent).join(', ')}): its code is in this attempt's branch, and a sibling starts from the base`);
  const staying = (state.work ?? []).filter((w) => !work.includes(w.id));
  for (const c of criteria) {
    const covering = (state.work ?? []).filter((w) => w.criteria.includes(c));
    if (covering.some((w) => !work.includes(w.id))) problems.push(`criterion ${c} is covered by work item ${covering.filter((w) => !work.includes(w.id)).map((w) => w.id).join(', ')}, which stays; move the work item with it`);
  }
  const copy = new Set([...criteria, ...(state.work ?? []).filter((w) => work.includes(w.id)).flatMap((w) => w.criteria)]);
  const remove = new Set([...copy].filter((c) => !staying.some((w) => w.criteria.includes(c))));
  if ((state.criteria ?? []).every((c) => remove.has(c.id))) problems.push('that would leave this attempt with no criteria; keep at least one, or abandon the attempt');
  if (problems.length) throw refuse(`not split: ${problems.join('; ')}`, null, { id: 'split:cannot-move' });
  return { work, criteria: [...remove], copyCriteria: [...copy], findings: found, discovered, items: wanted };
}

// A reserved batch id for the parent: the one it already waits for, or `BATCH-<parent id>` (made unique). The batch
// attempt itself is created by `wf batch create` when every member is accepted.
function batchFor(root, state) {
  if (state.batchOf) return state.batchOf;
  const taken = new Set(listAttempts(root));
  let id = `BATCH-${state.id}`;
  for (let k = 2; taken.has(id); k++) id = `BATCH-${state.id}-${k}`;
  return id;
}

// Performs the split (items already resolved by `resolveSplitItems`): creates the sibling attempt, freezes its criteria
// from what moved, joins parent and sibling to the pending batch, and records what moved on both sides.
export function performSplit(root, state, { resolved, reason, options = {} }) {
  const r = resolved ?? resolveSplitItems(root, state, options.items);
  const why = text(reason);
  if (!why) throw refuse('--reason says why the work is split', null, { id: 'split:no-reason' });
  const cfg = trustedAdapter(root, state);
  const splitId = `SPLIT-${state.splits.length + 1}`;
  const batch = batchFor(root, state);
  const movedWork = (state.work ?? []).filter((w) => r.work.includes(w.id));
  const criteria = (state.criteria ?? []).filter((c) => r.copyCriteria.includes(c.id)).map((c) => ({ ...c }));
  const taken = new Set(criteria.map((c) => c.id));
  const synthetic = [];
  const origin = (ref, summary, where) => {
    let n = synthetic.length + 1;
    while (taken.has(`O${n}`)) n += 1;
    taken.add(`O${n}`);
    synthetic.push({ id: `O${n}`, text: `Resolve ${ref}: ${summary}${where ? ` (${where})` : ''} — moved from ${state.id} by a split`, uat: false, movedFrom: { attempt: state.id, ref } });
  };
  for (const ref of r.findings) {
    const f = openFindings(state).find((x) => x.ref === ref).finding;
    origin(ref, text(f.summary) || ref, text(f.evidence).split('\n')[0]);
  }
  for (const id of r.discovered) {
    const d = state.discovered.find((x) => x.id === id);
    origin(`${state.id}:${id}`, text(d.summary) || id, d.where);
  }
  const allCriteria = [...criteria, ...synthetic];
  if (!allCriteria.length) throw refuse('not split: nothing to carry', null, { id: 'split:cannot-move' });
  // With work items in the plan, the observations need an item of their own, in the implementer class.
  const usedWork = new Set([...(state.work ?? []).map((w) => w.id), ...state.strategy.moved.work]);
  let k = 1;
  while (usedWork.has(`W${k}`)) k += 1;
  const work = state.work ? [...movedWork.map((w) => ({ ...w })), ...(synthetic.length ? [{ id: `W${k}`, criteria: synthetic.map((c) => c.id), repos: [], class: roleClass(cfg, 'implementer'), why: `moved from ${state.id} by a split` }] : [])] : null;
  const repos = movedWork.length && movedWork.every((w) => w.repos?.length) ? [...new Set(movedWork.flatMap((w) => w.repos))] : Object.keys(state.repos);
  // The sibling starts from the current base on its own branch; the same item, so a sibling's id reads `<item>.<n>`.
  const sibling = entry(root, { item: state.item, lane: state.lane, intent: 'implementation', repos: repos.join(','), id: nextAttemptId(root, state.item), owner: state.owner, deferHeavy: true, sibling: true, ...(state.issue?.file ? { 'issue-file': state.issue.file } : {}) });
  const by = actor(options);
  append(root, sibling.id, 'split.created', { from: state.id, split: splitId, items: r.items, reason: why }, by);
  append(root, sibling.id, 'criteria.frozen', { criteria: allCriteria, plan: siblingPlan(state.plan), source: { split: state.id }, ...(work ? { work } : {}), ...(state.impact ? { impact: { survey: state.impact.survey, impact: state.impact.impact, results: state.impact.results ?? {}, addenda: state.impact.addenda ?? [] } } : {}) }, by);
  append(root, sibling.id, 'batch.joined', { batch, pending: true, split: splitId }, by);
  if (state.batchOf !== batch) append(root, state.id, 'batch.joined', { batch, pending: true, split: splitId }, by);
  append(root, state.id, 'split.performed', { id: splitId, reason: why, batch, siblings: [{ id: sibling.id, items: r.items, criteria: allCriteria.map((c) => c.id), work: work?.map((w) => w.id) ?? [] }], moved: { work: r.work, criteria: r.criteria, findings: r.findings, discovered: r.discovered } }, by);
  return { id: splitId, batch, siblings: [loadState(root, sibling.id)], moved: { work: r.work, criteria: r.criteria, findings: r.findings, discovered: r.discovered }, state: loadState(root, state.id) };
}

// The sibling inherits the plan without its expectation: the parent's prediction was for the whole change, so the sibling
// states none until its owner re-plans with one (an amendment with `expect`).
const siblingPlan = (plan) => (plan && typeof plan === 'object' && !Array.isArray(plan) ? Object.fromEntries(Object.entries(plan).filter(([k]) => k !== 'expect')) : plan);

// `wf split --attempt X --items a,b --reason "..."`.
export function splitCommand(root, state, options) {
  const resolved = resolveSplitItems(root, state, options.items);
  return performSplit(root, state, { resolved, reason: options.reason, options });
}
