import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { closureFile, commitIn, criteriaFile, goodClosure, ok, singleRepoProject, state, wf, write } from './helpers.mjs';

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

// ---- I-14: the agent a handoff names, and how the review identifies it ----

const homeOf = (root) => path.join(root, '..', '.home');
function subagent(root, { name, agentType, prompt }) {
  const dir = path.join(homeOf(root), '.claude', 'projects', '-proj', 'sess', 'subagents');
  const f = `agent-${Math.random().toString(36).slice(2)}`;
  const at = new Date(Date.now() + 1000).toISOString();
  write(dir, `${f}.meta.json`, JSON.stringify({ ...(name ? { name } : {}), agentType, description: 'review' }));
  write(dir, `${f}.jsonl`, [{ type: 'user', timestamp: at, message: { role: 'user', content: prompt } }, { type: 'assistant', timestamp: at, message: { model: 'm-unnamed', content: [{ type: 'text', text: 'done' }] } }].map((x) => JSON.stringify(x)).join('\n'));
}
function admitted(name, config = {}) {
  const { base, root } = singleRepoProject(name, { gate: { steps: [{ id: 'unit', repo: 'app', run: 'true' }] }, ...config });
  const e = ok(wf(root, ['entry', '--item', 'ENG-32', '--owner', 'o', '--json'])).json();
  return { base, root, e };
}

test('every handoff names the agent type and the name to start it under, the reviewer\'s on stderr beside its one-line prompt', () => {
  // Named failure: `wf handoff reviewer` printed only the start line; the reviewer was started unnamed, did the whole
  // review, and its closure was refused for want of a transcript under the handed name.
  const { base, root, e } = admitted('handoff-names', { roles: { tester: {} } });
  const planner = ok(wf(root, ['handoff', 'planner', '--agent', 'plan-1', '--attempt', e.id])).out;
  assert.match(planner, /Start agent type wf-planner \(name it plan-1; do not pass a model\) with: "Read \S+ and follow its instructions\."/);
  ok(wf(root, ['plan', '--file', criteriaFile(base), '--attempt', e.id]));
  assert.match(ok(wf(root, ['handoff', 'implementer', '--agent', 'impl-1', '--attempt', e.id])).out, /Start agent type wf-implementer \(name it impl-1;/);
  assert.match(ok(wf(root, ['handoff', 'tester', '--agent', 'test-1', '--attempt', e.id])).out, /Start agent type wf-tester \(name it test-1;/);
  commitIn(e.repos.app.worktree, { 'src/a.txt': 'b\n' });
  const rv = ok(wf(root, ['handoff', 'reviewer', '--agent', 'rev-1', '--attempt', e.id]));
  assert.match(rv.out, /^Read \S+ and follow its instructions\.\n$/, 'stdout stays the one line the reviewer is started with');
  assert.match(rv.err, /^Start agent type wf-reviewer \(name it rev-1; do not pass a model\) with only the line on stdout as its prompt:$/m);
});

test('review provenance: an unnamed reviewer is accepted when exactly one transcript began with its handoff line; none or several are refused with how to start it', () => {
  const { base, root, e } = admitted('handoff-unnamed');
  fs.mkdirSync(path.join(homeOf(root), '.claude', 'projects'), { recursive: true });
  ok(wf(root, ['handoff', 'planner', '--agent', 'p', '--attempt', e.id]));
  ok(wf(root, ['plan', '--file', criteriaFile(base), '--attempt', e.id]));
  ok(wf(root, ['handoff', 'implementer', '--agent', 'i', '--attempt', e.id]));
  commitIn(e.repos.app.worktree, { 'src/a.txt': 'b\n' });
  const line = ok(wf(root, ['handoff', 'reviewer', '--agent', 'rev-a', '--attempt', e.id])).out.trim();
  const review = (who) => wf(root, ['review', '--closure', closureFile(base, goodClosure(who)), '--attempt', e.id]);
  const none = review('rev-a');
  assert.equal(none.code, 75);
  assert.match(none.err, /no Claude Code subagent transcript named `rev-a`: start it as agent type `wf-reviewer`, named `rev-a` \(the Agent tool's name\), with only the printed line as its prompt/);
  assert.match(none.err, /start it as the agent type that command prints, named <new id>/);
  subagent(root, { agentType: 'general-purpose', prompt: line });
  assert.match(review('rev-a').err, /an unnamed agent began with this handoff's line, but as agent type `general-purpose`, not `wf-reviewer`/);
  subagent(root, { agentType: 'wf-reviewer', prompt: `${line}\nFocus on the null check.` });
  assert.equal(review('rev-a').code, 75, 'a steered unnamed agent is not this round');
  subagent(root, { agentType: 'wf-reviewer', prompt: line });
  ok(review('rev-a'));
  const r = state(root, e.id).reviews.at(-1);
  assert.equal(r.provenance, 'verified');
  assert.equal(r.identity, 'unnamed');
  assert.equal(r.reviewerModel, 'm-unnamed');
  // Two unnamed agents started with the same line: which one wrote the closure is unknown.
  const line2 = ok(wf(root, ['handoff', 'reviewer', '--agent', 'rev-b', '--attempt', e.id])).out.trim();
  subagent(root, { agentType: 'wf-reviewer', prompt: line2 });
  subagent(root, { agentType: 'wf-reviewer', prompt: line2 });
  assert.match(review('rev-b').err, /and 2 unnamed ones began with this handoff's line, so which one wrote the closure is ambiguous/);
  // Named as told: verified as before.
  const line3 = ok(wf(root, ['handoff', 'reviewer', '--agent', 'rev-c', '--attempt', e.id])).out.trim();
  subagent(root, { name: 'rev-c', agentType: 'wf-reviewer', prompt: line3 });
  ok(review('rev-c'));
  assert.equal(state(root, e.id).reviews.at(-1).identity, 'named');
});

// ---- I-15: role files are read when a session starts ----

test('wf sync names the role files it changed and says a running session keeps the old roles; the handoff warns when the role changed after the session started', () => {
  // Named failure: `wf sync` added Write to the reviewer's tools, the next reviewer started from the same session still
  // ran without it (agent files are read at session start) and fell back to a shell heredoc.
  const { root } = singleRepoProject('role-stale', { gate: { steps: [{ id: 'unit', repo: 'app', run: 'true' }] } });
  const first = ok(wf(root, ['sync'])).out;
  assert.match(first, /role file\(s\) changed: .*\.claude\/agents\/wf-planner\.md \(new\)/);
  const plannerFile = path.join(root, '.claude', 'agents', 'wf-planner.md');
  const before = fs.statSync(plannerFile).mtimeMs;
  assert.match(ok(wf(root, ['sync'])).out, /no role file changed/);
  assert.equal(fs.statSync(plannerFile).mtimeMs, before, 'an unchanged role file is not rewritten');
  // A session that started after the last role change: no warning.
  const sessionDir = path.join(homeOf(root), '.claude', 'projects', '-proj');
  write(sessionDir, 'sess-late.jsonl', JSON.stringify({ type: 'user', timestamp: new Date(Date.now() + 60_000).toISOString(), message: { role: 'user', content: 'hi' } }));
  const e = ok(wf(root, ['entry', '--item', 'ENG-33', '--owner', 'o', '--json'])).json();
  const fresh = ok(wf(root, ['handoff', 'planner', '--agent', 'p', '--attempt', e.id, '--owner', 'o'], { env: { CLAUDE_CODE_SESSION_ID: 'sess-late' } }));
  assert.doesNotMatch(fresh.err + fresh.out, /changed at/);
  // The role changes while an older session runs.
  write(sessionDir, 'sess-old.jsonl', JSON.stringify({ type: 'user', timestamp: new Date(Date.now() - 3_600_000).toISOString(), message: { role: 'user', content: 'hi' } }));
  write(root, '.workflow/planner-extra.md', 'Name the rollback.\n');
  const cfgFile = path.join(root, '.workflow', 'project.yaml');
  fs.writeFileSync(cfgFile, JSON.stringify({ ...JSON.parse(fs.readFileSync(cfgFile, 'utf8')), roles: { planner: { appendix: 'planner-extra.md' } } }));
  const changed = ok(wf(root, ['sync'])).out;
  assert.match(changed, /role file\(s\) changed: \.claude\/agents\/wf-planner\.md, \.codex\/agents\/wf-planner\.toml\n {2}Claude Code and Codex read agent files when a session starts: a session that was already running keeps the old roles/);
  const stale = ok(wf(root, ['handoff', 'planner', '--agent', 'p2', '--attempt', e.id, '--owner', 'o'], { env: { CLAUDE_CODE_SESSION_ID: 'sess-old' } }));
  assert.match(stale.err, /warning: \.claude\/agents\/wf-planner\.md changed at \S+, after this Claude Code session started \(\S+\)\. Claude Code reads agent files when a session starts, so an agent of type wf-planner started from this session runs the old role/);
  assert.match(stale.err, /Restart Claude Code \(`claude --resume` keeps this conversation\)/);
});
