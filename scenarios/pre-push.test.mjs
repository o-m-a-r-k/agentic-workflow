import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { makeRepo, sh, tmp, write } from './helpers.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('pre-push verification uses foreign fixture repositories without changing the source Git metadata', () => {
  // Named failure I-30: Git hook variables sent the verifier fixtures into the source Git directory.
  const base = tmp('pre-push-env');
  const { dir: source, remote } = makeRepo(path.join(base, 'source'), { 'a.txt': 'original\n' });
  const dir = path.join(base, 'linked');
  sh(source, 'git worktree add -q -b candidate ' + JSON.stringify(dir));
  const hooks = path.join(dir, '.hooks');
  const bin = path.join(base, 'bin');
  fs.mkdirSync(hooks);
  fs.mkdirSync(bin);
  fs.copyFileSync(path.join(repo, '.githooks/pre-push'), path.join(hooks, 'pre-push'));
  fs.chmodSync(path.join(hooks, 'pre-push'), 0o755);
  sh(dir, 'git config core.hooksPath .hooks');
  write(dir, 'a.txt', 'changed\n');
  sh(dir, 'git add a.txt && git commit -q -m change');
  const head = sh(dir, 'git rev-parse HEAD');
  const configFile = path.join(source, '.git/config');
  const config = fs.readFileSync(configFile, 'utf8');
  const fixture = path.join(base, 'fixture');
  const marker = path.join(base, 'verified.json');
  write(bin, 'npm', `#!/usr/bin/env node
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
if (process.argv.slice(2).join(' ') !== 'run --silent verify') process.exit(97);
fs.mkdirSync(process.env.TEST_FIXTURE);
const initialized = spawnSync('git', ['init', '-q', '-b', 'fixture'], { cwd: process.env.TEST_FIXTURE, encoding: 'utf8' });
const observed = spawnSync('git', ['rev-parse', '--absolute-git-dir'], { cwd: process.env.TEST_FIXTURE, encoding: 'utf8' });
fs.writeFileSync(process.env.TEST_MARKER, JSON.stringify({ initialized: initialized.status, observed: observed.status, gitdir: observed.stdout.trim() }));
process.exit(Number(process.env.TEST_VERIFY_EXIT));
`);
  fs.chmodSync(path.join(bin, 'npm'), 0o755);
  const env = { ...process.env, PATH: bin + path.delimiter + process.env.PATH, TEST_FIXTURE: fixture, TEST_MARKER: marker, TEST_VERIFY_EXIT: '0' };
  const pushed = spawnSync('git', ['push', '-q', 'origin', 'HEAD:main'], { cwd: dir, env, encoding: 'utf8' });
  assert.equal(pushed.status, 0, pushed.stderr);
  assert.deepEqual(JSON.parse(fs.readFileSync(marker, 'utf8')), { initialized: 0, observed: 0, gitdir: path.join(fixture, '.git') });
  assert.equal(sh(dir, 'git rev-parse HEAD'), head);
  assert.equal(fs.readFileSync(configFile, 'utf8'), config);
  assert.equal(sh(base, 'git --git-dir=' + remote + ' rev-parse main'), head);

  // The hook still runs the verifier and refuses a push when it fails.
  write(dir, 'a.txt', 'refused\n');
  sh(dir, 'git add a.txt && git commit -q -m refused');
  const refused = spawnSync('git', ['push', '-q', 'origin', 'HEAD:main'], {
    cwd: dir, env: { ...env, TEST_FIXTURE: path.join(base, 'refused-fixture'), TEST_VERIFY_EXIT: '23' }, encoding: 'utf8',
  });
  assert.notEqual(refused.status, 0);
  assert.equal(sh(base, 'git --git-dir=' + remote + ' rev-parse main'), head, 'failed verification leaves the remote unchanged');
});
