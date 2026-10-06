import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { closureFile, commitIn, criteriaFile, goodClosure, ok, singleRepoProject, wf, write } from './helpers.mjs';

// Named failure (0.3.3, a live round): the generated reviewer was told to write its closure with the Write tool, but
// its `tools` list lacked Write, so the closure could not be recorded and the round was lost.
const TOOLS = ['Write', 'Edit', 'MultiEdit', 'Bash', 'Skill', 'Read', 'Grep', 'Glob', 'WebFetch', 'WebSearch', 'NotebookEdit', 'Agent', 'Task'];

test('every generated role names only tools its own tools list grants', () => {
  const { root } = singleRepoProject('role-tools', { classes: { light: {} }, gate: { steps: [] } });
  ok(wf(root, ['sync']));
  const dir = path.join(root, '.claude', 'agents');
  const files = fs.readdirSync(dir).filter((f) => /^wf-.*\.md$/.test(f));
  assert.ok(files.some((f) => f.startsWith('wf-reviewer')) && files.some((f) => f.startsWith('wf-planner')));
  for (const f of files) {
    const text = fs.readFileSync(path.join(dir, f), 'utf8');
    const listed = /^tools: (.*)$/m.exec(text.match(/^---\n[\s\S]*?\n---\n/)[0])?.[1];
    if (!listed) continue; // no list: every tool (the implementer)
    const granted = new Set(listed.split(',').map((t) => t.trim()));
    const named = new Set([...text.matchAll(new RegExp(`\\b(${TOOLS.join('|')}) tool\\b`, 'g'))].map((m) => m[1]));
    for (const t of named) assert.ok(granted.has(t), `${f} tells the agent to use the ${t} tool but its tools are: ${listed}`);
  }
  const reviewer = fs.readFileSync(path.join(dir, files.find((f) => f.startsWith('wf-reviewer'))), 'utf8');
  assert.match(reviewer, /^tools: .*\bWrite\b/m);
  assert.match(reviewer, /Write only to the path in `reviewClosureFile`; any other write changes the tree under review and invalidates your review/);
});

test('wf review refuses a closure when the worktree changed during the review round', () => {
  const steps = [{ id: 'unit', repo: 'app', run: 'true' }];
  const { base, root } = singleRepoProject('review-tree', { gate: { steps } });
  const e = ok(wf(root, ['entry', '--item', 'ENG-31', '--owner', 'o', '--json'])).json();
  ok(wf(root, ['handoff', 'planner', '--agent', 'p', '--attempt', e.id]));
  ok(wf(root, ['plan', '--file', criteriaFile(base), '--attempt', e.id]));
  ok(wf(root, ['handoff', 'implementer', '--agent', 'i', '--attempt', e.id]));
  commitIn(e.repos.app.worktree, { 'src/a.txt': 'b\n' });
  ok(wf(root, ['gate', '--attempt', e.id]));
  ok(wf(root, ['handoff', 'reviewer', '--agent', 'r', '--attempt', e.id]));
  write(e.repos.app.worktree, 'src/a.txt', 'the reviewer edited this\n');
  const r = wf(root, ['review', '--closure', closureFile(base, goodClosure('r')), '--attempt', e.id]);
  assert.equal(r.code, 75);
  assert.match(r.err, /the worktree changed during the review round \(app\): the closure no longer describes the tree under review/);
  fs.writeFileSync(path.join(e.repos.app.worktree, 'src/a.txt'), 'b\n');
  ok(wf(root, ['review', '--closure', closureFile(base, goodClosure('r')), '--attempt', e.id]));
});
