// 0.1.12: review rules. Named failure: in eleven review rounds no reviewer read any of the project's rule documents,
// and the required skill was only checked as installed (and only when screenshots existed).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { closureFile, commitIn, criteriaFile, goodClosure, ok, singleRepoProject, state, wf, write } from './helpers.mjs';

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
const verdicts = (b) => b.rules.map((r) => ({ rule: r.id, verdict: 'complies', evidence: `${r.docs[0]} section 1` }));

test('rules: matched by paths and by frontmatter; a review before the gate needs the paths-triggered skill; accept needs a verdict per rule', () => {
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
  assert.match(early.instructions, /Read every document under `rules`/);

  ok(wf(root, ['gate', '--attempt', id]));
  const b = bundleOf(root, id, 'r1');
  ok(wf(root, ['review', '--closure', closureFile(base, goodClosure('r1')), '--attempt', id]));
  const missing = wf(root, ['accept', '--attempt', id]);
  assert.equal(missing.code, 75);
  assert.match(missing.err, /rule ui: no verdict/);
  assert.match(missing.err, /rule api: no verdict/);
  assert.match(missing.err, /hand the tree to a fresh reviewer/);
  ok(wf(root, ['review', '--closure', closureFile(base, goodClosure('r1', { rules: [{ rule: 'ui', verdict: 'complies', evidence: ' ' }, { rule: 'api', verdict: 'finding', evidence: 'errors untyped' }] })), '--attempt', id]));
  const bad = wf(root, ['accept', '--attempt', id]).err;
  assert.match(bad, /rule ui: complies needs evidence/);
  assert.match(bad, /rule api: a finding verdict names a finding id/);
  ok(wf(root, ['review', '--closure', closureFile(base, goodClosure('r1', { findings: [{ id: 'F1', severity: 'minor', summary: 'error code naming', status: 'fixed', evidence: 'api/a.txt:1' }], rules: [{ rule: 'ui', verdict: 'complies', evidence: 'docs/ui.md tokens' }, { rule: 'api', verdict: 'finding', finding: 'F1', evidence: 'api/a.txt:1' }] })), '--attempt', id]));
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

// The reviewer's transcript must show it read each document and skill the bundle lists.
function transcript(root, name, prompt, calls) {
  const dir = path.join(homeOf(root), '.claude', 'projects', '-proj', 'sess', 'subagents');
  const f = `agent-${Math.random().toString(36).slice(2)}`;
  const at = new Date(Date.now() + 1000).toISOString();
  const entries = [{ type: 'user', timestamp: at, message: { role: 'user', content: prompt } }];
  calls.forEach((c, i) => {
    entries.push({ type: 'assistant', timestamp: at, message: { model: 'm', content: [{ type: 'tool_use', id: `t${i}`, name: c.name, input: c.input }] } });
    entries.push({ type: 'user', timestamp: at, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `t${i}`, content: 'ok', ...(c.error ? { is_error: true } : {}) }] } });
  });
  write(dir, `${f}.meta.json`, JSON.stringify({ name, agentType: 'wf-reviewer' }));
  write(dir, `${f}.jsonl`, entries.map((x) => JSON.stringify(x)).join('\n'));
}

test('reads: where a transcript exists every rule document and skill must have been read; Bash cat counts, another file or a failed read does not', () => {
  const { base, root, id } = project('rules-reads');
  fs.mkdirSync(path.join(homeOf(root), '.claude', 'projects'), { recursive: true });
  ok(wf(root, ['gate', '--attempt', id]));
  const start = (agent) => ok(wf(root, ['handoff', 'reviewer', '--agent', agent, '--attempt', id])).out.trim();
  const b = (agent) => {
    const s = state(root, id);
    return JSON.parse(fs.readFileSync(s.handoffs.filter((h) => h.role === 'reviewer' && h.agent === agent).at(-1).bundle, 'utf8'));
  };
  const closure = (agent, bundle) => closureFile(base, goodClosure(agent, { rules: verdicts(bundle) }));

  const s1 = start('ra');
  const b1 = b('ra');
  const [uiDoc] = b1.rules[0].read;
  const [apiDoc, errDoc] = b1.rules[1].read;
  // One document never read, one read through a failed call, one other file read: all three are missing.
  transcript(root, 'ra', s1, [{ name: 'Read', input: { file_path: uiDoc } }, { name: 'Read', input: { file_path: apiDoc }, error: true }, { name: 'Read', input: { file_path: path.join(root, 'docs/cli.md') } }, { name: 'Skill', input: { skill: 'design-review' } }]);
  const r1 = wf(root, ['review', '--closure', closure('ra', b1), '--attempt', id]);
  assert.equal(r1.code, 75);
  assert.match(r1.err, /no successful read of 2 document\(s\)/);
  assert.match(r1.err, new RegExp(`rule api: ${apiDoc.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  assert.match(r1.err, /rule api: .*errors\.md/);
  assert.doesNotMatch(r1.err, /rule ui:/);
  assert.match(r1.err, /start a fresh reviewer round/);

  const s2 = start('rb');
  const b2 = b('rb');
  transcript(root, 'rb', s2, [{ name: 'Read', input: { file_path: b2.rules[0].read[0] } }, { name: 'Bash', input: { command: `cat ${b2.rules[1].read[0]} ${b2.rules[1].read[1]}` } }, { name: 'Read', input: { file_path: b2.skills[0].file } }]);
  ok(wf(root, ['review', '--closure', closure('rb', b2), '--attempt', id]));
  assert.equal(state(root, id).reviews.at(-1).reads.status, 'verified');
  ok(wf(root, ['accept', '--attempt', id]));

  // No transcript store on the machine: recorded unverified, not refused.
  const other = project('rules-noreads');
  ok(wf(other.root, ['gate', '--attempt', other.id]));
  const ob = bundleOf(other.root, other.id, 'r');
  ok(wf(other.root, ['review', '--closure', closureFile(other.base, goodClosure('r', { rules: verdicts(ob) })), '--attempt', other.id]));
  assert.equal(state(other.root, other.id).reviews.at(-1).reads.status, 'unverified');
  ok(wf(other.root, ['accept', '--attempt', other.id]));
});
