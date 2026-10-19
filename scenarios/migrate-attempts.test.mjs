// Stream 7: `wf migrate attempts` skips held attempts and lists them, closes the other open 0.7 attempts as superseded
// (branches kept, clean worktrees removed), closes work already on its base by patch-id as shipped, and prints each
// attempt's last review state.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { commandHandler } from '../engine/contract.mjs';
import { clearDoubles, ctxFor, ledgerDoubles, makeModuleProject, useDoubles } from './onboard-fixture.mjs';
import { git, writeLegacyLedgers } from './helpers/index.mjs';

const at = (hm) => `2026-01-06T${hm}:00.000Z`;
const admitted = (id, item) => [at('09:00'), 'admitted', { id, item, lane: 'standard', repos: { core: { branch: `wf/${id}`, base: 'trunk' } } }];

test('migrate attempts: held skipped and listed, open superseded with branches kept, shipped by patch-id', async () => {
  const p = makeModuleProject();
  const appended = [];
  useDoubles(ledgerDoubles(appended));
  try {
    const core = p.repos.core.dir;
    // TK-8.1: work not on the base, in a clean worktree.
    const wt8 = path.join(p.root, '.wf-worktrees', 'TK-8.1', 'core');
    git(core, ['worktree', 'add', '--quiet', '-b', 'wf/TK-8.1', wt8, 'trunk']);
    p.commit('core', { 'src/modules/notes/more.mjs': 'export const more = 1;\n' }, 'more notes', { cwd: wt8 });
    // TK-9.1: its commit reached the base as a cherry-pick (a different sha, the same patch).
    git(core, ['branch', 'wf/TK-9.1', 'trunk']);
    git(core, ['checkout', '--quiet', 'wf/TK-9.1']);
    const sha9 = p.commit('core', { 'src/modules/notes/fix.mjs': 'export const fix = 1;\n' }, 'fix');
    git(core, ['checkout', '--quiet', 'trunk']);
    p.commit('core', { 'README.md': '# core moved\n' }, 'moved on');
    git(core, ['cherry-pick', sha9]);
    git(core, ['push', '--quiet', 'origin', 'trunk']);
    writeLegacyLedgers(p.root, {
      'TK-8.1': [admitted('TK-8.1', 'TK-8'), [at('10:00'), 'review.recorded', { tree: 't', closure: { verdict: 'changes', findings: [{ id: 'F1', status: 'open' }, { id: 'F2', status: 'fixed' }] } }]],
      'TK-9.1': [admitted('TK-9.1', 'TK-9'), [at('10:00'), 'review.recorded', { tree: 't', closure: { verdict: 'approve', findings: [] } }], [at('10:10'), 'review.accepted', {}]],
    });

    const r = await commandHandler('migrate')(ctxFor(p), { _: ['attempts'], flags: {} });
    // Held (from the shared 0.7 story): skipped, listed, nothing appended.
    assert.deepEqual(r.data.held.map((h) => [h.id, h.reason]), [['TK-4.1', 'stop everything']]);
    assert.match(r.text, /TK-4\.1 \(TK-4\) server:wf\/TK-4\.1: held \("stop everything"\), skipped/);
    assert.match(r.text, /Held attempts stay as they are, for you to decide: TK-4\.1/);
    assert.ok(!appended.some((a) => a.id === 'TK-4.1'));
    // Closed 0.7 attempts are left alone.
    assert.ok(!appended.some((a) => ['TK-1.1', 'TK-2.1', 'BATCH-1', 'TK-7.1'].includes(a.id)));

    const closed = Object.fromEntries(appended.map((a) => [a.id, a.data]));
    assert.equal(closed['TK-8.1'].outcome, 'superseded');
    assert.equal(closed['TK-5.1'].outcome, 'superseded');
    assert.equal(closed['TK-9.1'].outcome, 'shipped');
    assert.equal(closed['TK-9.1'].patchIds.length, 1);
    assert.match(closed['TK-9.1'].patchIds[0].patchId, /^[0-9a-f]{40}$/);
    assert.ok(appended.every((a) => a.type === 'attempt.closed'));

    assert.match(r.text, /TK-8\.1 \(TK-8\) core:wf\/TK-8\.1: closed as superseded; core: 1 unmerged; last review: changes, 1 open finding/);
    assert.match(r.text, /TK-9\.1 \(TK-9\) core:wf\/TK-9\.1: closed as shipped; core: 0 unmerged, 1 on origin\/trunk; last review: accepted/);
    assert.match(r.text, /TK-5\.1 .*server: no branch/);
    assert.match(r.text, /Tracker statuses were not changed/);
    // The clean worktree is gone; every branch stays.
    assert.equal(fs.existsSync(wt8), false);
    for (const b of ['wf/TK-8.1', 'wf/TK-9.1']) assert.ok(git(core, ['rev-parse', '--verify', '--quiet', `refs/heads/${b}`]));

    // A second run finds nothing open but the held attempt.
    appended.length = 0;
    const again = await commandHandler('migrate')(ctxFor(p), { _: ['attempts'], flags: {} });
    assert.deepEqual(appended, []);
    assert.deepEqual(again.data.superseded, []);
    assert.deepEqual(again.data.held.map((h) => h.id), ['TK-4.1']);
  } finally {
    clearDoubles();
    p.cleanup();
  }
});

test('migrate attempts --dry-run appends nothing and keeps worktrees; a worktree with changes is kept and named', async () => {
  const p = makeModuleProject();
  const appended = [];
  useDoubles(ledgerDoubles(appended));
  try {
    const core = p.repos.core.dir;
    const wt = path.join(p.root, '.wf-worktrees', 'TK-8.1', 'core');
    git(core, ['worktree', 'add', '--quiet', '-b', 'wf/TK-8.1', wt, 'trunk']);
    fs.writeFileSync(path.join(wt, 'scratch.txt'), 'unsaved\n');
    writeLegacyLedgers(p.root, { 'TK-8.1': [admitted('TK-8.1', 'TK-8')] });
    const dry = await commandHandler('migrate')(ctxFor(p), { _: ['attempts'], flags: { 'dry-run': true } });
    assert.deepEqual(appended, []);
    assert.match(dry.text, /TK-8\.1 .*would close as superseded.*last review: no review recorded/);
    const r = await commandHandler('migrate')(ctxFor(p), { _: ['attempts'], flags: {} });
    assert.match(r.text, /TK-8\.1\/core kept: uncommitted changes/);
    assert.ok(fs.existsSync(wt));
  } finally {
    clearDoubles();
    p.cleanup();
  }
});

test('migrate with no or an unknown subcommand names the subcommands', async () => {
  const p = makeModuleProject();
  try {
    await assert.rejects(commandHandler('migrate')(ctxFor(p), { _: [], flags: {} }), /the subcommands are attempts and material/);
  } finally {
    p.cleanup();
  }
});
