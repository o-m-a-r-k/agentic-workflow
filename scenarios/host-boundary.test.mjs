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

// A stored `runtime` string is looked up in the registry, never compared with a literal. The lines allowed here name a
// file, not a harness: the instruction documents a project keeps (its own facts, read by the onboarding scan and listed
// by doctor), whichever harness reads them. Add an entry (file -> the line it allows, and why) only for such a fact.
const ALLOWED = {
  'scan.mjs': { line: /export const isInstructionDoc = /, why: 'the names of the instruction documents a project keeps' },
  'onboard.mjs': { line: /for \(const f of \['AGENTS\.md', 'CLAUDE\.md'\]\)/, why: 'the instruction documents at a project root' },
};

test('no engine module outside engine/hosts/ names a harness', () => {
  const files = fs.readdirSync(engine).filter((f) => f.endsWith('.mjs'));
  assert.ok(files.length > 20, 'the engine modules were found');
  const found = [];
  for (const file of files) {
    fs.readFileSync(path.join(engine, file), 'utf8').split('\n').forEach((line, i) => {
      if (NAMES.test(line) && !ALLOWED[file]?.line.test(line)) found.push(`engine/${file}:${i + 1}: ${line.trim().slice(0, 100)}`);
    });
  }
  assert.deepEqual(found, [], 'a harness name outside engine/hosts/:\n  ' + found.join('\n  '));
});

test('every harness the engine knows has its module in engine/hosts/, with the capabilities the engine uses', async () => {
  const hosts = path.join(engine, 'hosts');
  const index = fs.readFileSync(path.join(hosts, 'index.mjs'), 'utf8');
  assert.match(index, /const registry = new Map\(\[claude, codex\]\.map/, 'the registry lists the built-in harnesses on one line');
  for (const id of ['claude', 'codex']) {
    const host = (await import(path.join(hosts, `${id}.mjs`))).default;
    assert.equal(host.id, id);
    for (const fn of ['detect', 'transcript', 'timeline', 'launch', 'resume', 'event']) assert.equal(typeof host[fn], 'function', `${id}.${fn}`);
  }
});
