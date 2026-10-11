// Named failure I-75: shared roles required Claude-only tools and left native Codex reviews without a closure.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ok, singleRepoProject, wf } from './helpers.mjs';
import { CODEX_DOCUMENT_READ_INSTRUCTIONS } from '../engine/rules.mjs';

test('I-75: every generated role supplies host-supported evidence and image tools', () => {
  const { root } = singleRepoProject('runtime-tools', { roles: { tester: {} } });
  ok(wf(root, ['sync']));
  for (const runtime of ['.codex', '.claude']) {
    for (const file of fs.readdirSync(path.join(root, runtime, 'agents'))) {
      const body = fs.readFileSync(path.join(root, runtime, 'agents', file), 'utf8');
      assert.match(body, /Host tool compatibility/, file);
      assert.match(body, /wf evidence show/, file);
      assert.match(body, /view_image/, file);
      assert.match(body, /Never assume a Claude tool name exists in Codex/, file);
    }
  }
  const reviewer = fs.readFileSync(path.join(root, '.codex/agents/wf-reviewer.toml'), 'utf8');
  assert.match(reviewer, /fs\.writeFile/, 'closure needs an available Codex writer');
  assert.match(reviewer, /apply_patch/, 'Codex without Node REPL needs a supported file writer');
  assert.doesNotMatch(reviewer, /with the Write tool, not a Bash heredoc|Read tool only/);
  assert.match(reviewer, /Write only to the path in `reviewClosureFile`/);
  assert.match(reviewer, /Never fabricate verdicts or reduce scope to finish/);
});

test('I-75: owner skill and required-read instructions do not demand unavailable Claude tools', () => {
  const skill = fs.readFileSync(new URL('../skills/work/SKILL.md', import.meta.url), 'utf8');
  assert.match(skill, /view_image/);
  assert.match(skill, /fresh.*handoff/s, 'native Codex repair needs a fresh handed process');
  assert.doesNotMatch(skill, /same planner \(SendMessage\)|same agent with SendMessage|then the Read tool|yourself with the Read tool/);
  assert.match(CODEX_DOCUMENT_READ_INSTRUCTIONS, /wf evidence show/, 'shell-only Codex needs the permitted reader');
  for (const name of ['quick-fix', 'resume']) {
    const text = fs.readFileSync(new URL(`../skills/${name}/SKILL.md`, import.meta.url), 'utf8');
    assert.match(text, /wf handoff run --agent <id> --attempt <id>/, name);
    assert.match(text, /Native launches|fresh engine instructions/, name);
  }
});
