// Stream 7: `wf init --from-07` on the module-heavy fixture is an onboarding run seeded from the 0.7 adapter, and
// `wf migrate material` lists what 0.8 no longer reads.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { checkAdapter, commandHandler } from '../engine/contract.mjs';
import { clearDoubles, ctxFor, ledgerDoubles, makeModuleProject, readAdapter, useDoubles, useUserDir } from './onboard-fixture.mjs';
import { git, writeLegacyLedgers } from './helpers/index.mjs';

const init = (p, flags = {}) => commandHandler('init')(ctxFor(p), { _: [], flags });
const captureDraft = (p) => {
  const f = path.join(p.tmp, 'draft.json');
  fs.writeFileSync(f, JSON.stringify({ screens: { capture: 'cd panel && npm run shots -- --out {out} --width {viewport} --lang {lang} {routes}' } }));
  return f;
};

test('--from-07 shows the seeded conversion, every dropped key, per-ticket steps, imports and module problems; writes nothing', async () => {
  const p = makeModuleProject();
  useDoubles(ledgerDoubles());
  const restore = useUserDir(p);
  try {
    const r = await init(p, { 'from-07': true });
    assert.equal(readAdapter(path.join(p.root, '.workflow', 'project.yaml')).version, 1);
    const dropped = r.data.migration.dropped.map((d) => d.key);
    for (const k of ['enabled', 'engine', 'adapterRepo', 'instructionFiles', 'lanes', 'classes', 'roles', 'gate.maxParallelSteps', 'gate.leases', 'gate.steps.tk7-proof', 'tracker.deliveredComment', 'tracker.statuses.done', 'tracker.statusByLabel', 'delivery.deployment', 'gate.steps.panel-shots.artifacts']) assert.ok(dropped.includes(k), k);
    assert.deepEqual(r.data.migration.perTicketSteps.map((s) => s.id), ['tk7-proof']);
    assert.match(r.text, /Per-ticket steps dropped: tk7-proof/);
    assert.match(r.text, /core\/test\/support\/capture\.mjs:1: import \{ shoot \} from "\.\.\/\.\.\/\.workflow\/browser\/shots\.mjs"/);
    // The shared loader extracts the module's top-level folder (all of `.workflow/`), so a sibling import resolves.
    assert.doesNotMatch(r.text, /runner\.mjs .*imports \.\.\/browser\/shots\.mjs/);
    // Seeded: tests through the module with the container lock, the tracker and delivery modules, statuses as stages.
    const ch = Object.fromEntries(r.data.diff.changes.map((c) => [c.key, c.to]));
    assert.deepEqual(ch['tests.core'].fast, { module: { repo: 'core', path: '.workflow/steps/runner.mjs' }, lock: { name: 'containers', count: 2 } });
    assert.deepEqual(ch['tests.panel'], { fast: { run: 'npm test' }, full: { run: 'npm test && npm run shots', lock: { name: 'screen', count: 1 } } });
    // A 0.7 delivery module is not a 0.8 stage: a merge request the person opens and merges, and the module is named.
    assert.deepEqual(ch['delivery.stages'], [
      { do: 'merge-request' },
      { do: 'wait-merged' },
      { do: 'status', to: 'Testing', comment: 'uat' },
      { do: 'status', to: 'Verify', comment: 'uat', when: { labels: ['Urgent'] } },
      { do: 'confirm-deployed', where: 'live', when: { labels: ['Urgent'] } },
      { do: 'status', to: 'Finished', comment: 'deployed', when: { labels: ['Urgent'] } },
    ]);
    assert.deepEqual(r.data.diff.seed.delivery.authority, { mergeRequest: 'person', merge: 'person' });
    assert.match(r.text, /delivery: core\/\.workflow\/delivery\/review-request\.mjs is a 0\.7 delivery module and needs rewriting/);
    // The 0.7 step's command writes no screen to {out}: no capture is proposed, and there are no screens.
    assert.equal(ch['screens.capture'], undefined);
    assert.match(r.text, /the 0\.7 step `panel-shots` collected screenshots, but its command does not write each one to \{out\}, so no capture is proposed/);
    // Nothing about risk is proposed or asked.
    assert.ok(!Object.keys(ch).some((k) => k.startsWith('risk')));
    // Item ids: the tracker's prefix and the 0.7 quick-fix prefix the old attempt folders show.
    assert.deepEqual(r.data.diff.seed.ticketing, { tracker: { module: { repo: 'core', path: '.workflow/tracker/board.mjs' } }, via: 'connector', idPattern: '^(?:QF|TK)-\\d+$', take: { status: 'Doing' }, followUps: { mode: 'off' } });
    // requires.tools keeps plain command names; the rest are dropped and listed.
    assert.deepEqual(r.data.diff.seed.requires, { tools: ['git', 'node'] });
    for (const k of ['requires.tools.emulator', 'requires.tools.docker compose']) assert.ok(dropped.includes(k), k);
    assert.match(r.text, /requires\.tools\.emulator: checked by `xcrun simctl list`, not by its name/);
    assert.match(r.text, /requires\.tools\.docker compose: not a plain command name/);
    assert.deepEqual(r.data.diff.seed.repos.map((x) => [x.name, x.base]), [['core', 'trunk'], ['panel', 'release'], ['handset', 'dev']]);
  } finally {
    restore();
    clearDoubles();
    p.cleanup();
  }
});

test('--from-07 names the items of old attempts the derived idPattern refuses (a UUID), with the two ways to start them', async () => {
  const p = makeModuleProject();
  const uuid = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
  writeLegacyLedgers(p.root, { [`${uuid}.1`]: [['2026-01-06T09:00:00.000Z', 'admitted', { id: `${uuid}.1`, item: uuid, lane: 'quick', repos: {} }], ['2026-01-06T10:00:00.000Z', 'closed', { reason: 'delivered' }]] });
  useDoubles(ledgerDoubles());
  const restore = useUserDir(p);
  try {
    const r = await init(p, { 'from-07': true });
    assert.equal(r.data.diff.seed.ticketing.idPattern, '^(?:QF|TK)-\\d+$');
    assert.deepEqual(r.data.migration.offPattern, [uuid]);
    assert.match(r.text, new RegExp(`does not match: wf start refuses them as they are\\. Start one with \`wf start --no-tracker <id>\`, or give the tracker module a \`normalise\` export[^\\n]*\\n  ${uuid}`));
  } finally {
    restore();
    clearDoubles();
    p.cleanup();
  }
});

test('--from-07 finishes with no capture (no screens); a draft capture is written; the adapter is valid', async () => {
  const p = makeModuleProject();
  useDoubles(ledgerDoubles());
  const restore = useUserDir(p);
  try {
    // No capture: onboarding still finishes; the project has no screens.
    const bare = makeModuleProject();
    const restoreBare = useUserDir(bare);
    try {
      const w0 = await init(bare, { 'from-07': true, confirm: ['all'] });
      assert.equal(w0.data.written.written, true);
      const a0 = readAdapter(path.join(bare.repos.core.dir, '.workflow', 'project.yaml'));
      assert.equal(a0.version, 2);
      assert.equal(a0.screens?.capture, undefined);
    } finally {
      restoreBare();
      bare.cleanup();
    }
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
    assert.equal(a.risk, undefined);
    assert.equal(a.screens.capture, 'cd panel && npm run shots -- --out {out} --width {viewport} --lang {lang} {routes}');
    const inv = fs.readFileSync(path.join(p.repos.core.dir, '.workflow', 'invariants.md'), 'utf8');
    assert.match(inv, /## Quality\n\n- Every page reads well at phone width\.\n- Totals cover the whole set, never one page\.\n/);
    assert.match(w.text, /Moved 2 `quality` lines/);
    // Re-evaluating the migrated project changes nothing.
    const again = await init(p);
    assert.deepEqual(again.data.diff.changes, []);
  } finally {
    restore();
    clearDoubles();
    p.cleanup();
  }
});

test('migrate material lists unreferenced workflow files per repo and the product imports', async () => {
  const p = makeModuleProject();
  useDoubles(ledgerDoubles());
  const restore = useUserDir(p);
  try {
    await init(p, { 'from-07': true, draft: captureDraft(p), confirm: ['all'] });
    git(p.repos.core.dir, ['add', '-A']);
    git(p.repos.core.dir, ['commit', '--quiet', '-m', 'adapter']);
    const r = await commandHandler('migrate')(ctxFor(p), { _: ['material'], flags: {} });
    const files = r.data.unreferenced.map((u) => u.file);
    assert.ok(files.includes('core/.workflow/steps/tk7.mjs'));
    assert.ok(files.includes('core/.workflow/browser/shots.mjs'));
    assert.ok(files.includes('core/.workflow/delivery/review-request.mjs'));
    for (const used of ['core/.workflow/steps/runner.mjs', 'core/.workflow/tracker/board.mjs', 'core/.workflow/invariants.md', 'core/.workflow/project.yaml']) assert.ok(!files.includes(used), used);
    assert.deepEqual(r.data.imports.map((i) => i.at), ['core/test/support/capture.mjs:1']);
    assert.match(r.text, /One removal ticket per repo/);
  } finally {
    restore();
    clearDoubles();
    p.cleanup();
  }
});

test('0.8.1 review: --from-07 gives its sources as reasons, says why a plugin screenshot step seeds no capture, and names the second reviewer\'s host', async () => {
  const p = makeModuleProject();
  useDoubles(ledgerDoubles());
  const restore = useUserDir(p);
  // Both hosts installed (fake commands on PATH): the second reviewer defaults to the other one.
  const bin = path.join(p.tmp, 'hosts-bin');
  fs.mkdirSync(bin, { recursive: true });
  for (const b of ['claude', 'codex']) fs.writeFileSync(path.join(bin, b), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const PATH = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${PATH}`;
  try {
    const file = path.join(p.repos.core.dir, '.workflow', 'project.yaml');
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('run: npm run shots {select}', 'plugin: ./browser/shots.mjs'));
    const r = await init(p, { 'from-07': true });
    const why = Object.fromEntries(r.data.diff.changes.map((c) => [c.key, c.reason]));
    assert.equal(why['tests.core'], 'from the 0.7 gate steps');
    assert.equal(why['delivery.stages'], 'from the 0.7 delivery (tracker statuses and labels)');
    assert.match(r.text, /the 0\.7 step `panel-shots` collected screenshots, but it runs as a 0\.7 plugin \(\.\/browser\/shots\.mjs\), not a command that writes each screen to \{out\}/);
    assert.match(r.text, /Second reviews: `models\.secondReviewer` is unset, so a second review a reviewer asks for runs on Codex/);
  } finally {
    process.env.PATH = PATH;
    restore();
    clearDoubles();
    p.cleanup();
  }
});
