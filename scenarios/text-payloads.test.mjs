// What the texts tell agents to write is what the engine accepts. Named failure (0.7.0): the engine was relaxed first and
// the texts followed a day later, so agents were told to write what the engine refused. The reviewer's text names every
// field of a finding, the severities, the classes and the verified statuses; each list is read from the text and compared
// with the engine's, and a finding written exactly as the text describes it passes the engine's check.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { CLASSES, SEVERITIES, checkFinding } from '../engine/findings.mjs';

const ROOT = path.join(import.meta.dirname, '..');
const reviewer = fs.readFileSync(path.join(ROOT, 'templates', 'agents', 'reviewer.md'), 'utf8');
const flow = fs.readFileSync(path.join(ROOT, 'engine', 'flow.mjs'), 'utf8');

test('the reviewer text lists the severities, classes and verified statuses the engine accepts, no more and no fewer', () => {
  const severities = /`severity` \(([^)]+)\)/.exec(reviewer)?.[1].split(/,\s*/);
  assert.deepEqual(severities, SEVERITIES);
  const classes = [...reviewer.matchAll(/^- `([a-z]+)`:/gm)].map((m) => m[1]);
  assert.deepEqual(classes, CLASSES);
  const statuses = /status: ([a-z|]+) \}/.exec(reviewer)?.[1].split('|');
  assert.deepEqual(statuses, ['fixed', 'open']);
  assert.match(flow, /\['fixed', 'open'\]\.includes\(v\.status\)/, 'the engine checks the same statuses');
});

test('a finding written with the fields the reviewer text names passes the engine\'s check; one missing a field does not', () => {
  const fields = /Each finding has (.+?) and `class`/.exec(reviewer)?.[1];
  assert.ok(fields, 'the text names the fields');
  const named = [...fields.matchAll(/`([a-z]+)`/g)].map((m) => m[1]).filter((f) => f !== 'repo');
  assert.deepEqual(named.slice(0, 4), ['location', 'what', 'why', 'severity']);
  const form = /`location` \(`([^`]+)`\)/.exec(reviewer)?.[1];
  assert.equal(form, 'repo/path:line');
  const finding = { location: 'app/src/a.mjs:3', what: 'the sum of an empty list is undefined', why: 'the total shows blank', severity: SEVERITIES[0], class: CLASSES[0] };
  assert.deepEqual(checkFinding(finding, ['app'], 0), []);
  for (const k of [...named.slice(0, 4), 'class']) assert.notDeepEqual(checkFinding({ ...finding, [k]: undefined }, ['app'], 0), [], `${k} is required`);
});
