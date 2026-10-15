// Named failure I-75: shared roles required one harness's tools and left native reviews of another without a closure.
// Since the host adapter layer each harness's role files and the owner skills say only what that harness has: the
// harness-specific sentences are fragments its adapter supplies (engine/hosts/), not words in the shared templates.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ok, singleRepoProject, wf } from './helpers.mjs';

// Phrases that name a tool one harness has and the other does not.
const CLAUDE_ONLY = /\bwith (Read|Skill|Write)\b|the Write tool/;
const CODEX_ONLY = /view_image|apply_patch|fs\.writeFile/;

test('I-75: every generated role file exists for both harnesses and names no tool the other harness has; the Claude reviewer carries the Write tool it closes with', () => {
  const { root } = singleRepoProject('runtime-tools', { roles: { tester: {} } });
  ok(wf(root, ['sync']));
  for (const [dir, foreign] of [['.codex', CLAUDE_ONLY], ['.claude', CODEX_ONLY]]) {
    const files = fs.readdirSync(path.join(root, dir, 'agents'));
    assert.ok(files.length > 0, `${dir}/agents holds the generated roles`);
    for (const file of files) assert.doesNotMatch(fs.readFileSync(path.join(root, dir, 'agents', file), 'utf8'), foreign, `${dir}/${file} names no tool its harness lacks`);
  }
  assert.ok(fs.existsSync(path.join(root, '.codex/agents/wf-reviewer.toml')));
  const claude = fs.readFileSync(path.join(root, '.claude/agents/wf-reviewer.md'), 'utf8');
  assert.match(claude, /^tools: .*\bWrite\b/m, 'the Claude reviewer carries the Write tool it is told to use');
});
