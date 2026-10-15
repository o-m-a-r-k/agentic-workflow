import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { closureFile, commitIn, criteriaFile, goodClosure, ok, sh, singleRepoProject, state, tmp, wf, WF } from './helpers.mjs';
import { classifierFor, lessonStats } from '../engine/learning.mjs';
import codex from '../engine/hosts/codex.mjs';

// 0.7.9, D19, named failure (field): one project had 70 lessons, all `proposed`, 16 recurred and none ever curated: the
// counting waited for a reviewer to volunteer a verdict, and merging, promoting and retiring waited for a person. Learning
// is now automatic and only changes what roles read and in which order.

const steps = [{ id: 'unit', repo: 'app', run: 'true', inputs: ['src/**'] }];
const add = (root, args) => ok(wf(root, ['lesson', 'add', ...args]));

// A fake `claude` on PATH: a classification turn (`--print --output-format json`) records its arguments and prompt and
// labels each item by the first rule whose text it contains (never the item's own lesson); FAKE_FAIL makes it fail.
function fakeClaude(base) {
  const bin = tmp('learning-bin');
  const probe = path.join(base, 'classify-probe.jsonl');
  fs.writeFileSync(path.join(bin, 'claude'), [
    '#!/usr/bin/env node',
    "import fs from 'node:fs';",
    'const prompt = fs.readFileSync(0, "utf8");',
    'const args = process.argv.slice(2);',
    `fs.appendFileSync(${JSON.stringify(probe)}, JSON.stringify({ args, prompt }) + "\\n");`,
    'if (process.env.FAKE_FAIL) { process.stderr.write("model unavailable"); process.exit(1); }',
    'const rules = JSON.parse(process.env.CLASSIFY_RULES ?? "[]");',
    'const labels = {};',
    'for (const line of prompt.split("\\n")) {',
    '  const m = /^- ([FN]\\d+): (.*)$/.exec(line);',
    '  if (!m) continue;',
    '  const own = /^the lesson (\\S+):/.exec(m[2])?.[1];',
    '  const rule = rules.find((r) => m[2].includes(r.match) && r.label !== own);',
    '  labels[m[1]] = rule ? rule.label : "none";',
    '}',
    'console.log(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "```json\\n" + JSON.stringify(labels) + "\\n```", total_cost_usd: 0.0004, modelUsage: { "claude-haiku-fixture": {} } }));',
  ].join('\n'), { mode: 0o755 });
  return { bin, probe, calls: () => (fs.existsSync(probe) ? fs.readFileSync(probe, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []) };
}

// An attempt whose first review raised one finding, fixed before the evidence review; stops before acceptance.
function reviewed(root, base, item, finding, { afterFirstReview = null } = {}) {
  const e = ok(wf(root, ['entry', '--item', item, '--owner', 'o', '--json'])).json();
  ok(wf(root, ['handoff', 'planner', '--agent', 'p', '--attempt', e.id]));
  ok(wf(root, ['plan', '--file', criteriaFile(base), '--attempt', e.id]));
  ok(wf(root, ['handoff', 'implementer', '--agent', 'i', '--attempt', e.id]));
  commitIn(e.repos.app.worktree, { 'src/a.txt': `${item}\n` });
  ok(wf(root, ['handoff', 'reviewer', '--agent', 'rev-0', '--attempt', e.id]));
  ok(wf(root, ['review', '--closure', closureFile(base, goodClosure('rev-0', { findings: finding ? [{ id: 'F1', severity: 'low', summary: finding, status: 'fixed', evidence: 'src/a.txt:1', category: 'design-system' }] : [] })), '--attempt', e.id]));
  afterFirstReview?.(e);
  ok(wf(root, ['gate', '--attempt', e.id]));
  ok(wf(root, ['handoff', 'reviewer', '--agent', 'rev-1', '--attempt', e.id]));
  ok(wf(root, ['review', '--closure', closureFile(base, goodClosure()), '--attempt', e.id]));
  return e;
}

function project(name, config = {}) {
  const p = singleRepoProject(name, { gate: { steps }, ...config });
  add(p.root, ['--title', 'Tables show the shared skeleton row while loading', '--what', 'a table rendered empty while its rows loaded', '--cause', 'design-system', '--mechanism', 'reviewer-checklist', '--tags', 'tables', '--paths', 'src/**']);
  add(p.root, ['--title', 'Invoice totals round once', '--what', 'a total was rounded per line and again in sum', '--cause', 'test', '--mechanism', 'reviewer-checklist', '--tags', 'invoices', '--paths', 'src/**']);
  add(p.root, ['--title', 'List loading states use the shared row skeleton', '--what', 'a list showed a spinner instead of rows', '--cause', 'design-system', '--mechanism', 'reviewer-checklist', '--tags', 'lists', '--paths', 'src/**']);
  sh(p.root, 'git add -A && git commit -q -m lessons && git push -q origin main');
  return p;
}

test('at acceptance the classifier labels what the attempt taught: a finding that repeats a lesson is its recurrence, lessons that describe one mistake become a merge, and lessons rank by it', () => {
  const { base, root } = project('learning-accept');
  const fake = fakeClaude(base);
  // The classifier is right about L-3 and wrong about L-2 (the owner says so with `wf lesson distinct`).
  const env = { WF_LEARNING: 'on', PATH: fake.bin + path.delimiter + process.env.PATH, CLASSIFY_RULES: JSON.stringify([{ match: 'no loading row', label: 'L-1' }, { match: 'List loading states', label: 'L-1' }, { match: 'Invoice totals', label: 'L-1' }]) };
  const e = reviewed(root, base, 'ENG-1', 'the orders table shows no loading row while it loads');
  const accepted = ok(wf(root, ['accept', '--attempt', e.id], { env }));
  assert.match(accepted.out, /learned: rev-0:F1 repeats L-1 \(counted as recurrences; lessons rank by them\)/);

  // One tool-less turn of the cheap model, with every lesson as a choice and every finding and uncompared lesson as an item.
  const [call] = fake.calls();
  assert.deepEqual(call.args.slice(call.args.indexOf('--model'), call.args.indexOf('--model') + 4), ['--model', 'haiku', '--effort', 'low']);
  assert.equal(call.args[call.args.indexOf('--tools') + 1], '', 'no tools');
  assert.ok(call.args.includes('--no-session-persistence'));
  assert.match(call.prompt, /classification: no reasoning, no tools/);
  assert.match(call.prompt, /^- L-2: Invoice totals round once/m);
  assert.match(call.prompt, /^- F1: a review finding: the orders table shows no loading row while it loads; category design-system$/m);
  assert.equal([...call.prompt.matchAll(/^- N\d+: the lesson L-\d+:/gm)].length, 3, 'the project\'s existing lessons are compared once');

  const s = state(root, e.id);
  assert.equal(s.learning.at(-1).model, 'claude-haiku-fixture');
  assert.deepEqual(s.learning.at(-1).findings, { 'rev-0:F1': 'L-1' });
  assert.deepEqual(s.learning.at(-1).lessons, { 'L-1': 'none', 'L-2': 'L-1', 'L-3': 'L-1' });
  assert.match(s.lessons.recurred.at(-1).why, /^classifier \(claude-haiku-fixture\): review finding rev-0:F1 repeats it$/);
  const listed = ok(wf(root, ['lesson', 'list'])).out;
  assert.match(listed, /^L-1 .*recurrence 1 \(last \d{4}-\d{2}-\d{2}\)/m);
  assert.match(listed, /^L-3 .*recurrence 0 /m, 'an older lesson describing the same mistake is a merge to make, not a new occurrence');
  // I-130: nothing written into the main checkout; the learned record is git-excluded project state.
  assert.equal(sh(root, 'git status --porcelain'), '');
  assert.ok(fs.existsSync(path.join(root, '.workflow-maintenance', 'learned.jsonl')));

  // The merge is proposed where it can be made: an open attempt holding the lessons' repo, before its acceptance stands.
  assert.match(ok(wf(root, ['status', '--attempt', e.id])).out, /lessons describing one mistake \(classifier\): L-1 \+ L-2 \+ L-3: merge them in an open attempt that holds their repos, before its review is accepted/);
  const merge = ['lesson', 'merge', 'L-1', 'L-3', '--title', 'Tables and lists show the shared skeleton row while loading', '--attempt'];
  const late = wf(root, [...merge, e.id]);
  assert.equal(late.code, 75);
  assert.match(late.err, /lessons not merged: lesson L-\d+ would be written into app's main checkout \(accepted\), outside ENG-1\.1's review/);
  assert.match(ok(wf(root, ['lesson', 'distinct', 'L-1', 'L-2'])).out, /lessons L-1, L-2 are different mistakes: no merge of them is proposed again/);
  const next = ok(wf(root, ['entry', '--item', 'ENG-2', '--owner', 'o', '--json'])).json();
  assert.match(ok(wf(root, ['status', '--attempt', next.id])).out, /lessons describing one mistake \(classifier\): L-1 \+ L-3: merge each into one lesson in this attempt/);
  // The next planner sees the lesson whose mistake repeated first.
  const planner = ok(wf(root, ['handoff', 'planner', '--agent', 'p', '--attempt', next.id])).out;
  assert.match(planner, /^lessons injected: L-1, /m);
  assert.match(ok(wf(root, [...merge, next.id])).out, /lessons L-1, L-3 merged into L-4 \(recurrence 1\)/);
  const wt = next.repos.app.worktree;
  const merged = fs.readFileSync(path.join(wt, '.workflow', 'lessons', 'L-4.yaml'), 'utf8');
  assert.match(merged, /^merged:\n {2}- L-1\n {2}- L-3$/m);
  assert.match(merged, /^tags:\n {2}- tables\n {2}- lists$/m);
  assert.match(merged, /what: a table rendered empty while its rows loaded; a list showed a spinner instead of rows/, 'what happened, in the members\' words');
  // The merged lesson inherits its members' ranking evidence.
  const stats = lessonStats(root);
  assert.equal(stats.get('L-4@app').lastRepeatAt, stats.get('L-1@app').lastRepeatAt);
  assert.match(fs.readFileSync(path.join(wt, '.workflow', 'lessons', 'L-3.yaml'), 'utf8'), /^status: retired$[\s\S]*^mergedInto: L-4$/m);
  assert.equal(sh(wt, 'git status --porcelain'), '', 'committed in the attempt');
  assert.doesNotMatch(ok(wf(root, ['status', '--attempt', next.id])).out, /lessons describing one mistake/);
  // Another open attempt is not asked to merge them again.
  const other = ok(wf(root, ['entry', '--item', 'ENG-7', '--owner', 'o', '--json'])).json();
  assert.doesNotMatch(ok(wf(root, ['status', '--attempt', other.id])).out, /lessons describing one mistake/);
});

// Independent review of 0.7.9: the owner records a lesson from a finding, and at acceptance the classifier matched that
// finding to the new lesson, so the lesson was born recurring, ranked first and was soon proposed for promotion.
test('a lesson recorded from a finding is that finding\'s lesson, not its repeat', () => {
  const { base, root } = project('learning-origin');
  const fake = fakeClaude(base);
  const env = { WF_LEARNING: 'on', PATH: fake.bin + path.delimiter + process.env.PATH, CLASSIFY_RULES: JSON.stringify([{ match: 'unrounded subtotal', label: 'L-4' }]) };
  const e = reviewed(root, base, 'ENG-8', 'an unrounded subtotal reaches the invoice footer', {
    // Recorded during the review rounds (committed in the attempt), so the next round reviews it.
    afterFirstReview: (x) => {
      add(root, ['--attempt', x.id, '--finding', 'F1', '--title', 'Footers show rounded subtotals', '--what', 'an unrounded subtotal reached a footer', '--cause', 'test', '--mechanism', 'reviewer-checklist', '--tags', 'footers', '--paths', 'src/**']);
      ok(wf(root, ['handoff', 'reviewer', '--agent', 'rev-0b', '--attempt', x.id]));
      ok(wf(root, ['review', '--closure', closureFile(base, goodClosure('rev-0b')), '--attempt', x.id]));
    },
  });
  ok(wf(root, ['accept', '--attempt', e.id], { env }));
  const s = state(root, e.id);
  assert.deepEqual(s.learning.at(-1).findings, { 'rev-0:F1': 'L-4' }, 'the label is kept');
  assert.deepEqual(s.lessons.recurred, [], 'and counts as no recurrence');
  assert.doesNotMatch(ok(wf(root, ['status', '--attempt', e.id])).out, /LESSON L-4 RECURRED/);
});

test('learning is a configurable agent: the adapter pins the classifier per runtime or turns it off, and a failed classifier never fails an acceptance', () => {
  const on = {};
  assert.deepEqual([classifierFor({}, 'claude', on).model, classifierFor({}, 'claude', on).effort], ['haiku', 'low']);
  assert.deepEqual([classifierFor({}, 'codex', on).model, classifierFor({}, 'codex', on).effort], ['gpt-6-luna', 'low']);
  assert.equal(classifierFor({ learning: { classifier: { codex: { model: 'cheap-model' } } } }, 'codex', on).model, 'cheap-model');
  assert.equal(classifierFor({ learning: { enabled: false } }, 'claude', on), null);
  assert.equal(classifierFor({}, 'claude', { WF_LEARNING: 'off' }), null, 'this machine can turn it off');
  const call = codex.classifyLaunch({ prompt: 'p', model: 'gpt-6-luna', effort: 'low', dir: '/tmp/x' });
  assert.deepEqual(call.args.slice(0, 5), ['exec', '--skip-git-repo-check', '--ephemeral', '--sandbox', 'read-only']);
  assert.ok(call.args.includes('gpt-6-luna') && call.outFile === path.join('/tmp/x', 'answer.txt'));

  const bad = singleRepoProject('learning-bad', { gate: { steps }, learning: { classifier: { other: { model: 'x' } }, extra: true } });
  const r = wf(bad.root, ['lesson', 'list']);
  assert.notEqual(r.code, 0);
  assert.match(r.err, /`learning.extra`: learning takes `enabled` and `classifier`/);
  assert.match(r.err, /`learning.classifier.other`: the runtimes are claude, codex/);

  const pinned = project('learning-pinned', { learning: { classifier: { claude: { model: 'house-cheap-model', effort: 'minimal' } } } });
  const fake = fakeClaude(pinned.base);
  const env = { WF_LEARNING: 'on', PATH: fake.bin + path.delimiter + process.env.PATH, FAKE_FAIL: '1' };
  const e = reviewed(pinned.root, pinned.base, 'ENG-3', 'a finding');
  ok(wf(pinned.root, ['accept', '--attempt', e.id], { env }));
  const [call2] = fake.calls();
  assert.deepEqual(call2.args.slice(call2.args.indexOf('--model'), call2.args.indexOf('--model') + 4), ['--model', 'house-cheap-model', '--effort', 'minimal']);
  assert.equal(state(pinned.root, e.id).phase, 'accepted');
  assert.match(ok(wf(pinned.root, ['status', '--attempt', e.id])).out, /learning: the classifier \(house-cheap-model\) gave no labels at acceptance \(claude exited 1: model unavailable\); lesson ranking is unchanged/);

  const off = project('learning-off', { learning: { enabled: false } });
  const fakeOff = fakeClaude(off.base);
  const e2 = reviewed(off.root, off.base, 'ENG-4', 'a finding');
  ok(wf(off.root, ['accept', '--attempt', e2.id], { env: { WF_LEARNING: 'on', PATH: fakeOff.bin + path.delimiter + process.env.PATH } }));
  assert.deepEqual(fakeOff.calls(), [], 'no model call');
});

test('a delivered attempt\'s prediction and what happened reach the next planner and the strategist, per lane (never the implementer or the reviewer)', () => {
  const { base, root } = singleRepoProject('learning-course', { gate: { steps } });
  const e = reviewed(root, base, 'ENG-5', null);
  ok(wf(root, ['accept', '--attempt', e.id]));
  ok(wf(root, ['deliver', '--attempt', e.id]));
  const next = ok(wf(root, ['entry', '--item', 'ENG-6', '--owner', 'o', '--json'])).json();
  const bundleOf = (out) => JSON.parse(fs.readFileSync(/^Read (\S+) and follow/m.exec(out)?.[1] ?? /bundle: (\S+)/.exec(out)[1], 'utf8'));
  const pb = bundleOf(ok(wf(root, ['handoff', 'planner', '--agent', 'p', '--attempt', next.id])).out);
  const lane = state(root, e.id).lane;
  assert.equal(pb.pastEstimates[lane].attempts, 1);
  assert.equal(pb.pastEstimates[lane].rounds.attempts, 1);
  assert.equal(typeof pb.pastEstimates[lane].rounds.medianActualOverPredicted, 'number');
  ok(wf(root, ['plan', '--file', criteriaFile(base), '--attempt', next.id]));
  const ib = bundleOf(ok(wf(root, ['handoff', 'implementer', '--agent', 'i', '--attempt', next.id])).out);
  assert.equal(ib.pastEstimates, undefined, 'a prediction is never an implementer\'s target (D9)');
});

// I-131: a command a scenario spawns with a copy of process.env writes its refusals into this test process's own folder,
// never into the person's refusal log.
test('scenario processes keep their user-level state to themselves', () => {
  const own = path.join(path.dirname(process.env.WF_IMPROVEMENTS_DIR), 'refusals.jsonl');
  assert.ok(process.env.WF_IMPROVEMENTS_DIR.startsWith(fs.realpathSync(path.dirname(path.dirname(process.env.WF_IMPROVEMENTS_DIR)))));
  const { root } = singleRepoProject('learning-isolated', { gate: { steps } });
  const r = spawnSync(process.execPath, [WF, 'lesson', 'recur', 'L-404'], { cwd: root, env: { ...process.env }, encoding: 'utf8' });
  assert.equal(r.status, 75, r.stderr);
  assert.ok(fs.existsSync(own) && fs.readFileSync(own, 'utf8').includes('no lesson L-404'), 'the refusal is in this process\'s own log');
  assert.ok(!process.env.WF_IMPROVEMENTS_DIR.startsWith(path.join(process.env.HOME ?? '/nonexistent', '.agentic-workflow')));
});
