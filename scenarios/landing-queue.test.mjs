// Stream 2: the landing queue. Ready attempts are squashed onto the fetched base in order, `full` runs once, green pushes;
// red bisects to the ticket that broke it, returns that one and lands the rest. Nothing waits for an unready ticket.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { commandHandler, land } from '../engine/contract.mjs';
import { DEFAULT_REPOS, git } from './helpers/index.mjs';
import { change, done, eventsOf, fixture, read, startAttempt, useDoubles } from './tests-doubles.mjs';

// `full` fails while any tracked file says BROKEN.
const CHECK = 'const { execSync } = require("child_process"); const bad = execSync("git grep -l -e BROK[E]N -- . || true").toString().trim(); if (bad) { console.error("broken by " + bad); process.exit(1); } console.log("green");';
const SERVER = { ...DEFAULT_REPOS[0], files: { ...DEFAULT_REPOS[0].files, 'check.js': CHECK } };

function project({ race } = {}) {
  const p = fixture({ repos: [SERVER, DEFAULT_REPOS[1]] });
  const full = { run: race ? `node check.js && node ${race}` : 'node check.js', lock: { name: 'fixture-suite', count: 1 } };
  p.adapter.repos[0].tests.full = full;
  p.adapter.delivery.landing = 'queue';
  useDoubles(p);
  return p;
}

const remoteLog = (p) => git(p.repos.server.origin, ['log', '--format=%s%n%b', p.repos.server.base]);
const remoteFiles = (p) => git(p.repos.server.origin, ['ls-tree', '-r', '--name-only', p.repos.server.base]).split('\n');

function three(p, broken = null) {
  for (const n of [1, 2, 3]) {
    const a = `TK-${n}.1`;
    startAttempt(p, a, ['server']);
    change(p, a, 'server', { [`src/f${n}.mjs`]: n === broken ? '// BROKEN\n' : `export const f${n} = ${n};\n` }, { message: `add f${n}` });
  }
  return ['TK-1.1', 'TK-2.1', 'TK-3.1'];
}

test('green: the ready tickets are stacked in order, full runs once on the stack, and the stack is pushed', async () => {
  const p = project();
  try {
    const ids = three(p);
    const r = await land(p.root, ids);
    assert.deepEqual(r.failed, []);
    assert.deepEqual(r.landed.map((l) => l.attempt), ids);
    assert.match(remoteLog(p), /TK-3: add f3[\s\S]*Wf-Attempt: TK-3\.1[\s\S]*TK-2: add f2[\s\S]*TK-1: add f1/);
    const tip = git(p.repos.server.origin, ['rev-parse', `${p.repos.server.base}`]);
    assert.equal(r.landed[2].sha, tip);
    const runs = p.events.filter((e) => e.type === 'test.run');
    assert.deepEqual(runs.map((e) => e.attempt), ids, 'one full run, recorded on every ticket it contains');
    for (const { data } of runs) {
      assert.deepEqual({ kind: data.kind, source: data.source, pass: data.pass }, { kind: 'full', source: 'landing', pass: true });
      assert.equal(data.tree, git(p.repos.server.origin, ['rev-parse', `${p.repos.server.base}^{tree}`]), 'the landed tree');
    }
    for (const a of ids) {
      const [l] = eventsOf(p, 'landing', a);
      assert.equal(l.result, 'landed');
      assert.deepEqual(l.attempts, ids);
      assert.equal(l.bisects, 0);
    }
    assert.equal(fs.existsSync(path.join(p.root, '.wf-worktrees', '.landing')) && fs.readdirSync(path.join(p.root, '.wf-worktrees', '.landing')).length, 0, 'landing worktree removed');
  } finally {
    done(p);
  }
});

test('red: bisect finds the ticket that broke full, returns it with its log, and lands the rest', async () => {
  const p = project();
  try {
    const ids = three(p, 2);
    const r = await land(p.root, ids);
    assert.deepEqual(r.landed.map((l) => l.attempt), ['TK-1.1', 'TK-3.1']);
    assert.equal(r.failed.length, 1);
    assert.equal(r.failed[0].attempt, 'TK-2.1');
    assert.match(read(r.failed[0].log), /broken by src\/f2\.mjs/);
    const files = remoteFiles(p);
    assert.ok(files.includes('src/f1.mjs') && files.includes('src/f3.mjs') && !files.includes('src/f2.mjs'));
    const [ret] = eventsOf(p, 'landing', 'TK-2.1');
    assert.equal(ret.result, 'returned');
    assert.equal(ret.sha, git(p.repos.server.dir, ['rev-parse', 'wf/TK-2.1']), 'the returned branch tip');
    assert.ok(ret.bisects >= 1);
    const [ok] = eventsOf(p, 'landing', 'TK-3.1');
    assert.equal(ok.result, 'landed');
    // The landed tree has its own passing full run.
    const lastPass = eventsOf(p, 'test.run', 'TK-3.1').filter((t) => t.pass).pop();
    assert.equal(lastPass.tree, git(p.repos.server.origin, ['rev-parse', `${p.repos.server.base}^{tree}`]));
  } finally {
    done(p);
  }
});

test('nothing waits for a ticket that is not ready, and a ticket with a merge problem other than merge:untested is not landed', async () => {
  const p = project();
  try {
    three(p);
    p.facts.set('TK-1.1', [{ id: 'merge:untested', message: 'no passing full run on the landed tree' }]);
    p.facts.set('TK-3.1', [{ id: 'merge:open', message: 'F1 is open' }]);
    const r = await land(p.root, ['TK-1.1', 'TK-3.1']);
    assert.deepEqual(r.landed.map((l) => l.attempt), ['TK-1.1']);
    assert.deepEqual(r.failed.map((f) => [f.attempt, f.reason]), [['TK-3.1', 'merge:open: F1 is open']]);
    assert.ok(!remoteFiles(p).includes('src/f2.mjs'), 'the unready ticket is untouched');
    assert.equal(eventsOf(p, 'landing', 'TK-2.1').length, 0);
  } finally {
    done(p);
  }
});

test('a base that already fails blames no ticket and pushes nothing', async () => {
  const p = project();
  try {
    const ids = three(p);
    const broken = p.pushElsewhere('server', { 'src/base.mjs': '// BROKEN\n' });
    const r = await land(p.root, ids);
    assert.deepEqual(r.landed, []);
    assert.deepEqual(r.failed.map((f) => f.attempt), ids);
    assert.match(r.failed[0].reason, /already fails on trunk/);
    assert.equal(git(p.repos.server.origin, ['rev-parse', p.repos.server.base]), broken);
    assert.deepEqual(eventsOf(p, 'landing').map((l) => l.result), ['failed', 'failed', 'failed']);
  } finally {
    done(p);
  }
});

test('a ticket that conflicts with the ones before it is not landed; the others are', async () => {
  const p = project();
  try {
    for (const [n, v] of [[1, 'a'], [2, 'b']]) {
      startAttempt(p, `TK-${n}.1`, ['server']);
      change(p, `TK-${n}.1`, 'server', { 'src/core/sum.mjs': `export const sum = "${v}";\n` });
    }
    const r = await land(p.root, ['TK-1.1', 'TK-2.1']);
    assert.deepEqual(r.landed.map((l) => l.attempt), ['TK-1.1']);
    assert.equal(r.failed[0].attempt, 'TK-2.1');
    assert.match(r.failed[0].reason, /conflicts with trunk and TK-1\.1/);
    assert.match(read(r.failed[0].log), /CONFLICT/);
  } finally {
    done(p);
  }
});

test('a base that moves during the run is fetched again; the stack is rebuilt, retested and pushed on top', async () => {
  const marker = path.join(fs.mkdtempSync(path.join((await import('node:os')).tmpdir(), 'wf08-race-')), 'moved');
  const race = path.join(path.dirname(marker), 'race.mjs');
  const p = project({ race });
  try {
    fs.writeFileSync(race, `import fs from 'node:fs'; import { execFileSync } from 'node:child_process';
if (!fs.existsSync(${JSON.stringify(marker)})) {
  fs.writeFileSync(${JSON.stringify(marker)}, '1');
  const other = ${JSON.stringify(path.join(p.tmp, 'racer'))};
  const g = (...a) => execFileSync('git', ['-c', 'user.name=r', '-c', 'user.email=r@example.test', ...a]);
  g('clone', '--quiet', '--branch', 'trunk', ${JSON.stringify(p.repos.server.origin)}, other);
  fs.writeFileSync(other + '/src/other.mjs', 'export const o = 1;\\n');
  g('-C', other, 'add', '-A'); g('-C', other, 'commit', '--quiet', '-m', 'someone else'); g('-C', other, 'push', '--quiet', 'origin', 'trunk');
}
`);
    const ids = three(p);
    const r = await land(p.root, ids);
    assert.deepEqual(r.landed.map((l) => l.attempt), ids);
    assert.match(remoteLog(p), /TK-1: add f1[\s\S]*someone else/);
    assert.ok(remoteFiles(p).includes('src/other.mjs'));
    const trees = new Set(eventsOf(p, 'test.run', 'TK-1.1').map((t) => t.tree));
    assert.equal(trees.size, 2, 'run again on the rebuilt stack');
  } finally {
    fs.rmSync(path.dirname(marker), { recursive: true, force: true });
    done(p);
  }
});

test('wf land takes the waiting attempts, oldest first, skips one returned until its branch moves, and empties the queue', async () => {
  const p = project();
  try {
    three(p);
    const waiting = (at) => ({ stages: [{ do: 'land' }], stageResults: { 0: { state: 'waiting', at } } });
    Object.assign(p.states.get('TK-1.1'), waiting('2026-01-02T00:00:00Z'));
    Object.assign(p.states.get('TK-3.1'), waiting('2026-01-01T00:00:00Z'));
    Object.assign(p.states.get('TK-2.1'), waiting('2026-01-03T00:00:00Z'));
    p.states.get('TK-2.1').landings.push({ repo: 'server', result: 'returned', sha: git(p.repos.server.dir, ['rev-parse', 'wf/TK-2.1']) });
    const handler = commandHandler('land');
    const ctx = { cwd: p.root, root: p.root, env: {}, actor: null, json: false };
    const r = await handler(ctx, { _: [], flags: {} });
    assert.deepEqual(r.data.landed.map((l) => l.attempt), ['TK-3.1', 'TK-1.1']);
    assert.match(r.text, /^landed TK-3\.1 server /m);
    const again = await handler(ctx, { _: [], flags: {} });
    assert.equal(again.text, 'The landing queue is empty.');
    // A fix moves the returned branch: it is queued again.
    change(p, 'TK-2.1', 'server', { 'src/f2.mjs': 'export const f2 = 22;\n' }, { message: 'fix f2' });
    const fixed = await handler(ctx, { _: [], flags: {} });
    assert.deepEqual(fixed.data.landed.map((l) => l.attempt), ['TK-2.1']);
  } finally {
    done(p);
  }
});
