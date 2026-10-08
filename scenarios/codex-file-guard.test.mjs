import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { check } from '../hooks/guard-evidence.mjs';
import { tmp } from './helpers.mjs';

const protectedDir = '.wf-evidence';
const add = (file, text) => ['*** Begin Patch', '*** Add File: ' + file, '+' + text, '*** End Patch'].join('\n');
const judge = (command, cwd, tool_name = 'apply_patch') => check({ tool_name, cwd, tool_input: { command } });

test('I-43: native Codex patches check file targets without classifying source as shell', () => {
  const root = tmp('native-file-target');
  const content = 'regex .*; role wf-implementer; expansion $value; citation ' + protectedDir;
  assert.equal(judge(add('src/guard.test.mjs', content), root), null);
  assert.ok(judge(add('src/guard.test.mjs', content), root, 'Bash'), 'shell never takes the patch allowance');
  for (const target of [protectedDir + '/ledger', 'src/../' + protectedDir + '/ledger']) assert.ok(judge(add(target, 'tamper'), root));
  fs.mkdirSync(path.join(root, protectedDir));
  fs.symlinkSync(path.join(root, protectedDir), path.join(root, 'linked'));
  assert.ok(judge(add('linked/new', 'tamper'), root));
  const rename = ['*** Begin Patch', '*** Update File: src/a', '*** Move to: ' + protectedDir + '/ledger', '@@', '-a', '+b', '*** End Patch'].join('\n');
  assert.ok(judge(rename, root));
  const deletion = ['*** Begin Patch', '*** Delete File: ' + protectedDir + '/ledger', '*** End Patch'].join('\n');
  assert.ok(judge(deletion, root));
  assert.ok(judge(add('src/a', 'safe') + '\nrm -rf x', root));
  assert.ok(judge('not a patch', root));
  const mixed = add('src/a', 'safe').replace('*** End Patch', '*** Add File: ' + protectedDir + '/ledger\n+tamper\n*** End Patch');
  assert.ok(judge(mixed, root));
});
