// Plain git helpers for the scenarios that test the plugin's own scripts and kept modules (release, verify layout,
// state folders): a temporary folder, a shell command, a file, and a repo with a bare remote. Project fixtures for the
// flow live in helpers/ (makeProject).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export function sh(cwd, cmd) {
  const r = spawnSync('sh', ['-c', cmd], { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`${cmd} failed in ${cwd}: ${r.stderr || r.stdout}`);
  return r.stdout.trim();
}

export function tmp(name) {
  return fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), `wf-${name}-`));
}

export function write(dir, rel, content) {
  const f = path.join(dir, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, content);
}

// A repo on `main` (the plugin's own branch; projects bring their own) with a bare remote beside it at `<dir>.origin.git`.
export function makeRepo(dir, files = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const remote = `${dir}.origin.git`;
  sh(path.dirname(dir), `git init -q --bare -b main ${JSON.stringify(remote)}`);
  sh(dir, 'git init -q -b main');
  sh(dir, 'git config user.email t@example.test && git config user.name t && git config commit.gpgsign false');
  for (const [rel, content] of Object.entries(files)) write(dir, rel, content);
  sh(dir, `git add -A && git commit -q -m init && git remote add origin ${JSON.stringify(remote)} && git push -q origin main`);
  return { dir, remote };
}
