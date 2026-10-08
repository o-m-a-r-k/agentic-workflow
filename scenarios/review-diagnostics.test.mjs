// Named failure: refused-then-recorded submissions disappeared from the report, while unknown history was wasted.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reviewDiagnostics, reviewRounds } from '../engine/telemetry.mjs';

test('review diagnostics deduplicate handoffs and distinguish refusal history, failed starts and unknown outcomes', () => {
  const t = '2026-01-01T00:00:00.000Z', end = '2026-01-01T00:01:00.000Z';
  const handoffs = ['recorded', 'failed-start', 'failed-run', 'historical', 'current'].map(agent => ({ role: 'reviewer', agent, bundle: `/synthetic/${agent}.json`, at: t }));
  handoffs[1].launch = { status: 'failed', finishedAt: end };
  handoffs[2].launch = { status: 'failed', finishedAt: end };
  handoffs[2].session = 'started-session';
  const recorded = { handoff: handoffs[0].bundle, at: end, closure: { findings: [{ id: 'F1', severity: 'major', status: 'open' }] } };
  const s = { handoffs, reviews: [recorded, { ...recorded }], reviewRounds: [
    { bundle: handoffs[0].bundle, at: t, outcome: 'refused', reasonClass: 'unread-documents' },
    { bundle: handoffs[0].bundle, at: t, outcome: 'refused', reasonClass: 'unread-documents' },
    { bundle: handoffs[0].bundle, at: end, outcome: 'recorded' },
  ] };
  const before = JSON.stringify(s);
  const rounds = reviewRounds([], s);
  assert.deepEqual(rounds.map(r => r.result), ['recorded', 'failed-start', 'failed-run', 'unknown', 'open']);
  assert.equal(rounds.length, 5);
  assert.equal(rounds[0].findings.length, 1);
  assert.equal(rounds[3].resultEvidence, 'no-recorded-outcome');
  assert.equal(rounds[1].endedAt, end);
  assert.deepEqual(reviewDiagnostics(rounds), { roundsWithRefusal: 1, failedLaunchRounds: 2, failedStartRounds: 1, unknownOutcomeRounds: 1, refusalReasons: { 'unread-documents': 1 } });
  assert.equal(JSON.stringify(s), before, 'reporting changes no ledger/state or acceptance decision');
});
