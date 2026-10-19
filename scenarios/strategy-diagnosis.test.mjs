import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { closureFile, commitIn, goodClosure, ok, wf } from './helpers.mjs';
import { append, loadState } from '../engine/ledger.mjs';
import { inProcess, project, started, strategistClosure } from './strategist-fixtures.mjs';

// 0.7.34 (I-232), named failure (field): one attempt ran 23 review rounds. Five evidence reviews in a row asked again for
// screen-recording proof the local simulator cannot make, each under fresh finding ids; then each wording fix caused the next
// finding, four in a row under four family labels; then base merges and toolchain drift opened rounds of their own. Its two
// strategist decisions carried an action, a rationale and a prediction; the second said "no recurring causes are recorded" and that
// the base would be taken in once (it was merged twice more). Nothing asked what kept going wrong, what changes in how the work runs,
// or whether the last change was made and held. The person: "the strategist should also look at what went wrong and correct course
// so we don't go into infinite loop".
//
// I-234, named failure (field): between the round count at 10 and the person's hold at 20, eleven rounds were handed with no
// strategist decision while the fix chain was visible: the course signals named the strategist as the next step and held nothing.

const LONG = { files: 50, rounds: 40, minutes: 600 };
let n = 0;

// One recorded code-review round: commit, hand a fresh reviewer, record a closure with these findings.
function round(ctx, a, agent, findings = [], extra = {}) {
  commitIn(a.wt, { 'src/a.txt': `round ${agent} ${++n}\n` });
  const handed = wf(ctx.root, ['handoff', 'reviewer', '--agent', agent, '--attempt', a.id, '--owner', a.owner]);
  if (handed.code !== 0) return handed;
  const bundleFile = handed.out.match(/^Read (\S+)/m)?.[1];
  const bundle = bundleFile ? JSON.parse(fs.readFileSync(bundleFile, 'utf8')) : {};
  const prior = (bundle.openFindings ?? []).map((f) => ({ round: f.round, id: f.id, status: 'open', evidence: 'still at src/a.txt:1' }));
  ok(wf(ctx.root, ['review', '--closure', closureFile(ctx.base, goodClosure(agent, { findings, criteria: [{ id: 'C1', evidence: { kind: 'output', ref: 'log line 1' } }, { id: 'C2', evidence: { kind: 'output', ref: 'log line 1' } }], ...(prior.length ? { priorFindings: prior } : {}), ...extra })), '--attempt', a.id]));
  return { ...handed, bundle };
}
const proof = (id, tag) => ({ id, severity: 'major', summary: `the recording proof is missing (${tag})`, status: 'open', evidence: 'src/a.txt:1', family: 'device-proof', criterion: 'C1' });
const strategist = (ctx, a, agent, reason = 'the rounds keep asking for the same proof') => ok(wf(ctx.root, ['handoff', 'strategist', '--agent', agent, '--attempt', a.id, '--reason', reason, '--json'])).json();
const record = (ctx, a, file) => wf(ctx.root, ['strategy', 'record', '--closure', file, '--attempt', a.id]);
const base = (agent, extra = {}) => ({ strategist: agent, action: 'continue', rationale: 'The rounds re-ask for proof this environment cannot make.', prediction: { signal: 'blockingLatest <= 0', by: 9 }, ...extra });

test('the strategist diagnoses what kept going wrong, cites what exists, accounts for every round, and corrects the flow; its correction reaches the roles', () => {
  const ctx = project('diagnosis');
  const a = started({ run: (r, args) => wf(r, args) }, ctx, { item: 'ENG-900', expect: LONG });
  round(ctx, a, 'rev-1', [proof('F1', 'first')]);
  round(ctx, a, 'rev-2', [proof('F1', 'second')]);
  const h = strategist(ctx, a, 'strat-1');
  const bundle = JSON.parse(fs.readFileSync(h.bundle, 'utf8'));
  // What it cites, verbatim, and what it accounts for.
  assert.deepEqual(bundle.roundsToAccount.map((r) => r.round), ['rev-1', 'rev-2']);
  assert.deepEqual(bundle.history.findings.map((f) => f.ref), ['rev-1:F1', 'rev-2:F1']);
  assert.ok(bundle.closureSchema.diagnosis && bundle.closureSchema.causes.capability && bundle.closureSchema.levers.routing);
  assert.match(bundle.instructions, /step back: say what kept going wrong/);
  // No diagnosis: refused (an earlier engine recorded this closure).
  const none = record(ctx, a, strategistClosure(ctx.base, h.bundle, { ...base('strat-1'), diagnosis: null }).file);
  assert.equal(none.code, 75, none.err);
  assert.match(none.err, /`diagnosis` is required/);
  // A ref that does not exist is named with the nearest one that does; a round left out of the account is named.
  const wrong = record(ctx, a, strategistClosure(ctx.base, h.bundle, { ...base('strat-1'), diagnosis: [{ cause: 'capability', what: 'the reviews keep asking for a recording the simulator cannot make', rounds: ['rev-1'], refs: ['rev-1:F9'], correction: { lever: 'review-scope', change: 'the next rounds state the recording proof as unproven and do not raise it again' } }], progressed: [], review: [] }).file);
  assert.equal(wrong.code, 75);
  assert.match(wrong.err, /rev-1:F9 is not a review round, finding, discovered issue, decision, base merge or gate run of this attempt \(nearest: rev-1:F1\)/);
  assert.match(wrong.err, /review round rev-2 \(recorded since the previous decision\) is in no diagnosis entry's `rounds` and not in `progressed`/);
  // A cause outside the vocabulary, two entries for one cause, and neither correction nor settledBy.
  const shape = record(ctx, a, strategistClosure(ctx.base, h.bundle, { ...base('strat-1'), diagnosis: [{ cause: 'growth', what: 'x', rounds: ['rev-1'] }, { cause: 'capability', what: 'y', rounds: ['rev-2'], correction: { lever: 'pray', change: 'z' } }, { cause: 'capability', what: 'y', rounds: ['rev-2'], settledBy: 'S9' }], progressed: [], review: [] }).file);
  assert.match(shape.err, /diagnosis\[0\]\.cause must be one of capability, assumption, regression, one-at-a-time, base, tooling, scope, review, other/);
  assert.match(shape.err, /diagnosis\[0\] needs exactly one of `correction/);
  assert.match(shape.err, /diagnosis\[1\]\.correction\.lever must be one of person, one-pass, root-cause, review-scope, base-timing, repair-tooling, routing, replan, split, model, other/);
  assert.match(shape.err, /diagnosis\[2\]: the cause capability is listed twice/);
  assert.match(shape.err, /diagnosis\[2\]\.settledBy must name an earlier strategist decision/);
  // The diagnosis that holds.
  const diagnosis = [{ cause: 'capability', what: 'the reviews keep asking for a recording the simulator here cannot make', rounds: ['rev-1', 'rev-2'], refs: ['rev-1:F1', 'rev-2:F1'], correction: { lever: 'review-scope', change: 'the next rounds state the recording proof as unproven once and do not raise it again' } }];
  ok(record(ctx, a, strategistClosure(ctx.base, h.bundle, { ...base('strat-1'), diagnosis, progressed: [], review: [] }).file));
  const s1 = loadState(ctx.root, a.id).strategy.decisions[0];
  assert.deepEqual(s1.diagnosis, [{ ...diagnosis[0] }]);
  // The correction in force, in plain words: no cause or lever token reaches the reader.
  const resume = ok(wf(ctx.root, ['resume', '--attempt', a.id])).out;
  assert.match(resume, /the strategist's correction in force since S1, for "the work needs something this environment cannot give \(a device, an account, a secret, a tool\)": the next rounds state the recording proof as unproven once and do not raise it again/);
  assert.doesNotMatch(resume, /review-scope|capability/);
  // The next reviewer is handed it, and told to work within it.
  const r3 = round(ctx, a, 'rev-3', [proof('F1', 'third')]);
  assert.deepEqual(r3.bundle.courseCorrections, [{ since: 'S1', about: 'the work needs something this environment cannot give (a device, an account, a secret, a tool)', change: 'the next rounds state the recording proof as unproven once and do not raise it again' }]);
  assert.match(r3.bundle.instructions, /`courseCorrections` is how the strategist changed the way this attempt runs/);
});

test('the next decision reports what became of the correction; the same cause met with the same change after it came back is refused; a re-raised finding holds the next round (I-234)', () => {
  const ctx = project('same-course');
  const a = started({ run: (r, args) => wf(r, args) }, ctx, { item: 'ENG-901', expect: LONG });
  round(ctx, a, 'rev-1', [proof('F1', 'first')]);
  round(ctx, a, 'rev-2', [proof('F1', 'second')]);
  const h1 = strategist(ctx, a, 'strat-1');
  const lever = { lever: 'review-scope', change: 'the next rounds state the recording proof as unproven once and do not raise it again' };
  ok(record(ctx, a, strategistClosure(ctx.base, h1.bundle, { ...base('strat-1'), diagnosis: [{ cause: 'capability', what: 'reviews keep asking for a recording this environment cannot make', rounds: ['rev-1', 'rev-2'], refs: ['rev-1:F1', 'rev-2:F1'], correction: lever }], progressed: [], review: [] }).file));
  // A round after the correction raises the same proof again, under a fresh id and with no link: the next implementer is held.
  round(ctx, a, 'rev-3', [proof('F1', 'third')]);
  const held = wf(ctx.root, ['handoff', 'implementer', '--agent', 'impl-2', '--attempt', a.id, '--owner', a.owner]);
  assert.equal(held.code, 75, held.err);
  assert.match(held.err, /not handed: the course needs the strategist first, and no implementer starts until it decides: rev-3:F1 was raised after S1, with the family and criterion of rev-1:F1, which S1 accounted for as "the work needs something this environment cannot give/);
  assert.match(ok(wf(ctx.root, ['resume', '--attempt', a.id])).out, /until it decides, no implementer and no code-review round starts/);
  const h2 = strategist(ctx, a, 'strat-2', 'the proof was raised again');
  const b2 = JSON.parse(fs.readFileSync(h2.bundle, 'utf8'));
  assert.deepEqual(b2.openCorrections.map((c) => c.correction), ['S1:capability']);
  assert.deepEqual(b2.roundsToAccount.map((r) => r.round), ['rev-3']);
  const again = (review, entry, extra = {}) => strategistClosure(ctx.base, h2.bundle, { ...base('strat-2'), diagnosis: entry ? [entry] : [], progressed: entry ? [] : ['rev-3'], review, ...extra }).file;
  const back = { cause: 'capability', what: 'the recording proof was asked for again', rounds: ['rev-3'], refs: ['rev-3:F1'] };
  // The open correction is reviewed.
  assert.match(record(ctx, a, again([], { ...back, correction: { lever: 'person', change: 'ask the person whether to ship without the recording' } })).err, /review: S1:capability .* is open and has no review entry/);
  // "Held" while citing the cause back after it is a contradiction.
  assert.match(record(ctx, a, again([{ correction: 'S1:capability', outcome: 'held', refs: ['rev-3'] }], { ...back, correction: { lever: 'person', change: 'ask the person' } })).err, /review of S1:capability says held, and the diagnosis cites "the work needs something this environment cannot give .*" again in rev-3, rev-3:F1 after it: say failed/);
  // "Failed" needs evidence from after the correction, and an answer for that cause in the same closure.
  assert.match(record(ctx, a, again([{ correction: 'S1:capability', outcome: 'failed', refs: ['rev-1'] }], { ...back, correction: { lever: 'person', change: 'ask the person' } })).err, /"failed" needs at least one ref from after S1/);
  assert.match(record(ctx, a, again([{ correction: 'S1:capability', outcome: 'failed', refs: ['rev-3'] }], null)).err, /S1's correction for "the work needs something this environment cannot give .*" did not hold; the diagnosis answers it with an entry for that cause/);
  // The same change again: refused (a design guard), whatever the action, except an escalation.
  const same = record(ctx, a, again([{ correction: 'S1:capability', outcome: 'failed', refs: ['rev-3'] }], { ...back, correction: lever }, { action: 'delta-review' }));
  assert.equal(same.code, 75);
  assert.match(same.err, /not recorded: S1 met "the work needs something this environment cannot give .*" with "change what the next rounds review or raise again" .* and the cause came back after it; the same change again repeats the loop: choose another change to the flow for it, or escalate to the person/);
  // Another change to the flow is recorded; the first correction is closed as failed, the new one is in force.
  ok(record(ctx, a, again([{ correction: 'S1:capability', outcome: 'failed', refs: ['rev-3', 'rev-3:F1'] }], { ...back, correction: { lever: 'person', change: 'the person decides whether to ship without the recording proof; no round asks for it until then' } })));
  const out = ok(wf(ctx.root, ['signals', '--attempt', a.id])).out;
  assert.match(out, /S1's correction for "the work needs something this environment cannot give .*" \(the next rounds state .*\): did not hold: the cause came back \(S2\)/);
  assert.match(out, /the strategist's correction in force since S2/);
  // Answered: the implementer starts.
  ok(wf(ctx.root, ['handoff', 'implementer', '--agent', 'impl-2', '--attempt', a.id, '--owner', a.owner]));
});

test('progressed is for rounds that did what they were handed; a round in flight is not accounted for yet; settledBy and not-applied are pinned to time and the inbox; overlaps are shown', () => {
  const ctx = project('progressed');
  const a = started({ run: (r, args) => wf(r, args) }, ctx, { item: 'ENG-902', expect: LONG });
  round(ctx, a, 'rev-1', [proof('F1', 'first')]);
  // rev-2 dies (handed, never recorded, a later reviewer handed), rev-3 does not reach its scope, rev-4 is in flight.
  commitIn(a.wt, { 'src/a.txt': 'died\n' });
  ok(wf(ctx.root, ['handoff', 'reviewer', '--agent', 'rev-2', '--attempt', a.id, '--owner', a.owner]));
  round(ctx, a, 'rev-3', [], { notReached: ['the screenshots: the export refused them'] });
  commitIn(a.wt, { 'src/a.txt': 'in flight\n' });
  ok(wf(ctx.root, ['handoff', 'reviewer', '--agent', 'rev-4', '--attempt', a.id, '--owner', a.owner]));
  const h = strategist(ctx, a, 'strat-1', 'rounds end unfinished');
  const b = JSON.parse(fs.readFileSync(h.bundle, 'utf8'));
  assert.deepEqual(b.roundsToAccount.map((r) => [r.round, r.status]), [['rev-1', 'recorded'], ['rev-2', 'died'], ['rev-3', 'recorded']]);
  assert.deepEqual(b.roundsInFlight, ['rev-4'], 'a round in flight is listed apart and not accounted for yet');
  const bad = record(ctx, a, strategistClosure(ctx.base, h.bundle, { ...base('strat-1'), diagnosis: [], progressed: ['rev-1', 'rev-2', 'rev-3'], review: [] }).file);
  assert.match(bad.err, /progressed: rev-2 died before it recorded a closure/);
  assert.match(bad.err, /progressed: rev-3 did not reach part of its scope \(the screenshots: the export refused them\)/);
  // The improvement a workflow rule needs exists in the inbox, when named.
  ok(record(ctx, a, strategistClosure(ctx.base, h.bundle, { ...base('strat-1'), diagnosis: [{ cause: 'tooling', what: 'the export refuses the screenshots, so reviews end unfinished', rounds: ['rev-2', 'rev-3'], correction: { lever: 'repair-tooling', change: 'repair the export before the next evidence review' } }, { cause: 'capability', what: 'the recording proof cannot be made here', rounds: [], refs: ['rev-1:F1'], correction: { lever: 'other', change: 'look for a device' } }], progressed: ['rev-1'], review: [] }).file));
  round(ctx, a, 'rev-5');
  const h2 = strategist(ctx, a, 'strat-2', 'the export is still broken');
  fs.mkdirSync(path.join(ctx.root, '..', '.improvements'), { recursive: true });
  fs.writeFileSync(path.join(ctx.root, '..', '.improvements', 'I-7.yaml'), 'id: I-7\ntitle: the gate requires the current base\n');
  const second = (improvement, extra = {}) => strategistClosure(ctx.base, h2.bundle, { ...base('strat-2'), diagnosis: [{ cause: 'tooling', what: 'the export still refuses the screenshots', rounds: ['rev-4', 'rev-5'], refs: ['rev-3'], correction: { lever: 'repair-tooling', change: 'repair the export first' } }, { cause: 'capability', what: 'still no device', rounds: [], refs: ['rev-1:F1'], correction: { lever: 'other', change: 'look for a device again' } }, ...(extra.entries ?? [])], progressed: [], review: [{ correction: 'S1:tooling', outcome: 'not-applied', why: 'a workflow rule kept the export from being repaired', ...(improvement ? { improvement } : {}) }, { correction: 'S1:capability', outcome: 'too-early' }] }).file;
  assert.match(record(ctx, a, second('I-99')).err, /improvement: I-99 is not an item of the improvement inbox/);
  // settledBy names what came after it: the cause is back, not settled.
  assert.match(record(ctx, a, second('I-7', { entries: [{ cause: 'review', what: 'the reviews do not finish', rounds: ['rev-5'], settledBy: 'S1' }] })).err, /diagnosis\[2\]: it says S1 settled it, and cites rev-5 from after S1/);
  // Not carried out, then the same change again: recorded (it was never tried); `other` never counts as the same change.
  ok(record(ctx, a, second('I-7')));
  const s = loadState(ctx.root, a.id);
  assert.deepEqual(s.strategy.decisions[1].review.map((r) => r.outcome), ['not-applied', 'too-early']);
  // Each cause has one correction in force: the new one closes the earlier as replaced.
  round(ctx, a, 'rev-6');
  const h3 = strategist(ctx, a, 'strat-3', 'still');
  ok(record(ctx, a, strategistClosure(ctx.base, h3.bundle, { ...base('strat-3'), diagnosis: [{ cause: 'review', what: 'the rounds before were unfinished', rounds: ['rev-6'], refs: ['rev-3'], correction: { lever: 'review-scope', change: 'review only what the export can show' } }], progressed: [], review: [{ correction: 'S2:tooling', outcome: 'not-applied', why: 'the same rule' }, { correction: 'S2:capability', outcome: 'dropped', why: 'the person accepted the gap' }] }).file));
  const resume = ok(wf(ctx.root, ['resume', '--attempt', a.id])).out;
  assert.match(resume, /the strategist's correction in force since S2, for "the gate, the evidence export or the validation fails for reasons outside the product": repair the export first; corrections for this were reported not carried out 2 times in a row/);
  assert.match(resume, /S1's correction for "the gate, the evidence export [^"]*" \(repair the export before the next evidence review\): replaced by a later correction \(S2\)/);
  // What two decisions put under different causes is shown, never refused.
  assert.match(resume, /S3 puts rev-3 under "the reviews do not converge: .*", where S1 put it under "the gate, the evidence export or the validation fails for reasons outside the product": information for the strategist/);
});

test('rounds past the attempt\'s own prediction hold the next implementer and code-review round until a strategist decides; size alone holds nothing; a strategist handed by an earlier release owes no diagnosis', async () => {
  const ctx = project('binding');
  const a = started({ run: (r, args) => wf(r, args) }, ctx, { item: 'ENG-903', expect: { files: 1, rounds: 1, minutes: 30 } });
  // Files far past twice the plan hold nothing (a large ticket going well crosses that line too).
  const files = {};
  for (let i = 0; i < 12; i++) files[`src/x-${i}.txt`] = `${i}\n`;
  commitIn(a.wt, files);
  round(ctx, a, 'rev-1', [proof('F1', 'first')]);
  ok(wf(ctx.root, ['handoff', 'implementer', '--agent', 'impl-2', '--attempt', a.id, '--owner', a.owner]));
  round(ctx, a, 'rev-2', [proof('F1', 'second')]);
  const held = wf(ctx.root, ['handoff', 'implementer', '--agent', 'impl-3', '--attempt', a.id, '--owner', a.owner]);
  assert.equal(held.code, 75);
  assert.match(held.err, /no implementer starts until it decides: 2 review rounds handed, past the 1 the plan expected/);
  // A strategist handed by an earlier release (its handoff owes nothing new) is recorded without a diagnosis.
  await inProcess(ctx.root, () => append(ctx.root, a.id, 'handoff', { role: 'strategist', agent: 'strat-old', runtime: 'claude', bundle: null, reason: 'handed before 0.7.34' }, null));
  const oldBundle = path.join(ctx.base, 'old-bundle.json');
  fs.writeFileSync(oldBundle, JSON.stringify({ attempt: a.id }));
  const legacy = strategistClosure(ctx.base, oldBundle, { ...base('strat-old'), prediction: { signal: 'blockingLatest <= 0', by: 4 } });
  ok(record(ctx, a, legacy.file));
  assert.match(fs.readFileSync(path.join(ctx.root, '..', 'refusals.jsonl'), 'utf8'), /"id":"strategy:course"/);
  assert.equal(loadState(ctx.root, a.id).strategy.decisions[0].diagnosis, undefined);
  // Its decision answered the signal: the implementer starts.
  ok(wf(ctx.root, ['handoff', 'implementer', '--agent', 'impl-3', '--attempt', a.id, '--owner', a.owner]));
});

test('an evidence review of a gated tree is not held by an unanswered course signal: only implementers and code-review rounds are', () => {
  const ctx = project('binding-evidence');
  const a = started({ run: (r, args) => wf(r, args) }, ctx, { item: 'ENG-904', expect: { files: 5, rounds: 1, minutes: 30 } });
  round(ctx, a, 'rev-1', [proof('F1', 'first')]);
  ok(wf(ctx.root, ['handoff', 'implementer', '--agent', 'impl-2', '--attempt', a.id, '--owner', a.owner]));
  commitIn(a.wt, { 'src/a.txt': 'fixed\n' });
  const clean = round(ctx, a, 'rev-2', [], { priorFindings: [{ round: 'rev-1', id: 'F1', status: 'fixed', evidence: 'src/a.txt:1 is correct now' }] });
  assert.equal(clean.code, 0, clean.err);
  assert.match(wf(ctx.root, ['handoff', 'implementer', '--agent', 'impl-3', '--attempt', a.id, '--owner', a.owner]).err, /2 review rounds handed, past the 1 the plan expected/);
  ok(wf(ctx.root, ['gate', '--attempt', a.id]));
  ok(wf(ctx.root, ['handoff', 'reviewer', '--agent', 'rev-evidence', '--attempt', a.id, '--owner', a.owner]));
});

// Seam with I-233 (base merges observed by hand, `mode: 'merge'` rounds), read defensively: both shapes of the state.
test('a base merge observed by hand is citable as base:<n> beside `wf base merge` ones, in time order; a merge round shows its mode and is accounted for like any round', async () => {
  const { refsOf, roundsOf } = await import('../engine/diagnosis.mjs');
  const without = { reviews: [], handoffs: [], baseMerges: [{ at: '2026-01-02', repo: 'app', commits: 3 }] };
  assert.deepEqual([...refsOf(without).keys()], ['base:1']);
  const withObserved = { ...without, baseObserved: [{ at: '2026-01-01', repo: 'app' }], handoffs: [{ role: 'reviewer', agent: 'rev-m', bundle: 'b-m', at: '2026-01-03', mode: 'merge' }], reviews: [{ reviewer: 'rev-m', handoff: 'b-m', at: '2026-01-04', mode: 'merge', closure: { reviewer: 'rev-m', findings: [] } }] };
  const refs = refsOf(withObserved);
  assert.match(refs.get('base:1').line, /merged by hand/);
  assert.match(refs.get('base:2').line, /3 commit\(s\)/);
  assert.deepEqual(roundsOf(withObserved).map((r) => [r.agents[0], r.mode, r.status]), [['rev-m', 'merge', 'recorded']]);
});
