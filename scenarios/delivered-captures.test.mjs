import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { closureFile, commitIn, criteriaFile, goodClosure, ok, OUT_OF_ORDER, singleRepoProject, state, toAccepted, wf } from './helpers.mjs';
import { reduce } from '../engine/ledger.mjs';

// 0.7.26 (I-182). Named failure (field): a batch's gate recorded 510 verified screenshots; each member's handoff held 40
// of them, all from two steps whose globs had no placeholder (every unit's), none of the ticket's own. There was no cap:
// a project step plugin tagged the captures it returned with the item ids it knows (`units: ["ENG-81"]`), `deliveredSet`
// read the attempt id only, so 470 captures, the ticket's own 30 among them, were in no member's set; narrowing could only
// keep some of the 40, and a verified capture could not be chosen while the handoff was pending. The set now reads an item
// as well as an attempt id, takes a capture the ticket's own criteria cite whatever its tag, puts the ticket's own first
// and lists every set member (no cap); `wf delivery list` shows every verified capture, and `wf delivery narrow --keep`
// may name any of them.

const ignore = { '.gitignore': '.wf-evidence/\n.wf-worktrees/\nshots/\n' };
// A step plugin returning captures tagged with the items they belong to, as a project that knows its tickets does.
const plugin = (groups) => `import fs from 'node:fs';import path from 'node:path';
export default { async run(ctx) {
  const artifacts = [];
  for (const [item, count] of ${JSON.stringify(groups)}) {
    for (let i = 0; i < count; i++) {
      const png = path.join(ctx.evidenceDir, 'shots', item + '-' + String(i).padStart(2, '0') + '.png');
      fs.mkdirSync(path.dirname(png), { recursive: true });
      fs.writeFileSync(png, item + ':' + i);
      artifacts.push({ path: png, kind: 'screenshot', units: [item] });
    }
  }
  return { status: 'passed', suites: [{ id: 'browser', status: 'passed' }], artifacts };
} };`;
const shownFile = (dir, entries) => {
  const f = path.join(dir, `shown-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(f, JSON.stringify({ screenshots: entries, anomalies: 'none seen' }));
  return f;
};
const sourceOf = (f) => path.basename(f.source ?? f.path);

test('I-182: a batch member\'s handoff holds the captures tagged for its item first, every one of them, and the rest of the gate\'s verified captures are listed and may be chosen', () => {
  // 45 captures for the first member's item (more than the 40 the field showed), 12 for the second's, 12 for an upstream
  // ticket the batch inherits, and 3 from a step whose glob has no placeholder (every unit's).
  const steps = [
    { id: 'unit', repo: 'app', run: 'true', inputs: ['src/**'] },
    { id: 'browser', repo: 'app', tier: 'heavy', plugin: 'steps/browser.mjs', inputs: ['src/**'] },
    { id: 'shared', repo: 'app', tier: 'heavy', run: 'mkdir -p shots/shared && for n in a b c; do printf $n > shots/shared/shared-$n.png; done', artifacts: ['shots/shared/*.png'] },
  ];
  const { base, root } = singleRepoProject('captures-batch', { gate: { steps } }, { ...ignore, 'src/b.txt': 'b\n', '.workflow/steps/browser.mjs': plugin([['ENG-81', 45], ['ENG-82', 12], ['ENG-90', 12]]) });
  const m1 = toAccepted(root, base, { item: 'ENG-81', change: { 'src/a.txt': 'one\n' }, extraEntry: ['--defer-heavy'] });
  const m2 = toAccepted(root, base, { item: 'ENG-82', change: { 'src/b.txt': 'two\n' }, extraEntry: ['--defer-heavy'] });
  const b = ok(wf(root, ['batch', 'create', '--members', `${m1.id},${m2.id}`, '--owner', 'o', '--json'])).json();
  const g = ok(wf(root, ['gate', ...OUT_OF_ORDER, '--attempt', b.id, '--json'])).json();
  const all = g.steps.flatMap((x) => x.artifacts ?? []).filter((a) => a.kind === 'screenshot').map((a) => a.sha256);
  assert.equal(all.length, 45 + 12 + 12 + 3, 'the batch gate verified every capture');
  ok(wf(root, ['handoff', 'reviewer', '--agent', 'rb', '--attempt', b.id]));
  ok(wf(root, ['review', '--closure', closureFile(base, { reviewer: 'rb', findings: [], criteria: [{ id: 'B1', evidence: { kind: 'output', ref: 'batch gate' } }], screenshotsInspected: all, anomalies: 'none seen' }), '--attempt', b.id]));
  ok(wf(root, ['accept', '--attempt', b.id]));
  const d = ok(wf(root, ['deliver', '--attempt', b.id]));
  assert.match(d.out, /SHOW TO OWNER \(48 delivered screenshot\(s\) for ENG-81\)/, 'every capture of the ticket, past 40');
  assert.match(d.out, /SHOW TO OWNER \(15 delivered screenshot\(s\) for ENG-82\)/);

  const s1 = state(root, m1.id);
  const first = s1.delivery.screenshots.screenshots.map(sourceOf);
  assert.equal(first.length, 48);
  assert.ok(first.slice(0, 45).every((n) => /^ENG-81-\d\d\.png$/.test(n)), `the ticket's own captures come first: ${first.slice(0, 3)}`);
  assert.deepEqual(first.slice(45), ['shared-a.png', 'shared-b.png', 'shared-c.png'], 'then what every unit shares');
  assert.ok(!first.some((n) => /^ENG-8[2]|^ENG-90/.test(n)), 'another ticket\'s capture is not in this one\'s set by default');
  const second = state(root, m2.id).delivery.screenshots.screenshots.map(sourceOf);
  assert.equal(second.length, 15);
  assert.ok(second.slice(0, 12).every((n) => /^ENG-82-\d\d\.png$/.test(n)));
  // The set says there is more, where to see it and how to choose it.
  assert.match(d.out, /24 more verified capture\(s\) are tagged for other tickets only and are not in this set; `wf delivery list` shows them/);

  // Every verified capture is listed, the ticket's own first, each with where it stands.
  const list = ok(wf(root, ['delivery', 'list', '--attempt', m1.id, '--json'])).json();
  assert.equal(list.length, 72);
  assert.deepEqual(list.slice(0, 48).map((f) => f.rank), [...Array(45).fill(1), ...Array(3).fill(2)]);
  assert.deepEqual(new Set(list.slice(48).map((f) => f.rank)), new Set([3]));
  const text = ok(wf(root, ['delivery', 'list', '--attempt', m1.id])).out;
  assert.match(text, /72 verified capture\(s\) the handoff can draw from, the ticket's own first/);
  assert.match(text, /in the set {2}this ticket's own \(tagged for it, or collected by its own gate\)/);
  assert.match(text, /in the set {2}shared by every unit/);
  assert.match(text, /not in the set {2}tagged for other tickets only/);

  // The owner chooses from any of them while the handoff is pending: two of the ticket's own and one of the second ticket's.
  const own = s1.delivery.screenshots.screenshots.slice(0, 2).map((f) => f.sha256);
  const elsewhere = list.find((f) => /^ENG-82-00/.test(sourceOf(f)));
  assert.equal(elsewhere.rank, 3);
  assert.match(wf(root, ['delivery', 'narrow', '--keep', `${own[0]},${'e'.repeat(64)}`, '--reason', 'x', '--attempt', m1.id]).err, /1 kept sha256 not in the delivered set or the verified captures[\s\S]*e{64}/);
  const dry = ok(wf(root, ['delivery', 'narrow', '--keep', [...own, elsewhere.sha256].join(','), '--reason', 'the second ticket\'s capture shows the shared header', '--dry-run', '--attempt', m1.id]));
  assert.match(dry.out, /would be narrowed from 48 to 3 \(46 dropped, 1 chosen from the verified captures\)/);
  assert.equal(state(root, m1.id).delivery.narrowed, undefined, 'a dry run records nothing');
  const n = ok(wf(root, ['delivery', 'narrow', '--keep', [...own, elsewhere.sha256].join(','), '--reason', 'the second ticket\'s capture shows the shared header', '--attempt', m1.id]));
  assert.match(n.out, /narrowed from 48 to 3 \(1 chosen from the verified captures\)/);
  const s = state(root, m1.id);
  assert.deepEqual(s.delivery.screenshots.screenshots.map((f) => f.sha256), [...own, elsewhere.sha256], 'the set\'s own kept files, then the one chosen');
  assert.equal(s.delivery.narrowed.added.length, 1);
  assert.equal(s.delivery.narrowed.added[0].title, 'ENG-82-00.png');
  assert.equal(ok(wf(root, ['export', '--attempt', m1.id, '--json'])).json().delivered.narrowed.added, 1, 'the export says one was chosen from the verified captures');
  const draft = JSON.parse(fs.readFileSync(path.join(root, '.wf-worktrees', '_exports', m1.id, 'shown-draft.json'), 'utf8'));
  assert.equal(draft.screenshots.length, 3);
  // The chosen capture is acknowledged like any other.
  const entries = s.delivery.screenshots.screenshots.map((f, i) => ({ sha256: f.sha256, caption: `Capture ${i + 1} of the chat panel` }));
  ok(wf(root, ['shown', '--file', shownFile(base, entries), '--attempt', m1.id]));
  assert.equal(state(root, m1.id).delivery.shown.screenshots.length, 3);
  assert.match(wf(root, ['delivery', 'narrow', '--keep', own[0], '--reason', 'again', '--attempt', m1.id]).err, /is done; a delivered set can be narrowed only while the handoff is pending/);
});

test('I-182: a capture the ticket\'s own criterion cites is in its set whatever its tag, first; the other verified captures stay listed and may be chosen', () => {
  // The plugin tags by the item whose spec wrote the capture: ENG-80 is this ticket's, ENG-90 is an upstream ticket's that
  // this ticket's criterion cites as its proof, ENG-91 is unrelated.
  const steps = [{ id: 'unit', repo: 'app', run: 'true', inputs: ['src/**'] }, { id: 'browser', repo: 'app', plugin: 'steps/browser.mjs', inputs: ['src/**'] }];
  const { base, root } = singleRepoProject('captures-cited', { gate: { steps } }, { ...ignore, '.workflow/steps/browser.mjs': plugin([['ENG-80', 2], ['ENG-90', 2], ['ENG-91', 2]]) });
  const e = ok(wf(root, ['entry', '--item', 'ENG-80', '--owner', 'o', '--json'])).json();
  ok(wf(root, ['handoff', 'planner', '--agent', 'p', '--attempt', e.id]));
  ok(wf(root, ['plan', '--file', criteriaFile(base), '--attempt', e.id]));
  ok(wf(root, ['handoff', 'implementer', '--agent', 'i', '--attempt', e.id]));
  commitIn(e.repos.app.worktree, { 'src/a.txt': 'changed\n' });
  ok(wf(root, ['handoff', 'reviewer', '--agent', 'r0', '--attempt', e.id]));
  ok(wf(root, ['review', '--closure', closureFile(base, goodClosure('r0')), '--attempt', e.id]));
  const g = ok(wf(root, ['gate', '--attempt', e.id, '--json'])).json();
  const shots = g.steps.find((s) => s.id === 'browser').artifacts;
  assert.equal(shots.length, 6);
  const cited = shots.find((a) => a.source === 'shots/ENG-90-01.png');
  ok(wf(root, ['handoff', 'reviewer', '--agent', 'r1', '--attempt', e.id]));
  ok(wf(root, ['review', '--closure', closureFile(base, goodClosure('r1', { criteria: [{ id: 'C1', evidence: { kind: 'screenshot', ref: cited.sha256 } }], screenshotsInspected: shots.map((a) => a.sha256) })), '--attempt', e.id]));
  ok(wf(root, ['accept', '--attempt', e.id]));
  const d = ok(wf(root, ['deliver', '--attempt', e.id]));
  assert.match(d.out, /SHOW TO OWNER \(3 delivered screenshot\(s\) for ENG-80\)/);
  assert.deepEqual(state(root, e.id).delivery.screenshots.screenshots.map(sourceOf), ['ENG-90-01.png', 'ENG-80-00.png', 'ENG-80-01.png'], 'the cited capture first, then the ticket\'s tagged ones');
  const list = ok(wf(root, ['delivery', 'list', '--attempt', e.id, '--json'])).json();
  assert.deepEqual(list.map((f) => [sourceOf(f), f.rank]), [['ENG-90-01.png', 0], ['ENG-80-00.png', 1], ['ENG-80-01.png', 1], ['ENG-90-00.png', 3], ['ENG-91-00.png', 3], ['ENG-91-01.png', 3]]);
  // Choosing the unrelated ones is the owner's call, with a reason.
  const extra = list.filter((f) => /^ENG-91/.test(sourceOf(f))).map((f) => f.sha256);
  ok(wf(root, ['delivery', 'narrow', '--keep', [cited.sha256, ...extra].join(','), '--reason', 'the unrelated captures show the empty state the criterion compares with', '--attempt', e.id]));
  assert.deepEqual(state(root, e.id).delivery.screenshots.screenshots.map(sourceOf), ['ENG-90-01.png', 'ENG-91-00.png', 'ENG-91-01.png']);
});

test('I-182: a capture chosen from the verified ones reaches the set and the pending attach action in either order of the ledger\'s entries', () => {
  const file = (name) => ({ path: `/evidence/${name}`, sha256: name.padEnd(64, '0'), source: `shots/${name}`, title: name });
  const [a, b, c, chosen] = ['a.png', 'b.png', 'c.png', 'd.png'].map(file);
  const admitted = { type: 'admitted', at: '2026-01-01T00:00:00Z', actor: 'o', data: { id: 'ENG-9.1', item: 'ENG-9', lane: 'standard', intent: 'implementation', repos: {} } };
  const pending = { type: 'tracker.pending', at: '2026-01-01T00:01:00Z', actor: 'o', data: { event: 'delivered', actions: [{ op: 'attach', files: [a, b, c] }] } };
  const set = { type: 'delivery.screenshots', at: '2026-01-01T00:01:00Z', actor: null, data: { screenshots: [a, b, c] } };
  const narrowed = { type: 'delivery.narrowed', at: '2026-01-01T00:02:00Z', actor: 'o', data: { keep: [b.sha256, chosen.sha256], from: 3, to: 2, dropped: 2, added: [chosen], reason: 'chosen', legacy: false } };
  for (const entries of [[admitted, pending, set, narrowed], [admitted, set, narrowed, pending]]) {
    const s = reduce(entries);
    assert.deepEqual(s.delivery.screenshots.screenshots.map((f) => f.title), ['b.png', 'd.png']);
    assert.deepEqual(s.tracker.pending.find((x) => x.op === 'attach').files.map((f) => f.title), ['b.png', 'd.png']);
    assert.equal(s.delivery.narrowed.added.length, 1);
  }
  // An entry written before captures could be chosen (no `added`) folds as it did.
  const old = reduce([admitted, pending, set, { ...narrowed, data: { ...narrowed.data, keep: [b.sha256], added: undefined, to: 1, dropped: 2 } }]);
  assert.deepEqual(old.delivery.screenshots.screenshots.map((f) => f.title), ['b.png']);
  assert.deepEqual(old.tracker.pending.find((x) => x.op === 'attach').files.map((f) => f.title), ['b.png']);
});
