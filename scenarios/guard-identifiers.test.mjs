// Named failure: Markdown resultEvidence in a public documentation heredoc matched an assembled folder fragment.
// These are hook-decision fixtures only. Never execute their shell programs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { check } from '../hooks/guard-evidence.mjs';
import { check as baseline } from './fixtures/guard-0.1.15.mjs';
import { tmp } from './helpers.mjs';

test('guard identifier boundary: documentation suffixes are not standalone assembled evidence fragments', () => {
  const cwd = tmp('guard-identifier');
  fs.mkdirSync(path.join(cwd, '.workflow'));
  const judge = (command, dir = cwd) => check({ tool_name: 'Bash', cwd: dir, tool_input: { command } });
  const harmless = identifier => "python3 - <<'PY'\nfrom pathlib import Path\nPath('docs/telemetry.md').write_text('Fields: `" + identifier + "`')\nPY";
  for (const command of [harmless('resultEvidence'), harmless('ResultEvidence'), harmless('result_evidence'), "printf '%s' 'Fields: `resultEvidence`'", 'getEvidence() "$OTHER"']) {
    assert.equal(baseline({ cwd, tool_input: { command } }), null);
    assert.equal(judge(command), null, command);
  }
  for (const command of [
    "printf '%s' evidence${TAIL}", "printf '%s' evidence`printf x`", "printf '%s' evidence{one,two} \"$OTHER\"", "printf '%s' evidence(foo) \"$OTHER\"",
    'piece=evidence; printf "%s" "$piece"', 'printf "%s" ${PREFIX}evidence', 'printf "%s" $(printf prefix)evidence',
    'cat .wf-evidence/attempts/a', "cat '.wf-'\"evidence\"/attempts/a", 'cat .wf-\\x65vidence/attempts/a', 'cat .*/attempts/a',
    harmless('resultEvidence') + '\nrm .wf-evidence/ledger',
  ]) assert.ok(judge(command), command);
  const protectedCwd = path.join(cwd, '.wf-evidence');
  fs.mkdirSync(protectedCwd);
  assert.ok(judge(harmless('resultEvidence'), protectedCwd));
});
