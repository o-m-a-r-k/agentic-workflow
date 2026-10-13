// Named failure I-75: shared roles required one harness's tools and left native reviews of another without a closure.
// Since the host adapter layer each harness's role files and the owner skills say only what that harness has: the
// harness-specific sentences are fragments its adapter supplies (engine/hosts/), not words in the shared templates.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ok, singleRepoProject, wf } from './helpers.mjs';

// Names of tools one harness has and the other does not.
const CLAUDE_ONLY = /\bwith (Read|Skill|Write)\b|the Write tool/;
const CODEX_ONLY = /view_image|apply_patch|fs\.writeFile/;

test('I-75: every generated role supplies its own harness\'s evidence, image and writer tools and names no other harness\'s', () => {
  const { root } = singleRepoProject('runtime-tools', { roles: { tester: {} } });
  ok(wf(root, ['sync']));
  for (const [dir, own, foreign] of [['.codex', CODEX_ONLY, CLAUDE_ONLY], ['.claude', CLAUDE_ONLY, CODEX_ONLY]]) {
    for (const file of fs.readdirSync(path.join(root, dir, 'agents'))) {
      const body = fs.readFileSync(path.join(root, dir, 'agents', file), 'utf8');
      assert.match(body, /Host tool compatibility/, file);
      assert.match(body, /wf evidence show/, file);
      assert.match(body, own, `${dir}/${file} names its harness's tools`);
      assert.doesNotMatch(body, foreign, `${dir}/${file} names no tool its harness lacks`);
      assert.doesNotMatch(body, /Never assume a Claude tool name exists in Codex/, file);
    }
  }
  const codex = fs.readFileSync(path.join(root, '.codex/agents/wf-reviewer.toml'), 'utf8');
  assert.match(codex, /fs\.writeFile/, 'closure needs an available Codex writer');
  assert.match(codex, /apply_patch/, 'Codex without Node REPL needs a supported file writer');
  assert.doesNotMatch(codex, /with the Write tool, not a Bash heredoc|Read tool only/);
  assert.match(codex, /Write only to the path in `reviewClosureFile`/);
  assert.match(codex, /Never fabricate verdicts or reduce scope to finish/);
  const claude = fs.readFileSync(path.join(root, '.claude/agents/wf-reviewer.md'), 'utf8');
  assert.match(claude, /Write only to the path in `reviewClosureFile` \(the Write tool on that file\)/);
  assert.match(claude, /^tools: .*\bWrite\b/m, 'the Claude reviewer carries the Write tool it is told to use');
  assert.match(claude, /Never fabricate verdicts or reduce scope to finish/);
});

test('I-75: owner skill and required-read instructions name no harness\'s tools and teach the fresh native launch', () => {
  const skill = fs.readFileSync(new URL('../skills/work/SKILL.md', import.meta.url), 'utf8');
  assert.match(skill, /fresh.*handoff/s, 'native repair needs a fresh handed process');
  assert.doesNotMatch(skill, /view_image|same planner \(SendMessage\)|same agent with SendMessage|then the Read tool|yourself with the Read tool|Claude Read/);
  for (const name of ['work', 'quick-fix', 'resume']) {
    const text = fs.readFileSync(new URL(`../skills/${name}/SKILL.md`, import.meta.url), 'utf8');
    assert.match(text, /wf handoff run --agent <id> --attempt <id>/, name);
    assert.match(text, /Native launches|native launches|fresh engine instructions/, name);
    assert.doesNotMatch(text, /\bIn Codex\b|\bCodex:|Claude Code: send|on the Agent call/, `${name} carries no sentence for one harness only`);
  }
});
