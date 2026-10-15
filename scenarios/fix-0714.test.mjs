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
  // The shapes real Codex sessions record: a shell run is an `exec` script calling `tools.exec_command`, a long one is
  // followed by `write_stdin` polls (its minutes add to the command they wait on), and older sessions used `function_call`.
  const exec = (id, script, min) => ({ timestamp: at(min), type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', call_id: id, input: script } });
  const done = (id, min, type = 'custom_tool_call_output') => ({ timestamp: at(min), type: 'response_item', payload: { type, call_id: id, output: [] } });
  fs.writeFileSync(codex, [
    exec('c1', 'const r = await tools.exec_command({cmd:"npx playwright test e2e/specs/120.spec.ts","workdir":"/w","yield_time_ms":10000}); text(r.output);\n', 0),
    done('c1', 1),
    exec('c2', 'const r = await tools.write_stdin({session_id:7,chars:"",yield_time_ms:60000}); text(r.output);\n', 1),
    done('c2', 7),
    { timestamp: at(8), type: 'response_item', payload: { type: 'function_call', name: 'shell', call_id: 'c3', arguments: JSON.stringify({ command: ['bash', '-lc', 'git status'] }) } },
    done('c3', 8, 'function_call_output'),
    exec('c4', 'const r = await tools.exec_command({cmd:"sleep 600"}); text(r.output);\n', 9),
  ].map((x) => JSON.stringify(x)).join('\n'));
  const x = findHost('codex').shellRuns(codex);
  assert.deepEqual(x.runs.map((r) => [r.command, Math.round(r.minutes)]), [['npx playwright test e2e/specs/120.spec.ts', 7], ['bash -lc git status', 0]]);
  assert.equal(x.running.command, 'sleep 600');
  const shell = { running: { command: c.running.command, minutes: 30 }, longRuns: 1, longMinutes: 20, longest: [{ command: c.runs[0].command, minutes: 20 }] };
  const line = courseLines({ files: { changed: 1 }, rounds: [], implementers: [], wallMinutes: 60, sessions: [{ role: 'implementer', agent: 'i', minutes: 60, expectMinutes: 30, located: true, idleMinutes: 0, shell }], expect: {} }).find((l) => l.startsWith('implementer i'));
  assert.match(line, /running now: `npx playwright test e2e\/specs\/120\.spec\.ts` for 30 min/);
  assert.match(line, /20 min of its time in 1 shell command\(s\) of 5 min or more \(longest: `for i in \$\(seq 1 59\); do \[ -f \$S\/done \] && break; sleep 10; done`, 20 min\)/);
});
