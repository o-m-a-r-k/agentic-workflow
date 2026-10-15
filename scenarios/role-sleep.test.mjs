// 0.7.11, named failure (audit of role launches): a reviewer 94 minutes into its work was stopped as stalled 11 seconds after
// the machine woke from a 68-minute sleep; "68 minutes since its last event" was the sleep. The time a role's quiet spell
// spent with the machine asleep is said beside it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { asleepSince, courseLines, sleepSeams } from '../engine/signals.mjs';

test('quiet time the machine spent asleep is said beside a role\'s last activity', () => {
  const real = sleepSeams.last;
  const t = Date.parse('2026-10-15T06:50:22Z');
  try {
    sleepSeams.last = () => ({ sleptAt: t - 70 * 60000, wokeAt: t - 2 * 60000 });
    assert.deepEqual(asleepSince(t - 71 * 60000, t), { asleepMinutes: 68, wokeMinutesAgo: 2 });
    assert.equal(asleepSince(t - 60000, t), null, 'active since it woke');
    const s = { role: 'reviewer', agent: 'r40', minutes: 164, expectMinutes: null, located: true, idleMinutes: 71, asleepMinutes: 68, wokeMinutesAgo: 2 };
    const line = courseLines({ expect: {}, files: { changed: 1 }, rounds: [], wallMinutes: 200, implementers: [], sessions: [s] }).at(-1);
    assert.match(line, /last activity 71 min ago \(68 min of that with the machine asleep; it woke 2 min ago: not a stall\)/);
  } finally {
    sleepSeams.last = real;
  }
});
