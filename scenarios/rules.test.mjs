// 0.1.12: review rules. Named failure: in eleven review rounds no reviewer read any of the project's rule documents,
// and the required skill was only checked as installed (and only when screenshots existed).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { closureFile, commitIn, criteriaFile, goodClosure, ok, OUT_OF_ORDER, singleRepoProject, state, wf, write } from './helpers.mjs';

const steps = [{ id: 'unit', repo: 'app', run: 'true', inputs: ['**'] }];
const review = { rules: [{ id: 'ui', read: ['docs/ui.md'] }, { id: 'api', paths: ['api/**'], read: ['docs/api.md', 'docs/errors.md'] }, { id: 'cli', paths: ['cli/**'], read: ['docs/cli.md'] }] };
const requires = { skills: [{ name: 'design-review', roles: ['reviewer'], when: { paths: ['web/**'] } }] };
const files = {
  'docs/ui.md': '---\npaths: ["web/**"]\n---\n# UI rules\nUse the design tokens.\n',
  'docs/api.md': '# API rules\nErrors are typed.\n',
  'docs/errors.md': '# Error codes\n',
  'docs/cli.md': '# CLI rules\n',
  '.claude/skills/design-review/SKILL.md': '---\nname: design-review\ndescription: d\n---\nReview the design.\n',
  'web/a.txt': 'w\n',
  'api/a.txt': 'a\n',
};
const homeOf = (root) => path.join(root, '..', '.home');

function project(name, change = { 'web/a.txt': 'w2\n', 'api/a.txt': 'a2\n' }) {
  const p = singleRepoProject(name, { gate: { steps }, review, requires }, files);
  const e = ok(wf(p.root, ['entry', '--item', 'ENG-80', '--owner', 'o', '--json'])).json();
  ok(wf(p.root, ['handoff', 'planner', '--agent', 'p', '--attempt', e.id]));
  ok(wf(p.root, ['plan', '--file', criteriaFile(p.base), '--attempt', e.id]));
  ok(wf(p.root, ['handoff', 'implementer', '--agent', 'i', '--attempt', e.id]));
  commitIn(e.repos.app.worktree, change);
  return { ...p, id: e.id, wt: e.repos.app.worktree };
}

const bundleOf = (root, id, agent) => JSON.parse(fs.readFileSync(ok(wf(root, ['handoff', 'reviewer', '--agent', agent, '--attempt', id, '--json'])).json().bundle, 'utf8'));

test('rules: matched by paths and by frontmatter; a review before the gate needs the paths-triggered skill; the verdicts a reviewer gives are recorded with the acceptance', () => {
  const { base, root, id } = project('rules', { 'web/a.txt': 'w2\n', 'api/a.txt': 'a2\n', 'docs/ui.md': '---\npaths: ["web/**"]\n---\n# UI rules, edited by the ticket\n' });
  // Before any gate: the skill is required by changed paths, not by screenshots.
  const early = bundleOf(root, id, 'r0');
  assert.deepEqual(early.skills.map((s) => s.name), ['design-review']);
  assert.match(early.skills[0].file, /design-review\/SKILL\.md$/);
  assert.deepEqual(early.rules.map((r) => r.id), ['ui', 'api'], 'cli governs nothing this ticket changed');
  const ui = early.rules[0];
  assert.deepEqual(ui.paths, ['web/**'], 'paths taken from the document frontmatter');
  assert.deepEqual(ui.matched, ['web/a.txt']);
  assert.equal(ui.docChangedByTicket, true);
  assert.match(fs.readFileSync(ui.read[0], 'utf8'), /# UI rules\nUse the design tokens/, 'the trusted copy is the base version');
  assert.equal(early.rules[1].read.length, 2);
  assert.equal(early.rules[1].docChangedByTicket, false);
  assert.match(early.instructions, /Rules, skills[^:]*are context for your judgement: cite them in findings; no verdict form is owed/);

  ok(wf(root, ['gate', ...OUT_OF_ORDER, '--attempt', id]));
  const b = bundleOf(root, id, 'r1');
  ok(wf(root, ['review', '--closure', closureFile(base, goodClosure('r1', { findings: [{ id: 'F1', severity: 'minor', summary: 'error code naming', status: 'fixed', evidence: 'api/a.txt:1' }], rules: [{ rule: 'ui', verdict: 'complies', evidence: 'docs/ui.md tokens' }, { rule: 'api', verdict: 'finding', finding: 'F1', evidence: 'api/a.txt:1' }] })), '--attempt', id]));
  // 0.7.0 (goals, not forms): the rules are context in the bundle and no verdict per rule is required (the next scenario
  // accepts without any); the ones given are recorded, and shown in the export.
  ok(wf(root, ['accept', '--attempt', id]));
  assert.deepEqual(state(root, id).accepted.rules.map((r) => [r.rule, r.verdict]), [['ui', 'complies'], ['api', 'finding']]);
  assert.ok(b.rules.length === 2);
  ok(wf(root, ['export', '--attempt', id]));
  const html = fs.readFileSync(path.join(root, '.wf-evidence', 'attempts', id, 'export', 'attempt.html'), 'utf8');
  assert.match(html, /<h2>Rules<\/h2>/);
  assert.match(html, /changed by this ticket/);
  assert.match(html, /docs\/ui\.md tokens/);
});

test('rules: the adapter is read at the base, so a ticket that removes its rules is still judged by them', () => {
  const p = project('rules-base', { 'api/a.txt': 'a2\n', '.workflow/project.yaml': JSON.stringify({ version: 1, enabled: true, name: 'rules-base', repos: [{ name: 'app', path: '.', base: 'main' }], lanes: ['quick', 'standard', 'batch'], gate: { steps } }) });
  // The owner's checkout loses the rules too (uncommitted): the bundle still comes from the adapter at the base.
  const cfgFile = path.join(p.root, '.workflow', 'project.yaml');
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
  delete cfg.review;
  fs.writeFileSync(cfgFile, JSON.stringify(cfg));
  const b = bundleOf(p.root, p.id, 'r1');
  assert.deepEqual(b.rules.map((r) => r.id), ['api']);
  assert.deepEqual(b.skills, [], 'no web file changed: the paths-triggered skill is not required');
});

test('config: duplicate rule ids, a rule without documents and an unknown `when` are refused; doctor warns on a document missing at base', () => {
  const bad = singleRepoProject('rules-bad', { gate: { steps }, review: { rules: [{ id: 'a', read: ['x.md'] }, { id: 'a', read: [] }] }, requires: { skills: [{ name: 's', roles: ['reviewer'], when: 'always' }] } });
  const r = wf(bad.root, ['doctor', '--no-steps']);
  assert.match(r.out + r.err, /duplicate review rule `a`/);
  assert.match(r.out + r.err, /review rule `a`: `read` must list at least one document path/);
  assert.match(r.out + r.err, /`when` must be `visual` or \{ paths: \[globs\] \}/);
  const warn = singleRepoProject('rules-warn', { gate: { steps }, review: { rules: [{ id: 'gone', paths: ['src/**'], read: ['docs/missing.md'] }, { id: 'all', read: ['docs/all.md'] }] } }, { 'docs/all.md': '# no frontmatter\n' });
  const d = wf(warn.root, ['doctor', '--no-steps']).out;
  assert.match(d, /review rule gone/);
  assert.match(d, /docs\/missing\.md/);
  assert.match(d, /applies to every change/);
});

// Named failure (0.7.0): a transcript read receipt refused reviewers whose reads were real and proved only that a tool call
// ran, not that the document was understood. The bundle names the documents and the closure is recorded whatever the
// transcript shows. A verdict per rule is no longer a form either (it measured compliance with the form, not defects):
// acceptance records the ones given and asks for none.
test('no read receipts: a closure is recorded whether or not the reviewer transcript shows the rule documents read, and no verdict per rule is required', () => {
  const { base, root, id } = project('rules-reads');
  ok(wf(root, ['gate', ...OUT_OF_ORDER, '--attempt', id]));
  const bundle = bundleOf(root, id, 'ra');
  assert.ok(bundle.rules.length && bundle.skills.length, 'the bundle still names the documents to read');
  // The reviewer's transcript shows nothing read, and the closure is recorded: no receipt is asked for. It judges no
  // rule, and acceptance goes through and records none.
  ok(wf(root, ['review', '--closure', closureFile(base, goodClosure('ra')), '--attempt', id]));
  assert.equal(state(root, id).reviews.at(-1).reads ?? null, null, 'no read receipt is recorded');
  ok(wf(root, ['accept', '--attempt', id]));
  assert.equal(state(root, id).accepted.rules, undefined, 'no verdict was given, so none is recorded');
});
