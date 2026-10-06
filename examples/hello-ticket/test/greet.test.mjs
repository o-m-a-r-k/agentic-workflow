import { test } from 'node:test';
import assert from 'node:assert/strict';
import { greet } from '../lib/greet.mjs';

test('greet() says hello', () => {
  assert.equal(greet(), 'Hello!');
});
