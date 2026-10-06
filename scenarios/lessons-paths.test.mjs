import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { criteriaFile, ok, singleRepoProject, tmp, wf, yaml } from './helpers.mjs';

// 0.2.1: named finding (0.2.0 review): a lesson id, read from a flag, a --file or a lesson file's own content, became a
// path; links in the lessons folder were followed. Ids are an allowlist, a lesson's id is its file name, the folder and
// files are checked, and nothing is read or written through a link.

const base = { '--title': 't', '--what': 'w', '--cause': 'test', '--mechanism': 'doc' };
const args = (extra = {}) => Object.entries({ ...base, ...extra }).flat();
const snapshot = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir).sort().map((f) => `${f}:${fs.lstatSync(path.join(dir, f)).size}`) : []);

test('lesson ids: only the allowlist reaches a path (flags and --file alike)', () => {
  const { base: b, root } = singleRepoProject('lesson-ids', {});
  const lessons = path.join(root, '.workflow', 'lessons');
  const outside = path.join(root, 'outside.yaml');
  for (const id of ['../outside', '../../x', 'a/b', '/abs/path', '.hidden', '-dash', 'a.b', 'a_b', 'x'.repeat(65), 'L‐1', 'L-1​', 'ok id', '']) {
    const r = wf(root, ['lesson', 'add', ...args({ '--id': id })]);
    assert.notEqual(r.code, 0, JSON.stringify(id));
    assert.match(r.err, /`id` must be letters, digits and dashes|needs|is empty/, JSON.stringify(id));
    const f = path.join(b, `l-${Math.random().toString(36).slice(2)}.yaml`);
    fs.writeFileSync(f, yaml({ id, title: 't', trigger: { what: 'w' }, cause: 'test', mechanism: { kind: 'doc' }, scope: 'project', status: 'proposed' }));
    assert.notEqual(wf(root, ['lesson', 'add', '--file', f]).code, 0, `--file ${JSON.stringify(id)}`);
  }
  // A NUL can only come through a file.
  const nul = path.join(b, 'nul.yaml');
  fs.writeFileSync(nul, `id: "a\\0b"\ntitle: t\ntrigger: { what: w }\ncause: test\nmechanism: { kind: doc }\nscope: project\nstatus: proposed\n`);
  assert.match(wf(root, ['lesson', 'add', '--file', nul]).err, /`id` must be letters/);
  assert.ok(!fs.existsSync(outside));
  assert.deepEqual(snapshot(lessons), [], 'nothing written');
  // Valid ids work; a case variant of an existing one is refused (one file per folded name).
  ok(wf(root, ['lesson', 'add', ...args({ '--id': 'Table-Rule' })]));
  assert.match(wf(root, ['lesson', 'add', ...args({ '--id': 'table-rule' })]).err, /already exists|collide/);
  ok(wf(root, ['lesson', 'add', ...args({ '--id': 'x'.repeat(64) })]));
});

test('lesson files: a symlinked folder, a folder outside the adapter repo, symlinked and hard-linked files, a file whose id differs from its name', () => {
  const { base: b, root } = singleRepoProject('lesson-files', {});
  const lessons = path.join(root, '.workflow', 'lessons');
  const victimDir = tmp('lesson-victim');
  const victim = path.join(victimDir, 'victim.yaml');
  fs.writeFileSync(victim, yaml({ title: 'victim', trigger: { what: 'w' }, cause: 'test', mechanism: { kind: 'doc' }, scope: 'project', status: 'proposed', recurrence: 0 }));
  const victimBytes = fs.readFileSync(victim, 'utf8');
  // The lessons folder a symlink to outside the repo, or into the evidence.
  for (const target of [victimDir, path.join(root, '.wf-evidence')]) {
    fs.mkdirSync(target, { recursive: true });
    fs.rmSync(lessons, { recursive: true, force: true });
    fs.symlinkSync(target, lessons);
    const r = wf(root, ['lesson', 'add', ...args()]);
    assert.notEqual(r.code, 0);
    assert.match(r.err, /lessons\b.* is a symlink; lessons are not read or written through it/);
    assert.match(ok(wf(root, ['lesson', 'list'])).out, /warning: .* is a symlink/);
    fs.rmSync(lessons);
  }
  assert.equal(fs.readFileSync(victim, 'utf8'), victimBytes);
  assert.deepEqual(fs.readdirSync(victimDir), ['victim.yaml']);
  // A real folder, holding a symlinked and a hard-linked lesson file and a file claiming another id.
  fs.mkdirSync(lessons);
  fs.symlinkSync(victim, path.join(lessons, 'L-5.yaml'));
  fs.linkSync(victim, path.join(lessons, 'L-6.yaml'));
  fs.writeFileSync(path.join(lessons, 'L-7.yaml'), yaml({ id: '../../escaped', title: 'liar', trigger: { what: 'w' }, cause: 'test', mechanism: { kind: 'doc' }, scope: 'project', status: 'proposed' }));
  fs.writeFileSync(path.join(lessons, 'bad name.yaml'), 'title: x\n');
  const list = ok(wf(root, ['lesson', 'list'])).out;
  assert.match(list, /L-5\.yaml: a symlink \(skipped\)/);
  assert.match(list, /L-6\.yaml: not a regular file with one name \(a hard link\?\) \(skipped\)/);
  assert.match(list, /L-7\.yaml: its id `\.\.\/\.\.\/escaped` differs from its file name \(skipped\)/);
  assert.match(list, /bad name\.yaml: not a valid lesson file name \(skipped\)/);
  assert.doesNotMatch(list, /victim|liar/, 'no skipped lesson is used');
  for (const id of ['L-5', 'L-6', 'L-7']) {
    assert.notEqual(wf(root, ['lesson', 'recur', id]).code, 0, `recur ${id}`);
    assert.notEqual(wf(root, ['lesson', 'set', id, '--status', 'retired']).code, 0, `set ${id}`);
  }
  assert.equal(fs.readFileSync(victim, 'utf8'), victimBytes, 'the linked file outside was never written');
  assert.ok(!fs.existsSync(path.join(root, 'escaped.yaml')) && !fs.existsSync(path.join(root, '..', 'escaped.yaml')));
  // Skipped lessons are never injected.
  const e = ok(wf(root, ['entry', '--item', 'ENG-310', '--owner', 'o', '--json'])).json();
  const out = ok(wf(root, ['handoff', 'planner', '--agent', 'p', '--attempt', e.id])).out;
  const bundle = JSON.parse(fs.readFileSync(out.match(/bundle: (\S+)/)[1], 'utf8'));
  assert.deepEqual(bundle.lessons.apply.map((l) => l.id), []);
  assert.ok(criteriaFile && b);
});

test('a lessons folder linked out of the adapter repo is refused', () => {
  const { root } = singleRepoProject('lesson-outside', {});
  const elsewhere = tmp('lesson-elsewhere');
  // .workflow/lessons is a real folder whose parent is reached through a link out of the repo.
  const wfDir = path.join(root, '.workflow');
  fs.mkdirSync(path.join(elsewhere, 'lessons'));
  fs.symlinkSync(path.join(elsewhere, 'lessons'), path.join(wfDir, 'lessons'));
  const r = wf(root, ['lesson', 'add', ...args()]);
  assert.notEqual(r.code, 0);
  assert.match(r.err, /is a symlink|outside the adapter repo/);
  assert.deepEqual(fs.readdirSync(path.join(elsewhere, 'lessons')), []);
});
