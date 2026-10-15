// 0.7.4, stream 3 (lessons, review division, native patch grammar). Each test names the failure it reproduces and fails on 0.7.3.
//   I-49   a generated lesson failed the repository's own Prettier check (layout, precedence, recur/set/move)
//   I-99   a lesson recorded after an accepted tree was repaired went untracked into the main checkout; the first fix's
//          edge: an implementer left open at acceptance made a later lesson move the tree off the accepted one
//   I-112  a lesson for a repository the attempt did not admit went untracked into that repository's main checkout
//   I-96   documentation files flipped the review division to a single reviewer
//   I-108  a valid native patch with an empty context line was refused as evidence
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { amendFile, closureFile, commitIn, criteriaFile, goodClosure, makeRepo, ok, sh, singleRepoProject, state, tmp, toAccepted, wf, write, yaml } from './helpers.mjs';
import { patchTargets } from '../engine/hosts/codex-tool.mjs';
import { YAML } from '../engine/util.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const steps = [{ id: 'unit', repo: 'app', run: 'true', inputs: ['src/**'] }];
const add = (root, args, opts) => wf(root, ['lesson', 'add', ...args], opts);
const lessonFile = (repoRoot, id) => path.join(repoRoot, '.workflow', 'lessons', `${id}.yaml`);

// ---- An engine stamped with a given version (obligations follow the version an attempt was admitted under, D7) ----
// Copies the plugin into a temporary folder with that version in its package.json: identical code, a different admission
// stamp. `wf(root, args, { bin })` then runs that copy.
const copies = new Map();
function engineAt(version) {
  if (copies.has(version)) return copies.get(version);
  const dir = tmp(`engine-${version}`);
  for (const d of ['bin', 'engine', 'templates', 'docs', 'skills', 'adapters', 'hooks']) fs.cpSync(path.join(REPO, d), path.join(dir, d), { recursive: true });
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8'));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ ...pkg, version }));
  process.once('exit', () => fs.rmSync(dir, { recursive: true, force: true }));
  copies.set(version, path.join(dir, 'bin', 'wf'));
  return copies.get(version);
}

function multiRepoProject(name, { api = {}, web = {} } = {}) {
  const base = tmp(name);
  const root = path.join(base, 'ws');
  fs.mkdirSync(root);
  const cfg = { version: 1, enabled: true, name, adapterRepo: 'api', repos: [{ name: 'api', path: 'api', base: 'main' }, { name: 'web', path: 'web', base: 'main' }], lanes: ['quick', 'standard'], gate: { steps: [{ id: 'api-unit', repo: 'api', run: 'true', inputs: ['src/**'] }, { id: 'web-unit', repo: 'web', run: 'true', inputs: ['src/**'] }] } };
  makeRepo(path.join(root, 'api'), { '.workflow/project.yaml': yaml(cfg), 'src/a.txt': 'a\n', ...api });
  makeRepo(path.join(root, 'web'), { 'src/w.txt': 'w\n', 'src/table.tsx': 'x\n', ...web });
  fs.symlinkSync(path.join('api', '.workflow'), path.join(root, '.workflow'));
  return { base, root };
}

const lessonArgs = (title, what = 'a thing went wrong', extra = []) => ['--title', title, '--what', what, '--cause', 'test', '--mechanism', 'doc', ...extra];

// ======================================================================================================================
// I-99 / I-112: where a lesson is written
// ======================================================================================================================

// Named failure (I-99): an accepted attempt that was repaired (commits made after the acceptance, its implementer closed)
// still had its lesson written untracked into the pull-only main checkout, and moved by hand each time; the rule was "accepted
// with an implementer open", which says nothing about whether the accepted tree is still the tree.
test('I-99: a lesson recorded after the accepted tree moved (a repair committed, no implementer open) is committed in the attempt worktree', () => {
  const { base, root } = singleRepoProject('fix074-moved', { gate: { steps } });
  const { id, wt } = toAccepted(root, base, { item: 'ENG-401' });
  commitIn(wt, { 'src/a.txt': 'repaired after the acceptance\n' }, 'repair after acceptance');
  const r = ok(add(root, ['--attempt', id, ...lessonArgs('Repairs after acceptance are reviewed again')]));
  assert.match(r.out, /committed in ENG-401\.1's worktree: it is reviewed and delivered with this attempt/);
  assert.ok(fs.existsSync(lessonFile(wt, 'L-1')), 'in the attempt worktree');
  assert.ok(!fs.existsSync(lessonFile(root, 'L-1')), 'not in the main checkout');
  assert.equal(sh(root, 'git status --porcelain'), '', 'the main checkout holds no untracked lesson');
  assert.match(sh(wt, 'git log -1 --format=%s'), /^Lesson L-1: Repairs after acceptance are reviewed again$/);
  // A recurrence and a status change follow the same rule: they update the lesson in the worktree.
  ok(wf(root, ['lesson', 'set', 'L-1', '--status', 'retired', '--attempt', id]));
  assert.match(sh(wt, 'git log -1 --format=%s'), /^Lesson L-1: retired$/);
  assert.equal(sh(root, 'git status --porcelain'), '');
});

// Independent review of 0.7.4 (I-99 class): `wf lesson set --attempt` on the attempt's own lesson, with the accepted tree
// standing, wrote a second, untracked copy (with the new status) into the main checkout; the delivered file kept the old one.
test('I-99 class: wf lesson set on a lesson of the standing accepted tree is refused, and nothing is written into the main checkout', () => {
  const { base, root } = singleRepoProject('fix074-set-accepted', { gate: { steps } });
  const owner = 'owner-1';
  const e = ok(wf(root, ['entry', '--item', 'ENG-405', '--owner', owner, '--json'])).json();
  const id = e.id;
  const wt = e.repos.app.worktree;
  ok(wf(root, ['handoff', 'planner', '--agent', 'plan-1', '--attempt', id, '--owner', owner]));
  ok(wf(root, ['plan', '--file', criteriaFile(base), '--attempt', id, '--owner', owner]));
  ok(wf(root, ['handoff', 'implementer', '--agent', 'impl-1', '--attempt', id, '--owner', owner]));
  commitIn(wt, { 'src/a.txt': 'b\n' });
  ok(add(root, ['--attempt', id, ...lessonArgs('Own lesson of the attempt')]));
  ok(wf(root, ['handoff', 'reviewer', '--agent', 'rev-0', '--attempt', id, '--owner', owner]));
  ok(wf(root, ['review', '--closure', closureFile(base, goodClosure('rev-0')), '--attempt', id]));
  ok(wf(root, ['gate', '--attempt', id]));
  ok(wf(root, ['handoff', 'reviewer', '--agent', 'rev-1', '--attempt', id, '--owner', owner]));
  ok(wf(root, ['review', '--closure', closureFile(base, goodClosure()), '--attempt', id]));
  ok(wf(root, ['accept', '--attempt', id, '--owner', owner]));
  const refused = wf(root, ['lesson', 'set', 'L-1', '--status', 'retired', '--attempt', id], { ownerSilent: true });
  assert.equal(refused.code, 75);
  assert.match(refused.err, /lesson L-1 is part of ENG-405\.1's accepted tree .* and changing it would change that tree/);
  assert.equal(sh(root, 'git status --porcelain'), '', 'no untracked copy in the main checkout');
  assert.equal(sh(wt, 'git status --porcelain'), '', 'the accepted tree is untouched');
});

// Named failure (I-99, fix-induced edge): an implementer left open when the review was accepted counted as "repairing", so a
// later `wf lesson add` committed into the worktree, HEAD moved past the accepted tree, and `wf deliver` refused "modified
// after acceptance". An open implementer opened before the acceptance says nothing about the tree.
test('I-99: an implementer left open at acceptance does not make a later lesson move the accepted tree; the lesson waits in the main checkout and the attempt delivers', () => {
  const { base, root } = singleRepoProject('fix074-open-at-accept', { gate: { steps } });
  const open = { implementersOpen: true };
  const why = ['--reason', 'scenario: the implementer is still open'];
  const owner = 'owner-1';
  const e = ok(wf(root, ['entry', '--item', 'ENG-402', '--owner', owner, '--json'])).json();
  const id = e.id;
  ok(wf(root, ['handoff', 'planner', '--agent', 'plan-1', '--attempt', id, '--owner', owner]));
  ok(wf(root, ['plan', '--file', criteriaFile(base), '--attempt', id, '--owner', owner]));
  ok(wf(root, ['handoff', 'implementer', '--agent', 'impl-1', '--attempt', id, '--owner', owner]));
  commitIn(e.repos.app.worktree, { 'src/a.txt': 'b\n' });
  ok(wf(root, ['handoff', 'reviewer', '--agent', 'rev-0', '--attempt', id, '--owner', owner, ...why], open));
  ok(wf(root, ['review', '--closure', closureFile(base, goodClosure('rev-0')), '--attempt', id]));
  ok(wf(root, ['gate', '--attempt', id]));
  ok(wf(root, ['handoff', 'reviewer', '--agent', 'rev-1', '--attempt', id, '--owner', owner, ...why], open));
  ok(wf(root, ['review', '--closure', closureFile(base, goodClosure()), '--attempt', id]));
  ok(wf(root, ['accept', '--attempt', id, '--owner', owner]));
  assert.ok(state(root, id).implementers.some((x) => !x.closedAt), 'the implementer is still open');
  const head = sh(e.repos.app.worktree, 'git rev-parse HEAD');
  const r = ok(add(root, ['--attempt', id, ...lessonArgs('A lesson learned while the accepted tree waits')]));
  assert.match(r.out, /in app's main checkout: commit it there/, 'the accepted tree is frozen: the lesson waits outside it');
  assert.equal(sh(e.repos.app.worktree, 'git rev-parse HEAD'), head, 'the accepted tree did not move');
  assert.ok(!fs.existsSync(lessonFile(e.repos.app.worktree, 'L-1')));
  ok(wf(root, ['deliver', '--attempt', id]));
  assert.equal(state(root, id).phase, 'done');
});

// An implementer handed after the acceptance (a repair about to begin) moves the work back into the worktree before its first
// commit; closed with nothing committed, the accepted tree stands again.
test('I-99: an implementer handed after the acceptance and still open sends the lesson to the worktree; closed with the tree unmoved, the acceptance stands again', () => {
  const { base, root } = singleRepoProject('fix074-adopted', { gate: { steps } });
  const { id, wt } = toAccepted(root, base, { item: 'ENG-403' });
  // Handed and closed with nothing committed: the accepted tree is as it was, so the lesson waits outside it.
  ok(wf(root, ['handoff', 'implementer', '--agent', 'repair-0', '--attempt', id]));
  ok(wf(root, ['handoff', 'close', '--agent', 'repair-0', '--attempt', id]));
  assert.match(ok(add(root, ['--attempt', id, ...lessonArgs('Nothing was committed')])).out, /in app's main checkout: commit it there/);
  assert.ok(!fs.existsSync(lessonFile(wt, 'L-1')));
  // Handed again and open: the repair is under way, so the lesson belongs to it, committed in the worktree.
  ok(wf(root, ['handoff', 'implementer', '--agent', 'repair-1', '--attempt', id]));
  assert.match(ok(add(root, ['--attempt', id, ...lessonArgs('Lesson while a repair is under way')])).out, /committed in ENG-403\.1's worktree/);
  assert.ok(fs.existsSync(lessonFile(wt, 'L-2')));
  // The lesson moved the tree, so the next one stays in the worktree even after the implementer closes.
  ok(wf(root, ['handoff', 'close', '--agent', 'repair-1', '--attempt', id]));
  assert.match(ok(add(root, ['--attempt', id, ...lessonArgs('Second lesson of the repair')])).out, /committed in ENG-403\.1's worktree/);
});

// Named failure (I-99 class): a lesson the attempt itself added lives in its worktree and is delivered from there. A reviewer's
// `finding` verdict counts as a recurrence right after the acceptance, and the recurrence was written as a second, untracked copy
// into the main checkout, which the delivered file then collided with.
test('I-99 class: a recurrence recorded at acceptance for a lesson the attempt itself added leaves the main checkout clean', () => {
  const { base, root } = singleRepoProject('fix074-recur-at-accept', { gate: { steps } });
  const owner = 'owner-1';
  const e = ok(wf(root, ['entry', '--item', 'ENG-405', '--owner', owner, '--json'])).json();
  const id = e.id;
  ok(wf(root, ['handoff', 'planner', '--agent', 'plan-1', '--attempt', id, '--owner', owner]));
  ok(wf(root, ['plan', '--file', criteriaFile(base), '--attempt', id, '--owner', owner]));
  ok(wf(root, ['handoff', 'implementer', '--agent', 'impl-1', '--attempt', id, '--owner', owner]));
  commitIn(e.repos.app.worktree, { 'src/a.txt': 'b\n' });
  ok(add(root, ['--attempt', id, ...lessonArgs('The attempt teaches its own lesson', 'a thing went wrong', ['--paths', 'src/**'])]));
  ok(wf(root, ['handoff', 'reviewer', '--agent', 'rev-0', '--attempt', id, '--owner', owner]));
  ok(wf(root, ['review', '--closure', closureFile(base, goodClosure('rev-0')), '--attempt', id]));
  ok(wf(root, ['gate', '--attempt', id]));
  const handed = ok(wf(root, ['handoff', 'reviewer', '--agent', 'rev-1', '--attempt', id, '--owner', owner])).out;
  const bundle = JSON.parse(fs.readFileSync((handed.match(/bundle: (\S+)/) ?? handed.match(/^Read (\S+)/m))[1], 'utf8'));
  assert.deepEqual(bundle.lessons.apply.map((l) => l.id), ['L-1']);
  const finding = { id: 'F1', severity: 'minor', summary: 'the lesson was not followed', status: 'fixed', evidence: 'src/a.txt:1', category: 'review' };
  ok(wf(root, ['review', '--closure', closureFile(base, goodClosure('rev-1', { findings: [finding], lessons: [{ lesson: 'L-1', verdict: 'finding', evidence: 'src/a.txt', finding: 'F1' }] })), '--attempt', id]));
  ok(wf(root, ['accept', '--attempt', id, '--owner', owner]));
  assert.equal(state(root, id).lessons.recurred[0].id, 'L-1', 'the recurrence is recorded in the ledger');
  assert.ok(!fs.existsSync(lessonFile(root, 'L-1')), 'and no second copy of the lesson is written into the main checkout');
  assert.equal(sh(root, 'git status --porcelain'), '');
  ok(wf(root, ['deliver', '--attempt', id]));
  assert.equal(sh(root, 'git status --porcelain'), '', 'the delivered lesson did not collide with a stray copy');
});

// Named failure (I-99 class): `wf lesson move --attempt` wrote the lesson into the other repo's worktree and committed it there,
// but removed the source file from its own worktree without committing the removal: the tree was dirty (the next gate or review
// saw uncommitted work) and the delivered change carried the lesson in both repos.
test('I-99 class: a lesson moved out of an attempt worktree is removed there by a commit, not left as an uncommitted deletion', () => {
  const { base, root } = multiRepoProject('fix074-move-attempt');
  const e = ok(wf(root, ['entry', '--item', 'ENG-406', '--owner', 'o', '--json'])).json();
  ok(wf(root, ['handoff', 'planner', '--agent', 'p', '--attempt', e.id]));
  ok(wf(root, ['plan', '--file', criteriaFile(base), '--attempt', e.id]));
  ok(add(root, ['--attempt', e.id, '--repo', 'api', ...lessonArgs('Moves to the web repo')]));
  ok(add(root, ['--attempt', e.id, '--repo', 'api', ...lessonArgs('Goes to the improvement inbox')]));
  const moved = ok(wf(root, ['lesson', 'move', 'L-1', '--repo', 'web', '--attempt', e.id]));
  assert.match(moved.out, /\(committed in the attempt\)/);
  const api = e.repos.api.worktree, web = e.repos.web.worktree;
  assert.equal(sh(api, 'git status --porcelain'), '', 'the source worktree has no uncommitted deletion');
  assert.match(sh(api, 'git log -1 --format=%s'), /^Lesson L-1 moved to web$/);
  assert.ok(!fs.existsSync(lessonFile(api, 'L-1')) && fs.existsSync(lessonFile(web, 'L-1')));
  assert.equal(sh(web, 'git status --porcelain'), '');
  ok(wf(root, ['lesson', 'move', 'L-2', '--improvement', '--attempt', e.id]));
  assert.equal(sh(api, 'git status --porcelain'), '');
  assert.match(sh(api, 'git log -1 --format=%s'), /^Lesson L-2 moved to the improvement inbox$/);
});

// Named failure (I-99 class, found in review): moving a lesson that lives in an accepted tree removed the file from its worktree
// without committing the removal (the tree no longer matched its acceptance) while the copy went untracked into the other repo,
// and the lesson was delivered twice.
test('I-99 class: a lesson that is part of the accepted tree is not moved out from under its acceptance', () => {
  const bin = engineAt('0.7.4');
  const { base, root } = multiRepoProject('fix074-move-accepted');
  const owner = 'owner-1';
  const run = (args) => ok(wf(root, args, { bin }));
  const e = run(['entry', '--item', 'ENG-407', '--owner', owner, '--json']).json();
  run(['handoff', 'planner', '--agent', 'plan-1', '--attempt', e.id, '--owner', owner]);
  run(['plan', '--file', criteriaFile(base), '--attempt', e.id, '--owner', owner]);
  run(['handoff', 'implementer', '--agent', 'impl-1', '--attempt', e.id, '--owner', owner]);
  commitIn(e.repos.api.worktree, { 'src/a.txt': 'b\n' });
  ok(add(root, ['--attempt', e.id, '--repo', 'api', ...lessonArgs('Part of the accepted tree')], { bin }));
  run(['handoff', 'reviewer', '--agent', 'rev-0', '--attempt', e.id, '--owner', owner]);
  run(['review', '--closure', closureFile(base, goodClosure('rev-0')), '--attempt', e.id]);
  run(['gate', '--attempt', e.id]);
  run(['handoff', 'reviewer', '--agent', 'rev-1', '--attempt', e.id, '--owner', owner]);
  run(['review', '--closure', closureFile(base, goodClosure()), '--attempt', e.id]);
  run(['accept', '--attempt', e.id, '--owner', owner]);
  const api = e.repos.api.worktree;
  const head = sh(api, 'git rev-parse HEAD');
  const refused = wf(root, ['lesson', 'move', 'L-1', '--repo', 'web', '--attempt', e.id], { bin });
  assert.equal(refused.code, 75, refused.err);
  assert.match(refused.err, /lesson L-1 is part of ENG-407\.1's accepted tree \(\.workflow\/lessons\/L-1\.yaml\), and moving it would change that tree/);
  assert.equal(wf(root, ['lesson', 'move', 'L-1', '--improvement', '--attempt', e.id], { bin }).code, 75);
  assert.equal(sh(api, 'git status --porcelain'), '', 'the accepted tree is untouched');
  assert.equal(sh(api, 'git rev-parse HEAD'), head);
  assert.ok(!fs.existsSync(lessonFile(path.join(root, 'web'), 'L-1')), 'and nothing was copied into the other repo');
  run(['deliver', '--attempt', e.id]);
});

// Named failure (I-112): `wf lesson add --repo X` with X not among the attempt's repos (or a project lesson whose adapter repo is
// not) wrote the file into X's main checkout as an untracked file, even though the attempt was open, and reported it recorded.
test('I-112: a lesson for a repository the attempt did not admit is refused with the route; without --attempt it is written to the main checkout on purpose', () => {
  const bin = engineAt('0.7.4');
  const { base, root } = multiRepoProject('fix074-not-admitted');
  const e = ok(wf(root, ['entry', '--item', 'ENG-410', '--owner', 'o', '--repos', 'web', '--json'], { bin })).json();
  assert.deepEqual(Object.keys(e.repos), ['web']);
  const refused = add(root, ['--attempt', e.id, '--repo', 'api', ...lessonArgs('A lesson for the repo the attempt does not hold')], { bin });
  assert.equal(refused.code, 75, refused.err);
  assert.match(refused.err, /lesson not recorded: api is not part of ENG-410\.1 \(its repos: web\), so the lesson could not be committed, reviewed or delivered with this attempt, and a file written into api's main checkout would stay untracked there/);
  assert.match(refused.err, /wf criteria amend --file <amendment\.json> --reason "<why>" --add-repo api --attempt ENG-410\.1/);
  assert.match(refused.err, /without `--attempt` \(it is written into api's main checkout, to commit there\)/);
  assert.ok(!fs.existsSync(path.join(root, 'api', '.workflow', 'lessons')), 'nothing was written');
  assert.deepEqual(state(root, e.id).lessons?.recorded ?? [], [], 'nothing is recorded in the ledger');
  // A project lesson lives in the adapter repo; here it is not admitted either.
  const project = add(root, ['--attempt', e.id, '--project', ...lessonArgs('A project lesson learned in a web-only ticket')], { bin });
  assert.equal(project.code, 75);
  assert.match(project.err, /lesson not recorded: api \(the adapter repo, where a project lesson lives\) is not part of ENG-410\.1/);
  // The repo the attempt does hold is unchanged.
  assert.match(ok(add(root, ['--attempt', e.id, '--repo', 'web', ...lessonArgs('A lesson for the repo the attempt holds')], { bin })).out, /committed in ENG-410\.1's worktree/);
  // Outside the attempt the owner can still write it on purpose, and the command says where.
  const apart = ok(add(root, [...lessonArgs('A lesson recorded outside the attempt'), '--repo', 'api'], { bin }));
  assert.match(apart.out, /in api's main checkout: commit it there/);
  assert.ok(fs.existsSync(lessonFile(path.join(root, 'api'), 'L-2')));
  // Moving a lesson into a repository the attempt does not hold is the same write, and the same refusal.
  const move = wf(root, ['lesson', 'move', 'L-1', '--repo', 'api', '--attempt', e.id], { bin });
  assert.equal(move.code, 75, move.err);
  assert.match(move.err, /lesson not moved: api is not part of ENG-410\.1 \(its repos: web\)/);
  assert.ok(fs.existsSync(lessonFile(state(root, e.id).repos.web.worktree, 'L-1')), 'the lesson stays where it was');
  assert.ok(base);
});

test('I-112: the route works: amending the attempt to add the repo lets the lesson be committed in that repo\'s worktree', () => {
  const bin = engineAt('0.7.4');
  const { base, root } = multiRepoProject('fix074-add-repo');
  const e = ok(wf(root, ['entry', '--item', 'ENG-411', '--owner', 'o', '--repos', 'web', '--json'], { bin })).json();
  ok(wf(root, ['handoff', 'planner', '--agent', 'p', '--attempt', e.id], { bin }));
  ok(wf(root, ['plan', '--file', criteriaFile(base), '--attempt', e.id], { bin }));
  ok(wf(root, ['criteria', 'amend', '--file', amendFile(base, [{ id: 'C1', text: 'a changes', uat: 'a shows the new text' }]), '--reason', 'the api lesson needs its repo', '--add-repo', 'api', '--attempt', e.id], { bin }));
  const r = ok(add(root, ['--attempt', e.id, '--repo', 'api', ...lessonArgs('A lesson for the api repo, now in the attempt')], { bin }));
  assert.match(r.out, /committed in ENG-411\.1's worktree/);
  assert.ok(fs.existsSync(lessonFile(state(root, e.id).repos.api.worktree, 'L-1')));
  assert.ok(!fs.existsSync(path.join(root, 'api', '.workflow', 'lessons')));
});

// D7: an attempt admitted before 0.7.4 keeps the write it had.
test('I-112 (D7): an attempt admitted before 0.7.4 is not refused: the lesson goes to the repo\'s main checkout as it did', () => {
  const bin = engineAt('0.7.3');
  const { root } = multiRepoProject('fix074-not-admitted-old');
  const e = ok(wf(root, ['entry', '--item', 'ENG-412', '--owner', 'o', '--repos', 'web', '--json'], { bin })).json();
  assert.equal(state(root, e.id).engineVersion, '0.7.3');
  const r = ok(add(root, ['--attempt', e.id, '--repo', 'api', ...lessonArgs('Written as before')], { bin }));
  assert.match(r.out, /in api's main checkout: commit it there/);
  assert.ok(fs.existsSync(lessonFile(path.join(root, 'api'), 'L-1')));
});

// ======================================================================================================================
// I-49: a generated lesson passes the repository's own Prettier check
// ======================================================================================================================

// The texts of real lessons are long: most fold at 80 columns, and some need quotes.
const WORDS = {
  title: 'Data tables use the shared table and pagination components, never a raw table element',
  what: 'A report page rendered a raw table without pagination; the review did not catch it, and the owner found it while checking the page on a phone: the list ran to 400 rows and the page took six seconds to open.',
  quote: "why isn't this using our table? it's the third time I have asked",
  text: 'Ask for the shared table and its pager in every plan that touches a list, and have the reviewer open the page with more rows than one page holds before judging it complete.',
  ref: 'table-has-pagination',
};
const BOTH = { title: 'Owner\'s "quoted" words stay in the lesson', what: 'The owner said "use the table" and it\'s still not done: a long tail follows to push the text well past the print width of eighty characters.' };

const addLong = (root, id, extra = []) => ok(add(root, ['--title', WORDS.title, '--what', WORDS.what, '--quote', WORDS.quote, '--cause', 'design-system', '--mechanism', 'designSystem-rule', '--ref', WORDS.ref, '--text', WORDS.text, '--tags', 'ui,tables', '--paths', 'src/**/*.tsx', ...extra]));

// What Prettier's YAML printer requires of the shapes a lesson has (checked against Prettier 3.9 on some 3,700 generated lesson files):
// every line is a `key: value` line, a `- item` line, or inside a block scalar (no continuation line: a one-line scalar stays on
// one line whatever its width unless `proseWrap` is `always`), indentation in whole `tabWidth`s, one line ending throughout, and
// the preferred quote unless the text needs the other. Returns the problems found.
function layoutProblems(text, { tabWidth = 2, singleQuote = false, endOfLine = 'lf', printWidth = 80, proseWrap = 'preserve' } = {}) {
  const problems = [];
  const eol = { lf: '\n', crlf: '\r\n', cr: '\r' }[endOfLine];
  const lines = text.split(eol);
  if (lines.at(-1) !== '') problems.push('no final line ending');
  if (lines.some((l) => (endOfLine === 'lf' ? /\r/.test(l) : /[\r\n]/.test(l)))) problems.push(`not every line ends with ${endOfLine}`);
  let blockIndent = null;
  for (const line of lines.slice(0, -1)) {
    const indent = line.match(/^ */)[0].length;
    if (blockIndent !== null && (indent > blockIndent || line === '')) continue;
    blockIndent = null;
    if (indent % tabWidth) problems.push(`indent ${indent} is not a multiple of ${tabWidth}: ${line}`);
    if (!/^ *(- )?[A-Za-z]+:( .*)?$/.test(line) && !/^ *- .*$/.test(line)) problems.push(`continuation line: ${line.slice(0, 60)}`);
    if (/(:|-) [|>][-+0-9]*$/.test(line)) blockIndent = indent;
    const value = /^ *(?:- |[A-Za-z]+: )(["'].*)$/.exec(line)?.[1];
    if (value) {
      const quote = value[0], body = value.slice(1, -1);
      if (quote === '"' && singleQuote && !/['\\]/.test(body)) problems.push(`double quotes where the config asks for single: ${line.slice(0, 60)}`);
      if (quote === "'" && !singleQuote && !/"/.test(body)) problems.push(`single quotes where double is preferred: ${line.slice(0, 60)}`);
    }
    if (proseWrap === 'always' && blockIndent === null && line.length > printWidth && /\s/.test(line.replace(/^ *(- )?[A-Za-z]*:? */, ''))) problems.push(`a line over ${printWidth} columns that proseWrap always would wrap: ${line.slice(0, 60)}`);
  }
  return problems;
}

// A lone CR is a line break (`endOfLine: cr`); the YAML library reads only LF and CRLF, so the engine reads a lesson the same way.
const readBack = (text) => YAML.parse(text.replace(/\r\n?/g, '\n'));

const PRETTIER_CONFIGS = {
  'defaults (no config)': {},
  'singleQuote': { files: { '.prettierrc': '{"singleQuote": true}\n' }, style: { singleQuote: true } },
  'printWidth 40 and 120': { files: { '.prettierrc.json': '{"printWidth": 40}\n' }, style: { printWidth: 40 } },
  'tabWidth 4': { files: { '.prettierrc.yaml': 'tabWidth: 4\n' }, style: { tabWidth: 4 } },
  'endOfLine crlf': { files: { '.prettierrc': 'endOfLine: crlf\n' }, style: { endOfLine: 'crlf' } },
  'proseWrap always, printWidth 100': { files: { 'package.json': JSON.stringify({ name: 'x', prettier: { proseWrap: 'always', printWidth: 100 } }) }, style: { proseWrap: 'always', printWidth: 100 } },
  'proseWrap never': { files: { '.prettierrc': '{"proseWrap": "never"}\n' }, style: { proseWrap: 'never' } },
  'endOfLine cr': { files: { '.prettierrc': '{"endOfLine": "cr"}\n' }, style: { endOfLine: 'cr' } },
  'all of them, from an override': { files: { '.prettierrc': JSON.stringify({ tabWidth: 8, overrides: [{ files: '*.yaml', options: { singleQuote: true, tabWidth: 3, endOfLine: 'crlf', proseWrap: 'always', printWidth: 60 } }] }) }, style: { singleQuote: true, tabWidth: 3, endOfLine: 'crlf', proseWrap: 'always', printWidth: 60 } },
};

// Prettier itself, when the machine has it (a dependency is not added for it): WF_TEST_PRETTIER names its bin script, else a
// `prettier` on PATH. Without it the layout rules above stand in for it.
const PRETTIER = (() => {
  if (process.env.WF_TEST_PRETTIER) return { cmd: process.execPath, args: [process.env.WF_TEST_PRETTIER] };
  const found = spawnSync('sh', ['-c', 'command -v prettier'], { encoding: 'utf8' }).stdout.trim();
  return found ? { cmd: found, args: [] } : null;
})();
const prettierCheck = (cwd) => {
  const r = spawnSync(PRETTIER.cmd, [...PRETTIER.args, '--check', '.workflow/lessons'], { cwd, encoding: 'utf8' });
  return { ok: r.status === 0, out: `${r.stdout}${r.stderr}` };
};

for (const [name, cfg] of Object.entries(PRETTIER_CONFIGS)) {
  // Named failure (I-49): the 0.7.0 fix read `singleQuote` only. The library folded text at 80 columns whatever `printWidth` said
  // (Prettier keeps a one-line scalar on one line), indented by two spaces whatever `tabWidth` said, ended lines with `\n`
  // whatever `endOfLine` said and wrapped nothing the way `proseWrap: always` does: 29 of 70 real lesson texts failed
  // `prettier --check` with the default config, all of them with `tabWidth: 4`, `endOfLine: crlf` or `proseWrap: always`.
  test(`I-49: a generated lesson is laid out for the repository's Prettier config: ${name}`, () => {
    const { root } = singleRepoProject('fix074-prettier', { gate: { steps } }, cfg.files ?? {});
    addLong(root, 'L-1');
    ok(add(root, [...lessonArgs(BOTH.title, BOTH.what), '--tags', 'quotes']));
    ok(add(root, lessonArgs('Short', 'short and sweet: with a colon')));
    const style = cfg.style ?? {};
    for (const id of ['L-1', 'L-2', 'L-3']) {
      const text = fs.readFileSync(lessonFile(root, id), 'utf8');
      assert.deepEqual(layoutProblems(text, style), [], `${id}:\n${text}`);
      const parsed = readBack(text);
      assert.equal(parsed.id, id);
    }
    const first = readBack(fs.readFileSync(lessonFile(root, 'L-1'), 'utf8'));
    assert.equal(first.title, WORDS.title);
    assert.equal(first.trigger.what, WORDS.what, 'the text is the same whatever its layout');
    assert.equal(first.trigger.quote, WORDS.quote);
    assert.equal(first.mechanism.text, WORDS.text);
    const both = fs.readFileSync(lessonFile(root, 'L-2'), 'utf8');
    assert.equal(readBack(both).title, BOTH.title);
    assert.equal(readBack(both).trigger.what, BOTH.what);
    if (style.proseWrap !== 'always') {
      // Prettier writes a text holding both kinds of quote in single quotes, whatever the preference (under proseWrap always
      // this long text is a literal block instead).
      assert.match(both.replace(/\r\n?/g, '\n'), /^ *what: 'The owner said "use the table" and it''s still not done: a long tail/m);
    }
  });
}

test('I-49: the lessons pass Prettier\'s own check under every config above (skipped where Prettier is not installed; WF_TEST_PRETTIER names its bin script)', { skip: PRETTIER ? false : 'prettier is not installed here' }, () => {
  for (const [name, cfg] of Object.entries(PRETTIER_CONFIGS)) {
    const { root } = singleRepoProject('fix074-prettier-real', { gate: { steps } }, cfg.files ?? {});
    addLong(root, 'L-1');
    ok(add(root, [...lessonArgs(BOTH.title, BOTH.what), '--tags', 'quotes']));
    ok(add(root, lessonArgs('Short', 'short and sweet: with a colon')));
    ok(wf(root, ['lesson', 'recur', 'L-1']));
    ok(wf(root, ['lesson', 'set', 'L-2', '--status', 'retired']));
    const r = prettierCheck(root);
    assert.ok(r.ok, `${name}: ${r.out}`);
  }
});

// Named failure (I-49, found in review): `endOfLine: cr` wrote a lesson the YAML library cannot read (it knows LF and CRLF
// only), so `recur`, `set` and `move` answered "no lesson" for a file that was there.
test('I-49: a lesson written with bare CR line endings is read back by the commands', () => {
  const { root } = singleRepoProject('fix074-cr', { gate: { steps } }, { '.prettierrc': '{"endOfLine": "cr"}\n' });
  addLong(root, 'L-1');
  const text = fs.readFileSync(lessonFile(root, 'L-1'), 'utf8');
  assert.ok(text.includes('\r') && !text.includes('\n'), 'bare CR throughout');
  assert.match(ok(wf(root, ['lesson', 'list'])).out, /^L-1 {2}app \(main\) /m);
  ok(wf(root, ['lesson', 'recur', 'L-1']));
  ok(wf(root, ['lesson', 'set', 'L-1', '--status', 'enforced', '--ref', 'table-has-pagination']));
  const after = fs.readFileSync(lessonFile(root, 'L-1'), 'utf8');
  assert.ok(!after.includes('\n'));
  // I-130 (0.7.9): a recurrence is learned, never written into the file; `set` rewrites it in its layout.
  assert.equal(readBack(after).recurrence, 0);
  assert.match(ok(wf(root, ['lesson', 'list'])).out, /^L-1 {2}app \(main\) .*recurrence 1/m);
  assert.equal(readBack(after).status, 'enforced');
});

// Named failure (I-49): the 0.7.0 reader tried `.prettierrc` before `package.json`, and `.prettierrc.yaml` before `.yml`; Prettier
// takes a package.json that has a `prettier` key first and `.yml` before `.yaml` (checked with `prettier --find-config-path`
// on 3.9), uses the first folder that has a config (the lesson's own folder and `.workflow` count), applies `overrides` by the
// lesson file's path, and never reads on past a config it uses even when this module cannot read that one.
test('I-49: the config is found as Prettier finds it: package.json before .prettierrc, .yml before .yaml, the nearest folder, overrides by path', () => {
  const lessonWith = (files) => {
    const { root } = singleRepoProject('fix074-precedence', { gate: { steps } }, files);
    ok(add(root, lessonArgs('Precedence', 'a raw table shipped: no reviewer caught it')));
    return fs.readFileSync(lessonFile(root, 'L-1'), 'utf8');
  };
  const quoted = /^ {2,}what: '/m;
  // package.json with a prettier key beats .prettierrc; without the key it is skipped.
  const pkg = lessonWith({ 'package.json': JSON.stringify({ name: 'x', prettier: { singleQuote: true, tabWidth: 4 } }), '.prettierrc': '{"singleQuote": false, "tabWidth": 2}' });
  assert.match(pkg, quoted);
  assert.match(pkg, /^ {4}what: /m);
  assert.match(lessonWith({ 'package.json': JSON.stringify({ name: 'x' }), '.prettierrc': '{"singleQuote": true}' }), quoted, 'a package.json without a prettier key is skipped');
  // Prettier skips a package.json whose key is empty or null, or that it cannot read (checked on 3.9).
  assert.match(lessonWith({ 'package.json': JSON.stringify({ name: 'x', prettier: null }), '.prettierrc': '{"singleQuote": true}' }), quoted);
  assert.match(lessonWith({ 'package.json': JSON.stringify({ name: 'x', prettier: '' }), '.prettierrc': '{"singleQuote": true}' }), quoted);
  assert.match(lessonWith({ 'package.json': '{ not json', '.prettierrc': '{"singleQuote": true}' }), quoted);
  // A config that is a link is read through it.
  const linked = singleRepoProject('fix074-linked-config', { gate: { steps } }, { 'shared/prettier.json': '{"singleQuote": true}\n' });
  fs.symlinkSync(path.join('shared', 'prettier.json'), path.join(linked.root, '.prettierrc'));
  ok(add(linked.root, lessonArgs('Linked', 'a raw table shipped: no reviewer caught it')));
  assert.match(fs.readFileSync(lessonFile(linked.root, 'L-1'), 'utf8'), quoted);
  // .prettierrc.yml comes before .prettierrc.yaml; .prettierrc.json before both.
  assert.match(lessonWith({ '.prettierrc.yml': 'singleQuote: true\n', '.prettierrc.yaml': 'singleQuote: false\n' }), quoted);
  assert.match(lessonWith({ '.prettierrc.json': '{"singleQuote": true}', '.prettierrc.yml': 'singleQuote: false\n' }), quoted);
  // The nearest folder that has a config wins whole: .workflow/ before the root, no merging across folders.
  const near = lessonWith({ '.workflow/.prettierrc': '{"tabWidth": 4}', '.prettierrc': '{"singleQuote": true}' });
  assert.match(near, /^ {4}what: "/m, 'tabWidth from .workflow/.prettierrc, and no single quote from the root config');
  // Overrides apply by the lesson file's path: a name pattern, a path pattern, an exclusion, later ones over earlier.
  assert.match(lessonWith({ '.prettierrc': JSON.stringify({ overrides: [{ files: '*.yaml', options: { singleQuote: true } }] }) }), quoted);
  assert.match(lessonWith({ '.prettierrc': JSON.stringify({ overrides: [{ files: '.workflow/**', options: { singleQuote: true } }] }) }), quoted);
  assert.match(lessonWith({ '.prettierrc': JSON.stringify({ overrides: [{ files: '*.{yml,yaml}', options: { singleQuote: true } }] }) }), quoted);
  assert.doesNotMatch(lessonWith({ '.prettierrc': JSON.stringify({ overrides: [{ files: '*.md', options: { singleQuote: true } }, { files: 'src/**', options: { singleQuote: true } }, { files: '*.yml', options: { singleQuote: true } }] }) }), quoted);
  assert.doesNotMatch(lessonWith({ '.prettierrc': JSON.stringify({ singleQuote: true, overrides: [{ files: '**/*.yaml', excludeFiles: '**/L-1.yaml', options: { singleQuote: false } }, { files: '*.yaml', options: { singleQuote: false } }] }) }), quoted);
  assert.match(lessonWith({ '.prettierrc': JSON.stringify({ overrides: [{ files: '*.yaml', options: { singleQuote: false } }, { files: '.workflow/lessons/*.yaml', options: { singleQuote: true } }] }) }), quoted, 'a later override wins');
});

// A config this module does not read (JavaScript, TOML, a shared-config name) is the one Prettier uses; the search stops there
// rather than falling through to a lower config Prettier would never reach, and the lesson is written in Prettier's defaults.
test('I-49: a config form that cannot be read statically stops the search; a new lesson is then written in Prettier\'s defaults', () => {
  const lessonWith = (files) => {
    const { root } = singleRepoProject('fix074-unreadable', { gate: { steps } }, files);
    ok(add(root, lessonArgs('Unreadable', 'a raw table shipped: no reviewer caught it')));
    return fs.readFileSync(lessonFile(root, 'L-1'), 'utf8');
  };
  const quoted = /^ {2,}what: '/m;
  assert.doesNotMatch(lessonWith({ '.prettierrc.js': 'module.exports = { singleQuote: true, tabWidth: 4 };\n', '.prettierrc.toml': 'singleQuote = true\n' }), quoted);
  assert.doesNotMatch(lessonWith({ 'prettier.config.mjs': 'export default { singleQuote: true };\n', '.prettierrc.toml': 'singleQuote = true\n' }), quoted);
  assert.doesNotMatch(lessonWith({ 'package.json': JSON.stringify({ name: 'x', prettier: '@scope/prettier-config' }), '.prettierrc': '{"singleQuote": true}' }), quoted, 'a shared-config name is the config Prettier uses; it is not resolved');
  // ... but a readable config that comes first in Prettier's order is used (.prettierrc.json before .prettierrc.js).
  assert.match(lessonWith({ '.prettierrc.json': '{"singleQuote": true}', '.prettierrc.js': 'module.exports = {};\n' }), quoted);
  const text = lessonWith({ '.prettierrc.js': 'module.exports = { tabWidth: 8 };\n' });
  assert.match(text, /^ {2}what: /m);
  assert.deepEqual(layoutProblems(text), []);
});

// Named failure (I-49): `recur`, `set` and `move` re-serialise the whole file, so a manual `prettier --write` was undone by the
// next command. The file is laid out for the config again; where the config is not readable, the file keeps its own layout.
test('I-49: set and move write the layout the config asks for; where the config is unreadable the file keeps its own', () => {
  const { root } = singleRepoProject('fix074-rewrite', { gate: { steps } }, { '.prettierrc': '{"tabWidth": 4, "singleQuote": true, "endOfLine": "crlf"}\n' });
  addLong(root, 'L-1');
  ok(wf(root, ['lesson', 'recur', 'L-1']));
  ok(wf(root, ['lesson', 'set', 'L-1', '--status', 'enforced', '--ref', 'table-has-pagination']));
  const text = fs.readFileSync(lessonFile(root, 'L-1'), 'utf8');
  assert.deepEqual(layoutProblems(text, { tabWidth: 4, singleQuote: true, endOfLine: 'crlf' }), []);
  const parsed = YAML.parse(text);
  assert.equal(parsed.recurrence, 0, 'I-130: a recurrence is learned, never written into the file');
  assert.equal(parsed.status, 'enforced');
  assert.equal(parsed.trigger.what, WORDS.what);

  // Each repository has its own config: a moved lesson takes the layout of the repository it moves to.
  const { root: ws } = multiRepoProject('fix074-move', { api: { '.prettierrc': '{"tabWidth": 4}\n' }, web: { '.prettierrc': '{"singleQuote": true, "endOfLine": "crlf"}\n' } });
  ok(add(ws, ['--repo', 'api', ...lessonArgs('Moves to the web repo', 'a raw table shipped: no reviewer caught it')]));
  assert.deepEqual(layoutProblems(fs.readFileSync(lessonFile(path.join(ws, 'api'), 'L-1'), 'utf8'), { tabWidth: 4 }), []);
  ok(wf(ws, ['lesson', 'move', 'L-1', '--repo', 'web']));
  assert.deepEqual(layoutProblems(fs.readFileSync(lessonFile(path.join(ws, 'web'), 'L-1'), 'utf8'), { singleQuote: true, endOfLine: 'crlf' }), []);
  assert.ok(!fs.existsSync(lessonFile(path.join(ws, 'api'), 'L-1')));

  // A JavaScript config cannot be read: a file Prettier has formatted (four spaces, CRLF, single quotes) keeps that layout when
  // a command rewrites it, and a new lesson in the same repository is written in the defaults.
  const own = singleRepoProject('fix074-own-layout', { gate: { steps } }, { '.prettierrc.js': 'module.exports = { tabWidth: 4, singleQuote: true, endOfLine: "crlf" };\n' });
  const seed = { id: 'L-1', title: 'Formatted by the project', trigger: { what: 'a raw table shipped: no reviewer caught it', attempt: null, finding: null, quote: null }, cause: 'test', mechanism: { kind: 'doc', ref: null, text: null }, scope: 'repo', status: 'proposed', tags: [], paths: [], components: [], kinds: [], classes: [], recurrence: 0, created: '2026-10-14T00:00:00.000Z', repo: 'app' };
  fs.mkdirSync(path.dirname(lessonFile(own.root, 'L-1')), { recursive: true });
  fs.writeFileSync(lessonFile(own.root, 'L-1'), YAML.stringify(seed, { indent: 4, singleQuote: true, lineWidth: 0 }).replace(/\n/g, '\r\n'));
  sh(own.root, 'git add -A && git commit -q -m "lesson formatted by the project"');
  // A rewrite (I-130, 0.7.9: `set`; a recurrence no longer writes the file) keeps the file's own layout.
  ok(wf(own.root, ['lesson', 'set', 'L-1', '--status', 'enforced', '--ref', 'table-has-pagination']));
  const kept = fs.readFileSync(lessonFile(own.root, 'L-1'), 'utf8');
  assert.deepEqual(layoutProblems(kept, { tabWidth: 4, singleQuote: true, endOfLine: 'crlf' }), []);
  assert.match(kept, /^ {4}what: 'a raw table shipped: no reviewer caught it'\r$/m);
  assert.equal(YAML.parse(kept).status, 'enforced');
  ok(add(own.root, lessonArgs('A new lesson', 'a raw table shipped: no reviewer caught it')));
  assert.deepEqual(layoutProblems(fs.readFileSync(lessonFile(own.root, 'L-2'), 'utf8')), [], 'a new lesson in the defaults');

  // An .editorconfig is not read either; beside a readable config, what the config does not set stays as the file has it.
  const editor = singleRepoProject('fix074-editorconfig', { gate: { steps } }, { '.prettierrc': '{"singleQuote": true}\n', '.editorconfig': 'root = true\n[*]\nend_of_line = crlf\nindent_size = 4\n' });
  fs.mkdirSync(path.dirname(lessonFile(editor.root, 'L-1')), { recursive: true });
  fs.writeFileSync(lessonFile(editor.root, 'L-1'), YAML.stringify(seed, { indent: 4, singleQuote: true, lineWidth: 0 }).replace(/\n/g, '\r\n'));
  sh(editor.root, 'git add -A && git commit -q -m "lesson formatted by the project"');
  ok(wf(editor.root, ['lesson', 'recur', 'L-1']));
  assert.deepEqual(layoutProblems(fs.readFileSync(lessonFile(editor.root, 'L-1'), 'utf8'), { tabWidth: 4, singleQuote: true, endOfLine: 'crlf' }), []);
});

// ======================================================================================================================
// I-96: documentation and provenance files do not decide the review division
// ======================================================================================================================

// Two separable flows of 24 product files each, plus `docs` documentation files that no flow maps.
function twoFlows({ docs = 0, perFlow = 24, docLines = 500, docDir = 'docs/verification', docExt = 'md' } = {}) {
  const product = ['alpha', 'beta'].flatMap((feature) => Array.from({ length: perFlow }, (_, i) => `${feature}/${i}.ts`));
  const documentation = Array.from({ length: docs }, (_, i) => `${docDir}/record-${i}.${docExt}`);
  const flows = ['alpha', 'beta'].map((id) => ({ id, flow: `use ${id}`, failure: 'show retry', query: id }));
  const bundle = { changed: { app: [...product, ...documentation] }, impactMap: { survey: { flows }, derived: { outside: [] } } };
  const results = Object.fromEntries(flows.map((f) => [f.id, { files: product.filter((p) => p.startsWith(f.id)).map((p) => `app:${p}`) }]));
  const weights = Object.fromEntries([...product.map((p) => [`app:${p}`, 2]), ...documentation.map((d) => [`app:${d}`, docLines])]);
  return { bundle, results, weights, product, documentation };
}

// Named failure (I-96): 12 documentation files of 500 lines in a 48-file change of two separable flows were read as product code.
// No flow maps them, so they were unmapped integration work (cost 6000 of 6096, over the 3048 threshold) and a division into two
// scopes became one reviewer; 10 such files already did, and 49 also tripped the file-count threshold.
test('I-96: documentation files neither weigh on the division nor count toward its thresholds, and the integration reviewer still owns them', async () => {
  const { divideReview, reviewDivisionSummary, validateDivision } = await import('../engine/review-groups.mjs');
  for (const docs of [10, 12, 49]) {
    const { bundle, results, weights } = twoFlows({ docs });
    const plan = divideReview(bundle, results, { weights });
    assert.equal(plan.mode, 'parallel', `${docs} documentation files: ${plan.reason}`);
    assert.deepEqual(plan.slices.map((s) => s.files.length), [24, 24]);
    assert.equal(plan.documentation.length, docs);
    assert.ok(plan.documentation.every((f) => plan.integration.files.includes(f)), 'integration is handed every documentation file');
    assert.equal(plan.integration.files.length, docs);
    assert.equal(plan.integration.estimatedCost, 0, 'and they cost it nothing');
    assert.equal(plan.diagnostics.integration.unmapped.files, 0, 'they are not unmapped integration code');
    assert.equal(plan.diagnostics.changedFiles, 48);
    assert.equal(plan.diagnostics.documentationFiles, docs);
    assert.equal(plan.files.length, 48 + docs, 'the plan still lists every changed file');
    assert.match(reviewDivisionSummary(plan), new RegExp(`48 changed files \\(${docs} documentation files more, handed to integration and outside the estimate\\)`));
    validateDivision(plan, bundle);
  }
  // The same change without them, and a plan that lies about a documentation file, for the check that owns them.
  const { bundle, results, weights } = twoFlows({ docs: 12 });
  const plan = divideReview(bundle, results, { weights });
  const forged = structuredClone(plan);
  forged.documentation.push('app:alpha/0.ts');
  assert.throws(() => validateDivision(forged, bundle), /documentation file that is not a changed file owned by integration/);
  const lost = structuredClone(plan);
  lost.integration.files = lost.integration.files.filter((f) => f !== plan.documentation[0]);
  assert.throws(() => validateDivision(lost, bundle), /every changed file exactly once|documentation file/);
});

test('I-96: the 40-file threshold counts product files; a flow\'s query that returns a documentation file does not make it a flow file', async () => {
  const { divideReview } = await import('../engine/review-groups.mjs');
  const small = twoFlows({ perFlow: 15, docs: 20 });
  const single = divideReview(small.bundle, small.results, { weights: small.weights });
  assert.equal(single.mode, 'single', '30 product files and 20 documentation files are not 50 files to divide');
  assert.equal(single.diagnostics.reasonCode, 'below-minimum-files');
  assert.match(single.reason, /only 30 changed product files; retain one reviewer below 40/);
  assert.equal(single.diagnostics.documentationFiles, 20);
  assert.equal(single.integration.files.length, 50, 'a single reviewer is handed all of them');
  const wide = twoFlows({ docs: 3 });
  wide.results.alpha.files.push('app:docs/verification/record-0.md');
  const plan = divideReview(wide.bundle, wide.results, { weights: wide.weights });
  assert.equal(plan.mode, 'parallel');
  assert.ok(plan.flows.every((f) => f.files.every((file) => !file.includes('docs/'))), 'documentation is not a flow file');
  assert.deepEqual(plan.integration.interfaces, [], 'and a changed documentation file in a query\'s results is no outside consumer');
});

test('I-96: what counts as documentation: prose and licence files by type, and the adapter\'s docsOnly files through its matcher; a folder name is not enough', async () => {
  const { divideReview } = await import('../engine/review-groups.mjs');
  const { documentationMatcher, isDocumentationFile } = await import('../engine/impact.mjs');
  for (const file of ['README.md', 'docs/guide.md', 'guide.mdx', 'notes.rst', 'manual.adoc', 'LICENSE', 'sub/NOTICE', 'LICENSE.md']) assert.ok(isDocumentationFile(file), file);
  // Independent review of 0.7.4: a folder name made product code documentation (it then left the division and the symbol scan).
  for (const file of ['src/a.ts', 'src/docs.ts', 'src/documents/a.ts', 'requirements.txt', 'robots.txt', 'app/evidence/log.ts', 'src/readme.ts', 'a.md.ts', 'docs/a.json', 'src/modules/doc/doc.service.ts', 'apps/docs/app/page.tsx', 'src/docs/renderer.ts', 'packages/api/documentation/openapi.controller.ts', 'app/Docs/layout.tsx']) assert.ok(!isDocumentationFile(file), file);
  const matcher = documentationMatcher({ repos: [{ name: 'app', packages: [{ path: '.', docsOnly: ['evidence/**'] }] }, { name: 'api', packages: [{ path: 'services/billing', docsOnly: ['fixtures/**/*.json'] }] }] });
  assert.ok(matcher('app', 'evidence/run-1.json') && matcher('app', 'README.md'));
  assert.ok(!matcher('app', 'src/evidence.ts'));
  assert.ok(matcher('api', 'services/billing/fixtures/a/b.json') && !matcher('api', 'services/billing/src/a.json') && !matcher('api', 'fixtures/a.json'));
  assert.ok(!matcher('other', 'evidence/run-1.json'));
  // The caller passes the matcher; the division then leaves those files out as well.
  const { bundle, results, weights } = twoFlows({ docs: 12, docDir: 'evidence', docExt: 'json' });
  assert.equal(divideReview(bundle, results, { weights }).mode, 'single', 'without the adapter\'s notion these are product files');
  const plan = divideReview(bundle, results, { weights, documentation: matcher });
  assert.equal(plan.mode, 'parallel');
  assert.equal(plan.documentation.length, 12);
});

// The default handoff, with no caller-supplied notion: 12 documentation files of 500 lines in the diff, next to two flows of 25 files.
function flowFiles() {
  const files = { 'shared.ts': 'alpha beta\n', 'unmapped.ts': 'common\n' };
  for (const feature of ['alpha', 'beta']) for (let i = 0; i < 24; i++) files[`${feature}/${i}.ts`] = `${feature}\n`;
  return files;
}
test('I-96: an ordinary reviewer handoff still divides a large separable change that also commits a documentation package', () => {
  const files = flowFiles();
  const p = singleRepoProject('fix074-docs-division', { strategy: { enabled: false }, gate: { steps: [] } }, files);
  const e = ok(wf(p.root, ['entry', '--lane', 'quick', '--json'])).json();
  const queries = ['alpha', 'beta'].map((id) => ({ id, pattern: id, kind: 'literal', paths: ['alpha/**', 'beta/**', 'shared.ts'], hits: 25 }));
  const doc = { survey: { queries, patterns: [{ id: 'P', query: 'alpha', hits: 25 }] }, expect: { files: 2, rounds: 2, minutes: 60 }, criteria: [{ id: 'C1', text: 'flows remain coherent' }], plan: { anchors: ['src/a.txt'], tests: { run: ['flow-test'] } },
    impact: { changes: queries.map((q) => ({ id: q.id, element: q.id, kind: 'symbol', cites: ['C1'], covers: ['P'], consumers: { query: q.id, hits: 25 }, flows: [{ flow: `use ${q.id}`, failure: 'retry', query: q.id, hits: 25 }], contracts: [], suites: [{ suite: 'flow-test', query: q.id, hits: 25 }] })) } };
  ok(wf(p.root, ['plan', '--file', closureFile(p.base, doc), '--attempt', e.id]));
  ok(wf(p.root, ['handoff', 'implementer', '--agent', 'impl', '--attempt', e.id]));
  const change = Object.fromEntries(Object.entries(files).map(([file, text]) => [file, `${text}changed\n`]));
  for (let i = 0; i < 12; i++) change[`docs/verification/capture-${i}.md`] = 'a recorded http result line\n'.repeat(500);
  commitIn(e.repos.app.worktree, change);
  const h = ok(wf(p.root, ['handoff', 'reviewer', '--agent', 'integration', '--attempt', e.id, '--json'])).json();
  assert.equal(h.division.mode, 'parallel', h.division.reason);
  assert.equal(h.members.length, 3);
  assert.equal(h.division.documentation.length, 12);
  const integration = JSON.parse(fs.readFileSync(h.bundle, 'utf8'));
  assert.ok(integration.primaryFiles.includes('app:docs/verification/capture-0.md'), 'the integration reviewer is handed the documentation');
  assert.ok(integration.primaryFiles.includes('app:shared.ts'));
  for (const member of h.members.filter((m) => m !== h.members.at(-1))) assert.ok(!JSON.stringify(JSON.parse(fs.readFileSync(member.file ?? member.bundle ?? h.bundle, 'utf8')).primaryFiles ?? []).includes('docs/verification'), 'a scope is not handed them');
});

// Named failure (I-96, same class): the symbol scan of the final diff took declarations out of documentation files, so a code block
// in a guide put `renderGuide` among the symbols whose callers every reviewer was asked about.
test('I-96: declarations in documentation files are not symbols of the final diff', () => {
  const { base, root } = singleRepoProject('fix074-docs-symbols', { gate: { steps } });
  const e = ok(wf(root, ['entry', '--item', 'ENG-420', '--owner', 'o', '--json'])).json();
  ok(wf(root, ['handoff', 'planner', '--agent', 'p', '--attempt', e.id]));
  ok(wf(root, ['plan', '--file', criteriaFile(base), '--attempt', e.id]));
  ok(wf(root, ['handoff', 'implementer', '--agent', 'i', '--attempt', e.id]));
  commitIn(e.repos.app.worktree, {
    'src/table.js': 'export function renderTable(rows) {\n  return rows;\n}\n',
    'docs/guide.md': '# Guide\n\n```js\nexport function renderGuide(rows) {\n  return rows;\n}\nclass GuideHelper {}\n```\n',
    'docs/manifest.json': '{ "note": "export function renderManifest() {}" }\n',
  });
  ok(wf(root, ['gate', '--reason', 'scenario: gate mechanics, outside the order of work', '--attempt', e.id]));
  const start = ok(wf(root, ['handoff', 'reviewer', '--agent', 'rev-1', '--attempt', e.id])).out;
  const bundle = JSON.parse(fs.readFileSync(start.match(/^Read (\S+)/m)[1], 'utf8'));
  assert.ok(bundle.impactMap.derived.symbols.includes('renderTable'), 'product declarations are still scanned');
  for (const symbol of ['renderGuide', 'GuideHelper']) assert.ok(!bundle.impactMap.derived.symbols.includes(symbol), `${symbol} is documentation`);
  // A file is documentation by its type (or the adapter's docsOnly), not by its folder: docs/manifest.json is scanned.
  assert.ok(bundle.impactMap.derived.symbols.includes('renderManifest'), 'a non-prose file under docs/ is product unless docsOnly names it');
});

// ======================================================================================================================
// I-108: every native patch Codex itself applies is parsed; a malformed payload is refused as malformed
// ======================================================================================================================

const P = (...lines) => lines.join('\n');
const BEGIN = '*** Begin Patch';
const END = '*** End Patch';
const update = (...body) => P(BEGIN, '*** Update File: a.txt', ...body, END);

// The grammar Codex applies, taken from the installed Codex itself (`codex --codex-run-as-apply-patch`, codex-cli 0.162.1, each
// row run on a three-file folder): the target list the guard must read, or `null` for a patch Codex refuses to parse.
// WF_TEST_CODEX names a Codex binary (or `1` for the one on PATH): the next test then runs every row through it.
const PATCHES = [
  // Update hunks: what an update line may be
  ['an empty context line (I-108)', update('@@', ' one', '', '-two', '+TWO'), ['a.txt']],
  ['an empty context line in a CRLF patch', update('@@', ' one', '', '-two', '+TWO').replace(/\n/g, '\r\n'), ['a.txt']],
  ['empty lines between two chunks', update('@@', '-one', '+ONE', '', '', '@@', '-three', '+THREE'), ['a.txt']],
  ['a line of spaces in a chunk', update('@@', ' one', '   ', '-two', '+TWO'), ['a.txt']],
  ['a first chunk with no @@ line', update(' two', '-three', '+THREE'), ['a.txt']],
  ['a first chunk of an empty line', update('', '@@', '-three', '+THREE'), ['a.txt']],
  ['@@ with a context text, and @@ with a trailing space', update('@@ three', '-four', '+FOUR', '@@ ', '-one', '+ONE'), ['a.txt']],
  ['a plus line that starts with plus signs', update('@@', ' two', '-three', '+++x'), ['a.txt']],
  ['an End of File marker, and blank lines after it', update('@@', '-five', '+FIVE', '*** End of File', '', '\t', '   '), ['a.txt']],
  ['an End of File marker with trailing spaces', update('@@', '-five', '+FIVE', '*** End of File  '), ['a.txt']],
  ['an End of File marker before the first chunk is skipped', update('*** End of File', '@@', '-five', '+FIVE'), ['a.txt']],
  ['a context line that reads like the end of the patch', update('@@', ' *** End Patch', '-three', '+THREE'), ['a.txt']],
  ['a context-only hunk', update('@@', ' one'), ['a.txt']],
  ['a move, with trailing spaces on its line', P(BEGIN, '*** Update File: a.txt', '*** Move to: d.txt  ', '@@', '-three', '+THREE', END), ['a.txt', 'd.txt']],
  ['a move and an empty context line', P(BEGIN, '*** Update File: a.txt', '*** Move to: sub/d.txt', '@@', ' one', '', '-two', '+TWO', END), ['a.txt', 'sub/d.txt']],
  ['an update followed by a hunk header with no blank between', P(BEGIN, '*** Update File: a.txt', '@@', '-three', '+THREE', '*** Delete File: c.txt', END), ['a.txt', 'c.txt']],
  ['an empty line before the next header is an empty context line', P(BEGIN, '*** Update File: a.txt', '@@', '-three', '+THREE', '', '*** Update File: b.txt', '@@', '-x', '+X', END), ['a.txt', 'b.txt']],
  // Hunk headers
  ['an Add with empty + lines', P(BEGIN, '*** Add File: n.txt', '+hello', '+', '+world', END), ['n.txt']],
  ['an Add with no lines', P(BEGIN, '*** Add File: n.txt', END), ['n.txt']],
  ['an Add, a Delete and an Update', P(BEGIN, '*** Add File: n.txt', '+a', '*** Delete File: c.txt', '*** Update File: b.txt', '@@', '-x', '+X', END), ['n.txt', 'c.txt', 'b.txt']],
  ['a header with white space around it after an Add', P(BEGIN, '*** Add File: n.txt', '+hello', '  *** Delete File: b.txt  ', END), ['n.txt', 'b.txt']],
  ['paths with spaces and non-ASCII letters', P(BEGIN, '*** Add File: dir/n n.txt', '+x', '*** Add File: ü/ö.txt', '+x', END), ['dir/n n.txt', 'ü/ö.txt']],
  // The boundaries
  ['white space around the whole patch and its boundary lines', `  \n\n${BEGIN}  \n*** Delete File: c.txt\n  ${END}\n\n`, ['c.txt']],
  ['a heredoc around the patch', P("<<'EOF'", BEGIN, '*** Delete File: c.txt', END, 'EOF'), ['c.txt']],
  ['a heredoc, bare and double-quoted', P('<<EOF', BEGIN, '*** Delete File: c.txt', END, 'EOF'), ['c.txt']],
  ['a stray second End Patch line after blank lines', P(BEGIN, '*** Delete File: c.txt', END, '', END), ['c.txt']],
  // Refused by Codex's own parser, so malformed here
  ['text that is not a patch', 'rm -rf x', null],
  ['no Begin Patch line', P('*** Delete File: c.txt', END), null],
  ['no End Patch line', P(BEGIN, '*** Delete File: c.txt'), null],
  ['text after End Patch', P(BEGIN, '*** Delete File: c.txt', END, 'trailing'), null],
  ['a hunk after a stray End Patch', P(BEGIN, '*** Delete File: c.txt', END, '*** Delete File: b.txt', END), null],
  ['two stray End Patch lines', P(BEGIN, '*** Delete File: c.txt', END, END, END), null],
  ['a second Begin Patch line', P(BEGIN, BEGIN, '*** Delete File: c.txt', END), null],
  ['a heredoc with another tag, or a command around it', P("<<'PATCH'", BEGIN, '*** Delete File: c.txt', END, 'PATCH'), null],
  ['a command around the heredoc', P("apply_patch <<'EOF'", BEGIN, '*** Delete File: c.txt', END, 'EOF'), null],
  ['no hunks', P(BEGIN, END), null],
  ['an empty line before the first hunk', P(BEGIN, '', '*** Delete File: c.txt', END), null],
  ['an empty line after a Delete', P(BEGIN, '*** Delete File: c.txt', '', '*** Delete File: b.txt', END), null],
  ['an empty line inside an Add', P(BEGIN, '*** Add File: n.txt', '+hello', '', '+world', END), null],
  ['a line after a Delete', P(BEGIN, '*** Delete File: c.txt', '-x', END), null],
  ['a header with no space after the colon, or in lower case', P(BEGIN, '*** Delete File:c.txt', END), null],
  ['a lower-case header after a chunk', update('@@', '-three', '+THREE', '*** add file: n.txt', '+x'), null],
  ['an update with no chunk', update(), null],
  ['an update of only @@', update('@@'), null],
  ['an @@ chunk with nothing in it before the next header', P(BEGIN, '*** Update File: a.txt', '@@', '*** Delete File: c.txt', END), null],
  ['an End of File marker right after @@', update('@@', '*** End of File'), null],
  ['@@ glued to text', update('@@x', '-three', '+THREE'), null],
  ['a line that starts any other way in a chunk', update('@@', '-three', '+THREE', 'foo'), null],
  ['a "No newline" line', update('@@', '-five', '+FIVE', '\\ No newline at end of file'), null],
  ['a tab-only line between chunks', update('@@', '-one', '+ONE', '\t', '@@', '-three', '+THREE'), null],
  ['a second chunk with no @@ line', update('@@', '-one', '+ONE', '*** End of File', '+x'), null],
  ['a second End of File marker', update('@@', '-five', '+FIVE', '*** End of File', '*** End of File'), null],
  ['a move that is not the line after the header', update('@@', '-three', '+THREE', '*** Move to: d.txt'), null],
  ['a move to nowhere', P(BEGIN, '*** Update File: a.txt', '*** Move to: ', '@@', '-three', '+THREE', END), null],
  ['a move with no chunk', P(BEGIN, '*** Update File: a.txt', '*** Move to: d.txt', END), null],
];

const targetsOf = (patch) => {
  try {
    return patchTargets(patch);
  } catch {
    return null;
  }
};

// Named failure (I-108): the parser accepted an update line only when it began with a space, `+` or `-`, so a hunk with an empty
// context line threw "unknown patch line", and the guard refused a patch that touched no evidence as one that did.
test('I-108: every patch Codex applies yields its targets, and a patch Codex refuses to parse stays malformed', () => {
  for (const [name, patch, expected] of PATCHES) assert.deepEqual(targetsOf(patch), expected, name);
});

const CODEX = (() => {
  const wanted = process.env.WF_TEST_CODEX;
  if (!wanted) return null;
  return wanted === '1' ? 'codex' : wanted;
})();
test('I-108: the same patches through the installed Codex agree (WF_TEST_CODEX=1, or the path of a Codex binary; skipped without it)', { skip: CODEX ? false : 'WF_TEST_CODEX is not set' }, () => {
  const run = (patch) => {
    const dir = tmp('codex-patch');
    for (const [file, text] of Object.entries({ 'a.txt': 'one\n\ntwo\nthree\nfour\nfive\n', 'b.txt': 'x\ny\n', 'c.txt': 'cc\n' })) write(dir, file, text);
    const snapshot = () => Object.fromEntries(['a.txt', 'b.txt', 'c.txt', 'd.txt', 'n.txt', 'sub/d.txt', 'dir/n n.txt', 'ü/ö.txt'].filter((f) => fs.existsSync(path.join(dir, f))).map((f) => [f, fs.readFileSync(path.join(dir, f), 'utf8')]));
    const before = snapshot();
    const r = spawnSync(CODEX, ['--codex-run-as-apply-patch', patch], { cwd: dir, encoding: 'utf8' });
    const after = snapshot();
    const touched = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter((f) => before[f] !== after[f]);
    fs.rmSync(dir, { recursive: true, force: true });
    const first = (r.stderr || '').split('\n')[0];
    return { applied: r.status === 0, parsed: r.status === 0 || (!/^Invalid patch/.test(first) && !/^No files were modified/.test(first)), touched };
  };
  for (const [name, patch, expected] of PATCHES) {
    const codex = run(patch);
    assert.equal(codex.parsed, expected !== null, `${name}: Codex ${codex.parsed ? 'parses' : 'refuses'} it`);
    if (codex.applied) for (const file of codex.touched) assert.ok(expected.includes(file), `${name}: Codex wrote ${file}`);
  }
});

// The guard on the ground: the patch of the report (an update with an empty context line, to an ordinary file) passes; the same
// shape aimed at the evidence folder, or a payload that cannot be read, does not.
test('I-108: the guard passes a valid patch with an empty context line, refuses one that touches the evidence, and calls an unreadable payload malformed', async () => {
  const { check } = await import('../hooks/guard-evidence.mjs');
  const root = tmp('fix074-guard');
  const judge = (command, tool_name = 'apply_patch') => check({ tool_name, cwd: root, tool_input: { command } });
  const scratch = P(BEGIN, '*** Update File: notes/scratch.txt', '@@', ' heading', '', '-old', '+new', END);
  assert.equal(judge(scratch), null);
  assert.match(judge(P(BEGIN, '*** Update File: .wf-evidence/ledger', '@@', ' heading', '', '-old', '+new', END)), /\.wf-evidence\/ledger is workflow evidence/);
  assert.match(judge(P(BEGIN, '*** Update File: notes/a.txt', '*** Move to: .wf-evidence/x', '@@', ' one', '', '-two', '+TWO', END)), /is workflow evidence/);
  assert.match(judge(P(BEGIN, '*** Delete File: notes/a.txt', '', '*** Update File: .wf-evidence/x', '@@', '-a', '+b', END)), /malformed native file-edit payload/, 'a blank line after a Delete is not a patch Codex reads');
  assert.equal(judge(scratch, 'Bash'), null, 'a shell command is never read as a patch');
  for (const bad of ['not a patch', P(BEGIN, '*** Update File: a.txt', '@@', '-a', '+b', 'oops', END), P(BEGIN, '*** Add File: a.txt', '+a')]) assert.match(judge(bad), /^malformed native file-edit payload: \S/, bad); // with the parser's reason (0.7.4)
});

// Named failure (I-108): the refusal for an unreadable payload said "this targets the workflow evidence folder", so the agent
// looked for an evidence path in a patch that had none. It now says the payload is malformed and what a patch is.
test('I-108: the hook refuses a malformed payload with a message that says so, and an evidence target with the evidence message', () => {
  const hook = path.join(REPO, 'hooks', 'guard-evidence.mjs');
  const run = (command, cwd = tmp('fix074-hook')) => spawnSync(process.execPath, [hook], { input: JSON.stringify({ tool_name: 'apply_patch', cwd, tool_input: { command } }), encoding: 'utf8' });
  const malformed = run(P(BEGIN, '*** Update File: a.txt', '@@', '-a', '+b', 'oops', END));
  assert.equal(malformed.status, 2);
  assert.match(malformed.stderr, /this file-edit payload is malformed, so its file targets cannot be read/);
  assert.match(malformed.stderr, /not about the workflow evidence/);
  assert.match(malformed.stderr, /`\*\*\* Begin Patch`[\s\S]*`\*\*\* End Patch` as the last line/);
  assert.doesNotMatch(malformed.stderr, /this targets the workflow evidence folder/);
  const evidence = run(P(BEGIN, '*** Add File: .wf-evidence/x', '+a', END));
  assert.equal(evidence.status, 2);
  assert.match(evidence.stderr, /this targets the workflow evidence folder, which only `wf` writes/);
  assert.equal(run(P(BEGIN, '*** Update File: a.txt', '@@', ' one', '', '-a', '+b', END)).status, 0, 'the patch of the report passes');
});
