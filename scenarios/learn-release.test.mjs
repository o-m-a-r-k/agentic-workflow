// Stream 5: the release check scripts/release.mjs calls. Rule-shaped changes are facts of the tree (refusal ids,
// commands, adapter keys, event types, words in the texts agents read: role, skill, session-rules and risk guidance
// templates; hook code is not counted); a net increase over budget.json fails unless a kept or active plugin proposal
// accounts for it.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkRelease, classifyRuleShapes, textWords } from '../engine/learn.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BUDGET = JSON.parse(fs.readFileSync(path.join(REPO, 'budget.json'), 'utf8'));
const words = (n) => Array.from({ length: n }, (_, i) => `w${i}`).join(' ');

// A plugin tree with the real contract, an adapter key list, one role text and one hook.
function tree(t, { contract = (s) => s, roleWords = 100, keys = BUDGET.adapterKeys } = {}) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wf08-release-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'engine'));
  fs.writeFileSync(path.join(dir, 'engine', 'contract.mjs'), contract(fs.readFileSync(path.join(REPO, 'engine', 'contract.mjs'), 'utf8')));
  if (keys) fs.writeFileSync(path.join(dir, 'engine', 'config.mjs'), `export const ADAPTER_KEYS = ${JSON.stringify(keys)};\n`);
  fs.mkdirSync(path.join(dir, 'templates', 'agents'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'templates', 'agents', 'reviewer.md'), words(roleWords));
  fs.mkdirSync(path.join(dir, 'hooks'));
  fs.writeFileSync(path.join(dir, 'hooks', 'session-rules.mjs'), '// a comment with many words that are not counted\nconsole.log("read the rules first");\n');
  return dir;
}
const budget = { ...BUDGET, words: { ...BUDGET.words, total: 101 } };
const addRefusal = (s) => s.replace("'answer:not-person': {", "'merge:extra': { stream: 1, when: 'x' },\n  'answer:not-person': {");

test('the tree at the budget passes; counts are by name and words by total', async (t) => {
  const r = await checkRelease({ pluginRoot: tree(t), budget });
  assert.deepEqual(r.problems, []);
  assert.equal(r.ok, true);
  assert.equal(r.counts.refusals.length, 18);
  assert.equal(r.counts.words.total, 100); // the hook's code and its string literals are not counted
  assert.equal(r.classification.ruleShaped, false);
});

test('an added refusal fails the release unless a kept or active plugin proposal accounts for it', async (t) => {
  const root = tree(t, { contract: addRefusal });
  const r = await checkRelease({ pluginRoot: root, budget });
  assert.equal(r.ok, false);
  assert.match(r.problems[0], /refusals: 1 more than budget\.json \(merge:extra added\)/);
  const reverted = [{ scope: 'plugin', status: 'reverted', adds: { refusals: ['merge:extra'] } }];
  assert.equal((await checkRelease({ pluginRoot: root, budget, proposals: reverted })).ok, false);
  const active = [{ scope: 'plugin', status: 'active', adds: { refusals: ['merge:extra'] } }];
  assert.equal((await checkRelease({ pluginRoot: root, budget, proposals: active })).ok, true);
});

test('a replacement is rule-shaped but no net increase; words and role length are counted', async (t) => {
  const swapped = tree(t, { contract: (s) => addRefusal(s).replace("  'criteria:max': { stream: 1, when: 'more than 6 criteria' },\n", '') });
  const r = await checkRelease({ pluginRoot: swapped, budget });
  assert.equal(r.ok, true, r.problems.join('\n'));
  assert.equal(r.classification.ruleShaped, true);
  assert.deepEqual(r.classification.refusals, { added: ['merge:extra'], removed: ['criteria:max'], net: 0 });
  const long = await checkRelease({ pluginRoot: tree(t, { roleWords: 160 }), budget });
  assert.equal(long.ok, false);
  assert.ok(long.problems.some((p) => /words: 160 against 101/.test(p)));
  assert.ok(long.problems.some((p) => /reviewer\.md: 160 words, over the 150-word role limit/.test(p)));
  const covered = await checkRelease({ pluginRoot: tree(t, { roleWords: 140 }), budget, proposals: [{ scope: 'plugin', status: 'kept', adds: { words: 40 } }] });
  assert.equal(covered.ok, true, covered.problems.join('\n'));
});

test('a kind the tree does not list fails rather than passing unchecked', async (t) => {
  const r = await checkRelease({ pluginRoot: tree(t, { keys: null }), budget });
  assert.equal(r.ok, false);
  assert.match(r.problems.join('\n'), /adapterKeys: not counted/);
  assert.equal((await checkRelease({ pluginRoot: tree(t, { keys: null }), budget, adapterKeys: BUDGET.adapterKeys })).ok, true);
});

test('bug fixes are classified by the same facts', () => {
  const before = { refusals: ['a'], commands: ['c'], events: ['e'], adapterKeys: ['k'], words: 10 };
  assert.equal(classifyRuleShapes(before, { ...before }).ruleShaped, false);
  assert.equal(classifyRuleShapes(before, { ...before, refusals: ['a', 'b'] }).ruleShaped, true);
  assert.equal(classifyRuleShapes(before, { ...before, words: 11 }).ruleShaped, true);
  assert.equal(textWords('hooks/x.mjs', '// not counted\nconst a = `one ${b} two`; const c = "three";'), 3);
  assert.equal(textWords('skills/x/SKILL.md', 'four words in prose'), 4);
});
