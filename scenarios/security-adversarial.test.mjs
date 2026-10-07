// 0.5.0 adversarial security review of the integrated branch: trust decisions read from the working tree when the
// adapter at base could not be read, adoption without the current owner, owner messages spent again from a copied
// transcript, a linked `.workflow/`, `git replace` under the engine, and globs that hang the engine. Each test
// reproduces one finding and fails without its fix.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { makeRepo, ok, sh, singleRepoProject, tmp, WF, wf } from './helpers.mjs';

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

// F5: `git replace` (or a grafts file) rewrote what the base commit contains for every engine git call.
test('git replace: the engine reads the objects a commit really holds, and refuses a repo with replace refs or grafts', () => {
  const p = singleRepoProject('replace', { gate: { steps } });
  const e = ok(wf(p.root, ['entry', '--item', 'RP-1', '--json'])).json();
  // The agent writes a weaker adapter blob and replaces the committed adapter with it: impact analysis is no longer required.
  const cfgFile = path.join(p.root, '.workflow', 'project.yaml');
  const weak = { ...JSON.parse(fs.readFileSync(cfgFile, 'utf8')), impact: { requiredFor: [] } };
  const weakFile = path.join(p.base, 'weak.yaml');
  fs.writeFileSync(weakFile, JSON.stringify(weak, null, 2));
  const orig = sh(p.root, 'git rev-parse HEAD:.workflow/project.yaml');
  const blob = sh(p.root, `git hash-object -w ${JSON.stringify(weakFile)}`);
  sh(p.root, `git replace ${orig} ${blob}`);
  const r = wf(p.root, ['handoff', 'planner', '--agent', 'p', '--attempt', e.id]);
  assert.equal(r.code, 75, r.out);
  assert.match(r.err, /refs\/replace/);
  // Engine git calls never apply replacements, whatever the environment says.
  const shown = spawnSync(process.execPath, ['--input-type=module', '-e', `import('${engine}/engine/util.mjs').then((u) => console.log(u.git(${JSON.stringify(p.root)}, ['show', 'HEAD:.workflow/project.yaml'])))`], { encoding: 'utf8', env: Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'GIT_NO_REPLACE_OBJECTS')) });
  assert.doesNotMatch(shown.stdout, /requiredFor/);
  // A grafts file is refused the same way.
  sh(p.root, `git replace -d ${orig}`);
  fs.writeFileSync(path.join(p.root, '.git', 'info', 'grafts'), `${sh(p.root, 'git rev-parse HEAD')}\n`);
  const g = wf(p.root, ['handoff', 'planner', '--agent', 'p', '--attempt', e.id]);
  assert.equal(g.code, 75, g.out);
  assert.match(g.err, /info\/grafts/);
});

// F1: when the adapter at base could not be read (an uncommitted `adapterRepo` edit made it throw), trust decisions fell
// back to the working tree's copy.
const cfgOf = (root) => JSON.parse(fs.readFileSync(path.join(root, '.workflow', 'project.yaml'), 'utf8'));
const setCfg = (root, cfg) => fs.writeFileSync(path.join(root, '.workflow', 'project.yaml'), JSON.stringify(cfg, null, 2));
const planFile = (dir, doc = { plan: 'change src/a.txt', criteria: [{ id: 'C1', text: 'a.txt says b', uat: 'n/a' }] }) => {
  const f = path.join(dir, `plan-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(f, JSON.stringify(doc));
  return f;
};

test('adapter at base: an unreadable adapter refuses impact queries; the working copy never names the repos they read', () => {
  const p = singleRepoProject('impfb', { gate: { steps } });
  const e = ok(wf(p.root, ['entry', '--item', 'IF-1', '--json'])).json();
  const secret = makeRepo(path.join(tmp('secret'), 'vault'), { 'keys/prod.env': 'TOKEN=sk_test_ABC123\n' });
  const orig = cfgOf(p.root);
  const q = JSON.stringify({ id: 'x', pattern: 'sk_test_', repo: 'other' });
  setCfg(p.root, { ...orig, repos: [...orig.repos, { name: 'other', path: secret.dir, base: 'main' }] });
  const a = wf(p.root, ['impact', 'run', '--query', q, '--attempt', e.id]);
  assert.equal(a.code, 75, a.out);
  assert.doesNotMatch(a.out, /prod\.env/);
  // The working copy also names `other` as the adapter repo, so the adapter at base can no longer be found through it.
  setCfg(p.root, { ...orig, adapterRepo: 'other', repos: [...orig.repos, { name: 'other', path: secret.dir, base: 'main' }] });
  const b = wf(p.root, ['impact', 'run', '--query', q, '--attempt', e.id]);
  assert.notEqual(b.code, 0, b.out);
  assert.doesNotMatch(b.out, /prod\.env/);
  // The attempt's adapter is found from what admission recorded, so a query on a repo of the base adapter still runs.
  const c = wf(p.root, ['impact', 'run', '--query', JSON.stringify({ id: 'y', pattern: 'a', repo: 'app' }), '--attempt', e.id]);
  assert.equal(c.code, 0, c.err);
  assert.equal(ok(wf(p.root, ['resume', '--attempt', e.id, '--json'])).json().adapter.repo, 'app');
});

test('adapter at base: an uncommitted adapter edit cannot drop the impact analysis, the planner or a class', () => {
  const p = singleRepoProject('impskip', { gate: { steps } });
  const e = ok(wf(p.root, ['entry', '--item', 'IS-1', '--json'])).json();
  ok(wf(p.root, ['handoff', 'planner', '--agent', 'p', '--attempt', e.id]));
  const orig = cfgOf(p.root);
  // Names a repo that does not hold `.workflow/` as the adapter repo, and turns the impact analysis off.
  setCfg(p.root, { ...orig, adapterRepo: 'decoy', repos: [...orig.repos, { name: 'decoy', path: p.base, base: 'main' }], impact: { requiredFor: [] } });
  const r = wf(p.root, ['plan', '--file', planFile(p.base), '--attempt', e.id]);
  assert.equal(r.code, 75, r.out);
  assert.match(r.err, /impact analysis is incomplete|no `survey`/);
  // A class the base adapter does not know, invented in the working copy so no work item is `full`.
  setCfg(p.root, { ...orig, classes: { cheap: { use: 'anything' } } });
  const w = wf(p.root, ['plan', '--file', planFile(p.base, { plan: 'x', criteria: [{ id: 'C1', text: 't', uat: 'n/a' }], work: [{ id: 'W1', criteria: ['C1'], class: 'cheap', why: 'x' }] }), '--attempt', e.id]);
  assert.notEqual(w.code, 0, w.out);
  assert.match(w.err, /class `cheap` is not a known class/);
  // The planner switched off in the working copy: a fresh attempt still needs its planner.
  const e2 = ok(wf(p.root, ['entry', '--item', 'IS-2', '--json'])).json();
  setCfg(p.root, { ...orig, roles: { planner: false }, impact: { requiredFor: [] } });
  const n = wf(p.root, ['plan', '--file', planFile(p.base), '--attempt', e2.id]);
  assert.equal(n.code, 75, n.out);
  assert.match(n.err, /needs a planner/);
});

test('adapter at base: an amendment adds only a repo of the base adapter', () => {
  const p = singleRepoProject('addrepo', { gate: { steps }, impact: { requiredFor: [] } });
  const e = ok(wf(p.root, ['entry', '--item', 'AR-1', '--json'])).json();
  ok(wf(p.root, ['handoff', 'planner', '--agent', 'p', '--attempt', e.id]));
  ok(wf(p.root, ['plan', '--file', planFile(p.base), '--attempt', e.id]));
  const secret = makeRepo(path.join(tmp('secret2'), 'vault'), { 'keys/prod.env': 'TOKEN=x\n' });
  const orig = cfgOf(p.root);
  setCfg(p.root, { ...orig, repos: [...orig.repos, { name: 'other', path: secret.dir, base: 'main' }] });
  const amend = planFile(p.base, { criteria: [{ id: 'C2', text: 'other changes', uat: 'n/a' }] });
  const r = wf(p.root, ['criteria', 'amend', '--file', amend, '--reason', 'needs other', '--add-repo', 'other', '--attempt', e.id]);
  assert.notEqual(r.code, 0, r.out);
  assert.match(r.err, /unknown repo `other`/);
  assert.equal(ok(wf(p.root, ['resume', '--attempt', e.id, '--json'])).json().repos.other, undefined);
});

// F4: a linked `.workflow/` pointed "the adapter committed at base" at another committed folder.
test('adapter location: a .workflow link to another committed folder is refused, and a link retargeted after admission is refused', () => {
  const weak = { version: 1, enabled: true, name: 'weak-example', repos: [{ name: 'app', path: '.', base: 'main' }], lanes: ['quick', 'standard'], gate: { steps: [{ id: 'unit', repo: 'app', run: 'true' }] }, impact: { requiredFor: [] } };
  const p = singleRepoProject('adloc', { gate: { steps } }, { 'examples/demo/.workflow/project.yaml': JSON.stringify(weak, null, 2) });
  const swap = () => {
    fs.renameSync(path.join(p.root, '.workflow'), path.join(p.base, 'saved-workflow'));
    fs.symlinkSync(path.join(p.root, 'examples', 'demo', '.workflow'), path.join(p.root, '.workflow'));
  };
  const restore = () => {
    fs.rmSync(path.join(p.root, '.workflow'));
    fs.renameSync(path.join(p.base, 'saved-workflow'), path.join(p.root, '.workflow'));
  };
  swap();
  const before = wf(p.root, ['entry', '--item', 'AL-1', '--json']);
  assert.equal(before.code, 75, before.out);
  assert.match(before.err, /is a link to .*examples\/demo\/\.workflow/);
  restore();
  const e = ok(wf(p.root, ['entry', '--item', 'AL-2', '--json'])).json();
  ok(wf(p.root, ['handoff', 'planner', '--agent', 'p', '--attempt', e.id]));
  swap();
  const r = wf(p.root, ['plan', '--file', planFile(p.base), '--attempt', e.id]);
  assert.equal(r.code, 75, r.out);
  assert.match(r.err, /recorded at admission/);
});
