// Fixer C (L13): the scan's library lists stay generic and small. A list may only grow through a plugin proposal that
// raises its cap here, so no project's stack accretes into the scan one name at a time.
import test from 'node:test';
import assert from 'node:assert/strict';
import { LIBRARY_LISTS } from '../engine/scan.mjs';

// The 0.8.0 sizes: entries of a set, alternatives of a pattern, summed over a list of patterns.
const CAPS = { SKIP_DIRS: 12, CONTAINERS: 21, CONTENT: 101, PATHS: 34, WRITE_CALL: 8, MIGRATION_DIR: 4, TEST_SCRIPT: 12, CRITICAL_LINE: 9, CODE: 16, LOCKFILES: 9 };
const alternatives = (re) => re.source.split('|').length;
const size = (v) => (v instanceof Set ? v.size : Array.isArray(v) ? v.reduce((n, [, re]) => n + alternatives(re), 0) : alternatives(v));

test('the scan\'s library lists are capped', () => {
  assert.deepEqual(Object.keys(LIBRARY_LISTS).sort(), Object.keys(CAPS).sort());
  for (const [name, list] of Object.entries(LIBRARY_LISTS)) assert.ok(size(list) <= CAPS[name], `${name} has ${size(list)} entries, over its cap of ${CAPS[name]}`);
});
