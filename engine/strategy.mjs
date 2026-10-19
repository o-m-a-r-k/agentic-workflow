// The strategist (0.7.0, D3) and the owner's escalation.
//
// Named failure: no role owned "stop, consolidate, split, or is this still worth its cost". Agents proposed splitting a
// runaway ticket three times and nothing could act on it; one ticket ran 47 review rounds with the blocking findings
// flat for 18 of them, a review round sat open 745 minutes after its session died.
// The first answer made the engine the judge: tripwires on thresholds it picked (amendments, changed files, bundle size,
// wall minutes, a quiet role) refused every implementer and reviewer handoff until a strategist decided. A large ticket
// that was going well hit the same line as one that was not. Now agents predict (the plan's `expect`, an implementer's
// report, a reviewer's closure, the strategist's own prediction), the engine shows each beside what happened (`wf signals`,
// `wf resume`, `wf status`) and the owner agent judges the course at each round boundary, handing the strategist when it
// diverges. The engine stops for three things only: the round count (every 10 handed review rounds the strategist decides first how
// the ticket goes on, 0.7.33, D84), a strategist's escalation awaiting `wf approve` (the person is asked only then), and the rule
// that two missed predictions in a row make the strategist's next decision an escalation (its own predictions, not a number of ours).
//
// The obligations this module adds to a handoff (a plan's `expect`) apply to attempts admitted at 0.7.0 or later (engine/versions.mjs,
// D7). The person's own stops, the round escalation and a strategist's escalation awaiting them, apply to every attempt being
// worked, whatever release admitted it (0.7.27, D34).
import fs from 'node:fs';
import path from 'node:path';
import { acceptedTreeStands, actor, openState } from './attempt.mjs';
import { approveHint, chose, createDecision } from './approve.mjs';
import { STRATEGY_DEFAULTS, ADAPTER_DIR, agentTypeFor, roleClass, trustedAdapter } from './config.mjs';
import { append, attemptDir, loadState, recordedTogether } from './ledger.mjs';
import { executionSettings } from './models.mjs';
import { startPromptFor } from './provenance.mjs';
import { defaultRuntime } from './runtime-policy.mjs';
import { planPaths, scopeFiles } from './scope.mjs';
import { mkdirStateDirectory } from './state-folders.mjs';
import { computeSignals, courseLines, handedRounds, recordedRounds, roundMetrics } from './signals.mjs';
import { introducedFindings } from './introduced.mjs';
import { dispositionOf, observations, openAcrossRounds, placementLevel, severityLevel } from './review-policy.mjs';
import { composeAsk } from './asking.mjs';
import { discoveredLevel } from './discovered.mjs';
import { policyOf, ruleText } from './leaving.mjs';
import { pastCourse } from './learning.mjs';
import { performSplit, resolveSplitItems } from './split.mjs';
import { obligationSince } from './versions.mjs';
import { binds, courseSignals, outstanding, unanswered } from './course.mjs';
import { CAUSES, LEVERS, OUTCOMES, causeOverlaps, correctionLines, diagnosisProblems, openCorrections, refsOf, roundsOf, roundsToAccount, sameCourse } from './diagnosis.mjs';
import { findingHistory } from './causes.mjs';
import { inboxDir } from './improve.mjs';
import { gatePassedForCurrentTree } from './gate.mjs';
import { premiseOpen } from './premise.mjs';
import { productDecisionsFor } from './product-decisions.mjs';
import { expectOf, expectProblems, PLAN_EXPECT } from './expectations.mjs';
import { detectOwner, hostChoice, isHost } from './hosts/index.mjs';
import { WfError, assertSafeId, readJson, refuse, writeJson } from './util.mjs';

export const ACTIONS = ['continue', 'consolidate', 'cluster', 'delta-review', 'split', 'ticket', 'model', 'escalate'];

// ---- The round count ----
// The one number the engine stops for, and it is the person's: at `reviewRoundsEscalate` handed review rounds no implementer or
// reviewer starts until the course is settled again. Named failure: one ticket ran 47 review rounds before anyone stepped back; an
// automatic stop at round 3 was too early; the person's first rule: "make it 10 and then raise it to me to discuss how to continue".
// 0.7.33 (I-229, D84), the person's rule that replaces it: at the count the strategist decides first, and the person is asked only
// when it escalates (two missed predictions in a row still force its escalation). Named failure (field): the round question at 20
// was withdrawn when the person held the attempt to rethink it; they lifted the hold with a direction ("release the api and portal
// fixes and then the mobile apps"), the strategist decided to consolidate, and two minutes later the engine asked the same round
// question again, recommending what the person had just said. The person: "why is the strategist not reviewing this first: I ask
// it to finish it and deliver and i get the following message". A firing is settled by what decides the course after the count
// was reached: a strategist's decision (an escalation too: its own question to the person then holds the handoffs), or the
// person's own direction (their answer to a round question an earlier release asked, a hold they lifted, a product decision
// recorded with `wf decide`), each proven theirs by `wf approve` or `personSaid`. A question the agent withdrew settles nothing.
// The count restarts from the settlement: due again `reviewRoundsEscalate` handed rounds after it.
const ESCALATION = 'rounds-escalation';

// The owner's decision for the escalation (kind escalation, created by the engine; `wf approve`).
export const ownerDecisionKey = (f) => `tripwire:${f.id}:${f.key}`;
const OWNER_KEY = `tripwire:${ESCALATION}:`;
const isOwnerQuestion = (d) => d?.kind === 'escalation' && String(d.key ?? '').startsWith(OWNER_KEY);
const keyedRound = (d) => Number(/:rounds:(\d+)$/.exec(String(d.key ?? ''))?.[1]) || 0;

// The person's latest answer to the round question that chose one of its options, with the handed round count at which they
// gave it, or null. Read from the ledger as it stands (the rounds handed by the time of the answer), so a ledger an earlier
// release wrote replays the same way.
function ownerAnswer(state) {
  const d = (state.decisions ?? []).filter((x) => isOwnerQuestion(x) && chose(x)).sort((x, y) => String(x.approved.at ?? '').localeCompare(String(y.approved.at ?? ''))).at(-1);
  if (!d) return null;
  return { decision: d, rounds: Math.max(keyedRound(d), d.approved.at ? handedRounds(state, d.approved.at) : 0) };
}

// The handed round count at which the round question is next due: `every` rounds, and after each answer `every` rounds after
// the count at which the person answered, whatever they chose. 0.7.29 (I-214). Named failure (field): the person answered
// "Keep going as now" at 17 handed rounds (an attempt an earlier release let run past 10 unasked, I-185), whose promise is
// another 10 rounds before asking again; the next firing was keyed to the next multiple of 10, so at 20 the next implementer
// handoff asked the same question again, three rounds later. A question is never asked twice: "comes back after N" counts from
// the answer.
export function escalationDue(state, c = STRATEGY_DEFAULTS) {
  const every = c.reviewRoundsEscalate;
  if (!every) return null;
  const answer = ownerAnswer(state);
  const marks = settlements(state);
  let at = every;
  let settled = null;
  let next = 0;
  // Each firing in turn: the first settlement at or after the count was reached (an answer to a round question settles whenever it
  // came: it was asked at a firing), and the next firing as many rounds after it.
  for (;;) {
    const reached = reachedAt(state, at);
    if (!reached) break;
    // Review of 0.7.33 (L1, M5): an answer settles the firing its question was keyed to, or one reached before it was given; a lifted
    // hold settles only a firing reached before the hold was placed (the person stopped the course at the count, then gave it).
    const i = marks.findIndex((m, k) => k >= next && (m.by === 'answer' ? m.keyed === at || String(m.at) >= String(reached) : String(m.at) >= String(reached) && (m.by !== 'lifted' || String(m.holdAt ?? '') >= String(reached))));
    if (i < 0) break;
    next = i + 1;
    settled = { ...marks[i], rounds: Math.max(marks[i].keyed ?? 0, handedRounds(state, marks[i].at)) };
    at = settled.rounds + every;
  }
  return { at, answer, settled };
}

// The time the handed review rounds reached `n`: when the n-th round was handed (a divided review counts once).
function reachedAt(state, n) {
  const seen = new Set();
  for (const h of [...(state.handoffs ?? [])].filter((x) => x.role === 'reviewer').sort((x, y) => String(x.at).localeCompare(String(y.at)))) {
    seen.add(h.reviewGroup?.id ?? h.bundle);
    if (seen.size === n) return h.at ?? null;
  }
  return null;
}

// What settles a firing of the round count, in time order (0.7.33, I-229): a strategist's recorded decision, the person's answer
// to a round question, and a hold the person placed after the count was reached and then lifted (their `wf approve` of it). Never a
// question the agent withdrew. Review of 0.7.33 (M5): a product decision (`wf decide`) answers a product question, not how the
// course goes on, so it settles nothing; nor does a hold placed before the count, whose lifting says nothing about the count.
function settlements(state) {
  const out = [];
  for (const d of state.strategy?.decisions ?? []) out.push({ at: d.at, by: 'strategist', id: d.id, what: `the strategist decided ${d.action} (${d.id})` });
  for (const d of state.decisions ?? []) {
    if (isOwnerQuestion(d) && chose(d)) out.push({ at: d.approved.at, by: 'answer', id: d.id, keyed: keyedRound(d), what: `the person answered ${d.id} (${d.approved.choice})` });
    else if (d.kind === 'lift-hold' && d.approved?.choice === 'yes') out.push({ at: d.approved.at, by: 'lifted', id: d.id, holdAt: String(d.key ?? '').slice(`release:${state.id}:`.length) || null, what: `the person lifted the hold (${d.id}${d.approved.quote ? `: "${d.approved.quote}"` : ''})` });
  }
  return out.filter((m) => m.at).sort((x, y) => String(x.at).localeCompare(String(y.at)));
}

// The round question asked since the person's latest answer (or since the start, before any), open or answered in their own
// words, or null: the question a firing due now asks. An earlier release keyed a first question to the multiple of the count
// it was opened at (`rounds:20` for an attempt it let run to 23 unasked); that question is still this firing's, so it is never
// asked twice. A withdrawn one is no question: the next handoff asks afresh.
function askedSince(state, due) {
  const since = String(due?.settled?.at ?? '');
  return (state.decisions ?? []).filter((d) => isOwnerQuestion(d) && !d.withdrawn && !chose(d) && d.id !== due?.settled?.id && String(d.createdAt ?? '') > since).at(-1) ?? null;
}

// The firing at `rounds` handed review rounds, or null. `key` names one firing: the round count it is due at, or the key of
// the question already asked for it.
export function roundsEscalation(state, c = STRATEGY_DEFAULTS, rounds = handedRounds(state)) {
  const due = escalationDue(state, c);
  if (!due || rounds < due.at) return null;
  const asked = askedSince(state, due);
  return { id: ESCALATION, key: asked ? asked.key.slice(OWNER_KEY.length) : `rounds:${due.at}`, summary: `${rounds} review rounds handed; ${asked && !asked.approved ? 'the owner decides how to continue' : 'the strategist decides first how to continue'}` };
}

// The open round questions that are not the firing's.
const earlyQuestions = (state, c) => {
  const firing = roundsEscalation(state, c);
  return (state.decisions ?? []).filter((d) => isOwnerQuestion(d) && !d.approved && !d.withdrawn && (!firing || d.key !== ownerDecisionKey(firing)));
};

// A round question still open that is not the firing's: one an earlier release opened at the next multiple of the count,
// before as many rounds had passed since the person's answer (I-214). The engine withdraws it, saying why, when any command
// opens the attempt (`openState`, and `wf status` for every open attempt), before anything lists it or tells the agent to ask
// it: a question that is not due is never put to the person. The question due later is a new one. Returns the state as it
// stands after.
//
// Review of 0.7.29: with the adapter unreadable, the defaults (every 10 rounds) judged a project that asks every 4, so a
// question due there was withdrawn and the person asked it again; nothing is withdrawn on a reading of the rules that is not
// the project's. And two commands opening the attempt at once each read it before either withdrew, so each appended the
// same withdrawals: the questions are read again and judged inside the ledger's transaction, before anything is appended.
export function settleRoundQuestions(root, state) {
  if (!(state.decisions ?? []).some((d) => isOwnerQuestion(d) && !d.approved && !d.withdrawn)) return state;
  if (!worked(state)) return state;
  const cfg = adapterOf(root, state);
  if (!cfg || switchedOff(cfg)) return state;
  const c = cfg.strategy ?? STRATEGY_DEFAULTS;
  if (!earlyQuestions(state, c).length) return state;
  recordedTogether(root, state.id, () => {
    const current = loadState(root, state.id);
    const early = worked(current) ? earlyQuestions(current, c) : [];
    if (!early.length) return;
    const due = escalationDue(current, c);
    const settled = due?.settled;
    const why = `${settled ? `${settled.what} at ${settled.rounds} handed rounds; ` : ''}the round count comes back at ${due?.at ?? '?'} handed rounds, counted from ${settled ? 'that' : 'the start'}: this question is not due and is not asked`;
    for (const d of early) append(root, state.id, 'decision.withdrawn', { id: d.id, reason: why }, null);
  });
  return loadState(root, state.id);
}

// 0.7.28 (I-210) gave the round question a `hold` choice, and its choices were the engine's own (continue | split | deliver-core | hold
// | stop). Since 0.7.33 (I-229, D84) the engine asks no round question: the strategist decides at the count, and a question an earlier
// release asked is answered with the choices it was asked with (its record holds them).
const ownerDecision = (state, f) => (state.decisions ?? []).filter((d) => d.kind === 'escalation' && d.key === ownerDecisionKey(f)).at(-1) ?? null;

// The adapter at the attempt's base: a ticket cannot loosen its own escalation. Null when it cannot be read; the defaults
// then apply (the stricter reading).
function adapterOf(root, state) {
  try {
    return trustedAdapter(root, state);
  } catch {
    return null;
  }
}

// Whether the escalation applies to this attempt now: an implementation still being worked on (not accepted, not delivered),
// and not switched off in the adapter.
// 0.7.27 (I-185, D34). Named failure (field): an attempt admitted by a release before 0.7.0 ran 14 review rounds handed (11
// recorded) and was never asked how to go on, because the escalation was gated on the admission version (D7: a release adds no
// obligation to an attempt in flight). The checkpoint is the person's own rule, a question that reopens nothing and costs one
// answer, and its worth is the stop on a ticket that has run long: the attempt that has run longest is the one admitted
// earliest. The agent that read the work skill noticed `wf decisions` was empty and had a strategist ask the person instead.
// Independent review of 0.7.0: acceptance switched the hold off for good, though a base merge after it reopens review
// rounds; an acceptance counts only while the tree is the one accepted.
// A delivered attempt's worktrees are gone: it is not being worked (second final review of 0.7.0: `wf signals` on a delivered
// attempt refused instead of showing its numbers).
const acceptedNow = (state) => acceptedTreeStands(state);
// A batch counts too (final review of 0.7.0: batches sat outside the person's escalation).
const worked = (state) => state.intent === 'implementation' && !['done', 'abandoned', 'handoff-pending'].includes(state.phase) && !state.delivery?.completedAt && !acceptedNow(state);
const switchedOff = (cfg) => cfg?.roles?.strategist === false || cfg?.strategy?.enabled === false;
export const strategyApplies = (state, cfg) => worked(state) && !switchedOff(cfg);

// ---- Predictions ----
// `prediction.signal` is a comparison the engine can evaluate: `<signal> <op> <number>`, judged when `prediction.by`
// (a review round number, or an ISO time) is reached. Round-derived signals are judged on the rounds up to `by`.
export const PREDICTABLE = {
  rounds: (m) => m.rounds,
  blockingLatest: (m) => m.blockingLatest,
  findingsLatest: (m) => m.findingsLatest,
  roundsSinceDecrease: (m) => m.roundsSinceDecrease,
  blockingOpen: (_m, s) => s.blockingOpen,
  observationsOpen: (_m, s) => s.observationsOpen.length,
  changedFiles: (_m, s) => s.files.changed,
  amendments: (_m, s) => s.amendments,
  wallMinutes: (_m, s) => s.wallMinutes ?? 0,
  bundleBytes: (_m, s) => s.bundle.bytes ?? 0,
};
const OPS = { '<=': (a, b) => a <= b, '>=': (a, b) => a >= b, '==': (a, b) => a === b, '<': (a, b) => a < b, '>': (a, b) => a > b };

export function parseSignalExpression(text) {
  const m = /^\s*([A-Za-z]+)\s*(<=|>=|==|<|>)\s*(\d+(?:\.\d+)?)\s*$/.exec(String(text ?? ''));
  if (!m || !PREDICTABLE[m[1]]) return null;
  return { name: m[1], op: m[2], value: Number(m[3]) };
}

// 'pending' until `by` is reached, then 'held' or 'missed' (sticky once a decision recorded it).
export function predictionStatus(state, decision, signals, nowMs = Date.now()) {
  const kept = state.strategy.outcomes[decision.id];
  if (kept) return { status: kept.status, observed: kept.observed };
  const p = decision.prediction;
  const expr = parseSignalExpression(p?.signal);
  if (!p || !expr) return { status: 'none', observed: null };
  const round = Number.isInteger(p.by);
  if (round ? signals.rounds.length < p.by : nowMs < Date.parse(p.by)) return { status: 'pending', observed: null };
  const metrics = roundMetrics(round ? signals.rounds.slice(0, p.by) : signals.rounds);
  const observed = PREDICTABLE[expr.name](metrics, signals);
  return { status: OPS[expr.op](observed, expr.value) ? 'held' : 'missed', observed };
}

// Consecutive missed predictions, newest decision last; a held one resets it, and so does an escalation (the owner has
// been asked).
export function missedStreak(state, signals, nowMs = Date.now()) {
  let streak = 0;
  for (const d of state.strategy.decisions) {
    if (d.action === 'escalate') {
      streak = 0;
      continue;
    }
    const { status } = predictionStatus(state, d, signals, nowMs);
    if (status === 'missed') streak += 1;
    else if (status === 'held') streak = 0;
  }
  return streak;
}

// ---- The hold ----

// The strategist's escalation still open: its latest question (a fresh one is asked after an answer in the person's own
// words) that no choice has answered. A later strategist decision supersedes it (it is the last decision's escalation that
// counts), so a question the person withdrew stays open, holding the handoffs, until one is recorded or it is asked again.
const openEscalation = (state) => {
  const last = state.strategy.decisions.at(-1);
  const first = last?.action === 'escalate' && last.escalation ? state.decisions.find((x) => x.id === last.escalation) : null;
  // A withdrawn question is not an answer: the escalation stays open and the next handoff asks it afresh.
  const d = first ? state.decisions.filter((x) => x.kind === 'escalation' && x.key === first.key).at(-1) : null;
  return d && !chose(d) ? d : null;
};
const wordsOf = (d) => (d?.approved?.words ? `; the person answered ${d.id} in their own words, "${d.approved.words}": follow them, and if they mean one of the choices, ask again with exactly these options` : '');

// A strategist handed and not yet decided (a launch the engine saw fail does not count) on an attempt still being worked:
// `wf resume` tells the owner to wait for it. Information, not a refusal: the owner decides whether to wait. A handoff
// older than the last recorded decision is superseded by it: a strategist that died undecided and was replaced by one that
// decided is not waited for.
export const strategistWaiting = (state) => {
  if (!worked(state)) return null;
  const decided = state.strategy.decisions.at(-1)?.at ?? null;
  const h = state.handoffs.filter((x) => x.role === 'strategist' && !state.strategy.decisions.some((d) => d.handoff === x.bundle) && !(decided && x.at && x.at <= decided)).at(-1);
  return h && h.launch?.status !== 'failed' ? h : null;
};

// What stops the next implementer or reviewer handoff: the person's round escalation, unanswered, or a strategist's
// escalation the person has not decided. Null when nothing does (or the escalation does not apply to this attempt).
export function strategyHold(root, state) {
  if (!worked(state)) return null;
  const cfg = adapterOf(root, state);
  if (switchedOff(cfg)) return null;
  const c = cfg?.strategy ?? STRATEGY_DEFAULTS;
  // Due only when as many rounds have passed since the person's latest answer (I-214): an answered firing is never due again.
  const owner = roundsEscalation(state, c);
  const escalation = openEscalation(state);
  if (!owner && !escalation) return null;
  if (owner) {
    const pending = ownerDecision(state, owner);
    const open = pending && !pending.approved && !pending.withdrawn ? pending : null;
    // A round question an earlier release asked and the person has not answered stays theirs to answer; a strategist's decision
    // recorded since settles it too (the question is then withdrawn, with that reason).
    if (open) {
      const guidance = `${owner.summary}: ${open.id} is the person's question, asked before 0.7.33; they answer it (${approveHint(state, open)}), or the strategist decides first (\`wf handoff strategist --agent <id> --reason "${owner.summary.split(';')[0]}"\`, then \`wf strategy record --closure <file> --attempt ${state.id}\`), which settles it. No implementer or reviewer starts until one of them does.`;
      return { owner, ownerPending: open, escalation, guidance: `${guidance}${waitingNote(state, escalation)}` };
    }
    // 0.7.33 (I-229, D84): at the count the strategist decides first; the person is asked only when it escalates. A round question an
    // earlier release asked that they answered in words that choose no option is no settlement: their words go to the strategist.
    const words = pending?.approved?.words ? ` The person answered ${pending.id} in their own words, "${pending.approved.words}": hand them to the strategist (\`--context\` or its reason); they settle nothing by themselves.` : '';
    const guidance = `${owner.summary}:${words} at the round count the strategist decides first. Hand it with the count as the reason (\`wf handoff strategist --agent <id> --reason "${owner.summary.split(';')[0]}"\`) and record its decision (\`wf strategy record --closure <file> --attempt ${state.id}\`): any decision settles the count, which restarts from it (due again after ${c.reviewRoundsEscalate} more handed rounds); the person is asked only when it escalates (and after two of its predictions missed in a row it must). A hold the person placed after the count was reached and lifted settles it too. No implementer or reviewer starts until then.`;
    return { owner, ownerPending: null, ownerDecisionWords: pending?.approved?.words ? { id: pending.id, words: pending.approved.words } : null, escalation, guidance: `${guidance}${waitingNote(state, escalation)}` };
  }
  return { owner: null, ownerPending: null, escalation, guidance: escalationGuidance(state, escalation) };
}

// 0.7.27 (review of the release, I-185 x I-186). The person's round question can be due while the owner has withdrawn a
// strategist's escalation and handed a corrected strategist that has not decided. Named failure (a ticket's own shape): the
// guidance spoke only of the round question, and once the person answered it the next handoff asked the withdrawn question
// afresh, verbatim: the person was asked about the same stop twice, once with a question already judged wrong. The waiting
// strategist's decision supersedes the withdrawn question, so it comes first.
function waitingNote(state, escalation) {
  if (!escalation?.withdrawn) return '';
  const waiting = strategistWaiting(state);
  // No strategist handed since: the next handoff after the person's answer asks the withdrawn question again, as it was.
  if (!waiting) return ` The strategist's escalation ${escalation.id} was withdrawn (${escalation.withdrawn.reason ?? 'no reason recorded'}) and no strategist has been handed since: hand one and record its decision before the next handoff, or ${escalation.id}'s question is asked again as it was after this one, a question already judged wrong: \`wf handoff strategist --agent <id> --reason "..."\`, then \`wf strategy record --closure <file> --attempt ${state.id}\` (its decision supersedes the withdrawn question).`;
  return ` The strategist's escalation ${escalation.id} was withdrawn (${escalation.withdrawn.reason ?? 'no reason recorded'}) and strategist ${waiting.agent} was handed after it: record its decision first, which supersedes the withdrawn question (\`wf strategy record --closure <file> --attempt ${state.id}\`), so the person is not asked that question as well.`;
}

// What the owner agent does about a strategist's escalation that holds the handoffs, by the state of its question. 0.7.27
// (I-186). Named failure (field): the guidance for a question the owner had withdrawn was the one for a question awaiting the
// person (ask it and run `wf approve`), a route `wf approve` refuses for a withdrawn question; the owner was left with no
// supported way on, and the strategist's corrected decision was refused for the same reason.
const redo = (state) => `hand a strategist with what changed (\`wf handoff strategist --agent <id> --reason "..."\`) and record its decision (\`wf strategy record --closure <file> --attempt ${state.id}\`): a recorded decision supersedes the question`;
function escalationGuidance(state, e) {
  if (e.withdrawn) return `the strategist's escalation ${e.id} was withdrawn (${e.withdrawn.reason ?? 'no reason recorded'}) and nobody can answer it; no implementer or reviewer starts until a decision supersedes it (${redo(state)}) or the question is asked again (the next implementer or reviewer handoff asks the question again with its choices, and the person answers that one)`;
  if (e.approved) return `the strategist's escalation ${e.id} was answered in the person's own words, "${e.approved.words ?? e.approved.choice}", which is neither choice: follow them; no implementer or reviewer starts until the question is settled: the next implementer or reviewer handoff asks it again with exactly its choices, or, if their words change the course, withdraw it with what they said (\`wf decisions withdraw ${e.id} --attempt ${state.id} --reason "<their words>"\`) and ${redo(state)}`;
  return `the strategist escalated (${e.id}); the person decides: ${approveHint(state, e)}; no implementer or reviewer starts until then`;
}

// Recorded when the engine refuses because of the escalation: the report counts them. At most once per firing.
function recordEscalation(root, state, f) {
  if (state.strategy.tripwires.some((t) => t.id === f.id && t.key === f.key)) return;
  append(root, state.id, 'strategy.tripwire', { tripwire: f.id, key: f.key, summary: f.summary }, null);
}

// The owner answered the escalation with `stop`, or with `hold` (a product or legal answer is needed first): the attempt is held
// in his words, once per decision.
function stopChosen(root, state) {
  const stopped = (state.decisions ?? []).find((d) => d.kind === 'escalation' && String(d.key).startsWith('tripwire:') && ['stop', 'hold'].includes(d.approved?.choice) && !(state.holds ?? []).some((h) => h.decision === d.id));
  if (!stopped) return;
  const hold = stopped.approved.choice === 'hold';
  append(root, state.id, 'hold', { reason: hold ? `the person needs to give a product or legal answer first (escalation ${stopped.id}: ${stopped.summary})` : `the owner chose stop at the escalation ${stopped.id} (${stopped.summary})`, decision: stopped.id }, null);
  throw refuse(hold ? `not handed: the person chose to hold ${state.id} at ${stopped.id} until they give a product or legal answer` : `not handed: the owner chose stop at ${stopped.id}; ${state.id} is on hold`, hold ? 'gather what they need to decide (read-only), bring it to them, and wait: only they lift the hold (`wf release`, confirmed with `wf approve`)' : 'only the owner lifts it (`wf release`, confirmed with `wf approve`)', { id: 'strategy:owner-stop' });
}

// `wf handoff implementer|reviewer`: refused while the person's escalation or a strategist's escalation stands.
export function requireOwnerDecision(root, state, role, options = {}) {
  stopChosen(root, state);
  const hold = strategyHold(root, state);
  if (!hold) return requireCourseDecision(root, state, role);
  if (hold.owner) {
    recordEscalation(root, state, hold.owner);
    const pendingOwner = hold.ownerPending;
    if (pendingOwner) throw refuse(`not handed: ${hold.owner.summary} (${pendingOwner.id}); no ${role} starts until the person answers it or the strategist decides`, approveHint(state, pendingOwner), { id: 'strategy:owner-escalation' });
    // 0.7.33 (I-229, D84). Named failure (field): the engine asked the person the round question two minutes after the strategist
    // decided and the person had given the course; the strategist decides first, and the person is asked only when it escalates.
    const waiting = strategistWaiting(state);
    const words = hold.ownerDecisionWords ?? null;
    throw refuse(`not handed: ${hold.owner.summary}; no ${role} starts until it decides${words ? `; the person answered ${words.id} in their own words, "${words.words}": hand them to it` : ''}`, waiting ? `strategist ${waiting.agent} was handed and has recorded no decision: wait for it, then \`wf strategy record --closure <file> --attempt ${state.id}\`` : `\`wf handoff strategist --agent <id> --reason "${hold.owner.summary.split(';')[0]}" --attempt ${state.id}\`, then \`wf strategy record --closure <file> --attempt ${state.id}\`; the person is asked only when it escalates`, { id: 'strategy:round-count' });
  }
  // Asked again after an answer in the person's own words or a withdrawal, with the same words (0.7.23: the second asking
  // lost them and showed the strategist's rationale).
  const e = hold.escalation;
  // 0.7.27 (review of the release): a withdrawn question is not asked afresh while a strategist handed after it has not decided;
  // that decision supersedes it, and asking the person first would put the same stop to them twice.
  const successor = e.withdrawn ? strategistWaiting(state) : null;
  if (successor) throw refuse(`not handed: the strategist's escalation ${e.id} was withdrawn and strategist ${successor.agent} was handed after it and has recorded no decision; no ${role} starts until it does (its decision supersedes ${e.id}, so the person is not asked it again)`, `wait for ${successor.agent}'s completion notification, then \`wf strategy record --closure <file> --attempt ${state.id}\`; if it is gone, hand a fresh strategist with a new id (\`wf handoff strategist --agent <new id> --reason "..."\`) and record that one's decision`, { id: 'strategy:escalated' });
  const esc = e.approved || e.withdrawn ? createDecision(root, state, { kind: 'escalation', key: e.key, summary: e.summary, choices: e.choices, plain: e.plain ?? null, labels: e.labels ?? null, then: e.then ?? null, recommend: e.recommend ?? null, settles: e.settles ?? null, items: e.items ?? null }) : e;
  // Asked again as it was after a withdrawal (the owner judged it wrong): the way out is named where it is asked (review of the release).
  const askedAgain = e.withdrawn ? ` ${esc.id} is the withdrawn question ${e.id} asked again as it was; if it is still wrong, withdraw it (\`wf decisions withdraw ${esc.id} --attempt ${state.id} --reason "<what changed>"\`), hand a strategist (\`wf handoff strategist --agent <id> --reason "..."\`) and record its decision: a recorded decision supersedes the question.` : '';
  throw refuse(`not handed: the strategist escalated ${state.id} (${esc.id}: ${esc.summary}); no ${role} starts until the owner decides${wordsOf(hold.escalation.approved ? hold.escalation : null)}`, askedAgain ? `${approveHint(state, esc)}.${askedAgain}` : approveHint(state, esc), { id: 'strategy:escalated' });
}

// 0.7.34 (I-234): a course signal that binds (engine/course.mjs `BINDING`: rounds past the attempt's own prediction, a fix whose own
// lines held the next round's findings, a cause a reviewer linked to one already fixed, a finding a strategist's diagnosis accounted
// for raised again) and that no strategist decision answered holds the next implementer and code-review round, as the round count
// does (D84): the strategist decides first. An evidence review (a gate passed on this tree), a gate, the acceptance and delivery go on.
// Named failure (field): eleven handed rounds with no strategist decision while a fix chain and base drift were visible.
export function bindingSignals(root, state, role) {
  if (!worked(state)) return [];
  const cfg = adapterOf(root, state);
  if (switchedOff(cfg)) return [];
  if (role === 'reviewer') {
    try {
      if (gatePassedForCurrentTree(state)?.ok) return [];
    } catch {}
  }
  try {
    // The person's own direction given after a signal fired (their answer to a round question an earlier release asked, a hold
    // they lifted) gave the course it asks about: it holds nothing then (D84: a course the person gave is followed).
    const given = settlements(state).filter((m) => m.by !== 'strategist').map((m) => String(m.at));
    return unanswered(state, courseSignals(state, null)).filter(binds).filter((x) => !(x.at && given.some((t) => t > String(x.at))));
  } catch {
    return [];
  }
}

function requireCourseDecision(root, state, role) {
  const open = bindingSignals(root, state, role);
  if (!open.length) return;
  const waiting = strategistWaiting(state);
  throw refuse(`not handed: the course needs the strategist first, and no ${role} starts until it decides: ${open.map((x) => x.line).join('; ')}`, waiting ? `strategist ${waiting.agent} was handed and has recorded no decision: wait for it, then \`wf strategy record --closure <file> --attempt ${state.id}\`` : `\`wf handoff strategist --agent <id> --attempt ${state.id}\` (its bundle carries these as \`courseSignals\`), then \`wf strategy record --closure <file> --attempt ${state.id}\`; any decision it records answers them`, { id: 'strategy:course' });
}

// ---- `wf signals` ----

const decisionsOf = (state, signals, nowMs) => state.strategy.decisions.map((d) => ({ id: d.id, at: d.at, action: d.action, prediction: d.prediction, handedBecause: d.handedBecause ?? null, prediction_status: predictionStatus(state, d, signals, nowMs) }));

export function signalsReport(root, state) {
  const cfg = adapterOf(root, state);
  const c = cfg?.strategy ?? STRATEGY_DEFAULTS;
  const nowMs = Date.now();
  const signals = computeSignals(root, state, { cfg, nowMs });
  const due = escalationDue(state, c);
  const firing = roundsEscalation(state, c, signals.roundsHanded);
  const last = due?.answer ?? null;
  return {
    ...signals,
    strategy: {
      applies: strategyApplies(state, cfg),
      // When the round question is next due (handed rounds, counted from the person's latest answer), that answer, and the
      // firing when it is due now.
      escalation: { everyRounds: c.reviewRoundsEscalate, nextAt: due?.at ?? null, lastAnswer: last ? { id: last.decision.id, choice: last.decision.approved.choice, rounds: last.rounds } : null, settledBy: due?.settled ? { id: due.settled.id, by: due.settled.by, rounds: due.settled.rounds, what: due.settled.what } : null, firing },
      decisions: decisionsOf(state, signals, nowMs),
      missedPredictionsInARow: missedStreak(state, signals, nowMs),
      // What the plan expected, and each re-plan's expectation after it (`wf criteria amend`).
      expectations: state.expectations,
      nextRound: state.strategy.nextRound,
      // Observations a ticket decision queued; the tracker step is the owner agent's (the engine records no ticket).
      toTicket: state.strategy.toTicket,
    },
  };
}

export function signalsText(r) {
  const n = (v, unit = '') => (v === null || v === undefined ? 'n/a' : `${v}${unit}`);
  const lines = [`${r.attempt}  ${r.item}  signals at ${r.at}`];
  lines.push('  course (what was expected against what is; no limit applies, the owner agent judges at each round boundary):');
  for (const l of courseLines(r, { predictions: r.strategy.decisions })) lines.push(`    ${l}`);
  for (const x of r.strategy.expectations.filter((y) => y.source === 'amendment')) lines.push(`    re-plan at amendment ${x.amendment} expects ${Object.entries(x.expect).map(([k, v]) => `${k} ${v}`).join(', ')} ("${x.reason}")`);
  lines.push(`  review rounds recorded: ${r.rounds.length}${r.rounds.length ? ` (new blocking findings per round: ${r.rounds.map((x) => x.blocking).join(', ')}; findings: ${r.rounds.map((x) => x.findings).join(', ')}); of ${r.rounds.length === 1 ? "the first round's" : `the first 1 to ${r.rounds.length} rounds'`} findings, open now: ${r.rounds.map((x) => x.open).join(', ')}` : ''}; rounds since new blocking findings last decreased: ${r.roundsSinceDecrease}`);
  lines.push(`  open now: ${r.blockingOpen} blocking${r.blockingOpen ? ` (${r.blockingOpen - r.blockingCarried} raised by the latest round, ${r.blockingCarried} carried from earlier rounds${r.blockingCarried ? `: ${r.blockingFindings.filter((f) => f.carried).map((f) => f.ref).join(', ')}` : ''})` : ''}, ${r.observationsOpen.length} observation(s)`);
  lines.push(`  criteria: ${n(r.criteria.atFreeze)} at freeze, ${r.criteria.now} now; amendments: ${r.amendments}`);
  lines.push(`  plan names ${n(r.files.planned)} path(s) in its anchors and tests; latest reviewer bundle: ${n(r.bundle.bytes, ' bytes')}`);
  const e = r.strategy.escalation;
  lines.push(`  round count${r.strategy.applies ? '' : ' (does not apply to this attempt: accepted, delivered or switched off)'}: every ${e.everyRounds} handed rounds the strategist decides first, counted from what last settled it; ${e.firing ? `${e.firing.summary} [UNSETTLED]` : `next at ${e.nextAt} handed rounds${e.settledBy ? ` (${e.settledBy.what} at ${e.settledBy.rounds})` : ''}`}`);
  for (const t of r.strategy.toTicket) lines.push(`  to ticket (${t.decision}): ${t.items.join(', ')}`);
  if (r.strategy.missedPredictionsInARow) lines.push(`  strategist predictions missed in a row: ${r.strategy.missedPredictionsInARow}${r.strategy.missedPredictionsInARow >= 2 ? '; its next decision must be an escalation' : ''}`);
  return lines.join('\n');
}

// ---- The strategist's handoff ----

// 0.7.34 (I-232): every ref a diagnosis may cite, verbatim: the review rounds, the findings (engine/causes.mjs findingHistory) and
// the events between them.
function historyOf(state) {
  return {
    rounds: roundsOf(state).map((r) => ({ round: r.agents.join(' / '), ...(r.mode ? { mode: r.mode } : {}), handedAt: r.handedAt, status: r.status, endedAt: r.endedAt, ...(r.notReached.length ? { notReached: r.notReached } : {}) })),
    findings: findingHistory(state).map((f) => ({ ref: f.ref, ...(f.family ? { family: f.family } : {}), severity: f.severity, status: f.status, summary: f.summary, ...(f.cause ? { cause: f.cause } : {}) })),
    events: [...refsOf(state).values()].filter((x) => x.kind !== 'finding').sort((x, y) => String(x.at).localeCompare(String(y.at))).map((x) => ({ ref: x.ref, at: x.at, kind: x.kind, line: x.line })),
  };
}

const familyGroups = (items) => {
  const out = {};
  for (const f of items) (out[f.family ?? '(none)'] ??= []).push(f);
  return out;
};

// `wf handoff strategist --agent ID [--reason "what diverged"]`: the bundle the strategist reads. The owner agent hands it
// whenever it judges the course needs it, for example because the plan, an implementer or the strategist's own earlier
// prediction no longer matches what is happening; `--reason` is what it saw. Reviewer-independence rules do not apply (it
// judges the attempt's course, not its code), but it may not be one of the attempt's implementers.
export function strategistHandoff(root, state, options) {
  if (!options.agent || options.agent === true) throw new WfError('--agent <identity of the agent you are starting> is required');
  if (options.reason !== undefined && (typeof options.reason !== 'string' || !options.reason.trim())) throw new WfError('--reason needs text: what in the course diverged from what was predicted');
  const handedBecause = options.reason === undefined ? null : options.reason.trim().slice(0, 2000);
  // 0.7.33 (I-229, D84): handed while the round count is due, the strategist is told it decides first.
  const roundCount = (() => {
    try {
      const c = trustedAdapter(root, state).strategy ?? STRATEGY_DEFAULTS;
      return roundsEscalation(state, c)?.summary.split(';')[0] ?? null;
    } catch {
      return null;
    }
  })();
  const agent = assertSafeId(options.agent, 'agent id');
  if (state.intent !== 'implementation') throw refuse(`${state.id} is an ${state.intent} attempt; only implementation attempts have a strategist`, null, { id: 'strategy:not-implementation' });
  if (['done', 'abandoned'].includes(state.phase)) throw refuse(`${state.id} is ${state.phase}`, null, { id: 'strategy:closed' });
  if (state.roles.implementer.includes(agent)) throw refuse(`${agent} implemented part of this attempt and cannot be its strategist`, 'start a fresh agent for the strategist with a new id', { id: 'strategy:implementer-as-strategist' });
  const cfg = trustedAdapter(root, state);
  if (cfg.roles?.strategist === false) throw refuse('the strategist role is switched off in this project (`roles.strategist: false`)', null, { id: 'strategy:disabled' });
  const runtime = options.runtime ?? cfg.roles?.strategist?.runtime ?? defaultRuntime(state) ?? detectOwner()?.runtime;
  if (!isHost(runtime)) throw refuse(`choose --runtime ${hostChoice(' or ')}: this attempt has no recorded owning runtime`, null, { id: 'strategy:no-runtime' });
  const cls = roleClass(cfg, 'strategist');
  const agentType = agentTypeFor(cfg, 'strategist');
  const { effort, model, sourceClass, runtimeAdapterBase } = executionSettings(root, state, 'strategist', cls, runtime);
  const nowMs = Date.now();
  const signals = computeSignals(root, state, { cfg, nowMs });
  const streak = missedStreak(state, signals, nowMs);
  const decisions = decisionsOf(state, signals, nowMs);
  const n = state.handoffs.length + 1;
  const file = path.join(attemptDir(root, state.id), 'handoffs', `${String(n).padStart(2, '0')}-strategist.json`);
  const closureFile = path.join(root, '.wf-worktrees', state.id, '_strategy', `closure-${n}.json`);
  const appendix = cfg.roles?.strategist?.appendix ? path.resolve(root, ADAPTER_DIR, cfg.roles.strategist.appendix) : null;
  const bundle = {
    attempt: state.id,
    item: state.item,
    lane: state.lane,
    role: 'strategist',
    agent,
    agentType,
    class: cls,
    effort,
    model,
    sourceClass,
    runtimeAdapterBase,
    worktrees: Object.fromEntries(Object.entries(state.repos).map(([k, v]) => [k, v.worktree])),
    criteria: state.criteria,
    workItems: state.work,
    planFiles: state.plan ? planPaths(state.plan, scopeFiles(state)) : [],
    // Why the owner agent handed you: what it saw diverge from what was predicted (null when it said nothing).
    handedBecause,
    ...(roundCount ? { roundCount } : {}),
    // 0.7.28 (I-210): what the engine saw that no strategist has answered (engine/course.mjs): why it made you the next step.
    courseSignals: unanswered(state, courseSignals(state, signals)).map(({ id, line }) => ({ id, line })),
    // 0.7.28 (I-207): what does not block and is still open, for one planned pass (`consolidate`).
    outstanding: outstanding(state),
    // 0.7.31 (I-217, D64, D65): items whose premise an implementer reported does not hold (settled by a reviewer or the person, never
    // planned into a pass meanwhile), and the product decisions the person made, with what each rests on.
    premiseFailed: premiseOpen(state).length ? premiseOpen(state).map((p) => ({ ref: p.ref, kind: p.kind, reportedBy: p.agent, why: p.why, evidence: p.evidence ?? [] })) : undefined,
    decisions: productDecisionsFor(state, 'strategist'),
    // Without the roles' shell commands (`sessions[].shell`): the bundle is kept as evidence.
    signals: { ...signals, sessions: (signals.sessions ?? []).map(({ shell, ...rest }) => rest) },
    // The comparison the owner agent made, as `wf resume` shows it: the plan's expectation, each implementer's and reviewer's
    // own, and your earlier predictions, beside what happened.
    // Without the roles' shell commands: the bundle is kept as evidence, and a command may carry a value no one should keep.
    course: courseLines(signals, { predictions: decisions, shell: false }),
    // 0.7.9 (D19): how this project's plans predicted against what happened in delivered attempts, per lane, so a
    // predictable overrun is judged as one (D9: measurement, never a threshold).
    pastEstimates: pastCourse(root) ?? undefined,
    expectations: state.expectations,
    predictions: { missedInARow: streak, escalateRequired: streak >= 2 },
    blocking: { count: signals.blockingOpen, byFamily: familyGroups(signals.blockingFindings) },
    observations: { count: signals.observationsOpen.length, byFamily: familyGroups(signals.observationsOpen) },
    discoveredOpen: (state.discovered ?? []).filter((d) => d.status === 'open').map((d) => ({ id: d.id, summary: d.summary, where: d.where ?? null, severity: d.severity ?? null, invariant: d.invariant ?? null, placement: d.invariant ? 'high' : severityLevel(d.severity) ?? 'high' })),
    // Where the located findings came from: each traced (git blame on the reviewed tree) to the implementer handoff whose
    // commits wrote the cited line (engine/introduced.mjs). Measurement, for your judgement of what keeps failing.
    introduced: (() => {
      try {
        return introducedFindings(state);
      } catch {
        return null;
      }
    })(),
    // The person's rule for what may leave the delivery (D17, 2026-10-14).
    severityRule: ruleText(policyOf(cfg)),
    severityScale: { projectExamples: cfg.severity ?? null, leaving: policyOf(cfg) },
    earlierDecisions: state.strategy.decisions.map((d) => ({ id: d.id, at: d.at, action: d.action, rationale: d.rationale, ...(d.premise ? { premise: d.premise } : {}), ...(d.diagnosis ? { diagnosis: d.diagnosis } : {}), ...(d.review ? { review: d.review } : {}), handedBecause: d.handedBecause ?? null, prediction: d.prediction, outcome: predictionStatus(state, d, signals, nowMs) })),
    // 0.7.34 (I-232): what your diagnosis cites and accounts for. `history` lists every review round (by reviewer id, with whether it
    // was recorded, died or is in flight, and what it did not reach), every finding with where it stands, and the events between
    // them (base merges, gate runs, discovered issues, decisions), each ref exactly as you cite it. `roundsToAccount` are the rounds
    // recorded or died since the previous decision: each goes in a diagnosis entry's \`rounds\` or in \`progressed\`; rounds in
    // flight are listed apart and are not yours to account for yet. `openCorrections` are the corrections earlier decisions made that
    // no decision has closed: you review each. `causeOverlaps` names what earlier decisions put under different causes.
    history: historyOf(state),
    roundsToAccount: roundsToAccount(state).map((r) => ({ round: r.agents.join(' / '), status: r.status, ...(r.notReached.length ? { notReached: r.notReached } : {}) })),
    roundsInFlight: roundsOf(state).filter((r) => r.status === 'in-flight').map((r) => r.agents.join(' / ')),
    openCorrections: openCorrections(state).map((c) => ({ correction: c.key, since: c.decision, cause: c.cause, about: CAUSES[c.cause], lever: c.lever, change: c.change, reviews: c.reviews.map((r) => ({ decision: r.decision, outcome: r.outcome, ...(r.why ? { why: r.why } : {}) })) })),
    corrections: correctionLines(state),
    causeOverlaps: causeOverlaps(state),
    invariants: cfg.invariants ? path.resolve(root, ADAPTER_DIR, cfg.invariants) : null,
    roleAppendix: appendix && fs.existsSync(appendix) ? appendix : null,
    // Outside .wf-evidence/: the strategist writes it, `wf strategy record` copies it into the evidence.
    strategyClosureFile: closureFile,
    closureSchema: {
      strategist: agent,
      action: ACTIONS.join(' | '),
      rationale: 'why this action, in a few sentences',
      prediction: { signal: `<${Object.keys(PREDICTABLE).join(' | ')}> <op> <number>, for example "blockingLatest <= 2"`, by: 'a review round number (recorded rounds so far: ' + signals.rounds.length + ') or an ISO time' },
      items: 'optional: the observation (`reviewer:id`) or discovered (`D<n>`) ids to ticket (ticket; low items only, each then decided by the person), the families to sweep (cluster), the criteria to consolidate',
      split: '{ items: [work item, criterion, observation `reviewer:id` or discovered ids], reason } (action split)',
      model: '{ role: implementer|reviewer|planner, class } (action model): the next handoffs of that role run at that work class, with its pinned model and effort',
      question: 'action escalate: in plain words, for someone with no other context, what the person decides and why it is theirs',
      options: 'action escalate: 2 or 3 of { "label": "<plain words>", "then": "<what happens next>", "settles": [{ "ref": "<open finding or discovered id this option decides>", "what": "<what it is, one plain line>" }] (optional: each is shown to the person and not asked again) }',
      recommend: 'action escalate: { "label": "<one of the labels>", "why": "<one line>" }, or { "label": null, "why": "<what it depends on>" }',
      expect: 'optional, any action: { files: <the whole change>, rounds: <from now>, minutes: <from now> }: the expectation the course is compared with from now on (`continue` with a new expectation; a consolidation states the pass it plans)',
      diagnosis: `required: what kept going wrong, one entry per cause (an empty list when nothing did): [{ cause: <${Object.keys(CAUSES).join(' | ')}>, what: "<plain words, no ids>", rounds: [<reviewer ids from history>], refs: [<findings round:id, D<n>, S<n>, A<n>, base:<n>, gate:<runId> from history>], correction: { lever: <${Object.keys(LEVERS).join(' | ')}>, change: "<plain words: what the owner and the roles do differently from now on>" } }] (or \`settledBy: "<S<n> or A<n>>"\` in place of \`correction\` when an earlier decision already deals with it); \`causes\` and \`levers\` say what each means`,
      progressed: 'required with the diagnosis: the reviewer ids of rounds in `roundsToAccount` that did what they were handed (a round that died or did not reach its scope goes in a diagnosis entry)',
      review: `required while \`openCorrections\` is not empty: [{ correction: "<S<n>:<cause>>", outcome: <${OUTCOMES.join(' | ')}>, refs: [<what shows it, from after that decision for held and failed>], why: "<plain words; required for not-applied and dropped>", improvement: "<I-<n>, optional: the improvement item for a workflow rule that kept it from being carried out>" }]`,
      causes: CAUSES,
      levers: LEVERS,
      premise: 'cluster and consolidate (any action may): { shared: "<the premise the findings or the pass rest on>", traced: "<what was traced: who writes the data in production, who reads it, what depends on it, what happens when it is absent>", notTraced: "<what was not>" }; a shared premise nobody traced is an analysis before a fix round',
    },
    instructions: `You are the strategist. You were handed because the course diverged from what was predicted: \`courseSignals\` is what the engine saw that no strategist has answered (files past twice the plan, rounds past it, criteria amended upward, a cause that keeps coming back, a fix whose own lines were where the next defects were found, an implementer whose expectation is far above the fix the reviewers stated, one that asks for a re-plan, or a fix round or planned pass whose own commits changed a contract or a migration that nothing it was handed accounts for), and \`handedBecause\` what the owner saw. Your decision answers those signals and drives the next step: \`consolidate\` restates all remaining work (the open findings, \`outstanding\`, unstarted work) as one planned pass with an expectation, never scope added piecemeal; \`split\` moves part of it to a sibling attempt; \`continue\` says why the numbers are explained and states the new \`expect\` the course is compared with from now on. Read \`course\` (the expectations beside what happened), the signals and the earlier decisions; choose one action; give a prediction the engine can check. A \`cluster\` or \`consolidate\` names the premise the findings or the pass share (\`premise: { shared, traced, notTraced }\`): who writes the data in production, who reads it, what depends on it and what happens when it is absent, and what was not traced; a shared premise nobody traced is an analysis before a fix round, never a fix round on a finding's own framing. Contraction is allowed and expected when work keeps growing. A finding that blocks is never waived here (that is the owner's \`wf approve\`), and nothing the change caused leaves the delivery batch without the owner's approval. Before you choose, step back: say what kept going wrong across the rounds (\`diagnosis\`, one entry per cause, citing the rounds and refs in \`history\`), what changes in how the work runs so it does not happen again (its \`correction\`), which rounds since the previous decision did what they were handed (\`progressed\`), and what became of each correction in \`openCorrections\` (\`review\`): a correction that did not hold is never met with the same change again. Write the closure file named in \`strategyClosureFile\`, then run \`wf strategy record --closure <that file> --attempt ${state.id}\`.${streak >= 2 ? ' Two of your earlier predictions were missed: the only action the engine accepts now is `escalate`.' : ''}${roundCount ? ` You were handed at the round count (${roundCount}): you decide first how the ticket goes on, and any decision you record settles the count; the person is asked only when you escalate, so escalate when their decision is needed, and follow a course they already gave (the owner's reason, a hold they lifted, their product decisions).` : ''}`,
  };
  mkdirStateDirectory(path.dirname(closureFile), { recursive: true });
  const startPrompt = startPromptFor(file);
  // Named failure (I-109): the bundle was written into the evidence and the handoff appended to the ledger with no transaction,
  // and the file was recorded in the manifest only when the process ended, so a `wf` command another session ran in between
  // found a file nobody had recorded and refused with "extra file (not written by wf)". Written, entered in the ledger and
  // recorded in one transaction, as a reviewer handoff is (`publish` in lifecycle.mjs): a reader sees none of it or all.
  recordedTogether(root, state.id, () => {
    writeJson(file, bundle);
    append(root, state.id, 'handoff', { role: 'strategist', agent, runtime, session: options.session ?? null, agentType, class: cls, effort, model, sourceClass, runtimeAdapterBase, startPrompt, work: null, bundle: file, reason: handedBecause, owes: ['diagnosis'] }, actor(options));
  });
  return { bundle: file, startPrompt, agentType, agent, roleStale: null, restrictions: [], sweeps: null, class: cls, effort, model, work: null, lessons: null, closureFile, state: loadState(root, state.id) };
}

// ---- `wf strategy record` ----

const KEYS = ['strategist', 'action', 'rationale', 'prediction', 'items', 'split', 'model', 'options', 'question', 'recommend', 'expect', 'premise', 'diagnosis', 'progressed', 'review'];
// 0.7.31 (I-217, D64): the premise a decision rests on (a cluster's or a consolidation's shared premise, what was traced and what
// was not), recorded with it, read leniently: a string or { shared, traced, notTraced }. Never a reason to refuse a closure.
const premiseOf = (v) => {
  const t = (x, n) => (typeof x === 'string' && x.trim() ? x.trim().slice(0, n) : null);
  if (typeof v === 'string') return t(v, 2000) ? { shared: t(v, 2000) } : null;
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const out = { shared: t(v.shared, 1000), traced: t(v.traced, 2000), notTraced: t(v.notTraced, 2000) };
  return out.shared || out.traced || out.notTraced ? Object.fromEntries(Object.entries(out).filter(([, x]) => x)) : null;
};
const TOKEN = /^[a-z0-9][a-z0-9-]{0,39}$/;
// An option the person reads: plain words, not an identifier.
const plainLabel = (v) => typeof v === 'string' && v.trim().length >= 3 && v.trim().length <= 80 && !TOKEN.test(v.trim()) && !/\(recommended\)\s*$/i.test(v);
const sameLabel = (v) => String(v ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
const slug = (v, taken) => {
  let s = String(v).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'option';
  while (taken.has(s)) s = `${s.slice(0, 37)}-${taken.size}`;
  taken.add(s);
  return s;
};
// The escalation as the person will read it: the choice ids the engine keeps, and their plain labels, consequences and the
// recommendation (engine/approve.mjs createDecision).
// 0.7.23 (D29): an option may name the open items it decides (`settles`: [{ ref, what }]): the engine lists each in its
// `then`, in the strategist's plain words, and those items are recorded under the person's answer instead of being asked
// about again (the person's rule: "i don't want the same question asked multiple times"). Named failure (field): an
// escalation's option said "the owner presents the six blocking findings ... for your explicit approvals", so the answer the
// person gave was asked again seven times. A recommendation is written into the question itself (`plain`).
const settleRef = (x) => String(x?.ref ?? '').trim();
export function escalationWords(c, { blocking = new Set(), ruleNote = () => null } = {}) {
  if (!Array.isArray(c.options) || !c.options.every((o) => o && typeof o === 'object')) return null;
  const taken = new Set();
  const choices = c.options.map((o) => slug(o.label, taken));
  const labels = Object.fromEntries(choices.map((id, i) => [id, c.options[i].label.trim()]));
  const listed = choices.map((id, i) => [id, (Array.isArray(c.options[i].settles) ? c.options[i].settles : []).filter((x) => settleRef(x))]);
  const settles = Object.fromEntries(listed.filter(([, xs]) => xs.length).map(([id, xs]) => [id, [...new Set(xs.map(settleRef))]]));
  // Every item, each in its own words (never a count: the person sees what they decide).
  const decides = (xs) => {
    // An item the project's rule fixes before shipping says so (independent review of 0.7.23: a medium item left on the
    // answer with no word that the rule would have kept it).
    const line = (x) => `${String(x.what).trim().replace(/[.\s]+$/, '')}${blocking.has(settleRef(x)) ? ' (accepted without a fix)' : ` (shipped unfixed, listed for later${ruleNote(settleRef(x)) ? `; ${ruleNote(settleRef(x))}` : ''})`}`;
    return ` Choosing this also decides ${xs.length === 1 ? 'this, without asking you again' : `these ${xs.length}, without asking you again about each`}: ${xs.map((x, n) => `${xs.length > 1 ? `(${n + 1}) ` : ''}${line(x)}`).join('; ')}.`;
  };
  const then = Object.fromEntries(choices.map((id, i) => [id, listed[i][1].length ? `${String(c.options[i].then).trim().replace(/[.\s]+$/, '')}.${decides(listed[i][1])}` : String(c.options[i].then).trim()]));
  // Each settled item's plain line, for the delivered comment's known limits (engine/tracker.mjs).
  const items = Object.fromEntries(listed.flatMap(([, xs]) => xs.map((x) => [settleRef(x), { what: String(x.what).trim() }])));
  const rec = c.recommend && typeof c.recommend === 'object' ? c.recommend : null;
  const pick = rec ? choices.find((id) => labels[id] === String(rec.label ?? '').trim()) ?? null : null;
  const why = String(rec?.why ?? '').trim();
  const plain = rec && why ? composeAsk({ context: '', recommend: { choice: pick, why } }, { question: String(c.question).trim(), labels, then }, choices).plain : String(c.question).trim();
  return { choices, plain, labels, then, ...(pick ? { recommend: { choice: pick, why: why || null } } : {}), ...(Object.keys(settles).length ? { settles, items } : {}) };
}

// Schema check of the strategist's closure; returns the problems (empty when it is valid).
export function closureProblems(c, { rounds = 0, nowMs = Date.now(), plainEscalation = false, openRefs = null } = {}) {
  const p = [];
  const text = (v) => typeof v === 'string' && v.trim();
  const list = (v) => Array.isArray(v) && v.length > 0 && v.every(text);
  if (!c || typeof c !== 'object' || Array.isArray(c)) return ['the closure must be a JSON object'];
  // Keys the engine does not read are ignored, not refused (second final review of 0.7.0: a closure that carried an extra
  // note was refused on first use).
  if (!text(c.strategist)) p.push('`strategist`: the agent id this decision comes from (the id the handoff was made for)');
  if (!ACTIONS.includes(c.action)) p.push(`\`action\` must be one of ${ACTIONS.join(', ')}`);
  if (!text(c.rationale)) p.push('`rationale`: why this action');
  const pr = c.prediction;
  if (!pr || typeof pr !== 'object') p.push('`prediction`: { signal, by } is required');
  else {
    if (!parseSignalExpression(pr.signal)) p.push(`\`prediction.signal\` must read "<signal> <op> <number>" with a signal from ${Object.keys(PREDICTABLE).join(', ')} and an op from <=, >=, ==, <, >`);
    if (Number.isInteger(pr.by)) {
      if (pr.by <= rounds) p.push(`\`prediction.by\` ${pr.by} is a round that has already been recorded (${rounds} so far); a prediction names a later one`);
    } else if (typeof pr.by === 'string' && Number.isFinite(Date.parse(pr.by)) && /^\d{4}-\d\d-\d\d/.test(pr.by)) {
      if (Date.parse(pr.by) <= nowMs) p.push('`prediction.by` is a time that has already passed');
    } else p.push('`prediction.by` must be a review round number or an ISO time');
  }
  // 0.7.28 (I-210): a new expectation the course is compared with from now on (any action may state one).
  p.push(...expectProblems(c.expect, PLAN_EXPECT, 'expect'));
  // Fields another action uses are ignored, not refused: the role file shows them all (second final review of 0.7.0).
  if (c.action === 'ticket' && !list(c.items)) p.push('action ticket needs `items`: the observation ids to ticket');
  if (c.action === 'split') {
    if (!c.split || typeof c.split !== 'object' || !list(c.split.items) || !text(c.split.reason)) p.push('action split needs `split: { items: [ids], reason }`');
  }
  if (c.action === 'model') {
    const m = c.model;
    // The strategist picks among the work classes the project's adapter declares (each pins its models and effort); a
    // free model string would bypass the committed pin (I-44), so it names a class.
    if (!m || typeof m !== 'object' || Array.isArray(m) || !['implementer', 'reviewer', 'planner'].includes(m.role) || !text(m.class)) p.push('action model needs `model: { role: implementer|reviewer|planner, class: <a work class of the adapter> }`');
  }
  // 0.7.11: an escalation is a question the person answers, often on a phone with nothing else to read. It says in plain
  // words what is decided and why it is theirs (`question`), and each option is a plain label with what happens next
  // (`then`); a recommendation is welcome, never required (one forced would be invented).
  if (c.action === 'escalate' && plainEscalation) {
    if (!text(c.question) || c.question.trim().length > 400) p.push('action escalate needs `question`: in plain words, for someone with no other context, what the person decides and why it is theirs (at most 400 characters; no ids, no workflow terms)');
    if (!Array.isArray(c.options) || c.options.length < 2 || c.options.length > 3 || !c.options.every((o) => o && typeof o === 'object' && plainLabel(o.label) && text(o.then))) p.push('action escalate needs `options`: 2 or 3 of { "label": "<plain words, 3-80 characters, not an identifier, not ending in (Recommended)>", "then": "<what happens next if the person picks it>" }');
    else if (new Set(c.options.map((o) => sameLabel(o.label))).size !== c.options.length) p.push('the escalation options need distinct labels (letter case aside)');
    // 0.7.23: the person asked for a recommendation with every question; "none" is allowed when it depends on something only
    // they know, and `why` says what (a recommendation forced would be invented).
    if (!c.recommend || typeof c.recommend !== 'object' || !(c.recommend.label === null || c.options?.some?.((o) => o?.label?.trim() === String(c.recommend.label ?? '').trim())) || !text(c.recommend.why)) p.push('action escalate needs `recommend`: { "label": "<one of the option labels>", "why": "<one line>" }, or { "label": null, "why": "<what the choice depends on>" } when it truly depends on something only the person knows');
    for (const o of Array.isArray(c.options) ? c.options : []) {
      if (!o || typeof o !== 'object' || o.settles === undefined) continue;
      if (!Array.isArray(o.settles) || !o.settles.every((x) => x && typeof x === 'object' && text(x.ref) && text(x.what))) p.push('`settles`, when given, is a list of { "ref": "<open finding `reviewer:id` or discovered `D<n>`>", "what": "<what it is, in one plain line>" }: the items the option decides, each shown to the person');
      else if (openRefs) {
        const bad = o.settles.map((x) => x.ref.trim()).filter((r) => !openRefs.has(r));
        if (bad.length) p.push(`\`settles\` of "${o.label}": ${bad.join(', ')} ${bad.length > 1 ? 'are' : 'is'} not an open finding or discovered issue of this attempt`);
      }
    }
  } else if (c.action === 'escalate') {
    if (!Array.isArray(c.options) || c.options.length < 2 || c.options.length > 3 || !c.options.every((o) => typeof o === 'string' && TOKEN.test(o))) p.push('action escalate needs `options`: 2 or 3 short choices for the owner (lowercase letters, digits and dashes, for example "split", "continue", "abandon")');
  }
  return p;
}

// The decision, checked and applied: a split is performed, an escalation becomes the owner's reserved decision, a
// delta-review sets the next round's mode (state.strategy.nextRound, in the ledger event). Returns { state, decision }.
export function recordStrategy(root, options) {
  const state = openState(root, options);
  if (typeof options.closure !== 'string') throw new WfError('--closure <file> is required');
  const closure = readJson(options.closure);
  // D7: attempts admitted before 0.7.11 keep the escalation form they were admitted with (or may use the new one).
  const plainEscalation = obligationSince(state, '0.7.11') || (Array.isArray(closure?.options) && closure.options.some((o) => o && typeof o === 'object'));
  const openFound = openAcrossRounds(state).filter((f) => !dispositionOf(state, f.ref));
  const openRefs = new Set([...openFound.map((f) => f.ref), ...(state.discovered ?? []).filter((d) => d.status === 'open' && d.kind !== 'bookkeeping').map((d) => d.id)]);
  const problems = closureProblems(closure, { rounds: computeRounds(state), plainEscalation, openRefs });
  if (problems.length) throw new WfError(`the strategist closure is invalid:\n  - ${problems.join('\n  - ')}`, { hint: 'the bundle\'s `closureSchema` shows the shape' });
  if (['done', 'abandoned'].includes(state.phase)) throw refuse(`${state.id} is ${state.phase}`, null, { id: 'strategy:closed' });
  const h = state.handoffs.filter((x) => x.role === 'strategist' && x.agent === closure.strategist).at(-1);
  if (!h) throw refuse(`\`${closure.strategist}\` was not handed this attempt as its strategist${state.roles.strategist.length ? ` (strategists: ${state.roles.strategist.join(', ')})` : ''}`, `run \`wf handoff strategist --agent <id>\` and start that agent with the printed line`, { id: 'strategy:no-strategist' });
  if (state.strategy.decisions.some((d) => d.handoff === h.bundle)) throw refuse(`${closure.strategist} already recorded its decision (${state.strategy.decisions.find((d) => d.handoff === h.bundle).id}); a new decision needs a fresh strategist handoff`, null, { id: 'strategy:handoff-used' });
  // 0.7.34 (I-232): the diagnosis, the rounds that progressed and the review of open corrections, owed by a strategist handed by this
  // release (`owes` on its handoff: a strategist handed by an earlier one is judged by the bundle it read). Given when not owed, they
  // are checked and recorded all the same; coverage and the review of open corrections are asked only when owed (review of the design, M7).
  const owed = (h.owes ?? []).includes('diagnosis');
  const inbox = (id) => fs.existsSync(path.join(inboxDir(), `${id}.yaml`));
  const diag = diagnosisProblems(state, closure, { owed, inbox });
  if (diag.length) throw refuse(`the strategist closure's diagnosis is refused:\n  - ${diag.join('\n  - ')}`, 'the bundle\'s `history`, `roundsToAccount`, `openCorrections` and `closureSchema` show what it cites and owes', { id: 'strategy:diagnosis' });
  const nowMs = Date.now();
  if (closure.action === 'model') {
    const classes = Object.keys(adapterOf(root, state)?.classes ?? {});
    if (!classes.includes(closure.model.class)) throw refuse(`\`${closure.model.class}\` is not a work class of this project (classes: ${classes.join(', ')})`, null, { id: 'strategy:unknown-class' });
  }
  const pending = openEscalation(state);
  // 0.7.27 (I-186). Named failure (field): the owner withdrew an escalation whose question was wrong and asked the strategist
  // for the corrected decision, and this refused it ("the owner has not decided", with `wf approve` of the withdrawn question,
  // which `wf approve` refuses): the only way on was to edit the workflow. A withdrawn question can be answered by no one, so
  // the decision recorded now supersedes it (the handoffs stay held until it is recorded, or the engine asks the question
  // again, and then that one is live). A question answered in the person's own words stays: their words are followed or
  // withdrawn first, because a decision recorded over them would never see them.
  if (pending && !pending.withdrawn) {
    if (pending.approved) throw refuse(`the strategist escalated ${state.id} (${pending.id}) and the person answered it in their own words, "${pending.approved.words ?? pending.approved.choice}", which is neither choice; no further decision is recorded over their words`, `follow their words; if they mean one of the choices, the next implementer or reviewer handoff asks the question again with exactly these options. If their words change the course, withdraw the question with what they said (\`wf decisions withdraw ${pending.id} --attempt ${state.id} --reason "<their words>"\`), then hand the strategist again (\`wf handoff strategist --agent <id> --reason "..."\`) and record its decision`, { id: 'strategy:escalation-pending' });
    // The question can be the withdrawn one asked again as it was, which is wrong: withdrawing it is the other way on (review of the release).
    throw refuse(`the strategist escalated ${state.id} (${pending.id}) and the owner has not decided; no further decision is recorded until then`, `${approveHint(state, pending)}; or, if the question is wrong, withdraw it with what changed (\`wf decisions withdraw ${pending.id} --attempt ${state.id} --reason "<what changed>"\`) and record the decision again: a recorded decision supersedes a withdrawn question`, { id: 'strategy:escalation-pending' });
  }
  const signals = computeSignals(root, state, { cfg: adapterOf(root, state), nowMs });
  // The strategist's own rule, about its own predictions: two missed in a row and its next decision asks the owner.
  if (missedStreak(state, signals, nowMs) >= 2 && closure.action !== 'escalate') throw refuse(`${state.id}: the last two strategist predictions were missed, so the next decision is answered only by \`escalate\` (to the owner), not \`${closure.action}\``, 'write a closure with action escalate and 2 or 3 options for the owner', { id: 'strategy:escalate-required' });
  // Review of 0.7.33 (H3), a design guard with no field case yet: at the round count the strategist decides instead of the person, and
  // the backstop is its own rule (two missed predictions make its next decision an escalation). A prediction judged only after the next
  // count cannot be missed by then, so the count could come back twice and never reach the person. Recorded while the count is due, a
  // decision's prediction names a review round no later than the next count (the rounds recorded now plus the count); a time cannot
  // be matched to a count, so it is refused there.
  const countC = adapterOf(root, state)?.strategy ?? STRATEGY_DEFAULTS;
  if (closure.action !== 'escalate' && roundsEscalation(state, countC)) {
    const limit = signals.rounds.length + countC.reviewRoundsEscalate;
    const by = closure.prediction?.by;
    if (!Number.isInteger(by) || by > limit) throw refuse(`at the round count a prediction is judged by the next count: \`prediction.by\` must name a review round no later than ${limit} (${signals.rounds.length} recorded now, the next count ${countC.reviewRoundsEscalate} rounds on)${Number.isInteger(by) ? `, not ${by}` : ', not a time'}`, 'a prediction the next count cannot miss is not a prediction: name the round by which your decision shows its effect, and if it misses twice your next decision is an escalation to the person', { id: 'strategy:prediction-past-count' });
  }
  // 0.7.34 (I-232, review of the design H1): the same cause met with the same change after it came back. A design guard with no field
  // case yet: the field's two decisions carried no correction to compare.
  const again = sameCourse(state, closure);
  if (again) throw refuse(`not recorded: ${again}`, 'write a closure whose correction for that cause changes the flow another way, or escalate', { id: 'strategy:same-course' });
  // Checked before anything is applied.
  let moved = null;
  if (closure.action === 'split') moved = resolveSplitItems(root, state, closure.split.items);
  if (closure.action === 'ticket') {
    // Open observations and open discovered issues; whether one may leave the delivery is the person's rule (D17),
    // applied when the owner agent files it (`wf scope ticket`, `wf discovered close --deferred`).
    const refs = new Set([...signals.observationsOpen.map((o) => o.ref), ...(state.discovered ?? []).filter((d) => d.status === 'open' && d.kind !== 'bookkeeping').map((d) => d.id)]);
    const bad = closure.items.filter((id) => !refs.has(id));
    if (bad.length) throw refuse(`${bad.join(', ')} ${bad.length > 1 ? 'are' : 'is'} not an open observation or discovered issue of ${state.id}${refs.size ? ` (open: ${[...refs].join(', ')})` : ''}; a finding that blocks is fixed, or waived by the person`, null, { id: 'strategy:unknown-item' });
    // Only an item the project's `leaving:` policy lets leave may be queued (by default a low one, D17/D18); who decides it
    // (the person or the owner) is applied when the owner files it.
    const levelOf = (ref) => {
      const d = (state.discovered ?? []).find((x) => x.id === ref);
      if (d) return discoveredLevel(d);
      const f = observations(state).find((x) => x.ref === ref);
      return f ? placementLevel(state, f) : 'high';
    };
    const policy = policyOf(adapterOf(root, state));
    const kept = closure.items.filter((ref) => policy[levelOf(ref)] === 'never');
    if (kept.length) throw refuse(`${kept.join(', ')} ${kept.length > 1 ? 'are' : 'is'} at a level the project never lets leave: ${ruleText(policy)}`, 'write a closure that fixes them (cluster, consolidate or split into a sibling attempt of the batch)', { id: 'strategy:ticket-not-low' });
  }
  const id = `S${state.strategy.decisions.length + 1}`;
  const outcomes = state.strategy.decisions.map((d) => ({ d, o: predictionStatus(state, d, signals, nowMs) })).filter(({ d, o }) => !state.strategy.outcomes[d.id] && ['held', 'missed'].includes(o.status)).map(({ d, o }) => ({ decision: d.id, status: o.status, observed: o.observed }));
  let splitResult = null;
  if (closure.action === 'split') splitResult = performSplit(root, state, { resolved: moved, reason: closure.split.reason, options });
  let escalation = null;
  if (closure.action === 'escalate') {
    const fresh = loadState(root, state.id);
    const policy = policyOf(adapterOf(root, state));
    const levelOf = (ref) => {
      const dd = (state.discovered ?? []).find((x) => x.id === ref);
      if (dd) return discoveredLevel(dd);
      const ff = openFound.find((x) => x.ref === ref);
      return ff ? placementLevel(state, ff) : null;
    };
    const ruleNote = (ref) => (levelOf(ref) && policy[levelOf(ref)] === 'never' ? `a ${levelOf(ref)} issue, which your rule normally fixes before shipping` : null);
    const words = escalationWords(closure, { blocking: new Set(openFound.filter((f) => f.classified.blocks).map((f) => f.ref)), ruleNote });
    escalation = createDecision(root, fresh, { kind: 'escalation', key: `strategy:${id}`, summary: closure.rationale.trim().split('\n')[0].slice(0, 300), choices: words?.choices ?? closure.options, ...(words ? { plain: words.plain, labels: words.labels, then: words.then, recommend: words.recommend ?? null, settles: words.settles ?? null, items: words.items ?? null } : {}), options });
  }
  append(root, state.id, 'strategy.decided', {
    id,
    action: closure.action,
    rationale: closure.rationale.trim(),
    prediction: closure.prediction,
    items: closure.items ?? [],
    split: splitResult ? { id: splitResult.id, items: closure.split.items, reason: closure.split.reason, siblings: splitResult.siblings.map((s) => s.id), batch: splitResult.batch } : null,
    model: closure.model ?? null,
    options: closure.options ?? null,
    ...(closure.question ? { question: closure.question } : {}),
    escalation: escalation?.id ?? null,
    outcomes,
    strategist: closure.strategist,
    handoff: h.bundle,
    handedBecause: h.reason ?? null,
    roundsAtDecision: signals.rounds.length,
    // 0.7.28 (I-210): the course signals this decision answers (engine/course.mjs), and the expectation it states.
    course: courseSignals(state, signals).map((x) => x.key),
    ...(expectOf(closure.expect) ? { expect: expectOf(closure.expect) } : {}),
    ...(premiseOf(closure.premise) ? { premise: premiseOf(closure.premise) } : {}),
    ...diagnosisOf(closure),
    signals: { rounds: signals.rounds.map((r) => ({ n: r.n, blocking: r.blocking, findings: r.findings })), roundsSinceDecrease: signals.roundsSinceDecrease, blockingOpen: signals.blockingOpen, observationsOpen: signals.observationsOpen.length, amendments: signals.amendments, changedFiles: signals.files.changed, plannedFiles: signals.files.planned, bundleBytes: signals.bundle.bytes, wallMinutes: signals.wallMinutes},
  }, actor(options));
  return { state: loadState(root, state.id), decision: loadState(root, state.id).strategy.decisions.at(-1), split: splitResult, escalation };
}

// The diagnosis as recorded: only the keys the engine reads, trimmed (it was checked whole before).
const strs = (v) => (Array.isArray(v) ? v.map((x) => String(x).trim()).filter(Boolean) : []);
function diagnosisOf(c) {
  const out = {};
  if (Array.isArray(c.diagnosis)) out.diagnosis = c.diagnosis.map((e) => ({ cause: e.cause, what: e.what.trim(), rounds: strs(e.rounds), refs: strs(e.refs), ...(e.correction ? { correction: { lever: e.correction.lever, change: e.correction.change.trim() } } : { settledBy: String(e.settledBy).trim() }) }));
  if (Array.isArray(c.progressed)) out.progressed = strs(c.progressed);
  if (Array.isArray(c.review)) out.review = c.review.map((r) => ({ correction: String(r.correction).trim(), outcome: r.outcome, refs: strs(r.refs), ...(typeof r.why === 'string' && r.why.trim() ? { why: r.why.trim() } : {}), ...(r.improvement ? { improvement: String(r.improvement) } : {}) }));
  return out;
}

const computeRounds = (state) => new Set((state.reviews ?? []).map((r) => r.handoff ?? `reviewer:${r.reviewer}`)).size;
