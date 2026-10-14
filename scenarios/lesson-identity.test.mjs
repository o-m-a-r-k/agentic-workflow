import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { closureFile, commitIn, criteriaFile, goodClosure, makeRepo, ok, sh, tmp, wf, yaml } from './helpers.mjs';

// Named failure (I-95): lesson ids are allocated per repository, so two repositories can each hold a different `L-4`. The
// loader kept the first by id and dropped the other without a word, so its lesson never reached a bundle. Each lesson now has
// an identity that is stable and unique across the project: its id, or `<id>@<repository>` while another repository holds a
// different lesson of that id. Allocation also counts what parallel open attempts have taken.

function project(name) {
  const base = tmp(name);
  const root = path.join(base, 'ws');
  fs.mkdirSync(root);
  const cfg = { version: 1, enabled: true, name, adapterRepo: 'api', repos: [{ name: 'api', path: 'api', base: 'main' }, { name: 'web', path: 'web', base: 'main' }], lanes: ['quick', 'standard'], gate: { steps: [{ id: 'api-unit', repo: 'api', run: 'true', inputs: ['src/**'] }, { id: 'web-unit', repo: 'web', run: 'true', inputs: ['src/**'] }] } };
  makeRepo(path.join(root, 'api'), { '.workflow/project.yaml': yaml(cfg), 'src/a.txt': 'a\n' });
  makeRepo(path.join(root, 'web'), { 'src/w.txt': 'w\n' });
  fs.symlinkSync(path.join('api', '.workflow'), path.join(root, '.workflow'));
  return { base, root };
}
const lessonFile = (root, repo, id) => path.join(root, repo, '.workflow', 'lessons', `${id}.yaml`);
const put = (root, repo, id, title, extra = {}) => {
  fs.mkdirSync(path.dirname(lessonFile(root, repo, id)), { recursive: true });
  fs.writeFileSync(lessonFile(root, repo, id), yaml({ id, title, repo, trigger: { what: title }, cause: 'test', mechanism: { kind: 'doc' }, status: 'proposed', tags: [], paths: ['src/**'], created: '2026-01-01T00:00:00.000Z', ...extra }));
};
const bundleOf = (out) => JSON.parse(fs.readFileSync((out.match(/bundle: (\S+)/) ?? out.match(/^Read (\S+)/m))[1], 'utf8'));
const add = (root, args) => wf(root, ['lesson', 'add', ...args]);

test('two different lessons of one id reach the roles they apply to, each under its own stable identity', () => {
  const { base, root } = project('lesson-identity-roles');
  put(root, 'api', 'L-4', 'API lesson', { tags: ['tables'] });
  put(root, 'web', 'L-4', 'Web lesson', { tags: ['tables'] });
  const issue = path.join(base, 'issue.md');
  fs.writeFileSync(issue, 'The invoices page needs sortable tables.\n');
  const e = ok(wf(root, ['entry', '--item', 'ENG-401', '--owner', 'o', '--issue-file', issue, '--json'])).json();
  const planner = bundleOf(ok(wf(root, ['handoff', 'planner', '--agent', 'p', '--attempt', e.id])).out);
  assert.deepEqual(planner.lessons.apply.map((l) => [l.id, l.repo, l.title]), [['L-4@api', 'api', 'API lesson'], ['L-4@web', 'web', 'Web lesson']], 'neither is hidden from the planner');
  ok(wf(root, ['plan', '--file', criteriaFile(base), '--attempt', e.id]));
  ok(wf(root, ['handoff', 'implementer', '--agent', 'i', '--attempt', e.id]));
  // An implementer acknowledges a lesson under the identity its bundle gave it.
  sh(e.repos.api.worktree, 'printf x > src/a.txt && git add -A && git commit -q -m change -m "Lesson L-4@api: applied - followed it"');
  sh(e.repos.web.worktree, 'printf y > src/w.txt && git add -A && git commit -q -m change -m "Lesson L-4@web: not-applicable - nothing to apply"');
  ok(wf(root, ['handoff', 'close', '--agent', 'i', '--attempt', e.id]));
  const reviewer = bundleOf(ok(wf(root, ['handoff', 'reviewer', '--agent', 'r', '--attempt', e.id])).out);
  assert.deepEqual(reviewer.lessons.apply.map((l) => l.id), ['L-4@api', 'L-4@web']);
  assert.deepEqual(reviewer.lessons.acknowledged.map((a) => `${a.lesson}:${a.ack}:${a.repo}`).sort(), ['L-4@api:applied:api', 'L-4@web:not-applicable:web']);
  // A verdict on either is recorded against its own identity.
  ok(wf(root, ['review', '--closure', closureFile(base, goodClosure('r', { lessons: reviewer.lessons.apply.map((l) => ({ lesson: l.id, verdict: 'complied', evidence: 'checked' })) })), '--attempt', e.id]));
  assert.deepEqual(wf(root, ['resume', '--attempt', e.id, '--json']).json().review.closure.lessons.map((v) => v.lesson), ['L-4@api', 'L-4@web']);
});

test('a lesson is addressed by its qualified identity; a bare id that is two lessons names both; the file keeps its own id', () => {
  const { root } = project('lesson-identity-cli');
  put(root, 'api', 'L-4', 'API lesson');
  put(root, 'web', 'L-4', 'Web lesson');
  const bare = wf(root, ['lesson', 'show', 'L-4']);
  assert.notEqual(bare.code, 0);
  assert.match(bare.err, /lesson L-4 is 2 different lessons: name one of L-4@api, L-4@web/);
  assert.match(ok(wf(root, ['lesson', 'show', 'L-4@web'])).out, /^L-4@web {2}web \(main\) .*Web lesson/);
  ok(wf(root, ['lesson', 'set', 'L-4@web', '--status', 'enforced', '--ref', 'rule-1']));
  const web = fs.readFileSync(lessonFile(root, 'web', 'L-4'), 'utf8');
  assert.match(web, /"?id"?: "?L-4"?[,\n]/, 'the file is still L-4 under its own id');
  assert.match(web, /status"?: "?enforced/);
  assert.equal(fs.existsSync(lessonFile(root, 'web', 'L-4@web')), false);
  assert.match(fs.readFileSync(lessonFile(root, 'api', 'L-4'), 'utf8'), /status"?: "?proposed/, 'the other repository\'s lesson is untouched');
  const recurred = ok(wf(root, ['lesson', 'recur', 'L-4@api', '--json'])).json();
  assert.equal(recurred.recurrence, 1);
  assert.match(fs.readFileSync(lessonFile(root, 'api', 'L-4'), 'utf8'), /recurrence"?: 1/);
  assert.match(fs.readFileSync(lessonFile(root, 'web', 'L-4'), 'utf8'), /recurrence"?: 0/);
  // Once one is renamed the other has its plain id again, and the qualified form recorded while they collided still names it.
  fs.renameSync(lessonFile(root, 'api', 'L-4'), lessonFile(root, 'api', 'L-9'));
  put(root, 'api', 'L-9', 'API lesson', { recurrence: 1 });
  assert.match(ok(wf(root, ['lesson', 'show', 'L-4'])).out, /^L-4 {2}web \(main\)/);
  assert.match(ok(wf(root, ['lesson', 'show', 'L-4@web'])).out, /^L-4 {2}web \(main\)/, 'the qualified identity stays valid');
});

test('a new lesson id is not one a parallel open attempt has already taken', () => {
  const { root } = project('lesson-identity-alloc');
  const a = ok(wf(root, ['entry', '--item', 'ENG-402', '--owner', 'o', '--json'])).json();
  const b = ok(wf(root, ['entry', '--item', 'ENG-403', '--owner', 'o', '--json'])).json();
  const first = ok(add(root, ['--attempt', a.id, '--repo', 'api', '--title', 'First', '--what', 'w', '--cause', 'test', '--mechanism', 'doc']));
  assert.match(first.out, /lesson L-1 recorded in api/);
  const second = ok(add(root, ['--attempt', b.id, '--repo', 'web', '--title', 'Second', '--what', 'w2', '--cause', 'test', '--mechanism', 'doc']));
  assert.match(second.out, /lesson L-2 recorded in web/, 'without the other attempt\'s worktree counted, this was another L-1');
});

test('a lesson is never moved over a different lesson of the same id in the repository it moves to', () => {
  const { root } = project('lesson-identity-move');
  put(root, 'api', 'L-4', 'API lesson', { scope: 'project', repo: null });
  put(root, 'web', 'L-4', 'Web lesson');
  const refused = wf(root, ['lesson', 'move', 'L-4@api', '--repo', 'web']);
  assert.notEqual(refused.code, 0);
  assert.match(refused.err, /web already holds a different lesson L-4/);
  assert.match(fs.readFileSync(lessonFile(root, 'web', 'L-4'), 'utf8'), /Web lesson/, 'the lesson already there is intact');
  assert.ok(fs.existsSync(lessonFile(root, 'api', 'L-4')), 'and the moved one stays where it was');
});
