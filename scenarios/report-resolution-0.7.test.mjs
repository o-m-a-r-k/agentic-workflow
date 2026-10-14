// 0.7.0 (integration review), named failure: `wf deliver` still ran the pre-0.7 transcript scan of implementer reports on
// an attempt admitted at 0.7.0, so a transcript line such as "Not fixed, outside the brief" refused a delivery that review
// and acceptance had passed, and no review could clear it. From 0.7.0 the implementer's structured report carries what it
// left (discovered issues); the transcript is read for none of it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { closureFile, commitIn, goodClosure, ok, planDoc, singleRepoProject } from './helpers.mjs';
import { runner } from './strategist-fixtures.mjs';

const v7 = runner('0.7.0');
const wf = v7.run;
const state = v7.state;

function transcript(p, agent, text) {
  const dir = path.join(p.root, '..', '.home', '.claude', 'projects', '-project', 'owner', 'subagents');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `agent-${agent}.jsonl`);
  const agentType = state(p.root, p.id).handoffs.find((h) => h.agent === agent).agentType;
  fs.writeFileSync(file.replace(/\.jsonl$/, '.meta.json'), JSON.stringify({ name: agent, agentType }));
  const at = new Date().toISOString();
  fs.writeFileSync(file, [{ type: 'user', timestamp: at, message: { role: 'user', content: 'Read the bundle.' } }, { type: 'assistant', timestamp: at, message: { role: 'assistant', content: [{ type: 'text', text }] } }].map((x) => JSON.stringify(x)).join('\n'));
}

test('0.7.0: a transcript line about something not fixed never blocks the delivery of an attempt admitted at 0.7.0', () => {
  const { base, root } = singleRepoProject('report-07', { gate: { steps: [] } });
  const e = ok(wf(root, ['entry', '--item', 'ENG-843', '--owner', 'owner', '--json'])).json();
  const p = { root, id: e.id, wt: e.repos.app.worktree };
  ok(wf(root, ['handoff', 'planner', '--agent', 'planner', '--attempt', p.id]));
  const plan = path.join(base, 'plan.json');
  fs.writeFileSync(plan, JSON.stringify(planDoc({ plan: 'repair', criteria: [{ id: 'C1', text: 'correct output', uat: 'check output' }] })));
  ok(wf(root, ['plan', '--file', plan, '--attempt', p.id]));
  ok(wf(root, ['handoff', 'implementer', '--agent', 'impl-1', '--runtime', 'claude', '--attempt', p.id]));
  commitIn(p.wt, { 'src/a.txt': 'correct total\n' });
  transcript(p, 'impl-1', 'Done. Not fixed, outside the brief: the export total is wrong.');
  ok(wf(root, ['handoff', 'close', '--agent', 'impl-1', '--attempt', p.id]));
  const code = ok(wf(root, ['handoff', 'reviewer', '--agent', 'rev-1', '--runtime', 'codex', '--attempt', p.id]));
  const bundle = JSON.parse(fs.readFileSync(code.out.match(/^Read (\S+)/m)[1], 'utf8'));
  assert.deepEqual(bundle.historicalReports ?? [], [], 'no transcript scan is handed to a 0.7.0 reviewer');
  assert.equal(bundle.implementerReports.length, 1, 'the structured report is');
  ok(wf(root, ['review', '--closure', closureFile(base, goodClosure('rev-1')), '--attempt', p.id]));
  ok(wf(root, ['gate', '--attempt', p.id]));
  ok(wf(root, ['handoff', 'reviewer', '--agent', 'rev-2', '--runtime', 'codex', '--attempt', p.id]));
  ok(wf(root, ['review', '--closure', closureFile(base, goodClosure('rev-2')), '--attempt', p.id]));
  ok(wf(root, ['accept', '--attempt', p.id]));
  ok(wf(root, ['deliver', '--attempt', p.id]));
});
