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
    assert.match(r.text, /tests\.core: unset → .*npm run lint && npm run test/);
    assert.match(r.text, /--draft <file>/);
    assert.match(r.text, /"diffRead": "before" \| "after"/);
    const keys = r.data.diff.changes.map((c) => c.key);
    for (const k of ['review.diffRead', 'delivery.stages', 'tests.core', 'tests.panel']) assert.ok(keys.includes(k), k);
    // No risk paths, however much money, external writes or access code the repos hold: reviewers judge each change.
    assert.ok(!keys.some((k) => k.startsWith('risk')), keys.join(', '));
    assert.doesNotMatch(r.text, /risk path|money computed|"risk"/);
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
    assert.equal(a.risk, undefined);
    assert.equal(a.review.diffRead, 'before');
    assert.equal(a.onboarded.hashes['review.diffRead'], policyHash('before'));
    assert.deepEqual(Object.keys(a.budget.adapter).sort(), ['modules', 'operationWords', 'rules']);
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

test('a draft is proposed per key; it may say the project has no screens', async () => {
  const p = fresh();
  useDoubles(ledgerDoubles());
  try {
    const good = path.join(p.tmp, 'good.yaml');
    fs.writeFileSync(good, YAML.stringify({ screens: 'none', review: { diffRead: 'after' } }));
    const r = await init(p, { draft: good, confirm: ['all'] });
    const a = readAdapter(r.data.written.file);
    assert.equal(a.screens, 'none');
    assert.equal(a.review.diffRead, 'after');
  } finally {
    clearDoubles();
    p.cleanup();
  }
});

test('a confirm naming no proposed key is refused', async () => {
  const p = fresh();
  useDoubles(ledgerDoubles());
  try {
    await assert.rejects(init(p, { confirm: ['risk.nope'] }), /no proposed change for `risk\.nope`/);
    assert.equal(fs.existsSync(path.join(p.root, '.workflow', 'project.yaml')), false);
  } finally {
    clearDoubles();
    p.cleanup();
  }
});

test('onboarding finishes with what the person confirms: nothing is required, screens included', async () => {
  const p = fresh();
  useDoubles(ledgerDoubles());
  try {
    const w = await init(p, { confirm: ['review.diffRead'] });
    assert.equal(w.data.written.written, true);
    const a = readAdapter(path.join(p.root, '.workflow', 'project.yaml'));
    assert.equal(a.screens?.capture, undefined);
    // Doctor notes it once, as a fact, not a failure.
    const d = await commandHandler('doctor')(ctxFor(p), { _: [], flags: {} });
    assert.equal(d.data.checks.filter((c) => c.check === 'screens').length, 1);
    assert.deepEqual(d.data.checks.find((c) => c.check === 'screens'), { level: 'ok', check: 'screens', detail: 'none: no capture command, so no screens are captured', fix: null });
    assert.ok(!d.data.checks.some((c) => c.check === 'risk'));
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
    // A capture with no routes module: only a shared path captures screens, and doctor says so.
    const y = YAML.parse(fs.readFileSync(file, 'utf8'));
    y.screens = { ...(y.screens ?? {}), capture: { run: 'true {out}' } };
    delete y.screens.routes;
    fs.writeFileSync(file, YAML.stringify(y));
    const d2 = await commandHandler('doctor')(ctxFor(p), { _: [], flags: {} });
    assert.match(d2.text, /screens: `screens\.routes` is unset/);
  } finally {
    clearDoubles();
    p.cleanup();
  }
});
