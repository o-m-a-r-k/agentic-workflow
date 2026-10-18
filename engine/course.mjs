// What sends an attempt to its strategist, and the one planned pass that takes the work that does not block (0.7.28).
//
// Named failure (field, a three-ticket batch: 35 hours, 47 review rounds against 11 planned): the owner agent judged the course
// at every round boundary, wrote "converging, not calling the strategist" six times and handed no strategist in 47 rounds,
// while the changed files ran two to four times the plan and the criteria were amended upward four times. Ten of one ticket's
// sixteen rounds were reactive: each low finding and each item an implementer left became its own implementer round and its
// own review round. One fix whose reviewer had stated a narrow change became a 240-minute redesign that caused the batch's only
// high finding, and nine of the ticket's thirty findings were regressions of the fix round before.
//
// D9 left the course to the owner's judgement, and the judgement was the failure. So the engine names what it sees and the next
// step is the strategist's handoff, an agent's decision and never a question to the person: the signals below, each kept until a
// strategist's recorded decision answers it. Nothing here refuses a handoff (D9: no number the engine picked stops one); the
// next step `wf resume` and `wf advance` read is the strategist, and the strategist's decision (consolidate into one planned pass,
// split, or continue with a new expectation) is what drives the step after it.
import { implementerOf } from './introduced.mjs';
import { familyRecurrenceLine, familyRecurrences, recurrenceLine, recurringCauses } from './causes.mjs';
import { dispositionOf, findingSummary, observations, placementLevel, recordedRoundsOf } from './review-policy.mjs';
import { openDiscovered, discoveredLevel } from './discovered.mjs';
import { premiseOpen } from './premise.mjs';
import { readStatement } from './expectations.mjs';
import { handedRounds, reachLine } from './signals.mjs';
import path from 'node:path';

const idOf = (bundle) => (bundle ? path.basename(String(bundle), '.json') : null);

// The factor the person named for files ("files past twice the plan"), and the same factor for an implementer's expectation
// against the fix a reviewer stated: the one number here, theirs, and it opens a strategist handoff, never a refusal.
export const TWICE = 2;

const reviewerOf = (r) => r.closure?.reviewer ?? r.reviewer;
const latestWith = (state, key) => [...(state.expectations ?? [])].map((x, i) => ({ ...x, index: i })).reverse().find((x) => typeof x.expect?.[key] === 'number') ?? null;

// The implementer's own report while it works or once it closed: its expectation and a re-plan request (I-208).
function reportOf(state, h) {
  const recorded = [...(state.implementerReports ?? [])].reverse().find((r) => r.agent === h.agent && r.handoff && r.handoff === idOf(h.bundle));
  if (recorded) return { minutes: recorded.expect?.minutes ?? null, replan: recorded.replan ?? null, at: recorded.at };
  const said = readStatement(h.reportFile, 'approach');
  return said ? { minutes: said.minutes, replan: null, at: null } : null;
}

// What the plan (or the latest re-plan or strategist expectation stating both) expects one review round to take: its minutes over its
// rounds. Review of 0.7.28 (L4a). An implementer's expectation far above the reviewers' stated fix matters when the excess is more
// than a whole round of the plan: the named failure was 240 minutes against a narrow fix, while 11 against 5 is the noise of two
// estimates, cheaper to let run than a strategist's decision. Infinity when nothing states it: the comparison has no ground then.
function roundMinutes(state) {
  const both = [...(state.expectations ?? [])].reverse().find((x) => typeof x.expect?.minutes === 'number' && typeof x.expect?.rounds === 'number');
  return both ? both.expect.minutes / Math.max(1, both.expect.rounds) : Infinity;
}

// Every course signal of the attempt now, answered or not: { id, key, line, at }.
export function courseSignals(state, sig) {
  const out = [];
  const firstImplementer = (state.handoffs ?? []).find((h) => h.role === 'implementer')?.at ?? null;
  // Files past twice what the plan (or the latest re-plan or strategist decision that states files) expected.
  const ef = latestWith(state, 'files');
  if (ef && sig?.files && sig.files.changed > TWICE * ef.expect.files) out.push({ id: 'files', key: `files:${ef.index}`, at: null, line: `${sig.files.changed} files changed, more than twice the ${ef.expect.files} ${ef.source === 'plan' ? 'the plan' : ef.source === 'strategy' ? 'the strategist' : 'the re-plan'} expected` });
  // Review rounds past the expectation (counted from a re-plan or a strategist's expectation when that is the latest).
  const er = latestWith(state, 'rounds');
  if (er) {
    const handed = er.source === 'plan' ? handedRounds(state) : new Set((state.handoffs ?? []).filter((h) => h.role === 'reviewer' && h.at > er.at).map((h) => h.reviewGroup?.id ?? h.bundle)).size;
    if (handed > er.expect.rounds) out.push({ id: 'rounds', key: `rounds:${er.index}`, at: null, line: `${handed} review rounds handed${er.source === 'plan' ? '' : ' since the latest expectation'}, past the ${er.expect.rounds} ${er.source === 'plan' ? 'the plan' : er.source === 'strategy' ? 'the strategist' : 'the re-plan'} expected` });
  }
  // Criteria amended upward once implementation started: an amendment that adds criteria, unless it carries out the strategist's
  // own consolidation (recorded after a consolidate decision and before the next implementer was handed).
  (state.criteriaAmendments ?? []).forEach((a, i) => {
    if (!a.changes?.added?.length || !firstImplementer || a.at < firstImplementer) return;
    const before = (state.strategy?.decisions ?? []).filter((d) => d.at <= a.at).at(-1);
    const quiet = (since) => !(state.handoffs ?? []).some((h) => h.role === 'implementer' && h.at > since && h.at < a.at);
    const applying = before && before.action === 'consolidate' && quiet(before.at);
    // Review of 0.7.28 (L4b): the re-plan an implementer asked for (`replan` in its report) is the course correction itself, not a
    // drift to send to the strategist: the amendment that answers it, recorded before the next implementer, carries it out.
    const requested = (state.implementerReports ?? []).some((r) => r.replan && r.at && r.at < a.at && quiet(r.at));
    if (applying || requested) return;
    out.push({ id: 'amended', key: `amended:${i + 1}`, at: a.at, line: `amendment ${i + 1} added ${a.changes.added.join(', ')} after implementation started (criteria ${state.criteriaAtFreeze ?? '?'} at freeze, ${(state.criteria ?? []).length} now)` });
  });
  // The same cause across rounds: a confirmed link, or the family of a finding already marked fixed.
  for (const r of recurringCauses(state)) out.push({ id: 'recurring', key: `recurring:${r.again}`, at: null, line: recurrenceLine(r) });
  for (const r of familyRecurrences(state)) if (!out.some((x) => x.key === `recurring:${r.again}`)) out.push({ id: 'recurring', key: `recurring:${r.again}`, at: null, line: familyRecurrenceLine(r) });
  // A fix round whose own lines are where the next round found its defects: the fix made new ones.
  const rounds = recordedRoundsOf(state);
  if (rounds.length >= 2) {
    const [prev, last] = rounds.slice(-2);
    const handedLast = (state.handoffs ?? []).find((h) => h.bundle === last.handoff)?.at ?? last.at;
    const fixers = new Set((state.implementers ?? []).filter((x) => x.openedAt > prev.at && x.closedAt && x.closedAt <= handedLast).map((x) => x.handoff));
    if (fixers.size) {
      const caused = [];
      for (const f of last.closure?.findings ?? []) {
        try {
          const who = implementerOf(state, last, f);
          if (who && fixers.has(who.handoff)) caused.push(f.id);
        } catch {}
      }
      if (caused.length) out.push({ id: 'regression', key: `regression:${reviewerOf(last)}`, at: last.at, line: `round ${rounds.length} raised ${caused.length} finding(s) on lines the fix round after round ${rounds.length - 1} wrote (${caused.map((id) => `${reviewerOf(last)}:${id}`).join(', ')}): the last fix made new defects` });
    }
  }
  // An implementer whose own expectation is far above the fix the reviewers stated for what it was handed, or that asks for a
  // re-plan because the fix needs a migration, a new state or a new endpoint (I-208).
  for (const h of (state.handoffs ?? []).filter((x) => x.role === 'implementer')) {
    const rep = reportOf(state, h);
    if (!rep) continue;
    const stated = h.statedFix?.minutes;
    if (typeof stated === 'number' && stated > 0 && typeof rep.minutes === 'number' && rep.minutes > TWICE * stated && rep.minutes - stated > roundMinutes(state)) out.push({ id: 'divergence', key: `divergence:${h.bundle}`, at: rep.at ?? h.at, line: `implementer ${h.agent} expects ${rep.minutes} min for findings whose reviewers stated a fix of ${stated} min in all (${(h.statedFix.findings ?? []).map((x) => `${x.ref}: ${x.what}`).join('; ')}): an approach far larger than the fix asked for` });
    if (rep.replan) out.push({ id: 'replan', key: `replan:${h.bundle}`, at: rep.at ?? h.at, line: `implementer ${h.agent} asks for a re-plan: ${rep.replan.why}${rep.replan.needs?.length ? ` (it needs ${rep.replan.needs.join(', ')})` : ''}` });
  }
  // 0.7.31 (I-217, D64): a fix round or a planned pass whose own commits changed a contract surface or a migration (measured in
  // engine/signals.mjs `reachSignal`). Named failure (field): a low item with no stated fix became four reshaped API DTOs and a new
  // failure path in a fix round; the estimate signal could not see it (no stated fix for the item; 120 minutes against 60 is exactly
  // twice). The factor stays "more than twice": the person's, and the overrun came from the unbounded item, which no factor on the
  // stated fix could bound; this signal watches what the work did instead. Answered by a strategist decision that saw it (by key).
  for (const r of sig?.reach ?? []) out.push({ id: 'reach', key: `reach:${r.handoff}`, at: null, line: reachLine(r) });
  return out;
}

// A signal is answered by a strategist decision that saw it (the keys it records), or, for one with a time, by any decision
// recorded after it (decisions an earlier engine recorded carry no keys). A re-plan request is answered by an amendment
// recorded after it too: the re-plan it asked for.
export function unanswered(state, signals) {
  const decisions = state.strategy?.decisions ?? [];
  const seen = new Set(decisions.flatMap((d) => d.course ?? []));
  return signals.filter((s) => {
    if (seen.has(s.key)) return false;
    if (s.at && decisions.some((d) => d.at > s.at)) return false;
    if (s.id === 'replan' && s.at && (state.criteriaAmendments ?? []).some((a) => a.at > s.at)) return false;
    return true;
  });
}

// What the owner reads as the next step while signals stand unanswered: the strategist's handoff, said as the step, with what
// the engine saw (its bundle carries the same list as `courseSignals`).
// Review of 0.7.28 (L5): with an implementer still open, the step says what to do with it: the strategist decides alongside, and a
// decision that changes the approach stops it first (its work so far is kept in its commits).
export const courseStep = (open, agentType, running = []) => `the course needs the strategist (the engine's next step, not a judgement call): ${open.map((s) => s.line).join('; ')}. Hand it now: \`wf handoff strategist --agent <new id>\`${agentType ? ` [${agentType}]` : ''} (its bundle carries these signals as \`courseSignals\`; add \`--reason "<your analysis>"\` when you have one), then record its decision (\`wf strategy record --closure <file>\`): one planned pass for all remaining work (\`consolidate\`: a re-plan restating it as work items with a new expectation), a \`split\`, or \`continue\` with a new \`expect\`. Its decision drives the next step${running.length ? `. Implementer ${running.join(', ')} ${running.length > 1 ? 'are' : 'is'} still open: the strategist decides alongside; when its decision changes the approach (a consolidation, a split, a re-plan), stop ${running.length > 1 ? 'them' : 'it'} before the next handoff (\`wf handoff stop --agent <id>\` for one wf launched, then \`wf handoff close --agent <id> --outcome stopped\`; what it committed stays), otherwise let ${running.length > 1 ? 'them' : 'it'} finish and close as usual` : ''}`;

// ---- The planned pass (I-207) ----

// Work items that are a planned pass: an amendment's `pass`, naming the findings and discovered issues it fixes.
export const passItemsOf = (state) => (state.work ?? []).filter((w) => Array.isArray(w.items) && w.items.length);

// Whether a pass work item still holds its items: not yet built, being built, or built and not yet seen by a review.
function holding(state, w) {
  const impls = (state.implementers ?? []).filter((x) => x.work === w.id || (!x.work && (state.handoffs ?? []).some((h) => h.role === 'implementer' && idOf(h.bundle) === x.handoff && (h.covers ?? []).includes(w.id))));
  if (!impls.length) return true;
  if (impls.some((x) => !x.closedAt)) return true;
  const closed = impls.map((x) => x.closedAt).sort().at(-1);
  return !(state.reviews ?? []).some((r) => r.at > closed);
}

// Findings and discovered issues that do not block and are still open, with what the owner and the pass need of each, less
// those a pass already holds. A low one included: the person's rule fixes it unless they let it leave, and it joins a pass
// that happens anyway, never a round of its own.
// 0.7.30 (I-173, D51): `bookkeeping` adds the open bookkeeping entries (an implementer's lint or fixture fixes) for a fix round's
// `alsoFix`: the implementer makes them. The course leaves them out: they open no pass and keep no delivery waiting.
// 0.7.31 (I-217, D64): an item whose premise an implementer reported does not hold in production is no pass's and no fix round's
// until a reviewer or the person settles it (engine/premise.mjs): handing it again would build what the trace showed has no reason
// to exist. It still keeps the delivery waiting.
export function outstanding(state, { bookkeeping = false } = {}) {
  const held = new Set([...passItemsOf(state).filter((w) => holding(state, w)).flatMap((w) => w.items), ...premiseOpen(state).map((p) => p.ref)]);
  // A finding already recorded fixed waits for a reviewer to verify it, not for another pass.
  const found = state.review ? observations(state).filter((f) => !dispositionOf(state, f.ref)).map((f) => ({ ref: f.ref, kind: 'finding', level: placementLevel(state, f), severity: f.severity ?? null, family: f.family ?? null, summary: String(f.summary ?? '').slice(0, 300), where: f.evidence ?? null })) : [];
  const issues = openDiscovered(state).filter((d) => (bookkeeping || d.kind !== 'bookkeeping') && !d.claim).map((d) => ({ ref: d.id, kind: 'discovered', level: discoveredLevel(d), severity: d.severity ?? null, family: d.family ?? null, summary: String(d.summary ?? '').slice(0, 300), where: d.where ?? null, blockedBy: d.blockedBy ?? null }));
  return [...found, ...issues].filter((x) => !held.has(x.ref));
}

// The next step for outstanding items with no blocking finding to fix: one planned pass (an amendment's `pass`, or the
// strategist's consolidation), then one implementer pass and one review of it (the evidence review after the gate).
export const passStep = (items, attempt, fixAll = null) => `${fixAll ? `the person said to fix every item ("${fixAll.words}"): no item is asked about again and none opens a round of its own. ` : ''}${items.length} item(s) that do not block are open (${items.map((x) => `${x.ref}${x.severity ? ` (${x.severity})` : ''}`).join(', ')}): they are fixed in one planned pass, never a round each. Plan it: \`wf criteria amend --file <f> --reason "<why>" --attempt ${attempt}\` with \`pass: [{ items: [${items.map((x) => `"${x.ref}"`).join(', ')}], why: "<what the pass fixes>", repos: [<repo>] }]\` (group them by cause or place; every outstanding item in some group) and \`expect: { minutes: <n>, rounds: 1 }\`, or hand the strategist to group them (\`consolidate\`). Then one implementer for the pass (\`wf handoff implementer --work <its id> --agent <id>\`); record what it fixed with its commit (\`wf discovered close <id> --fixed <commit>\` for a discovered issue, \`wf scope fixed --finding <ref> --commit <sha>\` for a finding); then the gate: the evidence review after it verifies the pass, with no code-review round of its own`;

// The pass was built and nothing else changed: every implementer handed since the last review built a planned pass and closed
// done, no criterion changed since, and that review left nothing blocking. Then the gate runs without a code review of its own
// and the evidence review after it verifies the pass (as D2 has it for an evidence review's fixes).
export function passReady(state, { blockingOpen = 0 } = {}) {
  const r = state.review;
  if (!r || blockingOpen) return false;
  if ((state.criteriaAmendments ?? []).some((a) => a.at > r.at && (a.changes?.added?.length || a.changes?.changed?.length || a.changes?.dropped?.length))) return false;
  const after = (state.implementers ?? []).filter((x) => x.openedAt > r.at);
  if (!after.length || after.some((x) => !x.closedAt || x.outcome !== 'done')) return false;
  const passes = new Set(passItemsOf(state).map((w) => w.id));
  const built = (x) => passes.has(x.work) || (!x.work && (state.handoffs ?? []).some((h) => h.role === 'implementer' && idOf(h.bundle) === x.handoff && (h.covers ?? []).length && h.covers.every((id) => passes.has(id))));
  return after.every(built);
}

// ---- The strategist's consolidation (I-210) ----

// A `consolidate` decision whose amendment is not recorded yet (no amendment and no implementer handed since it): the next
// step that would hand work records that one amendment first, so the decision drives the step after it.
export function consolidationOwed(state) {
  const d = (state.strategy?.decisions ?? []).at(-1);
  if (!d || d.action !== 'consolidate') return null;
  if ((state.criteriaAmendments ?? []).some((a) => a.at > d.at)) return null;
  if ((state.handoffs ?? []).some((h) => h.role === 'implementer' && h.at > d.at)) return null;
  return d;
}
export const consolidationStep = (d, attempt) => `the strategist decided to consolidate (${d.id}): record its one amendment first, restating all remaining work as one planned pass with an expectation (\`wf criteria amend --file <f> --reason "${d.id}: <why>" --attempt ${attempt}\` with \`pass\` for the outstanding findings and discovered issues, \`work\` for work it regroups or adds, and \`expect\`), never scope added piecemeal; then one implementer pass and one review of it`;

// ---- What the review after a pass is handed (review of 0.7.28, L1) ----

// The planned passes built since the last recorded review (their implementers closed after it), with each item and the commits
// recorded for it, and the implementer's own range. Named failure (a review's case): the evidence review after a pass, the one
// review the pass gets, was handed only the diff since the last reviewed tree, with nothing saying that a pass was built, which
// items it claimed to fix and where: it could verify the gate's evidence and miss the pass.
export function passesSince(state) {
  const since = state.review?.at ?? '';
  const out = [];
  for (const w of passItemsOf(state)) {
    const impls = (state.implementers ?? []).filter((x) => x.closedAt && x.closedAt > since && (x.work === w.id || (!x.work && (state.handoffs ?? []).some((h) => h.role === 'implementer' && idOf(h.bundle) === x.handoff && (h.covers ?? []).includes(w.id)))));
    if (!impls.length) continue;
    const items = w.items.map((ref) => {
      const d = (state.discovered ?? []).find((x) => x.id === ref);
      if (d) return { ref, kind: 'discovered', summary: String(d.summary ?? '').slice(0, 300), status: d.status, ...(d.fixed?.commit ? { fixedIn: { repo: d.fixed.repo ?? null, commit: String(d.fixed.commit).slice(0, 12) } } : {}) };
      const rec = (state.scopeDecisions ?? []).filter((x) => x.choice === 'fixed' && (x.keys ?? []).includes(ref)).at(-1);
      return { ref, kind: 'finding', summary: String(findingSummary(state, ref) ?? '').slice(0, 300), ...(rec ? { fixedIn: { repo: rec.repo ?? null, commit: String(rec.commit).slice(0, 12) } } : {}) };
    });
    const ranges = impls.map((x) => ({ implementer: x.agent, commits: Object.fromEntries(Object.keys(x.closedHeads ?? {}).map((r) => [r, `${String(x.heads?.[r] ?? '').split('+')[0].slice(0, 12)}..${String(x.closedHeads[r]).split('+')[0].slice(0, 12)}`])) }));
    out.push({ work: w.id, why: w.why ?? null, items, built: ranges });
  }
  return out;
}
