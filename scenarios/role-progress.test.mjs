import { test } from 'node:test';
import assert from 'node:assert/strict';
import { roleProgress, roleReport } from '../engine/role-progress.mjs';

test('I-59: a quiet hour emits one heartbeat per ten checks without invented progress', () => {
  let time = 0;
  const output = [];
  const progress = roleProgress({ role: 'reviewer', agent: 'r3', model: 'configured-model', effort: 'high' }, { now: () => time, write: (line) => output.push(line) });
  progress.start('session-1234');
  for (let minute = 1; minute <= 60; minute++) {
    time = minute * 60_000;
    if (minute === 20) progress.event();
    progress.heartbeat();
  }
  progress.finish();
  time += 60_000;
  progress.heartbeat();
  assert.equal(output.length, 7, 'one immediate start and six occasional liveness lines');
  assert.match(output[0], /reviewer r3.*session-1234.*configured-model\/high/);
  assert.match(output[2], /elapsed 20m.*last runtime event 0s ago/);
  assert.match(output[6], /elapsed 60m.*last runtime event 40m ago/);
  assert.ok(output.every((line) => line.length < 220));
  assert.doesNotMatch(output.join(''), /finding|percent|ETA|verified|completed/);
});

test('role reports are bounded, deduplicated, coalesced and explicitly unverified', () => {
  let time = 0;
  const lines = [];
  const p = roleProgress({ role: 'reviewer', agent: 'r' }, { now: () => time, write: (line) => lines.push(line) });
  p.report('before session');
  p.start('session-1234');
  p.report('\x1b[31mInspecting\x1b[0m invoices\npermission boundaries\u202e');
  p.report('Inspecting invoices permission boundaries');
  assert.equal(lines.length, 2);
  assert.match(lines[1], /agent report \(unverified\): Inspecting invoices permission boundaries/);
  p.report('older queued progress');
  p.report('newest queued progress');
  time = 60_000; p.heartbeat();
  assert.equal(lines.length, 3);
  assert.match(lines[2], /newest queued progress/);
  assert.doesNotMatch(lines.join(''), /before session|older queued|\x1b|\u202e/);
  p.report('superseded queued progress');
  p.report('newest queued progress');
  time += 60_000; p.heartbeat();
  assert.equal(lines.length, 3, 'returning to the last report clears superseded queued text');
  p.report('x'.repeat(10_000));
  p.finish(); p.finish(); p.report('after finish');
  assert.equal(lines.length, 4);
  assert.ok(lines[3].length < 700);
  assert.match(lines[3], /…\n$/);
});

test('only assistant text is reportable from supported native event streams', () => {
  assert.equal(roleReport({ type: 'item.completed', item: { type: 'agent_message', text: 'Inspecting billing' } }, 'codex'), 'Inspecting billing');
  assert.equal(roleReport({ type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'secret' }, { type: 'text', text: 'Inspecting lists' }, { type: 'tool_use', input: 'secret' }] } }, 'claude'), 'Inspecting lists');
  for (const type of ['reasoning', 'command_execution', 'mcp_tool_call']) assert.equal(roleReport({ type: 'item.completed', item: { type, text: 'secret' } }, 'codex'), null);
  assert.equal(roleReport({ type: 'item.started', item: { type: 'agent_message', text: 'partial' } }, 'codex'), null);
  assert.equal(roleReport({ type: 'result', result: 'completed' }, 'claude'), null);
});

test('heartbeat output is rate-limited and does not label a pre-session launch running', () => {
  let time = 0;
  const output = [];
  const progress = roleProgress({ role: 'planner', agent: 'p', model: 'configured-model' }, { now: () => time, write: (line) => output.push(line) });
  time = 60_000;
  progress.heartbeat();
  assert.equal(output.length, 0);
  progress.start('session-1234');
  progress.heartbeat();
  time += 59_999;
  progress.heartbeat();
  assert.equal(output.length, 1);
  time++;
  progress.heartbeat();
  assert.equal(output.length, 1, 'the first nine eligible checks stay silent');
  for (let duplicate = 0; duplicate < 100; duplicate++) progress.heartbeat();
  assert.equal(output.length, 1, 'rapid duplicate calls cannot advance the skip count');
  for (let check = 2; check <= 10; check++) {
    time += 60_000;
    progress.event();
    progress.heartbeat();
    assert.equal(output.length, check === 10 ? 2 : 1, 'runtime activity is liveness, not reportable review progress');
  }
  assert.equal(output.length, 2);
  assert.match(output[1], /process running.*elapsed 10m.*last runtime event 0s ago/);
  progress.finish();
  time += 120_000;
  progress.heartbeat();
  assert.equal(output.length, 2);
});
