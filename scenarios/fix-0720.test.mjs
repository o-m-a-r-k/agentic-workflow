import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { commitIn, criteriaFile, ok, OUT_OF_ORDER, singleRepoProject, state, wf } from './helpers.mjs';
import { deliveredSet, gateFiles } from '../engine/lifecycle.mjs';

// I-170 (field): two gate steps captured the same relative path; their titles flattened to one name, the export of 422
// screenshots was refused, and one upload could have satisfied both records' attachment check.
test('screenshots two steps capture at one relative path get distinct titles, and each exports with its own bytes', () => {
  const packages = ['one', 'two'];
  const steps = packages.map((pkg) => ({ id: pkg, repo: 'app', package: pkg, run: `mkdir -p shots && printf ${pkg}-bytes > shots/home.png`, artifacts: ['shots/*.png'] }));
  const p = singleRepoProject('export-titles', { repos: [{ name: 'app', path: '.', base: 'main', packages: packages.map((x) => ({ path: x })) }], gate: { steps } }, { '.gitignore': '.wf-evidence/\n.wf-worktrees/\n**/shots/\n', 'one/a.txt': 'a\n', 'two/b.txt': 'b\n' });
  const e = ok(wf(p.root, ['entry', '--item', 'EXP-1', '--lane', 'quick', '--owner', 'o', '--json'])).json();
  const call = (args) => wf(p.root, [...args, '--attempt', e.id]);
  ok(call(['plan', '--file', criteriaFile(p.base)]));
  ok(call(['handoff', 'implementer', '--agent', 'i']));
  commitIn(e.repos.app.worktree, { 'one/a.txt': 'A\n', 'two/b.txt': 'B\n' });
  ok(call(['gate', ...OUT_OF_ORDER]));
  const s = state(p.root, e.id);
  const gate = gateFiles(s);
  assert.equal(gate.length, 2, 'two different captures');
  assert.equal(new Set(gate.map((f) => f.title)).size, 2, `titles are distinct: ${gate.map((f) => f.title).join(', ')}`);
  assert.deepEqual(deliveredSet(p.root, s).map((f) => f.title), gate.map((f) => f.title), 'the delivered set is titled the same way');
  const out = ok(call(['export', 'screenshots', '--gate', '--json'])).json();
  assert.equal(out.files.length, 2);
  for (const f of out.files) {
    const want = gate.find((g) => g.title === f.title);
    assert.equal(crypto.createHash('sha256').update(fs.readFileSync(f.file)).digest('hex'), want.sha256, `${path.basename(f.file)} holds ${f.title}'s bytes`);
  }
});
