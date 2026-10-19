import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeRepo, ok, sh, state, tmp, wf, yaml } from './helpers.mjs';
import { accepted, multiRepo } from './adapter-fault-fixtures.mjs';
import { headOf, integrations, perRepoAdapter, reconcile } from './base-merge-in-flight-fixtures.mjs';

// 0.7.26 (I-183), several repos: see base-merge-in-flight.test.mjs for the named failure and the single-repo scenarios.

// The shape of the field case: a project of several repos, one with no change (recorded as skipped, or not yet recorded) or
// already integrated, and the other awaiting its merge. A repo recorded for the delivery is settled: the base merge, and the
// adapter, leave it alone; so does a repo this ticket changes nothing in (merging into it would only run its gate steps again).


// `pending` waits for its merge; `other` is recorded as skipped (it has no change and comes first in the delivery order),
// recorded as delivered (it changed and landed), or not recorded at all (it has no change and comes after the pending repo).
const SHAPES = {
  skipped: { pending: 'web', other: 'api', changes: ['web'], recorded: (d) => d.skipped === 'no changes', refusal: /api is already settled in this delivery \(skipped, no changes\)/, line: /api: left as it is \(already settled in this delivery: skipped, no changes\)/ },
  delivered: { pending: 'web', other: 'api', changes: ['web', 'api'], recorded: (d) => Boolean(d.commit), refusal: /api is already settled in this delivery \(delivered [0-9a-f]{10}\)/, line: /api: left as it is \(already settled in this delivery: delivered [0-9a-f]{10}\)/ },
  idle: { pending: 'api', other: 'web', changes: ['api'], recorded: (d) => d === undefined, refusal: null, line: /web: left as it is \(this ticket changes nothing there, so the delivery skips it\)/ },
};
for (const [shape, x] of Object.entries(SHAPES)) {
  test(`I-183: several repos, one ${shape} and one awaiting its merge: the base comes into the waiting repo only, and the other is left as it is`, () => {
    const { base, root } = multiRepo(`mr-base-${shape}`, perRepoAdapter);
    const e = ok(wf(root, ['entry', '--item', 'ENG-185', '--owner', 'o', '--json'])).json();
    const wt = (n) => e.repos[n].worktree;
    const files = { web: { 'src/w.txt': 'web\n' }, api: { 'src/a.txt': 'api\n' } };
    accepted(root, base, e.id, x.changes.map((n) => [wt(n), files[n]]));
    if (shape === 'delivered') fs.writeFileSync(path.join(root, '..', 'merged.api'), '');
    assert.match(ok(wf(root, ['deliver', '--attempt', e.id])).out, new RegExp(`${x.pending}: awaiting-merge`));
    const settled = state(root, e.id).delivery.repos[x.other];
    assert.ok(x.recorded(settled), `${x.other} is recorded as expected (${shape}): ${JSON.stringify(settled)}`);
    const otherHead = headOf(wt(x.other));
    const reviewed = headOf(wt(x.pending));

    for (const [dir, file] of [[path.join(root, 'api'), 'src/b.txt'], [path.join(root, 'web'), 'src/x.txt']]) sh(dir, `git pull -q --ff-only origin main && printf 'new\\n' > ${file} && git add -A && git commit -qm 'base change' && git push -q origin main`);

    // Naming a repo the delivery recorded is refused, and says why; the waiting repo is the one the base comes into.
    if (x.refusal) {
      const refused = wf(root, ['base', 'merge', '--repo', x.other, '--attempt', e.id]);
      assert.equal(refused.code, 75);
      assert.match(refused.err, x.refusal);
      assert.equal(headOf(wt(x.other)), otherHead);
    }
    const m = ok(wf(root, ['base', 'merge', '--attempt', e.id]));
    assert.match(m.out, new RegExp(`${x.pending}: merged origin/main`));
    assert.match(m.out, x.line);
    assert.equal(headOf(wt(x.other)), otherHead, 'the other repo was not touched');
    assert.notEqual(headOf(wt(x.pending)), reviewed);
    assert.deepEqual(state(root, e.id).delivery.repos[x.other], settled, 'its delivery record is as it was');
    assert.equal(state(root, e.id).accepted, null);

    // Gate, review, accept again. The merge left the ticket's lines alone, so the code review still covers the change: a repo
    // recorded as delivered cannot change, and its diff no longer showing (its change is on the target) is not a change to review.
    const merged = headOf(wt(x.pending));
    // 0.7.34 (I-233, M1): the gate on the merged tree collected nothing new to inspect, so the evidence round stands.
    assert.deepEqual(reconcile(root, base, e.id, 'rev-again'), ['gate']);
    const before = integrations(root).length;
    assert.match(ok(wf(root, ['deliver', '--attempt', e.id])).out, new RegExp(`${x.pending}: awaiting-merge`));
    assert.deepEqual(integrations(root).slice(before), [`${x.pending} ${merged}`], 'only the waiting repo was integrated again');
    fs.writeFileSync(path.join(root, '..', `merged.${x.pending}`), '');
    ok(wf(root, ['deliver', '--attempt', e.id]));
    const after = state(root, e.id).delivery.repos;
    assert.equal(after[x.pending].commit, merged);
    if (shape === 'idle') assert.equal(after.web.skipped, 'no changes');
    else assert.deepEqual(after[x.other], settled);
  });
}


// The built-in push-main delivers repo by repo and merges the base itself for each; once a repo is recorded, `wf base merge`
// keeps its old answer for it (the refusal that was wrong for an adapter, whose delivery never merges the base).
test('I-183: with the built-in push-main, once a repo is recorded for the delivery wf base merge still refuses: wf deliver merges the base itself', () => {
  const base = tmp('pm-recorded');
  const root = path.join(base, 'ws');
  fs.mkdirSync(root);
  const cfg = {
    version: 1, enabled: true, name: 'pm-recorded', adapterRepo: 'api', lanes: ['quick', 'standard', 'batch'],
    repos: [{ name: 'api', path: 'api', base: 'main' }, { name: 'web', path: 'web', base: 'main' }],
    components: [{ id: 'api', kind: 'service', repo: 'api', provides: [{ contract: 'http', spec: 'openapi.json' }] }, { id: 'web', kind: 'web', repo: 'web', dependsOn: [{ component: 'api', via: 'http', contract: 'api/openapi.json' }] }],
    gate: { steps: [{ id: 'api-unit', repo: 'api', run: 'true', inputs: ['src/**'] }, { id: 'web-unit', repo: 'web', run: 'true', inputs: ['src/**'] }] },
  };
  makeRepo(path.join(root, 'api'), { '.workflow/project.yaml': yaml(cfg), 'openapi.json': '{}\n', 'src/a.txt': 'a\n' });
  makeRepo(path.join(root, 'web'), { 'src/w.txt': 'w\n' });
  fs.symlinkSync(path.join('api', '.workflow'), path.join(root, '.workflow'));
  const e = ok(wf(root, ['entry', '--item', 'ENG-189', '--owner', 'o', '--json'])).json();
  accepted(root, base, e.id, [[e.repos.web.worktree, { 'src/w.txt': 'web\n' }]]);
  // The base changes the same line the ticket changed: delivering web merges it and conflicts, after api was recorded as skipped.
  sh(path.join(root, 'web'), "printf 'other\\n' > src/w.txt && git commit -qam 'conflicting base change' && git push -q origin main");
  assert.match(wf(root, ['deliver', '--attempt', e.id]).err, /moved and conflicts/);
  assert.equal(state(root, e.id).delivery.repos.api.skipped, 'no changes');
  const r = wf(root, ['base', 'merge', '--attempt', e.id]);
  assert.equal(r.code, 75);
  assert.match(r.err, /is already being delivered; `wf deliver` merges the base itself/);
});
