import { test } from 'node:test';
import assert from 'node:assert/strict';
import { roleProgress } from '../engine/role-progress.mjs';

test('a quiet hour emits bounded liveness and no interim messages or invented progress', () => {
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
  assert.equal(output.length, 61, 'one start and at most one liveness line per minute');
  assert.match(output[0], /reviewer r3.*session-1234.*configured-model\/high/);
  assert.match(output[20], /elapsed 20m.*last runtime event 0s ago/);
  assert.match(output[60], /elapsed 60m.*last runtime event 40m ago/);
  assert.ok(output.every((line) => line.length < 220));
  assert.doesNotMatch(output.join(''), /finding|percent|ETA|verified|completed/);
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
  assert.equal(output.length, 2);
  assert.match(output[1], /process running/);
  progress.finish();
  time += 120_000;
  progress.heartbeat();
  assert.equal(output.length, 2);
});
