#!/usr/bin/env node
// Exits 0 when GitHub CI's scenario workflow passed on the given commit, else says what to do and exits 1. The pre-push hook
// runs it for a push to main (`.githooks/pre-push`): the whole suite runs in CI, never on this machine.
import { spawnSync } from 'node:child_process';

const sha = process.argv[2];
if (!/^[0-9a-f]{40}$/.test(sha ?? '')) {
  process.stderr.write('ci-passed: give the full commit sha\n');
  process.exit(2);
}
const r = spawnSync('gh', ['run', 'list', '--commit', sha, '--workflow', 'scenarios', '--json', 'conclusion,status,databaseId', '--limit', '20'], { encoding: 'utf8' });
if (r.error || r.status !== 0) {
  process.stderr.write(`pre-push: could not ask GitHub whether CI passed on ${sha.slice(0, 10)} (${(r.stderr || r.error?.message || '').trim().split('\n')[0]}); push the branch, run CI on it, and push main again once it is green\n`);
  process.exit(1);
}
const runs = JSON.parse(r.stdout || '[]');
if (runs.some((x) => x.conclusion === 'success')) process.exit(0);
const pending = runs.find((x) => x.status !== 'completed');
process.stderr.write(`pre-push: CI has not passed on ${sha.slice(0, 10)}${pending ? ` (run ${pending.databaseId} is ${pending.status})` : runs.length ? ` (its runs: ${runs.map((x) => x.conclusion || x.status).join(', ')})` : ''}. Push the branch, run CI on it (\`gh workflow run scenarios --ref <branch>\`), and push main once it is green; the suite never runs on this machine for a push.\n`);
process.exit(1);
