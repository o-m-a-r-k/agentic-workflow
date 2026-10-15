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
// diverges. The engine stops for three things only: the person's own 10-round escalation, a strategist's escalation
// awaiting `wf approve`, and the rule that two missed predictions in a row make the strategist's next decision an
// escalation (its own predictions, not a number of ours).
//
// Obligations from this module apply to attempts admitted at 0.7.0 or later (engine/versions.mjs, D7).
import fs from 'node:fs';
import path from 'node:path';
import { acceptedTreeStands, actor, openState } from './attempt.mjs';
import { approveHint, chose, createDecision, questionFor } from './approve.mjs';
import { STRATEGY_DEFAULTS, ADAPTER_DIR, agentTypeFor, roleClass, trustedAdapter } from './config.mjs';
import { append, attemptDir, loadState, recordedTogether } from './ledger.mjs';
import { executionSettings } from './models.mjs';
import { startPromptFor } from './provenance.mjs';
import { defaultRuntime } from './runtime-policy.mjs';
import { planPaths, scopeFiles } from './scope.mjs';
import { mkdirStateDirectory } from './state-folders.mjs';
import { computeSignals, courseLines, handedRounds, recordedRounds, roundMetrics } from './signals.mjs';
import { introducedFindings } from './introduced.mjs';
import { observations, placementLevel, severityLevel } from './review-policy.mjs';
import { discoveredLevel } from './discovered.mjs';
import { policyOf, ruleText } from './leaving.mjs';
import { pastCourse } from './learning.mjs';
import { performSplit, resolveSplitItems } from './split.mjs';
import { obligationSince } from './versions.mjs';
import { detectOwner, hostChoice, isHost } from './hosts/index.mjs';
import { WfError, assertSafeId, readJson, refuse, writeJson } from './util.mjs';

export const ACTIONS = ['continue', 'consolidate', 'cluster', 'delta-review', 'split', 'ticket', 'model', 'escalate'];

// ---- The owner's escalation ----
// The one number the engine stops for, and it is the person's: at `reviewRoundsEscalate` recorded review rounds the next
// implementer or reviewer handoff opens a reserved decision (`wf approve`), and again every as many rounds after a
// `continue`. Named failure: one ticket ran 47 review rounds before anyone stepped back; an automatic stop at round 3 was
// too early; the person's rule: "make it 10 and then raise it to me to discuss how to continue".
const ESCALATION = 'rounds-escalation';

// The firing at `rounds` recorded review rounds, or null. `key` names one firing (the round it fired at).
export function roundsEscalation(rounds, c = STRATEGY_DEFAULTS) {
  const every = c.reviewRoundsEscalate;
  if (!every || rounds < every) return null;
  const at = Math.floor(rounds / every) * every;
  return { id: ESCALATION, key: `rounds:${at}`, summary: `${rounds} review rounds handed; the owner decides how to continue` };
}

// The owner's decision for the escalation (kind escalation, created by the engine; `wf approve`).
export const ownerDecisionKey = (f) => `tripwire:${f.id}:${f.key}`;
export const OWNER_CHOICES = ['continue', 'split', 'deliver-core', 'stop'];
// What the person sees for each choice of the round escalation, and what follows it (0.7.11: plain questions).
const OWNER_WORDS = {
  labels: { continue: 'Keep going as now', split: 'Split off the rest as its own ticket', 'deliver-core': 'Ship what the criteria need now', stop: 'Stop this ticket' },
  then: {
    continue: 'the next fix and review round starts; this question comes back after as many rounds again',
    split: 'the work that keeps reopening moves to a sibling attempt delivered with this one',
    'deliver-core': 'what the criteria need is fixed and shipped; the other open findings are listed as known issues or ticketed',
    stop: 'nothing more is worked on; the attempt waits to be abandoned or reopened',
  },
};
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

// Whether the escalation applies to this attempt now: admitted at 0.7.0 or later, an implementation still being worked
// on (not accepted, not delivered), and not switched off in the adapter.
// Independent review of 0.7.0: acceptance switched the hold off for good, though a base merge after it reopens review
// rounds; an acceptance counts only while the tree is the one accepted.
// A delivered attempt's worktrees are gone: it is not being worked (second final review of 0.7.0: `wf signals` on a delivered
// attempt refused instead of showing its numbers).
const acceptedNow = (state) => acceptedTreeStands(state);
// A batch counts too (final review of 0.7.0: batches sat outside the person's escalation).
const worked = (state) => obligationSince(state, '0.7.0') && state.intent === 'implementation' && !['done', 'abandoned', 'handoff-pending'].includes(state.phase) && !state.delivery?.completedAt && !acceptedNow(state);
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
// words) that no choice has answered.
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
  const firing = roundsEscalation(handedRounds(state), cfg?.strategy ?? STRATEGY_DEFAULTS);
  const owner = firing && !chose(ownerDecision(state, firing)) ? firing : null;
  const escalation = openEscalation(state);
  if (!owner && !escalation) return null;
  if (owner) {
    const pending = ownerDecision(state, owner);
    const guidance = `${owner.summary}. This is the person's decision: bring them the brief from \`wf signals --attempt ${state.id}\` (rounds, blocking findings per round, the families that keep coming back, changed files against what the plan expected, amendments) with 2-3 options and your recommendation. ${pending?.approved || pending?.withdrawn ? `${pending.id} was ${pending.withdrawn ? 'withdrawn' : `answered in the person's own words, "${pending.approved.words}"`}: follow that, and the next implementer or reviewer handoff asks the question again with its choices. ` : ''}${pending && !pending.approved && !pending.withdrawn ? `They answer ${pending.id} in their own terminal (\`wf approve ${pending.id} --attempt ${state.id}\`) or in your question panel, with the question "${questionFor(state, pending)}" and exactly the options ${pending.choices.join(' | ')}, then \`wf approve ${pending.id} --from-question --attempt ${state.id}\`` : 'The next implementer or reviewer handoff opens the decision they answer with `wf approve`'} (continue: another ${(cfg?.strategy ?? STRATEGY_DEFAULTS).reviewRoundsEscalate} rounds before asking again | split: unstarted work, observations and discovered issues move to a sibling attempt of the batch (\`wf split\`); code already built stays | deliver-core: what the criteria need and what blocks stays, every other finding and discovered issue may be ticketed under this decision | stop: a hold). No implementer or reviewer starts until they decide.`;
    return { owner, ownerPending: pending, escalation, guidance };
  }
  return { owner: null, ownerPending: null, escalation, guidance: `the strategist escalated (${escalation.id}: ${escalation.summary}); the owner decides in their own terminal: \`wf approve ${escalation.id}\` (choices: ${escalation.choices.join(' | ')}), or in your question panel (the question "${questionFor(state, escalation)}", exactly those options), then \`wf approve ${escalation.id} --from-question\`; no implementer or reviewer starts until then` };
}

// Recorded when the engine refuses because of the escalation: the report counts them. At most once per firing.
function recordEscalation(root, state, f) {
  if (state.strategy.tripwires.some((t) => t.id === f.id && t.key === f.key)) return;
  append(root, state.id, 'strategy.tripwire', { tripwire: f.id, key: f.key, summary: f.summary }, null);
}

// The owner answered the escalation with `stop`: the attempt is held in his words, once per decision.
function stopChosen(root, state) {
  const stopped = (state.decisions ?? []).find((d) => d.kind === 'escalation' && String(d.key).startsWith('tripwire:') && d.approved?.choice === 'stop' && !(state.holds ?? []).some((h) => h.decision === d.id));
  if (!stopped) return;
  append(root, state.id, 'hold', { reason: `the owner chose stop at the escalation ${stopped.id} (${stopped.summary})`, decision: stopped.id }, null);
  throw refuse(`not handed: the owner chose stop at ${stopped.id}; ${state.id} is on hold`, 'only the owner lifts it (`wf release`, confirmed with `wf approve`)', { id: 'strategy:owner-stop' });
}

// `wf handoff implementer|reviewer`: refused while the person's escalation or a strategist's escalation stands.
export function requireOwnerDecision(root, state, role) {
  stopChosen(root, state);
  const hold = strategyHold(root, state);
  if (!hold) return;
  if (hold.owner) {
    recordEscalation(root, state, hold.owner);
    const answeredInWords = hold.ownerPending?.approved ? hold.ownerPending : null;
    const d = hold.ownerPending && !hold.ownerPending.approved && !hold.ownerPending.withdrawn ? hold.ownerPending : createDecision(root, state, { kind: 'escalation', key: ownerDecisionKey(hold.owner), choices: OWNER_CHOICES, summary: `${hold.owner.summary}: continue | split | deliver-core | stop`, plain: `This ticket has been through ${hold.owner.summary.split(' ')[0]} review round${hold.owner.summary.split(' ')[0] === '1' ? '' : 's'} and the reviews keep finding problems. How should it go on?`, ...OWNER_WORDS });
    throw refuse(`not handed: ${hold.owner.summary} (${d.id}); no ${role} starts until the owner decides${wordsOf(answeredInWords)}`, `${approveHint(state, d)}. Bring the person the brief first (\`wf signals --attempt ${state.id}\`): the numbers, what keeps coming back, 2-3 options and your recommendation`, { id: 'strategy:owner-escalation' });
  }
  const esc = hold.escalation.approved || hold.escalation.withdrawn ? createDecision(root, state, { kind: 'escalation', key: hold.escalation.key, summary: hold.escalation.summary, choices: hold.escalation.choices }) : hold.escalation;
  throw refuse(`not handed: the strategist escalated ${state.id} (${esc.id}: ${esc.summary}); no ${role} starts until the owner decides${wordsOf(hold.escalation.approved ? hold.escalation : null)}`, approveHint(state, esc), { id: 'strategy:escalated' });
}

// ---- `wf signals` ----

const decisionsOf = (state, signals, nowMs) => state.strategy.decisions.map((d) => ({ id: d.id, at: d.at, action: d.action, prediction: d.prediction, handedBecause: d.handedBecause ?? null, prediction_status: predictionStatus(state, d, signals, nowMs) }));

export function signalsReport(root, state) {
  const cfg = adapterOf(root, state);
  const c = cfg?.strategy ?? STRATEGY_DEFAULTS;
  const nowMs = Date.now();
  const signals = computeSignals(root, state, { cfg, nowMs });
  const firing = roundsEscalation(signals.roundsHanded, c);
  const answer = firing ? ownerDecision(state, firing) : null;
  return {
    ...signals,
    strategy: {
      applies: strategyApplies(state, cfg),
      escalation: { everyRounds: c.reviewRoundsEscalate, firing: firing ? { ...firing, answeredBy: chose(answer) ? answer.id : null } : null },
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
  lines.push(`  review rounds recorded: ${r.rounds.length}${r.rounds.length ? ` (blocking per round: ${r.rounds.map((x) => x.blocking).join(', ')}; findings: ${r.rounds.map((x) => x.findings).join(', ')})` : ''}; rounds since blocking findings last decreased: ${r.roundsSinceDecrease}`);
  lines.push(`  open now: ${r.blockingOpen} blocking, ${r.observationsOpen.length} observation(s)`);
  lines.push(`  criteria: ${n(r.criteria.atFreeze)} at freeze, ${r.criteria.now} now; amendments: ${r.amendments}`);
  lines.push(`  plan names ${n(r.files.planned)} path(s) in its anchors and tests; latest reviewer bundle: ${n(r.bundle.bytes, ' bytes')}`);
  const e = r.strategy.escalation;
  lines.push(`  owner escalation${r.strategy.applies ? '' : ' (does not apply to this attempt: admitted before 0.7.0, accepted, or switched off)'}: every ${e.everyRounds} recorded rounds; ${e.firing ? `${e.firing.summary}${e.firing.answeredBy ? ` [answered by ${e.firing.answeredBy}]` : ' [UNANSWERED]'}` : 'not firing'}`);
  for (const t of r.strategy.toTicket) lines.push(`  to ticket (${t.decision}): ${t.items.join(', ')}`);
  if (r.strategy.missedPredictionsInARow) lines.push(`  strategist predictions missed in a row: ${r.strategy.missedPredictionsInARow}${r.strategy.missedPredictionsInARow >= 2 ? '; its next decision must be an escalation' : ''}`);
  return lines.join('\n');
}

// ---- The strategist's handoff ----

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
    signals,
    // The comparison the owner agent made, as `wf resume` shows it: the plan's expectation, each implementer's and reviewer's
    // own, and your earlier predictions, beside what happened.
    course: courseLines(signals, { predictions: decisions }),
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
    earlierDecisions: state.strategy.decisions.map((d) => ({ id: d.id, at: d.at, action: d.action, rationale: d.rationale, handedBecause: d.handedBecause ?? null, prediction: d.prediction, outcome: predictionStatus(state, d, signals, nowMs) })),
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
      options: '2 or 3 short choices for the owner (action escalate)',
    },
    instructions: `You are the strategist. The owner agent handed you because the course diverged from what was predicted (\`handedBecause\` says what it saw). Read \`course\` (the expectations beside what happened), the signals and the earlier decisions; choose one action; give a prediction the engine can check. Contraction is allowed and expected when work keeps growing. A finding that blocks is never waived here (that is the owner's \`wf approve\`), and nothing the change caused leaves the delivery batch without the owner's approval. Write the closure file named in \`strategyClosureFile\`, then run \`wf strategy record --closure <that file> --attempt ${state.id}\`.${streak >= 2 ? ' Two of your earlier predictions were missed: the only action the engine accepts now is `escalate`.' : ''}`,
  };
  mkdirStateDirectory(path.dirname(closureFile), { recursive: true });
  const startPrompt = startPromptFor(file);
  // Named failure (I-109): the bundle was written into the evidence and the handoff appended to the ledger with no transaction,
  // and the file was recorded in the manifest only when the process ended, so a `wf` command another session ran in between
  // found a file nobody had recorded and refused with "extra file (not written by wf)". Written, entered in the ledger and
  // recorded in one transaction, as a reviewer handoff is (`publish` in lifecycle.mjs): a reader sees none of it or all.
  recordedTogether(root, state.id, () => {
    writeJson(file, bundle);
    append(root, state.id, 'handoff', { role: 'strategist', agent, runtime, session: options.session ?? null, agentType, class: cls, effort, model, sourceClass, runtimeAdapterBase, startPrompt, work: null, bundle: file, reason: handedBecause }, actor(options));
  });
  return { bundle: file, startPrompt, agentType, agent, roleStale: null, restrictions: [], sweeps: null, class: cls, effort, model, work: null, lessons: null, closureFile, state: loadState(root, state.id) };
}

// ---- `wf strategy record` ----

const KEYS = ['strategist', 'action', 'rationale', 'prediction', 'items', 'split', 'model', 'options', 'question', 'recommend'];
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
export function escalationWords(c) {
  if (!Array.isArray(c.options) || !c.options.every((o) => o && typeof o === 'object')) return null;
  const taken = new Set();
  const choices = c.options.map((o) => slug(o.label, taken));
  const labels = Object.fromEntries(choices.map((id, i) => [id, c.options[i].label.trim()]));
  const then = Object.fromEntries(choices.map((id, i) => [id, String(c.options[i].then).trim()]));
  const pick = c.recommend && typeof c.recommend === 'object' ? choices.find((id) => labels[id] === String(c.recommend.label ?? '').trim()) : null;
  return { choices, plain: String(c.question).trim(), labels, then, ...(pick ? { recommend: { choice: pick, why: String(c.recommend.why ?? '').trim() || null } } : {}) };
}

// Schema check of the strategist's closure; returns the problems (empty when it is valid).
export function closureProblems(c, { rounds = 0, nowMs = Date.now(), plainEscalation = false } = {}) {
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
    if (c.recommend !== undefined && (!c.recommend || typeof c.recommend !== 'object' || !c.options?.some?.((o) => o?.label?.trim() === String(c.recommend.label ?? '').trim()))) p.push('`recommend`, when given, is { "label": "<one of the option labels>", "why": "<one line>" }');
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
  const problems = closureProblems(closure, { rounds: computeRounds(state), plainEscalation });
  if (problems.length) throw new WfError(`the strategist closure is invalid:\n  - ${problems.join('\n  - ')}`, { hint: 'the bundle\'s `closureSchema` shows the shape' });
  if (['done', 'abandoned'].includes(state.phase)) throw refuse(`${state.id} is ${state.phase}`, null, { id: 'strategy:closed' });
  const h = state.handoffs.filter((x) => x.role === 'strategist' && x.agent === closure.strategist).at(-1);
  if (!h) throw refuse(`\`${closure.strategist}\` was not handed this attempt as its strategist${state.roles.strategist.length ? ` (strategists: ${state.roles.strategist.join(', ')})` : ''}`, `run \`wf handoff strategist --agent <id>\` and start that agent with the printed line`, { id: 'strategy:no-strategist' });
  if (state.strategy.decisions.some((d) => d.handoff === h.bundle)) throw refuse(`${closure.strategist} already recorded its decision (${state.strategy.decisions.find((d) => d.handoff === h.bundle).id}); a new decision needs a fresh strategist handoff`, null, { id: 'strategy:handoff-used' });
  const nowMs = Date.now();
  if (closure.action === 'model') {
    const classes = Object.keys(adapterOf(root, state)?.classes ?? {});
    if (!classes.includes(closure.model.class)) throw refuse(`\`${closure.model.class}\` is not a work class of this project (classes: ${classes.join(', ')})`, null, { id: 'strategy:unknown-class' });
  }
  const pending = openEscalation(state);
  if (pending) throw refuse(`the strategist escalated ${state.id} (${pending.id}) and the owner has not decided; no further decision is recorded until then`, approveHint(state, pending), { id: 'strategy:escalation-pending' });
  const signals = computeSignals(root, state, { cfg: adapterOf(root, state), nowMs });
  // The strategist's own rule, about its own predictions: two missed in a row and its next decision asks the owner.
  if (missedStreak(state, signals, nowMs) >= 2 && closure.action !== 'escalate') throw refuse(`${state.id}: the last two strategist predictions were missed, so the next decision is answered only by \`escalate\` (to the owner), not \`${closure.action}\``, 'write a closure with action escalate and 2 or 3 options for the owner', { id: 'strategy:escalate-required' });
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
    const words = escalationWords(closure);
    escalation = createDecision(root, fresh, { kind: 'escalation', key: `strategy:${id}`, summary: closure.rationale.trim().split('\n')[0].slice(0, 300), choices: words?.choices ?? closure.options, ...(words ? { plain: words.plain, labels: words.labels, then: words.then, recommend: words.recommend ?? null } : {}), options });
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
    signals: { rounds: signals.rounds.map((r) => ({ n: r.n, blocking: r.blocking, findings: r.findings })), roundsSinceDecrease: signals.roundsSinceDecrease, blockingOpen: signals.blockingOpen, observationsOpen: signals.observationsOpen.length, amendments: signals.amendments, changedFiles: signals.files.changed, plannedFiles: signals.files.planned, bundleBytes: signals.bundle.bytes, wallMinutes: signals.wallMinutes},
  }, actor(options));
  return { state: loadState(root, state.id), decision: loadState(root, state.id).strategy.decisions.at(-1), split: splitResult, escalation };
}

const computeRounds = (state) => new Set((state.reviews ?? []).map((r) => r.handoff ?? `reviewer:${r.reviewer}`)).size;
