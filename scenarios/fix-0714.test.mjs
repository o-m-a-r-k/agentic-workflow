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
  const done = (id, min, type = 'custom_tool_call_output', text = '{"exit_code":0,"output":""}') => ({ timestamp: at(min), type: 'response_item', payload: { type, call_id: id, output: [{ type: 'input_text', text: 'Script completed\nWall time 1 seconds\nOutput:\n' }, { type: 'input_text', text }] } });
  fs.writeFileSync(codex, [
    exec('c1', 'const r = await tools.exec_command({cmd:"npx playwright test e2e/specs/120.spec.ts","workdir":"/w","yield_time_ms":10000}); text(r.output);\n', 0),
    done('c1', 1, 'custom_tool_call_output', '{"session_id":7,"output":""}'),
    exec('c5', 'text(await tools.exec_command({cmd:"rg --files src"}));\n', 1),
    done('c5', 1.1),
    exec('c2', 'const r = await tools.write_stdin({session_id:7,chars:"",yield_time_ms:60000}); text(r.output);\n', 1.1),
    done('c2', 7),
    { timestamp: at(8), type: 'response_item', payload: { type: 'function_call', name: 'shell', call_id: 'c3', arguments: JSON.stringify({ command: ['bash', '-lc', 'git status'] }) } },
    done('c3', 8, 'function_call_output'),
    exec('c4', 'const r = await tools.exec_command({cmd:"sleep 600"}); text(r.output);\n', 9),
  ].map((x) => JSON.stringify(x)).join('\n'));
  const x = findHost('codex').shellRuns(codex);
  // The poll's minutes are the playwright run's, by its session, not the quick search that finished just before it.
  assert.deepEqual(x.runs.map((r) => [r.command, Math.round(r.minutes)]), [['npx playwright test e2e/specs/120.spec.ts', 7], ['rg --files src', 0], ['bash -lc git status', 0]]);
  assert.equal(x.running.command, 'sleep 600');
  const shell = { running: { command: c.running.command, minutes: 30 }, longRuns: 1, longMinutes: 20, longest: [{ command: c.runs[0].command, minutes: 20 }] };
  const line = courseLines({ files: { changed: 1 }, rounds: [], implementers: [], wallMinutes: 60, sessions: [{ role: 'implementer', agent: 'i', minutes: 60, expectMinutes: 30, located: true, idleMinutes: 0, shell }], expect: {} }).find((l) => l.startsWith('implementer i'));
  assert.match(line, /running now: `npx playwright test e2e\/specs\/120\.spec\.ts` for 30 min/);
  assert.match(line, /20 min of its time in 1 shell command\(s\) of 5 min or more \(longest: `for i in \$\(seq 1 59\); do \[ -f \$S\/done \] && break; sleep 10; done`, 20 min\)/);
});

// 0.7.15 (lessons of one long attempt): a re-plan is measured from itself, the whole attempt only against the plan's own
// expectation; criterion churn and repeating discovered families are shown; an ended attempt's minutes stop at its end.
test('course lines measure a re-plan from itself and show churn and repeating discovered families', async () => {
  const { pastEstimates } = await import('../engine/signals.mjs');
  const base = { files: { changed: 724 }, rounds: [], implementers: [], sessions: [], wallMinutes: 7644, amendments: 138, churn: { changed: 163, added: 5, dropped: 0 }, discoveredFamilies: { 'payroll-fence-callers': 3, once: 1 } };
  const replanned = { ...base, expect: { files: 4, rounds: 1, minutes: 65 }, firstExpect: { files: 4, rounds: 1, minutes: 65 }, planExpect: null, replan: { at: at(0), amendment: 138, minutes: 356, rounds: 0 } };
  const lines = courseLines(replanned, { shell: false }).join('\n');
  assert.match(lines, /files changed: 724; the plan states no expectation/, 'a re-plan never stands for the whole attempt');
  assert.match(lines, /since the re-plan \(amendment 138\): 356 minutes and 0 review round\(s\); it expected 65 minutes and 1 round\(s\) \(past its own estimate\)/);
  assert.match(lines, /plan amendments: 138 \(163 criterion text\(s\) rewritten, 5 added, 0 dropped\)/);
  assert.match(lines, /discovered issues of family payroll-fence-callers: 3 open; fix the class in one sweep/);
  assert.doesNotMatch(lines, /family once/);
  assert.deepEqual(pastEstimates(replanned), ['356 minutes since the re-plan (it expected 65)'], 'no files prompt right after a re-plan');
  const planned = { ...base, files: { changed: 3 }, wallMinutes: 30, expect: { files: 2, rounds: 1, minutes: 60 }, firstExpect: { files: 2, rounds: 1, minutes: 60 }, planExpect: { files: 2, rounds: 1, minutes: 60 }, replan: null };
  assert.deepEqual(pastEstimates(planned), ['files changed 3 (the plan expected 2)'], 'without a re-plan nothing changes');
});

test('an ended attempt counts its minutes to its end, not to now', async () => {
  const { computeSignals } = await import('../engine/signals.mjs');
  const { loadState } = await import('../engine/ledger.mjs');
  const { singleRepoProject, ok, wf } = await import('./helpers.mjs');
  const p = singleRepoProject('signals-ended', { gate: { steps: [] } });
  const e = ok(wf(p.root, ['entry', '--item', 'ENG-1', '--owner', 'o', '--json'])).json();
  ok(wf(p.root, ['abandon', '--reason', 'scenario', '--attempt', e.id]));
  const sig = computeSignals(p.root, loadState(p.root, e.id), { nowMs: Date.now() + 24 * 3600 * 1000 });
  assert.ok(sig.wallMinutes < 5, `wall minutes ${sig.wallMinutes}`);
});
