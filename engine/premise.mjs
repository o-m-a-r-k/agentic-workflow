// Whether the premise behind a fix holds in production, as an implementer reported it and a reviewer or the person settled it
// (0.7.31, I-217, D64).
//
// Named failure (field): an evidence reviewer noted a low display anomaly (a due date shown with a clock time on one page and as a
// date on another). The research the owner ordered said no production caller sets the field; the owner turned that into "no wrong
// data exists", the implementer's brief repeated it, and the reviewer ran three "who sets it" searches, saw no writer and wrote
// nothing. Nobody asked what a field nothing writes is for. The low item became a reshape of four API DTOs and a new failure path,
// reverted after the person asked whether anyone had done a proper analysis. The same shape was in the ledgers five more times: a
// fix built on a finding's own framing whose premise nobody traced; the one implementer that checked the premise saved a fix.
//
// So an implementer that finds the thing a finding presumes is not there in production (never written, never reached, disabled,
// refused on the base) builds nothing for it and says so in its report (`premiseFailed: [{ ref, why, evidence }]`). This module
// reads those reports: an item whose premise was reported failed is not handed to another pass or fix round (`outstanding` in
// engine/course.mjs leaves it out), the next reviewer is handed it to judge the premise, and the owner is told the routes: a
// reviewer's `verified-nonissue` (with its evidence and rationale), the person's not-a-defect question (D38), or an analysis. A
// reviewer's `open` on it says the premise holds after all: it goes back to be fixed. Information and routing; nothing here
// refuses anything, and nothing leaves the delivery by it (an open item still keeps the delivery waiting).
import { dispositionOf, openAcrossRounds } from './review-policy.mjs';
import { openDiscovered } from './discovered.mjs';

const text = (v) => (typeof v === 'string' ? v.trim() : '');
const clip = (s, n) => {
  const t = text(s).replace(/\s+/g, ' ');
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};
const reviewerOf = (r) => r.closure?.reviewer ?? r.reviewer;
export const isDiscoveredRef = (ref) => /^D\d+$/.test(String(ref ?? ''));

// An item reference as a report may write it: a discovered issue (`D3`, any case) or a finding (`<reviewer>:<id>`).
export const premiseRef = (v) => {
  const t = text(String(v ?? ''));
  return /^d\d+$/i.test(t) ? t.toUpperCase() : t;
};

// Whether the item a premise names is open in this attempt: a discovered issue still open, or a finding still open and placed nowhere.
export function itemOpen(state, ref) {
  if (isDiscoveredRef(ref)) return openDiscovered(state).some((d) => d.id === ref);
  return openAcrossRounds(state).some((f) => f.ref === ref && !dispositionOf(state, ref));
}

// Every premise an implementer reported failed, the latest report per item: { ref, why, evidence, agent, handoff, at, contested }.
// Review of 0.7.31 (L6): `contested` names the reviewer that found the premise holds after an earlier report of the same item, when
// an implementer reports it fails again: two roles disagree on a fact, and another reviewer would only add a third opinion. The
// person decides it (D38's not-a-defect question, or their answer recorded with `wf decide`).
export function premiseReports(state) {
  const all = new Map();
  for (const r of state.implementerReports ?? []) for (const p of r.premiseFailed ?? []) if (p?.ref) all.set(p.ref, [...(all.get(p.ref) ?? []), { ...p, agent: r.agent, handoff: r.handoff, at: r.at }]);
  return [...all.values()].map((reports) => {
    const latest = reports.at(-1);
    const earlier = reports.slice(0, -1).map((x) => heldBy(state, x, latest.at)).filter(Boolean);
    return { ...latest, contested: earlier.at(-1) ?? null };
  });
}

// The reviewer whose round, recorded after the report (and before `until`, when given), found the premise holds (the item is a
// defect after all): `open` on a discovered issue, or a prior finding it found still open.
function heldBy(state, p, until = null) {
  for (const r of state.reviews ?? []) {
    if (!(String(r.at) > String(p.at)) || (until && !(String(r.at) < String(until)))) continue;
    const c = r.closure ?? {};
    const held = isDiscoveredRef(p.ref)
      ? (Array.isArray(c.discovered) ? c.discovered : []).some((v) => premiseRef(v?.id) === p.ref && v.verdict === 'open')
      : (Array.isArray(c.priorFindings) ? c.priorFindings : []).some((v) => `${v?.round}:${v?.id}` === p.ref && v.status === 'open');
    if (held) return reviewerOf(r);
  }
  return null;
}

// 0.7.32 (I-222, D71), named failure (found in an audit of 0.7.31): a contested premise was the person's to decide, and their
// answer changed nothing: `heldBy` read only reviewers, so an item the person said is a defect stayed out of every pass and fix
// round, and a finding had no "not a defect" closure at all. The person's answer settles it. That the premise holds is a product
// decision that names the item (`wf decide --item <ref> --premise holds`, D65) or their "no" to D38's question whether it is a
// defect at all (key `nonissue:<ref>`); the item goes back to the fix round with their words in the implementer's bundle. That it
// does not hold is their "yes" to that question, which closes the item as not a defect (`wf discovered close <id> --not-a-defect`, or
// `wf scope not-a-defect --finding <ref>` for a finding). An answer stands until the owner withdraws it with what changed.
export function personHeld(state, ref) {
  const decided = (state.productDecisions ?? []).filter((d) => !d.withdrawn && d.item === ref && d.premise === 'holds').at(-1);
  if (decided) return { decision: decided.id, words: decided.quote ?? null, at: decided.at, via: 'decide' };
  const asked = (state.decisions ?? []).filter((d) => d.kind === 'move-out-of-batch' && d.key === `nonissue:${ref}` && d.approved?.choice === 'no' && !d.withdrawn).at(-1);
  if (asked) return { decision: asked.id, words: asked.approved.words ?? asked.approved.quote ?? null, at: asked.approved.at, via: 'question' };
  return null;
}

// The items whose premise an implementer reported failed and the person said holds, still open: they go back to the fix round with
// the person's answer (`premiseHeld` in the implementer's bundle).
export const premisesHeldByPerson = (state) => premiseReports(state).filter((p) => itemOpen(state, p.ref)).flatMap((p) => {
  const held = personHeld(state, p.ref);
  return held ? [{ ref: p.ref, kind: isDiscoveredRef(p.ref) ? 'discovered' : 'finding', reportedBy: p.agent, why: p.why, reportedAt: p.at, ...held }] : [];
});

// The premises reported failed that nothing has settled yet: the item is still open, no reviewer found the premise holds since and
// the person has not answered. `seenBy`: the reviewers whose rounds were recorded after the report (they were handed it and gave no
// verdict on it).
export function premiseOpen(state) {
  return premiseReports(state)
    .filter((p) => itemOpen(state, p.ref) && !heldBy(state, p) && !personHeld(state, p.ref))
    .map((p) => ({ ...p, kind: isDiscoveredRef(p.ref) ? 'discovered' : 'finding', seenBy: [...new Set((state.reviews ?? []).filter((r) => String(r.at) > String(p.at)).map(reviewerOf))] }));
}

const forReviewer = (state, p) => {
  const d = p.kind === 'discovered' ? (state.discovered ?? []).find((x) => x.id === p.ref) : null;
  return { ref: p.ref, kind: p.kind, ...(d ? { summary: clip(d.summary, 300) } : {}), reportedBy: p.agent, why: p.why, evidence: p.evidence ?? [] };
};

// What a reviewer is handed of them. A full round is blind to earlier findings, so it is handed only discovered issues (which it
// is handed anyway); a delta round is handed findings too. A contested premise is the person's, never another reviewer's.
export function premisesForReview(state, mode) {
  return premiseOpen(state).filter((p) => !p.contested && (mode === 'delta' || p.kind === 'discovered')).map((p) => forReviewer(state, p));
}

// Review of 0.7.31 (L4): a full round is handed the findings' failed premises, with the implementer's evidence, once its blind
// closure is recorded, beside the earlier findings it then verifies (a finding a planned pass was handed had no other route to it).
export const premisesForReveal = (state) => premiseOpen(state).filter((p) => !p.contested && p.kind === 'finding').map((p) => forReviewer(state, p));

const one = (p) => `${p.ref} (${p.agent}: ${clip(p.why, 200)}${p.evidence?.length ? `; checked: ${p.evidence.slice(0, 3).map((e) => clip(e, 140)).join('; ')}` : ''})`;
// 0.7.32 (I-222, D71): both answers have a route that settles the item, for a finding as for a discovered issue.
const notDefectCommand = (p, attempt) => (p.kind === 'discovered' ? `wf discovered close ${p.ref} --not-a-defect --reason "<why>" --attempt ${attempt}` : `wf scope not-a-defect --finding ${p.ref} --reason "<why>" --attempt ${attempt}`);
const personRoute = (p, attempt) => `\`${notDefectCommand(p, attempt)}\` asks them whether it is a defect at all (their "yes" closes it as not a defect; their "no" sends it back to the fix round with their words); when they already answered in their own words, record that answer on the question it asks, and when they said it is a defect, \`wf decide --item ${p.ref} --premise holds\` (with the question, the options and their words) sends it back the same way`;
const routesFor = (p, attempt) => (p.kind === 'discovered'
  ? `a reviewer's verdict on ${p.ref} (\`verified-nonissue\` with its evidence and rationale closes it, \`open\` sends it back to be fixed), or the person's answer whether it is a defect at all (\`${notDefectCommand(p, attempt)}\`, one question)`
  : `a reviewer's verdict on ${p.ref} in \`priorFindings\` (\`verified-nonissue\` with its evidence and rationale settles it, \`open\` sends it back to be fixed), or the person's answer whether it is a defect at all (\`${notDefectCommand(p, attempt)}\`, one question)`);
const contestedText = (p, attempt) => `reviewer ${p.contested} found its premise holds and an implementer found it does not: the person decides, not another reviewer (${personRoute(p, attempt)})`;
const nextReviewer = (p) => `the next reviewer is handed it${p.kind === 'finding' ? ' (a full round once its blind closure is recorded)' : ''} and judges its premise`;

// The note `wf resume` puts before the next step while a premise reported failed is not settled, one item at a time.
export function premiseNote(state) {
  const open = premiseOpen(state);
  // An implementer that reports again, after the person's answer, that the premise does not hold: their answer stands until the owner
  // brings what changed back to them.
  const again = premisesHeldByPerson(state).filter((p) => String(p.reportedAt) > String(p.at));
  const againText = again.map((p) => `${p.ref}: the person decided its premise holds (${p.decision}) and ${p.reportedBy} reported after that it does not (${clip(p.why, 200)}): their answer stands, so it is fixed, unless you withdraw it with what changed (${p.via === 'decide' ? `\`wf decide withdraw ${p.decision} --reason "<what changed>" --attempt ${state.id}\`` : `\`wf decisions withdraw ${p.decision} --attempt ${state.id} --reason "<what changed>"\``}) and ask them again`).join('; ');
  if (!open.length) return again.length ? `premise reported failed after the person's answer: ${againText}` : null;
  const item = (p) => (p.contested ? `${one(p)}: ${contestedText(p, state.id)}; nothing is built for it and no pass or fix round is handed it meanwhile` : `${one(p)}: nothing was built for it and no pass or fix round is handed it again, and ${nextReviewer(p)}, or settle it with ${routesFor(p, state.id)}`);
  return `premise reported failed: ${open.map(item).join('; ')}; or trace it first in an analysis when the premise itself is the open question${again.length ? `; ${againText}` : ''}`;
}

// The step where the acceptance (or another fix round for the same findings) would be next while a premise reported failed is not
// settled: it is settled first, never assumed either way (a review recorded after the report passed it by, or none has seen it yet).
export function premiseStep(state, refs = null) {
  const open = premiseOpen(state).filter((p) => !refs || refs.includes(p.ref));
  if (!open.length) return null;
  const judged = open.filter((p) => !p.contested);
  const item = (p) => (p.contested ? `${one(p)}: ${contestedText(p, state.id)}` : `${one(p)} ${p.seenBy.length ? `was not settled by the review after it (${p.seenBy.join(', ')})` : 'has not been judged by a review yet'}`);
  return `${open.map(item).join('; ')}: the premise behind a fix is settled before anything more is built on it or the ticket is accepted, never assumed either way.${judged.length ? ` Settle ${judged.length < open.length ? judged.map((p) => p.ref).join(', ') : 'each'} with ${judged.map((p) => routesFor(p, state.id)).join('; ')}; a fresh reviewer (\`wf handoff reviewer --agent <new id> --attempt ${state.id}\`) is handed ${judged.length > 1 ? 'them' : 'it'} with the implementer's evidence; or trace it first in an analysis` : ''}`;
}

// What the close tells the owner about the premises an implementer reported failed.
export const premiseCloseNotes = (premises, attempt) => (premises ?? []).map((p) => (p.known && p.held
  ? `${p.agent} reports that the premise of ${p.ref} does not hold in production (${clip(p.why, 200)}), after the person decided it holds (${p.held.decision}${p.held.words ? `: "${clip(p.held.words, 200)}"` : ''}): their answer stands and the item stays in the fix round; when this report changes the picture, withdraw their answer with what changed (${p.held.via === 'decide' ? `\`wf decide withdraw ${p.held.decision} --reason "<what changed>" --attempt ${attempt}\`` : `\`wf decisions withdraw ${p.held.decision} --attempt ${attempt} --reason "<what changed>"\``}) and ask them again`
  : p.known && p.contested
  ? `${p.agent} reports that the premise of ${p.ref} does not hold in production (${clip(p.why, 200)}), after reviewer ${p.contested} found it holds: nothing was built for it; the person decides, not another reviewer (${personRoute({ ...p, kind: isDiscoveredRef(p.ref) ? 'discovered' : 'finding' }, attempt)})`
  : p.known
  ? `${p.agent} reports that the premise of ${p.ref} does not hold in production (${clip(p.why, 200)}): nothing was built for it; it is not handed to another pass or fix round: the next reviewer is handed it and judges its premise, or the person answers whether it is a defect at all (\`${notDefectCommand({ ref: p.ref, kind: isDiscoveredRef(p.ref) ? 'discovered' : 'finding' }, attempt)}\`); never argue from that fact that a change is safe`
  : `${p.agent}'s report says the premise of ${p.ref} does not hold, but ${p.ref} is not an open finding or discovered issue of ${attempt}: nothing is routed for it`));
