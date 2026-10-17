// What an attempt is doing, read from the ledger, the git tree and the roles' activity (0.7.0), shown beside what the
// roles said they expected (engine/expectations.mjs). Which harness runs the agents is an execution detail: no signal
// reads a harness's usage or budget.
//
// Named failures: nothing showed rounds, scope growth, wall time or a quiet session while one ticket ran 47 review rounds
// (blocking findings flat for 18 of them), grew 131 amendments over 13 criteria and reviewers were handed bundles of
// 20 MB; a review round sat open for 745 minutes after its session died. The first answer judged these against numbers the
// engine picked; this module only measures and shows the plan, an implementer or a reviewer against what happened, and the
// owner agent judges the course (the owner skill). Nothing here allows or blocks a command.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { changedFiles, treeHashes } from './attempt.mjs';
import { familyRecurrenceLine, familyRecurrences, recurrenceLine, recurringCauses } from './causes.mjs';
import { ownerTranscript } from './host-record.mjs';
import { home as hostHome } from './provenance.mjs';
import { blockingOpen, blockingSeries, earlierBlocking, observations, placementLevel, unreachedOf } from './review-policy.mjs';
import { expectOf, readStatement } from './expectations.mjs';
import { planPaths, scopeFiles, scopeNoise } from './scope.mjs';
import { findHost, optional, ownerString } from './hosts/index.mjs';
import { canonical } from './util.mjs';
import { readLedger } from './ledger.mjs';

export const SIGNALS_SCHEMA = 'agentic-workflow/signals@1';

// One entry per review round that has a recorded closure (a round recorded twice, blind and then with its prior-finding
// verdicts, counts once, at its latest record), in the order the rounds were first recorded.
export function recordedRounds(state) {
  const by = new Map();
  for (const r of state.reviews ?? []) by.set(r.handoff ?? `reviewer:${r.reviewer}`, r);
  return [...by.values()];
}

// Every review round handed, recorded or not (a review group counts once): what the person's escalation counts.
// Named failure (final review of 0.7.0): ten reviewers handed and never recorded (dead sessions, a tree moved under them)
// showed "recorded rounds: 0" and the escalation never fired; one ticket had 21 of its 47 rounds without a closure.
export function handedRounds(state) {
  return new Set((state.handoffs ?? []).filter((h) => h.role === 'reviewer').map((h) => h.reviewGroup?.id ?? h.bundle)).size;
}

const round1 = (n) => Math.round(n * 10) / 10;
const idOf = (bundle) => (bundle ? path.basename(String(bundle), '.json') : null);

// Findings of a round as the review policy classifies them now: total, blocking and observations.
function roundCounts(state, r, home = null) {
  const view = { ...state, review: { closure: r.closure } };
  const findings = r.closure?.findings ?? [];
  const blocking = blockingOpen(view);
  const observed = observations(view);
  const families = {};
  for (const f of [...blocking, ...observed]) families[f.family ?? '(none)'] = (families[f.family ?? '(none)'] ?? 0) + 1;
  // The round's wall time (handed to recorded) beside what its reviewer expected, from its closure.
  const handed = (state.handoffs ?? []).find((h) => h.bundle === r.handoff);
  const spent = handed && r.at ? (Date.parse(r.at) - Date.parse(handed.at)) / 60000 : NaN;
  const scope = typeof r.closure?.scope === 'string' && r.closure.scope.trim() ? r.closure.scope.trim().slice(0, 600) : null;
  // Named failure (I-69): `notReached` was written by every reviewer and read by nothing, so a round that stopped early
  // looked like one that finished. Shown beside `scope`; such a round does not count as the full audit (review-policy.mjs).
  const notReached = unreachedOf(r.closure).map((x) => x.slice(0, 300)).slice(0, 20);
  return { n: 0, handoff: idOf(r.handoff), reviewer: r.reviewer ?? null, at: r.at ?? null, findings: findings.length, blocking: blocking.length, observations: observed.length, families, minutes: Number.isFinite(spent) ? round1(spent) : null, activeUntilMinute: activeUntil(handed, home, Date.parse(r.at) || Date.now()), expectMinutes: expectOf(r.closure?.expect)?.minutes ?? null, scope, notReached };
}

// The round-derived numbers, from the list of rounds alone (so a prediction about "round N" is judged on the rounds up to N).
// `blocking` of a round is what that round raised itself, so `blockingLatest` and `roundsSinceDecrease` count new findings:
// recorded rounds since the new blocking findings last went down (the first round is the baseline); 0 once the latest round
// raised none. What earlier rounds raised and nothing has verified fixed is `open` (`blockingOpen`), never read from these (I-185).
export function roundMetrics(rounds) {
  const n = rounds.length;
  let lastDecrease = 0;
  for (let i = 1; i < n; i++) if (rounds[i].blocking < rounds[i - 1].blocking) lastDecrease = i;
  const latest = rounds.at(-1) ?? null;
  return { rounds: n, blockingLatest: latest?.blocking ?? 0, findingsLatest: latest?.findings ?? 0, roundsSinceDecrease: latest && latest.blocking > 0 ? n - 1 - lastDecrease : 0 };
}

export function filesSignal(state, cfg) {
  const perRepo = {};
  let changed = 0;
  for (const name of Object.keys(state.repos ?? {})) {
    let files = [];
    try {
      files = changedFiles(state, name).filter((f) => !cfg || !scopeNoise(cfg, name, f));
    } catch {}
    perRepo[name] = files.length;
    changed += files.length;
  }
  // The files the frozen plan names (anchors and tests); null when it names none, so there is nothing to compare with.
  const planned = state.plan ? planPaths(state.plan, scopeFiles(state)).length : 0;
  return { changed, planned: planned || null, perRepo };
}

function bundleSignal(state) {
  const h = state.handoffs.filter((x) => x.role === 'reviewer').at(-1);
  if (!h?.bundle) return { bytes: null, handoff: null, agent: null };
  let bytes = null;
  try {
    bytes = fs.statSync(h.bundle).size;
  } catch {}
  return { bytes, handoff: idOf(h.bundle), agent: h.agent };
}

// ---- Role sessions ----

// Where an agent's transcript is and when it was last written: the session file of a role with a session id, or what the
// harness adapter finds for a role that has none (a harness may record a sub-agent file under the name the owner started it
// with). mtime is enough: every turn appends to the file.
function activityOf(h, home) {
  try {
    if (h.session) {
      const t = ownerTranscript(ownerString(h.runtime, h.session), home);
      if (t.file) return { file: t.file, mtime: fs.statSync(t.file).mtimeMs };
    }
    return optional(findHost(h.runtime), 'roleActivity')?.(h, { home }) ?? null;
  } catch {}
  return null;
}

// Where a working role's time goes, from its transcript's shell commands: the one running now and the long ones (5 minutes
// or more each) it has run, with their total. Facts for the owner's judgement of what a role is doing, never a limit. Named
// failure (0.7.14): an implementer 266 minutes in had spent 201 of them in sleep loops waiting for its own background end-to-end
// runs, and the owner read "active within the last minute" as progress.
const LONG_RUN_MINUTES = 5;
function shellOf(h, file, nowMs) {
  try {
    const got = optional(findHost(h.runtime), 'shellRuns')?.(file);
    if (!got) return null;
    const long = got.runs.filter((r) => r.minutes >= LONG_RUN_MINUTES).sort((a, b) => b.minutes - a.minutes);
    const running = got.running ? { command: got.running.command.slice(0, 200), minutes: round1(Math.max(0, (nowMs - Date.parse(got.running.startedAt)) / 60000)) } : null;
    return { running, longRuns: long.length, longMinutes: round1(long.reduce((n, r) => n + r.minutes, 0)), longest: long.slice(0, 2).map((r) => ({ command: r.command.slice(0, 200), minutes: round1(r.minutes) })) };
  } catch {
    return null;
  }
}

// What a running role has said so far, from the file it writes early and completes at the end: an implementer's report,
// a reviewer's closure. Null when it has stated nothing (yet).
const statedBy = (h) => (h.role === 'implementer' ? readStatement(h.reportFile, 'approach') : h.role === 'reviewer' ? readStatement(h.closureFile, 'scope') : null);

// Role sessions that are working now: an engine-launched session whose launch has not finished, the latest reviewer round
// when it has neither a closure nor a refusal (the round the owner is waiting for), an implementer the owner has not closed
// and a strategist that has recorded no decision. Each with the time since it was handed, its last transcript activity and
// what it said it expects (its own words, never a limit).
// The machine's last sleep, when the host says (macOS: the kernel's last sleep and wake times), so time a role spent with the
// machine asleep is not read as the role going quiet. Named failure (audit of role launches): a reviewer 94 minutes into its
// work was stopped as stalled 11 seconds after the machine woke from a 68-minute sleep; "68 minutes since its last event"
// was the sleep. A seam for scenarios.
export const sleepSeams = { last: lastMachineSleep };
let sleepCache;
function lastMachineSleep() {
  if (sleepCache !== undefined) return sleepCache;
  sleepCache = null;
  if (process.platform !== 'darwin') return sleepCache;
  const r = spawnSync('sysctl', ['-n', 'kern.sleeptime', 'kern.waketime'], { encoding: 'utf8' });
  const secs = [...String(r.stdout ?? '').matchAll(/sec = (\d+)/g)].map((m) => Number(m[1]) * 1000);
  if (secs.length === 2 && secs[0] > 0 && secs[1] >= secs[0]) sleepCache = { sleptAt: secs[0], wokeAt: secs[1] };
  return sleepCache;
}
// Minutes of the stretch since `lastAt` the machine was asleep, and how long ago it woke; null when it did not sleep since.
export function asleepSince(lastAt, nowMs) {
  const s = sleepSeams.last();
  if (!s || !lastAt || s.wokeAt <= lastAt || s.wokeAt > nowMs) return null;
  return { asleepMinutes: round1((s.wokeAt - Math.max(s.sleptAt, lastAt)) / 60000), wokeMinutesAgo: round1((nowMs - s.wokeAt) / 60000) };
}

export function runningSessions(state, nowMs, home) {
  const lastReviewer = state.handoffs.filter((h) => h.role === 'reviewer').at(-1);
  const ended = (h) => (state.reviews ?? []).some((r) => r.handoff === h.bundle) || (state.reviewsRefused ?? []).some((r) => r.handoff === h.bundle);
  const lastOf = (role, agent) => state.handoffs.filter((x) => x.role === role && x.agent === agent).at(-1);
  const openImplementers = new Set((state.implementers ?? []).filter((x) => !x.closedAt).map((x) => lastOf('implementer', x.agent)?.bundle));
  const decidedAt = state.strategy.decisions.at(-1)?.at ?? null;
  let tree = null;
  const out = [];
  for (const h of state.handoffs) {
    const launched = ['starting', 'running'].includes(h.launch?.status);
    let waitedFor = false;
    if (!launched && h === lastReviewer && !h.launch && !h.reviewGroup && !ended(h)) {
      try {
        tree ??= canonical(treeHashes(state));
        waitedFor = !h.tree || canonical(h.tree) === tree;
      } catch {}
    }
    const open = h.role === 'implementer' && openImplementers.has(h.bundle);
    // A strategist handed before the last recorded decision is superseded by it (engine/strategy.mjs strategistWaiting).
    const deciding = h.role === 'strategist' && h.launch?.status !== 'failed' && !state.strategy.decisions.some((d) => d.handoff === h.bundle) && !(decidedAt && h.at && h.at <= decidedAt);
    if (!launched && !waitedFor && !open && !deciding) continue;
    const seen = activityOf(h, home);
    const shell = seen?.file ? shellOf(h, seen.file, nowMs) : null;
    const since = Math.max(Date.parse(h.at) || 0, Date.parse(h.launch?.startedAt) || 0);
    const lastAt = seen ? Math.max(seen.mtime, since) : null;
    const said = statedBy(h);
    // I-137: a launch that finished (an implementer the owner has not closed yet) is observed execution up to its end and then
    // time the owner has not acted; the two are never one number. `minutes` is the first for it, `waitingMinutes` the second.
    const endedAt = ['completed', 'failed'].includes(h.launch?.status) ? Date.parse(h.launch.finishedAt) || null : null;
    out.push({ agent: h.agent, role: h.role, work: h.work ?? null, runtime: h.runtime, handoff: idOf(h.bundle), handedAt: h.at, launch: h.launch?.status ?? null, located: Boolean(seen), lastActivityAt: lastAt ? new Date(lastAt).toISOString() : null, idleMinutes: lastAt ? Math.max(0, round1((nowMs - lastAt) / 60000)) : null, minutes: since ? Math.max(0, round1(((endedAt ?? nowMs) - since) / 60000)) : null, ...(endedAt ? { finished: h.launch.status, finishedAt: h.launch.finishedAt, waitingMinutes: Math.max(0, round1((nowMs - endedAt) / 60000)) } : {}), expectMinutes: said?.minutes ?? null, said: said?.said ?? null , ...(shell ? { shell } : {}), ...(asleepSince(lastAt, nowMs) ?? {}) });
  }
  return out;
}

// The implementers of the attempt, finished and open: time from handed to closed (or to now) beside what each expected.
// The minute (since it was handed) a finished role was last active in its transcript, when the transcript is found: wall
// minutes include nights and waits, so "took 300 min" beside "last active at minute 42" says the work was 42 minutes.
// Named failure (final review of 0.7.0): elapsed minutes counted idle time, so an owner agent reading an overnight round
// would misjudge it.
function activeUntil(h, home, end) {
  if (!h || !home) return null;
  const seen = activityOf(h, home);
  const from = Date.parse(h.at);
  if (!seen || !Number.isFinite(from)) return null;
  return Math.max(0, round1((Math.min(seen.mtime, end) - from) / 60000));
}

function implementersSignal(state, nowMs, sessions, home) {
  return (state.implementers ?? []).map((x) => {
    const report = [...(state.implementerReports ?? [])].reverse().find((r) => r.agent === x.agent && r.handoff === x.handoff);
    const running = x.closedAt ? null : sessions.find((s) => s.role === 'implementer' && s.agent === x.agent);
    const end = Date.parse(x.closedAt ?? '') || nowMs;
    const spent = (end - Date.parse(x.openedAt)) / 60000;
    const h = x.closedAt ? (state.handoffs ?? []).find((y) => y.role === 'implementer' && idOf(y.bundle) === x.handoff) : null;
    return { agent: x.agent, work: x.work, handoff: x.handoff, open: !x.closedAt, outcome: x.outcome ?? null, minutes: Number.isFinite(spent) ? round1(spent) : null, activeUntilMinute: activeUntil(h, home, end), expectMinutes: report?.expect?.minutes ?? running?.expectMinutes ?? null, approach: report?.approach ?? running?.said ?? null };
  });
}

// The longest stretch with no ledger entry since admission (to now): how much of the wall time nobody worked on the attempt.
function longestQuiet(root, state, nowMs) {
  try {
    const times = readLedger(root, state.id).map((e) => Date.parse(e.at)).filter(Number.isFinite).sort((a, b) => a - b);
    let gap = 0;
    for (let i = 1; i <= times.length; i += 1) gap = Math.max(gap, (i < times.length ? times[i] : nowMs) - times[i - 1]);
    return times.length ? round1(gap / 60000) : null;
  } catch {
    return null;
  }
}

// ---- The signals ----

// Everything `wf signals` shows: the numbers, and the plan's expectation beside them. `cfg` is the attempt's adapter at
// base (scope noise, nothing else); `home` the host home the engine already reads transcripts from (WF_HOME in tests).
export function computeSignals(root, state, { nowMs = Date.now(), cfg = null, home = hostHome() } = {}) {
  const finals = recordedRounds(state);
  // `blocking` is what a round raised itself; `open` how many of the blocking findings of the rounds up to it are open now (today's waivers apply), the ones earlier rounds raised
  // included (0.7.27, I-185: a round that raises nothing new has not cleared what earlier rounds raised).
  const openAfter = blockingSeries(state);
  const rounds = finals.map((r, i) => ({ ...roundCounts(state, r, home), n: i + 1, open: openAfter[i] }));
  const metrics = roundMetrics(rounds);
  const blocking = (state.reviews ?? []).length ? earlierBlocking(state, null) : [];
  const latest = finals.at(-1);
  const latestReviewer = latest?.closure?.reviewer ?? latest?.reviewer ?? null;
  const observed = state.review ? observations(state) : [];
  const ref = (f) => ({ ref: f.ref ?? `${state.review?.closure?.reviewer ?? '?'}:${f.id}`, severity: f.severity ?? null, placement: placementLevel(state, f), summary: f.summary ?? '', family: f.family ?? null, work: f.work ?? null });
  const blockRef = (f) => ({ ...ref(f), carried: f.round !== latestReviewer });
  const sessions = runningSessions(state, nowMs, home);
  return {
    schema: SIGNALS_SCHEMA,
    attempt: state.id,
    item: state.item,
    at: new Date(nowMs).toISOString(),
    admittedAt: state.admittedAt,
    engineVersion: state.engineVersion,
    // Up to its delivery or close for an attempt that ended (audit of one project: a delivered attempt read 1,818 minutes,
    // counted to the moment `wf signals` ran).
    wallMinutes: state.admittedAt ? round1(((Date.parse(state.delivery?.completedAt ?? state.closedAt ?? state.abandoned?.at ?? '') || nowMs) - Date.parse(state.admittedAt)) / 60000) : null,
    // The plan's own prediction ({ files, rounds, minutes }; a re-plan's replaces it), null when it states none.
    expect: state.expect ?? null,
    // The first prediction, kept beside a re-plan's (final review of 0.7.0: a re-plan replaced the baseline it is judged by).
    firstExpect: state.expectations?.[0]?.expect ?? null,
    // The expectation the plan itself stated, if it stated one (a re-plan's never stands for the whole attempt).
    planExpect: (state.expectations ?? []).find((x) => x.source === 'plan')?.expect ?? null,
    rounds,
    roundsRecorded: metrics.rounds,
    roundsHanded: handedRounds(state),
    blockingLatest: metrics.blockingLatest,
    findingsLatest: metrics.findingsLatest,
    roundsSinceDecrease: metrics.roundsSinceDecrease,
    // Every blocking finding open across the rounds (what the gate and the acceptance wait for), and how many of them an
    // earlier round raised. `blockingLatest` is only what the latest round raised.
    blockingOpen: blocking.length,
    blockingCarried: blocking.filter((f) => f.round !== latestReviewer).length,
    observationsOpen: observed.map(ref),
    blockingFindings: blocking.map(blockRef),
    // 0.7.27 (I-191): a finding still open that shares its cause with one already marked fixed (the reviewer's `sameCauseAs`).
    recurringCauses: recurringCauses(state),
    // A finding still open with the family of one already marked fixed, no cause confirmed: a possible recurrence.
    familyRecurrences: familyRecurrences(state),
    criteria: { atFreeze: state.criteriaAtFreeze, now: (state.criteria ?? []).length },
    amendments: (state.criteriaAmendments ?? []).length,
    discoveredFamilies: (state.discovered ?? []).filter((d) => d.status === 'open' && d.family).reduce((n, d) => ({ ...n, [d.family]: (n[d.family] ?? 0) + 1 }), {}),
    // How much the criteria moved, not only how many there are (lessons of one attempt: the count went from 22 to 27 while
    // 163 criterion texts were rewritten over 138 amendments, and nothing the owner read showed it).
    churn: (state.criteriaAmendments ?? []).reduce((n, a) => ({ changed: n.changed + (a.changes?.changed?.length ?? 0), added: n.added + (a.changes?.added?.length ?? 0), dropped: n.dropped + (a.changes?.dropped?.length ?? 0) }), { changed: 0, added: 0, dropped: 0 }),
    // A re-plan's expectation is measured from the re-plan: a small repair's 65 minutes was compared with five days.
    replan: (() => {
      const last = (state.expectations ?? []).at(-1);
      if (last?.source !== 'amendment') return null;
      const end = Date.parse(state.delivery?.completedAt ?? state.closedAt ?? state.abandoned?.at ?? '') || nowMs;
      return { at: last.at, amendment: last.amendment, minutes: round1(Math.max(0, (end - Date.parse(last.at)) / 60000)), rounds: (state.reviews ?? []).filter((r) => r.at > last.at).length };
    })(),
    files: filesSignal(state, cfg),
    bundle: bundleSignal(state),
    implementers: implementersSignal(state, nowMs, sessions, home),
    longestQuietMinutes: longestQuiet(root, state, nowMs),
    sessions,
  };
}

// ---- Plan against actual ----

// What is past the estimate its own role stated, one phrase each (empty when nothing is): `wf resume` puts it on the
// `next:` line the owner agent acts on, as a prompt to judge the course, never as a refusal (D9).
export function pastEstimates(sig) {
  const e = sig.expect ?? {};
  const out = [];
  // After a re-plan, its rounds and minutes are counted from it; files stay the whole attempt's, against the first plan's.
  const r = sig.replan ?? null;
  // After a re-plan, files are the whole attempt's and amendments record no tree to count them from: the course lines show
  // them against the first plan, and the prompt to judge the course does not repeat that every turn (independent review of
  // 0.7.15: right after a re-plan the prompt still asked for one).
  if (!r && typeof e.files === 'number' && sig.files.changed > e.files) out.push(`files changed ${sig.files.changed} (the plan expected ${e.files})`);
  const rounds = r ? r.rounds : Math.max(sig.rounds.length, sig.roundsHanded ?? 0);
  if (typeof e.rounds === 'number' && rounds > e.rounds) out.push(`review rounds ${rounds}${r ? ' since the re-plan' : ''} (${r ? 'it' : 'the plan'} expected ${e.rounds})`);
  const minutes = r ? r.minutes : sig.wallMinutes;
  if (r && typeof e.minutes === 'number' && minutes > e.minutes) out.push(`${Math.round(minutes)} minutes since the re-plan (it expected ${e.minutes})`);
  else if (!r && typeof e.minutes === 'number' && sig.wallMinutes !== null && sig.wallMinutes > e.minutes) out.push(`${Math.round(sig.wallMinutes)} minutes (the plan expected ${e.minutes}${typeof sig.longestQuietMinutes === 'number' && sig.longestQuietMinutes >= 1 ? `; ${Math.round(sig.longestQuietMinutes)} of them in one stretch with nothing recorded` : ''})`);
  for (const s of sig.sessions ?? []) if (s.expectMinutes && s.minutes > s.expectMinutes) out.push(`${s.role} ${s.agent} ${s.finished ? 'ran' : 'working'} ${Math.round(s.minutes)} min (it expected ${s.expectMinutes})`);
  return out;
}

const mins = (n) => (n === null || n === undefined ? 'n/a' : `${Math.round(n)} min`);
const lastActive = (x) => (typeof x.activeUntilMinute === 'number' && typeof x.minutes === 'number' && x.minutes - x.activeUntilMinute >= 1 ? ` (last active at minute ${Math.round(x.activeUntilMinute)})` : '');
const ago = (n) => (n === null || n === undefined ? 'unknown' : n < 1 ? 'under a minute ago' : `${Math.round(n)} min ago`);

// The comparison the owner agent judges at each round boundary: what the plan, an implementer or a reviewer said it expected,
// beside what is. No threshold, no verdict: "expected" and "actual" side by side, or "states none". `predictions` are the
// strategist's decisions with whether each prediction held. The latest three finished implementers and rounds are listed
// (`wf signals --json` has every one).
// A command as the owner reads it: leading variable assignments and temporary paths dropped, so `S=/tmp/x; for ...; sleep 10`
// reads as the loop it is.
const oneLine = (c) => String(c).replace(/\s+/g, ' ').replace(/^(\s*[A-Za-z_][A-Za-z0-9_]*=\S*\s*;?\s*)+/, '').replace(/(\/private)?\/(tmp|var\/folders)\/\S*/g, '…').slice(0, 120);
const shellText = (x) => !x ? '' : `${x.running ? `; running now: \`${oneLine(x.running.command)}\` for ${mins(x.running.minutes)}` : ''}${x.longRuns ? `; ${mins(x.longMinutes)} of its time in ${x.longRuns} shell command(s) of ${LONG_RUN_MINUTES} min or more (longest: \`${oneLine(x.longest[0].command)}\`, ${mins(x.longest[0].minutes)}): judge whether those runs add anything the gate will not` : ''}`;

export function courseLines(sig, { predictions = [], shell = true } = {}) {
  const e = sig.expect ?? {};
  const first = sig.firstExpect ?? null;
  // "past its own estimate" marks an actual beyond the number its own role stated: information for the owner agent's
  // judgement, never a limit (D9).
  const past = (actual, expected) => (typeof actual === 'number' && typeof expected === 'number' && actual > expected ? ' (past its own estimate)' : '');
  const line = (what, actual, expected, unit = '', key = null) => `${what}: ${actual}${unit}; the plan ${expected === undefined ? 'states no expectation' : `expected ${expected}${unit}${past(actual, expected)}${key && first && first[key] !== undefined && first[key] !== expected ? ` (first predicted ${first[key]}${unit})` : ''}`}`;
  // After a re-plan the whole attempt is set against the first plan, and the re-plan against what happened since it.
  const total = sig.replan ? sig.planExpect ?? {} : e;
  const out = [
    line('files changed', sig.files.changed, total.files, '', sig.replan ? null : 'files'),
    `${line('review rounds recorded', sig.rounds.length, total.rounds, '', sig.replan ? null : 'rounds')}${sig.roundsHanded !== undefined && sig.roundsHanded > sig.rounds.length ? `; ${sig.roundsHanded} handed (${sig.roundsHanded - sig.rounds.length} never recorded)` : ''}`,
    `${line('minutes since admission', sig.wallMinutes === null ? 'n/a' : Math.round(sig.wallMinutes), total.minutes, '', sig.replan ? null : 'minutes')}${typeof sig.longestQuietMinutes === 'number' && sig.longestQuietMinutes >= 1 ? `; the longest stretch with nothing recorded was ${Math.round(sig.longestQuietMinutes)} min` : ''}`,
  ];
  if (sig.replan) out.push(`since the re-plan (amendment ${sig.replan.amendment}): ${Math.round(sig.replan.minutes)} minutes and ${sig.replan.rounds} review round(s); it expected ${e.minutes ?? 'n/a'} minutes and ${e.rounds ?? 'n/a'} round(s)${past(sig.replan.minutes, e.minutes) || past(sig.replan.rounds, e.rounds)}`);
  for (const r of sig.recurringCauses ?? []) out.push(recurrenceLine(r));
  for (const r of sig.familyRecurrences ?? []) out.push(familyRecurrenceLine(r));
  // A pattern found one place at a time is a class to fix in one sweep (lessons of one attempt: about 35 of 67 discovered
  // issues were callers needing the same new guard, each found and recorded separately).
  // 0.7.27 (I-185): findings an earlier round raised and no round has verified fixed are not shown as zero because the latest
  // round raised none of its own.
  if (sig.blockingCarried) out.push(`blocking findings open: ${sig.blockingOpen}, ${sig.blockingOpen - sig.blockingCarried ? `${sig.blockingOpen - sig.blockingCarried} raised by the latest round` : 'none raised by the latest round'}; carried from earlier rounds and not yet verified fixed: ${sig.blockingFindings.filter((f) => f.carried).map((f) => f.ref).join(', ')}`);
  for (const [family, n] of Object.entries(sig.discoveredFamilies ?? {})) if (n >= 2) out.push(`discovered issues of family ${family}: ${n} open; fix the class in one sweep (find every place it occurs) rather than one at a time`);
  if (sig.amendments) out.push(`plan amendments: ${sig.amendments} (${sig.churn?.changed ?? 0} criterion text(s) rewritten, ${sig.churn?.added ?? 0} added, ${sig.churn?.dropped ?? 0} dropped)`);
  for (const x of sig.implementers.filter((i) => !i.open).slice(-3)) out.push(`implementer ${x.agent}${x.work ? ` (${x.work})` : ''} ${x.outcome ?? 'closed'}: took ${mins(x.minutes)}${lastActive(x)}; it ${x.expectMinutes ? `expected ${x.expectMinutes} min${past(x.minutes, x.expectMinutes)}` : 'stated no expectation'}${x.approach ? `; approach: ${x.approach.slice(0, 200)}` : ''}`);
  for (const r of sig.rounds.slice(-3)) out.push(`review round ${r.n} (${r.reviewer ?? r.handoff}): took ${mins(r.minutes)}${lastActive(r)}; it ${r.expectMinutes ? `expected ${r.expectMinutes} min${past(r.minutes, r.expectMinutes)}` : 'stated no expectation'}${r.scope ? `; scope: ${r.scope.slice(0, 200)}` : ''}${r.notReached?.length ? `; did not reach: ${r.notReached.slice(0, 5).map((x) => x.slice(0, 150)).join('; ')}${r.notReached.length > 5 ? ` and ${r.notReached.length - 5} more` : ''}` : ''}`);
  for (const s of sig.sessions) out.push(s.finished
    ? `${s.role} ${s.agent}${s.work ? ` (${s.work})` : ''} ${s.finished === 'completed' ? 'finished' : 'ended (failed)'} after ${mins(s.minutes)} of observed execution, ${s.expectMinutes ? `it expected ${s.expectMinutes} min${past(s.minutes, s.expectMinutes)}` : 'it stated no expectation'}; ${mins(s.waitingMinutes)} since then it has waited for the owner to close it, which is waiting and not work (\`wf handoff close --agent ${s.agent}\`)${s.said ? `; approach: ${s.said.slice(0, 200)}` : ''}`
    : `${s.role} ${s.agent}${s.work ? ` (${s.work})` : ''} is working: ${mins(s.minutes)} since handed, ${s.expectMinutes ? `it expects ${s.expectMinutes} min${past(s.minutes, s.expectMinutes)}` : 'it stated no expectation'}; last activity ${s.located ? ago(s.idleMinutes) : 'unknown (transcript not found)'}${typeof s.asleepMinutes === 'number' && s.asleepMinutes >= 1 ? ` (${Math.round(s.asleepMinutes)} min of that with the machine asleep; it woke ${ago(s.wokeMinutesAgo)}: not a stall)` : ''}${shell ? shellText(s.shell) : ''}${s.said ? `; ${s.role === 'reviewer' ? 'scope' : 'approach'}: ${s.said.slice(0, 200)}` : ''}`);
  for (const d of predictions) out.push(`strategist ${d.id} (${d.action}) predicted ${d.prediction ? `${d.prediction.signal} by ${typeof d.prediction.by === 'number' ? `round ${d.prediction.by}` : d.prediction.by}` : 'nothing'}: ${d.prediction_status.status}${d.prediction_status.observed !== null && d.prediction_status.observed !== undefined ? ` (observed ${d.prediction_status.observed})` : ''}`);
  return out;
}
