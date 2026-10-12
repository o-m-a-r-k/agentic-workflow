// Named failure: a delivery-tooling change accumulated unrelated portal repairs from passing broad checks.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { blockingFindings, scopeProblems, scopeKey, scopeHandoffProblems } from '../engine/scope-decisions.mjs';
import { readLedger } from '../engine/ledger.mjs';
import { closureFile, commitIn, criteriaFile, goodClosure, ok, singleRepoProject, state, wf, ownerSays, sh, stages } from './helpers.mjs';

const resources = [];
after(() => { for (const p of resources) {
  const id = p.id ?? 'SC-1.1';
  ok(wf(p.root, ['abandon', '--reason', 'scenario cleanup', '--attempt', id]));
  ok(wf(p.root, ['evidence', 'release', '--attempt', id]));
  fs.rmSync(p.base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
} });
const scope = (issue = 'portal-unused-import') => ({ kind: 'extra', issue, reason: 'Independent portal warning predates the delivery adapter change; the required lint command executes and passes.', baseEvidence: 'base:portal.js:1 unused import', currentEvidence: 'portal.js:1 unchanged unused import', requiredByRequest: false, causedByChange: false, affectsChangedContract: false, requiredValidation: false });
const finding = (extra = {}) => ({ id: 'F1', severity: 'minor', status: 'open', summary: 'Existing portal unused import', evidence: 'portal.js:1', scope: scope(), ...extra });
function project(name, gate = 'echo existing-warning') {
  const p = singleRepoProject(name, { impact: { requiredFor: [] }, gate: { steps: [{ id: 'lint', repo: 'app', run: gate }] } }, { 'portal.js': 'unused import\n', 'delivery.mjs': 'link only\n' });
  resources.push(p);
  const e = ok(wf(p.root, ['entry', '--item', 'SC-1', '--owner', 'owner', '--json'])).json();
  ok(wf(p.root, ['handoff', 'planner', '--agent', 'planner', '--attempt', e.id]));
  ok(wf(p.root, ['plan', '--file', criteriaFile(p.base), '--attempt', e.id]));
  ok(wf(p.root, ['handoff', 'implementer', '--agent', 'impl', '--attempt', e.id]));
  commitIn(e.repos.app.worktree, { 'delivery.mjs': 'create merge request\n' });
  p.id = e.id;
  const owner = state(p.root, e.id).owner;
  const home = path.join(p.base, '.home');
  ownerSays(home, owner, 'Work on the delivery adapter.');
  const sid = owner.split(':').slice(1).join(':');
  const file = path.join(home, '.codex', 'sessions', `rollout-scenario-${sid}.jsonl`);
  fs.appendFileSync(file, JSON.stringify({ type: 'session_meta', payload: { id: sid, originator: 'codex_cli_rs', source: 'cli' } }) + '\n');
  return { ...p, ...e, owner, home, wt: e.repos.app.worktree };
}
function review(p, reviewer, findings = [finding()]) {
  ok(wf(p.root, ['handoff', 'reviewer', '--agent', reviewer, '--attempt', p.id]));
  return wf(p.root, ['review', '--closure', closureFile(p.base, goodClosure(reviewer, { findings })), '--attempt', p.id]);
}
function choose(p, choice, words) {
  const asked = ok(wf(p.root, ['scope', 'ask', '--attempt', p.id, '--json'])).json();
  assert.deepEqual(asked.options, ['Increase scope and fix', 'Create tickets for later', 'Ignore for this attempt']);
  ownerSays(p.home, p.owner, words);
  return wf(p.root, ['scope', 'decide', '--choice', choice, '--attempt', p.id], { ownerSilent: true });
}

function scopeQuestion(p, answer, call = 'call_scope', extra = {}) {
  const sid = p.owner.split(':').slice(1).join(':');
  const file = path.join(p.home, '.codex', 'sessions', `rollout-scenario-${sid}.jsonl`);
  const title = 'Include the prepared responsive layout fix with this ticket?';
  const row = { questionItemId: JSON.stringify(['request_user_input_async', call, 0]), question: title, answer, ...extra };
  const records = [
    { type: 'response_item', payload: { type: 'function_call', name: 'functions.request_user_input_async', call_id: call,
      arguments: JSON.stringify({ questions: [{ title, options: ['Increase scope and include the responsive fix', 'Create tickets for later', 'Ignore for this attempt'] }] }) } },
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: `<send_user_message_question_reply>\n${JSON.stringify([row])}\n</send_user_message_question_reply>` }] } },
  ];
  fs.appendFileSync(file, records.map(r => JSON.stringify({ ...r, timestamp: new Date().toISOString() })).join('\n') + '\n');
  return file;
}

// Named failure: a genuine selected scope option with a fix description was decoded,
// then rejected by the phrase matcher and the owner was asked to repeat magic words.
test('a descriptive desktop scope choice expands once without a repeated owner approval', () => {
  const p = project('scope-described-option');
  ok(review(p, 'r1'));
  ok(wf(p.root, ['scope', 'ask', '--attempt', p.id]));
  const answer = 'Increase scope and include the responsive fix';
  scopeQuestion(p, answer);
  ok(wf(p.root, ['scope', 'decide', '--choice', 'expand', '--attempt', p.id], { ownerSilent: true }));
  const decision = state(p.root, p.id).scopeDecisions.at(-1);
  assert.equal(decision.choice, 'expand');
  assert.equal(decision.all, false);
  assert.equal(decision.authority.text, answer);
  assert.deepEqual(decision.authority.questionReply, { tool: 'request_user_input_async', callId: 'call_scope', index: 0 });
  assert.equal(readLedger(p.root, p.id).filter(e => e.type === 'scope.decided').length, 1);
  assert.equal(wf(p.root, ['scope', 'decide', '--choice', 'expand', '--attempt', p.id], { ownerSilent: true }).code, 75);
  const later = { ...state(p.root, p.id), reviews: [{ reviewer: 'r2', closure: { findings: [finding({ scope: scope('new-independent-defect') })] } }] };
  assert.match(scopeHandoffProblems(later).join(' '), /await the owner decision/);
});

test('descriptive scope choices reject conditions, negation, other decisions and forged bindings', () => {
  const p = project('scope-described-refusal');
  ok(review(p, 'r1'));
  ok(wf(p.root, ['scope', 'ask', '--attempt', p.id]));
  const answers = [
    'Increase scope and include the responsive fix if necessary',
    'Increase scope and include the responsive fix only after approval',
    'Increase scope and include the responsive fix but do not apply it',
    'Increase scope and include all future fixes',
    'Increase scope and include the responsive fix and ignore another defect',
    'Increase scope and include the responsive fix and push',
    'The reviewer said increase scope and include the responsive fix',
    'No',
  ];
  for (const [i, answer] of answers.entries()) {
    scopeQuestion(p, answer, `call_decline_${i}`);
    assert.equal(wf(p.root, ['scope', 'decide', '--choice', 'expand', '--attempt', p.id], { ownerSilent: true }).code, 75, answer);
  }
  scopeQuestion(p, 'Increase scope and include the responsive fix', 'call_forged', { question: 'A different question' });
  assert.equal(wf(p.root, ['scope', 'decide', '--choice', 'expand', '--attempt', p.id], { ownerSilent: true }).code, 75);
  assert.equal(state(p.root, p.id).scopeDecisions.length, 0);
});

test('descriptive desktop approval must follow the scope ask and remains revocable', () => {
  const p = project('scope-question-bounds');
  ok(review(p, 'r1'));
  const answer = 'Increase scope and include the responsive fix';
  scopeQuestion(p, answer, 'call_before_scope');
  ok(wf(p.root, ['scope', 'ask', '--attempt', p.id]));
  assert.equal(wf(p.root, ['scope', 'decide', '--choice', 'expand', '--attempt', p.id], { ownerSilent: true }).code, 75);
  scopeQuestion(p, answer, 'call_then_revoked');
  ownerSays(p.home, p.owner, 'wait, do not increase scope');
  assert.equal(wf(p.root, ['scope', 'decide', '--choice', 'expand', '--attempt', p.id], { ownerSilent: true }).code, 75);
  scopeQuestion(p, answer + ' (Recommended)', 'call_confirmed');
  assert.equal(wf(p.root, ['scope', 'decide', '--choice', 'ignore', '--attempt', p.id], { ownerSilent: true }).code, 75);
  ok(wf(p.root, ['scope', 'decide', '--choice', 'expand', '--attempt', p.id], { ownerSilent: true }));
  const scopeFile = path.join(p.base, 'additional-scope.json');
  fs.writeFileSync(scopeFile, JSON.stringify(scope('later-independent-defect')));
  ok(wf(p.root, ['discovered', 'add', '--summary', 'Another independent warning', '--scope-file', scopeFile, '--attempt', p.id]));
  ok(wf(p.root, ['scope', 'ask', '--attempt', p.id]));
  scopeQuestion(p, answer + ' (Recommended)', 'call_confirmed');
  const rejected = wf(p.root, ['scope', 'decide', '--choice', 'expand', '--attempt', p.id], { ownerSilent: true });
  assert.equal(rejected.code, 75);
  assert.match(rejected.out + rejected.err, /explicit, unconditional expand decision/);
  assert.doesNotMatch(rejected.out + rejected.err, /starts with `scope/);
  assert.equal(state(p.root, p.id).scopeDecisions.length, 1);
});

test('scope is causal: missing, uncertain and change-related consumer findings always block', () => {
  const f = finding();
  const waived = { keys: [scopeKey(f)], choice: 'ignore' };
  for (const actual of [finding({ scope: undefined }), finding({ scope: { kind: 'uncertain' } }), finding({ scope: { ...scope(), kind: 'in' } }), finding({ scope: { ...scope(), causedByChange: true } }), finding({ scope: { ...scope(), affectsChangedContract: true } }), finding({ scope: { ...scope(), requiredValidation: true } })]) {
    assert.equal(blockingFindings({ scopeDecisions: [waived] }, { closure: { findings: [actual] } }).length, 1);
  }
  assert.equal(scopeProblems([finding({ scope: { ...scope(), baseEvidence: '' } })]).length, 1);
  assert.equal(scopeProblems([finding({ scope: { ...scope(), requiredByRequest: true } })]).length, 1);
});

test('unrelated finding prompts before expansion; no reply, conditional reply or agent flags authorize repair', () => {
  const p = project('scope-wait');
  ok(review(p, 'r1'));
  assert.match(ok(wf(p.root, ['resume', '--attempt', p.id])).out, /Scope increase:[\s\S]*unrelated/);
  assert.equal(wf(p.root, ['handoff', 'implementer', '--agent', 'repair', '--attempt', p.id]).code, 75);
  ownerSays(p.home, p.owner, 'ignore'); // Before the question, even in the same millisecond: no authority.
  ok(wf(p.root, ['scope', 'ask', '--attempt', p.id]));
  assert.equal(wf(p.root, ['scope', 'decide', '--choice', 'ignore', '--attempt', p.id], { ownerSilent: true }).code, 75);
  for (const words of ['If necessary ignore', 'The reviewer said "ignore"', 'do not ignore']) {
    ownerSays(p.home, p.owner, words);
    assert.equal(wf(p.root, ['scope', 'decide', '--choice', 'ignore', '--attempt', p.id], { ownerSilent: true }).code, 75);
  }
  assert.equal(state(p.root, p.id).scopeDecisions.length, 0);
});

test('ignore applies only to proven extra scope, preserves source, gates and fresh evidence review, and does not recur as repairs', () => {
  const p = project('scope-ignore');
  ok(review(p, 'r1'));
  const head = sh(p.wt, 'git rev-parse HEAD');
  ok(choose(p, 'ignore', 'ignore these findings'));
  assert.equal(wf(p.root, ['accept', '--attempt', p.id]).code, 75, 'owner choice cannot replace a gate');
  ok(wf(p.root, ['gate', '--attempt', p.id]));
  assert.equal(wf(p.root, ['accept', '--attempt', p.id]).code, 75, 'fresh evidence review is still required');
  ok(review(p, 'r2'));
  assert.equal(blockingFindings(state(p.root, p.id)).length, 0);
  ok(wf(p.root, ['accept', '--attempt', p.id]));
  assert.equal(sh(p.wt, 'git rev-parse HEAD'), head);
  assert.equal(fs.readFileSync(path.join(p.wt, 'portal.js'), 'utf8'), 'unused import\n');
  const exported = ok(wf(p.root, ['export', '--json', '--attempt', p.id])).json();
  assert.ok(exported);
});

test('ticket choice waits for creation readback; failed creation stays blocking and successful capture stops repairs', () => {
  const p = project('scope-ticket');
  ok(review(p, 'r1'));
  ok(choose(p, 'ticket', 'create a ticket for later'));
  assert.equal(wf(p.root, ['gate', '--attempt', p.id]).code, 75);
  const capture = path.join(p.base, 'ticket.json');
  fs.writeFileSync(capture, JSON.stringify({ error: 'creation failed' }));
  assert.equal(wf(p.root, ['scope', 'ticket', '--finding', 'r1:F1', '--capture', capture, '--attempt', p.id]).code, 75);
  assert.equal(blockingFindings(state(p.root, p.id)).length, 1);
  fs.writeFileSync(capture, JSON.stringify({ issue: { id: 'later-1', title: 'Remove the existing portal warning', url: 'https://tracker.example.test/later-1' } }));
  ok(wf(p.root, ['scope', 'ticket', '--finding', 'r1:F1', '--capture', capture, '--attempt', p.id]));
  assert.equal(blockingFindings(state(p.root, p.id)).length, 0);
  ok(wf(p.root, ['gate', '--attempt', p.id]));
  const d = state(p.root, p.id).scopeDecisions.at(-1);
  assert.equal(d.ticket.provenance, 'agent-reported-raw-readback');
  assert.equal(fs.readFileSync(d.raw.file, 'utf8'), fs.readFileSync(capture, 'utf8'));
});

test('extra-scope choice cannot settle a simultaneous in-scope regression', () => {
  const p = project('scope-mixed');
  ok(review(p, 'r1', [finding(), finding({ id: 'F2', scope: { kind: 'in' }, summary: 'Changed adapter creates duplicate requests' })]));
  ok(choose(p, 'ignore', 'ignore'));
  assert.equal(wf(p.root, ['gate', '--attempt', p.id]).code, 75);
  assert.deepEqual(blockingFindings(state(p.root, p.id)).map((f) => f.id), ['F2']);
  assert.match(ok(wf(p.root, ['resume', '--attempt', p.id])).out, /fix the open findings \(F2\)/);
});

test('expand requires criteria and impact before repair; blanket expansion stays within its attempt and only extra scope', () => {
  const p = project('scope-expand');
  ok(review(p, 'r1'));
  ok(choose(p, 'expand-all', 'increase scope and continue fixing all'));
  assert.equal(wf(p.root, ['handoff', 'implementer', '--agent', 'repair', '--attempt', p.id]).code, 75);
  const key = scopeKey(finding());
  const amendment = path.join(p.base, 'amend.json');
  const addition = stages([{ id: 'C2' }], null, 'extra');
  fs.writeFileSync(amendment, JSON.stringify({ criteria: [{ id: 'C2', text: 'Remove the independent existing portal warning' }], scopeFindings: [key], impact: { ...addition.impact, survey: addition.survey } }));
  ok(wf(p.root, ['criteria', 'amend', '--file', amendment, '--reason', 'Owner approved the scope increase', '--attempt', p.id]));
  assert.equal(scopeHandoffProblems(state(p.root, p.id)).length, 0);
  const later = { ...state(p.root, p.id), reviews: [{ reviewer: 'r2', at: new Date(Date.now() + 1000).toISOString(), closure: { findings: [finding({ scope: scope('another-existing-defect') })] } }] };
  assert.match(scopeHandoffProblems(later).join(' '), /criteria\/impact amendment/);
  assert.equal(blockingFindings({ scopeDecisions: [] }, { closure: { findings: [finding()] } }).length, 1, 'permission does not cross attempts');
});

test('ignoring extra scope never converts a failed required gate into passing evidence', () => {
  const p = project('scope-failed-gate', 'exit 1');
  ok(review(p, 'r1'));
  ok(choose(p, 'ignore', 'ignore'));
  assert.equal(wf(p.root, ['gate', '--attempt', p.id]).code, 1);
  assert.equal(wf(p.root, ['accept', '--attempt', p.id]).code, 75);
  assert.equal(state(p.root, p.id).lastGate.status, 'failed');
});

test('a later human correction revokes an earlier scope reply; unrelated tool output cannot authorize ignore', () => {
  const p = project('scope-revocation');
  ok(review(p, 'r1'));
  ok(wf(p.root, ['scope', 'ask', '--attempt', p.id]));
  ownerSays(p.home, p.owner, 'ignore');
  ownerSays(p.home, p.owner, 'wait, do not ignore');
  assert.equal(wf(p.root, ['scope', 'decide', '--choice', 'ignore', '--attempt', p.id], { ownerSilent: true }).code, 75);
  assert.equal(state(p.root, p.id).scopeDecisions.length, 0);
});

test('narrow expansion does not authorize the next unrelated finding', () => {
  const p = project('scope-narrow');
  ok(review(p, 'r1'));
  ok(choose(p, 'expand', 'increase scope and fix'));
  const s = state(p.root, p.id);
  const f = finding({ scope: scope('different-defect') });
  const later = { ...s, reviews: [...s.reviews, { reviewer: 'r2', closure: { findings: [f] } }] };
  assert.match(scopeHandoffProblems(later).join(' '), /await the owner decision/);
  assert.equal(s.scopeDecisions[0].all, false);
});

test('implementer-discovered extra scope uses the same owner checkpoint without modifying source', () => {
  const p = project('scope-discovery');
  const file = path.join(p.base, 'scope.json');
  fs.writeFileSync(file, JSON.stringify(scope()));
  ok(wf(p.root, ['discovered', 'add', '--summary', 'Existing independent portal warning', '--scope-file', file, '--attempt', p.id]));
  assert.match(ok(wf(p.root, ['resume', '--attempt', p.id])).out, /Scope increase/);
  ok(choose(p, 'ignore', 'just ignore'));
  const s = state(p.root, p.id);
  assert.equal(s.discovered[0].status, 'open', 'the raw issue record is preserved rather than falsely fixed');
  assert.equal(scopeHandoffProblems(s).length, 0);
  assert.equal(fs.readFileSync(path.join(p.wt, 'portal.js'), 'utf8'), 'unused import\n');
});

test('an ignored independent finding becomes blocking if review establishes that it affects a changed contract', () => {
  const p = project('scope-reclassified');
  ok(review(p, 'r1'));
  ok(choose(p, 'ignore', 'ignore'));
  ok(review(p, 'r2', [finding({ scope: { ...scope(), kind: 'in', affectsChangedContract: true } })]));
  assert.equal(blockingFindings(state(p.root, p.id)).length, 1);
  assert.equal(wf(p.root, ['gate', '--attempt', p.id]).code, 75);
});
