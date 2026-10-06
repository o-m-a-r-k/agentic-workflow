import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { closureFile, commitIn, criteriaFile, goodClosure, ok, sh, singleRepoProject, state, toAccepted, wf, yaml } from './helpers.mjs';

// 0.2.0: the lessons harness (docs/LESSONS.md). Fixtures are generic versions of what went wrong on real tickets.

const steps = [{ id: 'unit', repo: 'app', run: 'true', inputs: ['src/**'] }];
const add = (root, args) => wf(root, ['lesson', 'add', ...args]);
const lessonFile = (root, id) => path.join(root, '.workflow', 'lessons', `${id}.yaml`);

// A reopened attempt taken to an accepted review, the reviewer giving `extra` (lesson verdicts) in its closure.
function reopenedToAccepted(root, base, item, reopenArgs = [], closureExtra = {}) {
  const args = ['reopen', '--item', item, '--reason', 'the screenshots are attached but I cannot see them in the ticket', '--owner', 'o', ...reopenArgs];
  const id = ok(wf(root, [...args.slice(0, 1), ...args.slice(1), '--json'])).json().id;
  const r = { out: ok(wf(root, ['resume', '--attempt', id])).out };
  ok(wf(root, ['handoff', 'planner', '--agent', 'p2', '--attempt', id]));
  ok(wf(root, ['plan', '--file', criteriaFile(base), '--attempt', id]));
  ok(wf(root, ['handoff', 'implementer', '--agent', 'i2', '--attempt', id]));
  commitIn(state(root, id).repos.app.worktree, { 'src/a.txt': `${id}\n` });
  ok(wf(root, ['gate', '--attempt', id]));
  const start = ok(wf(root, ['handoff', 'reviewer', '--agent', 'r2', '--attempt', id])).out.trim();
  const bundle = JSON.parse(fs.readFileSync(start.match(/^Read (\S+)/)[1], 'utf8'));
  ok(wf(root, ['review', '--closure', closureFile(base, goodClosure('r2', closureExtra(bundle))), '--attempt', id]));
  ok(wf(root, ['accept', '--attempt', id]));
  return { id, reopen: r, bundle };
}

test('capture: a lesson is validated, written to the adapter folder and recorded on its attempt; enforced needs a mechanism', () => {
  const { base, root } = singleRepoProject('lessons-capture', { gate: { steps } });
  const { id } = toAccepted(root, base, { item: 'ENG-300' });
  assert.match(add(root, ['--title', 'x']).err, /`trigger\.what`[\s\S]*`cause` is one of[\s\S]*`mechanism\.kind` is one of/);
  assert.match(add(root, ['--title', 't', '--what', 'w', '--cause', 'design-system', '--mechanism', 'designSystem-rule', '--status', 'enforced']).err, /an enforced lesson names its mechanism: `mechanism\.ref`/);
  const r = ok(add(root, ['--attempt', id, '--title', 'Data tables use the shared table and pagination', '--what', 'a report page used a raw table; no reviewer caught it', '--cause', 'design-system', '--mechanism', 'designSystem-rule', '--tags', 'ui,tables', '--paths', 'web/**/*.tsx', '--quote', "why isn't this our table?"]));
  assert.match(r.out, /lesson L-1 recorded: .*\.workflow\/lessons\/L-1\.yaml[\s\S]*wf lesson apply L-1/);
  const text = fs.readFileSync(lessonFile(root, 'L-1'), 'utf8');
  assert.match(text, /cause: design-system/);
  assert.match(text, /quote: why isn't this our table\?/);
  assert.equal(state(root, id).lessons.recorded[0].id, 'L-1');
  const yml = path.join(base, 'l.yaml');
  fs.writeFileSync(yml, yaml({ title: 'Readbacks are raw tool output', trigger: { what: 'a hand-built readback was accepted' }, cause: 'tooling', mechanism: { kind: 'engine-change' }, scope: 'plugin', status: 'proposed', tags: ['tracker'] }));
  assert.match(ok(add(root, ['--file', yml])).out, /lesson L-2 recorded/);
  const list = ok(wf(root, ['lesson', 'list'])).out;
  assert.match(list, /L-1 +\[proposed, project, design-system, designSystem-rule\] recurrence 0 +Data tables/);
  assert.match(list, /P-1 +\[enforced, plugin, review, reviewer-checklist .*\] .*Prior decisions are inputs, not authority/, 'the shipped lesson is listed');
  // apply prints, never edits.
  const before = sh(root, 'git status --porcelain');
  const a = ok(wf(root, ['lesson', 'apply', 'L-1'])).out;
  assert.match(a, /add to \.workflow\/project\.yaml \(designSystem\.rules\):[\s\S]*id: lesson-l-1[\s\S]*wf changes nothing itself/);
  assert.equal(sh(root, 'git status --porcelain'), before, 'apply changed nothing');
  assert.match(ok(wf(root, ['lesson', 'set', 'L-1', '--status', 'enforced', '--ref', 'lesson-l-1'])).out, /\[enforced/);
});

test('a reopened delivery does not close until a lesson is recorded or waived; both are ledgered', () => {
  const { base, root } = singleRepoProject('lessons-reopen', { gate: { steps } });
  const first = toAccepted(root, base, { item: 'ENG-301' });
  ok(wf(root, ['deliver', '--attempt', first.id]));
  const { id, reopen } = reopenedToAccepted(root, base, 'ENG-301', [], () => ({}));
  assert.match(reopen.out, /lesson: this attempt reopens ENG-301\.1 \("the screenshots are attached but I cannot see them in the ticket"\): record what the project learns/);
  ok(wf(root, ['deliver', '--attempt', id]));
  let s = state(root, id);
  assert.equal(s.phase, 'handoff-pending', 'delivered, not closed');
  assert.match(ok(wf(root, ['resume', '--attempt', id])).out, /next: this attempt reopens ENG-301\.1 .* its delivery does not close until then/);
  const r = ok(add(root, ['--attempt', id, '--title', 'Delivered screenshots are visible in the ticket', '--what', 'attachments showed only as links', '--cause', 'tooling', '--mechanism', 'engine-change', '--quote', 'I cannot see them']));
  assert.match(r.out, /ENG-301\.2 closed\./);
  s = state(root, id);
  assert.equal(s.phase, 'done');
  assert.equal(s.lessons.recorded[0].for, 'reopen');
  // The other ways out: waived on reopen, or later with a reason.
  // The lesson just recorded now applies to the next change: its reviewer judges it.
  const { id: id3, bundle } = reopenedToAccepted(root, base, 'ENG-301', ['--no-lesson', 'a typo in a label, nothing to learn'], (b) => ({ lessons: b.lessons.apply.map((l) => ({ lesson: l.id, verdict: 'complied', evidence: 'the comment embeds each screenshot' })) }));
  assert.deepEqual(bundle.lessons.apply.map((l) => l.id), ['L-1']);
  ok(wf(root, ['deliver', '--attempt', id3]));
  assert.equal(state(root, id3).phase, 'done');
  assert.equal(state(root, id3).lessons.waived.reason, 'a typo in a label, nothing to learn');
});

test('relevant lessons are injected (capped, by recurrence), the reviewer must judge each, and a finding verdict is a recurrence', () => {
  const { base, root } = singleRepoProject('lessons-inject', { gate: { steps } });
  const first = toAccepted(root, base, { item: 'ENG-302' });
  ok(wf(root, ['deliver', '--attempt', first.id]));
  for (let i = 1; i <= 7; i++) ok(add(root, ['--title', `lesson ${i}`, '--what', 'w', '--cause', 'review', '--mechanism', 'reviewer-checklist', '--tags', `t${i}`, '--paths', i === 7 ? 'docs/**' : 'src/**']));
  ok(wf(root, ['lesson', 'recur', 'L-4']));
  // The reviewer forgets one verdict: refused.
  const r = ok(wf(root, ['reopen', '--item', 'ENG-302', '--reason', 'r', '--owner', 'o', '--no-lesson', 'test']));
  assert.ok(r);
  const id = 'ENG-302.2';
  ok(wf(root, ['handoff', 'planner', '--agent', 'p2', '--attempt', id]));
  ok(wf(root, ['plan', '--file', criteriaFile(base), '--attempt', id]));
  ok(wf(root, ['handoff', 'implementer', '--agent', 'i2', '--attempt', id]));
  commitIn(state(root, id).repos.app.worktree, { 'src/a.txt': 'again\n' });
  ok(wf(root, ['gate', '--attempt', id]));
  const start = ok(wf(root, ['handoff', 'reviewer', '--agent', 'r2', '--attempt', id])).out.trim();
  const bundle = JSON.parse(fs.readFileSync(start.match(/^Read (\S+)/)[1], 'utf8'));
  assert.equal(bundle.lessons.apply.length, 5, 'capped');
  assert.equal(bundle.lessons.more, 1, 'L-7 governs docs/** only: not relevant; one more relevant beyond the cap');
  assert.equal(bundle.lessons.apply[0].id, 'L-4', 'most recurring first');
  assert.ok(!bundle.lessons.apply.some((l) => l.id === 'P-1'), 'a shipped lesson enforced by the templates is not injected');
  const verdicts = (skip) => bundle.lessons.apply.filter((l) => l.id !== skip).map((l) => ({ lesson: l.id, verdict: l.id === 'L-4' ? 'finding' : 'complied', evidence: 'checked', ...(l.id === 'L-4' ? { finding: 'F1' } : {}) }));
  const findings = [{ id: 'F1', severity: 'minor', summary: 'the checklist item was missed again', status: 'fixed', evidence: 'src/a.txt:1', category: 'review' }];
  const missing = wf(root, ['review', '--closure', closureFile(base, goodClosure('r2', { lessons: verdicts('L-1'), findings })), '--attempt', id]);
  assert.equal(missing.code, 75);
  assert.match(missing.err, /lesson L-1 \("lesson 1"\): no verdict/);
  ok(wf(root, ['review', '--closure', closureFile(base, goodClosure('r2', { lessons: verdicts(null), findings })), '--attempt', id]));
  const acc = ok(wf(root, ['accept', '--attempt', id]));
  assert.match(acc.out, /lesson: finding F1 is a review problem: record a lesson/);
  const st = ok(wf(root, ['status', '--attempt', id])).out;
  assert.match(st, /LESSON L-4 RECURRED \(recurrence 2\): its mechanism failed; `wf lesson review` proposes promoting it to a gate check/);
  assert.match(ok(wf(root, ['lesson', 'review'])).out, /recurring: promote the mechanism to a gate check \(1\):\n {2}L-4/);
  const j = ok(wf(root, ['export', '--attempt', id, '--json'])).json();
  assert.equal(j.lessons.verdicts.find((v) => v.lesson === 'L-4').verdict, 'finding');
});

test('a new lesson matching an existing one (same mechanism kind, a shared tag) flags a recurrence', () => {
  const { base, root } = singleRepoProject('lessons-recur', { gate: { steps } });
  const { id } = toAccepted(root, base, { item: 'ENG-303' });
  ok(add(root, ['--title', 'Investigate anomalies between captures', '--what', 'a count differed between two captures and was called cosmetic', '--cause', 'review', '--mechanism', 'reviewer-checklist', '--tags', 'screenshots,anomalies']));
  const r = ok(add(root, ['--attempt', id, '--title', 'Dates differed between captures', '--what', 'dates differed and nobody asked why', '--cause', 'review', '--mechanism', 'reviewer-checklist', '--tags', 'anomalies']));
  assert.match(r.out, /lesson L-1 recurred \(recurrence 1\): its mechanism failed/);
  assert.match(fs.readFileSync(lessonFile(root, 'L-1'), 'utf8'), /recurrence: 1/);
  assert.match(ok(wf(root, ['status', '--attempt', id])).out, /LESSON L-1 RECURRED \(recurrence 1\)/);
});

test('plugin lessons export as generic issue text: names, ids, paths, emails and URLs stripped; nothing is posted', () => {
  const { base, root } = singleRepoProject('acmecorp', { gate: { steps }, tracker: { kind: 'none', commentRules: { forbid: ['Project Zephyr'] } } });
  ok(add(root, ['--title', 'acmecorp tables in ENG-77 lacked pagination', '--what', 'see https://tracker.example.test/ENG-77 and /Users/someone/work/acmecorp/web/x.tsx, reported by dev@acmecorp.test for Project Zephyr', '--cause', 'design-system', '--mechanism', 'engine-change', '--scope', 'plugin', '--text', 'the app repo needs a table rule']));
  ok(add(root, ['--title', 'project only', '--what', 'w', '--cause', 'test', '--mechanism', 'doc']));
  const out = ok(wf(root, ['lesson', 'export', '--plugin'])).out;
  assert.match(out, /## <project> tables in <ticket> lacked pagination/);
  for (const leak of ['acmecorp', 'ENG-77', 'https://', '/Users/', 'dev@', 'Zephyr', 'the app repo']) assert.ok(!out.includes(leak), `leaked ${leak}`);
  assert.ok(!out.includes('project only'), 'project lessons are not exported');
  assert.ok(!out.includes('Prior decisions'), 'the plugin\'s own shipped lessons are not exported back');
  const file = path.join(base, 'issue.md');
  assert.match(ok(wf(root, ['lesson', 'export', '--plugin', '--out', file])).out, /review it and file it yourself/);
  assert.ok(fs.readFileSync(file, 'utf8').includes('<project>'));
});

test('prior decisions are inputs: a criterion kept only on precedent needs a purpose-based rationale or a precedent-only finding', () => {
  const { base, root } = singleRepoProject('lessons-precedent', { gate: { steps } });
  const e = ok(wf(root, ['entry', '--item', 'ENG-304', '--owner', 'o', '--json'])).json();
  ok(wf(root, ['handoff', 'planner', '--agent', 'p', '--attempt', e.id]));
  ok(wf(root, ['plan', '--file', criteriaFile(base), '--attempt', e.id]));
  ok(wf(root, ['handoff', 'implementer', '--agent', 'i', '--attempt', e.id]));
  commitIn(e.repos.app.worktree, { 'src/a.txt': 'p\n' });
  ok(wf(root, ['gate', '--attempt', e.id]));
  const crit = (extra) => [{ id: 'C1', evidence: { kind: 'output', ref: 'gate log' }, precedentOnly: true, ...extra }];
  ok(wf(root, ['handoff', 'reviewer', '--agent', 'r', '--attempt', e.id]));
  ok(wf(root, ['review', '--closure', closureFile(base, goodClosure('r', { criteria: crit({}) })), '--attempt', e.id]));
  assert.match(wf(root, ['accept', '--attempt', e.id]).err, /criterion C1: kept only on precedent; give a purpose-based `rationale` \(who uses this surface and what they need\) or raise a `precedent-only` finding/);
  ok(wf(root, ['handoff', 'reviewer', '--agent', 'r2', '--attempt', e.id]));
  ok(wf(root, ['review', '--closure', closureFile(base, goodClosure('r2', { criteria: crit({ rationale: 'the platform operator compares all workspaces, so the cross-workspace total stays' }) })), '--attempt', e.id]));
  ok(wf(root, ['accept', '--attempt', e.id]));
  // The templates carry the rule.
  ok(wf(root, ['sync']));
  const reviewer = fs.readdirSync(path.join(root, '.claude', 'agents')).find((f) => f.startsWith('wf-reviewer'));
  const text = fs.readFileSync(path.join(root, '.claude', 'agents', reviewer), 'utf8');
  assert.match(text, /Prior decisions are inputs, not authority/);
  assert.match(text, /precedent-only/);
  assert.match(text, /Invariant scope check/);
});
