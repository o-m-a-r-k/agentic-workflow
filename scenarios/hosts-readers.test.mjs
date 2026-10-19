// Stream 4: the host readers (filesRead, callerSession, sessionActivity, connectorCalls) on both transcript layouts.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { makeProject, transcript, reviewerTranscript } from './helpers/index.mjs';
import { codexRollout } from './decisions-helpers.mjs';
import { filesRead, callerSession, sessionActivity, connectorCalls } from '../engine/contract.mjs';

test('filesRead (Claude Code): Read targets and shell reads, in order and once; failed reads and unknown sessions are not reads', async (t) => {
  const p = makeProject({ adapter: false });
  t.after(p.cleanup);
  const wt = path.join(p.root, '.wf-worktrees', 'TK-1.1');
  const a = path.join(wt, 'server/src/core/sum.mjs');
  const b = path.join(wt, 'client/src/pages/items.mjs');
  const r = reviewerTranscript({ home: p.home, cwd: wt, files: [a, b, a] });
  assert.deepEqual(await filesRead(r.session, { home: p.home }), [a, b]);

  const tr = transcript({ home: p.home, cwd: wt, session: '11111111-0000-4000-8000-000000000001' });
  tr.toolCall('Read', { file_path: path.join(wt, 'missing.mjs') }, 'File does not exist.');
  tr.lines().at(-1).message.content[0].is_error = true;
  tr.toolCall('Bash', { command: 'cd server && sed -n \'1,80p\' src/core/sum.mjs | head -n 5 && cat nope.txt' }, 'cat: nope.txt: No such file or directory');
  tr.toolCall('Grep', { pattern: 'x', path: path.join(wt, 'client') }, 'none');
  tr.toolCall('Read', { file_path: 'client/src/common/button.mjs' }, 'ok');
  tr.write();
  assert.deepEqual(await filesRead(tr.session, { home: p.home }), [a, path.join(wt, 'client/src/common/button.mjs')]);
  assert.equal(await filesRead({ runtime: 'claude', id: '99999999-0000-4000-8000-000000000000' }, { home: p.home }), null);
  assert.equal(await filesRead({ runtime: 'nohost', id: 'x' }, { home: p.home }), null);
});

test('filesRead (Codex): shell reads through exec_command and exec scripts, against their working folder', async (t) => {
  const p = makeProject({ adapter: false });
  t.after(p.cleanup);
  const wt = path.join(p.root, '.wf-worktrees', 'TK-1.1');
  const r = codexRollout({ home: p.home, cwd: wt, source: 'exec', originator: 'codex_exec' })
    .shell('nl -ba server/src/core/sum.mjs')
    .shell('sed -n "1,40p" src/pages/items.mjs', 'ok', path.join(wt, 'client'))
    .script('bash -lc "cat server/README.md"')
    .shell('git diff --stat');
  r.write();
  assert.deepEqual(await filesRead(r.session, { home: p.home }), [path.join(wt, 'server/src/core/sum.mjs'), path.join(wt, 'client/src/pages/items.mjs'), path.join(wt, 'server/README.md')]);
});

test('callerSession: the host session from its variables; null at a plain terminal', async () => {
  assert.deepEqual(await callerSession({ CLAUDE_CODE_SESSION_ID: 'abc' }), { runtime: 'claude', id: 'abc' });
  assert.deepEqual(await callerSession({ CODEX_THREAD_ID: 't1' }), { runtime: 'codex', id: 't1' });
  assert.equal(await callerSession({ PATH: '/bin' }), null);
});

test('sessionActivity: turn times with human turns marked, tokens per request once, model; both layouts', async (t) => {
  const p = makeProject({ adapter: false });
  t.after(p.cleanup);
  const tr = transcript({ home: p.home, cwd: p.root, session: '22222222-0000-4000-8000-000000000002' });
  tr.human('start').advance(1).say('working').advance(1).notification('done').meta('injected').advance(1).queued('also').advance(1).read('/x/a');
  tr.write();
  const a = await sessionActivity(tr.session, { home: p.home });
  assert.equal(a.model, 'fixture-model');
  assert.deepEqual(a.tokens, { input: 200, output: 40, cacheRead: 0, cacheWrite: 0 });
  const human = a.turns.filter((x) => x.human).map((x) => x.at);
  assert.deepEqual(human, ['2026-01-05T09:00:00.000Z', '2026-01-05T09:03:00.000Z']);

  const c = codexRollout({ home: p.home, cwd: p.root }).human('go').advance(2).say('ok').tokens(1000, 400, 50);
  c.write();
  const ca = await sessionActivity(c.session, { home: p.home });
  assert.deepEqual(ca.tokens, { input: 600, output: 50, cacheRead: 400, cacheWrite: 0 });
  assert.equal(ca.model, 'fixture-codex');
  assert.equal(ca.turns.filter((x) => x.human).length, 1); // the AGENTS.md and environment line is not the person
});

test('connectorCalls: matched by suffix, with results, on both layouts; since filters', async (t) => {
  const p = makeProject({ adapter: false });
  t.after(p.cleanup);
  const tr = transcript({ home: p.home, cwd: p.root, session: '33333333-0000-4000-8000-000000000003', start: '2026-01-05T09:00:00.000Z' });
  tr.toolCall('mcp__tracker__get_issue', { id: 'TK-1' }, '{"id":"TK-1"}').advance(10).toolCall('mcp__abc__tracker_save_comment', { body: 'x wf:TK-1.1:uat' }, 'saved').toolCall('Read', { file_path: '/x' });
  tr.write();
  const all = await connectorCalls(tr.session, ['get_issue', 'save_comment'], { home: p.home });
  assert.deepEqual(all.map((c) => [c.tool, c.result]), [['get_issue', '{"id":"TK-1"}'], ['save_comment', 'saved']]);
  assert.equal((await connectorCalls(tr.session, ['get_issue', 'save_comment'], { home: p.home, since: '2026-01-05T09:05:00.000Z' })).length, 1);
  // An empty suffix (or list) reads back every call, each with the tool it went to.
  for (const every of [[''], []]) assert.deepEqual((await connectorCalls(tr.session, every, { home: p.home })).map((c) => c.tool), ['mcp__tracker__get_issue', 'mcp__abc__tracker_save_comment', 'Read']);
  assert.equal(all[1].name, 'mcp__abc__tracker_save_comment');

  const c = codexRollout({ home: p.home, cwd: p.root }).connector('mcp__tracker__get_issue', { id: 'TK-2' }, 'issue TK-2').wrapped('mcp__tracker__save_comment', { body: 'y' }, 'done');
  c.write();
  const cc = await connectorCalls(c.session, ['get_issue', 'save_comment'], { home: p.home });
  assert.deepEqual(cc.map((x) => [x.tool, x.input.id ?? x.input.body, x.result]), [['get_issue', 'TK-2', 'issue TK-2'], ['save_comment', 'y', 'done']]);
});
