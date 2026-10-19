// Stream 7: onboarding owns the policy keys; it shows a per-key diff, writes only what is confirmed, never overwrites a hand
// edit silently, and a re-run with nothing to change writes nothing.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { commandHandler } from '../engine/contract.mjs';
import { policyHash } from '../engine/onboard.mjs';
import { MODULE_REPOS, clearDoubles, ctxFor, ledgerDoubles, readAdapter, useDoubles } from './onboard-fixture.mjs';
import { YAML, makeProject } from './helpers/index.mjs';

const init = (p, flags = {}) => commandHandler('init')(ctxFor(p), { _: [], flags });
// The module fixture's repos, with no 0.7 adapter: a fresh onboarding.
const fresh = () => makeProject({ name: 'fresh', repos: MODULE_REPOS, adapter: false });

test('init without --confirm shows the proposal, how to hand back a draft, and writes nothing', async () => {
  const p = fresh();
  useDoubles(ledgerDoubles());
  try {
    const r = await init(p);
    assert.equal(fs.existsSync(path.join(p.root, '.workflow', 'project.yaml')), false);
    assert.match(r.text, /risk\.tally: unset → .*core\/src\/modules\/tally/);
    assert.match(r.text, /why: money computed: decimal-type core\/src\/modules\/tally\/total\.mjs:1/);
    assert.match(r.text, /tests\.core: unset → .*npm run lint && npm run test/);
    assert.match(r.text, /--draft <file>/);
    assert.match(r.text, /"diffRead": "before" \| "after"/);
    const keys = r.data.diff.changes.map((c) => c.key);
    for (const k of ['risk.tally', 'risk.relay', 'risk.access', 'risk.migrations', 'review.diffRead', 'delivery.stages', 'tests.core', 'tests.panel']) assert.ok(keys.includes(k), k);
    assert.ok(!keys.includes('risk.notes'));
  } finally {
    clearDoubles();
    p.cleanup();
  }
});

test('confirm all writes the adapter with hashes and a budget; a re-run on the unchanged project writes nothing', async () => {
  const p = fresh();
  useDoubles(ledgerDoubles());
  try {
    const w = await init(p, { confirm: ['all'] });
    const file = path.join(p.root, '.workflow', 'project.yaml');
    assert.equal(w.data.written.written, true);
    const a = readAdapter(file);
    assert.equal(a.version, 2);
    assert.deepEqual(a.repos.map((r) => [r.name, r.base]), [['core', 'trunk'], ['handset', 'dev'], ['panel', 'release']]);
    assert.deepEqual(a.risk.map((x) => x.id).sort(), ['access', 'migrations', 'relay', 'tally']);
    assert.equal(a.review.diffRead, 'before');
    assert.equal(a.onboarded.hashes.risk, policyHash(a.risk.map((x) => ({ id: x.id, paths: x.paths, reason: x.reason, tests: x.tests }))));
    assert.equal(a.budget.adapter.risk, 4);
    const bytes = fs.readFileSync(file, 'utf8');
    const again = await init(p);
    assert.deepEqual(again.data.diff.changes, []);
    assert.match(again.text, /Nothing to change; nothing written\./);
    const confirmed = await init(p, { confirm: ['all'] });
    assert.equal(confirmed.data.written.written, false);
    assert.equal(fs.readFileSync(file, 'utf8'), bytes);
  } finally {
    clearDoubles();
    p.cleanup();
  }
});

test('a hand-edited key is shown first, kept by `--confirm all`, and adopted only when its key is confirmed', async () => {
  const p = fresh();
  useDoubles(ledgerDoubles());
  try {
    await init(p, { confirm: ['all'] });
    const file = path.join(p.root, '.workflow', 'project.yaml');
    const edited = fs.readFileSync(file, 'utf8').replace('diffRead: before', 'diffRead: after');
    fs.writeFileSync(file, edited);
    const r = await init(p);
    assert.equal(r.data.diff.changes[0].key, 'review.diffRead');
    assert.equal(r.data.diff.changes[0].handEdited, true);
    assert.match(r.text, /Edited by hand since onboarding wrote them[^]*review\.diffRead: now after/);
    const all = await init(p, { confirm: ['all'] });
    assert.equal(all.data.written.written, false);
    assert.equal(fs.readFileSync(file, 'utf8'), edited);
    const adopt = await init(p, { confirm: ['review.diffRead'] });
    assert.equal(adopt.data.written.written, true);
    const a = readAdapter(file);
    assert.equal(a.review.diffRead, 'after');
    assert.equal(a.onboarded.hashes['review.diffRead'], policyHash('after'));
    assert.deepEqual((await init(p)).data.diff.changes, []);
  } finally {
    clearDoubles();
    p.cleanup();
  }
});

test('a draft risk path must guard existing files and cite scanned files; a valid draft is proposed per key', async () => {
  const p = fresh();
  useDoubles(ledgerDoubles());
  try {
    const bad = path.join(p.tmp, 'bad.json');
    fs.writeFileSync(bad, JSON.stringify({ risk: [{ id: 'ghost', paths: ['core/src/nowhere/**'], reason: 'it feels risky', tests: ['core/test/**'] }] }));
    await assert.rejects(init(p, { draft: bad }), /match no file in the scan[^]*cites no scanned file/);
    const good = path.join(p.tmp, 'good.yaml');
    fs.writeFileSync(good, YAML.stringify({ risk: [{ id: 'sums', paths: ['core/src/modules/tally/**'], reason: 'computes amounts in core/src/modules/tally/total.mjs', tests: ['core/test/tally/**'] }], review: { diffRead: 'after' } }));
    const r = await init(p, { draft: good, confirm: ['all'] });
    const a = readAdapter(r.data.written.file);
    assert.deepEqual(a.risk.map((x) => x.id), ['sums']);
    assert.equal(a.review.diffRead, 'after');
  } finally {
    clearDoubles();
    p.cleanup();
  }
});

test('a confirm naming no proposed key is refused; the risk budget holds areas back and says which', async () => {
  const p = fresh();
  useDoubles(ledgerDoubles());
  try {
    await assert.rejects(init(p, { confirm: ['risk.nope'] }), /no proposed change for `risk\.nope`/);
    await init(p, { confirm: ['risk.tally', 'review', 'delivery', 'tests'] });
    const file = path.join(p.root, '.workflow', 'project.yaml');
    const a = readAdapter(file);
    assert.deepEqual(a.risk.map((x) => x.id), ['tally']);
    assert.equal(a.budget.adapter.risk, 1);
    const r = await init(p);
    assert.deepEqual(r.data.diff.overBudget.map((x) => x.id).sort(), ['access', 'migrations', 'relay']);
    assert.match(r.text, /Not proposed, over the adapter's risk budget/);
    assert.ok(!r.data.diff.changes.some((c) => c.key.startsWith('risk')));
  } finally {
    clearDoubles();
    p.cleanup();
  }
});

test('onboarding cannot finish while risk is unconfirmed', async () => {
  const p = fresh();
  useDoubles(ledgerDoubles());
  try {
    await assert.rejects(init(p, { confirm: ['review.diffRead'] }), /`risk` is unconfirmed/);
    assert.equal(fs.existsSync(path.join(p.root, '.workflow', 'project.yaml')), false);
  } finally {
    clearDoubles();
    p.cleanup();
  }
});

test('a user-folder adapter is written with root and committed in its own history', async () => {
  const p = fresh();
  useDoubles(ledgerDoubles());
  try {
    const r = await init(p, { confirm: ['all'], location: 'user' });
    const file = path.join(p.env.WF_USER_DIR, 'projects', 'root.yaml');
    assert.equal(r.data.written.file, file);
    assert.equal(readAdapter(file).root, p.root);
    const log = (await import('node:child_process')).spawnSync('git', ['log', '--oneline'], { cwd: path.dirname(file), encoding: 'utf8' });
    assert.match(log.stdout, /onboarding/);
  } finally {
    clearDoubles();
    p.cleanup();
  }
});

test('doctor names instruction lines with removed commands and the hand edits', async () => {
  const p = fresh();
  useDoubles(ledgerDoubles());
  try {
    await init(p, { confirm: ['all'] });
    const file = path.join(p.root, '.workflow', 'project.yaml');
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('diffRead: before', 'diffRead: after'));
    const d = await commandHandler('doctor')(ctxFor(p), { _: [], flags: {} });
    assert.match(d.text, /core\/AGENTS\.md:3 names wf batch/);
    assert.doesNotMatch(d.text, /wf status/);
    assert.match(d.text, /hand edits: edited by hand since onboarding wrote them: review\.diffRead/);
    assert.match(d.text, /steps\/runner\.mjs|✓ adapter/);
  } finally {
    clearDoubles();
    p.cleanup();
  }
});
