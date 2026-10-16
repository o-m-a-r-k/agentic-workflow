// A new harness plugs in by adding one adapter: a throwaway `grok` adapter is registered from outside the engine, a fake
// `grok` binary stands in for the program, and `wf handoff run` launches a planner through it. No engine file changes.
// What the adapter supplies (argv, how its events read, its labels) is all the engine learns about the harness.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ok, singleRepoProject, state, wf, write } from './helpers.mjs';

const WRAPPER = path.join(import.meta.dirname, 'host-plugin-wf.mjs');

const ADAPTER = `export default {
  id: 'grok', name: 'Grok', label: 'Grok CLI', spawnMode: 'engine-only',
  sessionEnv: ['GROK_TEST_SESSION'], markerEnv: [], envPrefixes: ['GROK_TEST_'],
  classDefaults: {}, sandbox: 'grok-sandbox', needsGitRoot: false,
  detect: (env) => (env.GROK_TEST_SESSION ? { session: env.GROK_TEST_SESSION } : null),
  buildLaunch: (h, { body }) => ({ bin: 'grok', args: ['run', '--system', body, ...(h.model ? ['--model', h.model] : [])] }),
  interpretEvent: (e) => (e.kind === 'session' ? { started: e.id } : e.kind === 'finish' ? { terminal: { success: e.ok === true } } : e.kind === 'crash' ? { failed: true } : {}),
  roleReport: (e) => (e.kind === 'say' ? e.text : null),
};
`;

const SESSION = 'grok-session-0001';

function prepared(mode = 'ok') {
  const p = singleRepoProject('host-plugin', { classes: { review: { grok: { model: 'grok-test-model', effort: 'high' } }, planning: { grok: { model: 'grok-test-model', effort: 'high' } } }, gate: { steps: [] } });
  const dir = path.join(p.base, 'fake-bin');
  write(dir, 'grok', `#!/usr/bin/env node
import fs from 'node:fs';
const prompt = fs.readFileSync(0, 'utf8');
fs.writeFileSync(${JSON.stringify(path.join(p.base, 'spawn.json'))}, JSON.stringify({ args: process.argv.slice(2), prompt }));
console.log(JSON.stringify({ kind: 'session', id: ${JSON.stringify(SESSION)} }));
console.log(JSON.stringify({ kind: 'say', text: 'Reading the bundle now.' }));
${mode === 'crash' ? "console.log(JSON.stringify({ kind: 'crash' }));" : "console.log(JSON.stringify({ kind: 'finish', ok: true }));"}
`);
  fs.chmodSync(path.join(dir, 'grok'), 0o755);
  const adapter = path.join(p.base, 'grok-adapter.mjs');
  fs.writeFileSync(adapter, ADAPTER);
  const env = { PATH: dir + path.delimiter + process.env.PATH, WF_TEST_HOST_ADAPTER: adapter };
  const run = (args) => wf(p.root, args, { env, bin: WRAPPER, preserveRuntime: true });
  const id = ok(run(['entry', '--item', 'ENG-90', '--owner', 'plain:person', '--json'])).json().id;
  ok(run(['handoff', 'planner', '--agent', 'p', '--runtime', 'grok', '--attempt', id]));
  return { ...p, id, env, run };
}

test('a harness the engine has never heard of launches a role through its adapter alone', () => {
  const { base, root, id, run } = prepared();
  const r = ok(run(['handoff', 'run', '--agent', 'p', '--attempt', id]));
  assert.match(r.out, /Native p: completed \(grok-session-0001\)/);
  assert.match(r.err, /Grok planner p: session grok-session-0001 started; configured grok-test-model\/high/, 'the progress line uses the adapter\'s name');
  assert.match(r.err, /Grok planner p: agent report \(unverified\): Reading the bundle now\./);
  const h = state(root, id).handoffs.at(-1);
  assert.equal(h.runtime, 'grok');
  assert.equal(h.session, SESSION);
  assert.equal(h.launch.status, 'completed');
  const launched = JSON.parse(fs.readFileSync(path.join(base, 'spawn.json'), 'utf8'));
  assert.equal(launched.prompt, h.startPrompt, 'the frozen start line is what the harness receives');
  assert.deepEqual([launched.args[0], launched.args[1] === '--system', launched.args.slice(-2)], ['run', true, ['--model', 'grok-test-model']]);
  const receipt = JSON.parse(fs.readFileSync(h.bundle.replace(/\.json$/, '.launch.json'), 'utf8'));
  assert.equal(receipt.runtime, 'grok');
  assert.equal(receipt.sandbox, 'grok-sandbox');
});

test('a failed turn the adapter reports is a failed launch, named for the harness', () => {
  const { root, id, run } = prepared('crash');
  const r = run(['handoff', 'run', '--agent', 'p', '--attempt', id]);
  assert.notEqual(r.code, 0);
  assert.match(r.err, /Grok role failed: Grok reported a failed turn/);
  assert.equal(state(root, id).handoffs.at(-1).launch.status, 'failed');
});

test('without the adapter the same runtime is refused, naming the harnesses the engine knows', () => {
  const p = singleRepoProject('host-plugin-unknown', { gate: { steps: [] } });
  const id = ok(wf(p.root, ['entry', '--item', 'ENG-91', '--owner', 'plain:person', '--json'])).json().id;
  const r = wf(p.root, ['handoff', 'planner', '--agent', 'p', '--runtime', 'grok', '--attempt', id], { preserveRuntime: true });
  assert.equal(r.code, 75);
  assert.match(r.err, /claude or codex/);
});
