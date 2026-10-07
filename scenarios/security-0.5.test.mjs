// 0.5.0 integration review: an adversarial pass over every change to engine/attempt.mjs and engine/lifecycle.mjs on the
// four 0.5.0 branches (adapter re-pin, impact queries, ledger writers, readback parsing). Each test reproduces one
// finding and fails without its fix.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeRepo, ok, sh, singleRepoProject, state, toAccepted, tmp, wf, write, yaml } from './helpers.mjs';
import { adapterFileAtCommit, loadConfig } from '../engine/config.mjs';

const steps = [{ id: 'unit', repo: 'app', run: 'true', inputs: ['src/**'] }];
const ledger = (root, id) => fs.readFileSync(path.join(root, '.wf-evidence', 'attempts', id, 'ledger.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));

// An adapter whose integrate opens a merge request and whose observe reports it pending.
const pendingAdapter = `
import { execFileSync } from 'node:child_process';
export default {
  integrate(ctx) { execFileSync('git', ['push', '-q', 'origin', 'HEAD:refs/heads/' + ctx.branch], { cwd: ctx.worktree }); return { url: 'https://git.example.test/mr/7' }; },
  observe() { return { state: 'awaiting-merge' }; },
  readback() { return { ok: true }; },
};`;

test('abandon: a change already on the target branch is never abandoned; an integration that can still land needs the owner\'s acknowledgement', () => {
  // On the target: the accepted commit reached main outside wf (or an adapter merged it); nothing is recorded yet.
  const a = singleRepoProject('abandon-landed', { gate: { steps } });
  const { id, wt } = toAccepted(a.root, a.base, { item: 'SEC-1' });
  sh(wt, 'git push -q origin HEAD:refs/heads/main');
  const landed = wf(a.root, ['abandon', '--reason', 'changed my mind', '--attempt', id]);
  assert.equal(landed.code, 75, landed.err);
  assert.match(landed.err, /SEC-1\.1 is not abandoned: its change is on the target branch \(app: [0-9a-f]{10} is already on origin\/main\)/);
  assert.equal(wf(a.root, ['abandon', '--reason', 'x', '--acknowledge-integration', 'app:none', '--attempt', id]).code, 75, 'no acknowledgement takes back a landed change');
  assert.notEqual(state(a.root, id).phase, 'abandoned');
  // Pending: the adapter opened a merge request that can still be merged.
  const b = singleRepoProject('abandon-pending', { delivery: { kind: './delivery/mr.mjs' }, gate: { steps } }, { '.workflow/delivery/mr.mjs': pendingAdapter });
  const p = toAccepted(b.root, b.base, { item: 'SEC-2' });
  assert.match(ok(wf(b.root, ['deliver', '--attempt', p.id])).out, /awaiting-merge/);
  const pending = wf(b.root, ['abandon', '--reason', 'no longer needed', '--attempt', p.id]);
  assert.equal(pending.code, 75);
  assert.match(pending.err, /not abandoned: the delivery adapter last reported app awaiting-merge \(https:\/\/git\.example\.test\/mr\/7\); that integration can still land[\s\S]*--acknowledge-integration app:awaiting-merge/);
  ok(wf(b.root, ['abandon', '--reason', 'the owner closed the merge request', '--acknowledge-integration', 'app:awaiting-merge', '--attempt', p.id]));
  assert.deepEqual(ledger(b.root, p.id).find((x) => x.type === 'abandoned').data.integrationsClosed, ['app:awaiting-merge']);
});

test('delivery record: an adapter result never sets the engine\'s fields (repo, commit, target, skipped) or the worktree it is called with', () => {
  const forging = `
import { execFileSync } from 'node:child_process';
export default {
  integrate(ctx) { execFileSync('git', ['push', '-q', 'origin', 'HEAD:refs/heads/main'], { cwd: ctx.worktree }); return { url: 'https://git.example.test/mr/9', repo: 'other', worktree: '/nowhere', commit: 'f00d' }; },
  observe(ctx) { if (ctx.worktree === '/nowhere') throw new Error('the recorded result replaced the worktree'); return { state: 'integrated' }; },
  readback() { return { ok: true, commit: '0000000000000000000000000000000000000000', target: 'elsewhere/main', skipped: 'forged', repo: 'other', mergeRequest: 9 }; },
};`;
  const { base, root } = singleRepoProject('forged-record', { delivery: { kind: './delivery/mr.mjs' }, gate: { steps } }, { '.workflow/delivery/mr.mjs': forging });
  const { id, wt } = toAccepted(root, base, { item: 'SEC-3' });
  const head = sh(wt, 'git rev-parse HEAD');
  ok(wf(root, ['deliver', '--attempt', id]));
  const d = state(root, id).delivery.repos.app;
  assert.equal(d.commit, head);
  assert.deepEqual([d.repo, d.target, d.skipped, d.url, d.mergeRequest], ['app', 'origin/main', undefined, 'https://git.example.test/mr/9', 9]);
  assert.equal(state(root, id).delivery.repos.other, undefined);
});

test('adapter code is materialised without following a link: a planted link is replaced, never written through', () => {
  const { root } = singleRepoProject('adapter-link', { gate: { steps } }, { '.workflow/plugins/p.mjs': 'export default {};\n' });
  const cfg = loadConfig(root);
  const commit = sh(root, 'git rev-parse HEAD');
  const first = adapterFileAtCommit(root, cfg, commit, './plugins/p.mjs');
  const victim = path.join(path.dirname(root), 'victim.txt');
  fs.writeFileSync(victim, 'untouched\n');
  fs.rmSync(first);
  fs.symlinkSync(victim, first);
  const again = adapterFileAtCommit(root, cfg, commit, './plugins/p.mjs');
  assert.equal(again, first);
  assert.equal(fs.readFileSync(victim, 'utf8'), 'untouched\n', 'the link target was not written');
  assert.ok(fs.lstatSync(again).isFile() && !fs.lstatSync(again).isSymbolicLink());
  assert.equal(fs.readFileSync(again, 'utf8').trim(), 'export default {};');
  assert.throws(() => adapterFileAtCommit(root, cfg, '../../outside', './plugins/p.mjs'), /not a commit id/);
  assert.throws(() => adapterFileAtCommit(root, cfg, commit, '../src/a.txt'), /outside the adapter folder/);
  // A linked folder on the way is refused too.
  const linked = path.join(root, '.wf-evidence', 'adapters', commit);
  fs.rmSync(linked, { recursive: true });
  fs.mkdirSync(path.join(path.dirname(root), 'elsewhere'));
  fs.symlinkSync(path.join(path.dirname(root), 'elsewhere'), linked);
  assert.throws(() => adapterFileAtCommit(root, cfg, commit, './plugins/p.mjs'), /not a real folder inside the project/);
});

function attemptWithPlan(name, config = {}, files = {}) {
  const p = singleRepoProject(name, { gate: { steps }, ...config }, files);
  const e = ok(wf(p.root, ['entry', '--item', 'SEC-5', '--owner', 'o', '--json'])).json();
  return { ...p, e };
}

test('impact queries read the repos and limits of the adapter at the base, never the working tree\'s copy', () => {
  const { base, root, e } = attemptWithPlan('impact-trusted');
  // Another checkout on the machine, with a line the query looks for.
  makeRepo(path.join(base, 'other'), { 'notes.txt': 'planted-line-from-another-checkout\n' });
  const q = JSON.stringify({ pattern: 'planted-line-from-another-checkout', kind: 'literal', repo: 'extra' });
  // Uncommitted edit of the adapter in the project root: a repo the base adapter never had, pointed at that checkout.
  const file = path.join(root, '.workflow', 'project.yaml');
  const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
  write(root, '.workflow/project.yaml', yaml({ ...cfg, repos: [...cfg.repos, { name: 'extra', path: '../other', base: 'main' }] }));
  const r = wf(root, ['impact', 'run', '--attempt', e.id, '--query', q]);
  assert.equal(r.code, 75, `${r.out}${r.err}`);
  assert.match(r.err, /unknown repo `extra` in the adapter at the attempt's base/);
  assert.doesNotMatch(r.out, /notes\.txt/);
});

test('a regex query that backtracks without end is stopped and refused, never a hang', () => {
  const { root, e } = attemptWithPlan('impact-regex', { impact: { regexTimeoutMs: 1500 } }, { 'src/slow.txt': `${'a'.repeat(40)}!\n` });
  const t = Date.now();
  const r = wf(root, ['impact', 'run', '--attempt', e.id, '--query', JSON.stringify({ pattern: '^(a+)+$', kind: 'regex', paths: ['src/**'] })]);
  assert.equal(r.code, 75, `${r.out}${r.err}`);
  assert.match(r.err, /the regex ran longer than 2 s and was stopped[\s\S]*no nested quantifiers/);
  assert.ok(Date.now() - t < 30000, 'refused within the limit, not after the pattern finished');
  // An ordinary regex still counts.
  assert.match(ok(wf(root, ['impact', 'run', '--attempt', e.id, '--query', JSON.stringify({ pattern: '^a+!$', kind: 'regex', paths: ['src/**'] })])).out, /1 file/);
});
