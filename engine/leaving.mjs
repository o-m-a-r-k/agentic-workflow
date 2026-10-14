// What may leave a delivery (D17, the person's rule of 2026-10-14). A review finding or discovered issue that is high or
// medium (unrated, citing a frozen criterion or breaking a critical invariant counts as high) is fixed in this delivery
// batch, here or in a sibling attempt, and is never deferred or ticketed. A low one leaves only by the person's decision,
// one decision for every item named together, so the person answers once per delivery. The person's `deliver-core` answer
// to the round escalation stays the one exception: they decided there that what does not block may leave.
//
// Named failure (field, 0.7.6): under D10 a medium issue was the owner agent's call and a low one left freely, so an owner
// deferred 14 of 15 findings, among them a behaviour the person had asked for (called "a product decision") and two
// money and customer-data defects its reviewer had rated low.
import { deliverCoreDecision, requireYes } from './approve.mjs';
import { observations, placementLevel, severityLevel } from './review-policy.mjs';
import { refuse } from './util.mjs';

export const RULE = 'medium and high are fixed in this delivery, here or in a sibling attempt of the batch, never deferred or ticketed; a low one leaves only with the person\'s yes, every low one in one question (`wf scope defer --finding <ref>[,<D-id>...]` as a known issue, or `wf scope ticket` with a follow-up ticket; discovered issues included); a fix that needs a product decision is a question for the person, not a deferral';

// The same rule in a line, for routine output (next steps, a recorded issue); refusals print RULE in full.
export const RULE_SHORT = 'medium and high are fixed in this delivery; a low one leaves only with the person\'s yes (`wf scope defer` or `wf scope ticket`, every low item in one question)';

// items: [{ ref, level: 'high'|'medium'|'low', blocks, severity, summary, raisedAt, ratedBy, ratings, where }]. Returns the
// decision id that lets them leave, or throws: a refusal naming what must stay, or the person's question for the low ones.
// The question shows, per item, who rated it, every re-rating with its reason, and where it is, so the person's yes is
// informed (independent review of 0.7.7: it showed only "rated down from").
export function leavingDecision(root, state, items, { verb, reason = '', options = {} }) {
  const blocking = items.filter((x) => x.blocks);
  if (blocking.length) throw refuse(`${blocking.map((x) => x.ref).join(', ')} ${blocking.length > 1 ? 'block' : 'blocks'} this delivery: it is fixed here; a finding the person judges wrong is waived by them (\`wf scope waive\`)`, null, { id: 'leave:blocks' });
  const raised = items.map((x) => x.raisedAt).filter(Boolean).sort().at(-1) ?? null;
  const core = deliverCoreDecision(state, raised);
  if (core) return core.id;
  const kept = items.filter((x) => x.level !== 'low');
  if (kept.length) throw refuse(`not ${verb}: ${kept.map((x) => `${x.ref} (${x.level}${x.severity && x.severity !== x.level ? `, rated ${x.severity}` : ''})`).join(', ')} ${kept.length > 1 ? 'stay' : 'stays'} in this delivery: ${RULE}`, 'fix it through the implementer that did that work, or move it to a sibling attempt of the batch (`wf scope move`)', { id: 'leave:medium-high' });
  const line = (x) => `${x.ref} (${x.severity ?? 'low'}, rated by ${x.ratedBy ?? 'its reporter'}${x.ratings?.length ? `; re-rated ${x.ratings.map((r) => `${r.from ?? 'unrated'} to ${r.to} by ${r.by}${r.reason ? ` because ${r.reason}` : ''}`).join(', ')}` : ''}${x.where ? `; at ${x.where}` : ''}): ${x.summary ?? ''}`;
  // Every other open low item is named, so the owner puts them in this same question rather than a second one (the
  // promise is one question for the items named together; independent review of 0.7.7).
  const named = new Set(items.map((x) => x.ref));
  const others = otherOpenLow(state).filter((ref) => !named.has(ref));
  return requireYes(root, state, {
    kind: 'move-out-of-batch',
    key: `${verb}:${items.map((x) => x.ref).sort().join(',')}`,
    summary: `let ${items.length} low item(s) leave this delivery (${verb}): ${items.map(line).join('; ')}${reason ? ` (${reason})` : ''}${others.length ? `; other open low items not in this question: ${others.join(', ')}` : ''}`,
    what: `letting ${items.map((x) => x.ref).join(', ')} leave`,
    options,
  }).decision;
}

// Whether an attempt holds work another attempt of its batch moved to it (`wf scope move`, a split): a discovered issue
// or a live criterion with `movedFrom`. Ejecting or abandoning it would drop that work from the delivery, so it is the
// person's decision (independent review of 0.7.7: move, then eject, then abandon let a medium finding leave unasked).
export const carriesMovedWork = (state) => movedHeld(state).length > 0;
// The moved items an attempt holds, for the person's question: every moved discovered issue except one the person let leave
// (a fix in a branch that leaves the batch is not delivered: independent review of 0.7.7), and every moved criterion.
export const movedHeld = (state) => [
  ...(state.discovered ?? []).filter((d) => d.movedFrom && d.status !== 'deferred').map((d) => `${d.id} (${d.status}, from ${d.movedFrom.attempt} ${d.movedFrom.ref})`),
  ...(state.criteria ?? []).filter((c) => c.movedFrom).map((c) => `${c.id} (from ${c.movedFrom.attempt} ${c.movedFrom.ref})`),
];

// The rating facts of a discovered issue for the person's question: its reporter and every re-rating.
export const discoveredRating = (d) => ({ ratedBy: d.foundBy ? `${/^left by /.test(d.summary ?? '') ? 'its implementer ' : ''}${d.foundBy}` : d.by ?? null, ratings: (d.rated ?? []).map((r) => ({ from: r.from, to: r.to, by: r.by, reason: r.reason })), where: d.where ?? null });

// Open low review observations and discovered issues of the attempt, by ref.
export const otherOpenLow = (state) => [
  ...observations(state).filter((f) => placementLevel(state, f) === 'low').map((f) => f.ref),
  ...(state.discovered ?? []).filter((d) => d.status === 'open' && d.kind !== 'bookkeeping' && !(typeof d.invariant === 'string' && d.invariant.trim()) && severityLevel(d.severity) === 'low').map((d) => d.id),
];
