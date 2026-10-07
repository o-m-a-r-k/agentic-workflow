import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { closureFile, commitIn, criteriaFile, goodClosure, makeRepo, ok, OUT_OF_ORDER, sh, singleRepoProject, state, tmp, toAccepted, wf, yaml } from './helpers.mjs';

// 0.2.0/0.3.0: the lessons harness (docs/LESSONS.md). A lesson lives in the repository it concerns and is committed and
// delivered with the attempt that taught it; every role gets the lessons that apply (proposed ones as advisory), the
// implementer acknowledges each, the reviewer judges each.

const steps = [{ id: 'unit', repo: 'app', run: 'true', inputs: ['src/**'] }];
const add = (root, args) => wf(root, ['lesson', 'add', ...args]);
const lessonFile = (repoRoot, id) => path.join(repoRoot, '.workflow', 'lessons', `${id}.yaml`);
const bundleOf = (out) => JSON.parse(fs.readFileSync((out.match(/bundle: (\S+)/) ?? out.match(/^Read (\S+)/m))[1], 'utf8'));

function multiRepoProject(name) {
  const base = tmp(name);
  const root = path.join(base, 'ws');
  fs.mkdirSync(root);
  const cfg = { version: 1, enabled: true, name, adapterRepo: 'api', repos: [{ name: 'api', path: 'api', base: 'main' }, { name: 'web', path: 'web', base: 'main' }], lanes: ['quick', 'standard'], gate: { steps: [{ id: 'api-unit', repo: 'api', run: 'true', inputs: ['src/**'] }, { id: 'web-unit', repo: 'web', run: 'true', inputs: ['src/**'] }] } };
  makeRepo(path.join(root, 'api'), { '.workflow/project.yaml': yaml(cfg), 'src/a.txt': 'a\n' });
  makeRepo(path.join(root, 'web'), { 'src/w.txt': 'w\n', 'src/table.tsx': 'x\n' });
  fs.symlinkSync(path.join('api', '.workflow'), path.join(root, '.workflow'));
  return { base, root };
}

test('capture: validated, written into the repo it concerns, recorded on its attempt; enforced needs a mechanism; apply only prints', () => {
  const { base, root } = singleRepoProject('lessons-capture', { gate: { steps } });
  const { id } = toAccepted(root, base, { item: 'ENG-300' });
  assert.match(add(root, ['--title', 'x']).err, /`trigger\.what`[\s\S]*`cause` is one of[\s\S]*`mechanism\.kind` is one of/);
  assert.match(add(root, ['--title', 't', '--what', 'w', '--cause', 'design-system', '--mechanism', 'designSystem-rule', '--status', 'enforced']).err, /an enforced lesson names its mechanism: `mechanism\.ref`/);
  const r = ok(add(root, ['--attempt', id, '--title', 'Data tables use the shared table and pagination', '--what', 'a report page used a raw table; no reviewer caught it', '--cause', 'design-system', '--mechanism', 'designSystem-rule', '--tags', 'ui,tables', '--paths', 'web/**/*.tsx', '--quote', "why isn't this our table?"]));
  // The attempt is accepted: the lesson goes to the repo's main checkout, to be committed there.
  assert.match(r.out, /lesson L-1 recorded in app: .*\.workflow\/lessons\/L-1\.yaml\n {2}in app's main checkout: commit it there/);
  const text = fs.readFileSync(lessonFile(root, 'L-1'), 'utf8');
  assert.match(text, /repo: app/);
  assert.match(text, /quote: why isn't this our table\?/);
  assert.equal(state(root, id).lessons.recorded[0].id, 'L-1');
  assert.match(ok(wf(root, ['lesson', 'list'])).out, /L-1 {2}app \(main\) {2}\[proposed, design-system, designSystem-rule\] recurrence 0 {2}Data tables/);
  const before = sh(root, 'git status --porcelain');
  assert.match(ok(wf(root, ['lesson', 'apply', 'L-1'])).out, /designSystem\.rules[\s\S]*id: lesson-l-1, repo: app[\s\S]*wf changes nothing itself/);
  assert.equal(sh(root, 'git status --porcelain'), before, 'apply changed nothing');
  assert.match(ok(wf(root, ['lesson', 'set', 'L-1', '--status', 'enforced', '--ref', 'lesson-l-1'])).out, /\[enforced/);
  // A finding about the workflow itself is not a project lesson.
  const plugin = add(root, ['--title', 'p', '--what', 'w', '--cause', 'tooling', '--mechanism', 'engine-change', '--scope', 'plugin']);
  assert.notEqual(plugin.code, 0);
  assert.match(plugin.err, /not a lesson: it is an improvement to the plugin[\s\S]*wf improve add/);
  assert.deepEqual(fs.readdirSync(path.join(root, '.workflow', 'lessons')), ['L-1.yaml'], 'nothing written for it');
});

test('per repo: a lesson recorded in an open attempt is committed in that repo\'s worktree, covered (not unplanned), reviewed and delivered', () => {
  const { base, root } = multiRepoProject('lessons-repos');
  const e = ok(wf(root, ['entry', '--item', 'ENG-305', '--owner', 'o', '--json'])).json();
  ok(wf(root, ['handoff', 'planner', '--agent', 'p', '--attempt', e.id]));
  ok(wf(root, ['plan', '--file', criteriaFile(base), '--attempt', e.id]));
  ok(wf(root, ['handoff', 'implementer', '--agent', 'i', '--attempt', e.id]));
  commitIn(e.repos.web.worktree, { 'src/table.tsx': 'raw table\n' });
  // Two repos: with no --repo, the one with the most changed files.
  const r = ok(add(root, ['--attempt', e.id, '--title', 'Tables use the shared component', '--what', 'a raw table shipped', '--cause', 'design-system', '--mechanism', 'designSystem-rule', '--paths', 'src/**/*.tsx']));
  assert.match(r.out, /recorded in web: .*web\/\.workflow\/lessons\/L-1\.yaml\n {2}committed in ENG-305\.1's worktree: it is reviewed and delivered with this attempt/);
  assert.match(sh(e.repos.web.worktree, 'git log -1 --format=%s'), /^Lesson L-1: Tables use the shared component$/);
  assert.ok(!fs.existsSync(path.join(root, 'web', '.workflow', 'lessons', 'L-1.yaml')), 'not in the main checkout yet');
  assert.ok(!fs.existsSync(path.join(root, 'api', '.workflow', 'lessons', 'L-1.yaml')), 'not in the adapter repo');
  const st = ok(wf(root, ['status', '--attempt', e.id])).out;
  assert.match(st, /lesson \(covered\): web:\.workflow\/lessons\/L-1\.yaml \(delivered with this attempt\)/);
  assert.doesNotMatch(st, /outside the plan: .*lessons/);
  // Without a single best repo, the owner is asked.
  const e2 = ok(wf(root, ['entry', '--item', 'ENG-306', '--owner', 'o', '--json'])).json();
  assert.match(add(root, ['--attempt', e2.id, '--title', 't', '--what', 'w', '--cause', 'test', '--mechanism', 'doc']).err, /which repository does this lesson concern\? pass `--repo <name>` \(api, web\)/);
  assert.match(add(root, ['--attempt', e2.id, '--repo', 'nope', '--title', 't', '--what', 'w', '--cause', 'test', '--mechanism', 'doc']).err, /`repo` names the repository the lesson concerns: one of api, web/);
});

test('a reopened attempt records its lesson before the review; it is then delivered with the change', () => {
  const { base, root } = singleRepoProject('lessons-reopen', { gate: { steps } });
  const first = toAccepted(root, base, { item: 'ENG-301' });
  ok(wf(root, ['deliver', '--attempt', first.id]));
  const id = ok(wf(root, ['reopen', '--item', 'ENG-301', '--reason', 'the screenshots are attached but I cannot see them in the ticket', '--owner', 'o', '--json'])).json().id;
  ok(wf(root, ['handoff', 'planner', '--agent', 'p2', '--attempt', id]));
  ok(wf(root, ['plan', '--file', criteriaFile(base), '--attempt', id]));
  ok(wf(root, ['handoff', 'implementer', '--agent', 'i2', '--attempt', id]));
  commitIn(state(root, id).repos.app.worktree, { 'src/a.txt': 'again\n' });
  ok(wf(root, ['gate', ...OUT_OF_ORDER, '--attempt', id]));
  const refused = wf(root, ['handoff', 'reviewer', '--agent', 'r2', '--attempt', id]);
  assert.equal(refused.code, 75);
  assert.match(refused.err, /reopens ENG-301\.1 \("the screenshots are attached but I cannot see them in the ticket"\): record what the project learns before the review/);
  ok(add(root, ['--attempt', id, '--title', 'Delivered screenshots are visible in the ticket', '--what', 'attachments showed only as links', '--cause', 'tooling', '--mechanism', 'engine-change', '--quote', 'I cannot see them']));
  ok(wf(root, ['gate', ...OUT_OF_ORDER, '--attempt', id]));
  ok(wf(root, ['handoff', 'reviewer', '--agent', 'r3', '--attempt', id]));
  // The lesson this attempt recorded applies to its own review too.
  ok(wf(root, ['review', '--closure', closureFile(base, goodClosure('r3', { lessons: [{ lesson: 'L-1', verdict: 'complied', evidence: 'the comment embeds each image' }] })), '--attempt', id]));
  ok(wf(root, ['accept', '--attempt', id]));
  ok(wf(root, ['deliver', '--attempt', id]));
  assert.equal(state(root, id).phase, 'done');
  assert.match(sh(root, `git --git-dir=${root}.origin.git show main:.workflow/lessons/L-1.yaml`), /title: Delivered screenshots are visible in the ticket/, 'delivered with the change');
  // A reopen with nothing to learn says why, in the ledger.
  const id3 = ok(wf(root, ['reopen', '--item', 'ENG-301', '--reason', 'r', '--owner', 'o', '--no-lesson', 'a typo in a label, nothing to learn', '--json'])).json().id;
  assert.equal(state(root, id3).lessons.waived.reason, 'a typo in a label, nothing to learn');
});

test('every role gets the lessons that apply, with why; proposed ones are advisory; enforced and recurring are never capped; the implementer acknowledges each and the reviewer judges each', () => {
  const { base, root } = singleRepoProject('lessons-inject', { gate: { steps } });
  for (let i = 1; i <= 8; i++) ok(add(root, ['--title', `lesson ${i}`, '--what', 'w', '--cause', 'review', '--mechanism', 'reviewer-checklist', '--tags', `t${i}`, '--paths', i === 8 ? 'docs/**' : 'src/**']));
  ok(wf(root, ['lesson', 'set', 'L-7', '--status', 'enforced', '--ref', 'roles.reviewer.appendix']));
  ok(wf(root, ['lesson', 'recur', 'L-6']));
  const e = ok(wf(root, ['entry', '--item', 'ENG-302', '--owner', 'o', '--json'])).json();
  const planner = ok(wf(root, ['handoff', 'planner', '--agent', 'p', '--attempt', e.id])).out;
  assert.match(planner, /^lessons injected: L-6, L-7, L-1, L-2, L-3, L-4, L-5 \(omitted by the cap: L-8\)/m);
  const pb = bundleOf(planner);
  assert.deepEqual(pb.lessons.apply.find((l) => l.id === 'L-1').matched, ['its repo app is in this attempt']);
  assert.equal(pb.lessons.apply.find((l) => l.id === 'L-7').label, 'enforced by reviewer-checklist (roles.reviewer.appendix)');
  assert.equal(pb.lessons.apply.find((l) => l.id === 'L-1').label, 'advisory (proposed: no mechanism enforces it yet)');
  ok(wf(root, ['plan', '--file', criteriaFile(base), '--attempt', e.id]));
  const preview = ok(wf(root, ['lessons', 'preview', '--attempt', e.id, '--role', 'implementer'])).out;
  assert.match(preview, /the implementer of ENG-302\.1 would receive/);
  const impl = ok(wf(root, ['handoff', 'implementer', '--agent', 'i', '--attempt', e.id])).out;
  const ib = bundleOf(impl);
  assert.deepEqual(ib.lessons.apply.slice(0, 2).map((l) => l.id), ['L-6', 'L-7'], 'recurring and enforced first, never capped');
  assert.equal(ib.lessons.apply.length, 7);
  assert.deepEqual(ib.lessons.omitted, ['L-8']);
  assert.match(ib.instructions, /Lesson <id>: applied - <how>/);
  // Trailers: one -m per paragraph, so each is a line of the message as an implementer would write it.
  const commitWith = (files, ...paras) => {
    for (const [rel, content] of Object.entries(files)) fs.writeFileSync(path.join(e.repos.app.worktree, rel), content);
    sh(e.repos.app.worktree, `git add -A && git commit -q ${paras.map((p) => `-m ${JSON.stringify(p)}`).join(' ')}`);
  };
  commitWith({ 'src/a.txt': 'changed\n' }, 'change', 'Lesson L-6: applied - checklist followed', 'Lesson L-7: not-applicable - no review surface touched');
  ok(wf(root, ['gate', ...OUT_OF_ORDER, '--attempt', e.id]));
  const missing = wf(root, ['handoff', 'reviewer', '--agent', 'r', '--attempt', e.id]);
  assert.equal(missing.code, 75);
  assert.match(missing.err, /the implementer did not acknowledge 5 lesson\(s\) it was handed: L-1, L-2, L-3, L-4, L-5/);
  commitWith({ 'src/b.txt': 'acks\n' }, 'acks', ...['L-1', 'L-2', 'L-3', 'L-4', 'L-5'].map((x) => `Lesson ${x}: applied - done`));
  ok(wf(root, ['gate', ...OUT_OF_ORDER, '--attempt', e.id]));
  const rv = wf(root, ['handoff', 'reviewer', '--agent', 'r', '--attempt', e.id]);
  assert.equal(rv.code, 0, rv.err);
  assert.match(rv.err, /lessons injected: L-6, L-7, /);
  const rb = bundleOf(rv.out);
  assert.deepEqual(rb.lessons.acknowledged.map((a) => `${a.lesson}:${a.ack}`).sort(), ['L-1:applied', 'L-2:applied', 'L-3:applied', 'L-4:applied', 'L-5:applied', 'L-6:applied', 'L-7:not-applicable']);
  assert.equal(state(root, e.id).lessons.acknowledged.length, 7, 'acknowledgements are in the ledger');
  const verdicts = (skip) => rb.lessons.apply.filter((l) => l.id !== skip).map((l) => ({ lesson: l.id, verdict: l.id === 'L-6' ? 'finding' : 'complied', evidence: 'checked', ...(l.id === 'L-6' ? { finding: 'F1' } : {}) }));
  const findings = [{ id: 'F1', severity: 'minor', summary: 'the checklist item was missed again', status: 'fixed', evidence: 'src/a.txt:1', category: 'review' }];
  assert.match(wf(root, ['review', '--closure', closureFile(base, goodClosure('r', { lessons: verdicts('L-1'), findings })), '--attempt', e.id]).err, /lesson L-1 \("lesson 1"\): no verdict/);
  ok(wf(root, ['review', '--closure', closureFile(base, goodClosure('r', { lessons: verdicts(null), findings })), '--attempt', e.id]));
  assert.match(ok(wf(root, ['accept', '--attempt', e.id])).out, /lesson: finding F1 is a review problem: record a lesson/);
  assert.match(ok(wf(root, ['status', '--attempt', e.id])).out, /LESSON L-6 RECURRED \(recurrence 2\): its mechanism failed; `wf lesson review` proposes promoting it to a gate check/);
  const j = ok(wf(root, ['export', '--attempt', e.id, '--json'])).json();
  assert.equal(j.lessons.verdicts.find((v) => v.lesson === 'L-6').verdict, 'finding');
});

test('planner-time matching uses the ticket: a lesson whose tag the ticket mentions applies even in a repo the attempt does not touch', () => {
  const { base, root } = multiRepoProject('lessons-ticket');
  ok(add(root, ['--repo', 'web', '--title', 'Paged lists use the shared pagination', '--what', 'w', '--cause', 'design-system', '--mechanism', 'doc', '--tags', 'pagination', '--paths', 'src/**/*.tsx']));
  const issue = path.join(base, 'issue.md');
  fs.writeFileSync(issue, 'Add an invoices list with pagination to the api docs.\n');
  const e = ok(wf(root, ['entry', '--item', 'ENG-307', '--owner', 'o', '--repos', 'api', '--issue-file', issue, '--json'])).json();
  const pb = bundleOf(ok(wf(root, ['handoff', 'planner', '--agent', 'p', '--attempt', e.id])).out);
  assert.deepEqual(pb.lessons.apply.map((l) => [l.id, l.repo, l.matched]), [['L-1', 'web', ['the ticket mentions "pagination"']]]);
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

test('repo and project lessons: a project lesson spans repos and lives in the adapter repo; misplaced lessons are flagged and moved', () => {
  const { root } = multiRepoProject('lessons-move');
  const p = ok(add(root, ['--project', '--title', 'Contracts change in both repos together', '--what', 'an api change shipped without the web change', '--cause', 'process', '--mechanism', 'planner-criterion-template']));
  assert.match(p.out, /project lesson L-1 recorded in api \(the adapter repo: it spans the project\): .*api\/\.workflow\/lessons\/L-1\.yaml/);
  const pl = fs.readFileSync(path.join(root, 'api', '.workflow', 'lessons', 'L-1.yaml'), 'utf8');
  assert.match(pl, /^scope: project$/m);
  assert.match(pl, /^repo: null$/m);
  assert.match(ok(wf(root, ['lesson', 'list'])).out, /L-1 {2}project, in api \(main\)/);
  // From before 0.3.0: a lesson about web stored in the adapter repo (api).
  const dir = path.join(root, 'api', '.workflow', 'lessons');
  fs.writeFileSync(path.join(dir, 'L-9.yaml'), yaml({ title: 'old', repo: 'web', trigger: { what: 'w' }, cause: 'test', mechanism: { kind: 'doc' }, scope: 'project', status: 'proposed', tags: [] }));
  assert.match(ok(wf(root, ['lesson', 'list'])).out, /warning: api: lesson L-9 says it concerns web; move it there: `wf lesson move L-9 --repo web`/);
  assert.match(ok(wf(root, ['lesson', 'move', 'L-9', '--repo', 'web'])).out, /lesson L-9 moved: .*api\/\.workflow\/lessons\/L-9\.yaml -> .*web\/\.workflow\/lessons\/L-9\.yaml; commit both repos/);
  assert.ok(!fs.existsSync(path.join(dir, 'L-9.yaml')));
  assert.match(fs.readFileSync(path.join(root, 'web', '.workflow', 'lessons', 'L-9.yaml'), 'utf8'), /repo: web/);
  assert.doesNotMatch(ok(wf(root, ['lesson', 'list'])).out, /warning: (?!lesson L-1 declares no scope)/);
});

test('plugin lessons stored in a project (from before 0.3.0) still export as generic issue text, names stripped', () => {
  const { root } = singleRepoProject('acmecorp', { gate: { steps }, tracker: { kind: 'none', commentRules: { forbid: ['Project Zephyr'] } } });
  const dir = path.join(root, '.workflow', 'lessons');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'L-2.yaml'), yaml({ repo: 'app', title: 'acmecorp tables in ENG-77 lacked pagination', trigger: { what: 'see https://tracker.example.test/ENG-77 and /Users/someone/work/acmecorp/web/x.tsx, reported by dev@acmecorp.test for Project Zephyr' }, cause: 'design-system', mechanism: { kind: 'engine-change', text: 'the app repo needs a table rule' }, scope: 'plugin', status: 'proposed', tags: [] }));
  const out = ok(wf(root, ['lesson', 'export', '--plugin'])).out;
  assert.match(out, /## <project> tables in <ticket> lacked pagination/);
  for (const leak of ['acmecorp', 'ENG-77', 'https://', '/Users/', 'dev@', 'Zephyr', 'the app repo']) assert.ok(!out.includes(leak), `leaked ${leak}`);
  assert.match(ok(wf(root, ['lesson', 'list'])).out, /lesson L-2 is about the workflow itself: it is a plugin improvement, not a lesson; move it to your inbox with `wf lesson move L-2 --improvement`/);
});

test('prior decisions are inputs: a criterion kept only on precedent needs a purpose-based rationale or a precedent-only finding', () => {
  const { base, root } = singleRepoProject('lessons-precedent', { gate: { steps } });
  const e = ok(wf(root, ['entry', '--item', 'ENG-304', '--owner', 'o', '--json'])).json();
  ok(wf(root, ['handoff', 'planner', '--agent', 'p', '--attempt', e.id]));
  ok(wf(root, ['plan', '--file', criteriaFile(base), '--attempt', e.id]));
  ok(wf(root, ['handoff', 'implementer', '--agent', 'i', '--attempt', e.id]));
  commitIn(e.repos.app.worktree, { 'src/a.txt': 'p\n' });
  ok(wf(root, ['gate', ...OUT_OF_ORDER, '--attempt', e.id]));
  const crit = (extra) => [{ id: 'C1', evidence: { kind: 'output', ref: 'gate log' }, precedentOnly: true, ...extra }];
  ok(wf(root, ['handoff', 'reviewer', '--agent', 'r', '--attempt', e.id]));
  ok(wf(root, ['review', '--closure', closureFile(base, goodClosure('r', { criteria: crit({}) })), '--attempt', e.id]));
  assert.match(wf(root, ['accept', '--attempt', e.id]).err, /criterion C1: kept only on precedent; give a purpose-based `rationale` \(who uses this surface and what they need\) or raise a `precedent-only` finding/);
  ok(wf(root, ['handoff', 'reviewer', '--agent', 'r2', '--attempt', e.id]));
  ok(wf(root, ['review', '--closure', closureFile(base, goodClosure('r2', { criteria: crit({ rationale: 'an administrator compares all accounts, so the total across accounts stays' }) })), '--attempt', e.id]));
  ok(wf(root, ['accept', '--attempt', e.id]));
  ok(wf(root, ['sync']));
  const reviewer = fs.readdirSync(path.join(root, '.claude', 'agents')).find((f) => f.startsWith('wf-reviewer'));
  const text = fs.readFileSync(path.join(root, '.claude', 'agents', reviewer), 'utf8');
  assert.match(text, /Prior decisions are inputs, not authority/);
  assert.match(text, /precedent-only/);
  assert.match(text, /Invariant scope check/);
});

test('lessons are matched by their declared scope: a scripts-only fix in one repo gets no UI lessons of another repo, and what was filtered is shown', () => {
  // Named failure: a quick fix that changed only scripts in the api repo was handed the web repo's UI lessons (no paths,
  // so "every change in web", because web was admitted) and a project lesson about another subject (no paths, so "every
  // change"); the reviewer had to give each a verdict.
  const base = tmp('lessons-scope');
  const root = path.join(base, 'ws');
  fs.mkdirSync(root);
  const cfg = { version: 1, enabled: true, name: 'lessons-scope', adapterRepo: 'api', repos: [{ name: 'api', path: 'api', base: 'main' }, { name: 'web', path: 'web', base: 'main' }], components: [{ id: 'api', kind: 'service', repo: 'api' }, { id: 'web', kind: 'web', repo: 'web' }], lanes: ['quick', 'standard'], gate: { steps: [{ id: 'api-unit', repo: 'api', run: 'true' }, { id: 'web-unit', repo: 'web', run: 'true' }] } };
  makeRepo(path.join(root, 'api'), { '.workflow/project.yaml': yaml(cfg), 'src/a.ts': 'a\n', 'scripts/janitor.sh': 'echo a\n' });
  makeRepo(path.join(root, 'web'), { 'src/table.tsx': 'x\n' });
  fs.symlinkSync(path.join('api', '.workflow'), path.join(root, '.workflow'));
  const lesson = (args, title) => ok(add(root, [...args, '--title', title, '--what', 'w', '--cause', 'review', '--mechanism', 'reviewer-checklist']));
  lesson(['--repo', 'web', '--tags', 'ui,tables'], 'UI tables use the shared table'); // L-1: repo only
  lesson(['--repo', 'web', '--tags', 'e2e,evidence'], 'Evidence assertions prove the value'); // L-2: repo only
  lesson(['--project', '--tags', 'analytics,timezone'], 'Operator views use one clock'); // L-3: no scope at all
  lesson(['--project', '--kinds', 'script', '--tags', 'docker'], 'Scripts fail fast'); // L-4: file kind
  lesson(['--project', '--components', 'web', '--kinds', 'ui'], 'Pages use the layout'); // L-5: component and kind
  lesson(['--repo', 'api', '--paths', 'src/**'], 'Services log the request id'); // L-6: paths in api
  lesson(['--project', '--paths', '**'], 'Every change names its rollback'); // L-7: every change
  assert.match(add(root, ['--project', '--kinds', 'widgets', '--title', 't', '--what', 'w', '--cause', 'review', '--mechanism', 'doc']).err, /`kinds` are file kinds: ui, test, migration, docs, script, config, source \(not widgets\)/);
  assert.match(add(root, ['--project', '--components', 'nope', '--title', 't', '--what', 'w', '--cause', 'review', '--mechanism', 'doc']).err, /`components` names components of the adapter: api, web \(not nope\)/);
  assert.match(ok(wf(root, ['lesson', 'list'])).out, /warning: lesson L-3 declares no scope \(repo, components, paths or kinds\): it is injected only when the ticket mentions one of its tags \(analytics, timezone\)/);
  const e = ok(wf(root, ['entry', '--owner', 'o', '--json'])).json();
  assert.deepEqual(Object.keys(e.repos).sort(), ['api', 'web'], 'both repos admitted, as in the field');
  ok(wf(root, ['plan', '--file', criteriaFile(base), '--attempt', e.id]));
  const impl = ok(wf(root, ['handoff', 'implementer', '--agent', 'i', '--attempt', e.id]));
  assert.deepEqual(bundleOf(impl.out).lessons.apply.map((l) => l.id), ['L-7'], 'two repos, nothing planned or changed yet: only the every-change lesson');
  assert.match(impl.out, /lessons filtered out \(outside this change's scope\): L-1, L-2, L-3, L-4, L-5, L-6; `wf lesson preview --attempt QF-1\.1 --role implementer` says why/);
  commitIn(e.repos.api.worktree, { 'scripts/janitor.sh': 'set -e\necho b\n' }, 'Lesson L-7: applied - rollback is reverting the script');
  ok(wf(root, ['gate', ...OUT_OF_ORDER, '--attempt', e.id]));
  const rv = ok(wf(root, ['handoff', 'reviewer', '--agent', 'r', '--attempt', e.id]));
  assert.match(rv.err, /^lessons injected: L-4, L-7$/m);
  assert.match(rv.err, /lessons filtered out \(outside this change's scope\): L-1, L-2, L-3, L-5, L-6/);
  const rb = bundleOf(rv.out);
  assert.deepEqual(rb.lessons.apply.map((l) => [l.id, l.matched]), [['L-4', ['api:scripts/janitor.sh is in its scope (kinds script)']], ['L-7', ['it applies to every change (paths **)']]]);
  assert.equal(rb.lessons.filtered, undefined, 'the reviewer is handed only the lessons it judges');
  assert.deepEqual(state(root, e.id).handoffs.at(-1).lessonsFiltered, ['L-1', 'L-2', 'L-3', 'L-5', 'L-6'], 'the ledger keeps what was filtered');
  const preview = ok(wf(root, ['lesson', 'preview', '--attempt', e.id, '--role', 'reviewer'])).out;
  assert.match(preview, /filtered out, outside this change's scope \(5\):/);
  assert.match(preview, /L-1 web: UI tables use the shared table\n {5}filtered: no changed file is in its scope \(repo web\)/);
  assert.match(preview, /L-3 Operator views use one clock\n {5}filtered: declares no scope \(repo, components, paths or kinds\), so only its tags match, and the ticket mentions none of analytics, timezone/);
  assert.match(preview, /L-5 Pages use the layout\n {5}filtered: no changed file is in its scope \(components web; kinds ui\)/);
  assert.match(preview, /L-6 api: Services log the request id\n {5}filtered: no changed file is in its scope \(repo api; paths src\/\*\*\)/);
  ok(wf(root, ['review', '--closure', closureFile(base, goodClosure('r', { lessons: [{ lesson: 'L-4', verdict: 'complied', evidence: 'scripts/janitor.sh:1 set -e' }, { lesson: 'L-7', verdict: 'complied', evidence: 'commit message' }] })), '--attempt', e.id]));
  // The same lessons still reach a change inside their scope.
  const e2 = ok(wf(root, ['entry', '--owner', 'o', '--json'])).json();
  ok(wf(root, ['plan', '--file', criteriaFile(base), '--attempt', e2.id]));
  ok(wf(root, ['handoff', 'implementer', '--agent', 'i2', '--attempt', e2.id]));
  commitIn(e2.repos.web.worktree, { 'src/table.tsx': 'y\n' }, 'Lesson L-7: applied - revert');
  const p2 = ok(wf(root, ['lesson', 'preview', '--attempt', e2.id, '--role', 'reviewer'])).out;
  assert.match(p2, /would receive 4 lesson\(s\)/);
  for (const id of ['L-1', 'L-2', 'L-5', 'L-7']) assert.match(p2, new RegExp(`^ {2}${id} \\[`, 'm'));
});
