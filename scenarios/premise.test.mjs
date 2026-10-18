// 0.7.31 (I-217, D64, D65, D66), named failure (field): an evidence reviewer noted a low display anomaly (a due date shown with a
// clock time on one page and as a date on another). The owner recorded a decision with the person before any research, briefed a
// research agent on how such a date "should" be stored and shown, and asked the person, through the host's question panel and
// with no record, a question whose two options both built the change. The research said no production caller sets the field;
// the owner turned that into "no wrong data exists", and the implementer's brief and the reviewer repeated it. The low item became
// a reshape of four API DTOs and a new failure path, built in a fix round, and was reverted after the person asked whether anyone
// had done a proper analysis. Now: an implementer whose item's premise does not hold in production builds nothing for it and
// reports it; a reviewer judges a fix's premise as well as the fix; a product decision asked outside the engine is recorded with
// what it rests on and the person's own words; an owner's brief to an implementer is evidence; a plan's survey lists who writes
// the data; and a fix round or pass whose own commits change a contract or a critical boundary sends the course to the strategist.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { closureFile, commitIn, goodClosure, makeRepo, ok, planDoc, sh, singleRepoProject, tmp, wf, writeReport } from './helpers.mjs';
import { reachOf } from '../engine/signals.mjs';
import { parseConfig } from '../engine/config.mjs';

const steps = [{ id: 'unit', repo: 'app', run: 'true' }];
const LINES = 'l1\nl2\nl3\nl4\nl5\nl6\n';
// A plan that predicts enough rounds, files and minutes that no other course signal fires in these flows.
const EXPECT = { files: 10, rounds: 6, minutes: 600 };

function project(name, config = {}, files = {}) {
  const p = singleRepoProject(name, { gate: { steps }, ...config }, { 'src/a.txt': LINES, 'src/b.txt': LINES, ...files });
  const e = ok(wf(p.root, ['entry', '--item', 'PM-1', '--owner', 'o', '--json'])).json();
  ok(wf(p.root, ['handoff', 'planner', '--agent', 'p', '--attempt', e.id]));
  const plan = path.join(p.base, 'plan.json');
  fs.writeFileSync(plan, JSON.stringify(planDoc({ plan: { summary: 'change a', expect: EXPECT, anchors: ['src/a.txt'] }, criteria: [{ id: 'C1', text: 'a changes', uat: 'a shows the new text' }] })));
  ok(wf(p.root, ['plan', '--file', plan, '--attempt', e.id]));
  return { ...p, id: e.id, wt: e.repos.app.worktree };
}
const bundleOf = (r) => JSON.parse(fs.readFileSync((r.out.match(/^Read (\S+)/m) ?? r.out.match(/bundle: (\S+)/))[1], 'utf8'));
const resume = (p) => ok(wf(p.root, ['resume', '--attempt', p.id, '--json'])).json();
const record = (p, closure) => ok(wf(p.root, ['review', '--closure', closureFile(p.base, closure), '--attempt', p.id]));
const amend = (p, doc) => wf(p.root, ['criteria', 'amend', '--file', closureFile(p.base, doc), '--reason', 'one planned pass for what does not block', '--attempt', p.id]);
const low = (id, evidence) => ({ id, severity: 'low', summary: `${id}: the label reads oddly`, status: 'open', evidence });
const blocking = (id, evidence, extra = {}) => ({ id, severity: 'high', summary: `${id}: the total is wrong`, status: 'open', evidence, criterion: 'C1', ...extra });
const DUE = { what: 'the due date shows a clock time on the invoice page', where: 'src/b.txt:3', why: 'not caused by this change', severity: 'low' };
// The first implementer builds C1 and leaves the display item (D1); the first review is handed the tree.
function built(p, files = { 'src/a.txt': LINES.replace('l2', 'L2') }) {
  ok(wf(p.root, ['handoff', 'implementer', '--agent', 'i1', '--attempt', p.id]));
  commitIn(p.wt, files, 'implement C1');
  writeReport(p.root, p.id, 'i1', { left: [DUE] });
  ok(wf(p.root, ['handoff', 'close', '--agent', 'i1', '--attempt', p.id]));
  ok(wf(p.root, ['handoff', 'reviewer', '--agent', 'r1', '--attempt', p.id]));
}

test('an implementer whose item\'s premise does not hold in production builds nothing for it and reports why; no pass is handed it again, and it waits for a reviewer\'s verdict or the person', () => {
  const p = project('pm-route');
  built(p);
  record(p, goodClosure('r1', { findings: [low('F1', 'src/a.txt:2')] }));
  ok(amend(p, { pass: [{ items: ['r1:F1', 'D1'], why: 'the label and the due date', repos: ['app'] }], expect: { minutes: 30, rounds: 1 } }));
  const b = bundleOf(ok(wf(p.root, ['handoff', 'implementer', '--agent', 'i2', '--work', 'P1', '--attempt', p.id])));
  assert.match(b.instructions, /whether its premise holds in production/, 'the pass is told to establish each item\'s premise before it builds');
  commitIn(p.wt, { 'src/a.txt': LINES.replace('l2', 'L2 fixed') }, 'the label');
  const sha = sh(p.wt, 'git rev-parse HEAD').trim();
  writeReport(p.root, p.id, 'i2', {
    approach: 'traced who writes the due date before changing how it is shown',
    expect: { minutes: 20 },
    premises: [{ ref: 'r1:F1', holds: true, checked: ['src/a.txt:2 renders the label every user sees'] }],
    premiseFailed: [{ ref: 'D1', why: 'nothing in production writes the due date: only the specs set it, so no user sees the clock time', evidence: ['src/b.txt:3 is read only by the invoice page', 'no production writer: the one assignment is in a spec'] }],
  });
  const closed = ok(wf(p.root, ['handoff', 'close', '--agent', 'i2', '--attempt', p.id]));
  assert.match(closed.out, /i2 reports that the premise of D1 does not hold in production/);
  assert.match(closed.out, /nothing was built for it/);
  ok(wf(p.root, ['scope', 'fixed', '--finding', 'r1:F1', '--commit', sha, '--attempt', p.id]));
  let s = resume(p);
  const rep = s.implementerReports.at(-1);
  assert.deepEqual(rep.premiseFailed.map((x) => x.ref), ['D1']);
  assert.match(rep.premiseFailed[0].evidence.join(' '), /no production writer/);
  assert.deepEqual(rep.premises.map((x) => [x.ref, x.holds]), [['r1:F1', true]]);
  // The pass is built: the gate is next, and the step names the premise and its routes.
  assert.equal(s.decision.kind, 'gate');
  assert.match(s.next, /premise reported failed: D1 \(i2: nothing in production writes the due date/);
  assert.match(s.next, /the next reviewer is handed it and judges its premise/);
  assert.match(s.next, /`wf discovered close D1 --not-a-defect --reason "<why>"/);
  ok(wf(p.root, ['gate', '--attempt', p.id]));
  const ev = bundleOf(ok(wf(p.root, ['handoff', 'reviewer', '--agent', 'r2', '--attempt', p.id])));
  assert.deepEqual(ev.premiseFailed.map((x) => [x.ref, x.kind, x.reportedBy]), [['D1', 'discovered', 'i2']]);
  assert.match(ev.premiseFailed[0].evidence.join(' '), /no production writer/);
  assert.match(ev.instructions, /`premiseFailed` lists items an implementer did not build because their premise does not hold in production/);
  // The reviewer gives it no verdict: the next step is not the acceptance and not another pass, but the premise's routes.
  record(p, goodClosure('r2'));
  record(p, goodClosure('r2', { priorFindings: [{ round: 'r1', id: 'F1', status: 'fixed', evidence: 'src/a.txt:2 reads well' }] }));
  s = resume(p);
  assert.equal(s.decision.kind, 'premise');
  assert.match(s.next, /D1 \(i2: nothing in production writes the due date[^)]*\) was not settled by the review after it/);
  // The person decides it is not a defect (D38): it closes, and the acceptance is next.
  ok(wf(p.root, ['discovered', 'close', 'D1', '--not-a-defect', '--reason', 'nothing writes the due date in production', '--attempt', p.id]));
  assert.equal(resume(p).decision.kind, 'accept');
});

test('a reviewer judges the premise of a fix as well as the fix: one that does not hold settles the finding, one that holds sends the item back to be fixed', () => {
  const p = project('pm-verdict');
  built(p);
  record(p, goodClosure('r1', { findings: [blocking('F1', 'src/a.txt:2')] }));
  // The fix round: F1 blocks; D1 joins it. The implementer finds both premises false and builds neither.
  const fx = bundleOf(ok(wf(p.root, ['handoff', 'implementer', '--agent', 'i1', '--attempt', p.id])));
  assert.deepEqual(fx.alsoFix.map((x) => x.ref), ['D1']);
  assert.match(fx.instructions, /whether its premise holds in production/);
  writeReport(p.root, p.id, 'i1', { approach: 'traced both premises; built nothing', expect: { minutes: 15 }, premiseFailed: [
    { ref: 'r1:F1', why: 'the total is computed only for an export no production path runs', evidence: ['src/a.txt:2'] },
    { ref: 'D1', why: 'nothing in production writes the due date', evidence: ['src/b.txt:3'] },
  ] });
  ok(wf(p.root, ['handoff', 'close', '--agent', 'i1', '--attempt', p.id]));
  // It built nothing: the next step is a verdict on the premise, not another fix round for the same finding.
  const after = resume(p);
  assert.equal(after.decision.kind, 'premise');
  assert.match(after.next, /r1:F1 \(i1: the total is computed only for an export no production path runs[^)]*\) has not been judged by a review yet/);
  assert.match(after.next, /a fresh reviewer \(`wf handoff reviewer --agent <new id>/);
  assert.doesNotMatch(after.next, /fix the open findings/);
  // The delta reviewer is handed both premises, with the implementer's evidence.
  const d = bundleOf(ok(wf(p.root, ['handoff', 'reviewer', '--agent', 'r2', '--attempt', p.id])));
  assert.deepEqual(d.premiseFailed.map((x) => [x.ref, x.kind]), [['r1:F1', 'finding'], ['D1', 'discovered']]);
  // F1's premise does not hold (a verified non-issue, with its premise line); D1's does (open: it goes back to be fixed).
  record(p, goodClosure('r2', {
    criteria: [],
    priorFindings: [{ round: 'r1', id: 'F1', status: 'verified-nonissue', evidence: 'src/a.txt:2', rationale: 'the premise behind the fix does not hold in production paths', premise: 'does not hold: no production path computes this total (src/a.txt:2 is reached only from a spec)' }],
    discovered: [{ id: 'D1', verdict: 'open', evidence: 'src/b.txt:3 is written by the nightly import', premise: 'holds: the nightly import writes the due date with a clock time' }],
  }));
  const s = resume(p);
  assert.equal(s.decision.kind, 'pass', 'D1 is back with the work that does not block');
  assert.deepEqual(s.decision.outstanding, ['D1']);
  assert.doesNotMatch(s.next, /premise reported failed/);
  ok(amend(p, { pass: [{ items: ['D1'], why: 'the due date', repos: ['app'] }], expect: { minutes: 30, rounds: 1 } }));
  const pass = bundleOf(ok(wf(p.root, ['handoff', 'implementer', '--agent', 'i3', '--work', 'P1', '--attempt', p.id])));
  const f1 = pass.findingHistory.find((h) => h.ref === 'r1:F1');
  assert.equal(f1.status, 'verified-nonissue');
  assert.match(f1.premise, /does not hold: no production path computes this total/, 'the history carries the premise line of the verdict that settled it');
  // Review of 0.7.31 (L3): a premise line on a discovered verdict is kept with the issue, and the next implementer reads it.
  assert.deepEqual(resume(p).discovered.find((x) => x.id === 'D1').premises.map((x) => [x.reviewer, x.verdict]), [['r2', 'open']]);
  assert.match(pass.passItems[0].items[0].premises[0].premise, /holds: the nightly import writes the due date/);
  // Review of 0.7.31 (L6): an implementer that again finds D1's premise false after a reviewer found it holds is not sent to another
  // reviewer: the person decides.
  writeReport(p.root, p.id, 'i3', { approach: 'traced the import', expect: { minutes: 10 }, premiseFailed: [{ ref: 'D1', why: 'the nightly import is switched off in production', evidence: ['src/b.txt:5 reads a flag that is off'] }] });
  ok(wf(p.root, ['handoff', 'close', '--agent', 'i3', '--attempt', p.id]));
  const contested = resume(p);
  assert.match(contested.next, /D1 \(i3: the nightly import is switched off in production[^)]*\): reviewer r2 found its premise holds and an implementer found it does not: the person decides/);
  assert.match(contested.next, /`wf discovered close D1 --not-a-defect --reason "<why>"/);
  assert.doesNotMatch(contested.next, /the next reviewer is handed/);
  const r3 = bundleOf(ok(wf(p.root, ['handoff', 'reviewer', '--agent', 'r3', '--attempt', p.id])));
  assert.equal(r3.premiseFailed, undefined, 'not handed to another reviewer');
});

// The person's words are proven theirs (D41), as a reading of an answer is.
const CLAUDE = 'c1aude00-0000-4000-8000-00000000dec1';
const personWrites = (p, text, offsetMs = 1000) => {
  const file = path.join(p.base, '.home', '.claude', 'projects', 'proj', `${CLAUDE}.jsonl`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const when = (ms) => new Date(Date.now() + ms).toISOString();
  fs.appendFileSync(file, [{ type: 'assistant', timestamp: when(offsetMs - 500), message: { role: 'assistant', content: [{ type: 'text', text: 'Should the due date show only the date on every page?' }] } }, { type: 'user', timestamp: when(offsetMs), message: { role: 'user', content: text } }].map((l) => JSON.stringify(l)).join('\n') + '\n');
};
const session = { env: { CLAUDE_CODE_SESSION_ID: CLAUDE } };

test('a product decision asked outside the engine is recorded with its question, recommendation, basis and the person\'s own words, shown in resume and handed to later roles', () => {
  const p = project('pm-decide');
  const asked = ['--question', 'Should the due date show only the date on every page?', '--options', 'Only the date | The date and the time', '--recommend', 'Only the date: it is a calendar day, not an instant', '--basis', 'traced the two pages that show it (src/a.txt:2, src/b.txt:3)'];
  const decide = (extra) => wf(p.root, ['decide', ...asked, '--not-checked', 'who writes the due date in production; what reads it besides the two pages', ...extra, '--attempt', p.id], session);
  // What was not checked is part of the record: without it nothing is recorded.
  const bare = wf(p.root, ['decide', ...asked, '--choice', 'Only the date', '--quote', 'only the date please', '--attempt', p.id], session);
  assert.equal(bare.code, 1);
  assert.match(bare.err, /--not-checked/);
  // Words the person never wrote are not recorded as theirs.
  personWrites(p, 'looks fine');
  const unproven = decide(['--choice', 'Only the date', '--quote', 'only the date please']);
  assert.equal(unproven.code, 75);
  assert.match(unproven.err, /not recorded: "only the date please" is in no message of the person's in this session/);
  personWrites(p, 'ok, only the date please, on both pages', 2000);
  // Review of 0.7.31 (M2): the options offered are part of the record, and the choice is one of them.
  const offered = wf(p.root, ['decide', ...asked.filter((x, i) => asked[i - 1] !== '--options' && x !== '--options'), '--not-checked', 'who writes it', '--choice', 'Only the date', '--quote', 'only the date please', '--attempt', p.id], session);
  assert.equal(offered.code, 1);
  assert.match(offered.err, /--options/);
  const outside = decide(['--choice', 'Neither', '--quote', 'only the date please']);
  assert.equal(outside.code, 75);
  assert.match(outside.err, /"Neither" is not one of the options offered \("Only the date" \| "The date and the time"\)/);
  const rec = ok(decide(['--choice', 'Only the date', '--quote', 'only the date please']));
  assert.match(rec.out, /product decision PD1 recorded on PM-1\.1/);
  const s = resume(p);
  const pd = s.productDecisions[0];
  assert.deepEqual([pd.id, pd.choice, pd.quote], ['PD1', 'Only the date', 'only the date please']);
  assert.match(pd.notChecked, /who writes the due date in production/);
  assert.match(pd.via, /^chat, read by the agent/);
  assert.deepEqual(pd.options, ['Only the date', 'The date and the time']);
  assert.match(pd.plain, /Should the due date show only the date on every page\? The options: \(1\) Only the date; \(2\) The date and the time\./);
  const text = ok(wf(p.root, ['resume', '--attempt', p.id])).out;
  assert.match(text, /product decision PD1: "Should the due date show only the date on every page\?" \(options: "Only the date" \| "The date and the time"\) -> "Only the date" \(their words: "only the date please"\)/);
  assert.match(text, /not checked: who writes the due date in production/);
  // The same record from a file: what the agent asked, word for word.
  const file = path.join(p.base, 'decision.json');
  fs.writeFileSync(file, JSON.stringify({ question: 'Should the reminder go out on the due day?', options: ['Yes, on the due day', 'No, a day before'], recommend: 'Yes, on the due day', basis: 'traced the reminder job (src/a.txt:4)', notChecked: 'the time zone it runs in', choice: 'Yes, on the due day', quote: 'only the date please' }));
  assert.match(ok(wf(p.root, ['decide', '--file', file, '--attempt', p.id], session)).out, /product decision PD2 recorded/);
  // Later roles are handed it: the implementer with the person's words, a blind reviewer without them.
  const impl = bundleOf(ok(wf(p.root, ['handoff', 'implementer', '--agent', 'i1', '--attempt', p.id])));
  assert.deepEqual(impl.decisions.map((x) => [x.id, x.choice, x.quote]), [['PD1', 'Only the date', 'only the date please'], ['PD2', 'Yes, on the due day', 'only the date please']]);
  assert.match(impl.decisions[0].notChecked, /who writes the due date/);
  commitIn(p.wt, { 'src/a.txt': LINES.replace('l2', 'L2') }, 'implement C1');
  ok(wf(p.root, ['handoff', 'close', '--agent', 'i1', '--attempt', p.id]));
  const rev = bundleOf(ok(wf(p.root, ['handoff', 'reviewer', '--agent', 'r1', '--attempt', p.id])));
  assert.equal(rev.decisions[0].id, 'PD1');
  assert.equal(rev.decisions[0].quote, undefined, 'a blind reviewer gets the decision, not the person\'s words');
  // Review of 0.7.31 (L5): nor the owner's framing: the question, the options, the choice and what was not checked.
  assert.deepEqual(Object.keys(rev.decisions[0]).sort(), ['at', 'choice', 'id', 'notChecked', 'options', 'question']);
  // The analysis changes the picture: the decision is withdrawn with what changed, and says so where it was shown.
  ok(wf(p.root, ['decide', 'withdraw', 'PD1', '--reason', 'the trace found nothing writes the due date in production', '--attempt', p.id]));
  assert.match(resume(p).productDecisions[0].withdrawn.reason, /nothing writes the due date/);
  assert.match(ok(wf(p.root, ['resume', '--attempt', p.id])).out, /product decision PD1 \(withdrawn: the trace found nothing writes the due date in production\)/);
});

test('an owner\'s brief to an implementer is evidence: recorded with the handoff and in its bundle; a reviewer stays blind', () => {
  const p = project('pm-context');
  const brief = path.join(p.base, 'brief.md');
  fs.writeFileSync(brief, 'The research found no production caller sets the due date; only specs do. Check that before you build anything.\n');
  const b = bundleOf(ok(wf(p.root, ['handoff', 'implementer', '--agent', 'i1', '--context-file', brief, '--attempt', p.id])));
  assert.match(b.ownerContext, /no production caller sets the due date/);
  assert.match(b.instructions, /`ownerContext` is what the owner carried to you/);
  assert.match(resume(p).handoffs.filter((x) => x.role === 'implementer').at(-1).context, /no production caller sets the due date/);
  commitIn(p.wt, { 'src/a.txt': LINES.replace('l2', 'L2') }, 'implement C1');
  ok(wf(p.root, ['handoff', 'close', '--agent', 'i1', '--attempt', p.id]));
  const refused = wf(p.root, ['handoff', 'reviewer', '--agent', 'r1', '--context', 'look at the due date', '--attempt', p.id]);
  assert.notEqual(refused.code, 0);
  assert.match(refused.err, /a reviewer is started blind/);
});

test('a plan\'s survey lists who writes the data beside who reads it: each producer is a query the engine re-runs', () => {
  const p = singleRepoProject('pm-producers', { gate: { steps } }, { 'src/a.txt': LINES });
  const e = ok(wf(p.root, ['entry', '--item', 'PM-2', '--owner', 'o', '--json'])).json();
  ok(wf(p.root, ['handoff', 'planner', '--agent', 'p', '--attempt', e.id]));
  const doc = (hits) => {
    const d = planDoc({ plan: { summary: 'show the due date as a date', expect: EXPECT, anchors: ['src/a.txt'] }, criteria: [{ id: 'C1', text: 'the due date shows as a date', uat: 'the invoice page shows a date' }] });
    d.survey.queries.push({ id: 'QW', pattern: 'dueAt =', kind: 'literal', paths: ['src/**'], hits });
    d.survey.producers = [{ id: 'SW', symbol: 'dueAt', query: 'QW', hits, absent: 'the page shows no due date; reminders key off the period end' }];
    d.impact.changes[0].covers.push('SW');
    return d;
  };
  const wrong = wf(p.root, ['plan', '--file', closureFile(p.base, doc(3)), '--attempt', e.id]);
  assert.equal(wrong.code, 75, 'a producer count the engine does not find is refused, as every survey count is');
  assert.match(wrong.err, /survey\.producers\[0\] \(SW\)/);
  ok(wf(p.root, ['plan', '--file', closureFile(p.base, doc(0)), '--attempt', e.id]));
  const producer = ok(wf(p.root, ['resume', '--attempt', e.id, '--json'])).json().impact.survey.producers[0];
  assert.deepEqual([producer.id, producer.hits], ['SW', 0], 'no production writer is a recorded fact, not an inference');
  assert.match(producer.absent, /reminders key off the period end/);
});

const API = { components: [{ id: 'api', kind: 'service', repo: 'app', provides: [{ contract: 'http', spec: 'openapi.json' }] }] };

test('a fix round whose own commits change a contract, for an item with no stated fix, makes the strategist the next step; the first build of the planned work does not', () => {
  const p = project('pm-reach', API, { 'openapi.json': '{"paths":{}}\n' });
  built(p, { 'src/a.txt': LINES.replace('l2', 'L2'), 'openapi.json': '{"paths":{"/a":{}}}\n' });
  record(p, goodClosure('r1', { findings: [blocking('F1', 'src/a.txt:2', { fix: { what: 'round the total once', minutes: 60 } })] }));
  assert.equal(resume(p).decision.kind, 'repair', 'the planned work changing its own contract is no signal');
  ok(wf(p.root, ['handoff', 'implementer', '--agent', 'i1', '--attempt', p.id]));
  const h = resume(p).handoffs.filter((x) => x.role === 'implementer').at(-1);
  assert.deepEqual(h.fixes, { repair: ['r1:F1'], alsoFix: ['D1'], unbounded: ['D1'] });
  // It fixes F1 and, for the low item with no stated fix, reshapes the endpoint's contract. It expects exactly twice the stated
  // fix, which the implementer-estimate signal does not count.
  commitIn(p.wt, { 'src/a.txt': LINES.replace('l2', 'L2 rounded'), 'openapi.json': '{"paths":{"/a":{"dueDate":"date"}}}\n' }, 'fix F1; the due date as a date');
  writeReport(p.root, p.id, 'i1', { approach: 'round once; send the due date as a date', expect: { minutes: 120 } });
  ok(wf(p.root, ['handoff', 'close', '--agent', 'i1', '--attempt', p.id]));
  const s = resume(p);
  assert.equal(s.decision.kind, 'strategy');
  assert.deepEqual(s.decision.courseSignals.map((x) => x.id), ['reach']);
  assert.match(s.next, /the fix round of implementer i1 changed the contract openapi\.json/);
  assert.match(s.next, /1 handed item with no stated fix \(unbounded\): D1/);
  assert.match(ok(wf(p.root, ['signals', '--attempt', p.id])).out, /the fix round of implementer i1 changed the contract openapi\.json/);
  // The strategist answers it; the premise its decision rests on is recorded with it.
  const st = ok(wf(p.root, ['handoff', 'strategist', '--agent', 's1', '--attempt', p.id, '--json'])).json();
  assert.deepEqual(JSON.parse(fs.readFileSync(st.bundle, 'utf8')).courseSignals.map((x) => x.id), ['reach']);
  const f = path.join(p.base, 's1.json');
  fs.writeFileSync(f, JSON.stringify({ strategist: 's1', action: 'continue', rationale: 'the person asked for the contract change', prediction: { signal: 'blockingLatest <= 1', by: 3 }, expect: { files: 5, rounds: 2, minutes: 120 }, premise: { shared: 'the due date is written in production', traced: 'the two pages that show it', notTraced: 'who writes it' } }));
  ok(wf(p.root, ['strategy', 'record', '--closure', f, '--attempt', p.id]));
  const after = resume(p);
  assert.notEqual(after.decision.kind, 'strategy', 'its decision answers the signal');
  assert.match(after.strategy.decisions.at(-1).premise.notTraced, /who writes it/);
});

test('a planned pass whose own commits add a migration makes the strategist the next step', () => {
  const p = project('pm-reach-migration');
  built(p);
  record(p, goodClosure('r1', { findings: [low('F1', 'src/a.txt:2')] }));
  ok(amend(p, { pass: [{ items: ['r1:F1', 'D1'], why: 'the label and the due date', repos: ['app'] }], expect: { minutes: 30, rounds: 1 } }));
  ok(wf(p.root, ['handoff', 'implementer', '--agent', 'i2', '--work', 'P1', '--attempt', p.id]));
  commitIn(p.wt, { 'src/a.txt': LINES.replace('l2', 'L2 fixed'), 'db/migrations/002_due_date.sql': 'alter table invoice alter column due type date;\n' }, 'the pass');
  writeReport(p.root, p.id, 'i2', { approach: 'store the due date as a date', expect: { minutes: 30 } });
  ok(wf(p.root, ['handoff', 'close', '--agent', 'i2', '--attempt', p.id]));
  const s = resume(p);
  assert.equal(s.decision.kind, 'strategy', 'not the gate: the pass reached a critical boundary');
  assert.deepEqual(s.decision.courseSignals.map((x) => x.id), ['reach']);
  assert.match(s.next, /the planned pass of implementer i2 added or changed a migration \(db\/migrations\/002_due_date\.sql\)/);
});

// ---- Review of 0.7.31 ----

// M3. Named failure (a review's measurement): `reach` fired on 35 of 155 implementer rounds handed after a first review in one
// project's ledgers (an upper bound), mostly planned work regenerating an API baseline with a controller or DTO edit. The named
// failure is a change nobody planned: a contract or a migration reached from an item with no stated fix, or beyond the fixes stated.
test('review of 0.7.31 (M3): a contract change where a handed finding is located sends no course signal, and neither does a migration under docs', () => {
  const p = project('pm-reach-covered', API, { 'openapi.json': '{"paths":{}}\n' });
  built(p, { 'src/a.txt': LINES.replace('l2', 'L2'), 'openapi.json': '{"paths":{"/a":{}}}\n' });
  record(p, goodClosure('r1', { findings: [blocking('F1', 'openapi.json:1', { summary: 'F1: the response lacks the due date field', fix: { what: 'add dueDate to the /a response in openapi.json', minutes: 20 } })] }));
  ok(wf(p.root, ['handoff', 'implementer', '--agent', 'i1', '--attempt', p.id]));
  commitIn(p.wt, { 'openapi.json': '{"paths":{"/a":{"dueDate":"date"}}}\n', 'docs/migrations/notes.md': 'how the due date moved\n' }, 'fix F1');
  writeReport(p.root, p.id, 'i1', { approach: 'add the field', expect: { minutes: 20 } });
  ok(wf(p.root, ['handoff', 'close', '--agent', 'i1', '--attempt', p.id]));
  const s = resume(p);
  assert.equal(s.decision.kind, 'review', 'the finding is located on the contract it changed: the delta review is next');
  assert.equal(ok(wf(p.root, ['signals', '--attempt', p.id, '--json'])).json().reach.length, 0);
});

test('review of 0.7.31 (M3): a fix round handed only blocking findings that adjusts a contract its own planned work opened sends no course signal', () => {
  const p = project('pm-reach-own-surface', API, { 'openapi.json': '{"paths":{}}\n' });
  ok(wf(p.root, ['handoff', 'implementer', '--agent', 'i1', '--attempt', p.id]));
  commitIn(p.wt, { 'src/a.txt': LINES.replace('l2', 'L2'), 'openapi.json': '{"paths":{"/a":{}}}\n' }, 'C1 with its endpoint');
  ok(wf(p.root, ['handoff', 'close', '--agent', 'i1', '--attempt', p.id]));
  ok(wf(p.root, ['handoff', 'reviewer', '--agent', 'r1', '--attempt', p.id]));
  record(p, goodClosure('r1', { findings: [blocking('F1', 'src/a.txt:2', { fix: { what: 'round the total once', minutes: 30 } })] }));
  ok(wf(p.root, ['handoff', 'implementer', '--agent', 'i1', '--attempt', p.id]));
  commitIn(p.wt, { 'src/a.txt': LINES.replace('l2', 'L2 rounded'), 'openapi.json': '{"paths":{"/a":{"total":"rounded"}}}\n' }, 'fix F1');
  writeReport(p.root, p.id, 'i1', { approach: 'round once', expect: { minutes: 30 } });
  ok(wf(p.root, ['handoff', 'close', '--agent', 'i1', '--attempt', p.id]));
  assert.equal(resume(p).decision.kind, 'review');
  assert.equal(ok(wf(p.root, ['signals', '--attempt', p.id, '--json'])).json().reach.length, 0);
});

const C2 = [{ id: 'C1', text: 'a changes', uat: 'a shows the new text' }, { id: 'C2', text: 'b changes', uat: 'b shows the new text' }];
const WORK = [{ id: 'W1', criteria: ['C1'], repos: ['app'], class: 'full', why: 'a' }, { id: 'W2', criteria: ['C2'], repos: ['app'], class: 'full', why: 'b' }];
function twoItems(name) {
  const p = singleRepoProject(name, { gate: { steps }, ...API }, { 'src/a.txt': LINES, 'src/b.txt': LINES, 'openapi.json': '{"paths":{}}\n' });
  const e = ok(wf(p.root, ['entry', '--item', 'PM-3', '--owner', 'o', '--json'])).json();
  ok(wf(p.root, ['handoff', 'planner', '--agent', 'p', '--attempt', e.id]));
  const plan = path.join(p.base, 'plan.json');
  fs.writeFileSync(plan, JSON.stringify(planDoc({ plan: { summary: 'change a and b', expect: EXPECT, anchors: ['src/a.txt', 'src/b.txt'] }, criteria: C2, work: WORK })));
  ok(wf(p.root, ['plan', '--file', plan, '--attempt', e.id]));
  return { ...p, id: e.id, wt: e.repos.app.worktree };
}

test('review of 0.7.31 (M3, L1): the first build of planned work handed after a review is no signal; two fix rounds open at once are named together, once', () => {
  const p = twoItems('pm-reach-parallel');
  ok(wf(p.root, ['handoff', 'implementer', '--agent', 'iA', '--work', 'W1', '--attempt', p.id]));
  commitIn(p.wt, { 'src/a.txt': LINES.replace('l2', 'L2') }, 'W1');
  ok(wf(p.root, ['handoff', 'close', '--agent', 'iA', '--attempt', p.id]));
  ok(wf(p.root, ['check', '--attempt', p.id]));
  ok(wf(p.root, ['handoff', 'reviewer', '--agent', 'r1', '--attempt', p.id]));
  record(p, goodClosure('r1', { findings: [blocking('F1', 'src/a.txt:2', { work: 'W1', fix: { what: 'round once', minutes: 20 } })], criteria: [{ id: 'C1', evidence: { kind: 'output', ref: 'log 1' } }, { id: 'C2', evidence: { kind: 'not-applicable', reason: 'not built yet' } }] }));
  // W2 is built for the first time after the review: its reach is the plan's.
  ok(wf(p.root, ['handoff', 'implementer', '--agent', 'iB', '--work', 'W2', '--attempt', p.id]));
  assert.deepEqual(resume(p).handoffs.at(-1).fixes?.planned, ['W2']);
  // F1's fix round is handed while iB works: both open at once in the one repo.
  ok(wf(p.root, ['handoff', 'implementer', '--agent', 'iA', '--work', 'W1', '--attempt', p.id]));
  commitIn(p.wt, { 'src/b.txt': LINES.replace('l2', 'L2'), 'openapi.json': '{"paths":{"/b":{}}}\n' }, 'W2 with its endpoint');
  commitIn(p.wt, { 'src/a.txt': LINES.replace('l2', 'L2 rounded') }, 'fix F1');
  ok(wf(p.root, ['handoff', 'close', '--agent', 'iB', '--attempt', p.id]));
  writeReport(p.root, p.id, 'iA', { approach: 'round once', expect: { minutes: 20 } });
  ok(wf(p.root, ['handoff', 'close', '--agent', 'iA', '--attempt', p.id]));
  const sig = ok(wf(p.root, ['signals', '--attempt', p.id, '--json'])).json();
  assert.equal(sig.reach.length, 1, 'one change, said once');
  assert.match(ok(wf(p.root, ['signals', '--attempt', p.id])).out, /the rounds of implementers iA and iB, open at once in app \(their commits cannot be told apart\), changed the contract openapi\.json/);
});

test('review of 0.7.31 (L2): a blocking finding whose premise was reported failed is marked when a fix round hands it again beside others', () => {
  const p = project('pm-mixed');
  built(p);
  record(p, goodClosure('r1', { findings: [blocking('F1', 'src/a.txt:2'), blocking('F2', 'src/a.txt:5')] }));
  ok(wf(p.root, ['handoff', 'implementer', '--agent', 'i1', '--attempt', p.id]));
  writeReport(p.root, p.id, 'i1', { approach: 'traced F1; ran out of time on F2', expect: { minutes: 30 }, premiseFailed: [{ ref: 'r1:F1', why: 'the total is computed only for an export no production path runs', evidence: ['src/a.txt:2'] }] });
  ok(wf(p.root, ['handoff', 'close', '--agent', 'i1', '--attempt', p.id]));
  assert.equal(resume(p).decision.kind, 'repair', 'F2 still needs its fix round');
  const b = bundleOf(ok(wf(p.root, ['handoff', 'implementer', '--agent', 'i1', '--attempt', p.id])));
  const handed = b.repair.flatMap((g) => g.findings);
  assert.deepEqual(handed.map((f) => [f.ref, f.premiseFailed?.by ?? null]), [['r1:F1', 'i1'], ['r1:F2', null]]);
  assert.match(b.instructions, /marked `premiseFailed`/);
});

test('review of 0.7.31 (L4): after a planned pass, the full evidence review is handed a finding\'s failed premise with its evidence once its blind closure is recorded', () => {
  const p = project('pm-reveal');
  built(p);
  record(p, goodClosure('r1', { findings: [low('F1', 'src/a.txt:2')] }));
  ok(amend(p, { pass: [{ items: ['r1:F1', 'D1'], why: 'the label and the due date', repos: ['app'] }], expect: { minutes: 30, rounds: 1 } }));
  ok(wf(p.root, ['handoff', 'implementer', '--agent', 'i2', '--work', 'P1', '--attempt', p.id]));
  commitIn(p.wt, { 'src/b.txt': LINES.replace('l3', 'L3 as a date') }, 'the due date');
  const sha = sh(p.wt, 'git rev-parse HEAD').trim();
  writeReport(p.root, p.id, 'i2', { approach: 'the date; traced the label', expect: { minutes: 20 }, premiseFailed: [{ ref: 'r1:F1', why: 'the label is shown only on a page no production route serves', evidence: ['src/a.txt:2 is reached only from a spec'] }] });
  ok(wf(p.root, ['handoff', 'close', '--agent', 'i2', '--attempt', p.id]));
  ok(wf(p.root, ['discovered', 'close', 'D1', '--fixed', sha, '--attempt', p.id]));
  const s = resume(p);
  assert.equal(s.decision.kind, 'gate');
  assert.match(s.next, /r1:F1 \(i2: the label is shown only on a page no production route serves[^)]*\)[^;]*: [^;]*the next reviewer is handed it \(a full round once its blind closure is recorded\)/);
  ok(wf(p.root, ['gate', '--attempt', p.id]));
  const ev = bundleOf(ok(wf(p.root, ['handoff', 'reviewer', '--agent', 'r2', '--attempt', p.id])));
  assert.equal(ev.mode, 'full');
  assert.equal(ev.premiseFailed, undefined, 'a blind round is not shown an earlier finding');
  const blind = record(p, goodClosure('r2'));
  assert.match(blind.out, /1 premise\(s\) reported failed to judge \(r1:F1\), with the implementer.s evidence/);
  const reveal = JSON.parse(fs.readFileSync(blind.out.match(/: (\S+prior-findings-\S+\.json)/)[1], 'utf8'));
  assert.deepEqual(reveal.premiseFailed.map((x) => [x.ref, x.reportedBy]), [['r1:F1', 'i2']]);
  assert.match(reveal.premiseFailed[0].evidence.join(' '), /reached only from a spec/);
  record(p, goodClosure('r2', { priorFindings: [{ round: 'r1', id: 'F1', status: 'verified-nonissue', evidence: 'src/a.txt:2', rationale: 'the premise behind the fix does not hold in production paths', premise: 'does not hold: no production route serves the page' }] }));
  assert.equal(resume(p).decision.kind, 'accept');
});

// ---- Second review of 0.7.31 ----

// A fix round handed only F1 (with the reviewer's stated fix), whose commits add `files`.
function fixRoundWith(p, fix, files) {
  ok(wf(p.root, ['handoff', 'implementer', '--agent', 'i1', '--attempt', p.id]));
  commitIn(p.wt, { 'src/a.txt': LINES.replace('l2', 'L2') }, 'C1');
  ok(wf(p.root, ['handoff', 'close', '--agent', 'i1', '--attempt', p.id]));
  ok(wf(p.root, ['handoff', 'reviewer', '--agent', 'r1', '--attempt', p.id]));
  record(p, goodClosure('r1', { findings: [blocking('F1', 'src/a.txt:2', { fix })] }));
  ok(wf(p.root, ['handoff', 'implementer', '--agent', 'i1', '--attempt', p.id]));
  commitIn(p.wt, files, 'fix F1');
  writeReport(p.root, p.id, 'i1', { approach: 'the stated fix', expect: { minutes: 30 } });
  ok(wf(p.root, ['handoff', 'close', '--agent', 'i1', '--attempt', p.id]));
  return ok(wf(p.root, ['signals', '--attempt', p.id, '--json'])).json().reach;
}

test('second review of 0.7.31: a stated fix explains a migration only by naming its path, and an index file under a migrations folder is no migration', () => {
  // "no migration is needed" names no migration: the one the round adds is reached from nothing handed.
  const a = project('pm-mig-word');
  const word = fixRoundWith(a, { what: 'round the total once; no migration is needed', minutes: 30 }, { 'src/a.txt': LINES.replace('l2', 'L2 rounded'), 'db/migrations/003_total.sql': 'alter table invoice add column total_rounded numeric;\n' });
  assert.deepEqual(word.map((x) => x.migrations), [['db/migrations/003_total.sql']]);
  // A stated fix that names the migrations folder explains the migration added there.
  const b = project('pm-mig-path');
  assert.deepEqual(fixRoundWith(b, { what: 'store the rounded total: a new migration in db/migrations/ and the service change', minutes: 40 }, { 'src/a.txt': LINES.replace('l2', 'L2 rounded'), 'db/migrations/003_total.sql': 'alter table invoice add column total_rounded numeric;\n' }), []);
  // The folder's index (a barrel that lists the migrations), and its type declarations, are not migrations.
  const c = project('pm-mig-barrel');
  assert.deepEqual(fixRoundWith(c, { what: 'round the total once', minutes: 30 }, { 'src/a.txt': LINES.replace('l2', 'L2 rounded'), 'db/migrations/index.ts': 'export const migrations = [];\n', 'db/migrations/index.d.ts': 'export declare const migrations: string[];\n' }), []);
  // Third review of 0.7.31: a folder named in another case is the same folder.
  const d = project('pm-mig-case');
  assert.deepEqual(fixRoundWith(d, { what: 'store the rounded total: a new migration in DB/Migrations/', minutes: 40 }, { 'src/a.txt': LINES.replace('l2', 'L2 rounded'), 'db/migrations/003_total.sql': 'alter table invoice add column total_rounded numeric;\n' }), []);
});

test('second review of 0.7.31: a round that builds planned work and also fixes findings is judged by what it fixes', () => {
  const p = twoItems('pm-reach-mixed');
  ok(wf(p.root, ['handoff', 'implementer', '--agent', 'iA', '--work', 'W1', '--attempt', p.id]));
  commitIn(p.wt, { 'src/a.txt': LINES.replace('l2', 'L2') }, 'W1');
  writeReport(p.root, p.id, 'iA', { left: [DUE] });
  ok(wf(p.root, ['handoff', 'close', '--agent', 'iA', '--attempt', p.id]));
  ok(wf(p.root, ['check', '--attempt', p.id]));
  ok(wf(p.root, ['handoff', 'reviewer', '--agent', 'r1', '--attempt', p.id]));
  record(p, goodClosure('r1', { findings: [blocking('F1', 'src/a.txt:2', { fix: { what: 'round once', minutes: 20 } })], criteria: [{ id: 'C1', evidence: { kind: 'output', ref: 'log 1' } }, { id: 'C2', evidence: { kind: 'not-applicable', reason: 'not built yet' } }] }));
  // Handed without --work: W2's first build, F1's fix and D1 beside it, in one round.
  ok(wf(p.root, ['handoff', 'implementer', '--agent', 'iB', '--attempt', p.id]));
  assert.deepEqual(resume(p).handoffs.at(-1).fixes, { planned: ['W2'], repair: ['r1:F1'], alsoFix: ['D1'], unbounded: ['D1'] });
  commitIn(p.wt, { 'src/a.txt': LINES.replace('l2', 'L2 rounded'), 'src/b.txt': LINES.replace('l2', 'L2'), 'openapi.json': '{"paths":{"/b":{"dueDate":"date"}}}\n' }, 'W2, F1 and the due date');
  ok(wf(p.root, ['handoff', 'close', '--agent', 'iB', '--attempt', p.id]));
  const s = resume(p);
  assert.equal(s.decision.kind, 'strategy');
  assert.deepEqual(s.decision.courseSignals.map((x) => x.id), ['reach']);
  assert.match(s.next, /the fix round of implementer iB changed the contract openapi\.json/);
});

test('second review of 0.7.31: a work item handed again with words naming an open item is judged as handed that item', () => {
  const p = twoItems('pm-reach-named');
  ok(wf(p.root, ['handoff', 'implementer', '--agent', 'iA', '--work', 'W1', '--attempt', p.id]));
  ok(wf(p.root, ['handoff', 'implementer', '--agent', 'iB', '--work', 'W2', '--attempt', p.id]));
  commitIn(p.wt, { 'src/a.txt': LINES.replace('l2', 'L2'), 'src/b.txt': LINES.replace('l2', 'L2') }, 'W1 and W2');
  writeReport(p.root, p.id, 'iB', { left: [DUE] });
  ok(wf(p.root, ['handoff', 'close', '--agent', 'iA', '--attempt', p.id]));
  ok(wf(p.root, ['handoff', 'close', '--agent', 'iB', '--attempt', p.id]));
  ok(wf(p.root, ['check', '--attempt', p.id]));
  ok(wf(p.root, ['handoff', 'reviewer', '--agent', 'r1', '--attempt', p.id]));
  record(p, goodClosure('r1', { criteria: [{ id: 'C1', evidence: { kind: 'output', ref: 'log 1' } }, { id: 'C2', evidence: { kind: 'output', ref: 'log 2' } }] }));
  // W2 handed again, its context naming D1: no fix round, no pass, but D1 is what it was handed.
  ok(wf(p.root, ['handoff', 'implementer', '--agent', 'iB', '--work', 'W2', '--context', 'W2 bounded completion: fix D1', '--attempt', p.id]));
  assert.deepEqual(resume(p).handoffs.at(-1).fixes, { named: ['D1'], unbounded: ['D1'] });
  commitIn(p.wt, { 'src/b.txt': LINES.replace('l3', 'L3 as a date'), 'openapi.json': '{"paths":{"/b":{"dueDate":"date"}}}\n' }, 'D1');
  ok(wf(p.root, ['handoff', 'close', '--agent', 'iB', '--attempt', p.id]));
  const reach = ok(wf(p.root, ['signals', '--attempt', p.id, '--json'])).json().reach;
  assert.deepEqual(reach.map((x) => [x.agent, x.contracts]), [['iB', ['openapi.json']]]);
  const text = ok(wf(p.root, ['signals', '--attempt', p.id])).out;
  assert.match(text, /handed D1, with 1 handed item with no stated fix \(unbounded\): D1/);
  // Third review of 0.7.31: it is a re-handoff of the work item, not a fix round, and the line says so.
  assert.match(text, /the re-handoff of work item W2 to implementer iB changed the contract openapi\.json/);
});

test('third review of 0.7.31: a work item whose definition an amendment restated since its last build, stating the contract change, is planned work for it', () => {
  const p = twoItems('pm-reach-amended');
  ok(wf(p.root, ['handoff', 'implementer', '--agent', 'iA', '--work', 'W1', '--attempt', p.id]));
  ok(wf(p.root, ['handoff', 'implementer', '--agent', 'iB', '--work', 'W2', '--attempt', p.id]));
  commitIn(p.wt, { 'src/a.txt': LINES.replace('l2', 'L2'), 'src/b.txt': LINES.replace('l2', 'L2') }, 'W1 and W2');
  writeReport(p.root, p.id, 'iB', { left: [DUE] });
  ok(wf(p.root, ['handoff', 'close', '--agent', 'iA', '--attempt', p.id]));
  ok(wf(p.root, ['handoff', 'close', '--agent', 'iB', '--attempt', p.id]));
  ok(wf(p.root, ['check', '--attempt', p.id]));
  ok(wf(p.root, ['handoff', 'reviewer', '--agent', 'r1', '--attempt', p.id]));
  record(p, goodClosure('r1', { criteria: [{ id: 'C1', evidence: { kind: 'output', ref: 'log 1' } }, { id: 'C2', evidence: { kind: 'output', ref: 'log 2' } }] }));
  // The owner restates W2 with the accepted contract: the /b response carries the due date as a date (D1).
  const work = [WORK[0], { ...WORK[1], why: 'b, and fix D1: the /b response sends dueDate as a date under this accepted contract' }];
  ok(wf(p.root, ['criteria', 'amend', '--file', closureFile(p.base, { work, scope: { endpoints: ['GET /b'] }, impact: { unchanged: 'the same module' } }), '--reason', 'accept the /b contract for D1', '--attempt', p.id]));
  ok(wf(p.root, ['handoff', 'implementer', '--agent', 'iB', '--work', 'W2', '--attempt', p.id]));
  assert.deepEqual(resume(p).handoffs.at(-1).fixes, { named: ['D1'], unbounded: ['D1'] }, 'D1 is still what it was handed');
  commitIn(p.wt, { 'src/b.txt': LINES.replace('l3', 'L3 as a date'), 'openapi.json': '{"paths":{"/b":{"dueDate":"date"}}}\n' }, 'D1 under the accepted contract');
  ok(wf(p.root, ['handoff', 'close', '--agent', 'iB', '--attempt', p.id]));
  assert.deepEqual(ok(wf(p.root, ['signals', '--attempt', p.id, '--json'])).json().reach, [], 'the amendment planned that contract change');
});

// Work items W1 and W2 built, D1 left by W2's implementer, a clean first review: the point where a work item is handed again.
function reviewedTwo(name) {
  const p = twoItems(name);
  ok(wf(p.root, ['handoff', 'implementer', '--agent', 'iA', '--work', 'W1', '--attempt', p.id]));
  ok(wf(p.root, ['handoff', 'implementer', '--agent', 'iB', '--work', 'W2', '--attempt', p.id]));
  commitIn(p.wt, { 'src/a.txt': LINES.replace('l2', 'L2'), 'src/b.txt': LINES.replace('l2', 'L2') }, 'W1 and W2');
  writeReport(p.root, p.id, 'iB', { left: [DUE] });
  ok(wf(p.root, ['handoff', 'close', '--agent', 'iA', '--attempt', p.id]));
  ok(wf(p.root, ['handoff', 'close', '--agent', 'iB', '--attempt', p.id]));
  ok(wf(p.root, ['check', '--attempt', p.id]));
  ok(wf(p.root, ['handoff', 'reviewer', '--agent', 'r1', '--attempt', p.id]));
  record(p, goodClosure('r1', { criteria: [{ id: 'C1', evidence: { kind: 'output', ref: 'log 1' } }, { id: 'C2', evidence: { kind: 'output', ref: 'log 2' } }] }));
  return p;
}
const amendW = (p, doc) => ok(wf(p.root, ['criteria', 'amend', '--file', closureFile(p.base, doc), '--reason', 'restate W2 for D1', '--attempt', p.id]));
const reshape = (p, agent, files = {}) => {
  commitIn(p.wt, { 'src/b.txt': LINES.replace('l3', 'L3 as a date'), 'openapi.json': '{"paths":{"/b":{"dueDate":"date"},"/b/{id}":{"409":"due-date-locked"}}}\n', ...files }, 'D1');
  ok(wf(p.root, ['handoff', 'close', '--agent', agent, '--attempt', p.id]));
  return ok(wf(p.root, ['signals', '--attempt', p.id, '--json'])).json().reach;
};
const restated = [WORK[0], { ...WORK[1], why: 'b, and fix D1' }];

test('fourth review of 0.7.31: a re-plan explains a contract file only through an impact addendum whose change for the item lists it; a criterion reworded under `unchanged` explains nothing', () => {
  // The dodge (a review's reproduction): C2's acceptance check reworded, `impact: { unchanged }`, then a contract reshape and a
  // migration. Nothing planned them.
  const d = reviewedTwo('pm-reach-dodge');
  amendW(d, { work: restated, criteria: [{ id: 'C2', text: 'b changes', uat: 'b shows the new text (wording)' }], impact: { unchanged: 'wording only' } });
  ok(wf(d.root, ['handoff', 'implementer', '--agent', 'iB', '--work', 'W2', '--attempt', d.id]));
  const dodge = reshape(d, 'iB', { 'db/migrations/004_due.sql': 'alter table invoice alter column due type date;\n' });
  assert.deepEqual(dodge.map((x) => [x.contracts, x.migrations]), [[['openapi.json'], ['db/migrations/004_due.sql']]]);
  // A real re-plan: an addendum whose change for W2 crosses the contract a query finds in openapi.json.
  const p = reviewedTwo('pm-reach-replanned');
  const q = { id: 'QB', pattern: '"paths"', kind: 'literal', repo: 'app', paths: ['openapi.json'] };
  const hits = ok(wf(p.root, ['impact', 'run', '--attempt', p.id, '--query', JSON.stringify(q), '--json'])).json()[0].hits;
  const change = { id: 'IB', element: 'the /b response carries the due date as a date', kind: 'dto', cites: ['C2'], covers: [], consumers: { query: 'QB', hits }, flows: [{ flow: 'read b', failure: 'b shows an error', query: 'QB', hits }], contracts: [{ query: 'QB', hits }], suites: [{ suite: 'unit', query: 'QB', hits }], work: ['W2'] };
  amendW(p, { work: restated, criteria: [{ id: 'C2', text: 'b changes, and its response sends the due date as a date', uat: 'b shows a date' }], impact: { queries: [{ ...q, hits }], changes: [change] } });
  ok(wf(p.root, ['handoff', 'implementer', '--agent', 'iB', '--work', 'W2', '--attempt', p.id]));
  assert.deepEqual(reshape(p, 'iB'), [], 'the addendum planned the change to openapi.json');
});

test('fourth review of 0.7.31: an amendment that lands while the item\'s last build is open is not "since its last build"; overlapping rounds share what explains a file', () => {
  // The amendment states W2's endpoint while W2's first build is still open: the re-handoff after it is judged.
  const p = twoItems('pm-reach-window');
  ok(wf(p.root, ['handoff', 'implementer', '--agent', 'iA', '--work', 'W1', '--attempt', p.id]));
  ok(wf(p.root, ['handoff', 'implementer', '--agent', 'iB', '--work', 'W2', '--attempt', p.id]));
  commitIn(p.wt, { 'src/a.txt': LINES.replace('l2', 'L2'), 'src/b.txt': LINES.replace('l2', 'L2') }, 'W1 and W2');
  amendW(p, { work: restated, scope: { endpoints: ['GET /b'] }, impact: { unchanged: 'the same module' } });
  writeReport(p.root, p.id, 'iB', { left: [DUE] });
  ok(wf(p.root, ['handoff', 'close', '--agent', 'iA', '--attempt', p.id]));
  ok(wf(p.root, ['handoff', 'close', '--agent', 'iB', '--attempt', p.id]));
  ok(wf(p.root, ['check', '--attempt', p.id]));
  ok(wf(p.root, ['handoff', 'reviewer', '--agent', 'r1', '--attempt', p.id]));
  record(p, goodClosure('r1', { criteria: [{ id: 'C1', evidence: { kind: 'output', ref: 'log 1' } }, { id: 'C2', evidence: { kind: 'output', ref: 'log 2' } }] }));
  ok(wf(p.root, ['handoff', 'implementer', '--agent', 'iB', '--work', 'W2', '--attempt', p.id]));
  assert.equal(reshape(p, 'iB').length, 1, 'the endpoint was stated for the build that was open, not since it');
  // W1 restated with its endpoint since its last build and handed again beside W2's re-handoff for D1: one commit changes the
  // contract while both are open, and W1's amendment explains it for both.
  const o = reviewedTwo('pm-reach-overlap');
  amendW(o, { work: [{ ...WORK[0], why: 'a, and the /b response under the accepted contract' }, WORK[1]], scope: { endpoints: ['GET /b'] }, impact: { unchanged: 'the same module' } });
  ok(wf(o.root, ['handoff', 'implementer', '--agent', 'iA', '--work', 'W1', '--attempt', o.id]));
  ok(wf(o.root, ['handoff', 'implementer', '--agent', 'iB', '--work', 'W2', '--context', 'fix D1', '--attempt', o.id]));
  commitIn(o.wt, { 'openapi.json': '{"paths":{"/b":{"dueDate":"date"}}}\n' }, 'the /b contract');
  ok(wf(o.root, ['handoff', 'close', '--agent', 'iA', '--attempt', o.id]));
  ok(wf(o.root, ['handoff', 'close', '--agent', 'iB', '--attempt', o.id]));
  assert.deepEqual(ok(wf(o.root, ['signals', '--attempt', o.id, '--json'])).json().reach, [], 'W1\'s amendment explains the change for the round beside it');
});

test('fourth review of 0.7.31: an amendment\'s stated endpoints explain only the contract files they name', () => {
  const DTO = { components: [...API.components, { id: 'web', kind: 'web', repo: 'app', dependsOn: [{ component: 'api', via: 'http', contract: 'src/**/dto/**' }] }] };
  const run = (name, endpoint, dto = 'src/billing/dto/due-date.dto.ts') => {
    const p = singleRepoProject(name, { gate: { steps }, ...DTO }, { 'src/a.txt': LINES, 'src/b.txt': LINES, 'openapi.json': '{"paths":{}}\n', [dto]: 'export class DueDto {}\n' });
    const e = ok(wf(p.root, ['entry', '--item', 'PM-4', '--owner', 'o', '--json'])).json();
    ok(wf(p.root, ['handoff', 'planner', '--agent', 'p', '--attempt', e.id]));
    const plan = path.join(p.base, 'plan.json');
    fs.writeFileSync(plan, JSON.stringify(planDoc({ plan: { summary: 'change a and b', expect: EXPECT, anchors: ['src/a.txt', 'src/b.txt'] }, criteria: C2, work: WORK })));
    ok(wf(p.root, ['plan', '--file', plan, '--attempt', e.id]));
    const q = { ...p, id: e.id, wt: e.repos.app.worktree };
    ok(wf(q.root, ['handoff', 'implementer', '--agent', 'iA', '--work', 'W1', '--attempt', q.id]));
    ok(wf(q.root, ['handoff', 'implementer', '--agent', 'iB', '--work', 'W2', '--attempt', q.id]));
    commitIn(q.wt, { 'src/a.txt': LINES.replace('l2', 'L2'), 'src/b.txt': LINES.replace('l2', 'L2') }, 'W1 and W2');
    writeReport(q.root, q.id, 'iB', { left: [DUE] });
    ok(wf(q.root, ['handoff', 'close', '--agent', 'iA', '--attempt', q.id]));
    ok(wf(q.root, ['handoff', 'close', '--agent', 'iB', '--attempt', q.id]));
    ok(wf(q.root, ['check', '--attempt', q.id]));
    ok(wf(q.root, ['handoff', 'reviewer', '--agent', 'r1', '--attempt', q.id]));
    record(q, goodClosure('r1', { criteria: [{ id: 'C1', evidence: { kind: 'output', ref: 'log 1' } }, { id: 'C2', evidence: { kind: 'output', ref: 'log 2' } }] }));
    amendW(q, { work: restated, scope: { endpoints: [endpoint] }, impact: { unchanged: 'the same module' } });
    ok(wf(q.root, ['handoff', 'implementer', '--agent', 'iB', '--work', 'W2', '--attempt', q.id]));
    commitIn(q.wt, { [dto]: 'export class DueDto { dueDate!: string }\n' }, 'D1');
    ok(wf(q.root, ['handoff', 'close', '--agent', 'iB', '--attempt', q.id]));
    return ok(wf(q.root, ['signals', '--attempt', q.id, '--json'])).json().reach.map((x) => x.contracts);
  };
  assert.deepEqual(run('pm-scope-named', 'PATCH /api/v1/billing/due-dates'), [], 'the stated endpoint names the DTO it changed');
  assert.deepEqual(run('pm-scope-other', 'GET /api/v1/invoices/uninvoiced'), [['src/billing/dto/due-date.dto.ts']], 'another endpoint explains nothing here');
  // Fifth review of 0.7.31: the words are the file's own name, not its folders: a two-word module folder supplied both words, so one
  // endpoint of a module explained every contract file in it.
  assert.deepEqual(run('pm-scope-module', 'PUT /api/v1/resource-management/demands/:demandId/required-skills', 'src/resource-management/dto/resource-allocation.dto.ts'), [['src/resource-management/dto/resource-allocation.dto.ts']]);
});

// Fifth review of 0.7.31: what explains a file is read with its repo, and a spec is a component's own. Read through `reachOf` on two
// real repos and a recorded state (a two-repo attempt with an addendum and an amendment's scope).
function twoRepoReach({ planned = [], scope = null, changed, components }) {
  const base = tmp('pm-two-repos');
  const api = makeRepo(path.join(base, 'api'), { 'src/a.txt': LINES }).dir;
  const portal = makeRepo(path.join(base, 'portal'), { 'src/a.txt': LINES }).dir;
  const head = (dir) => sh(dir, 'git rev-parse HEAD').trim();
  const from = { api: head(api), portal: head(portal) };
  commitIn(api, changed, 'the re-handoff');
  const cfg = parseConfig(JSON.stringify({ version: 1, enabled: true, name: 'two', repos: [{ name: 'api', path: 'api', base: 'main' }, { name: 'portal', path: 'portal', base: 'main' }], components }), 'two.yaml');
  const at = (s) => `2026-01-01T00:00:${String(s).padStart(2, '0')}.000Z`;
  const state = {
    repos: { api: { worktree: api, base: from.api }, portal: { worktree: portal, base: from.portal } },
    work: [{ id: 'W2', criteria: ['C2'], repos: ['api', 'portal'] }],
    handoffs: [{ role: 'implementer', agent: 'iB', bundle: '/h/01-implementer.json', at: at(1), work: 'W2' }, { role: 'implementer', agent: 'iB', bundle: '/h/02-implementer.json', at: at(5), work: 'W2', fixes: { named: ['D1'], unbounded: ['D1'] } }],
    implementers: [{ handoff: '01-implementer', agent: 'iB', work: 'W2', heads: from, closedHeads: from, openedAt: at(1), closedAt: at(2), outcome: 'done' }, { handoff: '02-implementer', agent: 'iB', work: 'W2', heads: from, closedHeads: { api: head(api), portal: from.portal }, openedAt: at(5), closedAt: at(9), outcome: 'done' }],
    workAmended: { W2: [{ at: at(3), amendment: 1, why: 'fix D1', criteria: ['C2'] }] },
    criteriaAmendments: [{ at: at(3), scope }],
    impact: { results: {}, addenda: planned.length ? [{ amendment: 1, changes: planned, results: {} }] : [] },
    discovered: [{ id: 'D1', status: 'open', where: 'portal/src/a.txt:1' }],
    reviews: [],
  };
  return reachOf(state, cfg, state.handoffs[1]);
}

test('fifth review of 0.7.31: a planned file is read with its repo, and a spec explains a stated endpoint only for its own component', () => {
  const dto = [{ id: 'api', kind: 'service', repo: 'api', provides: [{ contract: 'http', spec: 'openapi.json' }] }, { id: 'portal', kind: 'web', repo: 'portal', dependsOn: [{ component: 'api', via: 'http', contract: 'api/src/**/dto/**' }] }];
  // The addendum's change for W2 found portal's file of the same path: it plans nothing in the api.
  const portalOnly = twoRepoReach({ components: dto, changed: { 'src/shared/dto/due.dto.ts': 'export class DueDto {}\n' }, planned: [{ work: ['W2'], kind: 'dto', contracts: [{ query: 'Q', files: ['portal:src/shared/dto/due.dto.ts'] }] }] });
  assert.deepEqual(portalOnly.contracts, ['src/shared/dto/due.dto.ts']);
  const apiToo = twoRepoReach({ components: dto, changed: { 'src/shared/dto/due.dto.ts': 'export class DueDto {}\n' }, planned: [{ work: ['W2'], kind: 'dto', contracts: [{ query: 'Q', files: ['api:src/shared/dto/due.dto.ts'] }] }] });
  assert.deepEqual(apiToo.contracts, [], 'the api file it found is planned');
  // A vendored copy of another component's spec is not the changed file's own component's spec.
  const vendored = [{ id: 'api', kind: 'service', repo: 'api', provides: [{ contract: 'http', spec: 'openapi.json' }] }, { id: 'admin', kind: 'web', repo: 'api', package: 'admin', dependsOn: [{ component: 'api', via: 'http', contract: 'api/admin/vendor/openapi.json' }] }];
  const copy = twoRepoReach({ components: vendored, changed: { 'admin/vendor/openapi.json': '{"paths":{"/b":{}}}\n' }, scope: { endpoints: 1, errorCodes: 0, names: ['GET /b'] } });
  assert.deepEqual(copy.contracts, ['admin/vendor/openapi.json']);
  const own = twoRepoReach({ components: vendored, changed: { 'openapi.json': '{"paths":{"/b":{}}}\n' }, scope: { endpoints: 1, errorCodes: 0, names: ['GET /b'] } });
  assert.deepEqual(own.contracts, [], 'the api\'s own spec carries the endpoint it states');
});
