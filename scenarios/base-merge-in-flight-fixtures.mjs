// Fixtures shared by the base-merge-in-flight scenarios (0.7.26, I-183): adapters that open a request and wait for its merge,
// and the steps that bring an accepted attempt back to its acceptance after a base merge.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { closureFile, goodClosure, ok, sh, state, wf } from './helpers.mjs';

// Pushes the branch on every `integrate` (the merge request's source) and logs the commit it pushed; `observe` reports
// `awaiting-merge` until a person has merged the request (HEAD is on main), as a manual adapter does.
export const mrAdapter = `
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
const at = (ctx, n) => ctx.root + '/../' + n;
const onMain = (ctx) => {
  execFileSync('git', ['fetch', '-q', 'origin', 'main'], { cwd: ctx.worktree });
  try { execFileSync('git', ['merge-base', '--is-ancestor', 'HEAD', 'origin/main'], { cwd: ctx.worktree }); return true; } catch { return false; }
};
export default {
  integrate(ctx) {
    execFileSync('git', ['push', '-q', '-f', 'origin', 'HEAD:refs/heads/' + ctx.branch], { cwd: ctx.worktree });
    fs.appendFileSync(at(ctx, 'integrate.log'), ctx.repo.name + ' ' + execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ctx.worktree, encoding: 'utf8' }));
    return { url: 'https://git.example.test/mr/183' };
  },
  observe(ctx) { return { state: onMain(ctx) ? 'integrated' : 'awaiting-merge' }; },
  readback(ctx) { return { ok: onMain(ctx) }; },
};`;
export const integrations = (root) => (fs.existsSync(path.join(root, '..', 'integrate.log')) ? fs.readFileSync(path.join(root, '..', 'integrate.log'), 'utf8').split('\n').filter(Boolean) : []);
export const headOf = (dir) => sh(dir, 'git rev-parse HEAD');
// Runs whatever the engine names next until it names the acceptance: a code review where the base merge changed the
// ticket's change (or a delivered repo's change looks gone), the gate, the evidence review. Returns the steps it ran.
export function reconcile(root, base, id, who) {
  const ran = [];
  for (let n = 0; n < 6; n++) {
    const d = state(root, id).decision;
    if (d.kind === 'accept') break;
    assert.equal(d.status, 'ready', `${d.kind}: ${d.blockers?.join('; ')}`);
    if (d.kind === 'gate') ok(wf(root, ['gate', '--attempt', id]));
    else if (d.kind === 'review') {
      ok(wf(root, ['handoff', 'reviewer', '--agent', `${who}-${n}`, '--attempt', id]));
      ok(wf(root, ['review', '--closure', closureFile(base, goodClosure(`${who}-${n}`)), '--attempt', id]));
    } else assert.fail(`unexpected next step ${d.kind}`);
    ran.push(d.kind === 'review' ? d.round : d.kind);
  }
  ok(wf(root, ['accept', '--attempt', id]));
  return ran;
}

// One adapter for a project of several repos: every `integrate` pushes the branch (and lands HEAD on main once the scenario has
// written `merged.<repo>` beside the project), `observe` reports `integrated` only for those, and each integrate is logged.
export const perRepoAdapter = `
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
const at = (ctx, n) => ctx.root + '/../' + n;
export default {
  integrate(ctx) {
    execFileSync('git', ['push', '-q', '-f', 'origin', 'HEAD:refs/heads/' + ctx.branch], { cwd: ctx.worktree });
    if (fs.existsSync(at(ctx, 'merged.' + ctx.repo.name))) execFileSync('git', ['push', '-q', 'origin', 'HEAD:refs/heads/main'], { cwd: ctx.worktree });
    fs.appendFileSync(at(ctx, 'integrate.log'), ctx.repo.name + ' ' + execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ctx.worktree, encoding: 'utf8' }));
    return { url: 'https://git.example.test/mr/' + ctx.repo.name };
  },
  observe(ctx) {
    return fs.existsSync(at(ctx, 'merged.' + ctx.repo.name)) ? { state: 'integrated' } : { state: 'awaiting-merge' };
  },
  readback() { return { ok: true }; },
};`;
