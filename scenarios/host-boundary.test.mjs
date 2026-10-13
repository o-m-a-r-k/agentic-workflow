// The workflow knows no harness: which harness runs the agents (Claude Code, Codex, a future one) is an execution
// detail behind engine/hosts/ (docs/DESIGN.md, the host adapter layer). Every engine module outside that folder is judged
// by a plain search for a harness name, comments and messages included: a name that creeps back in is a harness fact that
// escaped its adapter.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const engine = path.join(import.meta.dirname, '..', 'engine');
const NAMES = /claude|codex|grok/i;

// Persisted values that must stay readable are the only reason to name a harness outside engine/hosts/. Today none is
// needed: a stored `runtime` string is looked up in the registry, never compared with a literal. Add an entry here
// (file -> why) only for a value an old ledger can hold that no adapter could answer for.
const ALLOWED = {};

test('no engine module outside engine/hosts/ names a harness', () => {
  const files = fs.readdirSync(engine).filter((f) => f.endsWith('.mjs'));
  assert.ok(files.length > 30, 'the engine modules were found');
  const found = [];
  for (const file of files) {
    if (ALLOWED[file]) continue;
    fs.readFileSync(path.join(engine, file), 'utf8').split('\n').forEach((line, i) => {
      if (NAMES.test(line)) found.push(`engine/${file}:${i + 1}: ${line.trim().slice(0, 100)}`);
    });
  }
  assert.deepEqual(found, [], 'a harness name outside engine/hosts/:\n  ' + found.join('\n  '));
});

test('every harness the engine knows has its adapter in engine/hosts/, with the capabilities it launches roles by', () => {
  const hosts = path.join(engine, 'hosts');
  for (const id of ['claude', 'codex']) assert.ok(fs.existsSync(path.join(hosts, `${id}.mjs`)), `${id}.mjs`);
  const index = fs.readFileSync(path.join(hosts, 'index.mjs'), 'utf8');
  assert.match(index, /const builtin = \(\) => \[claude, codex\]/, 'the registry lists the built-in harnesses on one line');
});
