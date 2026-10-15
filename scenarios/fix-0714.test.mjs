// 0.7.14, named failure: an implementer spent 201 of 270 minutes in sleep loops waiting for its own background end-to-end
// runs, and the owner read "active within the last minute" as progress. `wf signals` now shows what a working role runs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmp } from './helpers.mjs';
import { findHost } from '../engine/hosts/index.mjs';
import { courseLines } from '../engine/signals.mjs';

const at = (min) => new Date(Date.UTC(2026, 9, 15, 9, 0) + min * 60000).toISOString();

test('a working role\'s shell commands are read from its transcript on both harnesses, and the owner sees the loop it runs', () => {
  const dir = tmp('shell-runs');
  const claude = path.join(dir, 'claude.jsonl');
  fs.writeFileSync(claude, [
    { timestamp: at(0), message: { content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'S=/tmp/x; for i in $(seq 1 59); do [ -f $S/done ] && break; sleep 10; done' } }] } },
    { timestamp: at(20), message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] } },
    { timestamp: at(21), message: { content: [{ type: 'tool_use', id: 't2', name: 'Bash', input: { command: 'git status' } }] } },
    { timestamp: at(21), message: { content: [{ type: 'tool_result', tool_use_id: 't2', content: 'clean' }] } },
    { timestamp: at(22), message: { content: [{ type: 'tool_use', id: 't3', name: 'Bash', input: { command: 'npx playwright test e2e/specs/120.spec.ts' } }] } },
  ].map((x) => JSON.stringify(x)).join('\n'));
  const c = findHost('claude').shellRuns(claude);
  assert.deepEqual(c.runs.map((r) => Math.round(r.minutes)), [20, 0]);
  assert.equal(c.running.command, 'npx playwright test e2e/specs/120.spec.ts');
  const codex = path.join(dir, 'codex.jsonl');
  fs.writeFileSync(codex, [
    { timestamp: at(0), type: 'response_item', payload: { type: 'function_call', name: 'shell', call_id: 'c1', arguments: JSON.stringify({ command: ['bash', '-lc', 'sleep 600'] }) } },
    { timestamp: at(10), type: 'response_item', payload: { type: 'function_call_output', call_id: 'c1', output: '' } },
  ].map((x) => JSON.stringify(x)).join('\n'));
  assert.deepEqual(findHost('codex').shellRuns(codex).runs.map((r) => [r.command, Math.round(r.minutes)]), [['bash -lc sleep 600', 10]]);
  const shell = { running: { command: c.running.command, minutes: 30 }, longRuns: 1, longMinutes: 20, longest: [{ command: c.runs[0].command, minutes: 20 }] };
  const line = courseLines({ files: { changed: 1 }, rounds: [], implementers: [], wallMinutes: 60, sessions: [{ role: 'implementer', agent: 'i', minutes: 60, expectMinutes: 30, located: true, idleMinutes: 0, shell }], expect: {} }).find((l) => l.startsWith('implementer i'));
  assert.match(line, /running now: `npx playwright test e2e\/specs\/120\.spec\.ts` for 30 min/);
  assert.match(line, /20 min of its time in 1 shell command\(s\) of 5 min or more \(longest: `for i in \$\(seq 1 59\); do \[ -f \$S\/done \] && break; sleep 10; done`, 20 min\)/);
});
