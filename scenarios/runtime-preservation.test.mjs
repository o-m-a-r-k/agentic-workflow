import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { append, reduce } from '../engine/ledger.mjs';
import { assertRuntimeLaunch, defaultRuntime } from '../engine/runtime-policy.mjs';
import { ok, singleRepoProject, state, wf } from './helpers.mjs';

// 0.7.0 (D4): choosing the other provider for a handoff is bookkeeping, recorded with the caller as actor. It used to wait
// for the owner's phrase `runtime <attempt>:<provider>` read from the owner session's transcript.

for (const runtime of ['codex', 'claude']) test(`${runtime} owner defaults locally and a recorded switch persists across handoffs and recovery`, () => {
  const other = runtime === 'codex' ? 'claude' : 'codex';
  const { root, base } = singleRepoProject(`origin-${runtime}`, {
    classes: { review: { codex: { model: 'test-model', effort: 'high' }, claude: { model: 'test-model', effort: 'high' } } },
  });
  const owner = `${runtime}:origin-owner`;
  const id = ok(wf(root, ['entry', '--item', 'ENG-91', '--owner', owner, '--json'])).json().id;
  assert.equal(state(root, id).originRuntime, runtime);
  ok(wf(root, ['handoff', 'planner', '--attempt', id, '--agent', 'same'], { preserveRuntime: true }));
  assert.equal(state(root, id).handoffs.at(-1).runtime, runtime);
  // An old wrong-provider handoff with no recorded choice cannot bypass the pin through the native launcher.
  append(root, id, 'handoff', { role: 'planner', agent: 'legacy-wrong', runtime: other }, owner);
  const launch = wf(root, ['handoff', 'run', '--attempt', id, '--agent', 'legacy-wrong']);
  assert.equal(launch.code, 75);
  assert.match(launch.err, /owning runtime/);
  assert.equal(state(root, id).handoffs.at(-1).launch, undefined);
  // An explicit --runtime for the other provider is a recorded choice: accepted, with who chose it and from what.
  ok(wf(root, ['handoff', 'planner', '--attempt', id, '--agent', 'chosen', '--runtime', other], { ownerSilent: true }));
  const chosen = state(root, id).handoffs.at(-1);
  assert.deepEqual([chosen.runtime, chosen.runtimeAuthority.runtime, chosen.runtimeAuthority.from], [other, other, runtime]);
  assert.equal(chosen.runtimeAuthority.phrase, undefined, 'no owner phrase is claimed');
  assert.equal(state(root, id).originRuntime, runtime);
  ok(wf(root, ['handoff', 'planner', '--attempt', id, '--agent', 'default-again'], { preserveRuntime: true, ownerSilent: true }));
  assert.equal(state(root, id).handoffs.at(-1).runtime, other);
  assert.equal(state(root, id).handoffs.at(-1).runtimeAuthority, undefined);
  ok(wf(root, ['handoff', 'planner', '--attempt', id, '--agent', 'switch-back', '--runtime', runtime], { ownerSilent: true }));
  ok(wf(root, ['handoff', 'planner', '--attempt', id, '--agent', 'after-back'], { preserveRuntime: true, ownerSilent: true }));
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
  const h = { runtime: 'claude' };
  assert.throws(() => assertRuntimeLaunch(s, h), /owning runtime/, 'no recorded choice');
  h.runtimeAuthority = { runtime: 'codex', from: 'codex', by: 'codex:x' };
  assert.throws(() => assertRuntimeLaunch(s, h), /owning runtime/, 'a choice of another provider');
  h.runtimeAuthority = { runtime: 'claude', from: 'codex', by: 'codex:x' };
  assert.doesNotThrow(() => assertRuntimeLaunch(s, h));
});

// Named failure I-74: an adopted host repeatedly asks for runtime receipts against the historical admission provider.
for (const runtime of ['codex', 'claude']) test(`adoption inherits current ${runtime} owner for repeated handoffs and recovery`, () => {
  const other = runtime === 'codex' ? 'claude' : 'codex';
  const { root } = singleRepoProject(`adopt-runtime-${runtime}`, {
    classes: { review: { codex: { model: 'test-model', effort: 'high' }, claude: { model: 'test-model', effort: 'high' } } },
  });
  const id = ok(wf(root, ['entry', '--item', 'ENG-96', '--owner', `${other}:original-owner`, '--json'])).json().id;
  append(root, id, 'handoff', { role: 'planner', agent: 'old-provider', runtime: other }, `${other}:original-owner`);
  // Replay an adoption; what adoption needs is covered by adoption.test.mjs.
  append(root, id, 'owner.adopted', {}, `${runtime}:current-owner`);
  for (const agent of ['first-repair', 'second-repair', 'recovered']) {
    ok(wf(root, ['handoff', 'planner', '--attempt', id, '--agent', agent, ...(agent === 'first-repair' ? ['--runtime', runtime] : [])], { preserveRuntime: true, ownerSilent: true, env: agent === 'recovered' ? { [other === 'codex' ? 'CODEX_THREAD_ID' : 'CLAUDE_CODE_SESSION_ID']: 'unrelated-caller' } : {} }));
    const s = state(root, id), h = s.handoffs.at(-1);
    assert.equal(h.runtime, runtime);
    assert.equal(h.runtimeAuthority, undefined);
    assert.equal(s.originRuntime, other); // Admission remains audit history.
    assert.doesNotThrow(() => assertRuntimeLaunch(s, h));
  }
  const s = state(root, id);
  assert.throws(() => assertRuntimeLaunch(s, s.handoffs[0]), /owning runtime/);
  ok(wf(root, ['handoff', 'planner', '--attempt', id, '--agent', 'switch-back', '--runtime', other], { ownerSilent: true }));
  assert.equal(state(root, id).handoffs.at(-1).runtimeAuthority.runtime, other, 'a deliberate switch is recorded, not inherited from the history');
});

test('current owner wins over historical runtime and unrelated caller environment', () => {
  const s = { id: 'ENG-97.1', owner: 'codex:current', originRuntime: 'claude', owners: ['claude:original', 'codex:current'] };
  assert.doesNotThrow(() => assertRuntimeLaunch(s, { runtime: 'codex' }));
  assert.throws(() => assertRuntimeLaunch(s, { runtime: 'claude' }), /owning runtime/);
});

test('persistent selection is owner-bound, validated, and not inferred from old handoffs', () => {
  const s = { id: 'ENG-98.1', owner: 'codex:current-owner', originRuntime: 'claude' };
  const authority = { runtime: 'claude', from: 'codex', by: 'codex:current-owner' };
  for (const preference of [
    { owner: 'codex:previous-owner', runtime: 'claude', authority },
    { owner: s.owner, runtime: 'claude', authority: null },
    { owner: s.owner, runtime: 'claude', authority: { ...authority, runtime: 'codex' } },
  ]) assert.equal(defaultRuntime({ ...s, runtimePreference: preference }), 'codex');
  const admitted = { type: 'admitted', actor: s.owner, data: { id: s.id, originRuntime: 'claude' } };
  const handoff = { type: 'handoff', actor: s.owner, data: { role: 'planner', agent: 'p', runtime: 'claude', runtimeAuthority: authority } };
  assert.equal(defaultRuntime(reduce([admitted, handoff])), 'codex');
  handoff.data.runtimeSelected = true;
  handoff.data.runtimeSelectionOwner = s.owner;
  const selected = reduce([admitted, handoff]);
  assert.equal(defaultRuntime(selected), 'claude');
  assert.doesNotThrow(() => assertRuntimeLaunch(selected, { runtime: 'claude' }));
  assert.throws(() => assertRuntimeLaunch(selected, { runtime: 'codex' }), /owning runtime/);
  const adopted = reduce([admitted, handoff, { type: 'owner.adopted', actor: 'codex:next-owner', data: {} }]);
  assert.equal(adopted.runtimePreference, null);
  assert.equal(defaultRuntime(adopted), 'codex');
  const late = reduce([admitted, { type: 'owner.adopted', actor: 'codex:next-owner', data: {} }, handoff]);
  assert.equal(defaultRuntime(late), 'codex');
  assert.throws(() => assertRuntimeLaunch(late, handoff.data), /owning runtime/);
});
