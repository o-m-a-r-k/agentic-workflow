// 0.5.0 adversarial security review of the integrated branch: trust decisions read from the working tree when the
// adapter at base could not be read, adoption without the current owner, owner messages spent again from a copied
// transcript, a linked `.workflow/`, `git replace` under the engine, and globs that hang the engine. Each test
// reproduces one finding and fails without its fix.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ok, singleRepoProject, WF, wf } from './helpers.mjs';

const steps = [{ id: 'unit', repo: 'app', run: 'true', inputs: ['src/**'] }];
const engine = path.resolve(import.meta.dirname, '..');

// F6: a glob is matched without backtracking, and an unclosed `{` is a literal.
test('glob: an unclosed brace is a literal and stacked ** cannot backtrack; impact queries finish within the control query\'s time', () => {
  const code = `import('${engine}/engine/util.mjs').then((u) => {
    const out = {};
    out.brace = [u.globToRegExp('src/{a').test('src/{a'), u.globToRegExp('src/{a').test('src/a')];
    const t = Date.now();
    out.stacked = u.matchesAny('a'.repeat(200), ['**a'.repeat(12) + 'b']);
    out.stackedHit = u.matchesAny('a'.repeat(30) + 'b', ['**a'.repeat(12) + 'b']);
    out.ms = Date.now() - t;
    out.semantics = [
      u.matchesAny('src/x/y.ts', ['src/**']), u.matchesAny('src/y.ts', ['src/**/*.ts']), u.matchesAny('src/a/b/y.ts', ['src/**/*.ts']),
      u.matchesAny('srcy.ts', ['src/**/*.ts']), u.matchesAny('a/b.md', ['*.md']), u.matchesAny('b.md', ['*.md']), u.matchesAny('x.ts', ['{x,y}.ts']),
      u.matchesAny('z.ts', ['{x,y}.ts']), u.matchesAny('ab', ['a?']), u.matchesAny('a/', ['a?']), u.matchesAny('docs/a.md', ['**/*.md']), u.matchesAny('a.md', ['**/*.md']),
    ];
    console.log(JSON.stringify(out));
  })`;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8', timeout: 5000, killSignal: 'SIGKILL' });
  assert.equal(r.signal, null, 'the matcher returned within 5 s');
  const out = JSON.parse(r.stdout);
  assert.deepEqual(out.brace, [true, false], 'an unclosed brace matches itself, literally');
  assert.equal(out.stacked, false);
  assert.equal(out.stackedHit, true);
  assert.ok(out.ms < 1000, `stacked ** matched in ${out.ms} ms`);
  assert.deepEqual(out.semantics, [true, true, true, false, false, true, true, false, true, false, true, true]);

  const p = singleRepoProject('globhang', { gate: { steps } });
  const e = ok(wf(p.root, ['entry', '--item', 'GH-1', '--json'])).json();
  const env = { ...process.env, WF_EVIDENCE_FLAGS: '0', WF_HOME: path.join(p.base, '.home'), WF_CONFIG_HOME: path.join(p.base, '.wfhome') };
  for (const k of ['CLAUDE_CODE_SESSION_ID', 'CLAUDECODE', 'CODEX_THREAD_ID']) delete env[k];
  const query = (paths) => {
    const t = Date.now();
    const q = spawnSync(process.execPath, [WF, 'impact', 'run', '--attempt', e.id, '--query', JSON.stringify({ id: 'q', pattern: 'a', paths })], { cwd: p.root, env, encoding: 'utf8', timeout: 30000, killSignal: 'SIGKILL' });
    return { ...q, ms: Date.now() - t };
  };
  const control = query(['src/**']);
  assert.equal(control.status, 0, control.stderr);
  const bound = Math.max(10 * control.ms, 3000);
  for (const paths of [['src/{a'], ['**a'.repeat(12) + 'b']]) {
    const q = query(paths);
    assert.equal(q.signal, null, `${paths[0]} was killed`);
    assert.ok(q.ms < bound, `${paths[0]} took ${q.ms} ms, over ${bound} ms (control ${control.ms} ms)`);
  }
  // A glob that expands into too many alternatives is refused up front.
  const wide = query(['{a,b}'.repeat(12)]);
  assert.equal(wide.status, 1, wide.stderr);
  assert.match(wide.stderr, /`paths`: .*expands to more than \d+ alternatives/);
});
