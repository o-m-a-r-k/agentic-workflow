// Fixer C (B4, B6, M15): a 0.7 project's own modules, in the shapes 0.7 gave them, migrate to what 0.8 can run, and what
// it cannot is said plainly: each module's default export is checked as the base holds it, a test runner that still
// reads 0.7 step context means no tests run until it is rewritten, and a delivery module becomes a merge request.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { commandHandler } from '../engine/contract.mjs';
import { baseBranch07, exportProblem, MODULE_CONTRACTS } from '../engine/migrate.mjs';
import { CONNECTOR_TRACKER, clearDoubles, ctxFor, ledgerDoubles, makeModuleProject, useDoubles, useUserDir } from './onboard-fixture.mjs';

const init = (p, flags = {}) => commandHandler('init')(ctxFor(p), { _: [], flags });
const captureDraft = (p) => {
  const f = path.join(p.tmp, 'draft.json');
  fs.writeFileSync(f, JSON.stringify({ screens: { capture: { run: 'cd panel && npm run shots -- --out {out} {routes}' } } }));
  return f;
};

test('--from-07 with 0.7-shaped modules: each default export is checked; the runner and delivery rewrites are said plainly', async () => {
  const p = makeModuleProject({ modules07: true });
  useDoubles(ledgerDoubles());
  const restore = useUserDir(p);
  try {
    const r = await init(p, { 'from-07': true });
    const byWhat = Object.fromEntries(r.data.migration.modules.map((m) => [m.what, m]));
    assert.match(byWhat['tests.core.fast'].problem, /exports an object \(plan, run\) by default, not a function: it is not usable as is/);
    assert.equal(byWhat['tests.core.fast'].contract, MODULE_CONTRACTS.tests);
    // Through a connector the tracker module gives the owner its words: this one has none.
    assert.match(byWhat['ticketing.tracker'].problem, /no `operations`: with `ticketing\.via: connector`/);
    // The runner: no tests run until it is rewritten, with the contract printed.
    assert.ok(r.text.includes(`No tests run until core/.workflow/steps/runner.mjs is rewritten for the 0.8 runner contract:\n  ${MODULE_CONTRACTS.tests}`));
    // The delivery module is not run: merge request + wait-merged, by the person, and the module is named for rewriting.
    const stages = r.data.diff.changes.find((c) => c.key === 'delivery.stages').to;
    assert.deepEqual(stages.slice(0, 2), [{ do: 'merge-request' }, { do: 'wait-merged' }]);
    assert.ok(!stages.some((s) => s.do === 'module'));
    assert.deepEqual(r.data.diff.seed.delivery.authority, { mergeRequest: 'person', merge: 'person' });
    assert.equal(r.data.migration.deliveryModule, 'core/.workflow/delivery/review-request.mjs');
    assert.match(r.text, /review-request\.mjs is a 0\.7 delivery module and needs rewriting/);
  } finally {
    restore();
    clearDoubles();
    p.cleanup();
  }
});

test('--from-07 with a runner already shaped for 0.8: no shape problem for it, the tracker\'s empty export is named', async () => {
  const p = makeModuleProject();
  useDoubles(ledgerDoubles());
  const restore = useUserDir(p);
  try {
    const r = await init(p, { 'from-07': true });
    const whats = r.data.migration.modules.map((m) => m.what);
    assert.ok(!whats.some((w) => w.startsWith('tests.')), JSON.stringify(r.data.migration.modules));
    assert.match(r.data.migration.modules.find((m) => m.what === 'ticketing.tracker').problem, /exports an object \(no keys\) by default/);
  } finally {
    restore();
    clearDoubles();
    p.cleanup();
  }
});

test('doctor fails a module whose default export its kind cannot call (M15)', async () => {
  const p = makeModuleProject({ modules07: true });
  useDoubles(ledgerDoubles());
  const restore = useUserDir(p);
  try {
    await init(p, { 'from-07': true, draft: captureDraft(p), confirm: ['all'] });
    const d = await commandHandler('doctor')(ctxFor(p), { _: [], flags: {} });
    const fails = d.data.checks.filter((c) => c.level === 'fail').map((c) => c.check);
    assert.ok(fails.includes('tests.core.fast'), JSON.stringify(d.data.checks));
    assert.ok(fails.includes('ticketing.tracker'));
    assert.equal(d.exitCode, 1);
    assert.match(d.text, /runner\.mjs exports an object \(plan, run\) by default, not a function/);
  } finally {
    restore();
    clearDoubles();
    p.cleanup();
  }
});

test('a connector tracker module (operations and helpers, no driver methods) is usable: init and doctor name no problem', async () => {
  const p = makeModuleProject({ modules07: true, core: CONNECTOR_TRACKER });
  useDoubles(ledgerDoubles());
  const restore = useUserDir(p);
  try {
    const r = await init(p, { 'from-07': true, draft: captureDraft(p), confirm: ['all'] });
    assert.equal(r.data.diff.seed.ticketing.via, 'connector');
    assert.ok(!r.data.migration.modules.some((m) => m.what === 'ticketing.tracker'), JSON.stringify(r.data.migration.modules));
    const d = await commandHandler('doctor')(ctxFor(p), { _: [], flags: {} });
    assert.ok(!d.data.checks.some((c) => c.level === 'fail' && c.check === 'ticketing.tracker'), JSON.stringify(d.data.checks));
  } finally {
    restore();
    clearDoubles();
    p.cleanup();
  }
});

test('the default-export check per kind; a 0.7 base is the branch of baseRef, never the start sha', () => {
  assert.equal(exportProblem('stage', async () => ({ state: 'done' })), null);
  assert.match(exportProblem('stage', { integrate() {}, observe() {}, readback() {} }), /an object \(integrate, observe, readback\).*not a function.*delivery stage contract/);
  assert.match(exportProblem('routes', undefined), /no default export/);
  assert.equal(exportProblem('tracker', { read() {}, search() {}, create() {}, setStatus() {}, comment() {} }), null);
  // The driver methods are checked only with `via: module`; through a connector, `operations` (default or named).
  const connectorShaped = { operations: { setStatus: 'Move it.' }, normalize: (x) => x };
  assert.match(exportProblem('tracker', connectorShaped), /lacks read, search, create, setStatus, comment/);
  assert.equal(exportProblem('tracker', connectorShaped, { via: 'connector' }), null);
  assert.equal(exportProblem('tracker', undefined, { via: 'connector', operations: { setStatus: 'Move it.' } }), null);
  assert.match(exportProblem('tracker', { normalize: (x) => x }, { via: 'connector' }), /no `operations`/);
  assert.equal(baseBranch07({ base: 'a'.repeat(40), baseRef: 'origin/trunk' }), 'trunk');
  assert.equal(baseBranch07({ base: 'a'.repeat(40), baseRef: 'upstream/line/two' }, 'upstream'), 'line/two');
  assert.equal(baseBranch07({ base: 'a'.repeat(40), baseRef: 'trunk' }), 'trunk');
  assert.equal(baseBranch07({ base: 'a'.repeat(40) }), null);
});
