import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { closureFile, commitIn, goodClosure, ok, planDoc, reportFileOf, wf, writeReport } from './helpers.mjs';
import { C, growTo, inProcess, jsonl, planFile, project, reviewRound, runner, started } from './strategist-fixtures.mjs';

// 0.7.0 (D3), named failures: nothing showed rounds, scope growth, wall time or quiet sessions. A review round stayed open
// 745 minutes after its session died; one ticket grew to 303 changed files against a plan of a few dozen anchors; the owner
// polled instead (a quarter of its turns). The first answer refused every handoff on thresholds the engine picked. Now the
// plan, an implementer and a reviewer say what they expect, `wf signals`, `wf resume` and `wf status` show it beside what
// happened, and the owner agent judges. Nothing in this file asserts a refusal for growth or for time.

const v7 = runner('0.7.0');
const EXPECT = { files: 2, rounds: 3, minutes: 60 };

// ---- The plan's expectation beside what happened ----

test('wf signals, wf resume and wf status show the plan\'s expectation beside the numbers', () => {
  const ctx = project('signals');
  const a = started(v7, ctx, { item: 'ENG-740', expect: EXPECT });
  const { root } = ctx;
  reviewRound(v7, ctx, a, { findings: 2 });
  reviewRound(v7, ctx, a, { findings: 1 });
  const sig = v7.signals(root, a.id);
  for (const key of ['schema', 'attempt', 'item', 'at', 'admittedAt', 'engineVersion', 'wallMinutes', 'expect', 'rounds', 'roundsRecorded', 'roundsSinceDecrease', 'blockingLatest', 'findingsLatest', 'blockingOpen', 'observationsOpen', 'blockingFindings', 'criteria', 'amendments', 'files', 'bundle', 'implementers', 'sessions', 'strategy']) assert.ok(key in sig, `signals has ${key}`);
  assert.equal(sig.schema, 'agentic-workflow/signals@1');
  assert.equal(sig.engineVersion, '0.7.0');
  assert.deepEqual(sig.expect, EXPECT);
  assert.deepEqual(sig.rounds.map((r) => [r.n, r.findings, r.blocking, r.observations]), [[1, 2, 2, 0], [2, 1, 1, 0]]);
  assert.equal(sig.roundsSinceDecrease, 0, 'blocking findings went down from round 1 to 2');
  assert.deepEqual(sig.criteria, { atFreeze: 2, now: 2 });
  assert.equal(sig.amendments, 0);
  assert.deepEqual(sig.files, { changed: 1, planned: 2, perRepo: { app: 1 } });
  assert.ok(sig.bundle.bytes > 0 && /reviewer$/.test(sig.bundle.handoff));
  // The round escalation is the one number left, and it is the person's.
  assert.deepEqual(sig.strategy.escalation, { everyRounds: 10, firing: null });
  assert.ok(!('thresholds' in sig.strategy) && !('tripwires' in sig.strategy));
  assert.deepEqual(sig.strategy.expectations.map((x) => [x.source, x.expect]), [['plan', EXPECT]]);
  // Each place the owner looks shows expected beside actual, with no verdict.
  const text = ok(v7.run(root, ['signals', '--attempt', a.id])).out;
  assert.match(text, /review rounds recorded: 2 \(blocking per round: 2, 1; findings: 2, 1\)/);
  assert.match(text, /files changed: 1; the plan expected 2/);
  assert.match(text, /review rounds recorded: 2; the plan expected 3/);
  assert.match(text, /minutes since admission: \d+; the plan expected 60/);
  for (const cmd of [['resume'], ['status']]) {
    const out = ok(v7.run(root, [...cmd, '--attempt', a.id])).out;
    assert.match(out, /course \(expected against actual; no limit applies/, cmd[0]);
    assert.match(out, /files changed: 1; the plan expected 2/, cmd[0]);
    assert.match(out, /review rounds recorded: 2; the plan expected 3/, cmd[0]);
  }
});

test('a plan that states no expectation is refused at 0.7.0 with a hint; an attempt admitted before it is shown as stating none', () => {
  // Named failure (final review of 0.7.0): a plan with no prediction left every course line reading "the plan states no
  // expectation", so the comparison the owner agent judges the course by was inert. The plan states its own prediction.
  const ctx = project('no-expect');
  const { root, base } = ctx;
  const bare = (summary) => {
    const doc = planDoc({ plan: { summary, anchors: ['src/a.txt', 'src/b.txt'] }, criteria: C });
    delete doc.expect;
    const f = path.join(base, `bare-${Math.random().toString(36).slice(2)}.json`);
    fs.writeFileSync(f, JSON.stringify(doc));
    return f;
  };
  const e = ok(v7.run(root, ['entry', '--item', 'ENG-741', '--owner', 'owner-1', '--json'])).json();
  ok(v7.run(root, ['handoff', 'planner', '--agent', 'plan-ENG-741', '--attempt', e.id, '--owner', 'owner-1']));
  const refused = v7.run(root, ['plan', '--file', bare('change a and b'), '--attempt', e.id, '--owner', 'owner-1']);
  assert.equal(refused.code, 75);
  assert.match(refused.err, /the plan states no expectation: how many files the change will touch, how many review rounds and minutes to delivery/);
  assert.match(refused.err, /add `expect: \{ files: <n>, rounds: <n>, minutes: <n> \}` to the plan \(your own prediction: the owner agent compares the course against it; no limit is derived from it\)/);
  const log = path.join(root, '..', 'refusals.jsonl');
  assert.equal(JSON.parse(fs.readFileSync(log, 'utf8').trim().split('\n').at(-1)).id, 'plan:no-expect');
  assert.equal(v7.state(root, e.id).criteria ?? null, null, 'nothing was frozen');
  // The same plan with a prediction under `plan:` (the other place it may sit) is frozen.
  const stated = planDoc({ plan: { summary: 'change a and b', anchors: ['src/a.txt', 'src/b.txt'], expect: EXPECT }, criteria: C });
  const f = path.join(base, 'stated.json');
  fs.writeFileSync(f, JSON.stringify(stated));
  ok(v7.run(root, ['plan', '--file', f, '--attempt', e.id, '--owner', 'owner-1']));
  assert.deepEqual(v7.signals(root, e.id).expect, EXPECT);

  // An attempt admitted before 0.7.0 keeps the obligations it was admitted under: its plan may state none, and its course
  // lines say so.
  const old = runner('0.6.9');
  const ctx6 = project('no-expect-old');
  const o = ok(old.run(ctx6.root, ['entry', '--item', 'ENG-746', '--owner', 'owner-1', '--json'])).json();
  ok(old.run(ctx6.root, ['handoff', 'planner', '--agent', 'plan-ENG-746', '--attempt', o.id, '--owner', 'owner-1']));
  const olderPlan = planDoc({ plan: { summary: 'change a and b', anchors: ['src/a.txt', 'src/b.txt'] }, criteria: C });
  delete olderPlan.expect;
  const of = path.join(ctx6.base, 'older.json');
  fs.writeFileSync(of, JSON.stringify(olderPlan));
  ok(old.run(ctx6.root, ['plan', '--file', of, '--attempt', o.id, '--owner', 'owner-1']));
  ok(old.run(ctx6.root, ['handoff', 'implementer', '--agent', 'impl-ENG-746', '--attempt', o.id, '--owner', 'owner-1']));
  assert.equal(old.signals(ctx6.root, o.id).expect, null);
  assert.match(ok(old.run(ctx6.root, ['resume', '--attempt', o.id])).out, /files changed: 0; the plan states no expectation/);
});

test('growth refuses nothing: 40 changed files are handed on and shown against what the plan expected', () => {
  // Named failure: the first answer stopped every handoff at changed files above 2x the plan's (and amendments above 1x the criteria).
  const ctx = project('growth');
  const a = started(v7, ctx, { item: 'ENG-742', expect: EXPECT });
  const { root } = ctx;
  growTo(a, 40);
  reviewRound(v7, ctx, a, { findings: 1 });
  const sig = v7.signals(root, a.id);
  assert.equal(sig.files.changed, 40);
  assert.match(ok(v7.run(root, ['resume', '--attempt', a.id])).out, /files changed: 40; the plan expected 2/);
  assert.notEqual(v7.state(root, a.id).decision.kind, 'strategy');
  ok(v7.run(root, ['handoff', 'reviewer', '--agent', 'free-reviewer', '--attempt', a.id, '--owner', a.owner]));
});

// ---- Roles say what they expect, in the file they write early ----

test('an implementer\'s report is read while it works: its approach and expected minutes against its elapsed time; a reviewer\'s closure the same', () => {
  const ctx = project('roles');
  const a = started(v7, ctx, { item: 'ENG-743', expect: EXPECT });
  const { root, base } = ctx;
  const implementer = 'impl-ENG-743';
  const implementerBundle = JSON.parse(fs.readFileSync(v7.state(root, a.id).handoffs.find((h) => h.agent === implementer).bundle, 'utf8'));
  assert.ok(!('expect' in implementerBundle.plan), 'the plan\'s prediction is not a target for the implementer');
  assert.match(implementerBundle.instructions, /`approach` and `expect: \{ minutes \}`/);
  // Written early: no summary yet, so the engine would not take it at close, but it reads what the report says so far.
  fs.mkdirSync(path.dirname(reportFileOf(root, a.id, implementer)), { recursive: true });
  fs.writeFileSync(reportFileOf(root, a.id, implementer), JSON.stringify({ implementer, approach: 'change a.txt and b.txt in one pass', expect: { minutes: 25 } }));
  let sig = v7.signals(root, a.id);
  const working = sig.sessions.find((s) => s.agent === implementer);
  assert.deepEqual([working.role, working.expectMinutes, working.said], ['implementer', 25, 'change a.txt and b.txt in one pass']);
  assert.ok(working.minutes >= 0 && working.minutes < 5);
  assert.match(ok(v7.run(root, ['resume', '--attempt', a.id])).out, /implementer impl-ENG-743 is working: \d+ min since handed, it expects 25 min; last activity [^;]*; approach: change a\.txt and b\.txt in one pass/);
  // Completed and closed: the expectation is kept with the close, beside the minutes it took.
  writeReport(root, a.id, implementer, { approach: 'change a.txt and b.txt in one pass', expect: { minutes: 25 } });
  ok(v7.run(root, ['handoff', 'close', '--agent', implementer, '--attempt', a.id, '--owner', a.owner]));
  sig = v7.signals(root, a.id);
  assert.deepEqual(sig.implementers.map((x) => [x.agent, x.open, x.expectMinutes, x.approach]), [[implementer, false, 25, 'change a.txt and b.txt in one pass']]);
  assert.deepEqual(v7.state(root, a.id).implementerReports.map((r) => r.expect), [{ minutes: 25 }]);
  assert.equal(sig.sessions.length, 0, 'a closed implementer is not working');
  assert.match(ok(v7.run(root, ['signals', '--attempt', a.id])).out, /implementer impl-ENG-743 done: took \d+ min; it expected 25 min; approach: change a\.txt/);
  // A reviewer round in flight: its closure file, started early, states its scope and expected minutes.
  commitIn(a.wt, { 'src/a.txt': 'reviewed change\n' });
  ok(v7.run(root, ['check', '--attempt', a.id, '--owner', a.owner]));
  const handed = ok(v7.run(root, ['handoff', 'reviewer', '--agent', 'rev-roles', '--attempt', a.id, '--owner', a.owner, '--json'])).json();
  const bundle = JSON.parse(fs.readFileSync(handed.bundle, 'utf8'));
  assert.ok(!('budget' in bundle), 'the reviewer bundle carries no effort budget');
  assert.ok(!('expect' in bundle.plan), 'the plan\'s prediction is not a target for the reviewer');
  assert.match(bundle.instructions, /`scope`[\s\S]*`expect: \{ minutes \}`/);
  fs.writeFileSync(bundle.reviewClosureFile, JSON.stringify({ reviewer: 'rev-roles', scope: 'both criteria and the one changed file', expect: { minutes: 20 } }));
  sig = v7.signals(root, a.id);
  const reading = sig.sessions.find((s) => s.agent === 'rev-roles');
  assert.deepEqual([reading.role, reading.expectMinutes, reading.said], ['reviewer', 20, 'both criteria and the one changed file']);
  // Recorded: the round keeps what the reviewer expected beside the minutes it took.
  const closure = goodClosure('rev-roles', { scope: 'both criteria and the one changed file', expect: { minutes: 20 }, criteria: ['C1', 'C2'].map((id) => ({ id, evidence: { kind: 'output', ref: 'log line 1' } })) });
  ok(v7.run(root, ['review', '--closure', closureFile(base, closure), '--attempt', a.id]));
  sig = v7.signals(root, a.id);
  assert.deepEqual(sig.rounds.map((r) => [r.expectMinutes, r.scope]), [[20, 'both criteria and the one changed file']]);
  assert.ok(sig.rounds[0].minutes >= 0);
  assert.match(ok(v7.run(root, ['signals', '--attempt', a.id])).out, /review round 1 \(rev-roles\): took [\d.]+ min; it expected 20 min; scope: both criteria and the one changed file/);
  // The strategist reads the plan's prediction with the rest.
  const strategist = JSON.parse(fs.readFileSync(ok(v7.run(root, ['handoff', 'strategist', '--agent', 'strat-roles', '--attempt', a.id, '--json'])).json().bundle, 'utf8'));
  assert.deepEqual(strategist.signals.expect, EXPECT);
});

test('a role silent for hours is shown with its elapsed time, last activity and its own expectation; nothing is refused for it', async () => {
  // Named failure: a reviewer round stayed open 745 minutes after its session died and the owner polled instead.
  const ctx = project('clock');
  const a = started(v7, ctx, { item: 'ENG-750', expect: EXPECT });
  const { root } = ctx;
  // A reviewer round is open (no closure), as a Claude Code subagent named rev-idle whose transcript was last written now.
  const handed = ok(v7.run(root, ['handoff', 'reviewer', '--agent', 'rev-idle', '--attempt', a.id, '--owner', a.owner, '--json'])).json();
  const bundle = JSON.parse(fs.readFileSync(handed.bundle, 'utf8'));
  fs.writeFileSync(bundle.reviewClosureFile, JSON.stringify({ reviewer: 'rev-idle', expect: { minutes: 20 } }));
  const home = path.join(root, '..', '.home');
  const dir = path.join(home, '.claude', 'projects', '-p', 'sess-1', 'subagents');
  jsonl(path.join(dir, 'agent-a1.jsonl'), [{ type: 'assistant', timestamp: new Date().toISOString(), requestId: 'r1', message: { model: 'claude-x', usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 5, cache_creation_input_tokens: 7 } } }]);
  fs.writeFileSync(path.join(dir, 'agent-a1.meta.json'), JSON.stringify({ name: 'rev-idle', agentType: 'wf-reviewer' }));
  const { computeSignals, courseLines } = await import('../engine/signals.mjs');
  const { strategyHold } = await import('../engine/strategy.mjs');
  const { loadState } = await import('../engine/ledger.mjs');
  await inProcess(root, () => {
    const state = loadState(root, a.id);
    const at = (minutes) => computeSignals(root, state, { nowMs: Date.now() + minutes * 60000, home });
    // The open reviewer round is a running session; its transcript is found by the name it was started with.
    const s5 = at(5);
    assert.equal(s5.sessions.length, 1);
    assert.equal(s5.sessions[0].located, true);
    assert.ok(s5.sessions[0].idleMinutes >= 4.9 && s5.sessions[0].idleMinutes < 6, `idle ${s5.sessions[0].idleMinutes}`);
    // Five hours on: the numbers say so beside what the reviewer expected, and nothing is judged.
    const s300 = at(300);
    assert.ok(s300.wallMinutes >= 300 && s300.sessions[0].minutes >= 300 && s300.sessions[0].idleMinutes >= 299, 'elapsed and idle time grow');
    assert.equal(s300.sessions[0].expectMinutes, 20);
    const lines = courseLines(s300).join('\n');
    // Beyond a number its own role stated, a line says so (information for the owner agent's judgement, never a limit), and a
    // round handed but never recorded is counted beside the recorded ones.
    assert.match(lines, /minutes since admission: 30\d; the plan expected 60 \(past its own estimate\)/);
    assert.match(lines, /review rounds recorded: 0; the plan expected 3; 1 handed \(1 never recorded\)/);
    assert.match(lines, /reviewer rev-idle is working: 30\d min since handed, it expects 20 min \(past its own estimate\); last activity 30\d min ago/);
    // The engine's hold is the person's and the strategist's escalations only: no clock enters it.
    assert.equal(strategyHold(root, state), null);
  });
  ok(v7.run(root, ['handoff', 'reviewer', '--agent', 'rev-after-silence', '--attempt', a.id, '--owner', a.owner]));
});

test('a plan expectation the engine cannot compare is refused; a role\'s unreadable estimate is dropped', () => {
  // Named failure: `minutes: "an hour"` or a misspelled key left the comparison silently empty where a role had predicted.
  const ctx = project('malformed');
  const { root, base } = ctx;
  const e = ok(v7.run(root, ['entry', '--item', 'ENG-744', '--owner', 'owner-1', '--json'])).json();
  ok(v7.run(root, ['handoff', 'planner', '--agent', 'plan-ENG-744', '--attempt', e.id, '--owner', 'owner-1']));
  for (const [expect, message] of [[{ minutes: 'an hour' }, /`plan\.expect\.minutes` must be a positive number/], [{ file: 3 }, /`plan\.expect\.file` is not known \(known: files, rounds, minutes\)/], [{ rounds: 2.5 }, /`plan\.expect\.rounds` must be a whole number/], ['soon', /`plan\.expect` must be a mapping/]]) {
    const r = v7.run(root, ['plan', '--file', planFile(base, { expect }), '--attempt', e.id, '--owner', 'owner-1']);
    assert.notEqual(r.code, 0);
    assert.match(r.err, message);
  }
  ok(v7.run(root, ['plan', '--file', planFile(base, { expect: { files: 3 } }), '--attempt', e.id, '--owner', 'owner-1']));
  ok(v7.run(root, ['handoff', 'implementer', '--agent', 'impl-m', '--attempt', e.id, '--owner', 'owner-1']));
  // An implementer's or reviewer's estimate is optional context: one the engine cannot read is dropped, never a reason to
  // refuse its close or its round (refusal audit of 0.7.0); the plan's, which the course is compared against, is refused.
  writeReport(root, e.id, 'impl-m', { expect: { minutes: 0 } });
  ok(v7.run(root, ['handoff', 'close', '--agent', 'impl-m', '--attempt', e.id, '--owner', 'owner-1'], { ownerSilent: true }));
  assert.equal(v7.state(root, e.id).implementerReports.at(-1).expect, null, 'the unreadable estimate is dropped');
});

// ---- A re-plan states its own expectation ----

test('a re-plan\'s amendment states a new expectation; the plan\'s stays in the history', () => {
  const ctx = project('replan');
  const a = started(v7, ctx, { item: 'ENG-745', expect: EXPECT });
  const { root, base } = ctx;
  const file = path.join(base, 'replan.json');
  fs.writeFileSync(file, JSON.stringify({ expect: { files: 12, rounds: 5, minutes: 150 } }));
  ok(v7.run(root, ['criteria', 'amend', '--file', file, '--reason', 'the contract spans both apps; 12 files, not 2', '--attempt', a.id, '--owner', a.owner]));
  const sig = v7.signals(root, a.id);
  assert.deepEqual(sig.expect, { files: 12, rounds: 5, minutes: 150 });
  assert.deepEqual(sig.strategy.expectations.map((x) => [x.source, x.amendment, x.reason]), [['plan', null, null], ['amendment', 1, 'the contract spans both apps; 12 files, not 2']]);
  assert.match(ok(v7.run(root, ['signals', '--attempt', a.id])).out, /re-plan at amendment 1 expects files 12, rounds 5, minutes 150 \("the contract spans both apps; 12 files, not 2"\)/);
  fs.writeFileSync(file, JSON.stringify({ expect: { minutes: 'long' } }));
  assert.match(v7.run(root, ['criteria', 'amend', '--file', file, '--reason', 'x', '--attempt', a.id, '--owner', a.owner]).err, /`expect\.minutes` must be a positive number/);
});

// ---- The adapter ----

test('adapter `strategy:` changes the round escalation; a mistyped key and a key of a removed tripwire are refused', () => {
  const ctx = project('override', { strategy: { reviewRoundsEscalate: 4 } });
  const a = started(v7, ctx, { item: 'ENG-770' });
  const { root } = ctx;
  reviewRound(v7, ctx, a, { findings: 0 });
  const sig = v7.signals(root, a.id);
  assert.equal(sig.strategy.escalation.everyRounds, 4);
  assert.equal(sig.strategy.escalation.firing, null);
  const typo = project('typo', { strategy: { reviewRoundsEscalat: 4 } });
  const r = wf(typo.root, ['entry', '--item', 'ENG-771'], { bin: v7.bin });
  assert.notEqual(r.code, 0);
  assert.match(r.err, /strategy\.reviewRoundsEscalat: unknown \(known: enabled, reviewRoundsEscalate\)/);
  // The thresholds the engine once picked are gone with their tripwires.
  const gone = project('gone', { strategy: { wallMinutesFirst: 30 } });
  assert.match(wf(gone.root, ['entry', '--item', 'ENG-772'], { bin: v7.bin }).err, /strategy\.wallMinutesFirst: unknown/);
});

// ---- The role: generated agent files, and a launch by the engine ----

test('wf sync writes the strategist agent for Claude and Codex, and `roles.strategist: false` switches the role and the escalation off', () => {
  const ctx = project('role');
  ok(v7.run(ctx.root, ['sync']));
  const claude = fs.readFileSync(path.join(ctx.root, '.claude', 'agents', 'wf-strategist.md'), 'utf8');
  assert.match(claude, /^name: wf-strategist$/m);
  assert.match(claude, /^tools: Read, Grep, Glob, Bash, Write$/m);
  assert.match(claude, /model: opus/);
  // Handed because the course diverged from what was predicted; one decision from the eight actions, one prediction.
  assert.match(claude, /handed you because the course diverged from what was predicted/);
  assert.doesNotMatch(claude, /tripwire/i);
  assert.match(claude, /\*\*You decide\*\* one action/);
  for (const action of ['continue', 'consolidate', 'cluster', 'delta-review', 'split', 'ticket', 'model', 'escalate']) assert.match(claude, new RegExp(`^- \`${action}\`: `, 'm'), action);
  assert.match(claude, /one prediction the engine can check/);
  assert.match(claude, /`wf strategy record --closure <that file> --attempt <id>`/);
  const codex = fs.readFileSync(path.join(ctx.root, '.codex', 'agents', 'wf-strategist.toml'), 'utf8');
  assert.match(codex, /name = "wf-strategist"/);
  assert.match(codex, /developer_instructions = """/);
  const off = project('role-off', { roles: { strategist: false }, strategy: { reviewRoundsEscalate: 1 } });
  ok(v7.run(off.root, ['sync']));
  assert.equal(fs.existsSync(path.join(off.root, '.claude', 'agents', 'wf-strategist.md')), false);
  const a = started(v7, off, { item: 'ENG-780' });
  reviewRound(v7, off, a, { findings: 0 });
  assert.equal(v7.signals(off.root, a.id).strategy.applies, false);
  ok(v7.run(off.root, ['handoff', 'reviewer', '--agent', 'rev-free', '--attempt', a.id, '--owner', a.owner]));
  assert.match(v7.run(off.root, ['handoff', 'strategist', '--agent', 'strat', '--attempt', a.id]).err, /strategist role is switched off/);
});

test('wf handoff run launches the strategist on the runtime the adapter names, and it records its own decision', () => {
  // The owner is a Claude session; the adapter sends the strategist to Codex (a model family other than the implementers').
  const ctx = project('launch', { roles: { strategist: { runtime: 'codex' } }, classes: { review: { codex: { model: 'strategist-model', effort: 'high' } } } });
  const { root, base } = ctx;
  const bin = path.join(base, 'fakebin');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, 'codex'), `#!/usr/bin/env node
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
const args = process.argv.slice(2);
const prompt = fs.readFileSync(0, 'utf8');
const bundle = JSON.parse(fs.readFileSync(prompt.replace(/^Read /, '').replace(/ and follow its instructions\\.$/, ''), 'utf8'));
fs.writeFileSync(${JSON.stringify(path.join(base, 'args.json'))}, JSON.stringify(args));
console.log(JSON.stringify({ type: 'thread.started', thread_id: '01a110b4-1637-7a42-b353-d0ad25e60077' }));
fs.writeFileSync(bundle.strategyClosureFile, JSON.stringify({ strategist: bundle.agent, action: 'continue', rationale: 'The numbers are explained by the plan.', prediction: { signal: 'rounds >= 1', by: 2 } }));
const r = spawnSync('wf', ['strategy', 'record', '--closure', bundle.strategyClosureFile, '--attempt', bundle.attempt], { encoding: 'utf8' });
if (r.status !== 0) { console.error(r.stderr); process.exit(1); }
console.log(JSON.stringify({ type: 'turn.completed' }));
`);
  fs.chmodSync(path.join(bin, 'codex'), 0o755);
  const a = started(v7, ctx, { item: 'ENG-790', owner: 'claude:owner-aaaaaaaa1' });
  const h = ok(v7.run(root, ['handoff', 'strategist', '--agent', 'strat-run', '--attempt', a.id, '--reason', 'the diff is past what the plan expected', '--json'])).json();
  assert.equal(h.model, 'strategist-model');
  assert.match(ok(v7.run(root, ['handoff', 'strategist', '--agent', 'strat-run-2', '--attempt', a.id])).out, /It records its own decision \(`wf strategy record --closure .*closure-\d+\.json`\)\. Wait for its completion notification[\s\S]*never poll/);
  const s0 = v7.state(root, a.id);
  const handed = s0.handoffs.find((x) => x.agent === 'strat-run');
  assert.equal(handed.runtime, 'codex');
  assert.equal(handed.reason, 'the diff is past what the plan expected');
  assert.equal(s0.owner, 'claude:owner-aaaaaaaa1');
  ok(v7.run(root, ['handoff', 'run', '--agent', 'strat-run', '--attempt', a.id], { env: { PATH: `${bin}${path.delimiter}${process.env.PATH}` } }));
  const args = JSON.parse(fs.readFileSync(path.join(base, 'args.json'), 'utf8'));
  assert.ok(args.includes('strategist-model'));
  assert.ok(args.some((x) => x.startsWith('developer_instructions=') && x.includes('You are the strategist')));
  const s = v7.state(root, a.id);
  assert.equal(s.handoffs.find((x) => x.agent === 'strat-run').launch.status, 'completed');
  assert.equal(s.strategy.decisions.length, 1);
  assert.equal(s.strategy.decisions[0].strategist, 'strat-run');
  assert.equal(s.strategy.decisions[0].action, 'continue');
  assert.equal(s.strategy.decisions[0].handedBecause, 'the diff is past what the plan expected');
  // The report reads a strategist handoff like any other role.
  assert.ok(JSON.stringify(ok(v7.run(root, ['report', '--json'])).json()).includes('strat-run'));
});

test('a strategist whose launch completed without recording a decision is not waited for: the owner is told to hand a fresh one', () => {
  // Named failure: a handed strategist that finished without recording left `wf resume` saying "wait for its completion
  // notification" for good, and with the tripwires gone nothing else would have shown it.
  const ctx = project('launch-silent', { roles: { strategist: { runtime: 'codex' } }, classes: { review: { codex: { model: 'strategist-model', effort: 'high' } } } });
  const { root, base } = ctx;
  const bin = path.join(base, 'fakebin');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, 'codex'), `#!/usr/bin/env node
import fs from 'node:fs';
fs.readFileSync(0, 'utf8');
console.log(JSON.stringify({ type: 'thread.started', thread_id: '01a110b4-1637-7a42-b353-d0ad25e60078' }));
console.log(JSON.stringify({ type: 'turn.completed' }));
`);
  fs.chmodSync(path.join(bin, 'codex'), 0o755);
  const a = started(v7, ctx, { item: 'ENG-791', owner: 'claude:owner-aaaaaaaa1' });
  ok(v7.run(root, ['handoff', 'strategist', '--agent', 'strat-silent', '--attempt', a.id, '--reason', 'rounds are not converging']));
  assert.match(v7.state(root, a.id).decision.guidance, /was handed because: rounds are not converging .*wait for its completion notification/);
  ok(v7.run(root, ['handoff', 'run', '--agent', 'strat-silent', '--attempt', a.id], { env: { PATH: `${bin}${path.delimiter}${process.env.PATH}` } }));
  const s = v7.state(root, a.id);
  assert.equal(s.handoffs.find((x) => x.agent === 'strat-silent').launch.status, 'completed');
  assert.equal(s.strategy.decisions.length, 0);
  assert.equal(s.decision.kind, 'strategy');
  assert.match(s.decision.guidance, /its launch completed without recording a decision: hand a fresh strategist with a new id/);
});
