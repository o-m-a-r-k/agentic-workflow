// Stream 7: `wf init --from-07` on the module-heavy fixture is an onboarding run seeded from the 0.7 adapter, and
// `wf migrate material` lists what 0.8 no longer reads.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { checkAdapter, commandHandler } from '../engine/contract.mjs';
import { clearDoubles, ctxFor, ledgerDoubles, makeModuleProject, readAdapter, useDoubles } from './onboard-fixture.mjs';
import { git } from './helpers/index.mjs';

const init = (p, flags = {}) => commandHandler('init')(ctxFor(p), { _: [], flags });
const captureDraft = (p) => {
  const f = path.join(p.tmp, 'draft.json');
  fs.writeFileSync(f, JSON.stringify({ screens: { capture: 'cd panel && npm run shots -- --out {out} --width {viewport} --lang {lang} {routes}' } }));
  return f;
};

test('--from-07 shows the seeded conversion, every dropped key, per-ticket steps, imports and module problems; writes nothing', async () => {
  const p = makeModuleProject();
  useDoubles(ledgerDoubles());
  try {
    const r = await init(p, { 'from-07': true });
    assert.equal(readAdapter(path.join(p.root, '.workflow', 'project.yaml')).version, 1);
    const dropped = r.data.migration.dropped.map((d) => d.key);
    for (const k of ['enabled', 'engine', 'adapterRepo', 'instructionFiles', 'lanes', 'classes', 'roles', 'gate.maxParallelSteps', 'gate.leases', 'gate.steps.tk7-proof', 'tracker.deliveredComment', 'tracker.statuses.done', 'tracker.statusByLabel', 'delivery.deployment', 'gate.steps.panel-shots.artifacts']) assert.ok(dropped.includes(k), k);
    assert.deepEqual(r.data.migration.perTicketSteps.map((s) => s.id), ['tk7-proof']);
    assert.match(r.text, /Per-ticket steps dropped: tk7-proof/);
    assert.match(r.text, /core\/test\/support\/capture\.mjs:1: import \{ shoot \} from "\.\.\/\.\.\/\.workflow\/browser\/shots\.mjs"/);
    assert.match(r.text, /core\/\.workflow\/steps\/runner\.mjs .*imports \.\.\/browser\/shots\.mjs, outside the module's folder/);
    // Seeded: tests through the module with the container lock, the tracker and delivery modules, statuses as stages.
    const ch = Object.fromEntries(r.data.diff.changes.map((c) => [c.key, c.to]));
    assert.deepEqual(ch['tests.core'].fast, { module: { repo: 'core', path: '.workflow/steps/runner.mjs' }, lock: { name: 'containers', count: 2 } });
    assert.deepEqual(ch['tests.panel'], { fast: { run: 'npm test' }, full: { run: 'npm test && npm run shots', lock: { name: 'screen', count: 1 } } });
    assert.deepEqual(ch['delivery.stages'], [
      { do: 'module', module: { repo: 'core', path: '.workflow/delivery/review-request.mjs' } },
      { do: 'status', to: 'Testing', comment: 'uat' },
      { do: 'status', to: 'Verify', comment: 'uat', when: { labels: ['Urgent'] } },
      { do: 'confirm-deployed', where: 'live', when: { labels: ['Urgent'] } },
      { do: 'status', to: 'Finished', comment: 'deployed', when: { labels: ['Urgent'] } },
    ]);
    assert.equal(ch['screens.capture'], 'cd panel && npm run shots');
    assert.match(r.text, /seeded from the 0\.7 step `panel-shots`/);
    assert.ok(ch['risk.tally']);
    assert.deepEqual(r.data.diff.seed.ticketing, { tracker: { module: { repo: 'core', path: '.workflow/tracker/board.mjs' } }, via: 'connector', idPattern: '^TK-\\d+$', take: { status: 'Doing' }, followUps: { mode: 'off' } });
    assert.deepEqual(r.data.diff.seed.repos.map((x) => [x.name, x.base]), [['core', 'trunk'], ['panel', 'release'], ['handset', 'dev']]);
  } finally {
    clearDoubles();
    p.cleanup();
  }
});

test('--from-07 refuses to finish while screens.capture does not write to {out}; with it, the adapter is written and valid', async () => {
  const p = makeModuleProject();
  useDoubles(ledgerDoubles());
  try {
    await assert.rejects(init(p, { 'from-07': true, confirm: ['all'] }), /`screens\.capture` is unset or does not write to \{out\}; nothing written/);
    assert.equal(readAdapter(path.join(p.root, '.workflow', 'project.yaml')).version, 1);
    const draft = captureDraft(p);
    const w = await init(p, { 'from-07': true, draft, confirm: ['all'] });
    assert.equal(w.data.written.written, true);
    const file = path.join(p.repos.core.dir, '.workflow', 'project.yaml');
    const a = readAdapter(file);
    assert.equal(a.version, 2);
    assert.deepEqual(await checkAdapter(a), []);
    for (const k of ['lanes', 'classes', 'gate', 'tracker', 'quality', 'adapterRepo']) assert.ok(!(k in a), k);
    assert.equal(a.invariants, 'core/.workflow/invariants.md');
    assert.deepEqual(a.rules, [{ paths: ['panel/src/pages/**'], read: ['panel/docs/pages.md'] }]);
    assert.ok(Array.isArray(a.risk) && a.risk.some((x) => x.id === 'tally'));
    const inv = fs.readFileSync(path.join(p.repos.core.dir, '.workflow', 'invariants.md'), 'utf8');
    assert.match(inv, /## Quality\n\n- Every page reads well at phone width\.\n- Totals cover the whole set, never one page\.\n/);
    assert.match(w.text, /Moved 2 `quality` lines/);
    // Re-evaluating the migrated project changes nothing.
    const again = await init(p);
    assert.deepEqual(again.data.diff.changes, []);
  } finally {
    clearDoubles();
    p.cleanup();
  }
});

test('migrate material lists unreferenced workflow files per repo and the product imports', async () => {
  const p = makeModuleProject();
  useDoubles(ledgerDoubles());
  try {
    await init(p, { 'from-07': true, draft: captureDraft(p), confirm: ['all'] });
    git(p.repos.core.dir, ['add', '-A']);
    git(p.repos.core.dir, ['commit', '--quiet', '-m', 'adapter']);
    const r = await commandHandler('migrate')(ctxFor(p), { _: ['material'], flags: {} });
    const files = r.data.unreferenced.map((u) => u.file);
    assert.ok(files.includes('core/.workflow/steps/tk7.mjs'));
    assert.ok(files.includes('core/.workflow/browser/shots.mjs'));
    for (const used of ['core/.workflow/steps/runner.mjs', 'core/.workflow/tracker/board.mjs', 'core/.workflow/delivery/review-request.mjs', 'core/.workflow/invariants.md', 'core/.workflow/project.yaml']) assert.ok(!files.includes(used), used);
    assert.deepEqual(r.data.imports.map((i) => i.at), ['core/test/support/capture.mjs:1']);
    assert.match(r.text, /One removal ticket per repo/);
  } finally {
    clearDoubles();
    p.cleanup();
  }
});
