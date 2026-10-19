// Stream 0: the shared 0.8 fixtures do what their comments say, so the streams can build on them.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { YAML, makeProject, git, fakeTracker, writeTrackerModule, transcript, reviewerTranscript, writeLegacyLedgers, STORY, EXPECTED, canonical, ledgerLines, writeDoubles, withDoubles } from './helpers/index.mjs';
import { runTests, canonicalJson } from '../engine/contract.mjs';
import crypto from 'node:crypto';

test('makeProject: two repos on their own bases with remotes, and a schema 2 adapter', (t) => {
  const p = makeProject();
  t.after(p.cleanup);
  assert.deepEqual(Object.keys(p.repos), ['server', 'client']);
  assert.equal(git(p.repos.server.dir, ['rev-parse', '--abbrev-ref', 'HEAD']), 'trunk');
  assert.equal(git(p.repos.client.dir, ['rev-parse', '--abbrev-ref', 'HEAD']), 'stable');
  assert.equal(git(p.repos.server.dir, ['rev-parse', 'origin/trunk']), p.head('server'));
  const raw = YAML.parse(fs.readFileSync(p.adapterFile, 'utf8'));
  assert.equal(raw.version, 2);
  assert.equal(p.adapterFile, path.join(p.root, '.workflow', 'project.yaml'));
  const moved = p.pushElsewhere('server', { 'other.txt': 'x\n' });
  git(p.repos.server.dir, ['fetch', '--quiet']);
  assert.equal(git(p.repos.server.dir, ['rev-parse', 'origin/trunk']), moved);
  const user = makeProject({ location: 'user' });
  t.after(user.cleanup);
  assert.ok(user.adapterFile.startsWith(user.env.WF_USER_DIR));
  assert.equal(YAML.parse(fs.readFileSync(user.adapterFile, 'utf8')).root, user.root);
});

test('fake tracker: search before write, markers required, unreadable labels read as null, module form', async (t) => {
  const p = makeProject({ adapter: false });
  t.after(p.cleanup);
  const tr = await fakeTracker(path.join(p.tmp, 'tracker.json'));
  assert.equal(await tr.driver.normalise('tk7'), 'TK-7');
  assert.equal((await tr.driver.read('TK-3')).labels, null);
  assert.deepEqual((await tr.driver.read('TK-2')).labels, ['urgent']);
  assert.deepEqual(await tr.driver.search({ marker: 'wf:TK-1.1:finding:F1' }), []);
  await assert.rejects(tr.driver.create({ title: 'x', body: 'no marker', marker: 'wf:TK-1.1:finding:F1' }), /marker/);
  const { id } = await tr.driver.create({ title: 'Found', body: 'details wf:TK-1.1:finding:F1', marker: 'wf:TK-1.1:finding:F1' });
  assert.equal(id, 'TK-4');
  assert.equal((await tr.driver.search({ marker: 'wf:TK-1.1:finding:F1' }))[0].id, 'TK-4');
  assert.deepEqual(tr.log(), ['read TK-3', 'read TK-2', 'search marker wf:TK-1.1:finding:F1', 'create TK-4 wf:TK-1.1:finding:F1', 'search marker wf:TK-1.1:finding:F1']);
  const file = writeTrackerModule(p.repos.server.dir, '.workflow/tracker.mjs', path.join(p.tmp, 'tracker2.json'));
  const mod = (await import(file)).default;
  await mod.setStatus('TK-1', 'Started');
  assert.equal((await mod.read('TK-1')).status, 'Started');
});

test('transcript fixture: Claude Code layout, reads, human turns, notifications, panel answers', (t) => {
  const p = makeProject({ adapter: false });
  t.after(p.cleanup);
  const tr = transcript({ home: p.home, cwd: p.root, session: 'abcdef12-0000-4000-8000-000000000000' });
  tr.human('start').advance(5).read('/x/a.mjs').notification('tests done').meta('injected').ask('Deploy?', ['yes', 'no']).panelAnswer('Deploy?', 'yes').advance(40).human('yes').queued('also this');
  const file = tr.write();
  assert.ok(file.startsWith(path.join(p.home, '.claude', 'projects')));
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(lines.filter((l) => l.message?.content?.[0]?.name === 'Read').length, 1);
  assert.ok(lines.some((l) => l.isMeta));
  assert.ok(lines.some((l) => l.toolUseResult?.answers?.['Deploy?'] === 'yes'));
  assert.equal(lines.at(-2).timestamp, '2026-01-05T09:45:00.000Z');
  assert.equal(lines.at(-1).attachment.origin.kind, 'human');
  const r = reviewerTranscript({ home: p.home, cwd: p.root, files: ['/x/1', '/x/2'], skip: ['/x/2'] });
  assert.equal(r.session.runtime, 'claude');
  assert.ok(fs.readFileSync(r.file, 'utf8').includes('/x/1') && !fs.readFileSync(r.file, 'utf8').includes('"/x/2"'));
});

test('0.7 ledgers: hash-chained as 0.7 wrote them, with a batch and held/open attempts', (t) => {
  const p = makeProject({ adapter: false });
  t.after(p.cleanup);
  const ids = writeLegacyLedgers(p.root);
  assert.deepEqual(ids, Object.keys(STORY));
  for (const id of ids) {
    let prev = null;
    for (const e of ledgerLines(p.root, id)) {
      const { hash, ...rest } = e;
      assert.equal(e.prev, prev);
      assert.equal(hash, crypto.createHash('sha256').update(canonical(rest)).digest('hex'));
      prev = hash;
    }
  }
  assert.equal(canonical({ b: [undefined], a: 1 }), canonicalJson({ b: [undefined], a: 1 }));
  assert.deepEqual(ledgerLines(p.root, 'BATCH-1')[1].data.members, ['TK-1.1', 'TK-2.1']);
  assert.ok(EXPECTED.held.every((id) => ledgerLines(p.root, id).some((e) => e.type === 'hold')));
});

test('doubles reach a facade in-process; writeDoubles writes a module a spawned wf can load', async (t) => {
  const p = makeProject({ adapter: false });
  t.after(p.cleanup);
  const r = await withDoubles({ runTests: async () => ({ pass: false, tree: 't', ms: 0, exitCode: 1, log: '' }) }, () => runTests(p.root, 'TK-1.1', 'server', 'fast'));
  assert.equal(r.pass, false);
  const file = writeDoubles(p, 'tests', `runTests: async () => ({ pass: true })`);
  assert.equal(typeof (await import(file)).default.runTests, 'function');
});
