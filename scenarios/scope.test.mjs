// 0.1.13: scope control. Named failures: an implementer changed audit-read code outside the plan and the reviewer
// marked it minor; a capture fix and an e2e build change with .gitignore entries were covered by no criterion until the
// owner amended the criteria after the review.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { closureFile, commitIn, goodClosure, ok, planDoc, singleRepoProject, state, wf } from './helpers.mjs';

const plan = { plan: { summary: 's', anchors: ['src/a.txt:1 the text'], tests: { changed: ['test/a.test.js'] } }, criteria: [{ id: 'C1', text: 'a changes', uat: 'a shows the new text' }, { id: 'C2', text: 'audit read is logged', uat: false }] };
const repos = [{ name: 'app', path: '.', base: 'main', packages: [{ path: '.', docsOnly: ['docs/**'] }] }];
const steps = [{ id: 'unit', repo: 'app', run: 'true', inputs: ['src/**', 'test/**'], ignores: ['gen/**'] }];

function project(name, change, p = plan) {
  const proj = singleRepoProject(name, { repos, gate: { steps } });
  const e = ok(wf(proj.root, ['entry', '--item', 'ENG-90', '--owner', 'o', '--json'])).json();
  ok(wf(proj.root, ['handoff', 'planner', '--agent', 'p', '--attempt', e.id]));
  const f = path.join(proj.base, 'plan.json');
  fs.writeFileSync(f, JSON.stringify(planDoc(p)));
  ok(wf(proj.root, ['plan', '--file', f, '--attempt', e.id]));
  ok(wf(proj.root, ['handoff', 'implementer', '--agent', 'i', '--attempt', e.id]));
  commitIn(e.repos.app.worktree, change);
  return { ...proj, id: e.id };
}

const change = { 'src/a.txt': 'b\n', 'test/a.test.js': 't\n', 'src/audit.txt': 'x\n', '.gitignore': '.wf-evidence/\n.wf-worktrees/\ne2e-out/\n', 'docs/notes.md': 'n\n', 'gen/client.ts': 'g\n' };

test('outside the plan: the owner is warned before the review; accept needs a verdict per file; docs-only and ignored files are not listed', () => {
  const { base, root, id } = project('scope-verdicts', change);
  const warn = /warning: 2 changed file\(s\) outside the plan: app:\.gitignore, app:src\/audit\.txt — amend the criteria/;
  assert.match(ok(wf(root, ['status'])).out, warn);
  assert.match(ok(wf(root, ['resume', '--attempt', id])).out, warn);
  assert.match(ok(wf(root, ['check', '--attempt', id])).out, /wf check: warning: 2 changed file\(s\) outside the plan/);
  const g = ok(wf(root, ['gate', '--attempt', id]));
  assert.ok(g.out.indexOf('wf gate: warning: 2 changed file(s) outside the plan') < g.out.indexOf('wf gate: run'), 'warned before the gate starts');
  const h = ok(wf(root, ['handoff', 'reviewer', '--agent', 'r', '--attempt', id]));
  assert.match(h.err, /warning: 2 changed file\(s\) outside the plan/, 'the owner is told at the handoff');
  assert.doesNotMatch(h.out, /outside the plan/, 'the reviewer\'s one-line prompt carries nothing else');
  const bundle = JSON.parse(fs.readFileSync(state(root, id).handoffs.at(-1).bundle, 'utf8'));
  assert.deepEqual(bundle.outsidePlan, ['app:.gitignore', 'app:src/audit.txt'], 'docsOnly and ignored (generated) files are not scope');

  ok(wf(root, ['review', '--closure', closureFile(base, goodClosure('r')), '--attempt', id]));
  const none = wf(root, ['accept', '--attempt', id]);
  assert.equal(none.code, 75);
  assert.match(none.err, /2 changed file\(s\) outside the plan without a valid verdict/);
  assert.match(none.err, /app:\.gitignore: no verdict/);
  assert.match(none.err, /app:src\/audit\.txt: no verdict/);
  assert.match(none.err, /wf criteria amend/);

  // `covered` must name a real criterion; anything else is a finding.
  ok(wf(root, ['review', '--closure', closureFile(base, goodClosure('r', { outsidePlan: [{ file: 'app:src/audit.txt', verdict: 'covered', by: 'C9', evidence: 'audit' }, { file: 'app:.gitignore', verdict: 'finding', by: 'F1', evidence: 'unplanned' }] })), '--attempt', id]));
  const bad = wf(root, ['accept', '--attempt', id]).err;
  assert.match(bad, /app:src\/audit\.txt: covered by `C9`, which is not a criterion/);
  assert.match(bad, /app:\.gitignore: a finding verdict names a finding id/);

  const findings = [{ id: 'F1', severity: 'minor', summary: 'e2e output ignored without a criterion', status: 'fixed', evidence: '.gitignore:3' }];
  const criteria = [{ id: 'C1', evidence: { kind: 'output', ref: 'gate log line 1' } }, { id: 'C2', evidence: { kind: 'test', ref: 'test/a.test.js audit' } }];
  ok(wf(root, ['review', '--closure', closureFile(base, goodClosure('r', { findings, criteria, outsidePlan: [{ file: 'app:src/audit.txt', verdict: 'covered', by: 'C2', evidence: 'C2 logs the audit read' }, { file: '.gitignore', verdict: 'finding', by: 'F1', evidence: '.gitignore:3' }] })), '--attempt', id]));
  ok(wf(root, ['accept', '--attempt', id]));
  assert.deepEqual(state(root, id).accepted.outsidePlan.map((v) => [v.file, v.verdict, v.by]), [['app:.gitignore', 'finding', 'F1'], ['app:src/audit.txt', 'covered', 'C2']]);
  assert.doesNotMatch(ok(wf(root, ['status', '--attempt', id])).out, /outside the plan/, 'no warning once accepted');
  ok(wf(root, ['export', '--attempt', id]));
  const html = fs.readFileSync(path.join(root, '.wf-evidence', 'attempts', id, 'export', 'attempt.html'), 'utf8');
  assert.match(html, /<h2>Outside the plan<\/h2>/);
  assert.match(html, /C2 logs the audit read/);
});

test('outside the plan: a plan that names no paths requires nothing', () => {
  const { base, root, id } = project('scope-none', { 'src/a.txt': 'b\n', 'src/audit.txt': 'x\n' }, { plan: 'change a', criteria: [{ id: 'C1', text: 'a', uat: 'a' }] });
  assert.doesNotMatch(ok(wf(root, ['status'])).out, /outside the plan/);
  ok(wf(root, ['gate', '--attempt', id]));
  ok(wf(root, ['handoff', 'reviewer', '--agent', 'r', '--attempt', id]));
  ok(wf(root, ['review', '--closure', closureFile(base, goodClosure('r')), '--attempt', id]));
  ok(wf(root, ['accept', '--attempt', id]));
});
