import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { criteriaFile, ok, planDoc, singleRepoProject, state, wf } from './helpers.mjs';

// 0.7.31 (I-216, D67), named failure (field): an analysis attempt's plan was accepted with investigation-only work items; the next
// step told the owner to hand an implementer, and that handoff refused ("analysis attempts are read-only; only a planner handoff
// is allowed"). Nothing recorded what the analysis found or finished it. An analysis now has its own route: plan, investigate
// read-only, `wf analysis record` with the evidence per question, then `wf intent implementation` or `wf analysis close`; what it
// found reaches the planner of whatever follows.

const steps = [{ id: 'unit', repo: 'app', run: 'grep -q . src/a.txt', inputs: ['src/**'], tier: 'light' }];
const tracker = { kind: 'linear', statuses: { started: 'In Progress', delivered: 'Ready for UAT', done: 'Done' } };
const QUESTIONS = [{ id: 'C1', text: 'which code writes the due date', uat: false }, { id: 'C2', text: 'what reads the due date in production', uat: false }];

function analysisPlan(base) {
  const f = path.join(base, `plan-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(f, JSON.stringify(planDoc({ plan: 'trace the due date', criteria: QUESTIONS, work: [{ id: 'W1', class: 'light', criteria: ['C1', 'C2'], summary: 'trace every writer and reader of the due date', files: ['src/a.txt'] }] })));
  return f;
}
const record = (base, doc) => {
  const f = path.join(base, `analysis-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(f, JSON.stringify(doc));
  return f;
};
const FOUND = {
  analyst: 'owner',
  summary: 'Nothing in production writes the due date; only tests set it.',
  criteria: [
    { id: 'C1', answer: 'only the test fixtures write it', evidence: [{ kind: 'query', ref: 'rg -n due_at src', result: '2 hits, both in tests' }] },
    { id: 'C2', unanswered: 'the billing worker repository is not in this project' },
  ],
  findings: [{ id: 'F1', summary: 'renewals are charged off the period end', evidence: [{ kind: 'file', ref: 'app:src/a.txt:1' }] }],
  traced: ['writers of the due date in this repository'],
  notTraced: ['the billing worker: not in this project'],
  recommendation: 'no change to the due date; ask the person about the worker',
};

function planned(name, item) {
  const f = singleRepoProject(name, { gate: { steps }, tracker });
  const e = ok(wf(f.root, ['entry', '--item', item, '--intent', 'analysis', '--json'])).json();
  ok(wf(f.root, ['handoff', 'planner', '--agent', 'p', '--attempt', e.id]));
  const p = ok(wf(f.root, ['plan', '--file', analysisPlan(f.base), '--attempt', e.id]));
  return { ...f, e, plan: p };
}

test('I-216: an analysis plans, records what it found with its evidence and closes; its next steps never name an implementer, and the next attempt\'s planner is given the analysis', () => {
  const { base, root, e, plan } = planned('analysis-route', 'ENG-5');
  // The plan's own next line, `wf resume` and the decision: the investigation and its record, never an implementer.
  for (const out of [plan.out, ok(wf(root, ['resume', '--attempt', e.id])).out]) {
    assert.doesNotMatch(out, /wf handoff implementer|start the implementer/, out);
    assert.match(out, /carry out the investigation the frozen plan states, read-only: its criteria \(C1, C2\) are the questions it answers, its work items \(W1\) the steps/);
    assert.match(out, /`wf analysis record --file <analysis\.yaml>`/);
  }
  // The refusal of an implementer names the route.
  assert.match(wf(root, ['handoff', 'implementer', '--agent', 'i', '--attempt', e.id]).err, /analysis attempts are read-only[^\n]*\n {2}→ carry out the investigation read-only and record what it found with `wf analysis record --file <analysis\.yaml>`/);
  const s0 = state(root, e.id);
  assert.deepEqual([s0.decision.kind, s0.decision.status, s0.decision.blockers], ['analysis', 'owner', ['the investigation is not recorded yet']]);
  assert.doesNotMatch(ok(wf(root, ['resume', '--attempt', e.id])).out, /implementers have none to follow/, 'an analysis plan owes no contract or anchors');
  // The investigation's own planner bundle says it plans an investigation that the owner records.
  const pb = JSON.parse(fs.readFileSync(s0.handoffs.find((h) => h.role === 'planner').bundle, 'utf8'));
  assert.match(pb.instructions, /This attempt is an analysis: plan the investigation\..*`wf analysis record`/);

  // An incomplete record says every gap and records nothing.
  const bad = wf(root, ['analysis', 'record', '--file', record(base, { summary: 'x', criteria: [{ id: 'C1', answer: 'tests only', evidence: [] }, { id: 'C9', answer: 'y', evidence: [{ kind: 'file', ref: 'a' }] }], verdict: 'done' }), '--attempt', e.id]);
  assert.equal(bad.code, 1, bad.err);
  assert.match(bad.err, /`verdict` is not part of an analysis record/);
  assert.match(bad.err, /C1: `evidence` lists at least one item/);
  assert.match(bad.err, /C9 is not a frozen criterion of this attempt \(C1, C2\)/);
  assert.match(bad.err, /C2 is not answered: every frozen criterion gets an answer with its evidence, or `unanswered: "<why>"`/);
  assert.equal(state(root, e.id).analyses.length, 0);
  // Closing with nothing recorded is an abandon, and says so.
  const early = wf(root, ['analysis', 'close', '--reason', 'done', '--attempt', e.id]);
  assert.equal(early.code, 75);
  assert.match(early.err, /has no recorded analysis to close with/);
  assert.match(early.err, /`wf abandon --reason "<why>"`/);

  const r = ok(wf(root, ['analysis', 'record', '--file', record(base, FOUND), '--attempt', e.id]));
  assert.match(r.out, /ENG-5\.1: analysis A1 recorded \(2 question\(s\) answered or marked unanswered, 1 other finding\(s\)\)/);
  assert.match(r.out, /next: the analysis is recorded \(A1\): tell the person what it found.*`wf intent implementation --reason "<their words>"`.*`wf analysis close --reason "<what follows: a ticket, a later attempt, their decision>"`/);
  assert.doesNotMatch(r.out, /wf handoff implementer/);
  const s1 = state(root, e.id);
  assert.equal(s1.analyses[0].id, 'A1');
  assert.ok(fs.existsSync(s1.analyses[0].raw.file), 'the record is kept raw in the evidence');
  assert.deepEqual(s1.decision.blockers, ['the analysis is recorded; what follows is the person\'s decision']);
  assert.match(ok(wf(root, ['status', '--attempt', e.id])).out, /analysis: A1 recorded [^\n]*: Nothing in production writes the due date; only tests set it\./);
  // The attempt's page carries it too: the answers, the evidence and what was not traced.
  const page = ok(wf(root, ['export', '--attempt', e.id, '--out', path.join(base, 'page.html')]));
  const html = fs.readFileSync(path.join(base, 'page.html'), 'utf8');
  for (const t of ['<h2>Analysis</h2>', 'Nothing in production writes the due date; only tests set it.', 'query: rg -n due_at src -&gt; 2 hits, both in tests', 'not answered: the billing worker repository is not in this project', '<li>the billing worker: not in this project</li>']) assert.ok(html.includes(t), `${t}\n${page.out}`);
  assert.ok(!html.includes('The frozen plan has no contract'), 'an analysis plan owes no contract or anchors');
  const shown = ok(wf(root, ['analysis', 'show', '--attempt', e.id])).out;
  for (const line of [/C1 \(which code writes the due date\):\n {4}only the test fixtures write it\n {4}evidence:\n {6}- query: rg -n due_at src -> 2 hits, both in tests/, /C2 \(what reads the due date in production\):\n {4}not answered: the billing worker repository is not in this project/, /Not traced:\n {2}- the billing worker: not in this project/, /Recommendation:\n {2}no change to the due date/]) assert.match(shown, line);

  const c = ok(wf(root, ['analysis', 'close', '--reason', 'the person files a ticket for the worker', '--attempt', e.id]));
  assert.match(c.out, /analysis closed \(the person files a ticket for the worker\); its worktrees are removed and its branch kept/);
  const s2 = state(root, e.id);
  assert.equal(s2.phase, 'done');
  assert.equal(fs.existsSync(e.repos.app.worktree), false);
  assert.match(s2.next, /nothing: the analysis is closed \(the person files a ticket for the worker\); what it found: `wf analysis show --attempt ENG-5\.1`/);
  assert.match(ok(wf(root, ['analysis', 'show', '--attempt', e.id])).out, /Closed [^\n]*: the person files a ticket for the worker/);
  assert.equal(wf(root, ['analysis', 'record', '--file', record(base, FOUND), '--attempt', e.id]).code, 75, 'a closed analysis is final');

  // What follows: the item's next attempt. Its planner is given the analysis; its implementers are not.
  const next = ok(wf(root, ['entry', '--item', 'ENG-5', '--json'])).json();
  assert.equal(wf(root, ['analysis', 'record', '--file', record(base, FOUND), '--attempt', next.id]).code, 75, 'only an analysis attempt records one');
  const h = ok(wf(root, ['handoff', 'planner', '--agent', 'p2', '--attempt', next.id, '--json'])).json();
  const b = JSON.parse(fs.readFileSync(h.bundle, 'utf8'));
  assert.deepEqual([b.analysis.attempt, b.analysis.id, b.analysis.summary, b.analysis.notTraced, b.analysis.closed], ['ENG-5.1', 'A1', FOUND.summary, FOUND.notTraced, 'the person files a ticket for the worker']);
  assert.match(b.instructions, /`analysis` is what the analysis of this item \(ENG-5\.1, A1\) found/);
  ok(wf(root, ['plan', '--file', criteriaFile(base), '--attempt', next.id]));
  const ih = ok(wf(root, ['handoff', 'implementer', '--agent', 'i', '--attempt', next.id, '--json'])).json();
  assert.equal(JSON.parse(fs.readFileSync(ih.bundle, 'utf8')).analysis, undefined);
});

test('I-216: an analysis upgraded to implementation hands a fresh planner, given the analysis, before any implementer', () => {
  const { base, root, e } = planned('analysis-upgrade', 'ENG-6');
  ok(wf(root, ['analysis', 'record', '--file', record(base, FOUND), '--attempt', e.id]));
  const up = ok(wf(root, ['intent', 'implementation', '--attempt', e.id, '--reason', 'implement the fix for the writers']));
  for (const out of [up.out, ok(wf(root, ['resume', '--attempt', e.id])).out]) {
    assert.doesNotMatch(out, /start the implementers|wf handoff implementer/, out);
    assert.match(out, /upgraded to implementation after its plan was frozen, and that plan was written for the analysis: hand a fresh planner for the implementation \(`wf handoff planner --agent <new id>` \[wf-planner\]; its bundle says why the intent changed and carries the recorded analysis\)/);
  }
  assert.deepEqual([state(root, e.id).decision.kind, state(root, e.id).decision.blockers], ['plan', ['the frozen plan was written for the analysis this attempt was upgraded from']]);
  const h = ok(wf(root, ['handoff', 'planner', '--agent', 'p2', '--attempt', e.id, '--json'])).json();
  const b = JSON.parse(fs.readFileSync(h.bundle, 'utf8'));
  assert.deepEqual([b.intent, b.analysis.attempt, b.analysis.id], ['implementation', 'ENG-6.1', 'A1']);
  assert.match(b.replacesPlan, /replaces the analysis plan/);
  assert.match(ok(wf(root, ['resume', '--attempt', e.id])).out, /record planner p2's implementation plan when it reports: `wf plan --from-agent p2` \(it replaces the analysis plan whole\); then the implementers/);
  ok(wf(root, ['plan', '--file', criteriaFile(base), '--attempt', e.id]));
  assert.match(ok(wf(root, ['resume', '--attempt', e.id])).out, /start the implementer: `wf handoff implementer --agent <id>`/);
  // The record of the analysis stays with the attempt; only an analysis attempt closes as one.
  assert.equal(state(root, e.id).analyses.length, 1);
  assert.match(wf(root, ['analysis', 'close', '--reason', 'x', '--attempt', e.id]).err, /ENG-6\.1 is an implementation attempt; only an analysis attempt is closed with `wf analysis close`/);
});

test('I-216: an analysis is admitted beside an open attempt of its item, and what it records reaches that attempt\'s next implementer; an open analysis is implemented in place, not beside', () => {
  const f = singleRepoProject('analysis-beside', { gate: { steps }, tracker });
  const impl = ok(wf(f.root, ['entry', '--item', 'ENG-7', '--json'])).json();
  ok(wf(f.root, ['handoff', 'planner', '--agent', 'p', '--attempt', impl.id]));
  ok(wf(f.root, ['plan', '--file', criteriaFile(f.base), '--attempt', impl.id]));
  // The premise of a fix is traced before the fix round, in an analysis of the same item beside the implementation.
  const an = ok(wf(f.root, ['entry', '--item', 'ENG-7', '--intent', 'analysis', '--json'])).json();
  assert.equal(an.id, 'ENG-7.2');
  assert.deepEqual(state(f.root, an.id).tracker.pending, [], 'an analysis moves no ticket');
  ok(wf(f.root, ['handoff', 'planner', '--agent', 'pa', '--attempt', an.id]));
  ok(wf(f.root, ['plan', '--file', analysisPlan(f.base), '--attempt', an.id]));
  ok(wf(f.root, ['analysis', 'record', '--file', record(f.base, FOUND), '--attempt', an.id]));
  ok(wf(f.root, ['analysis', 'close', '--reason', 'the fix round builds on it', '--attempt', an.id]));
  const h = ok(wf(f.root, ['handoff', 'implementer', '--agent', 'i', '--attempt', impl.id, '--json'])).json();
  const b = JSON.parse(fs.readFileSync(h.bundle, 'utf8'));
  assert.deepEqual([b.analysis.attempt, b.analysis.id, b.analysis.notTraced], ['ENG-7.2', 'A1', FOUND.notTraced]);
  assert.match(b.instructions, /`analysis` is what an analysis of this item \(ENG-7\.2, A1\) found since this attempt began/);

  // An open analysis is implemented in place (or closed): an implementation is not admitted beside it.
  const g = singleRepoProject('analysis-open', { gate: { steps }, tracker });
  const a = ok(wf(g.root, ['entry', '--item', 'ENG-8', '--intent', 'analysis', '--json'])).json();
  const beside = wf(g.root, ['entry', '--item', 'ENG-8', '--json']);
  assert.equal(beside.code, 75);
  assert.match(beside.err, new RegExp(`ENG-8 already has an open attempt ${a.id.replace('.', '\\.')}`));
  assert.match(beside.err, /ENG-8\.1 is an analysis: `wf intent implementation --attempt ENG-8\.1 --reason "<the person's words>"` implements it in place, or `wf analysis close --attempt ENG-8\.1 --reason "<what follows>"` once it is recorded/);
});
