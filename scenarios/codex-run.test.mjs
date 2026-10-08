import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { closureFile, commitIn, goodClosure, ok, planDoc, singleRepoProject, state, wf, write, yaml } from './helpers.mjs';
import { verifyAgent } from '../engine/provenance.mjs';
import { codexEntries } from '../engine/codex-agent.mjs';
import { unreadDocs } from '../engine/rules.mjs';
import { ENGINE_VERSION } from '../engine/util.mjs';

const SID = '01a110b4-1637-7a42-b353-d0ad25e60000';
function prepared(mode = '') {
  const p = singleRepoProject('codex-run', { classes: { review: { codex: { model: 'future-model', effort: 'max' } } }, gate: { steps: [{ id: 'unit', repo: 'app', run: 'true' }] } });
  const { base, root } = p;
  const dir = path.join(base, 'bin');
  const host = path.join(base, '.home');
  write(dir, 'codex', `#!/usr/bin/env node
import fs from 'node:fs'; import path from 'node:path'; import { spawnSync } from 'node:child_process';
const args = process.argv.slice(2), prompt = fs.readFileSync(0,'utf8');
const counter = ${JSON.stringify(path.join(base, 'counter'))};
const n = fs.existsSync(counter) ? Number(fs.readFileSync(counter,'utf8')) + 1 : 0;
fs.writeFileSync(counter,String(n));
const sid = '${SID}'.slice(0,-4) + String(n).padStart(4,'0');
fs.writeFileSync(${JSON.stringify(path.join(base, 'spawn.json'))}, JSON.stringify({args,prompt,parent:process.env.CODEX_THREAD_ID??null,wfVersion:spawnSync('wf',['--version'],{encoding:'utf8'}).stdout.trim()}));
const file = path.join(${JSON.stringify(host)},'.codex','sessions','2026','10','08','rollout-test-'+sid+'.jsonl');
fs.mkdirSync(path.dirname(file),{recursive:true});
const at = new Date().toISOString(), line=(x)=>JSON.stringify({timestamp:at,...x});
const actual = prompt + ${JSON.stringify(mode === 'steered' ? ' Focus only on one file.' : '')};
fs.writeFileSync(file,[line({type:'session_meta',payload:{id:sid,timestamp:at,originator:'codex_exec',source:'exec',cwd:${JSON.stringify(root)}}}),line({type:'response_item',payload:{type:'message',role:'user',internal_chat_message_metadata_passthrough:{content_item_kinds:['agents_md.instructions','environments.environment_context']},content:[{type:'input_text',text:'# AGENTS.md instructions fixture'},{type:'input_text',text:'<environment_context>fixture</environment_context>'}]}}),line({type:'response_item',payload:{type:'message',role:'user',internal_chat_message_metadata_passthrough:{content_item_kinds:['user.text']},content:[{type:'input_text',text:actual}]}}),line({type:'response_item',payload:{type:'message',role:'assistant',content:[{type:'output_text',text:${JSON.stringify('```yaml\n' + yaml(planDoc({ plan: 'Change a.', criteria: [{ id: 'C1', text: 'a changes' }] })) + '\n```')}}]}})].join('\\n')+'\\n');
console.log(JSON.stringify({type:'thread.started',thread_id:sid}));
console.log(JSON.stringify({type:'turn.completed'}));
process.exit(${mode === 'failed' ? 1 : 0});
`);
  fs.chmodSync(path.join(dir, 'codex'), 0o755);
  write(dir, 'wf', '#!/bin/sh\nprintf stale-engine\n');
  fs.chmodSync(path.join(dir, 'wf'), 0o755);
  const env = { PATH: dir + path.delimiter + process.env.PATH, WF_HOME: host };
  const id = ok(wf(root, ['entry', '--item', 'ENG-80', '--owner', 'o', '--json'])).json().id;
  ok(wf(root, ['handoff', 'planner', '--agent', 'p', '--runtime', 'codex', '--attempt', id]));
  return { ...p, id, env, host };
}

test('engine-launched Codex planner records the exact fresh prompt and imports its unchanged YAML', () => {
  const { base, root, id, env, host } = prepared();
  ok(wf(root, ['handoff', 'run', '--agent', 'p', '--attempt', id], { env }));
  const launched = JSON.parse(fs.readFileSync(path.join(base, 'spawn.json'), 'utf8'));
  const h = state(root, id).handoffs.at(-1);
  assert.equal(launched.prompt, h.startPrompt);
  assert.equal(launched.parent, null);
  assert.equal(launched.wfVersion, ENGINE_VERSION, 'the child must use its launching engine, never a stale global CLI');
  assert.ok(launched.args.includes('future-model'));
  assert.ok(launched.args.includes('model_reasoning_effort="max"'));
  assert.ok(launched.args.some((a) => a.startsWith('developer_instructions=') && a.includes('You are the planner')));
  assert.ok(launched.args.includes('workspace-write'));
  assert.equal(h.session, SID);
  const previous = process.env.WF_HOME; process.env.WF_HOME = host;
  try { assert.equal(verifyAgent(h).status, 'verified'); } finally { if (previous === undefined) delete process.env.WF_HOME; else process.env.WF_HOME = previous; }
  ok(wf(root, ['plan', '--from-agent', 'p', '--attempt', id], { env }));
  assert.equal(state(root, id).planSource.provenance, 'verified');
  assert.equal(wf(root, ['handoff', 'run', '--agent', 'p', '--attempt', id], { env }).code, 75, 'a handoff launches once');
});

test('engine-launched Codex provenance refuses a steered prompt and a failed planner run', () => {
  for (const mode of ['steered', 'failed']) {
    const { root, id, env } = prepared(mode);
    const run = wf(root, ['handoff', 'run', '--agent', 'p', '--attempt', id], { env });
    assert.equal(run.code, mode === 'failed' ? 1 : 0);
    const imported = wf(root, ['plan', '--from-agent', 'p', '--attempt', id], { env });
    assert.equal(imported.code, 75, imported.out);
    assert.match(imported.err, mode === 'failed' ? /not completed successfully/ : /start prompt/);
    assert.equal(state(root, id).criteria, null);
  }
});

test('engine-launched Codex reviewer has verified provenance while the existing tree binding still refuses writes', () => {
  const { base, root, id, env } = prepared();
  ok(wf(root, ['handoff', 'run', '--agent', 'p', '--attempt', id], { env }));
  ok(wf(root, ['plan', '--from-agent', 'p', '--attempt', id], { env }));
  ok(wf(root, ['handoff', 'implementer', '--agent', 'i', '--attempt', id]));
  commitIn(state(root, id).repos.app.worktree, { 'src/a.txt': 'changed by implementer' });
  ok(wf(root, ['handoff', 'close', '--agent', 'i', '--attempt', id]));
  ok(wf(root, ['handoff', 'reviewer', '--agent', 'r', '--runtime', 'codex', '--attempt', id]));
  ok(wf(root, ['handoff', 'run', '--agent', 'r', '--attempt', id], { env }));
  ok(wf(root, ['review', '--closure', closureFile(base, goodClosure('r')), '--attempt', id], { env }));
  assert.equal(state(root, id).reviews.at(-1).provenance, 'verified');
  ok(wf(root, ['handoff', 'reviewer', '--agent', 'r2', '--runtime', 'codex', '--attempt', id]));
  ok(wf(root, ['handoff', 'run', '--agent', 'r2', '--attempt', id], { env }));
  fs.writeFileSync(path.join(state(root, id).repos.app.worktree, 'src/a.txt'), 'changed during review');
  assert.match(wf(root, ['review', '--closure', closureFile(base, goodClosure('r2')), '--attempt', id], { env }).err, /worktree changed during the review/);
});

test('Codex reviewer document checks use completed successful host commands and refuse absent or failed reads', () => {
  const { base } = singleRepoProject('codex-reads');
  const file = path.join(base, 'reads.jsonl'), doc = path.join(base, 'rule.md');
  const rules = [{ id: 'R1', read: [doc] }];
  const item = { type: 'CommandExecution', id: 'exec-read', command: ['/bin/zsh', '-lc', 'cat ' + doc], status: 'completed', exit_code: 0 };
  const raw = (item) => JSON.stringify({ type: 'event_msg', payload: { type: 'item_completed', item } }) + '\n';
  for (const variant of [{ ...item, exit_code: 1 }, { ...item, status: 'failed' }, { ...item, type: 'AgentMessage' }]) {
    fs.writeFileSync(file, raw(variant));
    assert.equal(unreadDocs(codexEntries(file).entries, rules, []).length, 1);
  }
  fs.writeFileSync(file, raw(item));
  assert.deepEqual(unreadDocs(codexEntries(file).entries, rules, []), []);
  fs.writeFileSync(file, raw({ ...item, command: ['/bin/zsh', '-lc', 'wf evidence show ' + doc + ' --attempt ENG-80.1'] }));
  assert.deepEqual(unreadDocs(codexEntries(file).entries, rules, []), [], 'the permitted wf reader counts too');
});
