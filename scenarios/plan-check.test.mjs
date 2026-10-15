// 0.7.11, named failure (audit of 51 attempts): 9 plans were refused for the form of their impact analysis only after the
// planner had reported, and two needed a fresh planner. `wf plan --check` runs every check `wf plan` runs and records
// nothing, so the planner fixes its own plan before it reports.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { criteriaFile, ok, singleRepoProject, state, wf } from './helpers.mjs';

test('wf plan --check says what wf plan would refuse, records nothing, and accepts the plan it would accept', () => {
  const { base, root } = singleRepoProject('plan-check', { gate: { steps: [{ id: 'unit', repo: 'app', run: 'true' }] } });
  const e = ok(wf(root, ['entry', '--item', 'PC-1', '--owner', 'o', '--json'])).json();
  ok(wf(root, ['handoff', 'planner', '--agent', 'p', '--attempt', e.id]));
  const noExpect = path.join(base, 'no-expect.yaml');
  fs.writeFileSync(noExpect, '```yaml\nplan: change a\ncriteria:\n  - { id: C1, text: a changes, uat: a shows the new text }\n```\n');
  const before = state(root, e.id).seq ?? null;
  const refused = wf(root, ['plan', '--check', '--file', noExpect, '--attempt', e.id]);
  assert.equal(refused.code, 75);
  assert.match(refused.err, /the plan states no expectation/);
  const s = state(root, e.id);
  assert.equal(s.criteria ?? null, null, 'nothing frozen');
  assert.equal((s.planRefusals ?? []).length, 0, 'a dry run records no refusal');
  assert.equal(s.seq ?? null, before, 'the ledger did not move');
  const good = criteriaFile(base);
  assert.match(ok(wf(root, ['plan', '--check', '--file', good, '--attempt', e.id])).out, /the plan would be accepted: 1 criteria, 0 work item\(s\), the impact analysis checks out \(queries re-run\); nothing was recorded/);
  assert.equal(state(root, e.id).criteria ?? null, null);
  ok(wf(root, ['plan', '--file', good, '--attempt', e.id]));
  assert.equal(state(root, e.id).criteria.length, 1);
});
