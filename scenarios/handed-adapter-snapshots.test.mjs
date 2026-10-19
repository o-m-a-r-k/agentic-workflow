// 0.7.35 (I-235, D89). Named failure (field, three reviews on two attempts): since 0.7.32 (D78) a reviewer judging a correction of an
// admission check is handed the plugin at the admission original, the previous correction and the corrected pin, each with a decoded
// copy, under the shared `.wf-evidence/adapters/<commit>/`. `wf evidence show` and `inspect` refused every one of them as a
// cross-attempt or outside read (exit 75), and `wf evidence list --kind adapter` was empty, so the reviewer rebuilt them from git.
// A snapshot is readable because this attempt's reviewer bundle handed it; anything else in that folder stays refused.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { commitIn, criteriaFile, ok, singleRepoProject, wf } from './helpers.mjs';

const step = { id: 'unit', repo: 'app', plugin: 'steps/unit.mjs', inputs: ['src/**'] };
// The spec is embedded as an escaped string, as field plugins embed theirs: the decoded copy shows it line by line.
const PLUGIN = (marker) => `export default {async run(ctx){ const spec = "it('${marker}', () => {\\n  cy.contains(\\"Day 1\\")\\n})"; ctx.log(spec); return {status:'passed'} }};`;

function attempt(f, item) {
  const e = ok(wf(f.root, ['entry', '--item', item, '--json'])).json();
  ok(wf(f.root, ['handoff', 'planner', '--agent', `planner-${item}`, '--attempt', e.id]));
  ok(wf(f.root, ['plan', '--file', criteriaFile(f.base), '--attempt', e.id]));
  ok(wf(f.root, ['handoff', 'implementer', '--agent', `impl-${item}`, '--attempt', e.id]));
  commitIn(e.repos.app.worktree, { 'src/a.txt': `changed by ${item}\n` });
  ok(wf(f.root, ['handoff', 'close', '--agent', `impl-${item}`, '--attempt', e.id]));
  return e;
}
const correct = (f, e, marker) => {
  commitIn(e.repos.app.worktree, { '.workflow/steps/unit.mjs': PLUGIN(marker) });
  ok(wf(f.root, ['validation', 'correct', '--steps', 'unit', '--reason', `now ${marker}`, '--attempt', e.id], { ownerSilent: true }));
  const bundle = JSON.parse(fs.readFileSync(ok(wf(f.root, ['handoff', 'reviewer', '--agent', `code-${e.id}`, '--attempt', e.id])).out.match(/^Read (\S+)/m)[1], 'utf8'));
  return Object.assign(bundle.admissionCorrections[0], { bundle });
};
const show = (f, file, id, extra = []) => wf(f.root, ['evidence', 'show', file, '--attempt', id, ...extra]);

test('0.7.35 (I-235): a reviewer reads the adapter snapshots its bundle handed with `wf evidence show`, `inspect` and `list --kind adapter`', () => {
  const f = singleRepoProject('handed-snapshots', { gate: { steps: [step] } }, { '.workflow/steps/unit.mjs': PLUGIN('admitted') });
  const e = attempt(f, 'ENG-1');
  const c = correct(f, e, 'corrected');
  for (const v of [c.original, c.corrected]) for (const file of [v.plugin.file, v.plugin.decoded]) {
    assert.ok(file.startsWith(path.join(f.root, '.wf-evidence', 'adapters', v.commit) + path.sep), file);
    assert.equal(fs.statSync(file).mode & 0o777, 0o444, `${file} is written read-only`);
  }
  // The bundle names the route to read them.
  assert.match(c.bundle.instructions, /Read each copy with `wf evidence show <plugin\.decoded> --attempt ENG-1\.1`/);
  assert.match(c.bundle.instructions, /`wf evidence list --kind adapter --attempt ENG-1\.1` lists every copy you were handed/);

  // Each handed path, as the bundle names it, reads: the plugin as committed, the decoded copy line by line.
  const raw = ok(show(f, c.corrected.plugin.file, e.id)).out;
  assert.match(raw, /it\('corrected', \(\) => \{\\n {2}cy\.contains/);
  const decoded = ok(show(f, c.corrected.plugin.decoded, e.id)).out;
  assert.match(decoded, /it\('corrected', \(\) => \{\n {2}cy\.contains\("Day 1"\)\n\}\)/);
  assert.match(ok(show(f, c.original.plugin.decoded, e.id)).out, /it\('admitted'/);
  // From the project root too (D77), and paged with a whole-file hash.
  const fromRoot = path.relative(f.root, c.original.plugin.file);
  assert.match(ok(show(f, fromRoot, e.id)).out, /admitted/);
  const page = ok(show(f, c.corrected.plugin.decoded, e.id, ['--offset', '0', '--length', '20'])).json();
  assert.equal(page.bytes, 20);
  assert.match(page.sha256, /^[0-9a-f]{64}$/);
  // `inspect` reaches the file: the plugin is not JSON, which is the only refusal left.
  assert.match(wf(f.root, ['evidence', 'inspect', c.corrected.plugin.file, '--attempt', e.id]).err, /structured inspection requires valid JSON/);

  // Listed, each once, with the bundle and correction that handed it.
  const listed = ok(wf(f.root, ['evidence', 'list', '--kind', 'adapter', '--attempt', e.id, '--json'])).json().files;
  assert.deepEqual(listed.map((x) => [x.version, x.decoded, x.file]).sort(), [[ 'corrected', false, c.corrected.plugin.file ], [ 'corrected', true, c.corrected.plugin.decoded ], [ 'original', false, c.original.plugin.file ], [ 'original', true, c.original.plugin.decoded ]].sort());
  assert.ok(listed.every((x) => x.kind === 'adapter' && x.step === 'unit' && /^handoffs\/\d+-reviewer\.json$/.test(x.handedBy) && x.path.startsWith('.wf-evidence/adapters/')));
  assert.match(ok(wf(f.root, ['evidence', 'list', '--kind', 'adapter', '--attempt', e.id])).out, /^adapter \(4\):\n {2}\.wf-evidence\/adapters\/\S+ {2}\d+ B {2}\(unit (original|corrected)/m);
  // Every listed path reads.
  for (const x of listed) ok(show(f, x.path, e.id));

  // A copy changed on disk is not the committed adapter: nothing is read from it, and git is named as the way to read it.
  const kept = fs.readFileSync(c.corrected.plugin.decoded);
  fs.chmodSync(c.corrected.plugin.decoded, 0o644);
  fs.writeFileSync(c.corrected.plugin.decoded, kept.toString().replace('Day 1', 'Day'));
  const changed = show(f, c.corrected.plugin.decoded, e.id);
  assert.equal(changed.code, 75);
  assert.match(changed.err, /is not the adapter as committed at [0-9a-f]{10}; nothing is read from it/);
  assert.match(changed.err, /`git -C \S+ show [0-9a-f]{40}:\.workflow\/steps\/unit\.mjs` prints the plugin as committed \(the copy here drops its final newline, and the decoded copy expands its string escapes\)/);
  fs.writeFileSync(c.corrected.plugin.decoded, kept);
  ok(show(f, c.corrected.plugin.decoded, e.id));
  assert.equal(ok(wf(f.root, ['verify', '--attempt', e.id])).code, 0, 'nothing was written');
  // A handed snapshot whose commit folder is gone is still known as handed, and said to be gone, with the way to read it from git.
  fs.rmSync(path.dirname(c.corrected.plugin.file), { recursive: true, force: true });
  for (const [file, decodedNote] of [[c.corrected.plugin.file, false], [c.corrected.plugin.decoded, true]]) {
    const gone = show(f, file, e.id);
    assert.equal(gone.code, 75);
    assert.match(gone.err, /: handed by handoffs\/\d+-reviewer\.json, but no longer on disk/);
    assert.match(gone.err, /`git -C \S+ show [0-9a-f]{40}:\.workflow\/steps\/unit\.mjs` prints the plugin as committed \(the copy here drops its final newline/);
    assert.equal(/the decoded copy expands its string escapes/.test(gone.err), decodedNote);
  }
});

test('0.7.35 (I-235): a snapshot no bundle of this attempt handed stays refused, from another attempt and from the same folder', () => {
  const f = singleRepoProject('unhanded-snapshots', { gate: { steps: [step] } }, { '.workflow/steps/unit.mjs': PLUGIN('admitted') });
  const one = attempt(f, 'ENG-1');
  const two = attempt(f, 'ENG-2');
  const c1 = correct(f, one, 'fixed-here');
  // The second attempt has no correction and no handed snapshot: the first one's are refused to it, and it lists none.
  for (const file of [c1.corrected.plugin.file, c1.corrected.plugin.decoded, path.relative(f.root, c1.corrected.plugin.decoded)]) {
    const r = show(f, file, two.id);
    assert.equal(r.code, 75, file);
    assert.match(r.err, /an adapter snapshot no reviewer bundle of ENG-2\.1 handed; only the snapshots its bundles name are read here/);
  }
  assert.match(ok(wf(f.root, ['evidence', 'list', '--kind', 'adapter', '--attempt', two.id])).out, /no evidence files of kind adapter in ENG-2\.1/);
  // Once the second attempt corrects the check to something else, each reads its own snapshots and not the other's.
  const c2 = correct(f, two, 'fixed-there');
  assert.match(ok(show(f, c2.corrected.plugin.decoded, two.id)).out, /fixed-there/);
  assert.equal(show(f, c2.corrected.plugin.decoded, one.id).code, 75);
  assert.equal(show(f, c1.corrected.plugin.decoded, two.id).code, 75);
  // A file in a handed snapshot's folder that the bundle does not name is refused too: the hand-over is per file, not per folder.
  const stray = path.join(path.dirname(c1.corrected.plugin.file), 'other.mjs');
  fs.writeFileSync(stray, 'export default {};\n');
  assert.match(show(f, stray, one.id).err, /an adapter snapshot no reviewer bundle of ENG-1\.1 handed/);
  // Other attempts' evidence stays a cross-attempt read.
  assert.match(show(f, path.join(f.root, '.wf-evidence', 'attempts', two.id, 'ledger.jsonl'), one.id).err, /cross-attempt and outside reads are refused/);
});
