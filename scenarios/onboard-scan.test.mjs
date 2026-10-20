// Stream 7: the onboarding scan reads project shapes only; what a change risks is judged per change by its reviewers.
import test from 'node:test';
import assert from 'node:assert/strict';
import { scan } from '../engine/contract.mjs';
import { MODULE_REPOS, makeModuleProject } from './onboard-fixture.mjs';

test('scan: project shapes per repo, workflow material ignored, the project\'s documents named; no code shapes', async () => {
  const p = makeModuleProject();
  try {
    const facts = await scan(p.root);
    assert.deepEqual(facts.repos.map((r) => r.name).sort(), ['core', 'handset', 'panel']);
    const core = facts.repos.find((r) => r.name === 'core');
    const kinds = (kind) => core.facts.filter((f) => f.kind === kind).map((f) => f.path);
    assert.ok(kinds('invariants-doc').includes('core/.workflow/invariants.md'));
    assert.ok(kinds('instruction-doc').includes('core/AGENTS.md'));
    assert.ok(core.facts.some((f) => f.kind === 'test-script' && f.name === 'test:e2e' && f.containers));
    // The 0.7 material under .workflow/ is not product code.
    assert.ok(!core.facts.some((f) => f.path.includes('.workflow/steps') || f.path.includes('.workflow/tracker')));
    assert.ok(core.tests.includes('core/test/tally/total.spec.mjs'));
    const handset = facts.repos.find((r) => r.name === 'handset');
    assert.ok(handset.facts.some((f) => f.kind === 'mobile-app' && f.path === 'handset/ios'));
    // Risk is judged per change by reviewers: the scan reads no money, external-write, migration or access code.
    const all = facts.repos.flatMap((r) => r.facts.map((f) => f.kind));
    assert.deepEqual([...new Set(all)].filter((k) => !['ci-file', 'test-script', 'mobile-app', 'instruction-doc', 'invariants-doc'].includes(k)), []);
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
