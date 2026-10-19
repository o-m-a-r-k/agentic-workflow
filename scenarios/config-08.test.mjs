// Stream 6: the schema 2 adapter. Found in a repo or the user folder (never both), checked key by key, normalised with
// every key present, the user-folder copy kept in a git history of its own, and the adapter budget counted.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { YAML, adapterFor, git, makeProject, writeAdapterFile } from './helpers/index.mjs';
import { POLICY_KEYS, WfError, adapterBudget, checkAdapter, findProject, loadAdapter } from '../engine/contract.mjs';

const BUDGET = JSON.parse(fs.readFileSync(new URL('../budget.json', import.meta.url), 'utf8'));

test('findProject: the repo copy from any folder below the root, skipping attempt worktrees; null when there is none', async (t) => {
  const p = makeProject();
  t.after(p.cleanup);
  const here = { root: p.root, file: path.join(p.root, '.workflow', 'project.yaml'), location: 'repo' };
  assert.deepEqual(await findProject(p.root, { env: p.env }), here);
  assert.deepEqual(await findProject(path.join(p.repos.server.dir, 'src', 'core'), { env: p.env }), here);
  const wt = path.join(p.root, '.wf-worktrees', 'TK-1.1', 'server');
  fs.mkdirSync(path.join(wt, '.workflow'), { recursive: true });
  fs.writeFileSync(path.join(wt, '.workflow', 'project.yaml'), 'version: 2\n');
  assert.deepEqual(await findProject(wt, { env: p.env }), here);
  const none = makeProject({ adapter: false });
  t.after(none.cleanup);
  assert.equal(await findProject(none.root, { env: none.env }), null);
});

test('findProject and loadAdapter: a user-folder copy is found by its root; both copies are refused naming both files', async (t) => {
  const p = makeProject({ location: 'user' });
  t.after(p.cleanup);
  assert.deepEqual(await findProject(p.repos.client.dir, { env: p.env }), { root: p.root, file: p.adapterFile, location: 'user' });
  const a = await loadAdapter(p.root, { env: p.env });
  assert.equal(a.source.location, 'user');
  const repoFile = writeAdapterFile(p, adapterFor({ root: p.root }), 'repo');
  for (const call of [() => findProject(p.root, { env: p.env }), () => loadAdapter(p.root, { env: p.env })]) {
    await assert.rejects(call(), (e) => e instanceof WfError && e.message.includes(repoFile) && e.message.includes(p.adapterFile));
  }
});

test('loadAdapter: the user-folder copy is committed in a git history of its own, a hand edit becomes a new version', async (t) => {
  const p = makeProject({ location: 'user' });
  t.after(p.cleanup);
  const dir = path.dirname(p.adapterFile);
  await loadAdapter(p.root, { env: p.env });
  assert.equal(git(dir, ['rev-list', '--count', 'HEAD']), '1');
  await loadAdapter(p.root, { env: p.env });
  assert.equal(git(dir, ['rev-list', '--count', 'HEAD']), '1', 'an unchanged read writes nothing');
  const raw = YAML.parse(fs.readFileSync(p.adapterFile, 'utf8'));
  raw.review.diffRead = 'after';
  fs.writeFileSync(p.adapterFile, YAML.stringify(raw));
  assert.equal((await loadAdapter(p.root, { env: p.env })).review.diffRead, 'after');
  assert.equal(git(dir, ['rev-list', '--count', 'HEAD']), '2');
  assert.match(git(dir, ['show', 'HEAD~1:sample.yaml']), /diffRead: before/);
});

test('loadAdapter: a user-folder adapter needs root:, and its name matches its file', async (t) => {
  const p = makeProject({ location: 'user' });
  t.after(p.cleanup);
  const raw = YAML.parse(fs.readFileSync(p.adapterFile, 'utf8'));
  fs.writeFileSync(p.adapterFile, YAML.stringify({ ...raw, name: 'other' }));
  await assert.rejects(loadAdapter(p.root, { env: p.env }), /name: `other` must match the file name sample\.yaml/);
  const { root, ...noRoot } = raw;
  fs.writeFileSync(p.adapterFile, YAML.stringify(noRoot));
  await assert.rejects(findProject(p.root, { env: p.env }), /has no `root:`/);
  assert.ok((await checkAdapter(noRoot, { location: 'user' })).some((x) => x.startsWith('root:')));
});

test('loadAdapter: a 0.7 adapter names `wf init --from-07`; no adapter names `wf init`', async (t) => {
  const p = makeProject();
  t.after(p.cleanup);
  fs.writeFileSync(p.adapterFile, 'version: 1\nname: sample\nlanes: [quick]\nrepos: []\n');
  await assert.rejects(loadAdapter(p.root, { env: p.env }), (e) => e instanceof WfError && /wf init --from-07/.test(e.hint));
  fs.rmSync(p.adapterFile);
  await assert.rejects(loadAdapter(p.root, { env: p.env }), (e) => /no adapter/.test(e.message) && /wf init/.test(e.hint));
});

test('loadAdapter: the normalised adapter has every key of the contract type, defaults filled', async (t) => {
  const p = makeProject();
  t.after(p.cleanup);
  const a = await loadAdapter(p.root, { env: p.env });
  assert.deepEqual(Object.keys(a).sort(), ['budget', 'components', 'delivery', 'invariants', 'models', 'name', 'onboarded', 'repos', 'requires', 'review', 'risk', 'root', 'rules', 'screens', 'source', 'ticketing', 'version'].sort());
  assert.equal(a.root, p.root);
  assert.equal(a.source.location, 'repo');
  assert.match(a.source.hash, /^[0-9a-f]{64}$/);
  assert.deepEqual(a.requires, { connectors: [], tools: [], skills: [] });
  assert.equal(a.repos[0].remote, 'origin');
  assert.deepEqual(a.repos[0].provision, { clone: [], fingerprint: [], install: null, copyIgnored: [] });
  assert.deepEqual(a.repos[1].tests.full.lock, { name: 'fixture-suite', count: 1 });
  assert.deepEqual(a.risk, { confirmed: true, paths: [{ id: 'sums', paths: ['server/src/core/**'], reason: 'computes values written to storage (fixture)', tests: ['server/test/**'] }] });
  assert.deepEqual(a.delivery.order, ['server', 'client']);
  assert.deepEqual(a.delivery.authority, { push: 'agent', mergeRequest: 'agent', merge: 'person' });
  assert.deepEqual(a.onboarded, { at: null, engine: null, hashes: {} });
  assert.deepEqual(a.models, {});

  const bare = makeProject({ overrides: { risk: undefined, review: undefined, ticketing: undefined, delivery: undefined, budget: undefined, screens: undefined, components: undefined } });
  t.after(bare.cleanup);
  const b = await loadAdapter(bare.root, { env: bare.env });
  assert.deepEqual(b.risk, { confirmed: false, paths: [] });
  assert.equal(b.review.diffRead, 'before');
  assert.deepEqual(b.ticketing, { tracker: null, via: 'none', idPattern: null, take: null, followUps: { mode: 'off' }, operations: {} });
  assert.deepEqual(b.delivery, { landing: 'direct', order: ['server', 'client'], authority: { push: 'agent', mergeRequest: 'agent', merge: 'person' }, stages: [] });
  assert.deepEqual(b.screens, { routes: null, shared: [], sentinel: [], langs: [], viewports: [], capture: null });
  assert.deepEqual(b.budget, { adapter: { rules: null, risk: null, modules: null, operationWords: null } });
  const none = makeProject({ overrides: { risk: 'none' } });
  t.after(none.cleanup);
  assert.deepEqual((await loadAdapter(none.root, { env: none.env })).risk, { confirmed: true, paths: [] });
});

test('checkAdapter: the fixture is valid; every adapter key in budget.json is checked; problems name the key', async () => {
  const good = adapterFor({ root: '/x' });
  assert.deepEqual(await checkAdapter(good), []);
  // One bad value per adapter key the budget lists: each is reported under its own key.
  const bad = {
    version: [{ version: 3 }, /^version:/],
    name: [{ name: 'a/b' }, /^name:/],
    root: [{ root: 'relative/dir' }, /^root:/],
    requires: [{ requires: { connectors: 'x' } }, /^requires\.connectors:/],
    repos: [{ repos: [] }, /^repos:/],
    'repos.name': [{ repos: [{ ...good.repos[0], name: 'a/b' }, good.repos[1]] }, /^repos\[0\]\.name:/],
    'repos.path': [{ repos: [{ ...good.repos[0], path: '../out' }, good.repos[1]] }, /^repos\[0\]\.path:/],
    'repos.base': [{ repos: [{ ...good.repos[0], base: '' }, good.repos[1]] }, /^repos\[0\]\.base:/],
    'repos.remote': [{ repos: [{ ...good.repos[0], remote: 3 }, good.repos[1]] }, /^repos\[0\]\.remote:/],
    'repos.provision': [{ repos: [{ ...good.repos[0], provision: { clone: 'node_modules' } }, good.repos[1]] }, /^repos\[0\]\.provision\.clone:/],
    'repos.tests': [{ repos: [{ ...good.repos[0], tests: { fast: { run: 'x', module: { repo: 'server', path: 'a.mjs' } } } }, good.repos[1]] }, /^repos\[0\]\.tests\.fast: needs exactly one/],
    'repos.kinds': [{ repos: [{ ...good.repos[0], kinds: { tests: 'x' } }, good.repos[1]] }, /^repos\[0\]\.kinds\.tests:/],
    components: [{ components: [{ id: 'c', repo: 'nowhere', dependsOn: [] }] }, /^components\[0\]\.repo:/],
    invariants: [{ invariants: '/etc/passwd' }, /^invariants:/],
    rules: [{ rules: [{ paths: [], read: ['a.md'] }] }, /^rules\[0\]\.paths:/],
    'screens.routes': [{ screens: { routes: { repo: 'nowhere', path: 'r.mjs' } } }, /^screens\.routes\.repo:/],
    'screens.shared': [{ screens: { shared: 'x' } }, /^screens\.shared:/],
    'screens.sentinel': [{ screens: { sentinel: [1] } }, /^screens\.sentinel\[0\]:/],
    'screens.langs': [{ screens: { langs: [{ lang: 'l1', dir: 'up' }] } }, /^screens\.langs\[0\]\.dir:/],
    'screens.viewports': [{ screens: { viewports: [0] } }, /^screens\.viewports\[0\]:/],
    'screens.capture': [{ screens: { capture: 'cap {out} {size}' } }, /^screens\.capture: unknown placeholder \{size\}/],
    'review.diffRead': [{ review: { diffRead: 'never' } }, /^review\.diffRead:/],
    risk: [{ risk: [{ id: 'r', paths: ['a/**'], reason: 'x', tests: [] }] }, /^risk\[0\]\.tests:/],
    'ticketing.tracker': [{ ticketing: { tracker: { module: { repo: 'nowhere', path: 't.mjs' } } } }, /^ticketing\.tracker\.module\.repo:/],
    'ticketing.via': [{ ticketing: { via: 'carrier-pigeon' } }, /^ticketing\.via:/],
    'ticketing.idPattern': [{ ticketing: { idPattern: '([' } }, /^ticketing\.idPattern:/],
    'ticketing.take': [{ ticketing: { take: { status: '' } } }, /^ticketing\.take\.status:/],
    'ticketing.followUps': [{ ticketing: { followUps: { mode: 'always' } } }, /^ticketing\.followUps\.mode:/],
    'ticketing.operations': [{ ticketing: { operations: { teleport: 'x' } } }, /^ticketing\.operations\.teleport: unknown key/],
    'delivery.landing': [{ delivery: { landing: 'later' } }, /^delivery\.landing:/],
    'delivery.order': [{ delivery: { order: ['server'] } }, /^delivery\.order: leaves out `client`/],
    'delivery.authority': [{ delivery: { authority: { merge: 'robot' } } }, /^delivery\.authority\.merge:/],
    'delivery.stages': [{ delivery: { stages: [{ do: 'status' }] } }, /^delivery\.stages\[0\]: a `status` stage needs `to`/],
    models: [{ models: { strategist: 'm' } }, /^models\.strategist: unknown key/],
    'budget.adapter': [{ budget: { adapter: { rules: -1 } } }, /^budget\.adapter\.rules:/],
    onboarded: [{ onboarded: { hashes: { lanes: 'abc' } } }, /^onboarded\.hashes\.lanes:/],
  };
  assert.deepEqual(Object.keys(bad).sort(), [...BUDGET.adapterKeys].sort(), 'one case per adapter key in budget.json');
  for (const [key, [override, expect]] of Object.entries(bad)) {
    const problems = await checkAdapter({ ...good, ...override });
    assert.ok(problems.some((x) => expect.test(x)), `${key}: ${JSON.stringify(problems)}`);
  }
});

test('checkAdapter: dropped and unknown keys, stage kinds and modules, all problems listed at once', async () => {
  const good = adapterFor({ root: '/x' });
  const problems = await checkAdapter({ ...good, lanes: ['quick'], strategy: {}, colour: 'blue', delivery: { stages: [{ do: 'teleport' }, { do: 'module' }, { do: 'deploy' }, { do: 'merge-request', repos: ['nowhere'] }] } });
  assert.ok(problems.includes('lanes: dropped in schema 2: every ticket goes through one flow'));
  assert.ok(problems.some((x) => x.startsWith('strategy: dropped')));
  assert.ok(problems.includes('colour: unknown key'));
  assert.ok(problems.some((x) => x.startsWith('delivery.stages[0].do: must be one of')));
  assert.ok(problems.some((x) => x.startsWith('delivery.stages[1].module:')));
  assert.ok(problems.some((x) => x.startsWith('delivery.stages[2]: a `deploy` stage needs `where`')));
  assert.ok(problems.some((x) => x.startsWith('delivery.stages[3].repos: `nowhere`')));
  for (const k of POLICY_KEYS) assert.deepEqual(await checkAdapter({ ...good, onboarded: { at: null, engine: null, hashes: { [k]: 'a'.repeat(64) } } }), [], k);
});

test('loadAdapter: an invalid adapter throws one error listing every problem with the file', async (t) => {
  const p = makeProject({ overrides: { lanes: ['quick'], review: { diffRead: 'never' } } });
  t.after(p.cleanup);
  await assert.rejects(loadAdapter(p.root, { env: p.env }), (e) => e instanceof WfError && e.message.startsWith(p.adapterFile) && /lanes: dropped/.test(e.message) && /review\.diffRead/.test(e.message));
});

test('adapterBudget: rules, risk paths, distinct modules and operation words against budget.adapter', async (t) => {
  const p = makeProject({ overrides: {
    rules: [{ paths: ['client/src/**'], read: ['client/README.md'] }],
    ticketing: { tracker: { module: { repo: 'server', path: '.workflow/tracker.mjs' } }, via: 'connector', operations: { search: 'Search open issues for the text.', readBack: 'Read the issue back.' } },
    delivery: { stages: [{ do: 'module', module: { repo: 'server', path: '.workflow/tracker.mjs' } }, { do: 'module', module: { repo: 'client', path: 'deliver.mjs' } }] },
    budget: { adapter: { rules: 1, risk: 0, modules: 4, operationWords: 5 } },
  } });
  t.after(p.cleanup);
  const r = await adapterBudget(await loadAdapter(p.root, { env: p.env }));
  assert.deepEqual(r.counts, { rules: 1, risk: 1, modules: 3, operationWords: 10 });
  assert.deepEqual(r.limits, { rules: 1, risk: 0, modules: 4, operationWords: 5 });
  assert.deepEqual(r.over, ['risk', 'operationWords']);
  const unset = makeProject({ overrides: { budget: undefined } });
  t.after(unset.cleanup);
  assert.deepEqual((await adapterBudget(await loadAdapter(unset.root, { env: unset.env }))).over, []);
});
