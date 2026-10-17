// 0.7.28 (I-207), named failure (field, a three-ticket batch): ten of one ticket's sixteen review rounds were low-only or empty.
// Each low finding and each item an implementer left (56 of 61 discovered issues) became its own implementer round, then its own
// review round: an open discovered issue made "fix it" the next step before any review, and a clean review with observations sent
// the owner to "fix them now in one pass (then the next review round)", round after round. The person's standing "fix all" was
// used to open each one. Now what does not block joins the fix round that happens anyway, or one planned pass (an amendment's
// `pass`), built by one implementer and verified by the evidence review after the gate, with no code-review round of its own; and
// the person's "fix all" is recorded once and never asked again.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { closureFile, commitIn, goodClosure, ok, planDoc, sh, singleRepoProject, wf, writeReport } from './helpers.mjs';

const steps = [{ id: 'unit', repo: 'app', run: 'true' }];
const LINES = 'l1\nl2\nl3\nl4\nl5\nl6\n';
// A plan that predicts enough rounds and files that no course signal fires in these flows (engine/course.mjs is tested apart).
const EXPECT = { files: 10, rounds: 6, minutes: 600 };

function project(name) {
  const p = singleRepoProject(name, { gate: { steps } }, { 'src/a.txt': LINES, 'src/b.txt': LINES });
  const e = ok(wf(p.root, ['entry', '--item', 'PP-1', '--owner', 'o', '--json'])).json();
  ok(wf(p.root, ['handoff', 'planner', '--agent', 'p', '--attempt', e.id]));
  const plan = path.join(p.base, 'plan.json');
  fs.writeFileSync(plan, JSON.stringify(planDoc({ plan: { summary: 'change a', expect: EXPECT, anchors: ['src/a.txt'] }, criteria: [{ id: 'C1', text: 'a changes', uat: 'a shows the new text' }] })));
  ok(wf(p.root, ['plan', '--file', plan, '--attempt', e.id]));
  return { ...p, id: e.id, wt: e.repos.app.worktree };
}
const bundleOf = (r) => JSON.parse(fs.readFileSync((r.out.match(/^Read (\S+)/m) ?? r.out.match(/bundle: (\S+)/))[1], 'utf8'));
const resume = (p) => ok(wf(p.root, ['resume', '--attempt', p.id, '--json'])).json();
const record = (p, closure) => ok(wf(p.root, ['review', '--closure', closureFile(p.base, closure), '--attempt', p.id]));
const amend = (p, doc, extra = []) => wf(p.root, ['criteria', 'amend', '--file', closureFile(p.base, doc), '--reason', 'one planned pass for what does not block', '--attempt', p.id, ...extra]);
const low = (id, evidence) => ({ id, severity: 'low', summary: `${id}: the label reads oddly`, status: 'open', evidence, family: 'label-copy' });

test('a low finding and an item an implementer left never open a round: they wait for one planned pass, built by one implementer and verified by the evidence review after the gate', () => {
  const p = project('pp-pass');
  ok(wf(p.root, ['handoff', 'implementer', '--agent', 'i1', '--attempt', p.id]));
  commitIn(p.wt, { 'src/a.txt': LINES.replace('l2', 'L2') }, 'implement C1');
  writeReport(p.root, p.id, 'i1', { left: [{ what: 'the export page sums one page only', where: 'src/b.txt:4', why: 'not caused by this change', severity: 'low' }] });
  ok(wf(p.root, ['handoff', 'close', '--agent', 'i1', '--attempt', p.id]));
  // The left item is recorded, and the next step is the review, not a fix round for it.
  let s = resume(p);
  assert.equal(s.discovered.filter((d) => d.status === 'open').length, 1);
  assert.equal(s.decision.kind, 'review', 'an open discovered issue opens no round before the review');
  assert.doesNotMatch(s.next, /fix the discovered issue/);
  ok(wf(p.root, ['handoff', 'reviewer', '--agent', 'r1', '--attempt', p.id]));
  record(p, goodClosure('r1', { findings: [low('F1', 'src/a.txt:2')] }));
  // A clean review with a low finding and the left item: one planned pass, never a round each.
  s = resume(p);
  assert.equal(s.decision.kind, 'pass');
  assert.deepEqual(s.decision.outstanding, ['r1:F1', 'D1']);
  assert.match(s.next, /2 item\(s\) that do not block are open \(r1:F1 \(low\), D1 \(low\)\): they are fixed in one planned pass, never a round each/);
  assert.match(s.next, /`pass: \[\{ items: \["r1:F1", "D1"\]/);
  // The pass is planned: one amendment names both, with its own expectation.
  const planned = ok(amend(p, { pass: [{ items: ['r1:F1', 'D1'], why: 'the label copy and the export total', repos: ['app'] }], expect: { minutes: 30, rounds: 1 } }));
  assert.match(planned.out, /planned pass P1: r1:F1, D1/);
  s = resume(p);
  assert.equal(s.decision.kind, 'implementation');
  assert.deepEqual(s.work.find((w) => w.id === 'P1').items, ['r1:F1', 'D1']);
  // The pass's implementer is handed each item with what was said of it, and the finding history (I-209).
  const b = bundleOf(ok(wf(p.root, ['handoff', 'implementer', '--agent', 'i2', '--work', 'P1', '--attempt', p.id])));
  assert.deepEqual(b.passItems.map((x) => [x.work, x.items.map((i) => [i.ref, i.kind])]), [['P1', [['r1:F1', 'finding'], ['D1', 'discovered']]]]);
  assert.match(b.instructions, /This is a planned pass: `passItems` holds the findings and discovered issues it fixes/);
  assert.deepEqual(b.findingHistory.map((h) => h.ref), ['r1:F1']);
  commitIn(p.wt, { 'src/a.txt': LINES.replace('l2', 'L2 fixed'), 'src/b.txt': LINES.replace('l4', 'L4 fixed') }, 'the planned pass');
  const sha = sh(p.wt, 'git rev-parse HEAD').trim();
  ok(wf(p.root, ['handoff', 'close', '--agent', 'i2', '--attempt', p.id]));
  ok(wf(p.root, ['discovered', 'close', 'D1', '--fixed', sha, '--attempt', p.id]));
  // Built: the gate is next, with no code-review round of its own; the evidence review after it verifies the pass.
  s = resume(p);
  assert.equal(s.decision.kind, 'gate');
  assert.equal(s.decision.status, 'ready');
  assert.match(s.next, /the planned pass is built: run one `wf gate`; the evidence review after it verifies the pass/);
  ok(wf(p.root, ['gate', '--attempt', p.id]));
  s = resume(p);
  assert.equal(s.decision.kind, 'review');
  const evidence = bundleOf(ok(wf(p.root, ['handoff', 'reviewer', '--agent', 'r2', '--attempt', p.id])));
  assert.equal(evidence.round, 'evidence-review');
  // Review of 0.7.28 (L1): the one review the pass gets is told it was built, with its items and the commits recorded for them.
  assert.deepEqual(evidence.passBuilt.map((x) => [x.work, x.items.map((i) => [i.ref, i.kind, Boolean(i.fixedIn)])]), [['P1', [['r1:F1', 'finding', false], ['D1', 'discovered', true]]]]);
  assert.equal(evidence.passBuilt[0].items[1].fixedIn.commit, sha.slice(0, 12));
  assert.match(evidence.instructions, /A planned pass was built since the last review, with no code-review round of its own \(P1: r1:F1, D1\)/);
  // The first evidence review is a blind full audit: the earlier findings are verified in its second record.
  record(p, goodClosure('r2'));
  record(p, goodClosure('r2', { priorFindings: [{ round: 'r1', id: 'F1', status: 'fixed', evidence: 'src/a.txt:2 reads well' }] }));
  assert.equal(resume(p).decision.kind, 'accept');
  ok(wf(p.root, ['accept', '--attempt', p.id]));
  // Two review rounds in all: the low finding and the left item cost no round of their own.
  assert.equal(resume(p).handoffs.filter((h) => h.role === 'reviewer').length, 2);
});

test('in a fix round, what does not block joins the same pass (`alsoFix`), never a round of its own', () => {
  const p = project('pp-join');
  ok(wf(p.root, ['handoff', 'implementer', '--agent', 'i1', '--attempt', p.id]));
  commitIn(p.wt, { 'src/a.txt': LINES.replace('l2', 'L2') }, 'implement C1');
  writeReport(p.root, p.id, 'i1', { left: [{ what: 'the empty state shows no message', where: 'src/b.txt:3', why: 'not caused by this change', severity: 'medium' }] });
  ok(wf(p.root, ['handoff', 'close', '--agent', 'i1', '--attempt', p.id]));
  ok(wf(p.root, ['handoff', 'reviewer', '--agent', 'r1', '--attempt', p.id]));
  record(p, goodClosure('r1', { findings: [{ id: 'F1', severity: 'major', summary: 'F1: the label is wrong', status: 'open', evidence: 'src/a.txt:2', criterion: 'C1' }, low('F2', 'src/b.txt:5')] }));
  const s = resume(p);
  assert.equal(s.decision.kind, 'repair');
  assert.match(s.next, /the 2 item\(s\) that do not block \(r1:F2, D1\) join this same pass \(its bundle lists them under `alsoFix`\), never a round of their own/);
  const b = bundleOf(ok(wf(p.root, ['handoff', 'implementer', '--agent', 'i1', '--attempt', p.id])));
  assert.deepEqual(b.repair.flatMap((g) => g.findings.map((f) => `${f.round}:${f.id}`)), ['r1:F1']);
  assert.deepEqual(b.alsoFix.map((x) => x.ref), ['r1:F2', 'D1']);
  assert.match(b.instructions, /`alsoFix` holds what does not block and is still open: fix it in this same pass/);
});

test('a pass names only what waits for one: a blocking finding is refused with where it goes, an outstanding item left out is said', () => {
  const p = project('pp-refuse');
  ok(wf(p.root, ['handoff', 'implementer', '--agent', 'i1', '--attempt', p.id]));
  commitIn(p.wt, { 'src/a.txt': LINES.replace('l2', 'L2') }, 'implement C1');
  ok(wf(p.root, ['handoff', 'close', '--agent', 'i1', '--attempt', p.id]));
  ok(wf(p.root, ['handoff', 'reviewer', '--agent', 'r1', '--attempt', p.id]));
  record(p, goodClosure('r1', { findings: [{ id: 'F1', severity: 'major', summary: 'F1: wrong', status: 'open', evidence: 'src/a.txt:2', criterion: 'C1' }, low('F2', 'src/b.txt:5'), low('F3', 'src/b.txt:6')] }));
  const refused = amend(p, { pass: [{ items: ['r1:F1'], why: 'x' }] });
  assert.equal(refused.code, 75);
  assert.match(refused.err, /pass\[0\] names r1:F1, which is not an open finding or discovered issue that waits for a pass \(outstanding: r1:F2, r1:F3\)/);
  assert.match(refused.err, /a finding that blocks is fixed in a fix round/);
  const partial = ok(amend(p, { pass: [{ items: ['r1:F2'], why: 'x' }] }));
  assert.match(partial.err, /not in this pass: r1:F3: an item no pass names waits for another pass/);
});

// Review of 0.7.28 (L2): the person's words are proven theirs, as a reading of an answer is (D41), since their effect stands.
const CLAUDE = 'c1aude00-0000-4000-8000-0000000f1a11';
const personWrites = (p, text, offsetMs = 1000) => {
  const file = path.join(p.base, '.home', '.claude', 'projects', 'proj', `${CLAUDE}.jsonl`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const when = (ms) => new Date(Date.now() + ms).toISOString();
  fs.appendFileSync(file, [{ type: 'assistant', timestamp: when(offsetMs - 500), message: { role: 'assistant', content: [{ type: 'text', text: 'Fix the label finding now, or let it leave?' }] } }, { type: 'user', timestamp: when(offsetMs), message: { role: 'user', content: text } }].map((l) => JSON.stringify(l)).join('\n') + '\n');
};
const session = { env: { CLAUDE_CODE_SESSION_ID: CLAUDE } };

test("the person's \"fix all\" is recorded once, from their own words: no item is asked about leaving again, unless they direct one out in new words", () => {
  const p = project('pp-fixall');
  ok(wf(p.root, ['handoff', 'implementer', '--agent', 'i1', '--attempt', p.id]));
  commitIn(p.wt, { 'src/a.txt': LINES.replace('l2', 'L2') }, 'implement C1');
  ok(wf(p.root, ['handoff', 'close', '--agent', 'i1', '--attempt', p.id]));
  ok(wf(p.root, ['handoff', 'reviewer', '--agent', 'r1', '--attempt', p.id]));
  record(p, goodClosure('r1', { findings: [low('F1', 'src/b.txt:5')] }));
  // Words the person never wrote are not recorded as theirs.
  personWrites(p, 'looks good so far');
  const unproven = wf(p.root, ['scope', 'fix-all', '--person-said', 'fix all', '--attempt', p.id], session);
  assert.equal(unproven.code, 75);
  assert.match(unproven.err, /not recorded: "fix all" is in no message of the person's in this session/);
  personWrites(p, 'fix all of them, every one', 2000);
  const first = ok(wf(p.root, ['scope', 'fix-all', '--person-said', 'fix all of them', '--attempt', p.id], session));
  assert.match(first.out, /the person said to fix every item \("fix all of them"\)/);
  assert.match(resume(p).fixAll.via, /^chat, read by the agent/);
  assert.match(ok(wf(p.root, ['scope', 'fix-all', '--person-said', 'fix them all', '--attempt', p.id], session)).out, /already recorded on .*: "fix all of them"; nothing is asked again/);
  const asked = wf(p.root, ['scope', 'defer', '--finding', 'r1:F1', '--attempt', p.id], { ownerSilent: true });
  assert.equal(asked.code, 75);
  assert.match(asked.err, /the person said to fix every item \("fix all of them", [^)]+\), so r1:F1 is fixed in this delivery and not asked about again/);
  assert.equal(resume(p).decisions.filter((d) => d.key === 'leave:r1:F1').length, 0, 'no question was created');
  assert.match(resume(p).next, /the person said to fix every item \("fix all of them"\): no item is asked about again and none opens a round of its own/);
  // Their new words directing one out ask that item.
  const directed = wf(p.root, ['scope', 'defer', '--finding', 'r1:F1', '--person-directed', 'ok, let the label one go', '--attempt', p.id], { ownerSilent: true });
  assert.doesNotMatch(directed.err, /fix every item/);
});

// Second review of 0.7.28. Named failure (a review's case): the person's kickoff, "implement PP-1 and fix all findings, do not ask me
// about leaving any", written a minute before `wf entry`, was refused as words about another ticket, so the agent would have had to
// ask them again. Their instruction counts when it is the message that started the attempt or names its item; words about another
// ticket still do not, and the refusal says what the message names.
test('"fix all" given in the message that started the attempt, or in one naming its item, counts; a message about another ticket does not', () => {
  const p = singleRepoProject('pp-kickoff', { gate: { steps } }, { 'src/a.txt': LINES, 'src/b.txt': LINES });
  const file = path.join(p.base, '.home', '.claude', 'projects', 'proj', `${CLAUDE}.jsonl`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const ago = (s) => new Date(Date.now() - s * 1000).toISOString();
  const said = (text, secondsAgo) => fs.appendFileSync(file, `${JSON.stringify({ type: 'user', timestamp: ago(secondsAgo), message: { role: 'user', content: text } })}\n`);
  said('for ENG-9 just fix all of them too', 300);
  said('fix every finding without asking me, every one', 200);
  said('and for PP-4 fix all the lows as well', 120);
  said('implement the ticket and fix all findings, do not ask me about leaving any', 60);
  const e = ok(wf(p.root, ['entry', '--item', 'PP-3', '--owner', 'o', '--json'])).json();
  // About another ticket: refused, saying what the message names.
  const other = wf(p.root, ['scope', 'fix-all', '--person-said', 'just fix all of them', '--attempt', e.id], session);
  assert.equal(other.code, 75);
  assert.match(other.err, /before this attempt was admitted .*, in a message that names ENG-9, not PP-3: words about something else/);
  // Neither the message that started it nor one naming PP-3: refused, saying so.
  const older = wf(p.root, ['scope', 'fix-all', '--person-said', 'fix every finding without asking me', '--attempt', e.id], session);
  assert.equal(older.code, 75);
  assert.match(older.err, /in a message that does not name PP-3 and is not the one that started it \(their last chat message before the admission that answers no decision's question, at [^)]+\): words about something else/);
  // The kickoff counts, and the record says why.
  const kicked = ok(wf(p.root, ['scope', 'fix-all', '--person-said', 'fix all findings, do not ask me about leaving any', '--attempt', e.id], session));
  assert.match(kicked.out, /the person said to fix every item \("fix all findings, do not ask me about leaving any"\)/);
  assert.match(JSON.parse(ok(wf(p.root, ['resume', '--attempt', e.id, '--json'])).out).fixAll.via, /the message that started this attempt \(the last before its admission\)/);
  // A message before the admission that names the attempt's item counts too.
  const e4 = ok(wf(p.root, ['entry', '--item', 'PP-4', '--owner', 'o', '--json'])).json();
  ok(wf(p.root, ['scope', 'fix-all', '--person-said', 'for PP-4 fix all the lows as well', '--attempt', e4.id], session));
  assert.match(JSON.parse(ok(wf(p.root, ['resume', '--attempt', e4.id, '--json'])).out).fixAll.via, /written before the admission, naming PP-4/);
});

// Third review of 0.7.28. Named failures (a review's cases): "for ENG-9 fix all the lows, do not ask me about them", the last message
// before PP-3 was admitted, was recorded as PP-3's kickoff; so was a question-panel answer to ENG-9's decision. The kickoff is a chat
// message that answers no decision's question and names no other item; a reply to another attempt's question is never this one's;
// a message naming this item and others says so in the read-back; an encoding's name is no ticket id.
test('"fix all" said about another ticket is never this one\'s: not as the last message, not as a panel answer to its question; one naming others says so', () => {
  const p = singleRepoProject('pp-kickoff-else', { gate: { steps } }, { 'src/a.txt': LINES, 'src/b.txt': LINES });
  const file = path.join(p.base, '.home', '.claude', 'projects', 'proj', `${CLAUDE}.jsonl`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const ago = (sec) => new Date(Date.now() - sec * 1000).toISOString();
  const line = (x) => fs.appendFileSync(file, `${JSON.stringify(x)}\n`);
  const said = (text, sec) => line({ type: 'user', timestamp: ago(sec), message: { role: 'user', content: text } });
  const panel = (question, answer, sec) => {
    const id = `toolu_${Math.random().toString(36).slice(2)}`;
    line({ type: 'assistant', timestamp: ago(sec + 1), message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'AskUserQuestion', input: { questions: [{ question, header: 'wf', multiSelect: false, options: [{ label: 'Fix it now', description: 'x' }, { label: 'Let it leave', description: 'y' }] }] } }] } });
    line({ type: 'user', timestamp: ago(sec), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: `Your questions have been answered: "${question}"="${answer}".` }] }, toolUseResult: { questions: [], answers: { [question]: answer } } });
  };
  said('implement PP-3', 400);
  said('for PP-5 and ENG-9, fix all the copy findings, store it as UTF-8', 300);
  panel('ENG-9.1 A2: ENG-9.1 r1:F3: the label reads oddly. Fix it now, or let it leave?', 'No, fix all of them', 200);
  said('for ENG-9 fix all the lows, do not ask me about them', 60);
  const e = ok(wf(p.root, ['entry', '--item', 'PP-3', '--owner', 'o', '--json'])).json();
  const fixAll = (words, attempt = e.id) => wf(p.root, ['scope', 'fix-all', '--person-said', words, '--attempt', attempt], session);
  // Repro 1: the last message names only ENG-9.
  const last = fixAll('fix all the lows, do not ask me about them');
  assert.equal(last.code, 75);
  assert.match(last.err, /in a message that names ENG-9, not PP-3: words about something else/);
  // Repro 2: a panel answer to ENG-9's decision.
  const answer = fixAll('fix all of them');
  assert.equal(answer.code, 75);
  assert.match(answer.err, /in a message that answers another ticket's question \(ENG-9\.1\): words about something else/);
  // An encoding's name is not a ticket: the message names PP-5 and ENG-9 only.
  const named = fixAll('fix all the copy findings', ok(wf(p.root, ['entry', '--item', 'PP-5', '--owner', 'o', '--json'])).json().id);
  assert.equal(named.code, 0, named.err);
  const s5 = JSON.parse(ok(wf(p.root, ['resume', '--attempt', 'PP-5.1', '--json'])).out);
  assert.match(s5.fixAll.via, /written before the admission, naming PP-5; it also names ENG-9$/);
  assert.doesNotMatch(s5.fixAll.via, /UTF-8/);
  assert.equal(JSON.parse(ok(wf(p.root, ['resume', '--attempt', e.id, '--json'])).out).fixAll, undefined, 'nothing recorded on PP-3');
});

// Review of 0.7.28 (L3): "fix all" covers a level the project lets the owner decide too, and the person has a terminal route.
test('"fix all" also stops the owner deferring an item its policy delegates; the person records it in their own terminal by typing yes', async () => {
  const p = singleRepoProject('pp-fixall-owner', { gate: { steps }, leaving: { low: 'owner' } }, { 'src/a.txt': LINES, 'src/b.txt': LINES });
  const e = ok(wf(p.root, ['entry', '--item', 'PP-2', '--owner', 'o', '--json'])).json();
  ok(wf(p.root, ['handoff', 'planner', '--agent', 'p', '--attempt', e.id]));
  const plan = path.join(p.base, 'plan.json');
  fs.writeFileSync(plan, JSON.stringify(planDoc({ plan: { summary: 'change a', expect: EXPECT, anchors: ['src/a.txt'] }, criteria: [{ id: 'C1', text: 'a changes', uat: 'a shows the new text' }] })));
  ok(wf(p.root, ['plan', '--file', plan, '--attempt', e.id]));
  ok(wf(p.root, ['handoff', 'implementer', '--agent', 'i1', '--attempt', e.id]));
  commitIn(e.repos.app.worktree, { 'src/a.txt': LINES.replace('l2', 'L2') }, 'implement C1');
  ok(wf(p.root, ['handoff', 'close', '--agent', 'i1', '--attempt', e.id]));
  ok(wf(p.root, ['handoff', 'reviewer', '--agent', 'r1', '--attempt', e.id]));
  ok(wf(p.root, ['review', '--closure', closureFile(p.base, goodClosure('r1', { findings: [low('F1', 'src/b.txt:5')] })), '--attempt', e.id]));
  // Outside an agent session, not interactive: refused; interactive, the person types yes.
  const { recordFixAll } = await import('../engine/leaving.mjs');
  const { PassThrough } = await import('node:stream');
  const { inProcess } = await import('./strategist-fixtures.mjs');
  await inProcess(p.root, async () => {
    await assert.rejects(recordFixAll(p.root, { attempt: e.id }, { env: {}, input: new PassThrough(), output: new PassThrough() }), /not an interactive terminal/);
    const input = Object.assign(new PassThrough(), { isTTY: true, setRawMode: () => {} });
    const output = Object.assign(new PassThrough(), { isTTY: true, columns: 80 });
    const pending = recordFixAll(p.root, { attempt: e.id }, { env: {}, input, output });
    setImmediate(() => input.write('yes\n'));
    assert.equal((await pending).state.fixAll.via, 'terminal');
  });
  const deferred = wf(p.root, ['scope', 'defer', '--finding', 'r1:F1', '--reason', 'polish for later', '--attempt', e.id], { ownerSilent: true });
  assert.equal(deferred.code, 75);
  assert.match(deferred.err, /the person said to fix every item .* so r1:F1 is fixed in this delivery and not asked about again/);
});
