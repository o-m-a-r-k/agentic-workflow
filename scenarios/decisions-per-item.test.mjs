import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { approveAsOwner, closureFile, commitIn, criteriaFile, goodClosure, makeRepo, ok, sh, singleRepoProject, state, tmp, wf, write, yaml } from './helpers.mjs';
import { knownLimits } from '../engine/tracker.mjs';
import { loadState } from '../engine/ledger.mjs';

// 0.7.8, D18, named failure (field): the person was asked one yes/no question about three items at once, in the reviewers'
// own long text; they could neither understand it nor fix one and let another go, and their written answer ("fix all
// here, except F3 if it is in ENG-636") was not a choice, so the question stayed open. They also found 0.7.7 too tight:
// it asked them about ratings, ejections and dropped criteria they never wanted to decide.

const silent = { ownerSilent: true };
const CLAUDE = 'c1aude00-0000-4000-8000-00000000d018';
const at = (offsetMs = 0) => new Date(Date.now() + offsetMs).toISOString();
const LINES = 'l1\nl2\nl3\nl4\nl5\nl6\n';

function project(name, config = {}) {
  const p = singleRepoProject(name, { gate: { steps: [{ id: 'unit', repo: 'app', run: 'true' }] }, ...config }, { 'src/a.txt': LINES, 'src/old.txt': 'o1\no2\no3\n' });
  const e = ok(wf(p.root, ['entry', '--item', 'PI-1', '--owner', 'o', '--json'])).json();
  ok(wf(p.root, ['handoff', 'planner', '--agent', 'p', '--attempt', e.id]));
  ok(wf(p.root, ['plan', '--file', criteriaFile(p.base), '--attempt', e.id]));
  ok(wf(p.root, ['handoff', 'implementer', '--agent', 'i', '--attempt', e.id]));
  commitIn(e.repos.app.worktree, { 'src/a.txt': LINES.replace('l2', 'L2') });
  ok(wf(p.root, ['handoff', 'close', '--agent', 'i', '--attempt', e.id]));
  ok(wf(p.root, ['handoff', 'reviewer', '--agent', 'r1', '--attempt', e.id]));
  const finding = (id, severity, evidence) => ({ id, severity, summary: `${id}: ${evidence}. More detail the reviewer wrote at length about the reason and the files involved.`, status: 'open', evidence });
  const closure = goodClosure('r1', { findings: [finding('F1', 'low', 'src/old.txt:2 the XML button is never clicked by a test'), finding('F2', 'low', 'src/old.txt:3 payment history says Succeeded beside a partial credit'), finding('F3', 'medium', 'src/old.txt:1 the export sums one page only')] });
  ok(wf(p.root, ['review', '--closure', closureFile(p.base, closure), '--attempt', e.id]));
  return { ...p, id: e.id, wt: e.repos.app.worktree };
}
const run = (p, args, opts = silent) => wf(p.root, [...args, '--attempt', p.id], opts);
const asked = (r) => [...r.err.matchAll(/wf approve (A\d+) --from-question/g)].map((m) => m[1]);

test('each item is its own short question; the person fixes one and lets another leave', () => {
  const p = project('pi-each');
  const r = run(p, ['scope', 'defer', '--finding', 'r1:F1,r1:F2']);
  assert.equal(r.code, 75);
  const ids = asked(r);
  assert.equal(ids.length, 2, 'one question per item');
  const [q1, q2] = ids.map((id) => state(p.root, p.id).decisions.find((d) => d.id === id));
  assert.deepEqual(q1.choices, ['let it leave', 'fix now']);
  assert.match(q1.summary, /^r1:F1: src\/old\.txt:2 the XML button is never clicked by a test \(low, rated by reviewer r1, old\.txt:2\)\. Fix it now, or let it leave this delivery as a known issue\?$/);
  assert.doesNotMatch(q1.summary, /More detail the reviewer wrote/, 'the reviewer\'s long text stays in the record, not in the question');
  approveAsOwner(p.root, p.id, q1.id, 'let it leave');
  approveAsOwner(p.root, p.id, q2.id, 'fix now');
  const mixed = run(p, ['scope', 'defer', '--finding', 'r1:F1,r1:F2']);
  assert.match(mixed.err, /the person chose to fix r1:F2 \(A\d+\) now/);
  assert.equal(mixed.code, 75);
  ok(run(p, ['scope', 'defer', '--finding', 'r1:F1']));
  const s = state(p.root, p.id);
  assert.deepEqual(s.scopeDecisions.at(-1).keys, ['r1:F1']);
  assert.deepEqual(s.scopeDecisions.at(-1).decisionFor, { 'r1:F1': q1.id });
});

test('what the person chose to fix reaches the reviewers who rate similar items, in the project (0.7.9, D19)', () => {
  const p = project('pi-learn');
  const [q1, q2] = asked(run(p, ['scope', 'defer', '--finding', 'r1:F1,r1:F2']));
  approveAsOwner(p.root, p.id, q1, 'let it leave');
  approveAsOwner(p.root, p.id, q2, 'fix now');
  const h = ok(wf(p.root, ['handoff', 'reviewer', '--agent', 'r2', '--attempt', p.id, '--json'])).json();
  const fixed = JSON.parse(fs.readFileSync(h.bundle, 'utf8')).severityScale.personFixed;
  assert.equal(fixed.length, 1, 'a "let it leave" answer teaches nothing');
  assert.equal(fixed[0].answer, 'fix now');
  assert.match(fixed[0].item, /^r1:F2: src\/old\.txt:3 payment history says Succeeded beside a partial credit \(low, rated by reviewer r1/);
  const impl = ok(wf(p.root, ['handoff', 'implementer', '--agent', 'i3', '--attempt', p.id, '--json'])).json();
  assert.equal(JSON.parse(fs.readFileSync(impl.bundle, 'utf8')).severityScale.personFixed, undefined, 'only the reviewer rates');
});

test('the owner can word each question plainly with --explain', () => {
  const p = project('pi-explain');
  const explain = path.join(p.base, 'explain.json');
  fs.writeFileSync(explain, JSON.stringify({ 'r1:F1': { what: 'The Download XML button has no test that clicks it', fix: 'One test and a screenshot, on the next gate' } }));
  const r = run(p, ['scope', 'defer', '--finding', 'r1:F1', '--explain', explain]);
  assert.match(r.err, /"PI-1\.1 A\d+: r1:F1: The Download XML button has no test that clicks it \(low, rated by reviewer r1, old\.txt:2\)/);
  assert.match(r.err, /"fix now" \(One test and a screenshot, on the next gate\)/);
});

test('an answer in the person\'s own words is recorded as theirs, and a changed question is withdrawn and asked again', () => {
  const p = project('pi-words');
  const r = run(p, ['scope', 'defer', '--finding', 'r1:F1']);
  const id = asked(r)[0];
  const d = state(p.root, p.id).decisions.find((x) => x.id === id);
  const question = `${p.id} ${d.id}: ${d.summary}`;
  // Claude Code's record of the question panel: the person typed their own answer.
  const file = path.join(p.base, '.home', '.claude', 'projects', 'proj', `${CLAUDE}.jsonl`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tool = 'toolu_pi_words';
  const words = 'fix it here unless it is already in ENG-636';
  fs.writeFileSync(file, [
    { type: 'assistant', timestamp: at(1000), message: { role: 'assistant', content: [{ type: 'tool_use', id: tool, name: 'AskUserQuestion', input: { questions: [{ question, header: 'r1:F1', multiSelect: false, options: [{ label: 'let it leave', description: 'known issue' }, { label: 'fix now', description: 'next pass' }] }] } }] } },
    { type: 'user', timestamp: at(1000), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: tool, content: `Your questions have been answered: "${question}"="${words}".` }] }, toolUseResult: { questions: [], answers: { [question]: words } } },
  ].map((l) => JSON.stringify(l)).join('\n') + '\n');
  const env = { CLAUDE_CODE_SESSION_ID: CLAUDE };
  const answered = ok(wf(p.root, ['approve', id, '--from-question', '--attempt', p.id], { env, ...silent }));
  assert.match(answered.out, /in the person's own words: "fix it here unless it is already in ENG-636"/);
  const recorded = state(p.root, p.id).decisions.find((x) => x.id === id).approved;
  assert.deepEqual([recorded.choice, recorded.words], ['other', words]);
  const follow = run(p, ['scope', 'defer', '--finding', 'r1:F1']);
  assert.match(follow.err, /the person answered r1:F1 in their own words, "fix it here unless it is already in ENG-636" \(A\d+\), which is neither choice/);
  assert.match(follow.err, /if they mean "let it leave", withdraw the answer with their words as the reason/);
  assert.match(wf(p.root, ['decisions', 'withdraw', id, '--attempt', p.id]).err, /--reason says what changed/);
  ok(wf(p.root, ['decisions', 'withdraw', id, '--reason', 'it is in ENG-636 after all: ask again', '--attempt', p.id]));
  assert.notEqual(state(p.root, p.id).phase, 'done', 'withdrawing a question never closes the attempt');
  const again = run(p, ['scope', 'defer', '--finding', 'r1:F1']);
  assert.equal(again.code, 75);
  assert.notEqual(asked(again)[0], id, 'a fresh question');
  assert.match(ok(wf(p.root, ['decisions', '--all', '--attempt', p.id])).out, new RegExp(`${id} {2}move-out-of-batch {2}withdrawn: it is in ENG-636 after all`));
});

test('the project\'s `leaving:` policy decides who lets each level go', () => {
  const owner = project('pi-policy-owner', { leaving: { medium: 'owner' } });
  assert.match(run(owner, ['scope', 'defer', '--finding', 'r1:F3']).err, /may leave on your judgement under the project's `leaving:` policy: say why it waits/);
  ok(run(owner, ['scope', 'defer', '--finding', 'r1:F3', '--reason', 'the export page is rebuilt next']));
  assert.deepEqual(state(owner.root, owner.id).scopeDecisions.at(-1).decisionFor, { 'r1:F3': 'owner' });
  assert.equal((state(owner.root, owner.id).decisions ?? []).length, 0, 'nothing was put to the person');
  const strict = project('pi-policy-never', { leaving: { low: 'never' } });
  const r = run(strict, ['scope', 'defer', '--finding', 'r1:F1']);
  assert.match(r.err, /low: never leaves .*\(the project's `leaving:` policy\)/);
  const bad = singleRepoProject('pi-policy-bad', { leaving: { medium: 'maybe' } });
  assert.match(wf(bad.root, ['doctor', '--no-steps']).err + wf(bad.root, ['doctor', '--no-steps']).out, /`leaving\.medium` is never, person or owner, not `maybe`/);
});

test('the project\'s own severity examples reach the roles that rate', () => {
  const p = project('pi-scale', { severity: { high: ['anything that changes a customer invoice, tax document or payment'] } });
  const h = ok(wf(p.root, ['handoff', 'implementer', '--agent', 'i2', '--attempt', p.id, '--json'])).json();
  const bundle = JSON.parse(fs.readFileSync(h.bundle, 'utf8'));
  assert.deepEqual(bundle.severityScale.projectExamples.high, ['anything that changes a customer invoice, tax document or payment']);
  assert.deepEqual(bundle.severityScale.leaving, { high: 'never', medium: 'never', low: 'person' });
});

test('lowering a rating into low is a reason, not a question; the person sees it when the item is proposed to leave', () => {
  const p = project('pi-rate');
  ok(run(p, ['discovered', 'add', '--summary', 'a stale screenshot in the ignored folder', '--severity', 'medium']));
  ok(run(p, ['discovered', 'rate', 'D1', '--severity', 'low', '--reason', 'an ignored folder']));
  assert.equal((state(p.root, p.id).decisions ?? []).length, 0);
  const r = run(p, ['scope', 'defer', '--finding', 'D1']);
  assert.match(r.err, /D1: a stale screenshot in the ignored folder \(low, rated by [^,]+, re-rated medium to low \(an ignored folder\)\)/);
});

test('fixes no reviewer saw and a sibling that left are told to the tester, not stops (I-123)', () => {
  const p = project('pi-limits');
  ok(run(p, ['discovered', 'add', '--summary', 'the export sums one page only', '--severity', 'medium']));
  commitIn(p.wt, { 'src/old.txt': 'o1 fixed\no2\no3\n' }, 'fix the export');
  ok(run(p, ['discovered', 'close', 'D1', '--fixed', sh(p.wt, 'git rev-parse HEAD')]));
  const limits = knownLimits(loadState(p.root, p.id), { load: (id) => loadState(p.root, id) });
  assert.match(limits, /Closed as fixed after the last review, not verified by a reviewer: PI-1\.1:D1 \(medium\): the export sums one page only/);
  // A moved finding whose sibling is not delivered with this attempt reads as still open there.
  const fake = { ...loadState(p.root, p.id), batchOf: 'BATCH-X', scopeDecisions: [{ choice: 'moved', keys: ['r1:F3'], sibling: 'PI-9.1', reason: 'belongs there' }] };
  const told = knownLimits(fake, { load: () => ({ phase: 'abandoned', batchOf: null }) });
  assert.match(told, /Moved to PI-9\.1, which is not in this delivery \(abandoned\): r1:F3 is still open there/);
  const together = knownLimits(fake, { load: () => ({ phase: 'implementing', batchOf: 'BATCH-X' }) });
  assert.match(together, /Follow-up moved to PI-9\.1 for r1:F3/);
});

test('the base gaining commits that no workflow delivery covered is named in resume (I-119)', () => {
  const p = project('pi-base');
  commitIn(p.root, { 'src/b.txt': 'merged by hand\n' }, 'Merge a change by hand');
  sh(p.root, 'git push -q origin main');
  const out = ok(wf(p.root, ['resume', '--attempt', p.id])).out;
  assert.match(out, /1 of them reached origin\/main without a workflow delivery, so no gate passed them \(Merge a change by hand\): a gate failure may come from the base/);
});

test('an implementer is closed when its own repos are committed, whatever another implementer has in progress (I-124)', async () => {
  const { C, planFile } = await import('./strategist-fixtures.mjs');
  const base = tmp('pi-scoped');
  const root = path.join(base, 'proj');
  fs.mkdirSync(root);
  const cfg = { version: 1, enabled: true, name: 'pi-scoped', adapterRepo: 'api', repos: [{ name: 'api', path: 'api', base: 'main' }, { name: 'web', path: 'web', base: 'main' }], lanes: ['quick', 'standard', 'batch'], gate: { steps: [{ id: 'api-unit', repo: 'api', run: 'true', inputs: ['src/**'] }, { id: 'web-unit', repo: 'web', run: 'true', inputs: ['src/**'] }] } };
  makeRepo(path.join(root, 'api'), { '.workflow/project.yaml': yaml(cfg), 'src/a.txt': 'a\n' });
  makeRepo(path.join(root, 'web'), { 'src/w.txt': 'w\n' });
  fs.symlinkSync(path.join('api', '.workflow'), path.join(root, '.workflow'));
  const e = ok(wf(root, ['entry', '--item', 'PI-2', '--owner', 'o', '--json'])).json();
  ok(wf(root, ['handoff', 'planner', '--agent', 'plan', '--attempt', e.id]));
  const work = [{ id: 'W1', criteria: ['C1'], repos: ['api'], class: 'full', why: 'the api half' }, { id: 'W2', criteria: ['C2'], repos: ['web'], class: 'full', why: 'the web half' }];
  ok(wf(root, ['plan', '--file', planFile(base, { criteria: C, work }), '--attempt', e.id]));
  ok(wf(root, ['handoff', 'implementer', '--agent', 'i-api', '--work', 'W1', '--attempt', e.id], { implementersOpen: true }));
  ok(wf(root, ['handoff', 'implementer', '--agent', 'i-web', '--work', 'W2', '--attempt', e.id], { implementersOpen: true }));
  commitIn(e.repos.api.worktree, { 'src/a.txt': 'api done\n' });
  write(e.repos.web.worktree, 'src/w.txt', 'web half-way\n');
  ok(wf(root, ['handoff', 'close', '--agent', 'i-api', '--attempt', e.id]), 'the api implementer is done although the web one is mid-way');
  const web = wf(root, ['handoff', 'close', '--agent', 'i-web', '--attempt', e.id]);
  assert.notEqual(web.code, 0);
  assert.match(web.err, /i-web is not done: uncommitted changes in web/);
});

// Claude Code's record of a question-panel exchange in which the person typed their own answer.
function answeredInWords(base, question, words, tool, choices) {
  const file = path.join(base, '.home', '.claude', 'projects', 'proj', `${CLAUDE}.jsonl`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, [
    { type: 'assistant', timestamp: at(1000), message: { role: 'assistant', content: [{ type: 'tool_use', id: tool, name: 'AskUserQuestion', input: { questions: [{ question, header: 'wf', multiSelect: false, options: choices.map((label) => ({ label, description: label })) }] } }] } },
    { type: 'user', timestamp: at(1000), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: tool, content: `answered` }] }, toolUseResult: { questions: [], answers: { [question]: words } } },
  ].map((l) => JSON.stringify(l)).join('\n') + '\n');
}

test('an escalation answered in the person\'s own words stays open: words never act as a choice', async () => {
  const { project: proj, runner: rn, started, reviewRound } = await import('./strategist-fixtures.mjs');
  const r = rn('0.7.8');
  const ctx = proj('pi-escalate', { strategy: { reviewRoundsEscalate: 1 } });
  const a = started(r, ctx, { item: 'ENG-990' });
  reviewRound(r, ctx, a, { findings: 1 });
  const held = r.run(ctx.root, ['handoff', 'implementer', '--agent', 'impl-2', '--attempt', a.id, '--owner', a.owner], silent);
  assert.equal(held.code, 75);
  const id = held.err.match(/wf approve (A\d+)/)[1];
  const d = r.state(ctx.root, a.id).decisions.find((x) => x.id === id);
  const words = 'stop, this is going nowhere; park it';
  answeredInWords(ctx.base, `${a.id} ${d.id}: ${d.plain ?? d.summary}`, words, 'toolu_pi_escalate', d.choices.map((c) => d.labels?.[c] ?? c));
  ok(r.run(ctx.root, ['approve', id, '--from-question', '--attempt', a.id], { env: { CLAUDE_CODE_SESSION_ID: CLAUDE }, ...silent }));
  assert.match(r.state(ctx.root, a.id).next, /answered in the person's own words, "stop, this is going nowhere; park it": follow that/, 'resume says what happened, not "answer the old question"');
  assert.match(r.run(ctx.root, ['approve', id, '--choice', 'stop', '--attempt', a.id], silent).err, /already decided/);
  const again = r.run(ctx.root, ['handoff', 'implementer', '--agent', 'impl-2', '--attempt', a.id, '--owner', a.owner], silent);
  assert.equal(again.code, 75, 'the words did not let the work continue');
  assert.match(again.err, /in their own words, "stop, this is going nowhere; park it": follow them/);
  const fresh = again.err.match(/wf approve (A\d+)/)[1];
  assert.notEqual(fresh, id, 'the escalation is asked again with its choices');
  // A withdrawn question is not an answer either: it cannot be approved, and the next handoff asks afresh.
  ok(r.run(ctx.root, ['decisions', 'withdraw', fresh, '--reason', 'reworded the brief', '--attempt', a.id]));
  assert.match(r.run(ctx.root, ['approve', fresh, '--choice', 'continue', '--attempt', a.id], silent).err, /was withdrawn/);
  const third = r.run(ctx.root, ['handoff', 'implementer', '--agent', 'impl-2', '--attempt', a.id, '--owner', a.owner], silent);
  assert.equal(third.code, 75, 'still held');
  assert.notEqual(third.err.match(/wf approve (A\d+)/)[1], fresh);
});


// I-142 (the person's rule, 2026-10-15): the person told a session to leave a legacy part unchanged, and nothing let a high or
// medium item leave even on their answer. When the person directs it, each such item is their own question; an agent never
// lets it go.
test('a medium or high item the person directs out of the ticket leaves on their own answer to it, never an agent\'s', () => {
  const p = project('pi-directed');
  const refused = run(p, ['scope', 'defer', '--finding', 'r1:F3']);
  assert.equal(refused.code, 75);
  assert.match(refused.err, /r1:F3 \(medium\) stays in this delivery/);
  assert.match(refused.err, /if the person told you to leave it out of this ticket, run this again with `--person-directed "<their words>"`/);
  const asked = run(p, ['scope', 'defer', '--finding', 'r1:F3', '--person-directed', 'leave the old export as it is']);
  assert.equal(asked.code, 75);
  const [id] = asked.err.match(/wf approve (A\d+) --from-question/).slice(1);
  const d = state(p.root, p.id).decisions.find((x) => x.id === id);
  assert.match(d.summary, /Your rule fixes medium items in the delivery; you asked to leave this out: "leave the old export as it is"\./);
  approveAsOwner(p.root, p.id, id, 'let it leave');
  ok(run(p, ['scope', 'defer', '--finding', 'r1:F3', '--person-directed', 'leave the old export as it is']));
  assert.deepEqual(state(p.root, p.id).scopeDecisions.at(-1).keys, ['r1:F3']);
});
