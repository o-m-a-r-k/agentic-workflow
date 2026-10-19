// Fixer C (config side of M8, decision 2, L9, L12): the adapter's tracker operations are the engine's one list,
// `screens.capture` is a command or a module, an unchanged user-folder adapter is read without git, and the secrets
// catalogue lives beside the adapter wherever the adapter lives.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { checkAdapter, commandHandler, loadAdapter } from '../engine/contract.mjs';
import { secretsCatalogFile } from '../engine/config.mjs';
import { adapterFor, makeProject, YAML } from './helpers/index.mjs';

const with_ = (overrides) => adapterFor({ overrides });

test('ticketing.operations: the engine\'s operation names; the dead and renamed ones are refused', async () => {
  for (const op of ['read', 'search', 'fileFollowUp', 'setStatus', 'comment', 'mergeRequest']) assert.deepEqual(await checkAdapter(with_({ ticketing: { via: 'connector', tracker: 'board', operations: { [op]: 'words' } } })), [], op);
  for (const op of ['readIssue', 'attach', 'readBack']) {
    const problems = await checkAdapter(with_({ ticketing: { via: 'connector', tracker: 'board', operations: { [op]: 'words' } } }));
    assert.ok(problems.some((x) => x.startsWith(`ticketing.operations.${op}: unknown key`)), `${op}: ${problems}`);
  }
});

test('screens.capture: a command (a plain string means the same) or a module, normalised to { run } or { module }', async (t) => {
  const screens = (capture) => ({ screens: { ...adapterFor().screens, capture } });
  assert.deepEqual(await checkAdapter(with_(screens({ run: 'cap --out {out} {routes}' }))), []);
  assert.deepEqual(await checkAdapter(with_(screens({ module: { repo: 'client', path: 'scripts/capture.mjs' } }))), []);
  const both = await checkAdapter(with_(screens({ run: 'cap {out}', module: { repo: 'client', path: 'x.mjs' } })));
  assert.ok(both.some((x) => /^screens\.capture: needs exactly one of `run` and `module`/.test(x)), both.join('; '));
  assert.ok((await checkAdapter(with_(screens({ module: { repo: 'nowhere', path: 'x.mjs' } })))).some((x) => /^screens\.capture\.module\.repo: `nowhere` is not a listed repo/.test(x)));
  assert.ok((await checkAdapter(with_(screens({ run: 'cap {size}' })))).some((x) => /^screens\.capture: unknown placeholder \{size\}/.test(x)));
  assert.ok((await checkAdapter(with_(screens(7)))).some((x) => /^screens\.capture: must be \{ run: <command> \} or \{ module: \{ repo, path \} \}/.test(x)));

  const p = makeProject();
  t.after(p.cleanup);
  assert.deepEqual((await loadAdapter(p.root, { env: p.env })).screens.capture, { run: 'node capture.mjs --out {out} --viewport {viewport} --lang {lang} {routes}' });
  const raw = YAML.parse(fs.readFileSync(p.adapterFile, 'utf8'));
  raw.screens.capture = { module: { repo: 'client', path: 'scripts/capture.mjs' } };
  fs.writeFileSync(p.adapterFile, YAML.stringify(raw));
  const a = await loadAdapter(p.root, { env: p.env });
  assert.deepEqual(a.screens.capture, { module: { repo: 'client', path: 'scripts/capture.mjs' } });
  // A capture module counts against the adapter's module budget like any other.
  const { adapterBudget } = await import('../engine/contract.mjs');
  assert.equal((await adapterBudget(a)).counts.modules, 3);
});

test('loadAdapter: reading an unchanged user-folder adapter spawns no git (L9)', async (t) => {
  const p = makeProject({ location: 'user' });
  t.after(p.cleanup);
  await loadAdapter(p.root, { env: p.env });
  const before = process.env.PATH;
  process.env.PATH = path.join(p.tmp, 'no-tools');
  try {
    assert.equal((await loadAdapter(p.root, { env: p.env })).name, 'sample');
  } finally {
    process.env.PATH = before;
  }
  // A changed file is still committed.
  const raw = YAML.parse(fs.readFileSync(p.adapterFile, 'utf8'));
  raw.review.diffRead = 'after';
  fs.writeFileSync(p.adapterFile, YAML.stringify(raw));
  await loadAdapter(p.root, { env: p.env });
  const { spawnSync } = await import('node:child_process');
  assert.equal(spawnSync('git', ['rev-list', '--count', 'HEAD'], { cwd: path.dirname(p.adapterFile), encoding: 'utf8' }).stdout.trim(), '2');
});

test('the secrets catalogue lives beside a user-folder adapter, and does not pass for a second adapter (L12)', async (t) => {
  const p = makeProject({ location: 'user' });
  t.after(p.cleanup);
  const catalog = path.join(path.dirname(p.adapterFile), 'sample.secrets.yaml');
  fs.writeFileSync(catalog, YAML.stringify({ keys: [{ key: 'SAMPLE_TOKEN', purpose: 'reach the sample service', required: true }] }));
  const a = await loadAdapter(p.root, { env: p.env });
  assert.equal(secretsCatalogFile(a), catalog);
  const r = await commandHandler('secrets')({ cwd: p.root, root: p.root, env: { ...process.env, ...p.env }, actor: null }, { _: ['check'], flags: {} });
  assert.deepEqual(r.data.rows.map((x) => [x.key, x.state]), [['SAMPLE_TOKEN', 'missing']]);
  assert.equal(r.exitCode, 1);
  // A repo adapter keeps it in its own folder.
  const q = makeProject();
  t.after(q.cleanup);
  assert.equal(secretsCatalogFile(await loadAdapter(q.root, { env: q.env })), path.join(fs.realpathSync(q.root), '.workflow', 'secrets.yaml'));
});
