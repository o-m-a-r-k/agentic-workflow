// Fixtures shared by the adapter-fault scenarios (I-20, I-21, I-22): adapters that fault, the fix, the documented
// re-pin and an accepted attempt. adapter-fault.test.mjs covers single-repo and partly delivered attempts,
// adapter-fault-shapes.test.mjs the skipped repo, the quick lane and a batch; two files so they run side by side.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { closureFile, commitIn, criteriaFile, goodClosure, makeRepo, ok, OUT_OF_ORDER, sh, state, tmp, wf, yaml } from './helpers.mjs';

export const steps = [{ id: 'unit', repo: 'app', run: 'true', inputs: ['src/**'] }];

// Pushes HEAD to main only when the repo is not named in `.../noPush`; reports the state written in `.../observe.state`
// (or, per repo, `.../observe.<repo>.state`), and counts each observe call.
export const scriptedAdapter = `import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
const at = (ctx, n) => ctx.root + '/../' + n;
const read = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim() : null);
export default {
  integrate(ctx) {
    if (read(at(ctx, 'push.' + ctx.repo.name)) !== 'no') execFileSync('git', ['push', '-q', 'origin', 'HEAD:refs/heads/main'], { cwd: ctx.worktree });
    return { url: 'https://git.example.test/mr/' + ctx.repo.name };
  },
  observe(ctx) {
    fs.appendFileSync(at(ctx, 'observed.log'), ctx.repo.name + '\\n');
    const st = read(at(ctx, 'observe.' + ctx.repo.name + '.state')) ?? read(at(ctx, 'observe.state')) ?? 'integrated';
    return st === '(none)' ? { evidence: 'pipeline 9' } : { state: st, evidence: 'pipeline 9' };
  },
  readback() { return { ok: true }; },
};`;
// Reports a state that is not documented and pushes nothing.
export const brokenAdapter = `export default { integrate() { return { url: 'https://git.example.test/mr/x' }; }, observe() { return { state: 'merged' }; }, readback() { return { ok: true }; } };`;
// The fix: pushes HEAD to main and reports `integrated`.
export const fixedAdapter = `import { execFileSync } from 'node:child_process';
export default {
  integrate(ctx) {
    execFileSync('git', ['pull', '-q', '--no-rebase', '--no-edit', 'origin', 'main'], { cwd: ctx.worktree });
    execFileSync('git', ['push', '-q', 'origin', 'HEAD:refs/heads/main'], { cwd: ctx.worktree });
    return { url: 'https://git.example.test/mr/y' };
  },
  observe() { return { state: 'integrated' }; },
  readback() { return { ok: true }; },
};`;

export const observedCalls = (root) => (fs.existsSync(path.join(root, '..', 'observed.log')) ? fs.readFileSync(path.join(root, '..', 'observed.log'), 'utf8').split('\n').filter(Boolean).length : 0);
export const ledger = (root, id) => fs.readFileSync(path.join(root, '.wf-evidence', 'attempts', id, 'ledger.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));

// Commits and pushes the fixed adapter on the base branch of the repo holding `.workflow/`.
export function pushFix(dir, rel = '.workflow/delivery/mr.mjs') {
  sh(dir, 'git checkout -q main && git pull -q --ff-only origin main');
  fs.writeFileSync(path.join(dir, rel), fixedAdapter);
  sh(dir, 'git add -A && git commit -qm "fix the delivery adapter" && git push -q origin main');
  return sh(dir, 'git rev-parse HEAD');
}

// The documented recovery: the refusal without a commit shows what changes; the owner's confirmation is the tip typed
// back; it is recorded with both pins and the reason.
export function repin(root, id, tip, { delivered = 'nothing yet', left, failFirst = null }) {
  const preview = wf(root, ['deliver', '--attempt', id, '--repin-adapter', '--reason', 'the delivery adapter reported an undocumented state']);
  assert.equal(preview.code, 75, preview.err);
  assert.match(preview.err, new RegExp(`from: \\S+@[0-9a-f]{10} \\(delivery kind ./delivery/mr.mjs\\)\\n  to:   \\S+@${tip.slice(0, 10)}, the tip of origin/main`));
  assert.match(preview.err, /adapter files that differ: \.workflow\/delivery\/mr\.mjs/);
  assert.match(preview.err, new RegExp(`recorded so far: ${delivered}`));
  assert.match(preview.err, new RegExp(`still to deliver: ${left}`));
  assert.match(preview.err, /the gate, the review and the tracker stay on the admission pin/);
  assert.match(preview.err, new RegExp(`\`wf deliver --repin-adapter ${tip.slice(0, 12)} --reason "<why>"\``));
  assert.match(wf(root, ['deliver', '--attempt', id, '--repin-adapter', 'deadbeef00', '--reason', 'x']).err, new RegExp(`deadbeef00 is not the tip of origin/main \\(${tip.slice(0, 10)}\\)`));
  assert.match(wf(root, ['deliver', '--attempt', id, '--repin-adapter', tip.slice(0, 12)]).err, /--reason is required/);
  assert.equal(state(root, id).deliveryAdapterBase, null, 'nothing re-pinned by a refused try');
  const before = state(root, id).adapterBase;
  const confirm = () => wf(root, ['deliver', '--attempt', id, '--repin-adapter', tip.slice(0, 12), '--reason', 'the delivery adapter reported an undocumented state']);
  if (failFirst) {
    // A later step fails after the re-pin was recorded: the same command is accepted again (not refused as "already at
    // the tip"), and the re-pin is recorded once.
    const restore = failFirst();
    assert.notEqual(confirm().code, 0);
    assert.equal(state(root, id).deliveryAdapterBase, tip);
    restore();
  }
  const d = ok(confirm());
  assert.equal(ledger(root, id).filter((e) => e.type === 'adapter.repinned').length, 1);
  const s = state(root, id);
  assert.equal(s.deliveryAdapterBase, tip, 'delivery reads the adapter at the base tip');
  assert.equal(s.adapterBase, before, 'the admission pin (gate, review, tracker) is unchanged');
  const rec = ledger(root, id).find((e) => e.type === 'adapter.repinned');
  assert.equal(rec.data.from, before);
  assert.equal(rec.data.to, tip);
  assert.equal(rec.data.reason, 'the delivery adapter reported an undocumented state');
  assert.match(d.out, new RegExp(`delivery adapter re-pinned from ${before.slice(0, 10)} to ${tip.slice(0, 10)}`));
  return s;
}

export function accepted(root, base, id, wt, change, { planner = true } = {}) {
  if (planner) ok(wf(root, ['handoff', 'planner', '--agent', `p-${id}`, '--attempt', id]));
  ok(wf(root, ['plan', '--file', criteriaFile(base), '--attempt', id]));
  ok(wf(root, ['handoff', 'implementer', '--agent', `i-${id}`, '--attempt', id]));
  for (const [w, files] of wt) commitIn(w, files);
  ok(wf(root, ['gate', ...OUT_OF_ORDER, '--attempt', id]));
  ok(wf(root, ['handoff', 'reviewer', '--agent', `r-${id}`, '--attempt', id]));
  ok(wf(root, ['review', '--closure', closureFile(base, goodClosure(`r-${id}`)), '--attempt', id]));
  ok(wf(root, ['accept', '--attempt', id]));
}

export function multiRepo(name, adapter) {
  const base = tmp(name);
  const root = path.join(base, 'ws');
  fs.mkdirSync(root);
  const cfg = {
    version: 1,
    enabled: true,
    name,
    adapterRepo: 'api',
    repos: [{ name: 'api', path: 'api', base: 'main' }, { name: 'web', path: 'web', base: 'main' }],
    lanes: ['quick', 'standard', 'batch'],
    components: [
      { id: 'api', kind: 'service', repo: 'api', provides: [{ contract: 'http', spec: 'openapi.json' }] },
      { id: 'web', kind: 'web', repo: 'web', dependsOn: [{ component: 'api', via: 'http', contract: 'api/openapi.json' }] },
    ],
    delivery: { kind: './delivery/mr.mjs' },
    gate: { steps: [{ id: 'api-unit', repo: 'api', run: 'true', inputs: ['src/**'] }, { id: 'web-unit', repo: 'web', run: 'true', inputs: ['src/**'] }] },
  };
  makeRepo(path.join(root, 'api'), { '.workflow/project.yaml': yaml(cfg), '.workflow/delivery/mr.mjs': adapter, 'openapi.json': '{}\n', 'src/a.txt': 'a\n' });
  makeRepo(path.join(root, 'web'), { 'src/w.txt': 'w\n' });
  fs.symlinkSync(path.join('api', '.workflow'), path.join(root, '.workflow'));
  return { base, root };
}
