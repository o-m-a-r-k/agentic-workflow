#!/usr/bin/env node
// `npm run verify`: the scenario suite on this machine and in a Linux container (as a non-root user and as root), the
// same two operating systems CI runs. Exits non-zero on any failure. Named failure: three pushes went red on the Linux
// runner only (inode reuse, a shared-folder race) because the suite had been run on macOS alone.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const image = process.env.WF_VERIFY_IMAGE ?? 'node:22-bookworm';
const label = `agentic-workflow-verify=${process.pid}`;
const results = [];

const run = (name, cmd, args, opts = {}) => {
  process.stdout.write(`\n=== ${name}\n`);
  const t = Date.now();
  const r = spawnSync(cmd, args, { cwd: repo, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, ...opts });
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  const summary = out.split('\n').filter((l) => /^(ℹ (tests|pass|fail|skipped)|✖ )/.test(l.trim())).join('\n');
  process.stdout.write(`${summary || out.slice(-4000)}\n`);
  results.push({ name, ok: r.status === 0, seconds: Math.round((Date.now() - t) / 1000) });
  return r.status === 0;
};

run(`host (${process.platform} ${os.release()}, node ${process.version})`, process.execPath, ['--test', '--test-reporter=spec', ...fs.readdirSync(path.join(repo, 'scenarios')).filter((f) => f.endsWith('.test.mjs')).map((f) => `scenarios/${f}`)]);

const docker = spawnSync('docker', ['version', '--format', '{{.Server.Version}}'], { encoding: 'utf8' });
if (docker.status !== 0) {
  process.stdout.write('\n!!! docker is not available: the Linux run is SKIPPED. CI will run it; a Linux-only failure there is real.\n');
  results.push({ name: 'linux (skipped: no docker)', ok: true, skipped: true });
} else {
  // A read-only mount, copied inside the container: the suite writes into its own copy, never into this checkout.
  const script = 'set -e; rm -rf /tmp/w && cp -r /w /tmp/w && cd /tmp/w && mkdir -p /tmp/h && git config --global --add safe.directory "*" && git config --global user.email ci@example.test && git config --global user.name ci && git config --global init.defaultBranch main && node --test --test-reporter=spec scenarios/*.test.mjs';
  for (const user of ['node', 'root']) {
    run(`linux ${image} as ${user}`, 'docker', ['run', '--rm', '--label', label, '--user', user, '-e', 'HOME=/tmp/h', '-v', `${repo}:/w:ro`, image, 'sh', '-c', script]);
  }
  // Anything left behind by an interrupted run of this script.
  const left = spawnSync('docker', ['ps', '-aq', '--filter', `label=${label}`], { encoding: 'utf8' }).stdout.trim();
  if (left) spawnSync('docker', ['rm', '-f', ...left.split('\n')]);
}

process.stdout.write('\n=== verify\n');
for (const r of results) process.stdout.write(`${r.ok ? (r.skipped ? '!' : '✓') : '✗'} ${r.name}${r.seconds !== undefined ? ` (${r.seconds}s)` : ''}\n`);
const failed = results.filter((r) => !r.ok);
process.stdout.write(failed.length ? `verify FAILED: ${failed.map((r) => r.name).join(', ')}\n` : 'verify passed\n');
process.exit(failed.length ? 1 : 0);
