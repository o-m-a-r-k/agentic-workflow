import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { append, reduce } from '../engine/ledger.mjs';
import { assertRuntimeLaunch } from '../engine/runtime-policy.mjs';
import { ok, ownerSays, singleRepoProject, state, wf } from './helpers.mjs';

for (const runtime of ['codex', 'claude']) test(`origin runtime stays ${runtime} across handoff and recovery`, () => {
  const other = runtime === 'codex' ? 'claude' : 'codex';
  const { root, base } = singleRepoProject(`origin-${runtime}`, {
    classes: { review: { codex: { model: 'test-model', effort: 'high' }, claude: { model: 'test-model', effort: 'high' } } },
  });
  const owner = `${runtime}:origin-owner`;
  const id = ok(wf(root, ['entry', '--item', 'ENG-91', '--owner', owner, '--json'])).json().id;
  assert.equal(state(root, id).originRuntime, runtime);
  ok(wf(root, ['handoff', 'planner', '--attempt', id, '--agent', 'same'], { preserveRuntime: true }));
  assert.equal(state(root, id).handoffs.at(-1).runtime, runtime);
  const refused = wf(root, ['handoff', 'planner', '--attempt', id, '--agent', 'wrong', '--runtime', other], { ownerSilent: true });
  assert.equal(refused.code, 75);
  assert.equal(state(root, id).handoffs.length, 1);
  // An old wrong-provider handoff cannot bypass the pin through the native launcher.
  append(root, id, 'handoff', { role: 'planner', agent: 'legacy-wrong', runtime: other }, owner);
  const launch = wf(root, ['handoff', 'run', '--attempt', id, '--agent', 'legacy-wrong']);
  assert.equal(launch.code, 75);
  assert.match(launch.err, /origin runtime/);
  assert.equal(state(root, id).handoffs.at(-1).launch, undefined);
  ownerSays(path.join(base, '.home'), owner, `runtime ${id}:${other}`);
  ok(wf(root, ['handoff', 'planner', '--attempt', id, '--agent', 'authorized', '--runtime', other], { ownerSilent: true }));
  assert.ok(state(root, id).handoffs.at(-1).runtimeAuthority?.spent);
  assert.equal(state(root, id).originRuntime, runtime);
  ok(wf(root, ['handoff', 'planner', '--attempt', id, '--agent', 'default-again'], { preserveRuntime: true }));
  assert.equal(state(root, id).handoffs.at(-1).runtime, runtime);
});

test('legacy admission derives runtime from its first owner, never adoption or handoff', () => {
  const s = reduce([
    { type: 'admitted', actor: 'codex:first', data: { id: 'ENG-92.1' } },
    { type: 'owner.adopted', actor: 'claude:second', data: {} },
    { type: 'handoff', actor: 'claude:second', data: { role: 'planner', runtime: 'claude', agent: 'old' } },
  ]);
  assert.equal(s.originRuntime, 'codex');
});

for (const runtime of ['codex', 'claude']) test(`admission records the actual ${runtime} host before an owner alias`, () => {
  const { root } = singleRepoProject(`host-origin-${runtime}`, {});
  const env = runtime === 'codex' ? { CODEX_THREAD_ID: 'host-origin' } : { CLAUDE_CODE_SESSION_ID: 'host-origin' };
  const s = ok(wf(root, ['entry', '--item', 'ENG-93', '--owner', 'plain:terminal-owner', '--json'], { env })).json();
  assert.equal(s.originRuntime, runtime);
});

test('launch authority must name this attempt and the selected provider', () => {
  const s = { id: 'ENG-94.1', originRuntime: 'codex' };
  const h = { runtime: 'claude', runtimeAuthority: { provenance: 'host-recorded', spent: 'some-message', phrase: 'runtime ENG-95.1:claude' } };
  assert.throws(() => assertRuntimeLaunch(s, h), /origin runtime/);
  h.runtimeAuthority.phrase = 'runtime ENG-94.1:codex';
  assert.throws(() => assertRuntimeLaunch(s, h), /origin runtime/);
  h.runtimeAuthority = { provenance: 'interactive-terminal (unverified)', phrase: 'runtime ENG-94.1:claude' };
  assert.doesNotThrow(() => assertRuntimeLaunch(s, h));
});
