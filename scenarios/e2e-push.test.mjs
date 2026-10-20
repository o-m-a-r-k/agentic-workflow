// End to end, the real `wf` with no doubles: a push-to-main project with no CI and the built-in files tracker. One ticket
// goes through start, criteria, `wf test fast` and a review, a fix round and a second review, landing on the base, the
// tracker stages, close, and the telemetry row.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { git, makeProject, writeFiles } from './helpers/index.mjs';
import { events, fakeReviewerHost, reviewFiles, waitFor, wf } from './e2e-support.mjs';

const REPOS = [{
  name: 'app', base: 'trunk', files: {
    'src/sum.mjs': 'export const sum = (xs) => xs.reduce((a, b) => a + b, 0);\n',
    'test/run.mjs': 'import { sum } from "../src/sum.mjs";\nif (sum([]) !== 0 || sum([2, 3]) !== 5) { console.error("sum is wrong"); process.exit(1); }\n',
    'README.md': '# app\n',
  },
}];

function project() {
  const p = makeProject({
    name: 'pushy',
    repos: REPOS,
    overrides: {
      repos: [{
        name: 'app', path: 'app', base: 'trunk',
        tests: { fast: { run: 'node test/run.mjs' }, full: { run: 'node test/run.mjs', lock: { name: 'e2e-push-full', count: 1 } } },
        kinds: { tests: ['test/**'], other: ['**/*.md'] },
      }],
      ticketing: { tracker: 'files', via: 'files', idPattern: '^TK-\\d+$', take: { status: 'Started' }, followUps: { mode: 'file', status: 'Backlog', label: 'found-in-review' } },
      delivery: { landing: 'direct', stages: [{ do: 'land' }, { do: 'status', to: 'Ready', comment: 'uat' }] },
    },
  });
  writeFiles(p.root, {
    'tickets/TK-1.md': '---\nid: TK-1\ntitle: Average of a list\nstatus: Todo\nlabels: []\n---\nAdd an average next to the sum.\n',
  });
  return p;
}

const ticket = (p, id) => fs.readFileSync(path.join(p.root, 'tickets', `${id}.md`), 'utf8');

test('push to main: start, criteria, fast tests and a review, a fix round, landing, tracker stages, close and the row', async () => {
  const p = project();
  const host = fakeReviewerHost(p);
  try {
    // 1. Start: a fresh worktree from the fetched base, and the tracker's "taken" status.
    const started = wf(p, ['start', 'tk-1']);
    assert.match(started.out, /started TK-1\.1 from fresh bases/);
    assert.match(ticket(p, 'TK-1'), /status: Started/);
    const wt = path.join(p.root, '.wf-worktrees', 'TK-1.1', 'app');
    assert.equal(git(wt, ['rev-parse', 'HEAD']), git(p.repos.app.dir, ['rev-parse', 'origin/trunk']));

    // 2. Criteria.
    fs.writeFileSync(path.join(p.tmp, 'criteria.json'), JSON.stringify({ criteria: ['the average of [2, 4] is 3', 'the average of an empty list is 0'], areas: ['app/src'] }));
    assert.match(wf(p, ['criteria', '--file', path.join(p.tmp, 'criteria.json')]).out, /criteria set on TK-1\.1/);
    assert.match(wf(p, ['status']).out, /next: wf handoff implementer/);

    // 3. The implementer: a change with a defect (the empty list divides by zero), committed, and fast tests run.
    wf(p, ['handoff', 'implementer', '--session', 'claude:impl-1']);
    p.commit('app', { 'src/avg.mjs': 'import { sum } from "./sum.mjs";\nexport const avg = (xs) => sum(xs) / xs.length;\n', 'test/avg.mjs': 'import { avg } from "../src/avg.mjs";\nif (avg([2, 4]) !== 3) process.exit(1);\n' }, 'average', { cwd: wt });
    assert.match(wf(p, ['test', 'fast'], { cwd: wt }).out, /app: fast passed/);

    // 4. The first review: launched by wf with the bundle as its whole prompt; it finds a goal blocker.
    host.plan({ 1: { findings: [{ location: 'app/src/avg.mjs:2', class: 'goal', severity: 'medium', what: 'the average of an empty list is NaN, not 0 (C2)', why: 'C2 fails' }] } });
    const r1 = wf(p, ['review']);
    assert.match(r1.out, /reviewer whole: launched claude:/);
    const [file1] = reviewFiles(r1.out);
    await waitFor(file1);
    const rec1 = wf(p, ['review', '--record', file1]);
    assert.match(rec1.out, /review 1 recorded on TK-1\.1 \(seat whole, coverage complete\): 1 finding\(s\), 1 open blocker\(s\)/);
    assert.match(wf(p, ['status']).out, /next: wf handoff implementer[\s\S]*fix round for open blocker\(s\) F1/);
    // Delivery is refused while the blocker is open.
    assert.match(wf(p, ['deliver'], { code: 75 }).err, /refused \(merge:open\)/);

    // 5. The fix round, then the next review verifies the blocker and re-reads the whole change.
    wf(p, ['handoff', 'implementer', '--session', 'claude:impl-1']);
    p.commit('app', { 'src/avg.mjs': 'import { sum } from "./sum.mjs";\nexport const avg = (xs) => (xs.length ? sum(xs) / xs.length : 0);\n' }, 'empty list averages to 0', { cwd: wt });
    wf(p, ['test', 'fast'], { cwd: wt });
    host.plan({ 2: { findings: [], verified: [{ id: 'F1', status: 'fixed' }] } });
    const r2 = wf(p, ['review']);
    const [file2] = reviewFiles(r2.out);
    assert.notEqual(file2, file1);
    const prompt2 = fs.readFileSync(path.join(path.dirname(file2), 'prompt-whole.md'), 'utf8');
    assert.match(prompt2, /review round 2/);
    assert.match(prompt2, /Verify these open findings first[\s\S]*F1 goal medium app\/src\/avg\.mjs:2/);
    await waitFor(file2);
    assert.match(wf(p, ['review', '--record', file2]).out, /review 2 recorded .*0 open blocker\(s\)/);

    // 6. Delivery: the land stage lands the attempt alone (landing: direct), running full on the landed tree first.
    let st = wf(p, ['status']).out;
    assert.match(st, /next: wf deliver --attempt TK-1\.1/);
    const d1 = wf(p, ['deliver']);
    assert.match(d1.out, /0 land: done/);
    assert.match(d1.out, /1 status: pending — write the uat comment for TK-1/);
    git(p.repos.app.dir, ['fetch', '--quiet', 'origin']);
    assert.match(git(p.repos.app.dir, ['log', '-1', '--format=%B', 'origin/trunk']), /^TK-1: average[\s\S]*Wf-Attempt: TK-1\.1/);
    assert.equal(git(p.repos.app.dir, ['show', 'origin/trunk:src/avg.mjs']), 'import { sum } from "./sum.mjs";\nexport const avg = (xs) => (xs.length ? sum(xs) / xs.length : 0);');
    assert.ok(events(p, 'TK-1.1', 'test.run').some((e) => e.data.kind === 'full' && e.data.source === 'landing' && e.data.pass));
    // The owner writes the comment in product words; the stage posts it once and sets the status.
    const comment = /to (\S+comments\/uat\.md)/.exec(d1.out)[1];
    fs.writeFileSync(comment, 'Try the average of a few numbers and of an empty list.\n');
    const d2 = wf(p, ['deliver']);
    assert.match(d2.out, /delivered: every stage is done; wf close/);
    assert.match(ticket(p, 'TK-1'), /status: Ready/);
    assert.match(ticket(p, 'TK-1'), /Try the average[\s\S]*wf:TK-1\.1:stage-1:comment/);
    wf(p, ['deliver']); // idempotent: nothing is written twice
    assert.equal(ticket(p, 'TK-1').match(/wf:TK-1\.1:stage-1:comment/g).length, 1);

    // 7. Close: shipped, the worktree removed, the branch kept, and one telemetry row.
    st = wf(p, ['status']).out;
    assert.match(st, /next: wf close --attempt TK-1\.1/);
    const closed = wf(p, ['close']);
    assert.match(closed.out, /TK-1\.1 closed \(shipped\): delivery stages done/);
    assert.equal(fs.existsSync(wt), false);
    assert.ok(git(p.repos.app.dir, ['rev-parse', '--verify', 'wf/TK-1.1']));
    const rows = fs.readFileSync(path.join(p.env.WF_USER_DIR, 'telemetry', 'pushy.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    assert.equal(rows.length, 1);
    const row = rows[0];
    assert.equal(row.schema, 'wf-ticket@1');
    assert.equal(row.attempt, 'TK-1.1');
    assert.equal(row.outcome, 'shipped');
    assert.equal(row.reviews, 2);
    assert.equal(row.blockingReviews, 1);
    assert.equal(row.fixRounds, 1);
    assert.equal(row.coverage, 'complete');
    assert.equal(row.findings.goal, 1);
    assert.ok(row.testRuns.fast >= 2 && row.testRuns.full >= 1, JSON.stringify(row.testRuns));
    assert.ok(row.diff.product > 0 && row.diff.tests > 0, JSON.stringify(row.diff));
    assert.match(wf(p, ['status']).out, /no open attempts/);
    // `wf report` rebuilds the rows from the ledgers and agrees.
    const rep = wf(p, ['report', '--json']).json();
    assert.equal(rep.rows, 1);
  } finally {
    p.cleanup();
  }
});
