import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { ok } from './helpers.mjs';
import { W, growTo, inProcess, project, reviewRound, runner, started, strategistClosure } from './strategist-fixtures.mjs';

// 0.7.0 (D3), named failures: no role owned "stop, consolidate, split, or is this still worth its cost". A ticket ran 47
// review rounds with its blocking findings flat for 18 of them, agents proposed splitting it three times and nothing
// could act on it, a review round stayed open 745 minutes after its session died. The first answer made engine tripwires
// on numbers it picked summon the strategist and refuse every handoff until it decided. Now agents predict (the plan, an
// implementer, a reviewer, the strategist), the engine shows each prediction beside what happened, and the owner agent
// hands the strategist when it judges the course diverged. The engine stops only for the person's own round escalation,
// a strategist's escalation awaiting `wf approve`, and the strategist's rule that two missed predictions in a row make its
// next decision an escalation.

const v7 = runner('0.7.0');
const old = runner('0.6.9');
const refusalRows = (root) => {
  const log = path.join(root, '..', 'refusals.jsonl');
  return fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : [];
};

test('the owner agent hands the strategist when the course diverges; nothing was refused on the way; a delta-review decision sets the next round', async () => {
  const ctx = project('nonconv');
  const a = started(v7, ctx, { item: 'ENG-700', expect: { files: 2, rounds: 2, minutes: 30 } });
  const { root, base } = ctx;
  // Three recorded rounds with one blocking finding each, then a diff of 40 files against the 2 the plan expected: every
  // handoff was accepted, and a fourth round is handed on top of it.
  for (let i = 0; i < 3; i++) reviewRound(v7, ctx, a, { findings: 1 });
  growTo(a, 40);
  reviewRound(v7, ctx, a, { findings: 1 });
  const sig = v7.signals(root, a.id);
  assert.deepEqual(sig.rounds.map((r) => r.blocking), [1, 1, 1, 1]);
  assert.equal(sig.roundsSinceDecrease, 3);
  assert.equal(sig.strategy.applies, true);
  assert.deepEqual(sig.strategy.escalation.firing, null);
  // The comparison is where the owner looks; nothing in the engine says the course is wrong.
  const resume = ok(v7.run(root, ['resume', '--attempt', a.id])).out;
  assert.match(resume, /files changed: 40; the plan expected 2 \(past its own estimate\)/);
  assert.match(resume, /review rounds recorded: 4; the plan expected 2 \(past its own estimate\)/);
  // ... and the line the owner agent acts on starts with the comparison, as a prompt to judge the course, not a refusal.
  assert.match(resume, /next: past its own estimate: files changed 40 \(the plan expected 2\); review rounds 4 \(the plan expected 2\)\. Judge the course before the next step: continue, re-plan[^\n]*wf handoff strategist/);
  assert.notEqual(v7.state(root, a.id).decision.kind, 'strategy', 'no strategist is summoned by the engine');
  // The strategist may not be one of the attempt's implementers; a reason is text.
  const implementer = v7.state(root, a.id).roles.implementer[0];
  const asImplementer = v7.run(root, ['handoff', 'strategist', '--agent', implementer, '--attempt', a.id]);
  assert.equal(asImplementer.code, 75);
  assert.match(asImplementer.err, /implemented part of this attempt and cannot be its strategist/);
  assert.match(v7.run(root, ['handoff', 'strategist', '--agent', 'strat-x', '--attempt', a.id, '--reason']).err, /--reason needs text/);
  // The owner agent hands it with what it saw. The bundle: why, the comparison, the signals, findings by family, a closure file.
  const because = 'the diff is 20x the files the plan expected and four rounds did not reduce the blocking finding';
  const h = ok(v7.run(root, ['handoff', 'strategist', '--agent', 'strat-1', '--attempt', a.id, '--reason', because, '--json'])).json();
  assert.equal(h.agentType, 'wf-strategist');
  const bundle = JSON.parse(fs.readFileSync(h.bundle, 'utf8'));
  assert.equal(bundle.role, 'strategist');
  assert.equal(bundle.handedBecause, because);
  assert.ok(!('tripwires' in bundle), 'there are no engine tripwires to answer');
  assert.deepEqual(bundle.predictions, { missedInARow: 0, escalateRequired: false });
  assert.ok(bundle.course.includes('files changed: 40; the plan expected 2 (past its own estimate)'));
  assert.match(bundle.instructions, /handed you because the course diverged from what was predicted/);
  assert.equal(bundle.signals.rounds.length, 4);
  assert.deepEqual(Object.keys(bundle.blocking.byFamily), ['(none)']);
  assert.deepEqual(bundle.earlierDecisions, []);
  assert.deepEqual(bundle.criteria.map((c) => c.id), ['C1', 'C2']);
  assert.ok(bundle.planFiles.includes('src/a.txt'));
  assert.match(bundle.strategyClosureFile, /_strategy\/closure-\d+\.json$/);
  // Once handed, the owner is told to wait for it, and why it was handed. Waiting is the owner's choice: no handoff is refused.
  const waiting = v7.state(root, a.id).decision;
  assert.equal(waiting.kind, 'strategy');
  assert.match(waiting.guidance, new RegExp(`Strategist strat-1 was handed because: ${because}`));
  assert.match(waiting.guidance, /not launched through wf\) and has recorded no decision: wait for its completion notification/);
  // A closure that does not fit the schema is refused with every problem.
  const bad = strategistClosure(base, h.bundle, { strategist: 'strat-1', action: 'shrug', rationale: '', prediction: { signal: 'vibes', by: 1 } });
  const refused = v7.run(root, ['strategy', 'record', '--closure', bad.file, '--attempt', a.id]);
  assert.equal(refused.code, 1);
  assert.match(refused.err, /`action` must be one of continue, consolidate, cluster, delta-review, split, ticket, model, escalate/);
  assert.match(refused.err, /`rationale`/);
  assert.match(refused.err, /`prediction\.signal` must read/);
  assert.match(refused.err, /already been recorded \(4 so far\)/);
  // A decision without a strategist handoff behind it is refused.
  const nobody = strategistClosure(base, h.bundle, { strategist: 'someone-else', action: 'continue', rationale: 'no', prediction: { signal: 'blockingLatest <= 0', by: 6 } });
  assert.equal(v7.run(root, ['strategy', 'record', '--closure', nobody.file, '--attempt', a.id]).code, 75);
  // delta-review, with a prediction the engine can check.
  const good = strategistClosure(base, h.bundle, { strategist: 'strat-1', action: 'delta-review', rationale: 'Fresh blind reviewers keep finding something new; judge the diff and the open findings only.', prediction: { signal: 'blockingLatest <= 0', by: 6 } });
  const rec = ok(v7.run(root, ['strategy', 'record', '--closure', good.file, '--attempt', a.id, '--json'])).json();
  assert.equal(rec.decision.id, 'S1');
  let s = v7.state(root, a.id);
  assert.equal(s.strategy.decisions[0].action, 'delta-review');
  assert.equal(s.strategy.decisions[0].handedBecause, because);
  assert.equal(s.strategy.nextRound, 'delta', 'the review stream reads this flag through roundMode');
  assert.equal(s.strategy.decisions[0].signals.roundsSinceDecrease, 3);
  assert.notEqual(s.decision.kind, 'strategy');
  const { roundMode } = await import('../engine/review-policy.mjs');
  assert.equal(roundMode(s), 'delta');
  // The decision and its prediction are shown beside the rest.
  assert.match(ok(v7.run(root, ['resume', '--attempt', a.id])).out, /strategist S1 \(delta-review\) predicted blockingLatest <= 0 by round 6: pending/);
  // A decision belongs to one handoff.
  assert.match(v7.run(root, ['strategy', 'record', '--closure', good.file, '--attempt', a.id]).err, /already recorded its decision \(S1\)/);
  // The next reviewer round is handed, and the flag is consumed by it.
  ok(v7.run(root, ['handoff', 'reviewer', '--agent', 'rev-after', '--attempt', a.id, '--owner', a.owner]));
  s = v7.state(root, a.id);
  assert.equal(s.strategy.nextRound, null);
  assert.equal(s.handoffs.filter((x) => x.role === 'reviewer').at(-1).mode, 'delta', 'the handed round is a delta round');
  assert.deepEqual(s.strategy.tripwires, []);
});

test('a strategist handed and not yet decided is waited for by choice: no handoff is refused for it', () => {
  const ctx = project('waiting');
  const a = started(v7, ctx, { item: 'ENG-701' });
  const { root } = ctx;
  reviewRound(v7, ctx, a, { findings: 1 });
  ok(v7.run(root, ['handoff', 'strategist', '--agent', 'strat-w', '--attempt', a.id]));
  assert.equal(v7.state(root, a.id).decision.kind, 'strategy');
  ok(v7.run(root, ['handoff', 'reviewer', '--agent', 'x-reviewer', '--attempt', a.id, '--owner', a.owner]));
  assert.ok(!refusalRows(root).some((x) => /^strategy:/.test(x.id)), 'no strategy refusal was recorded');
});

test('a strategist that died undecided is superseded by a later one that decided: resume no longer waits for it', () => {
  const ctx = project('stale');
  const { root, base } = ctx;
  const a = started(v7, ctx, { item: 'ENG-702' });
  reviewRound(v7, ctx, a, { findings: 1 });
  ok(v7.run(root, ['handoff', 'strategist', '--agent', 'strat-dead', '--attempt', a.id, '--reason', 'blocking findings stayed flat']));
  const h = ok(v7.run(root, ['handoff', 'strategist', '--agent', 'strat-fresh', '--attempt', a.id, '--reason', 'the first strategist never answered', '--json'])).json();
  const c = strategistClosure(base, h.bundle, { strategist: 'strat-fresh', action: 'continue', rationale: 'The findings are converging.', prediction: { signal: 'blockingLatest <= 5', by: 3 } });
  ok(v7.run(root, ['strategy', 'record', '--closure', c.file, '--attempt', a.id]));
  assert.notEqual(v7.state(root, a.id).decision.kind, 'strategy');
  assert.ok(!v7.signals(root, a.id).sessions.some((x) => x.agent === 'strat-dead'), 'the superseded strategist is not shown as running');
});

test('an attempt admitted before 0.7.0 is not held by the round escalation', () => {
  const ctx = project('pre07', { strategy: { reviewRoundsEscalate: 2 } });
  const a = started(old, ctx, { item: 'ENG-710' });
  for (let i = 0; i < 3; i++) reviewRound(old, ctx, a, { findings: 1 });
  const sig = old.signals(ctx.root, a.id);
  assert.equal(sig.roundsSinceDecrease, 2, 'the numbers are still shown');
  assert.equal(sig.strategy.applies, false);
  assert.notEqual(old.state(ctx.root, a.id).decision.kind, 'strategy');
  ok(old.run(ctx.root, ['handoff', 'reviewer', '--agent', 'rev-more', '--attempt', a.id, '--owner', a.owner]));
});

test('two missed predictions in a row leave escalate as the strategist\'s only answer, and the owner decides it', async () => {
  // The rule is the strategist's own, about its own predictions: the owner agent hands it when it judges the course needs
  // it, and after two misses its next decision asks the person.
  const ctx = project('missed');
  const a = started(v7, ctx, { item: 'ENG-720' });
  const { root, base } = ctx;
  const decide = (tag, closure) => {
    const h = ok(v7.run(root, ['handoff', 'strategist', '--agent', `strat-${tag}`, '--attempt', a.id, '--reason', `round ${tag}: the blocking finding is still there`, '--json'])).json();
    return { h, ...strategistClosure(base, h.bundle, { strategist: `strat-${tag}`, ...closure }) };
  };
  const prediction = (by) => ({ signal: 'blockingLatest <= 0', by });
  reviewRound(v7, ctx, a, { findings: 1 });
  reviewRound(v7, ctx, a, { findings: 1 });
  let d = decide('1', { action: 'continue', rationale: 'The fix is one round away.', prediction: prediction(3) });
  ok(v7.run(root, ['strategy', 'record', '--closure', d.file, '--attempt', a.id]));
  reviewRound(v7, ctx, a, { findings: 1 }); // round 3 still has a blocking finding: the first prediction is missed
  assert.deepEqual(v7.signals(root, a.id).strategy.decisions.map((x) => x.prediction_status.status), ['missed']);
  assert.equal(v7.signals(root, a.id).strategy.missedPredictionsInARow, 1);
  d = decide('2', { action: 'continue', rationale: 'One more round.', prediction: prediction(4) });
  assert.deepEqual(d.bundle.predictions, { missedInARow: 1, escalateRequired: false });
  ok(v7.run(root, ['strategy', 'record', '--closure', d.file, '--attempt', a.id]));
  assert.equal(v7.state(root, a.id).strategy.outcomes.S1.status, 'missed', 'recorded with the next decision');
  reviewRound(v7, ctx, a, { findings: 1 }); // round 4: the second prediction is missed too
  assert.equal(v7.signals(root, a.id).strategy.missedPredictionsInARow, 2);
  assert.match(ok(v7.run(root, ['signals', '--attempt', a.id])).out, /strategist predictions missed in a row: 2; its next decision must be an escalation/);
  d = decide('3', { action: 'continue', rationale: 'Third time lucky.', prediction: prediction(5) });
  assert.deepEqual(d.bundle.predictions, { missedInARow: 2, escalateRequired: true });
  assert.match(d.bundle.instructions, /the only action the engine accepts now is `escalate`/);
  const refused = v7.run(root, ['strategy', 'record', '--closure', d.file, '--attempt', a.id]);
  assert.equal(refused.code, 75);
  assert.match(refused.err, /answered only by `escalate`/);
  assert.ok(refusalRows(root).some((x) => x.id === 'strategy:escalate-required'));
  // The closure must carry 2 or 3 options; the engine creates the owner's decision from them.
  const noOptions = strategistClosure(base, d.h.bundle, { strategist: 'strat-3', action: 'escalate', rationale: 'Two predictions missed.', prediction: prediction(5) });
  assert.match(v7.run(root, ['strategy', 'record', '--closure', noOptions.file, '--attempt', a.id]).err, /action escalate needs `options`/);
  const esc = strategistClosure(base, d.h.bundle, { strategist: 'strat-3', action: 'escalate', rationale: 'Two predictions missed; the owner chooses between splitting the work and abandoning it.', prediction: prediction(5), options: ['split', 'abandon'] });
  const rec = ok(v7.run(root, ['strategy', 'record', '--closure', esc.file, '--attempt', a.id, '--json'])).json();
  assert.equal(rec.escalation, 'A1');
  const decisions = ok(v7.run(root, ['decisions', '--attempt', a.id])).out;
  assert.match(decisions, /A1 {2}escalation {2}pending \(split \| abandon\)/);
  // Handoffs stay refused until the owner decides it.
  // ownerSilent: the scripted owner must not answer the escalation here; the refusal itself is under test.
  const blocked = v7.run(root, ['handoff', 'reviewer', '--agent', 'rev-blocked', '--attempt', a.id, '--owner', a.owner], { ownerSilent: true });
  assert.equal(blocked.code, 75);
  assert.match(blocked.err, /escalated .* \(A1:/);
  assert.match(v7.state(root, a.id).decision.guidance, /wf approve A1/);
  assert.ok(refusalRows(root).some((x) => x.id === 'strategy:escalated'));
  const { approveInTerminal } = await import('../engine/approve.mjs');
  await inProcess(root, async () => {
    const input = Object.assign(new PassThrough(), { isTTY: true, setRawMode: () => {} });
    const output = Object.assign(new PassThrough(), { isTTY: true, columns: 80 });
    const pending = approveInTerminal(root, 'A1', { attempt: a.id }, { input, output, env: {} });
    setImmediate(() => input.write('split\n'));
    assert.equal((await pending).choice, 'split');
  });
  ok(v7.run(root, ['handoff', 'reviewer', '--agent', 'rev-free', '--attempt', a.id, '--owner', a.owner]));
  // The escalation answered, the streak starts again.
  assert.equal(v7.signals(root, a.id).strategy.missedPredictionsInARow, 0);
});

test('a split decision performs the split: a sibling in the same batch carries the moved work and the parent loses it', () => {
  const ctx = project('splitdec');
  const a = started(v7, ctx, { item: 'ENG-730', work: W, expect: { files: 4, rounds: 3, minutes: 120 } });
  const { root, base } = ctx;
  const agents = [0, 1, 2].map(() => reviewRound(v7, ctx, a, { findings: 1 }));
  // What cannot move: work that has code (an implementer), a criterion whose work item stays, a finding that blocks.
  const cannot = (items) => v7.run(root, ['split', '--items', items, '--reason', 'x', '--attempt', a.id]);
  assert.match(cannot('W1').err, /work item W1 already has an implementer/);
  assert.match(cannot('C1').err, /criterion C1 is covered by work item W1, which stays/);
  assert.match(cannot(`${agents[2]}:F1`).err, new RegExp(`${agents[2]}:F1 is on a line this attempt changed: its fix lives in this attempt's branch`));
  assert.match(cannot('nothing').err, /not a work item, criterion, open finding or open discovered issue/);
  const h = ok(v7.run(root, ['handoff', 'strategist', '--agent', 'strat-split', '--attempt', a.id, '--reason', 'the second module is unrelated to what keeps failing review', '--json'])).json();
  const missingSplit = strategistClosure(base, h.bundle, { strategist: 'strat-split', action: 'split', rationale: 'Move the second module out.', prediction: { signal: 'blockingLatest <= 1', by: 4 } });
  assert.match(v7.run(root, ['strategy', 'record', '--closure', missingSplit.file, '--attempt', a.id]).err, /action split needs `split: \{ items: \[ids\], reason \}`/);
  const c = strategistClosure(base, h.bundle, { strategist: 'strat-split', action: 'split', rationale: 'The second module is unrelated to what keeps failing review; it goes to a sibling.', prediction: { signal: 'blockingLatest <= 1', by: 4 }, split: { items: ['W2'], reason: 'second module split out of a runaway review' } });
  const rec = ok(v7.run(root, ['strategy', 'record', '--closure', c.file, '--attempt', a.id, '--json'])).json();
  assert.equal(rec.split.id, 'SPLIT-1');
  assert.deepEqual(rec.split.siblings, ['ENG-730.2']);
  assert.equal(rec.split.batch, 'BATCH-ENG-730.1');
  const parent = v7.state(root, a.id);
  assert.deepEqual(parent.criteria.map((x) => x.id), ['C1'], 'the moved criterion left the parent open set');
  assert.deepEqual(parent.work.map((x) => x.id), ['W1']);
  assert.equal(parent.batchOf, 'BATCH-ENG-730.1');
  assert.equal(parent.batchPending, true);
  assert.deepEqual(parent.strategy.moved, { work: ['W2'], criteria: ['C2'], findings: [], discovered: [] });
  assert.equal(parent.splits[0].siblings[0].id, 'ENG-730.2');
  assert.equal(parent.strategy.decisions[0].split.id, 'SPLIT-1');
  const sib = v7.state(root, 'ENG-730.2');
  assert.equal(sib.item, 'ENG-730');
  assert.equal(sib.phase, 'planned');
  assert.deepEqual(sib.criteria.map((x) => x.id), ['C2']);
  assert.deepEqual(sib.work.map((x) => x.id), ['W2']);
  assert.equal(sib.batchOf, 'BATCH-ENG-730.1');
  assert.equal(sib.batchPending, true);
  assert.equal(sib.deferHeavy, true);
  assert.equal(sib.splitFrom.attempt, a.id);
  assert.equal(sib.owner, parent.owner);
  assert.ok(sib.impact, 'the parent impact map travels with the obligations');
  assert.equal(sib.expect, null, 'the parent predicted the whole change; the sibling states its own expectation when it re-plans');
  assert.equal(sib.tracker.pending.length, 0, 'no second admission is sent to the tracker');
  // The parent cannot deliver on its own, and its reviewers are free again.
  assert.match(v7.run(root, ['deliver', '--attempt', a.id]).err, /is a member of BATCH-ENG-730\.1; deliver the batch instead/);
  assert.notEqual(v7.state(root, a.id).decision.kind, 'strategy');
  // 0.7.0: with more than one work item the combined tree passes `wf check` before a review.
  ok(v7.run(root, ['check', '--attempt', a.id, '--owner', a.owner]));
  ok(v7.run(root, ['handoff', 'reviewer', '--agent', 'rev-after-split', '--attempt', a.id, '--owner', a.owner]));
});


test('ten review rounds are the owner\'s decision: continue gives another ten, stop holds the attempt', async () => {
  // Named failure: one ticket ran 47 rounds before anyone stepped back. the person: "make it 10 and then raise it to me".
  // The scenario lowers the count to 2 to stay short.
  const ctx = project('owner-rounds', { strategy: { reviewRoundsEscalate: 2 } });
  const a = started(v7, ctx, { item: 'ENG-790' });
  const { root } = ctx;
  reviewRound(v7, ctx, a, { findings: 1 });
  reviewRound(v7, ctx, a, { findings: 1 });
  const sig = v7.signals(root, a.id);
  assert.equal(sig.strategy.escalation.firing.id, 'rounds-escalation');
  assert.equal(sig.strategy.escalation.firing.answeredBy, null);
  assert.match(v7.state(root, a.id).decision.guidance, /This is the person's decision: bring them the brief/);
  // The next handoff opens the decision; no strategist is involved.
  const refused = v7.run(root, ['handoff', 'reviewer', '--agent', 'rev-x', '--attempt', a.id, '--owner', a.owner], { ownerSilent: true });
  assert.equal(refused.code, 75);
  assert.match(refused.err, /2 review rounds handed; the owner decides how to continue \(A1\); no reviewer starts until the owner decides/);
  assert.match(ok(v7.run(root, ['decisions', '--attempt', a.id])).out, /A1 {2}escalation {2}pending \(continue \| split \| deliver-core \| stop\)/);
  const { approveInTerminal } = await import('../engine/approve.mjs');
  const answer = (id, choice) => inProcess(root, async () => {
    const input = Object.assign(new PassThrough(), { isTTY: true, setRawMode: () => {} });
    const output = Object.assign(new PassThrough(), { isTTY: true, columns: 80 });
    const pending = approveInTerminal(root, id, { attempt: a.id }, { input, output, env: {} });
    setImmediate(() => input.write(`${choice}\n`));
    return pending;
  });
  await answer('A1', 'continue');
  // Continue: another two rounds before the owner is asked again. The count is the rounds handed, recorded or not: the
  // second of these is a reviewer that was handed the tree and never recorded a closure (a dead session), and it counts.
  reviewRound(v7, ctx, a, { findings: 1, tag: 'c1' });
  ok(v7.run(root, ['handoff', 'reviewer', '--agent', 'rev-dead', '--attempt', a.id, '--owner', a.owner]));
  const counted = v7.signals(root, a.id);
  assert.deepEqual([counted.rounds.length, counted.roundsHanded], [3, 4], 'three recorded, four handed');
  const again = v7.run(root, ['handoff', 'reviewer', '--agent', 'rev-y', '--attempt', a.id, '--owner', a.owner], { ownerSilent: true });
  assert.match(again.err, /4 review rounds handed; the owner decides how to continue \(A2\)/);
  await answer('A2', 'stop');
  // Stop: the attempt is held in the owner's words; only he lifts it.
  const held = v7.run(root, ['handoff', 'reviewer', '--agent', 'rev-z', '--attempt', a.id, '--owner', a.owner], { ownerSilent: true });
  assert.equal(held.code, 75);
  assert.match(held.err, /the owner chose stop at A2/);
  assert.match(v7.state(root, a.id).activeHold.reason, /the owner chose stop at the escalation A2/);
});

// 0.7.11, named failure: a strategist's escalation reached the person as its own rationale with options like
// "authorize-policy-correction", no description and no recommendation ("very cryptic … I don't have context, nor
// suggestions, nor even proper description"). An escalation is now a plain question with labelled options, what follows each,
// and a recommendation when there is one; the person answers by the label.
test('an escalation is a plain question: labelled options with what follows each, a recommendation, answered by its label', async () => {
  const cur = runner('0.7.11');
  const ctx = project('plain-escalation');
  const a = started(cur, ctx, { item: 'ENG-730' });
  const { root, base } = ctx;
  reviewRound(cur, ctx, a, { findings: 1 });
  const h = ok(cur.run(root, ['handoff', 'strategist', '--agent', 'strat-1', '--attempt', a.id, '--reason', 'the same finding keeps coming back', '--json'])).json();
  const prediction = { signal: 'blockingLatest <= 0', by: 3 };
  const legacy = strategistClosure(base, h.bundle, { strategist: 'strat-1', action: 'escalate', rationale: 'r', prediction, options: ['authorize-policy-correction', 'retain-blocked'] });
  const refused = cur.run(root, ['strategy', 'record', '--closure', legacy.file, '--attempt', a.id]);
  assert.notEqual(refused.code, 0);
  assert.match(refused.err, /action escalate needs `question`: in plain words/);
  assert.match(refused.err, /2 or 3 of \{ "label": "<plain words/);
  const plain = strategistClosure(base, h.bundle, { strategist: 'strat-1', action: 'escalate', rationale: 'The same finding came back after two fixes.', prediction,
    question: 'The same problem came back after two fixes. Should the work that keeps reopening move to its own ticket?',
    options: [{ label: 'Move it to its own ticket', then: 'this ticket ships what is done; the rest is planned again' }, { label: 'Keep fixing it here', then: 'another fix and review round starts now' }],
    recommend: { label: 'Move it to its own ticket', why: 'two fixes did not hold' } });
  const rec = ok(cur.run(root, ['strategy', 'record', '--closure', plain.file, '--attempt', a.id, '--json'])).json();
  const d = cur.state(root, a.id).decisions.find((x) => x.id === rec.escalation);
  assert.deepEqual(d.choices, ['move-it-to-its-own-ticket', 'keep-fixing-it-here']);
  assert.equal(d.plain, 'The same problem came back after two fixes. Should the work that keeps reopening move to its own ticket?');
  assert.deepEqual(d.recommend, { choice: 'move-it-to-its-own-ticket', why: 'two fixes did not hold' });
  const blocked = cur.run(root, ['handoff', 'reviewer', '--agent', 'rev-x', '--attempt', a.id, '--owner', a.owner], { ownerSilent: true });
  assert.equal(blocked.code, 75);
  assert.match(blocked.err, new RegExp(`the question "${a.id.replace('.', '\\.')} ${d.id}: The same problem came back after two fixes\\. Should the work that keeps reopening move to its own ticket\\?"`));
  assert.match(blocked.err, /"Move it to its own ticket \(Recommended\)": this ticket ships what is done; the rest is planned again; "Keep fixing it here": another fix and review round starts now\. Recommended because two fixes did not hold/);
  const { approveInTerminal } = await import('../engine/approve.mjs');
  await inProcess(root, async () => {
    const input = Object.assign(new PassThrough(), { isTTY: true, setRawMode: () => {} });
    const output = Object.assign(new PassThrough(), { isTTY: true, columns: 80 });
    const pending = approveInTerminal(root, d.id, { attempt: a.id }, { input, output, env: {} });
    setImmediate(() => input.write('Keep fixing it here\n'));
    assert.equal((await pending).choice, 'keep-fixing-it-here', 'the person answers by the label');
  });
});
