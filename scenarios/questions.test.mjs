// 0.7.23 (D29): every question the person answers reads the same way, each finding is its own question, and no question is
// asked twice. Named failure (field, 2026-10-16): after the person chose to ship a ticket without proof that screen recording
// works on a real phone, they were asked seven more questions about the same gap, six of them in the reviewers' own text
// ("waive recording_evidence_review_110:F1 (high: Neither candidate has ..."), and answered all seven in five seconds
// "without really knowing yes to what". The person's rules: "separate findings as different questions", "i want to
// understand what i'm reading", "i don't want the same question asked multiple times".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { knownLimits } from '../engine/tracker.mjs';
import { loadState, readLedger } from '../engine/ledger.mjs';
import { approveAsOwner, askFile, closureFile, commitIn, criteriaFile, goodClosure, ok, sh, singleRepoProject, state, wf } from './helpers.mjs';

const ENGINE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'engine');
const silent = { ownerSilent: true };
const unworded = { ownerSilent: true, words: false };
const LINES = 'l1\nl2\nl3\nl4\nl5\nl6\n';
const LONG = Array.from({ length: 20 }, (_, i) => `long ${i + 1}`).join('\n') + '\n';
const C = [{ id: 'C1', text: 'recordings play back', uat: 'a saved recording plays' }, { id: 'C2', text: 'the app switcher hides private screens', uat: 'the switcher shows the cover' }];

function project(name) {
  const p = singleRepoProject(name, { gate: { steps: [{ id: 'unit', repo: 'app', run: 'true' }] } }, { 'src/a.txt': LINES, 'src/long.txt': LONG });
  const e = ok(wf(p.root, ['entry', '--item', 'Q-1', '--owner', 'o', '--json'])).json();
  ok(wf(p.root, ['handoff', 'planner', '--agent', 'p', '--attempt', e.id]));
  ok(wf(p.root, ['plan', '--file', criteriaFile(p.base, C), '--attempt', e.id]));
  ok(wf(p.root, ['handoff', 'implementer', '--agent', 'i', '--attempt', e.id]));
  commitIn(e.repos.app.worktree, { 'src/a.txt': LINES.replace('l2', 'L2').replace('l5', 'L5') }, 'implement');
  ok(wf(p.root, ['handoff', 'close', '--agent', 'i', '--attempt', e.id]));
  return { ...p, id: e.id, wt: e.repos.app.worktree };
}
const review = (p, agent, findings, extra = {}) => {
  ok(wf(p.root, ['handoff', 'reviewer', '--agent', agent, '--attempt', p.id]));
  ok(wf(p.root, ['review', '--closure', closureFile(p.base, goodClosure(agent, { findings, ...extra })), '--attempt', p.id]));
};
const blocking = (id, criterion, summary) => ({ id, severity: 'high', summary, status: 'open', criterion, evidence: 'src/a.txt:2' });
const RECORDING = 'Neither candidate has the required real OS recording and saved-video proof; the captures are isolated simulator scenes with synthetic capture input.';
const SWITCHER = 'The required system app-switcher privacy proof is absent; native UIWindow renders do not show the actual system snapshot.';
const words = {
  context: 'The fix passes every test we can run here, but none of them records the screen on a real iPhone, so nobody has seen it work there.',
  recommend: { choice: 'No, fix it first', why: 'a real-phone check takes ten minutes once a phone is available' },
  technical: 'C1 needs a saved recording played back on a normal build; only simulator captures exist.',
};

test('every reserved question in the engine is written in the one shape: no question is the engine\'s raw record', () => {
  // A source check, so a new question cannot slip back to raw text: each `requireYes` names its frame, and each question
  // `createDecision` makes outside engine/approve.mjs carries the composed words. The one exception it allows: a strategist
  // closure in the string-option form of attempts admitted before 0.7.11 (D7) still creates its escalation without them.
  const missing = [];
  for (const file of fs.readdirSync(ENGINE).filter((f) => f.endsWith('.mjs') && f !== 'approve.mjs')) {
    const src = fs.readFileSync(path.join(ENGINE, file), 'utf8');
    for (let at = src.indexOf('requireYes(root'); at >= 0; at = src.indexOf('requireYes(root', at + 1)) {
      const call = src.slice(at, src.indexOf('options })', at));
      if (!/\bframe: /.test(call)) missing.push(`${file}: ${src.slice(0, at).split('\n').length}`);
    }
    for (let at = src.indexOf('createDecision(root'); at >= 0; at = src.indexOf('createDecision(root', at + 1)) {
      const call = src.slice(at, src.indexOf('\n', at));
      if (!/composeAsk\(|plain: |\.\.\.words|e\.plain/.test(call)) missing.push(`${file}: ${src.slice(0, at).split('\n').length}`);
    }
  }
  assert.deepEqual(missing, []);
});

test('each finding is its own question, in plain words with a recommendation; nothing is asked before it is written', () => {
  const p = project('q-each');
  review(p, 'r1', [blocking('F1', 'C1', RECORDING), blocking('F2', 'C2', SWITCHER)]);
  const bare = wf(p.root, ['scope', 'waive', '--finding', 'r1:F1,r1:F2', '--attempt', p.id], unworded);
  assert.equal(bare.code, 75);
  assert.match(bare.err, /not asked yet: waiving r1:F1, r1:F2 is the person's decision/);
  assert.match(bare.err, /the question: Should Q-1 ship with a problem the reviewers found accepted as it is, instead of fixed\?/);
  assert.match(bare.err, /"Accept it and ship" \(it is set aside and named in the delivery note as accepted without a fix; every other check still runs before delivery\)/);
  assert.equal((state(p.root, p.id).decisions ?? []).length, 0, 'nothing is put to the person before its words exist');
  const ask = askFile(p.root, [], { ...words, items: { 'r1:F1': { what: 'Screen recording has not been tried on a real iPhone' }, 'r1:F2': { what: 'Hiding private screens in the app switcher has not been tried on a real iPhone' } } });
  const r = wf(p.root, ['scope', 'waive', '--finding', 'r1:F1,r1:F2', '--ask', ask, '--attempt', p.id], silent);
  assert.equal(r.code, 75);
  assert.match(r.err, /the person decides these \(one question per finding/);
  const ds = state(p.root, p.id).decisions;
  assert.deepEqual(ds.map((d) => [d.kind, d.key]), [['waive-finding', 'r1:F1'], ['waive-finding', 'r1:F2']], 'two findings, two questions');
  assert.equal(ds[0].plain, 'Should Q-1 ship with a problem the reviewers found accepted as it is, instead of fixed? The problem: Screen recording has not been tried on a real iPhone. The fix passes every test we can run here, but none of them records the screen on a real iPhone, so nobody has seen it work there. Technical detail: C1 needs a saved recording played back on a normal build; only simulator captures exist. Recommended: "No, fix it first", because a real-phone check takes ten minutes once a phone is available.');
  for (const d of ds) assert.doesNotMatch(d.plain, /r1:F|Neither candidate|UIWindow/, 'the reviewer\'s own text stays in the record, not in the question');
  assert.match(r.err, new RegExp(`question: "${p.id.replace('.', '\\.')} A1: Should Q-1 ship`));
  assert.match(r.err, /options: "Accept it and ship": it is set aside .*; "No, fix it first \(Recommended\)": it stays open: Q-1 is not delivered until it is fixed, or a later review finds it resolved/);
  // The person accepts one and not the other: the one is recorded, the other is not asked again.
  approveAsOwner(p.root, p.id, 'A1', 'yes');
  approveAsOwner(p.root, p.id, 'A2', 'no');
  const after = wf(p.root, ['scope', 'waive', '--finding', 'r1:F1,r1:F2', '--ask', ask, '--attempt', p.id], silent);
  assert.match(after.err, /waiving r1:F2: the person answered A2 "No, fix it first"/);
  assert.match(after.err, /it is not asked again\. If something changed since they answered, withdraw it with what changed/);
  const s = state(p.root, p.id);
  assert.equal(s.decisions.length, 2, 'the same question is not asked again');
  assert.deepEqual(s.scopeDecisions.filter((d) => d.choice === 'waived').map((d) => [d.keys, d.decision]), [[['r1:F1'], 'A1']]);
  assert.match(knownLimits(loadState(p.root, p.id)), /Accepted without a fix: Screen recording has not been tried on a real iPhone\./);
});

test('an answer stands: a "no" is not asked again until it is withdrawn with what changed', () => {
  const p = project('q-no');
  ok(wf(p.root, ['hold', '--reason', 'wait for the store review', '--attempt', p.id], silent));
  const ask = askFile(p.root, [], { context: 'The store review you were waiting for came back approved this morning.', recommend: { choice: 'yes', why: 'what you paused it for is done' } });
  const asked = wf(p.root, ['release', '--ask', ask, '--attempt', p.id], silent);
  assert.equal(asked.code, 75);
  const d = state(p.root, p.id).decisions[0];
  assert.equal(d.plain, 'Should your pause on Q-1 be lifted? You paused it with: "wait for the store review". The store review you were waiting for came back approved this morning. Recommended: "Lift the pause", because what you paused it for is done.');
  approveAsOwner(p.root, p.id, d.id, 'no');
  const again = wf(p.root, ['release', '--ask', ask, '--attempt', p.id], silent);
  assert.equal(again.code, 75);
  assert.match(again.err, /lifting the hold on Q-1\.1: the person answered A1 "Keep it paused"/);
  assert.match(again.err, /it is not asked again/);
  assert.equal(state(p.root, p.id).decisions.length, 1);
  ok(wf(p.root, ['decisions', 'withdraw', d.id, '--reason', 'the release date moved', '--attempt', p.id]));
  assert.equal(wf(p.root, ['release', '--ask', ask, '--attempt', p.id], silent).code, 75);
  assert.equal(state(p.root, p.id).decisions.length, 2, 'withdrawn with what changed, it is a new question');
});

test('a finding a later review raises again about a gap the person accepted is recorded under that answer, never asked again', () => {
  const p = project('q-same');
  review(p, 'r1', [{ ...blocking('F1', 'C1', RECORDING), family: 'recording-proof' }]);
  ok(wf(p.root, ['scope', 'waive', '--finding', 'r1:F1', '--attempt', p.id]));
  const accepted = state(p.root, p.id).decisions.at(-1);
  assert.equal(accepted.approved.choice, 'yes');
  commitIn(p.wt, { 'src/a.txt': LINES.replace('l2', 'L2!').replace('l5', 'L5') }, 'another fix');
  review(p, 'r2', [{ ...blocking('F1', 'C1', 'Usable recordings on normal candidates remain unproven.'), family: 'recording-proof' }, blocking('F2', 'C2', SWITCHER)]);
  assert.match(wf(p.root, ['scope', 'waive', '--finding', 'r2:F1', '--same-as', accepted.id, '--attempt', p.id], silent).err, /--same-as A\d+: say how this is the gap the person accepted there/);
  ok(wf(p.root, ['scope', 'waive', '--finding', 'r2:F1', '--same-as', accepted.id, '--reason', 'the same missing real-phone recording proof, raised again', '--attempt', p.id], silent));
  const s = state(p.root, p.id);
  assert.equal(s.decisions.length, 1, 'no new question');
  assert.deepEqual(s.scopeDecisions.at(-1), { ...s.scopeDecisions.at(-1), keys: ['r2:F1'], under: accepted.id, sameAs: 'r1:F1' });
  const other = wf(p.root, ['scope', 'waive', '--finding', 'r2:F2', '--same-as', accepted.id, '--reason', 'r', '--attempt', p.id], silent);
  assert.equal(other.code, 75);
  assert.match(other.err, /r2:F2 is not the same as what A\d+ decided: it blocks because it cites frozen criterion C2/);
  assert.equal(state(p.root, p.id).decisions.length, 1);
  // The delivered comment words it as the finding the person accepted.
  assert.match(knownLimits(loadState(p.root, p.id)), /Accepted without a fix: what is wrong in r1:F1, for a user|Accepted without a fix: Neither candidate/);
  // A finding of another family under the same criterion is another defect: its own question.
  commitIn(p.wt, { 'src/a.txt': LINES.replace('l2', 'L2!!').replace('l5', 'L5') }, 'a third fix');
  review(p, 'r3', [{ ...blocking('F1', 'C1', 'Playback crashes when the app resumes.'), family: 'playback-crash' }], { priorFindings: [{ round: 'r2', id: 'F2', status: 'open', evidence: 'src/a.txt:2 still unproven' }] });
  const famRef = wf(p.root, ['scope', 'waive', '--finding', 'r3:F1', '--same-as', accepted.id, '--reason', 'r', '--attempt', p.id], silent);
  assert.equal(famRef.code, 75);
  assert.match(famRef.err, /r3:F1 is not the same as what A\d+ decided: .*family playback-crash.*family recording-proof/);
  // A finding with no family says nothing about which gap it is: its own question.
  commitIn(p.wt, { 'src/a.txt': LINES.replace('l2', 'L2!!!').replace('l5', 'L5') }, 'a fourth fix');
  review(p, 'r4', [blocking('F1', 'C1', 'Recording proof still missing.')], { priorFindings: [{ round: 'r2', id: 'F2', status: 'open', evidence: 'src/a.txt:2 still unproven' }, { round: 'r3', id: 'F1', status: 'open', evidence: 'src/a.txt:2 still crashes' }] });
  assert.equal(wf(p.root, ['scope', 'waive', '--finding', 'r4:F1', '--same-as', accepted.id, '--reason', 'r', '--attempt', p.id], silent).code, 75);
  assert.equal(state(p.root, p.id).decisions.length, 1);
  assert.equal(state(p.root, p.id).decisions.length, 1);
});

test('a strategist\'s option lists every item it decides, and the person\'s answer decides them: none is asked again', async () => {
  const { project: proj, runner, started, strategistClosure } = await import('./strategist-fixtures.mjs');
  const cur = runner(JSON.parse(fs.readFileSync(path.join(ENGINE, '..', 'package.json'), 'utf8')).version);
  const ctx = proj('q-settles');
  const a = started(cur, ctx, { item: 'ENG-801' });
  commitIn(a.wt, { 'src/a.txt': 'changed\n' });
  ok(cur.run(ctx.root, ['handoff', 'reviewer', '--agent', 'rev-a', '--attempt', a.id, '--owner', a.owner]));
  ok(cur.run(ctx.root, ['review', '--closure', closureFile(ctx.base, goodClosure('rev-a', { criteria: ['C1', 'C2'].map((id) => ({ id, evidence: { kind: 'output', ref: 'log line 1' } })), findings: [blocking('F1', 'C1', RECORDING), blocking('F2', 'C2', SWITCHER)] })), '--attempt', a.id]));
  ok(cur.run(ctx.root, ['discovered', 'add', '--summary', 'the recording banner text is cut off on small phones', '--severity', 'medium', '--attempt', a.id, '--owner', a.owner]));
  const h = ok(cur.run(ctx.root, ['handoff', 'strategist', '--agent', 'strat-1', '--attempt', a.id, '--reason', 'the proof cannot be produced here', '--json'])).json();
  const closure = (extra) => strategistClosure(ctx.base, h.bundle, { strategist: 'strat-1', action: 'escalate', rationale: 'No real phone is available to prove recording.', prediction: { signal: 'blockingLatest <= 0', by: 3 },
    question: 'The recording fix passes every test we can run, but nobody can try it on a real iPhone here. Ship it without that check, or wait for a phone?',
    options: [{ label: 'Wait for a real iPhone', then: 'nothing ships until someone records the screen on a real iPhone' }, { label: 'Ship without the iPhone check', then: 'it ships after the remaining tests', settles: [{ ref: 'rev-a:F1', what: 'Screen recording has not been tried on a real iPhone' }, { ref: 'D1', what: 'The recording banner is cut off on small phones' }] }], ...extra });
  assert.match(cur.run(ctx.root, ['strategy', 'record', '--closure', closure({}).file, '--attempt', a.id]).err, /action escalate needs `recommend`/);
  const rec = ok(cur.run(ctx.root, ['strategy', 'record', '--closure', closure({ recommend: { label: 'Wait for a real iPhone', why: 'recording is the point of the ticket' } }).file, '--attempt', a.id, '--json'])).json();
  const d = cur.state(ctx.root, a.id).decisions.find((x) => x.id === rec.escalation);
  assert.equal(d.then['ship-without-the-iphone-check'], 'it ships after the remaining tests. Choosing this also decides these 2, without asking you again about each: (1) Screen recording has not been tried on a real iPhone (accepted without a fix); (2) The recording banner is cut off on small phones (shipped unfixed, listed for later; a medium issue, which your rule normally fixes before shipping).');
  assert.match(d.plain, / Recommended: "Wait for a real iPhone", because recording is the point of the ticket\.$/);
  approveAsOwner(ctx.root, a.id, d.id, 'ship-without-the-iphone-check');
  const before = cur.state(ctx.root, a.id).decisions.length;
  ok(cur.run(ctx.root, ['scope', 'waive', '--finding', 'rev-a:F1', '--attempt', a.id, '--owner', a.owner], silent));
  ok(cur.run(ctx.root, ['scope', 'defer', '--finding', 'D1', '--attempt', a.id, '--owner', a.owner], silent));
  assert.equal(cur.state(ctx.root, a.id).decisions.length, before, 'what the answer decided is not asked again');
  assert.equal(cur.state(ctx.root, a.id).decisions.find((x) => x.id === d.id).spent, undefined, 'the answer is never used up by what it decided');
  // An item the option did not name is its own question.
  assert.match(cur.run(ctx.root, ['scope', 'waive', '--finding', 'rev-a:F2', '--attempt', a.id, '--owner', a.owner], unworded).err, /not asked yet: waiving rev-a:F2/);
  const limits = knownLimits(loadState(ctx.root, a.id));
  assert.match(limits, /Accepted without a fix: Screen recording has not been tried on a real iPhone\. Left out by the person's answer "Ship without the iPhone check"\./);
  assert.match(limits, /Known issue: The recording banner is cut off on small phones\. Left out by the person's answer "Ship without the iPhone check"\./);
});

test('an approval to run the tests early holds across a base merge that leaves the ticket\'s change alone (I-180)', () => {
  const p = project('q-gate');
  commitIn(p.wt, { 'src/long.txt': LONG.replace('long 15', 'LONG 15') }, 'change a line far below the top');
  review(p, 'r1', [blocking('F1', 'C1', RECORDING)]);
  const reason = ['gate', '--reason', 'the device check needs a passing build first', '--attempt', p.id];
  const ask = askFile(p.root, [], { context: 'A reviewer is waiting for proof that only a full test run can produce.', recommend: { choice: 'yes', why: 'the proof needs the run' } });
  const asked = wf(p.root, [...reason, '--ask', ask], silent);
  assert.equal(asked.code, 75);
  const d = state(p.root, p.id).decisions[0];
  assert.match(d.plain, /^Should Q-1's full test run start now, while the last code review still has a problem open\?/);
  approveAsOwner(p.root, p.id, d.id, 'yes');
  // Main moves: lines land above the ticket's own lines, so its hunk moves; the ticket's change itself does not.
  commitIn(p.root, { 'src/long.txt': `${Array.from({ length: 9 }, (_, i) => `top ${i}`).join('\n')}\n${LONG}` }, 'another ticket on main');
  sh(p.root, 'git push -q origin main');
  ok(wf(p.root, ['base', 'merge', '--attempt', p.id]));
  ok(wf(p.root, reason, silent));
  const s = state(p.root, p.id);
  assert.equal(s.decisions.length, 1, 'the same question is not asked again');
  assert.equal(readLedger(p.root, p.id).find((e) => e.type === 'gate.override').data.decision, d.id);
  // A change to the ticket's own lines is a new question.
  commitIn(p.wt, { 'src/long.txt': fs.readFileSync(path.join(p.wt, 'src/long.txt'), 'utf8').replace('LONG 15', 'LONG 15 again') }, 'more');
  assert.equal(wf(p.root, [...reason, '--ask', ask], silent).code, 75);
  assert.equal(state(p.root, p.id).decisions.length, 2);
});

test('a reply chooses by naming one option, anywhere and not negated; a question back, two options or a negation are the person\'s words', async () => {
  const { choiceOfReply } = await import('../engine/approve.mjs');
  const escalation = { choices: ['continue', 'split', 'deliver-core', 'stop'], labels: { continue: 'Keep going as now', split: 'Split off the rest as its own ticket', 'deliver-core': 'Ship what the criteria need now', stop: 'Stop this ticket' } };
  const yesNo = { choices: ['yes', 'no'], labels: { yes: 'Accept it and ship', no: 'No, fix it first' } };
  const cases = [
    [escalation, 'ok fix all and continue', true, 'continue'],
    [escalation, 'ok fix all and continue', false, 'continue'],
    [escalation, 'stop, this is going nowhere', true, 'stop'],
    [escalation, "don't continue", true, null],
    [escalation, 'continue or stop?', true, null],
    [escalation, 'keep going as now', true, 'continue'],
    [yesNo, 'no', true, 'no'],
    [yesNo, 'ok', true, 'yes'],
    [yesNo, 'go ahead', true, 'yes'],
    [yesNo, 'nope', true, 'no'],
    [yesNo, 'ok but only after the fix', true, null],
    [yesNo, 'yes, but keep the old button visible', true, 'yes'],
    [yesNo, 'yes, actually no', true, null],
    [yesNo, "I don't know", true, null],
    [yesNo, 'yes', false, null],
    [yesNo, 'ok', false, null],
    [yesNo, 'accept it and ship', false, 'yes'],
    [escalation, 'continue is not an option', true, null],
    [escalation, 'continue would be a mistake', true, null],
    [escalation, 'fix all first, then we can decide whether to continue', true, null],
    [escalation, 'I would prefer that we do not at this point continue', true, null],
    [yesNo, 'Accept it and ship is not what I want', true, null],
    [yesNo, 'fix it first', true, 'no'],
    [yesNo, 'no, not now', true, 'no'],
    [yesNo, 'yes, but only after the failing test is fixed', true, null],
    [{ ...yesNo, aliases: { yes: ['ship it'], no: ['fix it'] } }, 'ship it after the fix', true, null],
    [{ ...yesNo, aliases: { yes: ['ship it'], no: ['fix it'] } }, 'fix it here unless it is already in another ticket', true, null],
    [escalation, 'ok continue, except the lint part', true, null],
    [{ ...yesNo, aliases: { yes: ['ship it'], no: ['fix it'] } }, 'fix it', true, 'no'],
    [{ ...yesNo, aliases: { yes: ['ship it'], no: ['fix it'] } }, 'ok, ship it', false, 'yes'],
  ];
  for (const [d, reply, quoted, want] of cases) assert.equal(choiceOfReply(d, reply, { quoted }).choice, want, `${JSON.stringify(reply)} (${quoted ? 'quoted' : 'not quoted'})`);
  assert.equal(choiceOfReply(escalation, 'ok fix all and continue').said, 'ok fix all and continue', 'the rest of the reply is kept beside the choice');
});

// 0.7.27 (I-192, D41), named failure (field): "ok we can close this then. ticket is on done? and clean up completed?" chose
// nothing: the question marks of two questions about other things made the whole reply a question back, and "close this" was no
// name of the option. A reply is read per sentence, and a decision's frame, read from its kind and key, gives its action's own
// terms to every question asked under it, whichever release asked it.
test('a reply is read per sentence, and the decision\'s own terms for its action choose, also for a question an older release asked', async () => {
  const { choiceOfReply, namesAction } = await import('../engine/approve.mjs');
  const close = { kind: 'override-gate', key: 'close-shipped:ENG-1.1:abc', choices: ['yes', 'no'], summary: 'close ENG-1.1 as shipped without its acceptance' };
  const refs = ['ENG-1.1', 'ENG-1'];
  // `own`: the message before the reply neither quoted nor named the decision; only its action's own terms count.
  const own = [
    ['ok we can close this then. ticket is on done? and clean up completed?', 'yes'], ['close this', 'yes'], ['go ahead and close', 'yes'],
    ['close the ticket', 'yes'], ['ok, close ENG-1', 'yes'], ['can you close it?', 'yes'], ['Close it. Is the deploy safe?', 'yes'], ['keep it open', 'no'],
    ["don't close it yet", null], ['we shouldn\u2019t close it', null], ['hold off on closing it', null], ['close it after the review', null],
    ['when the deploy is done, close it', null], ['verify deployment. then if all good check the data, and then close the ticket (mark done)', null],
    ['should we close it?', null], ['ok should we close it', null], ['close it?', null], ['close it. why?', null], ['close it, keep it open', null],
    ['ok', null], ['yes', null], ['close the PR', null], ['close the browser tab', null], ['close ENG-12', null], ['close ENG-1.2', null],
  ];
  for (const [reply, want] of own) assert.equal(choiceOfReply(close, reply, { own: true, refs }).choice, want, JSON.stringify(reply));
  assert.equal(namesAction(close, "don't close it yet", refs), true, 'a negated action still names it: the latest such words decide');
  assert.equal(namesAction(close, 'close the PR', refs), false);
  // To a message that quoted the question: a question about something else is set aside; one about the decision is a question back.
  for (const [reply, want] of [['Yes. Is the ticket done too?', 'yes'], ['yes. are you sure?', null], ['Yes. Why?', null], ['close it', 'yes'], ['keep it open', 'no']]) assert.equal(choiceOfReply(close, reply).choice, want, JSON.stringify(reply));
  assert.equal(choiceOfReply(close, 'Yes. Is the ticket done too?').said, 'Yes. Is the ticket done too?', 'the question set aside is kept beside the choice');
  // "Go with your recommendation" chooses the recommended option; an auxiliary opens a question only before its subject.
  const hold = { kind: 'lift-hold', key: 'release:ENG-1.1:x', choices: ['yes', 'no'], labels: { yes: 'Lift the pause', no: 'Keep it paused' }, recommend: { choice: 'yes', why: 'the review is in' } };
  for (const [reply, want] of [['go with your recommendation', 'yes'], ['not the recommended one', null], ['why is that the recommendation?', null], ['will do. lift it', 'yes'], ['should we lift it', null]]) assert.equal(choiceOfReply(hold, reply).choice, want, JSON.stringify(reply));
  // An escalation has no terms of its own: its generic words never choose without a message that asked or named it.
  const escalation = { kind: 'escalation', key: 'x', choices: ['continue', 'stop'], aliases: { continue: ['keep going'], stop: ['stop it'] } };
  for (const reply of ['keep going', 'stop it', 'continue']) assert.equal(choiceOfReply(escalation, reply, { own: true, refs }).choice, null, reply);
});

test('a gate-order question asked before this release is the same question: pending, it is asked as it is; declined, it stands', async () => {
  const p = project('q-legacy-gate');
  review(p, 'r1', [blocking('F1', 'C1', RECORDING)]);
  const { append } = await import('../engine/ledger.mjs');
  const { treeHashes } = await import('../engine/attempt.mjs');
  const { hashValue } = await import('../engine/util.mjs');
  const key = `gate:${p.id}:${hashValue(treeHashes(loadState(p.root, p.id)))}`;
  append(p.root, p.id, 'decision.created', { id: 'A1', kind: 'override-gate', key, summary: 'run the gate out of the order of work (proof first): the latest review round (r1) has open findings (F1)', choices: ['yes', 'no'] }, 'human:scenario');
  const reason = ['gate', '--reason', 'proof first', '--attempt', p.id];
  const pending = wf(p.root, reason, silent);
  assert.equal(pending.code, 75);
  assert.match(pending.err, /\(A1: run the gate out of the order of work/);
  assert.equal(state(p.root, p.id).decisions.length, 1, 'no second question for the same override');
  approveAsOwner(p.root, p.id, 'A1', 'no');
  const declined = wf(p.root, reason, silent);
  assert.match(declined.err, /the person answered A1 "no"/);
  assert.equal(state(p.root, p.id).decisions.length, 1, 'a declined question is not asked again');
});
