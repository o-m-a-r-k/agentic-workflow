// Named failures: legacy fixed discoveries were mistaken for unclassified open defects;
// large native reviews ended without completing or recording their required judgments.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scopeProblems, extraScope, blockingFindings } from '../engine/scope-decisions.mjs';
import { discoveredVerdicts } from '../engine/discovered.mjs';
import { roleInstructions } from '../engine/onboard.mjs';
import { loadConfig } from '../engine/config.mjs';
import { singleRepoProject } from './helpers.mjs';

function reviewer() {
  const project = singleRepoProject('legacy-review', { gate: { steps: [] } });
  return roleInstructions(loadConfig(project.root), 'reviewer', 'review');
}

test('legacy discovery compatibility preserves fix evidence and cannot waive open findings', () => {
  const legacy = { id: 'D1', status: 'fixed', summary: 'Legacy discovery', scope: null };
  assert.deepEqual(scopeProblems([legacy]), []);
  assert.equal(extraScope(legacy), false);
  assert.equal(blockingFindings({ scopeDecisions: [] }, {
    closure: { findings: [{ id: 'F1', status: 'open', scope: null }] },
  }).length, 1);
  assert.equal(discoveredVerdicts([legacy], {
    discovered: [{ id: 'D1', verdict: 'fixed' }],
  }).problems.length, 1);
  assert.deepEqual(discoveredVerdicts([legacy], {
    discovered: [{ id: 'D1', verdict: 'fixed', evidence: 'src/list.ts:20 verified repair' }],
  }).problems, []);
  const prompt = reviewer();
  assert.match(prompt, /historical discovered entries without structured scope/);
  assert.match(prompt, /absent metadata supplies no extra-scope waiver and no approval/);
  assert.match(prompt, /missing fix evidence remains blocking/);
  assert.match(prompt, /newly identified extra scope still requires explicit causal metadata and the owner decision/);
  assert.doesNotMatch(prompt, /Missing scope metadata remains blocking\./);
});

test('native reviewer persists across large inputs without narrowing its blind review', () => {
  const prompt = reviewer();
  assert.match(prompt, /large bundle or diff is not by itself a reason to finish with an incomplete review/);
  assert.match(prompt, /preserve your position across context compaction/);
  assert.match(prompt, /until every required judgment is complete and the closure is recorded/);
  assert.match(prompt, /concrete external blocker/);
  assert.match(prompt, /Never fabricate verdicts or reduce scope/);
  assert.match(prompt, /You review blind/);
  assert.match(prompt, /fresh agent for this round/);
  assert.match(prompt, /every section in bounded batches/);
  assert.match(prompt, /inventory is navigation, not completed inspection/);
  assert.match(prompt, /every screenshot/);
});
