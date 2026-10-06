import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

// This repository is public: no project, company, product or person names in any tracked file. The names to look for
// are the maintainer's own and are never committed: one per line in `.privacy-denylist` at the repo root (gitignored)
// or in the file named by WF_PRIVACY_DENYLIST. A line is a case-insensitive word, or /a regular expression/.

const repo = path.resolve(import.meta.dirname, '..');
const listFile = process.env.WF_PRIVACY_DENYLIST ?? path.join(repo, '.privacy-denylist');

test('no tracked file contains a denylisted name', { skip: !fs.existsSync(listFile) && `no denylist (${listFile}); create it locally to run this check` }, () => {
  const patterns = fs.readFileSync(listFile, 'utf8').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#')).map((l) => {
    const m = /^\/(.+)\/$/.exec(l);
    return m ? new RegExp(m[1], 'i') : new RegExp(`\\b${l.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
  });
  assert.ok(patterns.length, 'the denylist is empty');
  const ignored = spawnSync('git', ['check-ignore', '-q', listFile], { cwd: repo }).status === 0;
  if (listFile.startsWith(repo + path.sep)) assert.ok(ignored, `${listFile} must be gitignored`);
  const files = spawnSync('git', ['ls-files', '-z'], { cwd: repo, encoding: 'utf8' }).stdout.split('\0').filter(Boolean);
  const hits = [];
  for (const f of files) {
    const p = path.join(repo, f);
    if (!fs.existsSync(p) || fs.lstatSync(p).isSymbolicLink()) continue;
    const text = fs.readFileSync(p, 'utf8');
    for (const re of patterns) if (re.test(text) || re.test(f)) hits.push(`${f} matches ${re}`);
  }
  assert.deepEqual(hits, [], `denylisted names in tracked files:\n${hits.join('\n')}`);
});
