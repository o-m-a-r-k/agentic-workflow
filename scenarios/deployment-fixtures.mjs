import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { readLedger } from '../engine/ledger.mjs';
import { closureFile, commitIn, criteriaFile, goodClosure, ok, singleRepoProject, summaryFile, wf, yaml } from './helpers.mjs';

// Shared by the deployment confirmation scenarios (deployment-confirmation, deployment-checks): two files, so each stays short.
//
// 0.7.27 (I-196, D42), named failure (field): a project's hotfix tickets (labelled "Hotfix") end their delivery with the final
// status, but only once the merged change is confirmed running where it deploys (a merge deploys it automatically, minutes later)
// and the fix was tested there where possible; every other ticket goes to UAT at the merge. The last tracker event was
// `delivered`, so a label route to Done could only fire at the merge, before anything was deployed or tested; the agent checked
// the deployment and the data by hand and had no step to record either, nor to set the status. `delivery.deployment` makes the
// delivery continue after the merge: the deployment is confirmed and the fix tested (or why not recorded), through `wf`, and
// only then the `deployed` tracker step runs (a comment, then the routed status).

export const statuses = { started: 'In progress', delivered: 'In UAT', deployed: 'Done', done: 'Done' };
export const routes = { delivered: { 'Hotfix': 'In progress' } };
export const TS = { labels: ['Hotfix'], where: 'production' };
export const ticket = (id, labels) => `---\n${yaml({ id, title: 'Fix the totals', status: 'Todo', labels }).trim()}\n---\nThe totals page shows the right total.\n`;
export const steps = [{ id: 'unit', repo: 'app', run: 'true' }];

// The project the person described: hotfix tickets routed away from UAT at the merge and to Done once deployed and tested.
export function project(name, { deployment = TS, delivery = {}, tracker = {}, files = {} } = {}) {
  return singleRepoProject(name, {
    tracker: { kind: 'files', statuses, statusByLabel: routes, deliveredComment: 'uat.md', ...tracker },
    delivery: { kind: 'push-main', ...(deployment ? { deployment } : {}), ...delivery },
    gate: { steps },
  }, {
    '.workflow/uat.md': '{id} is ready for UAT.\n\nUAT scope:\n{uatScope}\n',
    'tickets/ENG-500.md': ticket('ENG-500', ['Hotfix', 'billing']),
    'tickets/ENG-501.md': ticket('ENG-501', ['billing']),
    ...files,
  });
}
export const ticketFile = (root, item) => fs.readFileSync(path.join(root, 'tickets', `${item}.md`), 'utf8');
export const statusOf = (root, item) => /^status: (.*)$/m.exec(ticketFile(root, item))?.[1];
export const types = (root, id) => readLedger(root, id).map((e) => e.type);
export const deliver = (p, id) => ok(wf(p.root, ['deliver', '--attempt', id, '--summary-file', summaryFile(p.base)]));
export const dep = (p, id, args, opts) => wf(p.root, ['deployment', ...args, '--attempt', id], opts);
export const resume = (p, id) => ok(wf(p.root, ['resume', '--attempt', id])).out;

// Through a connector the agent posts the comment and sets the status; the readback is judged as every step's is.
export function connector(name) {
  const { base, root } = singleRepoProject(name, { tracker: { kind: 'linear', via: 'connector', statuses, statusByLabel: routes, deliveredComment: 'uat.md' }, delivery: { kind: 'push-main', deployment: TS }, gate: { steps } }, { '.workflow/uat.md': '{id} is ready for UAT.\n\nUAT scope:\n{uatScope}\n' });
  let n = 0;
  const at = () => new Date(Date.now() + 1000 * ++n).toISOString();
  const file = (name, text) => {
    const f = path.join(base, `${name}-${++n}`);
    fs.writeFileSync(f, text);
    return f;
  };
  const sha = (t) => crypto.createHash('sha256').update(t).digest('hex');
  const run = (item, labels) => {
    const e = ok(wf(root, ['entry', '--item', item, '--json'])).json();
    const id = e.id;
    const rec = (event, r, extra = []) => wf(root, ['tracker', 'record', '--event', event, '--agent-reported', '--file', file('reported.json', JSON.stringify(r)), '--attempt', id, ...extra]);
    ok(rec('admitted', { issue: item, title: 'Fix the totals', description: 'The totals page shows the right total.', status: 'In progress', labels, readAt: at() }));
    ok(wf(root, ['handoff', 'planner', '--agent', 'p', '--attempt', id]));
    ok(wf(root, ['plan', '--file', criteriaFile(base), '--attempt', id]));
    ok(wf(root, ['handoff', 'implementer', '--agent', 'i', '--attempt', id]));
    ok(rec('implementing', { issue: item, title: 'Fix the totals', description: 'The totals page shows the right total.', status: 'In progress', readAt: at() }));
    commitIn(e.repos.app.worktree, { [`src/${item}.txt`]: 'fix\n' });
    ok(wf(root, ['handoff', 'reviewer', '--agent', 'r', '--attempt', id]));
    ok(wf(root, ['review', '--closure', closureFile(base, goodClosure('r')), '--attempt', id]));
    ok(wf(root, ['gate', '--attempt', id]));
    ok(wf(root, ['handoff', 'reviewer', '--agent', 'r2', '--attempt', id]));
    ok(wf(root, ['review', '--closure', closureFile(base, goodClosure('r2')), '--attempt', id]));
    ok(wf(root, ['accept', '--attempt', id]));
    ok(wf(root, ['deliver', '--attempt', id, '--summary-file', summaryFile(base)]));
    return { id, rec };
  };
  // A readback whose comment is `body`, posted as it is.
  const post = ({ rec }, event, item, status, body, labels) => rec(event, { issue: item, status, ...(labels ? { labels } : {}), comment: { id: `c${n}`, bodySha256: sha(body), createdAt: at() }, attachments: [], readAt: at() }, ['--comment-file', file('posted.md', body)]);
  const delivered = (id) => fs.readFileSync(path.join(root, '.wf-evidence', 'attempts', id, 'delivery', 'delivered-comment.md'), 'utf8');
  return { root, run, post, delivered };
}

// A delivery adapter that merges by hand and knows what runs where it deploys: its read-only `deployment` check decides.
export const mergeAdapter = `
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
const running = (root) => root + '/../running.json';
export default {
  integrate(ctx) {
    execFileSync('git', ['push', '-q', 'origin', 'HEAD:refs/heads/' + ctx.branch], { cwd: ctx.worktree });
    return { url: 'https://git.example.test/mr/9' };
  },
  observe(ctx) {
    execFileSync('git', ['push', '-q', 'origin', 'HEAD:refs/heads/main'], { cwd: ctx.worktree });
    return { state: 'integrated' };
  },
  readback() { return { ok: true }; },
  deployment(ctx) {
    if (!fs.existsSync(running(ctx.root))) return { state: 'deploying', evidence: 'rollout: 1 of 3 replicas updated' };
    const now = JSON.parse(fs.readFileSync(running(ctx.root), 'utf8')).commit;
    return now === ctx.commit && ctx.url === 'https://git.example.test/mr/9' && ctx.where === 'production' ? { state: 'deployed', evidence: '3 of 3 replicas run the merged version' } : { state: 'failed', evidence: 'the replicas run another version' };
  },
};`;
