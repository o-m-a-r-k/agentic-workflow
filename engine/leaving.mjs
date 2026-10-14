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
import { refuse } from './util.mjs';

export const RULE = 'medium and high are fixed in this delivery, here or in a sibling attempt of the batch, never deferred or ticketed; a low one leaves only with the person\'s yes, every low one in one question (`wf scope defer --finding <ref>[,<D-id>...]` as a known issue, or `wf scope ticket` with a follow-up ticket; discovered issues included); a fix that needs a product decision is a question for the person, not a deferral';

// items: [{ ref, level: 'high'|'medium'|'low', blocks, severity, summary, ratedFrom, raisedAt }]. Returns the decision id
// that lets them leave, or throws: a refusal naming what must stay, or the person's question for the low ones.
export function leavingDecision(root, state, items, { verb, reason = '', options = {} }) {
  const blocking = items.filter((x) => x.blocks);
  if (blocking.length) throw refuse(`${blocking.map((x) => x.ref).join(', ')} ${blocking.length > 1 ? 'block' : 'blocks'} this delivery: it is fixed here; a finding the person judges wrong is waived by them (\`wf scope waive\`)`, null, { id: 'leave:blocks' });
  const raised = items.map((x) => x.raisedAt).filter(Boolean).sort().at(-1) ?? null;
  const core = deliverCoreDecision(state, raised);
  if (core) return core.id;
  const kept = items.filter((x) => x.level !== 'low');
  if (kept.length) throw refuse(`not ${verb}: ${kept.map((x) => `${x.ref} (${x.level}${x.severity && x.severity !== x.level ? `, rated ${x.severity}` : ''})`).join(', ')} ${kept.length > 1 ? 'stay' : 'stays'} in this delivery: ${RULE}`, 'fix it through the implementer that did that work, or move it to a sibling attempt of the batch (`wf scope move`)', { id: 'leave:medium-high' });
  const line = (x) => `${x.ref} (${x.severity ?? 'low'}${x.ratedFrom ? `, rated down from ${x.ratedFrom}` : ''}): ${x.summary ?? ''}`;
  return requireYes(root, state, {
    kind: 'move-out-of-batch',
    key: `${verb}:${items.map((x) => x.ref).sort().join(',')}`,
    summary: `let ${items.length} low item(s) leave this delivery (${verb}): ${items.map(line).join('; ')}${reason ? ` (${reason})` : ''}`,
    what: `letting ${items.map((x) => x.ref).join(', ')} leave`,
    options,
  }).decision;
}
