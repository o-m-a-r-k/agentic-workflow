// Fixer C (L13): the scan's library lists stay generic and small. A list may only grow through a plugin proposal that
// raises its cap here, so no project's stack accretes into the scan one name at a time.
import test from 'node:test';
import assert from 'node:assert/strict';
import { LIBRARY_LISTS } from '../engine/scan.mjs';

// The 0.8.1 sizes: entries of a set, alternatives of a pattern, summed over a list of patterns. 0.8.1 removed the code
// shapes the risk proposal read (CONTENT, PATHS, WRITE_CALL, MIGRATION_DIR, CONTAINERS, CRITICAL_LINE, CODE).
// 0.8.1's review added the test-folder names, config folders and settings files that tell configuration from tests.
const CAPS = { SKIP_DIRS: 12, TEST_SCRIPT: 12, LOCKFILES: 9, TEST_DIR: 7, CONFIG_DIR: 4, SETTINGS_FILE: 12 };
const alternatives = (re) => re.source.split('|').length;
const size = (v) => (v instanceof Set ? v.size : Array.isArray(v) ? v.reduce((n, [, re]) => n + alternatives(re), 0) : alternatives(v));

test('the scan\'s library lists are capped', () => {
  assert.deepEqual(Object.keys(LIBRARY_LISTS).sort(), Object.keys(CAPS).sort());
  for (const [name, list] of Object.entries(LIBRARY_LISTS)) assert.ok(size(list) <= CAPS[name], `${name} has ${size(list)} entries, over its cap of ${CAPS[name]}`);
});
