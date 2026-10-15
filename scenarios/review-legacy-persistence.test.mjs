// Named failures: legacy fixed discoveries were mistaken for unclassified open defects; large native reviews ended
// without completing or recording their required judgments; an unbounded review (0.5.14 forced every round to run to
// completion) took 1,183 tool calls.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { blockingFindings } from '../engine/scope-decisions.mjs';
import { discoveredVerdicts } from '../engine/discovered.mjs';
import { roleInstructions } from '../engine/onboard.mjs';
import { loadConfig } from '../engine/config.mjs';
import { singleRepoProject } from './helpers.mjs';

function reviewer() {
  const project = singleRepoProject('legacy-review', { gate: { steps: [] } });
  return roleInstructions(loadConfig(project.root), 'reviewer', 'review');
}

test('legacy discovery compatibility preserves fix evidence; a finding blocks only for a reason the engine can check', () => {
  const legacy = { id: 'D1', status: 'fixed', summary: 'Legacy discovery', scope: null };
  assert.equal(discoveredVerdicts([legacy], { discovered: [{ id: 'D1', verdict: 'fixed' }] }).problems.length, 1);
  assert.deepEqual(discoveredVerdicts([legacy], { discovered: [{ id: 'D1', verdict: 'fixed', evidence: 'src/list.ts:20 verified repair' }] }).problems, []);
  const state = { scopeDecisions: [], repos: {}, criteria: [{ id: 'C1' }] };
  const closure = (f) => ({ reviewer: 'r', closure: { reviewer: 'r', findings: [{ id: 'F1', status: 'open', ...f }] } });
  // 0.7.0: severity alone never blocks; a finding that cites nothing checkable (no location, no plan criterion, no
  // invariant) blocks until a later round locates or verifies it (security review: unlocated findings must not fail open).
  assert.equal(blockingFindings(state, closure({ severity: 'critical', evidence: 'src/untouched.ts:3' })).length, 0, 'a located finding on code the attempt did not change is an observation');
  assert.equal(blockingFindings(state, closure({ severity: 'critical' })).length, 1, 'unlocated: blocks until located');
  assert.equal(blockingFindings(state, closure({ criterion: 'C1' })).length, 1);
  assert.equal(blockingFindings(state, closure({ criterion: 'C9', evidence: 'src/untouched.ts:3' })).length, 0, 'a criterion the plan does not have is no criterion');
  assert.equal(blockingFindings(state, closure({ invariant: 'tenant isolation' })).length, 1);
  assert.equal(blockingFindings(state, closure({ criterion: 'C1', status: 'fixed' })).length, 0);
  const prompt = reviewer();
  assert.doesNotMatch(prompt, /Uncertain causality remains blocking/);
  assert.doesNotMatch(prompt, /requiredByRequest|affectsChangedContract|wf scope ask/);
});
