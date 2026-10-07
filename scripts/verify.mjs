#!/usr/bin/env node
// `npm run verify`: the scenario suite on this machine and in a Linux container (as a non-root user and as root), the
// same two operating systems CI runs. Exits non-zero on any failure. Named failure: three pushes went red on the Linux
// runner only (inode reuse, a shared-folder race) because the suite had been run on macOS alone.
//
// The three legs run at the same time. They share nothing they write: the host leg works in this machine's temporary
// folder, each container in its own /tmp (its own copy of the checkout, its own HOME), the checkout is mounted
// read-only, and the scenarios' servers listen on ephemeral ports inside their own network namespace. Each leg runs
// its share of the machine's cores (`--test-concurrency`, below), so the three together start about as many test files
// as the machine has cores. Named cost: run one after the other the legs took 78s + 58s + 60s (196s in all).
//
//   npm run verify                     all three legs
//   npm run verify -- --host-only      this machine only (not enough before a push: Linux-only failures are real)
//   npm run verify -- --linux-only     the two container legs only
//   npm run verify -- --serial         one leg after the other, each with the whole machine
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyLayout } from './verify-layout.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const image = process.env.WF_VERIFY_IMAGE ?? 'node:22-bookworm';
const label = `agentic-workflow-verify=${process.pid}`;
const flags = new Set(process.argv.slice(2));
for (const f of flags) if (!['--host-only', '--linux-only', '--serial'].includes(f)) {
  process.stderr.write(`verify: unknown option ${f} (known: --host-only, --linux-only, --serial)\n`);
  process.exit(2);
}
const files = fs.readdirSync(path.join(repo, 'scenarios')).filter((f) => f.endsWith('.test.mjs')).sort().map((f) => `scenarios/${f}`);

const legs = [];
if (!flags.has('--linux-only')) legs.push({ name: `host (${process.platform} ${os.release()}, node ${process.version})`, host: true });
const docker = flags.has('--host-only') ? null : spawnSync('docker', ['version', '--format', '{{.Server.Version}}'], { encoding: 'utf8' });
const results = [];
if (docker && docker.status !== 0) {
  process.stdout.write('\n!!! docker is not available: the Linux run is SKIPPED. CI will run it; a Linux-only failure there is real.\n');
  results.push({ name: 'linux (skipped: no docker)', ok: true, skipped: true });
} else if (docker) {
  for (const user of ['node', 'root']) legs.push({ name: `linux ${image} as ${user}`, user });
}

// Test files at a time for each leg. Run in parallel, the legs share this machine's cores (the containers run in a VM
// on it), each by its cost: on macOS the host leg costs about 1.4 times a container leg (measured: 508 against 360 CPU
// seconds a suite run; process starts cost more on macOS). Run alone, a leg takes every core but one, node's default.
// WF_VERIFY_JOBS overrides it for every leg.
const cores = os.availableParallelism();
const parallel = !flags.has('--serial') && legs.length > 1;
const weight = (leg) => (leg.host && process.platform === 'darwin' ? 1.4 : 1);
const totalWeight = legs.reduce((n, leg) => n + weight(leg), 0);
const share = (leg) => Number(process.env.WF_VERIFY_JOBS) || (parallel ? Math.max(2, Math.round((cores * weight(leg)) / totalWeight)) : Math.max(1, cores - 1));

function command(leg) {
  const jobs = share(leg);
  const suite = ['--test', '--test-reporter=spec', `--test-concurrency=${jobs}`];
  if (leg.host) return { jobs, cmd: process.execPath, args: [...suite, ...files] };
  // Read-only mounts, copied inside the container: the suite writes into its own copy, never into this checkout or its
  // git directories (a linked worktree's are mounted and relinked too: scripts/verify-layout.mjs).
  const layout = verifyLayout(repo);
  const script = `set -e; ${layout.script} && cd ${layout.checkout} && mkdir -p /tmp/h && git config --global --add safe.directory "*" && git config --global user.email ci@example.test && git config --global user.name ci && git config --global init.defaultBranch main && git rev-parse --verify HEAD >/dev/null && node ${suite.join(' ')} scenarios/*.test.mjs`;
  const mounts = layout.binds.flatMap((b) => ['-v', `${b.host}:${b.at}:ro`]);
  const env = Object.entries(layout.env).flatMap(([k, v]) => ['-e', `${k}=${v}`]);
  return { jobs, cmd: 'docker', args: ['run', '--rm', '--label', label, '--user', leg.user, '-e', 'HOME=/tmp/h', ...env, ...mounts, image, 'sh', '-c', script] };
}

function run(leg) {
  const { jobs, cmd, args } = command(leg);
  const t = Date.now();
  if (!parallel) process.stdout.write(`\n=== ${leg.name}\n`);
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd: repo, stdio: ['ignore', 'pipe', 'pipe'] });
    children.add(child);
    const chunks = [];
    child.stdout.on('data', (c) => chunks.push(c));
    child.stderr.on('data', (c) => chunks.push(c));
    const done = (code) => {
      const out = Buffer.concat(chunks).toString('utf8');
      const summary = out.split('\n').filter((l) => /^(ℹ (tests|pass|fail|skipped)|✖ )/.test(l.trim())).join('\n');
      const seconds = Math.round((Date.now() - t) / 1000);
      // Named failure I-32: a failed leg's summary hid its assertion and stack, leaving no diagnostic evidence.
      process.stdout.write(`${parallel ? `\n=== ${leg.name} (${seconds}s, ${jobs} files at a time)\n` : ''}${code === 0 ? (summary || out.slice(-4000)) : out}\n`);
      results.push({ name: leg.name, ok: code === 0, seconds, jobs });
      resolve();
    };
    child.on('error', (error) => {
      chunks.push(Buffer.from(`failed to start: ${error.message}\n`));
      done(127);
    });
    child.on('close', (code) => {
      children.delete(child);
      done(code);
    });
  });
}

const children = new Set();
const removeContainers = () => {
  if (docker?.status !== 0) return;
  const left = spawnSync('docker', ['ps', '-aq', '--filter', `label=${label}`], { encoding: 'utf8' }).stdout.trim();
  if (left) spawnSync('docker', ['rm', '-f', ...left.split('\n')]);
};
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    for (const c of children) c.kill(sig);
    removeContainers();
    process.exit(130);
  });
}

const started = Date.now();
if (parallel) process.stdout.write(`verify: ${legs.length} legs in parallel: ${legs.map((l) => l.name).join('; ')}\n`);
if (parallel) await Promise.all(legs.map(run));
else for (const leg of legs) await run(leg);
// Anything left behind by an interrupted run of this script.
removeContainers();

process.stdout.write('\n=== verify\n');
for (const r of results) process.stdout.write(`${r.ok ? (r.skipped ? '!' : '✓') : '✗'} ${r.name}${r.seconds !== undefined ? ` (${r.seconds}s, ${r.jobs} files at a time)` : ''}\n`);
const failed = results.filter((r) => !r.ok);
const total = Math.round((Date.now() - started) / 1000);
process.stdout.write(failed.length ? `verify FAILED: ${failed.map((r) => r.name).join(', ')} (${total}s)\n` : `verify passed (${total}s${parallel ? ', legs in parallel' : ''})\n`);
process.exit(failed.length ? 1 : 0);
