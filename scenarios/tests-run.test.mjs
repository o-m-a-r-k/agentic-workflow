// Stream 2: `wf test` runs one repo's fast, full or risk-base tests on the attempt's tree and records `test.run` against
// the tree the tests ran on; a machine-wide counted lock is shared by every project on the machine.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { commandHandler, runTests, worktreeDir } from '../engine/contract.mjs';
import { git } from './helpers/index.mjs';
import { change, done, eventsOf, fixture, read, startAttempt, useDoubles } from './tests-doubles.mjs';

const node = (code) => `node -e ${JSON.stringify(code)}`;

test('a fast run records exit code, minutes and the tree the tests ran on, uncommitted edits included', async () => {
  const p = fixture({ repoOverrides: { server: { tests: { fast: { run: node('console.log("ran in", process.cwd()); process.exit(0)') } } } } });
  try {
    useDoubles(p);
    startAttempt(p, 'TK-1.1');
    const wt = change(p, 'TK-1.1', 'server', { 'src/core/sum.mjs': 'export const sum = 1;\n' }, { commit: false });
    const r = await runTests(p.root, 'TK-1.1', 'server', 'fast');
    assert.equal(r.pass, true);
    assert.equal(r.exitCode, 0);
    const [run] = eventsOf(p, 'test.run', 'TK-1.1');
    assert.deepEqual({ repo: run.repo, kind: run.kind, pass: run.pass, exitCode: run.exitCode, source: run.source }, { repo: 'server', kind: 'fast', pass: true, exitCode: 0, source: 'attempt' });
    assert.ok(Number.isFinite(run.ms) && run.ms >= 0);
    assert.match(read(run.log), new RegExp(`ran in ${wt.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    assert.ok(run.log.startsWith(path.join(p.root, '.wf-evidence', 'attempts', 'TK-1.1', 'tests')));
    // Committing the tested files gives HEAD exactly the recorded tree.
    git(wt, ['add', '-A']);
    git(wt, ['commit', '--quiet', '-m', 'fix']);
    assert.equal(run.tree, git(wt, ['rev-parse', 'HEAD^{tree}']));
  } finally {
    done(p);
  }
});

test('a failing command is recorded as failed with its exit code', async () => {
  const p = fixture({ repoOverrides: { server: { tests: { fast: { run: node('process.exit(3)') } } } } });
  try {
    useDoubles(p);
    startAttempt(p, 'TK-1.1');
    const r = await runTests(p.root, 'TK-1.1', 'server', 'fast');
    assert.deepEqual({ pass: r.pass, exitCode: r.exitCode }, { pass: false, exitCode: 3 });
    assert.equal(eventsOf(p, 'test.run')[0].pass, false);
  } finally {
    done(p);
  }
});

test('a module test is loaded from its repo\'s fetched base and called with the run context', async () => {
  const p = fixture({ repoOverrides: { server: { tests: { full: { module: { repo: 'client', path: 'steps/suite.mjs' } } } } } });
  try {
    useDoubles(p);
    p.commit('client', { 'steps/suite.mjs': 'export default async (ctx) => ({ pass: false, log: `ctx ${ctx.kind} ${ctx.repo} ${ctx.attempt} ${ctx.cwd}` });\n' }, 'runner', { push: true });
    startAttempt(p, 'TK-2.1');
    const r = await runTests(p.root, 'TK-2.1', 'server', 'full');
    assert.equal(r.pass, false);
    assert.equal(r.exitCode, null);
    assert.equal(read(r.log), `ctx full server TK-2.1 ${worktreeDir(p.root, 'TK-2.1', 'server')}`);
  } finally {
    done(p);
  }
});

test('an attempt that edits its runner module to always pass is still judged by the base runner, and fails', async () => {
  const p = fixture({ repoOverrides: { server: { tests: { fast: { module: { repo: 'server', path: 'steps/runner.mjs' } } } } } });
  try {
    useDoubles(p);
    // The base runner executes the ticket's own test file from the worktree.
    p.commit('server', { 'steps/runner.mjs': 'import { spawnSync } from "node:child_process";\nexport default async (ctx) => { const r = spawnSync(process.execPath, ["test/sum.spec.mjs"], { cwd: ctx.cwd, encoding: "utf8" }); return { pass: r.status === 0, log: "base runner " + r.stderr }; };\n' }, 'runner', { push: true });
    startAttempt(p, 'TK-6.1');
    change(p, 'TK-6.1', 'server', {
      'test/sum.spec.mjs': 'console.error("ticket test fails"); process.exit(1);\n',
      'steps/runner.mjs': 'export default async () => ({ pass: true, log: "tampered runner" });\n',
    });
    const r = await runTests(p.root, 'TK-6.1', 'server', 'fast');
    assert.equal(r.pass, false);
    assert.match(read(r.log), /^base runner ticket test fails/);
    assert.equal(eventsOf(p, 'test.run', 'TK-6.1')[0].pass, false);
    // The module ran from the content-addressed cache in the user folder.
    assert.equal(fs.readdirSync(path.join(p.env.WF_USER_DIR, 'modules')).filter((f) => /^[0-9a-f]{40}-[0-9a-f]{12}$/.test(f)).length, 1);
  } finally {
    done(p);
  }
});

test('a base runner imports the helpers beside and below it, and the repo\'s installed packages', async () => {
  const p = fixture({ repoOverrides: { server: { tests: { fast: { module: { repo: 'server', path: 'steps/run/runner.mjs' } } } } } });
  try {
    useDoubles(p);
    p.commit('server', {
      'steps/run/runner.mjs': 'import { verdict } from "./helper.mjs";\nimport { word } from "./lib/words.mjs";\nimport pkg from "fixture-pkg";\nexport default async () => ({ pass: verdict(), log: `${word} ${pkg}` });\n',
      'steps/run/helper.mjs': 'export const verdict = () => true;\n',
      'steps/run/lib/words.mjs': 'export const word = "sibling";\n',
    }, 'runner', { push: true });
    // An installed package in the checkout (ignored by git, as node_modules is).
    fs.mkdirSync(path.join(p.repos.server.dir, 'node_modules', 'fixture-pkg'), { recursive: true });
    fs.writeFileSync(path.join(p.repos.server.dir, 'node_modules', 'fixture-pkg', 'package.json'), '{"name":"fixture-pkg","type":"module","exports":"./index.js"}');
    fs.writeFileSync(path.join(p.repos.server.dir, 'node_modules', 'fixture-pkg', 'index.js'), 'export default "package";\n');
    startAttempt(p, 'TK-8.1');
    const r = await runTests(p.root, 'TK-8.1', 'server', 'fast');
    assert.equal(read(r.log), 'sibling package');
    assert.equal(r.pass, true);
  } finally {
    done(p);
  }
});

test('a runner module missing from the base is an error naming the base', async () => {
  const p = fixture({ repoOverrides: { server: { tests: { fast: { module: { repo: 'server', path: 'steps/new.mjs' } } } } } });
  try {
    useDoubles(p);
    startAttempt(p, 'TK-7.1');
    change(p, 'TK-7.1', 'server', { 'steps/new.mjs': 'export default async () => ({ pass: true });\n' });
    await assert.rejects(runTests(p.root, 'TK-7.1', 'server', 'fast'), /steps\/new\.mjs is not committed on refs\/remotes\/origin\/trunk/);
    assert.equal(eventsOf(p, 'test.run').length, 0);
  } finally {
    done(p);
  }
});

test('the counted lock is machine-wide: two projects with count 1 never overlap, count 2 lets them run together', async () => {
  const runs = async (count) => {
    const a = fixture();
    const b = fixture();
    const marks = path.join(a.tmp, 'marks.log');
    const spec = { run: node(`const fs=require("fs");fs.appendFileSync(${JSON.stringify(marks)},"start "+Date.now()+"\\n");setTimeout(()=>{fs.appendFileSync(${JSON.stringify(marks)},"end "+Date.now()+"\\n")},400)`), lock: { name: 'shared-suite', count } };
    for (const p of [a, b]) p.adapter.repos[0].tests.full = spec;
    const shared = a.env.WF_USER_DIR;
    try {
      // One user folder: the lock lives there, across projects.
      process.env.WF_USER_DIR = shared;
      useDoubles(a);
      startAttempt(a, 'TK-1.1');
      startAttempt(b, 'TK-1.1');
      const { setDoubles } = await import('../engine/contract.mjs');
      setDoubles({
        loadAdapter: async (root) => (root === a.root ? a.adapter : b.adapter),
        attemptState: async (root, id) => (root === a.root ? a : b).states.get(id),
        append: async (root, attempt, type, data) => (root === a.root ? a : b).events.push({ attempt, type, data }),
      });
      await Promise.all([runTests(a.root, 'TK-1.1', 'server', 'full'), runTests(b.root, 'TK-1.1', 'server', 'full')]);
      const lines = read(marks).trim().split('\n').map((l) => l.split(' '));
      const lockA = eventsOf(a, 'test.run')[0].lock;
      assert.deepEqual({ name: lockA.name, count: lockA.count }, { name: 'shared-suite', count });
      assert.equal(fs.readdirSync(path.join(shared, 'locks', 'shared-suite')).length, 0, 'released');
      return lines.map(([k]) => k).join(',');
    } finally {
      done(a);
      done(b);
    }
  };
  assert.equal(await runs(1), 'start,end,start,end');
  assert.equal(await runs(2), 'start,start,end,end');
});

test('a slot whose holder process is gone is taken over', async () => {
  const p = fixture();
  try {
    p.adapter.repos[0].tests.fast = { run: node('process.exit(0)'), lock: { name: 'solo', count: 1 } };
    useDoubles(p);
    startAttempt(p, 'TK-1.1');
    const dir = path.join(p.env.WF_USER_DIR, 'locks', 'solo');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'slot-0.json'), JSON.stringify({ pid: 2 ** 22 + 12345, host: (await import('node:os')).default.hostname() }));
    const r = await runTests(p.root, 'TK-1.1', 'server', 'fast');
    assert.equal(r.pass, true);
  } finally {
    done(p);
  }
});

test('risk-base runs the fast tests at the merge-base with the changed risk tests applied, and records that they fail there', async () => {
  const p = fixture({ repoOverrides: { server: { tests: { fast: { run: 'node test/sum.spec.mjs' } } } } });
  try {
    useDoubles(p);
    startAttempt(p, 'TK-3.1');
    // The fix and a test that only passes with it.
    change(p, 'TK-3.1', 'server', {
      'src/core/sum.mjs': 'export const sum = (xs) => xs.reduce((a, b) => a + b, 0) + 0.5;\n',
      'test/sum.spec.mjs': 'import { sum } from "../src/core/sum.mjs";\nif (sum([1]) !== 1.5) { console.error("wrong"); process.exit(1); }\n',
    });
    const fast = await runTests(p.root, 'TK-3.1', 'server', 'fast');
    assert.equal(fast.pass, true, 'passes on the attempt');
    const base = await runTests(p.root, 'TK-3.1', 'server', 'risk-base');
    assert.equal(base.pass, false, 'fails on the merge-base');
    assert.match(read(base.log), /wrong/);
    const runs = eventsOf(p, 'test.run');
    assert.deepEqual(runs.map((r) => r.kind), ['fast', 'risk-base']);
    assert.equal(runs[1].tree, runs[0].tree, 'recorded against the attempt tree whose tests were applied');
    assert.match(runs[1].mergeBase, /^[0-9a-f]{40}$/, 'the merge-base it ran at');
    assert.equal(runs[0].mergeBase, undefined);
    assert.deepEqual(fs.readdirSync(path.join(p.root, '.wf-evidence', 'attempts', 'TK-3.1', 'tests')).filter((f) => f.startsWith('risk-base-')), [], 'scratch worktree removed');
  } finally {
    done(p);
  }
});

test('risk-base without a changed risk test is an error, not a pass', async () => {
  const p = fixture();
  try {
    useDoubles(p);
    startAttempt(p, 'TK-3.1');
    change(p, 'TK-3.1', 'server', { 'src/core/sum.mjs': 'export const sum = () => 0;\n' });
    await assert.rejects(runTests(p.root, 'TK-3.1', 'server', 'risk-base'), /changes no `risk.tests` file/);
    assert.equal(eventsOf(p, 'test.run').length, 0);
  } finally {
    done(p);
  }
});

test('a tree that changes while the tests run records nothing', async () => {
  const p = fixture({ repoOverrides: { server: { tests: { fast: { run: node('require("fs").writeFileSync("written-by-tests.txt","x")') } } } } });
  try {
    useDoubles(p);
    startAttempt(p, 'TK-1.1');
    await assert.rejects(runTests(p.root, 'TK-1.1', 'server', 'fast'), /changed while its fast tests ran.*written-by-tests\.txt/s);
    assert.equal(eventsOf(p, 'test.run').length, 0);
  } finally {
    done(p);
  }
});

test('wf test finds the attempt and repo from the folder it runs in; risk-base succeeds only when the tests fail', async () => {
  const p = fixture({ repoOverrides: { server: { tests: { fast: { run: 'node test/sum.spec.mjs' } } }, client: { tests: { fast: { run: node('process.exit(0)') } } } } });
  try {
    useDoubles(p);
    startAttempt(p, 'TK-4.1');
    change(p, 'TK-4.1', 'server', { 'test/sum.spec.mjs': 'process.exit(0);\n' });
    const handler = commandHandler('test');
    const ctx = { cwd: path.join(worktreeDir(p.root, 'TK-4.1', 'server'), 'src'), root: p.root, env: {}, actor: null, json: false };
    const fast = await handler(ctx, { _: ['fast'], flags: {} });
    assert.equal(fast.exitCode, 0);
    assert.deepEqual(fast.data.results.map((r) => r.repo), ['server']);
    const rb = await handler(ctx, { _: ['risk-base'], flags: {} });
    assert.equal(rb.exitCode, 1, 'a risk test that passes on the merge-base proves nothing');
    assert.match(rb.text, /PASS on the merge-base/);
    const all = await handler({ ...ctx, cwd: p.root }, { _: ['fast'], flags: { attempt: 'TK-4.1' } });
    assert.deepEqual(all.data.results.map((r) => r.repo), ['server', 'client']);
    await assert.rejects(handler({ ...ctx, cwd: p.root }, { _: ['fast'], flags: {} }), /which attempt/);
  } finally {
    done(p);
  }
});
