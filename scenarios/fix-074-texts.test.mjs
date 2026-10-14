import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

// 0.7.4: role texts that carry a rule no engine check enforces are pinned here, so a rewrite cannot drop the rule
// unnoticed (CONTRIBUTING.md: the texts change with the behaviour, in the same commit).
const ROOT = path.resolve(import.meta.dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

// I-86, named failure: an investigation asked the person for facts the read-only sources (logs, database, cluster,
// tracker) already held, and stopped until they answered.
test('an investigation queries the read-only sources before asking the person for a fact', () => {
  assert.match(read('skills/work/SKILL.md'), /In an investigation, query the read-only sources \(logs, database, cluster, tracker\) before asking the user for a fact\./);
  assert.match(read('templates/agents/planner.md'), /Investigations resolved from the read-only sources \([^)]*\) before anything is asked\./);
});

// I-97, named failure: a reviewer's "missing proof" finding was answered by committing diagnostic bundles (captures, logs,
// reports) to the repository and amending the criteria to publish them.
test('proof is managed evidence, never committed to the repository', () => {
  const work = read('skills/work/SKILL.md');
  assert.match(work, /## Proof belongs in evidence, not in the repository/);
  assert.match(work, /Never amend criteria to publish captures, logs or/);
  assert.match(read('templates/agents/planner.md'), /Proof is managed evidence, never a committed log or capture/);
  assert.match(read('templates/agents/implementer.md'), /Run outputs \(logs, captures, reports\) are not source: keep them in managed evidence or the tracker, never in a commit\./);
});

// I-110: texts that described checks 0.7.0 removed (rule verdict forms, transcript read receipts, required full reads).
test('no text describes the rule verdicts, read receipts or full-read demands 0.7.0 removed', () => {
  const design = read('docs/DESIGN.md');
  assert.doesNotMatch(design, /`wf accept` refuses, per rule id, a missing verdict/);
  assert.doesNotMatch(design, /`wf review` refuses unless, for every `read` document/);
  assert.doesNotMatch(read('engine/onboard.mjs'), /never claim a read that was truncated/);
  assert.doesNotMatch(read('engine/hosts/codex.mjs'), /supported full-file Node reader/);
});
