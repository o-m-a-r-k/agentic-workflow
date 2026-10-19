// Stream 7: the onboarding scan reads structural facts, and risk areas come from what a mistake costs, named by the
// project's own folders and documents.
import test from 'node:test';
import assert from 'node:assert/strict';
import { scan } from '../engine/contract.mjs';
import { riskFromFacts } from '../engine/onboard.mjs';
import { MODULE_REPOS, makeModuleProject } from './onboard-fixture.mjs';
import { makeProject } from './helpers/index.mjs';

test('scan: structural facts per repo, workflow material ignored, the project\'s documents quoted', async () => {
  const p = makeModuleProject();
  try {
    const facts = await scan(p.root);
    assert.deepEqual(facts.repos.map((r) => r.name).sort(), ['core', 'handset', 'panel']);
    const core = facts.repos.find((r) => r.name === 'core');
    const kinds = (kind) => core.facts.filter((f) => f.kind === kind).map((f) => f.path);
    assert.ok(kinds('decimal-type').includes('core/src/modules/tally/total.mjs:1'));
    assert.ok(kinds('rounding').some((x) => x.startsWith('core/src/modules/tally/total.mjs')));
    const out = core.facts.find((f) => f.kind === 'outbound-client');
    assert.equal(out.path, 'core/src/modules/relay/send.mjs:1');
    assert.equal(out.writes, true);
    assert.ok(kinds('webhook-handler').some((x) => x.startsWith('core/src/modules/relay/hook.controller.mjs')));
    assert.ok(kinds('permission').some((x) => x.startsWith('core/src/modules/access/guard.mjs')));
    assert.deepEqual(kinds('migration'), ['core/src/migrations']);
    assert.ok(kinds('invariants-doc').includes('core/.workflow/invariants.md:3'));
    assert.ok(kinds('instruction-doc').includes('core/AGENTS.md'));
    assert.ok(core.facts.some((f) => f.kind === 'test-script' && f.name === 'test:e2e' && f.containers));
    // The 0.7 material under .workflow/ is not product code.
    assert.ok(!core.facts.some((f) => f.path.includes('.workflow/steps') || f.path.includes('.workflow/tracker')));
    assert.ok(core.modules.includes('src/modules/tally'));
    assert.ok(core.tests.includes('core/test/tally/total.spec.mjs'));
    const handset = facts.repos.find((r) => r.name === 'handset');
    assert.ok(handset.facts.some((f) => f.kind === 'mobile-app' && f.path === 'handset/ios'));
  } finally {
    p.cleanup();
  }
});

test('risk from facts: one area per costly folder, a reason citing files, tests found, quiet folders left out', async () => {
  const p = makeModuleProject();
  try {
    const found = riskFromFacts(await scan(p.root));
    const byId = Object.fromEntries(found.map((x) => [x.id, x.entry]));
    assert.deepEqual(Object.keys(byId).sort(), ['access', 'migrations', 'relay', 'tally']);
    // Named by the project's invariants, so first.
    assert.deepEqual(found.slice(0, 2).map((x) => x.id).sort(), ['relay', 'tally']);
    assert.match(byId.tally.reason, /money computed: decimal-type core\/src\/modules\/tally\/total\.mjs:1/);
    assert.match(byId.tally.reason, /named in core\/\.workflow\/invariants\.md:3/);
    assert.deepEqual(byId.tally.paths, ['core/src/modules/tally/**']);
    assert.deepEqual(byId.tally.tests, ['core/test/tally/**']);
    assert.match(byId.relay.reason, /writes to external systems: .*outbound-client core\/src\/modules\/relay\/send\.mjs:1/);
    assert.match(byId.access.reason, /access granted/);
    assert.match(byId.migrations.reason, /data migrated/);
    for (const e of Object.values(byId)) assert.ok(e.tests.length, `${e.id} has tests`);
  } finally {
    p.cleanup();
  }
});

test('risk from facts: a project with nothing costly yields no area', async () => {
  const p = makeProject({ adapter: false, repos: [{ name: 'only', base: 'line', files: { 'src/a/b.mjs': 'export const b = 1;\n' } }] });
  try {
    assert.deepEqual(riskFromFacts(await scan(p.root)), []);
  } finally {
    p.cleanup();
  }
});

test('the fixture is the plugin\'s own: no repo of it is named in the engine', async () => {
  const fs = await import('node:fs');
  for (const f of ['scan.mjs', 'onboard.mjs', 'migrate.mjs']) {
    const text = fs.readFileSync(new URL(`../engine/${f}`, import.meta.url), 'utf8');
    for (const r of MODULE_REPOS.filter((x) => x.name !== 'panel')) assert.ok(!new RegExp(`\\b${r.name}\\b`).test(text), `${f} names ${r.name}`);
    for (const word of ['tally', 'relay', 'trunk', 'TK-']) assert.ok(!text.includes(word), `${f} carries ${word}`);
  }
});
