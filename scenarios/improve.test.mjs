import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ok, sh, singleRepoProject, tmp, wf } from './helpers.mjs';

// 0.3.0: the plugin improvement loop. A finding about the workflow itself is an improvement to the plugin, kept in a
// user-level inbox outside every repo, sanitised, worked from the plugin repo, closed only with a scenario test.

const inboxEnv = (dir, plugin) => ({ env: { WF_IMPROVEMENTS_DIR: dir, ...(plugin ? { WF_PLUGIN_REPO: plugin } : {}) } });
function pluginRepo() {
  const dir = tmp('plugin-repo');
  fs.mkdirSync(path.join(dir, 'scenarios'));
  fs.writeFileSync(path.join(dir, 'scenarios', 'fix.test.mjs'), "test('reproduces the failure', () => {});\n");
  sh(dir, 'git init -q && git add -A && git -c user.name=t -c user.email=t@example.test commit -q -m init');
  return dir;
}

test('capture: sanitised, stored in the inbox outside every repo; the owner\'s words kept verbatim only there', () => {
  const { root } = singleRepoProject('acmecorp', {});
  const inbox = path.join(tmp('inbox'), 'improvements');
  const plugin = pluginRepo();
  const r = ok(wf(root, ['improve', 'add', '--title', 'acmecorp delivery hid screenshots in ENG-12', '--what', 'see https://tracker.example.test/ENG-12 and /Users/someone/acmecorp/x.png, reported by dev@acmecorp.test', '--observed-in', 'ENG-12.1 delivered', '--quote', 'I cannot see the screenshots in ENG-12', '--class', 'tracker'], inboxEnv(inbox, plugin)));
  assert.match(r.out, /improvement I-1 recorded in your inbox \(outside every repo\)/);
  const text = fs.readFileSync(path.join(inbox, 'I-1.yaml'), 'utf8');
  assert.match(text, /title: <project> delivery hid screenshots in <ticket>/);
  for (const leak of ['https://', '/Users/', 'dev@', 'acmecorp delivery']) assert.ok(!text.split('quote:')[0].includes(leak), `leaked ${leak}`);
  assert.match(text, /quote: I cannot see the screenshots in ENG-12/, 'the quote is verbatim, in the user-level inbox only');
  assert.equal(sh(root, 'git status --porcelain'), '', 'nothing written into the project');
  assert.match(wf(root, ['improve', 'add', '--title', 't', '--what', 'w', '--class', 'nope'], inboxEnv(inbox)).err, /--class is one of engine, template, skill, guard, tracker, onboarding, docs, other/);
  assert.match(ok(wf(root, ['improve', 'list'], inboxEnv(inbox))).out, /I-1 {2}\[open, tracker\]/);
  assert.match(ok(wf(root, ['status'], inboxEnv(inbox))).out, /no open attempts/);
});

test('next: open items by recurrence, then age; close needs the scenario test and writes the generic history', () => {
  const inbox = path.join(tmp('inbox2'), 'improvements');
  const plugin = pluginRepo();
  const cwd = tmp('anywhere');
  const add = (title, extra = []) => ok(wf(cwd, ['improve', 'add', '--title', title, '--what', 'it happened', '--class', 'engine', ...extra], inboxEnv(inbox, plugin)));
  add('First thing went wrong');
  add('Second thing went wrong');
  assert.match(ok(wf(cwd, ['improve', 'next'], inboxEnv(inbox, plugin))).out, /^I-1 /);
  const close = (args) => wf(cwd, ['improve', 'close', 'I-1', ...args], inboxEnv(inbox, plugin));
  assert.match(close(['--version', '0.9.0', '--fix', 'f', '--test', 'scenarios/missing.test.mjs']).err, /scenarios\/missing\.test\.mjs does not exist in the plugin repo/);
  assert.match(close(['--version', '0.9.0', '--fix', 'f', '--test', 'scenarios/fix.test.mjs', '--name', 'no such test']).err, /has no test named "no such test"/);
  assert.match(close(['--version', '0.9.0', '--fix', 'f', '--test', '../outside.test.mjs']).err, /--test names the scenario test/);
  assert.match(close(['--version', 'soon', '--fix', 'f', '--test', 'scenarios/fix.test.mjs']).err, /--version is the plugin release/);
  const r = ok(close(['--version', '0.9.0', '--fix', 'the engine now checks it', '--test', 'scenarios/fix.test.mjs', '--name', 'reproduces the failure']));
  assert.match(r.out, /I-1 closed; history written to .*improvements\/I-1\.md/);
  const hist = fs.readFileSync(path.join(plugin, 'improvements', 'I-1.md'), 'utf8');
  assert.match(hist, /# I-1: First thing went wrong[\s\S]*Fixed in:\*\* 0\.9\.0[\s\S]*`scenarios\/fix\.test\.mjs` \(reproduces the failure\)[\s\S]*## Fix\n\nthe engine now checks it/);
  assert.match(ok(wf(cwd, ['improve', 'next'], inboxEnv(inbox, plugin))).out, /^I-2 /);
  // A regression of a closed item: flagged and first in line.
  const reg = add('First thing went wrong again');
  assert.match(reg.out, /regression of I-1 fixed in 0\.9\.0: it goes to the top of `wf improve next`/);
  assert.match(ok(wf(cwd, ['improve', 'next'], inboxEnv(inbox, plugin))).out, /^I-3 .*recurrence 1.*\(regression of I-1 fixed in 0\.9\.0\)/);
  assert.match(add('Unrelated', ['--regression-of', 'I-2']).out, /regression of I-2/);
  // Outside the plugin repo, nothing closes.
  assert.match(wf(cwd, ['improve', 'close', 'I-2', '--version', '0.9.1', '--fix', 'f', '--test', 'scenarios/fix.test.mjs'], inboxEnv(inbox, cwd)).err, /is not the plugin repo checkout/);
});

test('a symlinked inbox, or one inside the evidence, is refused', () => {
  const base = tmp('inbox-link');
  fs.mkdirSync(path.join(base, 'elsewhere'));
  fs.symlinkSync(path.join(base, 'elsewhere'), path.join(base, 'improvements'));
  const r = wf(base, ['improve', 'add', '--title', 't', '--what', 'w', '--class', 'docs'], inboxEnv(path.join(base, 'improvements')));
  assert.notEqual(r.code, 0);
  assert.match(r.err, /is a symlink; the inbox is not read or written through it/);
  assert.deepEqual(fs.readdirSync(path.join(base, 'elsewhere')), []);
});

test('the plugin repo carries the history of closed improvements, each naming its test', () => {
  const dir = path.join(import.meta.dirname, '..', 'improvements');
  const entries = fs.readdirSync(dir).filter((f) => /^I-\d+\.md$/.test(f));
  assert.ok(entries.length >= 10);
  for (const f of entries) {
    const text = fs.readFileSync(path.join(dir, f), 'utf8');
    const test = /\*\*Test:\*\* `([^`]+)`/.exec(text)?.[1];
    assert.ok(test, `${f} names its test`);
    assert.ok(fs.existsSync(path.join(import.meta.dirname, '..', test)), `${f}: ${test} exists`);
  }
});
