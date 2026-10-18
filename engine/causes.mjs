// What the findings of an attempt's review rounds have in common (0.7.27, I-191).
//
// Named failure (field): a ticket ran ten and more review rounds where each round found the next place one wrong assumption
// lived (a state only an invoice has, treated as true of a pending rate, built into six places). Every role worked one
// finding at a time: the fix round was handed the findings open now, grouped by the reviewer's symptom labels, so the
// implementer fixed that path's cause and never the assumption; a delta reviewer judged whether a change fixed what it set
// out to fix, so a fix that held at its one place was `fixed` while the cause lived elsewhere; and nothing showed the owner
// that findings across rounds shared a cause. This module reads what the rounds already recorded, and nothing more: a
// reviewer's `sameCauseAs` on a finding links it to the earlier (or sibling) findings it shares a cause with. Information
// for the roles and the owner; no check here refuses anything.
import { dispositionOf, notADefectRef, openAcrossRounds, recordedRoundsOf, settled, waivedRef } from './review-policy.mjs';

const reviewerOf = (r) => r.closure?.reviewer ?? r.reviewer;
export const refOf = (round, id) => `${round}:${id}`;
const text = (v) => (typeof v === 'string' ? v.trim() : '');
const clip = (s, n) => {
  const t = text(s).replace(/\s+/g, ' ');
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

// The findings a finding says it shares its cause with, as "<round>:<id>" refs (anything else it carries is not a ref).
export const sameCauseRefs = (f) => (Array.isArray(f?.sameCauseAs) ? f.sameCauseAs.map(text).filter((x) => x.includes(':')) : []);

// Every finding the recorded rounds raised, in the order raised, with what later rounds said about it. A round recorded twice
// (blind, then with its prior-finding verdicts) counts at its latest record.
function ledgerOf(state) {
  const rounds = recordedRoundsOf(state);
  const by = new Map();
  rounds.forEach((r, index) => {
    for (const f of r.closure?.findings ?? []) {
      const ref = refOf(reviewerOf(r), f.id);
      by.set(ref, { ref, round: reviewerOf(r), id: f.id, index, severity: f.severity ?? null, family: f.family ?? null, work: f.work ?? null, summary: f.summary ?? '', evidence: f.evidence ?? null, own: f.status ?? null, sameCauseAs: sameCauseRefs(f), verdicts: [] });
    }
  });
  rounds.forEach((r, index) => {
    for (const p of r.closure?.priorFindings ?? []) by.get(refOf(p?.round, p?.id))?.verdicts.push({ index, round: reviewerOf(r), status: p.status, evidence: p.evidence ?? null, ...(text(p.premise) ? { premise: p.premise } : {}) });
  });
  return by;
}

// The round a finding was first marked fixed in (a verdict with its evidence, as the engine settles one), or the round it
// was raised in when its reviewer recorded it already fixed; null when none did.
function fixedAt(e) {
  if (e.own === 'fixed') return e.index;
  return e.verdicts.find((v) => v.status === 'fixed' && text(v.evidence))?.index ?? null;
}

// Groups of findings linked by `sameCauseAs`, each named `cause-<n>` in the order its first finding was raised. A link to a
// finding no round recorded links nothing.
export function causeGroups(state, by = ledgerOf(state)) {
  const parent = new Map([...by.keys()].map((k) => [k, k]));
  const find = (k) => {
    while (parent.get(k) !== k) {
      parent.set(k, parent.get(parent.get(k)));
      k = parent.get(k);
    }
    return k;
  };
  for (const e of by.values()) for (const ref of e.sameCauseAs) if (by.has(ref) && ref !== e.ref) parent.set(find(e.ref), find(ref));
  const members = new Map();
  for (const k of by.keys()) members.set(find(k), [...(members.get(find(k)) ?? []), k]);
  const label = new Map();
  const groups = [];
  for (const k of by.keys()) {
    const refs = members.get(find(k));
    if (refs.length < 2 || label.has(k)) continue;
    const cause = `cause-${groups.length + 1}`;
    groups.push({ cause, refs });
    for (const r of refs) label.set(r, cause);
  }
  return { groups, label };
}

// Findings that are open now: still raised and not verified fixed, waived, ticketed or moved (a claimed fix still counts as open
// until a reviewer verifies it).
function openRefs(state) {
  return new Set(openAcrossRounds(state).filter((f) => {
    const d = dispositionOf(state, f.ref);
    return !d || d.choice === 'fixed';
  }).map((f) => f.ref));
}

// A recurring cause: a finding still open that says it shares its cause with an earlier finding a round had already marked
// fixed (in an earlier round, or in the round that raised this one). The last fix covered one place and the cause lives
// elsewhere too. `fix` is the commit recorded for the earlier finding, when one is.
export function recurringCauses(state, { fixes = [] } = {}) {
  const by = ledgerOf(state);
  if (!by.size) return [];
  const { label } = causeGroups(state, by);
  const open = openRefs(state);
  const out = [];
  for (const e of by.values()) {
    if (!open.has(e.ref)) continue;
    const earlier = e.sameCauseAs.map((ref) => by.get(ref)).filter((a) => a && a.ref !== e.ref && fixedAt(a) !== null && fixedAt(a) <= e.index);
    if (!earlier.length) continue;
    out.push({
      cause: label.get(e.ref) ?? null,
      again: e.ref,
      fixed: earlier.map((a) => a.ref),
      fixes: earlier.flatMap((a) => fixes.filter((x) => refOf(x.round, x.id) === a.ref).map((x) => ({ finding: a.ref, repo: x.repo, commit: String(x.commit).slice(0, 10) }))),
    });
  }
  // A finding a round verified fixed and a later round found open again (the same ref): the fix covered one place, and no new
  // finding was raised to say so. The engine settles a finding on its fixed verdict, so it is not among the open ones above.
  for (const e of by.values()) {
    const again = reopenedBy(e);
    if (again) out.push({ cause: label.get(e.ref) ?? null, again: e.ref, fixed: [e.ref], reopenedBy: again, fixes: fixes.filter((x) => refOf(x.round, x.id) === e.ref).map((x) => ({ finding: e.ref, repo: x.repo, commit: String(x.commit).slice(0, 10) })) });
  }
  return out;
}

// The round that last found a finding open again after one had verified it fixed, when no round has verified it fixed since.
function reopenedBy(e) {
  let fixed = e.own === 'fixed';
  let by = null;
  for (const v of e.verdicts) {
    if (v.status === 'fixed' && text(v.evidence)) {
      fixed = true;
      by = null;
    } else if (v.status === 'open' && text(v.evidence) && fixed) by = v.round;
  }
  return by;
}

// Earlier findings of the same `family` that a round had already marked fixed, per finding: a label match, not a confirmed
// cause (a reviewer confirms one with `sameCauseAs`; a pair already confirmed, or in one cause group, is not listed here).
function sameFamilyFixed(by, label) {
  const out = new Map();
  for (const e of by.values()) {
    const family = text(e.family);
    if (!family) continue;
    const earlier = [...by.values()].filter((a) => a.index < e.index && text(a.family) === family && fixedAt(a) !== null && fixedAt(a) <= e.index && !(label.get(a.ref) && label.get(a.ref) === label.get(e.ref)));
    if (earlier.length) out.set(e.ref, earlier.map((a) => a.ref));
  }
  return out;
}

// A possible recurring cause: a finding still open with the family of an earlier finding marked fixed. The engine knows only
// that the labels match, so it says that: the last fix may have covered one place.
export function familyRecurrences(state) {
  const by = ledgerOf(state);
  if (!by.size) return [];
  const { label } = causeGroups(state, by);
  const open = openRefs(state);
  return [...sameFamilyFixed(by, label)].filter(([ref]) => open.has(ref)).map(([again, fixed]) => ({ family: text(by.get(again).family), again, fixed }));
}

// What the owner reads about a recurring cause (`wf resume`, `wf status`, `wf signals`): plain facts and the way on. Information,
// never a refusal.
export const recurrenceLine = (r) => r.reopenedBy ? `${r.again} was marked fixed and found open again by ${r.reopenedBy}: the last fix covered one place; find the root cause before the next fix round (an analysis of the assumption behind it and every place that relies on it, or the strategist's \`cluster\`) so one fix covers them all` : `the cause of ${r.fixed.join(', ')} came back in ${r.again}: the last fix covered one place; find the root cause before the next fix round (an analysis of the assumption behind them and every place that relies on it, or the strategist's \`cluster\`) so one fix covers them all`;

// The same, for a label match (`familyRecurrences`): worded for what is known.
export const familyRecurrenceLine = (r) => `${r.again} has the family of ${r.fixed.join(', ')} (${r.family}), which ${r.fixed.length > 1 ? 'were' : 'was'} marked fixed: the last fix may have covered one place; check whether they share a cause (if they do, find the root cause before the next fix round: an analysis of the assumption behind them and every place that relies on it, or the strategist's \`cluster\`; the reviewer confirms it with \`sameCauseAs\`)`;

// Each finding the rounds recorded, briefly: where it stands now and the fix recorded for it. For the fix round's implementer,
// who fixes a problem so that no review finds it again anywhere and can see here that findings across rounds share a cause.
// Every finding is listed (nothing is counted or cut); only each text is shortened.
export function findingHistory(state, { fixes = [] } = {}) {
  const by = ledgerOf(state);
  const { label } = causeGroups(state, by);
  const open = openRefs(state);
  const labelled = sameFamilyFixed(by, label);
  return [...by.values()].map((e) => {
    const d = dispositionOf(state, e.ref);
    const last = e.verdicts.at(-1) ?? null;
    const status = open.has(e.ref) ? (d ? 'claimed-fixed' : 'open') : reopenedBy(e) ? 'reopened' : waivedRef(state, e.ref) ? 'waived' : notADefectRef(state, e.ref) ? 'not-a-defect' : d ? d.choice : last && settled({ status: last.status }) ? last.status : e.own && settled({ status: e.own }) ? e.own : 'closed';
    const fix = fixes.find((x) => refOf(x.round, x.id) === e.ref) ?? (d?.choice === 'fixed' ? d : null);
    const verified = [...e.verdicts].reverse().find((v) => settled({ status: v.status }) && text(v.evidence));
    // 0.7.30 (I-166, D51): a finding a later round found still open shows that round's evidence too (only a settled one did).
    const latest = e.verdicts.at(-1) && !settled({ status: e.verdicts.at(-1).status }) && text(e.verdicts.at(-1).evidence) ? e.verdicts.at(-1) : null;
    const premised = [...e.verdicts].reverse().find((v) => text(v.premise)) ?? null;
    return {
      ref: e.ref,
      ...(e.family ? { family: e.family } : {}),
      severity: e.severity,
      summary: clip(e.summary, 220),
      status,
      ...(fix ? { fix: { repo: fix.repo ?? null, commit: String(fix.commit ?? '').slice(0, 10) } } : {}),
      ...(verified && status !== 'open' ? { verifiedBy: verified.round, evidence: clip(verified.evidence, 160) } : {}),
      ...(latest && ['open', 'claimed-fixed', 'reopened'].includes(status) ? { stillOpen: { by: latest.round, evidence: clip(latest.evidence, 160) } } : {}),
      // 0.7.31 (I-217, D64): what the latest reviewer that judged the premise behind the fix found (`premise` on its verdict).
      ...(premised ? { premise: clip(premised.premise, 240), premiseBy: premised.round } : {}),
      ...(label.has(e.ref) ? { cause: label.get(e.ref) } : {}),
      ...(e.sameCauseAs.length ? { sameCauseAs: e.sameCauseAs } : {}),
      // A label match with an earlier finding marked fixed: a possible shared cause, apart from a confirmed `cause`.
      ...(labelled.has(e.ref) ? { possibleSameCauseAs: labelled.get(e.ref) } : {}),
    };
  });
}

// Marks findings (`{ round, id }` entries of a bundle) that share a cause with another: `cause` names the group.
export function markCauses(state, entries) {
  const { label } = causeGroups(state);
  return entries.map((f) => (label.has(refOf(f.round, f.id)) ? { ...f, cause: label.get(refOf(f.round, f.id)) } : f));
}

// Every finding a closure's `sameCauseAs` may name: those the recorded rounds raised, and the closure's own.
const knownRefs = (state, closure) => new Set([
  ...(state.reviews ?? []).flatMap((r) => (r.closure?.findings ?? []).map((f) => refOf(reviewerOf(r), f.id))),
  ...(closure.findings ?? []).map((f) => refOf(closure.reviewer, f?.id)),
]);

// What a closure's `sameCauseAs` names that no round recorded and the closure does not raise itself, a finding naming itself,
// and a value that is not a list of "<round>:<id>".
export function sameCauseProblems(state, closure) {
  const known = knownRefs(state, closure);
  const problems = [];
  for (const f of closure.findings ?? []) {
    if (f?.sameCauseAs === undefined) continue;
    const own = refOf(closure.reviewer, f.id);
    if (!Array.isArray(f.sameCauseAs) || !f.sameCauseAs.every((x) => typeof x === 'string' && text(x).includes(':'))) {
      problems.push(`${f.id}: \`sameCauseAs\` is a list of "<round>:<id>" (the reviewer id that raised the finding, a colon, its id)`);
      continue;
    }
    for (const raw of f.sameCauseAs) {
      const ref = text(raw);
      if (ref === own) problems.push(`${f.id}: \`sameCauseAs\` names the finding itself`);
      else if (!known.has(ref)) problems.push(`${f.id}: \`sameCauseAs\` names ${ref}, which no round of this attempt (nor this closure) raised`);
    }
  }
  return problems;
}

// The closure keeping only the `sameCauseAs` entries that name a recorded finding (a partial round, or a review group whose parts
// renamed their findings, keeps what it can instead of being refused).
export function withoutUnknownCauses(state, closure) {
  const known = knownRefs(state, closure);
  return {
    ...closure,
    findings: (closure.findings ?? []).map((f) => {
      if (f?.sameCauseAs === undefined) return f;
      const keep = Array.isArray(f.sameCauseAs) ? f.sameCauseAs.filter((x) => typeof x === 'string' && known.has(text(x)) && text(x) !== refOf(closure.reviewer, f.id)) : [];
      const { sameCauseAs: _dropped, ...rest } = f;
      return keep.length ? { ...rest, sameCauseAs: keep } : rest;
    }),
  };
}
