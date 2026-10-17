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
  assert.match(ok(wf(cwd, ['improve', 'next'], inboxEnv(inbox, plugin))).out, /^I-3 .*recurrence 1.*\(regression of I-1 fixed in 0\.9\.0[,)]/);
  assert.match(add('Unrelated', ['--regression-of', 'I-2']).out, /regression of I-2/);
  // Outside the plugin repo, nothing closes.
  assert.match(wf(cwd, ['improve', 'close', 'I-2', '--version', '0.9.1', '--fix', 'f', '--test', 'scenarios/fix.test.mjs'], inboxEnv(inbox, cwd)).err, /is not the plugin repo checkout/);
});

// 0.7.27 (I-193), named failure: items closed during the preparation of a release read "closed, fixed in 0.7.27" while the
// published and running wf was 0.7.26; the session concluded the fix was available, updated, and met the old behaviour again.
test('list and show say when a fix is in a release newer than the running wf: not released or installed yet', () => {
  const inbox = path.join(tmp('inbox-unshipped'), 'improvements');
  const plugin = pluginRepo();
  const cwd = tmp('anywhere-unshipped');
  const run = (args) => ok(wf(cwd, ['improve', ...args], inboxEnv(inbox, plugin)));
  run(['add', '--title', 'Fixed in a later release', '--what', 'it happened', '--class', 'engine']);
  run(['add', '--title', 'Fixed in an earlier release', '--what', 'it happened', '--class', 'engine']);
  run(['close', 'I-1', '--version', '99.0.0', '--fix', 'f', '--test', 'scenarios/fix.test.mjs']);
  run(['close', 'I-2', '--version', '0.1.0', '--fix', 'f', '--test', 'scenarios/fix.test.mjs']);
  const list = run(['list']).out;
  const running = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, '..', 'package.json'), 'utf8')).version;
  assert.match(list, new RegExp(`I-1 {2}\\[closed, engine, fixed in 99\\.0\\.0, not released or installed yet: this wf is ${running.replace(/\./g, '\\.')}\\]`));
  assert.match(list, /I-2 {2}\[closed, engine, fixed in 0\.1\.0\] {2}Fixed in an earlier release/);
  assert.match(run(['show', 'I-1']).out, /fixed in 99\.0\.0, not released or installed yet/);
  assert.doesNotMatch(run(['show', 'I-2']).out, /not released/);
  // A regression of an item whose fix is not in this wf says so too: the fix is not running here.
  assert.match(run(['add', '--title', 'Fixed in a later release again', '--what', 'it happened', '--class', 'engine', '--regression-of', 'I-1']).out, /regression of I-1/);
  assert.match(run(['list']).out, /\(regression of I-1 fixed in 99\.0\.0, not released or installed yet: this wf is /);
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

test('the plugin repo carries the history of closed improvements, each naming its test, or the version that retired its check', () => {
  const dir = path.join(import.meta.dirname, '..', 'improvements');
  const entries = fs.readdirSync(dir).filter((f) => /^I-\d+\.md$/.test(f));
  assert.ok(entries.length >= 10);
  for (const f of entries) {
    const text = fs.readFileSync(path.join(dir, f), 'utf8');
    if (/^- \*\*Retired in:\*\* \d+\.\d+\.\d+$/m.test(text)) {
      assert.match(text, /^- \*\*Refusals recorded:\*\* .+$/m, `${f} records the refusals`);
      assert.match(text, /## Why it was retired\n\n\S/, `${f} gives its reason`);
      continue;
    }
    const test = /\*\*Test:\*\* `([^`]+)`/.exec(text)?.[1];
    assert.ok(test, `${f} names its test`);
    assert.ok(fs.existsSync(path.join(import.meta.dirname, '..', test)), `${f}: ${test} exists`);
  }
});

// 0.7.0 (stream D): a check that caught nothing is retired, not "fixed", and the refusal log says which checks nobody judged.
const refusalRows = (file, rows) => fs.writeFileSync(file, rows.map(([id, attempt], i) => JSON.stringify({ at: new Date(Date.UTC(2026, 9, 13, 8, i)).toISOString(), id, version: '0.7.0', cmd: 'x', sub: null, attempt, message: `${id} refused` })).join('\n') + '\n');

test('retire: a check that caught nothing is closed without a scenario test; the reason and the refusal counts are recorded', () => {
  // Named failure: closing needed a new scenario test, so a check that only ever refused wrongly could never leave the engine.
  const inbox = path.join(tmp('inbox-retire'), 'improvements');
  const log = path.join(path.dirname(inbox), 'refusals.jsonl');
  const plugin = pluginRepo();
  const cwd = tmp('anywhere-retire');
  refusalRows(log, [['guard:bash-scan', 'A.1'], ['guard:bash-scan', 'A.1'], ['guard:bash-scan', 'A.2'], ['guard:bash-scan', 'A.3'], ['guard:bash-scan', 'A.3'], ['other:check', 'A.1']]);
  const env = inboxEnv(inbox, plugin);
  const add = (title, extra = []) => ok(wf(cwd, ['improve', 'add', '--title', title, '--what', 'it refused harmless commands', '--class', 'guard', ...extra], env));
  add('The command scanner refuses harmless reads', ['--refusal', 'guard:bash-scan']);
  add('Second check, never fired');
  add('Third check');
  const close = (args) => wf(cwd, ['improve', 'close', ...args], env);
  assert.match(close(['I-1', '--retire', '--version', '0.7.0']).err, /--reason says why the check caught nothing/);
  assert.match(close(['I-1', '--retire', '--reason', 'r']).err, /--version is the plugin release that removes the check/);
  assert.match(close(['I-1', '--retire', '--version', '0.7.0', '--reason', 'r', '--test', 'scenarios/fix.test.mjs']).err, /--retire records no scenario test or fix/);
  assert.match(close(['I-1', '--retire', '--version', '0.7.0', '--reason', 'r', '--refusal', 'bad id!']).err, /a refusal id is letters, digits/);
  assert.equal(add('Fourth check').code, 0);
  // The item's own refusal id supplies the count when none is named at close.
  const r = ok(close(['I-1', '--retire', '--version', '0.7.0', '--reason', 'every refusal was a retry of a harmless command', '--commit', 'abc1234']));
  assert.match(r.out, /I-1 retired; history written to .*improvements\/I-1\.md/);
  assert.match(r.out, /refusals recorded: guard:bash-scan 5/);
  const hist = fs.readFileSync(path.join(plugin, 'improvements', 'I-1.md'), 'utf8');
  assert.match(hist, /# I-1: The command scanner refuses harmless reads/);
  assert.match(hist, /- \*\*Retired in:\*\* 0\.7\.0\n- \*\*Refusals recorded:\*\* `guard:bash-scan` 5 refusal\(s\) in 3 attempt\(s\)\n- \*\*Commit:\*\* abc1234/);
  assert.match(hist, /## Why it was retired\n\nevery refusal was a retry of a harmless command/);
  assert.ok(!/\*\*Test:\*\*|## Fix/.test(hist), 'no scenario test and no fix');
  const item = fs.readFileSync(path.join(inbox, 'I-1.yaml'), 'utf8');
  assert.match(item, /status: retired/);
  assert.match(item, /retiredReason: every refusal was a retry of a harmless command/);
  assert.match(item, /id: guard:bash-scan\n {4}count: 5\n {4}attempts: 3/);
  // Retired items are neither open nor fixed.
  assert.match(ok(wf(cwd, ['improve', 'list'], env)).out, /I-1 {2}\[retired, guard, retired in 0\.7\.0\]/);
  assert.match(ok(wf(cwd, ['improve', 'next'], env)).out, /^I-2 /);
  assert.match(ok(wf(cwd, ['improve', 'show', 'I-1'], env)).out, /retired because: every refusal was a retry of a harmless command\n {2}refusals: guard:bash-scan 5/);
  assert.match(close(['I-1', '--retire', '--version', '0.7.0', '--reason', 'again']).err, /I-1 is already retired \(0\.7\.0\)/);
  // Ids named at close: an id with no refusal counts zero. `--retire` ahead of the id parses as the flag's value.
  const two = ok(close(['--retire', 'I-2', '--version', '0.7.0', '--reason', 'it never fired', '--refusal', 'never:fired,other:check']));
  assert.match(two.out, /refusals recorded: never:fired 0, other:check 1/);
  assert.match(fs.readFileSync(path.join(plugin, 'improvements', 'I-2.md'), 'utf8'), /\*\*Refusals recorded:\*\* `never:fired` 0 refusal\(s\) in 0 attempt\(s\); `other:check` 1 refusal\(s\) in 1 attempt\(s\)/);
  // Nothing named: said so, in the entry and in the output.
  const three = ok(close(['I-3', '--retire', '--version', '0.7.0', '--reason', 'the check was removed with its feature']));
  assert.match(three.out, /refusals recorded: none named/);
  assert.match(fs.readFileSync(path.join(plugin, 'improvements', 'I-3.md'), 'utf8'), /\*\*Refusals recorded:\*\* none named/);
  // A fixed close still needs its test.
  assert.match(close(['I-4', '--version', '0.9.0', '--fix', 'f']).err, /--test names the scenario test/);
});

test('review: refusal ids by count, each with the improvements and closures that cite it', () => {
  // Named failure: nothing counted refusals, so nobody could say which checks refuse often and have never been judged.
  const inbox = path.join(tmp('inbox-review'), 'improvements');
  const log = path.join(path.dirname(inbox), 'refusals.jsonl');
  const plugin = pluginRepo();
  const cwd = tmp('anywhere-review');
  const env = inboxEnv(inbox, plugin);
  assert.equal(ok(wf(cwd, ['improve', 'review'], env)).out.trim(), 'no refusals recorded');
  refusalRows(log, [
    ['plain:noise', 'A.1'], ['review:unread', 'A.1'], ['guard:bash-scan', 'A.1'], ['guard:bash-scan', 'A.2'], ['guard:bash-scan', 'A.2'], ['guard:bash-scan', 'A.3'], ['guard:bash-scan', 'A.3'],
    ['review:unread', 'A.2'], ['attempt.mjs:77', 'A.2'], ['guard:bash', 'A.3'],
  ]);
  // Cited three ways: the item's own refusals field, its text, and a history entry in the plugin repo.
  ok(wf(cwd, ['improve', 'add', '--title', 'The scanner refuses harmless reads', '--what', 'it refuses reads', '--class', 'guard', '--refusal', 'guard:bash-scan'], env));
  ok(wf(cwd, ['improve', 'add', '--title', 'Unread document refusals', '--what', 'the check review:unread refuses reviewers who read the document', '--class', 'engine'], env));
  fs.mkdirSync(path.join(plugin, 'improvements'), { recursive: true });
  fs.writeFileSync(path.join(plugin, 'improvements', 'I-9.md'), '# I-9: A guard rewrite\n\n- **Class:** guard\n- **Fixed in:** 0.6.0\n- **Test:** `scenarios/fix.test.mjs`\n\n## Failure\n\nIt refused at attempt.mjs:77 when it should not.\n');
  const rows = ok(wf(cwd, ['improve', 'review', '--json'], env)).json();
  assert.deepEqual(rows.map((c) => [c.id, c.count, c.attempts.length, c.citedBy.map((x) => `${x.id}:${x.status}`)]), [
    ['guard:bash-scan', 5, 3, ['I-1:open']],
    ['review:unread', 2, 2, ['I-2:open']],
    ['plain:noise', 1, 1, []],
    ['attempt.mjs:77', 1, 1, ['I-9:closed']],
    ['guard:bash', 1, 1, []],
  ], 'sorted by count; an id is not cited by a longer id that starts with it');
  const text = ok(wf(cwd, ['improve', 'review'], env)).out;
  assert.match(text, /^5 refusal id\(s\), most refusals first; 2 not cited by any improvement or closure/);
  assert.match(text, /\n {4}5 {2}guard:bash-scan {2}\(3 attempt\(s\); last [^)]+\) {2}cited by I-1 \(open\)\n {7}e\.g\. guard:bash-scan refused/);
  assert.match(text, /plain:noise [^\n]*NOT cited by any improvement or closure/);
  assert.deepEqual(ok(wf(cwd, ['improve', 'review', '--uncited', '--json'], env)).json().map((c) => c.id), ['plain:noise', 'guard:bash']);
  assert.equal(ok(wf(cwd, ['improve', 'review', '--since', '2030-01-01'], env)).out.trim(), 'no refusals recorded');
  // Retiring the item records its closure against the ids it names.
  ok(wf(cwd, ['improve', 'close', 'I-1', '--retire', '--version', '0.7.0', '--reason', 'it caught nothing'], env));
  assert.deepEqual(ok(wf(cwd, ['improve', 'review', '--json'], env)).json().find((c) => c.id === 'guard:bash-scan').citedBy, [{ id: 'I-1', status: 'retired' }]);
});
