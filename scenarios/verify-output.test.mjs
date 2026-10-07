import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmp, write } from './helpers.mjs';

test('failed verification retains the failing assertion and stack instead of only test names', () => {
  // Named failure I-32: summarizing a failed leg discarded the only evidence of an intermittent assertion failure.
  const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const root = tmp('verify-diagnostics');
  fs.mkdirSync(path.join(root, 'scripts'));
  for (const file of ['verify.mjs', 'verify-layout.mjs']) fs.copyFileSync(path.join(repo, 'scripts', file), path.join(root, 'scripts', file));
  write(root, 'scenarios/failure.test.mjs', "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\ntest('intermittent scenario', () => assert.fail('diagnostic assertion details'));\n");
  const verifierEnv = { ...process.env };
  delete verifierEnv.NODE_TEST_CONTEXT; // this is an independent verifier, not a recursive invocation of node:test
  const result = spawnSync(process.execPath, ['scripts/verify.mjs', '--host-only'], { cwd: root, encoding: 'utf8', env: verifierEnv });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /diagnostic assertion details/);
  assert.match(result.stdout, /failure\.test\.mjs:3/);
  assert.match(result.stdout, /verify FAILED/);
});
