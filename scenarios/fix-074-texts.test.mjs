import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ok, sh, tmp, wf } from './helpers.mjs';

// Independent review of 0.7.4 (high, privacy): `wf improve close` wrote an inbox item's text into this public repository
// with a project name, a tracker key and review ids in it: the stripper knew only ticket-id shapes. It now also strips the
// maintainer's private names, from the denylist the privacy check reads or the one beside the inbox.
test('wf improve close strips the maintainer\'s private names from what it writes into the plugin repository', () => {
  const home = tmp('improve-privacy');
  const inbox = path.join(home, 'improvements');
  fs.mkdirSync(inbox, { recursive: true });
  const plugin = tmp('privacy-plugin');
  fs.mkdirSync(path.join(plugin, 'scenarios'));
  fs.writeFileSync(path.join(plugin, 'scenarios', 'fix.test.mjs'), "test('reproduces the failure', () => {});\n");
  sh(plugin, 'git init -q && git add -A && git -c user.name=t -c user.email=t@example.test commit -q -m init');
  const env = { env: { WF_IMPROVEMENTS_DIR: inbox, WF_PLUGIN_REPO: plugin } };
  const cwd = tmp('privacy-anywhere');
  ok(wf(cwd, ['improve', 'add', '--title', 'acmeapp lost a closure', '--what', 'In batch_77_x9 the acmeapp reviewer stopped', '--class', 'engine'], env));
  // The names are listed after the item was recorded: the inbox still holds them, and only close stands between them and the repo.
  fs.writeFileSync(path.join(home, 'privacy-denylist'), 'acmeapp\n/batch_\\d+_x\\d+/\n');
  ok(wf(cwd, ['improve', 'close', 'I-1', '--version', '9.9.9', '--test', 'scenarios/fix.test.mjs', '--fix', 'acmeapp closures are kept'], env));
  const written = fs.readFileSync(path.join(plugin, 'improvements', 'I-1.md'), 'utf8');
  for (const leak of ['acmeapp', 'batch_77_x9']) assert.ok(!written.toLowerCase().includes(leak), `leaked ${leak}:\n${written}`);
  assert.match(written, /<name> lost a closure/);
});
