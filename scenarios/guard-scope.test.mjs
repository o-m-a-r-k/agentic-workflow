import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { check } from '../hooks/guard-evidence.mjs';
import { check as baseline } from './fixtures/guard-0.1.15.mjs';
import { tmp, write } from './helpers.mjs';

const hook = path.resolve(import.meta.dirname, '../hooks/guard-evidence.mjs');
const judge = (cwd, command) => check({ tool_name: 'Bash', cwd, tool_input: { command } });

test('unrelated literal searches treat quoted regexes as data, never as evidence globs', () => {
  const cwd = tmp('literal-search');
  write(cwd, 'source.txt', 'one\ntwo\n');
  for (const command of ["rg -n '.*' source.txt", 'grep -n ".*" source.txt', "rg -e '.*' -- source.txt", "rg -n '.*;|()' source.txt", "rg -e '--pre=./.*' source.txt"]) {
    assert.equal(baseline({ cwd, tool_input: { command } }), null, 'frozen write protection permits this search');
    assert.equal(judge(cwd, command), null, command);
    const result = spawnSync(process.execPath, [hook], { input: JSON.stringify({ tool_name: 'Bash', cwd, tool_input: { command } }), encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  }
});

test('literal search recognition preserves protected project and worktree scope', () => {
  for (const marker of ['.workflow', '.wf-evidence', '.wf-worktrees']) {
    const base = tmp('search-scope');
    fs.mkdirSync(path.join(base, marker));
    write(base, 'nested/source.txt', 'one');
    assert.ok(judge(path.join(base, 'nested'), "rg -n '.*' source.txt"), marker);
    const alias = path.join(tmp('search-alias'), 'project');
    fs.symlinkSync(base, alias);
    assert.ok(judge(path.join(alias, 'nested'), "rg -n '.*' source.txt"), 'canonical scope survives a cwd alias');
  }
});

test('cross-project evidence and aliased operands remain protected without changing contents', () => {
  const base = tmp('cross-project-search');
  const cwd = path.join(base, 'ordinary');
  fs.mkdirSync(cwd);
  const file = path.join(base, 'protected/.wf-evidence/log.txt');
  write(base, 'protected/.wf-evidence/log.txt', 'protected bytes');
  fs.symlinkSync(file, path.join(cwd, 'alias.txt'));
  fs.symlinkSync(path.dirname(file), path.join(cwd, 'alias-dir'));
  fs.linkSync(file, path.join(cwd, 'hard-alias.txt'));
  for (const operand of [file, '../protected/.wf-evidence/log.txt', 'alias.txt', 'alias-dir/log.txt', 'hard-alias.txt']) {
    const command = "rg -n '.*' " + operand;
    assert.ok(judge(cwd, command), command);
    const result = spawnSync(process.execPath, [hook], { input: JSON.stringify({ tool_name: 'Bash', cwd, tool_input: { command } }), encoding: 'utf8' });
    assert.equal(result.status, 2, command);
  }
  assert.equal(fs.readFileSync(file, 'utf8'), 'protected bytes');
});

test('ambiguous shell shapes and evidence spellings retain the original conservative refusal', () => {
  const cwd = tmp('search-refusals');
  write(cwd, 'source.txt', 'one');
  for (const command of [
    "rg -n '.*' source.txt; touch x", "rg -n '.*' source.txt > out", "rg -n '.*' $(echo source.txt)",
    "rg -n '.*' .*", 'rg -n .* source.txt', "node -e '.*'", "env rg -n '.*' source.txt",
    "rg --hidden '.*' source.txt", "rg '.*' .", "rg '.*'", "rg '.*' missing.txt", "rg '--pre=./.*' source.txt",
    "rg '.wf-evidence|.*' source.txt", "rg '.wf-evid''ence|.*' source.txt", "rg -n \"$X\" '.*' source.txt",
  ]) assert.ok(judge(cwd, command), command);
});
