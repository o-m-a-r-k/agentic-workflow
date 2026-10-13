// 0.1.13: scope control. Named failures: an implementer changed audit-read code outside the plan and the reviewer
// marked it minor; a capture fix and an e2e build change with .gitignore entries were covered by no criterion until the
// owner amended the criteria after the review.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { closureFile, commitIn, goodClosure, ok, OUT_OF_ORDER, planDoc, singleRepoProject, state, wf } from './helpers.mjs';

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

const criteria = [{ id: 'C1', evidence: { kind: 'output', ref: 'gate log line 1' } }, { id: 'C2', evidence: { kind: 'test', ref: 'test/a.test.js audit' } }];

// 0.7.0 (goals, not forms): the files outside the plan are told to the owner before the review and listed in the reviewer's
// bundle as context, but the reviewer owes no verdict per file (named failure: the form measured compliance with the form,
// not defects; a change no criterion covers is a finding when the reviewer sees it hurt, or the owner amends the criteria).
test('outside the plan: the owner is warned before the review and the bundle lists the files; acceptance asks for no verdict per file; docs-only and ignored files are not listed', () => {
  const { base, root, id } = project('scope-verdicts', change);
  const warn = /warning: 2 changed file\(s\) outside the plan: app:\.gitignore, app:src\/audit\.txt — amend the criteria/;
  assert.match(ok(wf(root, ['status'])).out, warn);
  assert.match(ok(wf(root, ['resume', '--attempt', id])).out, warn);
  assert.match(ok(wf(root, ['check', '--attempt', id])).out, /wf check: warning: 2 changed file\(s\) outside the plan/);
  const g = ok(wf(root, ['gate', ...OUT_OF_ORDER, '--attempt', id]));
  assert.ok(g.out.indexOf('wf gate: warning: 2 changed file(s) outside the plan') < g.out.indexOf('wf gate: run'), 'warned before the gate starts');
  const h = ok(wf(root, ['handoff', 'reviewer', '--agent', 'r', '--attempt', id]));
  assert.match(h.err, /warning: 2 changed file\(s\) outside the plan/, 'the owner is told at the handoff');
  assert.doesNotMatch(h.out, /outside the plan/, 'the reviewer\'s one-line prompt carries nothing else');
  const bundle = JSON.parse(fs.readFileSync(state(root, id).handoffs.at(-1).bundle, 'utf8'));
  assert.deepEqual(bundle.outsidePlan, ['app:.gitignore', 'app:src/audit.txt'], 'docsOnly and ignored (generated) files are not scope');

  ok(wf(root, ['review', '--closure', closureFile(base, goodClosure('r', { criteria })), '--attempt', id]));
  ok(wf(root, ['accept', '--attempt', id]));
  assert.equal(state(root, id).accepted.outsidePlan, undefined, 'no verdict was given, so none is recorded');
  assert.doesNotMatch(ok(wf(root, ['status', '--attempt', id])).out, /outside the plan/, 'no warning once accepted');
});

test('outside the plan: the verdicts a reviewer gives are recorded with the acceptance and shown in the export', () => {
  const { base, root, id } = project('scope-given', change);
  ok(wf(root, ['gate', ...OUT_OF_ORDER, '--attempt', id]));
  ok(wf(root, ['handoff', 'reviewer', '--agent', 'r', '--attempt', id]));
  const findings = [{ id: 'F1', severity: 'minor', summary: 'e2e output ignored without a criterion', status: 'fixed', evidence: '.gitignore:3' }];
  ok(wf(root, ['review', '--closure', closureFile(base, goodClosure('r', { findings, criteria, outsidePlan: [{ file: 'app:src/audit.txt', verdict: 'covered', by: 'C2', evidence: 'C2 logs the audit read' }, { file: '.gitignore', verdict: 'finding', by: 'F1', evidence: '.gitignore:3' }] })), '--attempt', id]));
  ok(wf(root, ['accept', '--attempt', id]));
  assert.deepEqual(state(root, id).accepted.outsidePlan.map((v) => [v.file, v.verdict, v.by]), [['app:.gitignore', 'finding', 'F1'], ['app:src/audit.txt', 'covered', 'C2']]);
  ok(wf(root, ['export', '--attempt', id]));
  const html = fs.readFileSync(path.join(root, '.wf-evidence', 'attempts', id, 'export', 'attempt.html'), 'utf8');
  assert.match(html, /<h2>Outside the plan<\/h2>/);
  assert.match(html, /C2 logs the audit read/);
});

test('outside the plan: a plan that names no paths requires nothing', () => {
  const { base, root, id } = project('scope-none', { 'src/a.txt': 'b\n', 'src/audit.txt': 'x\n' }, { plan: 'change a', criteria: [{ id: 'C1', text: 'a', uat: 'a' }] });
  assert.doesNotMatch(ok(wf(root, ['status'])).out, /outside the plan/);
  ok(wf(root, ['gate', ...OUT_OF_ORDER, '--attempt', id]));
  ok(wf(root, ['handoff', 'reviewer', '--agent', 'r', '--attempt', id]));
  ok(wf(root, ['review', '--closure', closureFile(base, goodClosure('r')), '--attempt', id]));
  ok(wf(root, ['accept', '--attempt', id]));
});
