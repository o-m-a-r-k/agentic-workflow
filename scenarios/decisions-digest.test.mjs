// Stream 4: the daily digest gathers open questions, pending diff-reads, merges waiting on a click and the findings the
// project sends to the digest; a blocking question is asked at once as well; one digest per day.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { makeProject, withDoubles } from './helpers/index.mjs';
import { fileLedger, startAttempt } from './decisions-helpers.mjs';
import { ask, digest, commandHandler } from '../engine/contract.mjs';

test('digest: questions, diff-reads, merges and digest findings across open attempts; answered and closed ones drop out', async (t) => {
  const p = makeProject({ adapter: false });
  t.after(p.cleanup);
  const L = fileLedger();
  await withDoubles({ ...L, loadAdapter: async () => ({ name: 'sample' }) }, async () => {
    for (const a of ['TK-1.1', 'TK-2.1', 'TK-3.1']) await startAttempt(L, p.root, a);
    const w = await ask(p.root, 'TK-1.1', { kind: 'waiver', question: 'Waive F3?', options: ['waive', 'fix'], refs: ['F3'], blocking: true });
    await ask(p.root, 'TK-1.1', { kind: 'diff-read', question: 'Read the diff and approve it?', options: ['approve', 'changes'], refs: ['diff'], blocking: true });
    await ask(p.root, 'TK-2.1', { kind: 'priority-other', question: 'F9 is high and outside the goal: file it now?', options: ['file', 'later'], refs: ['F9'], blocking: false });
    await L.append(p.root, 'TK-2.1', 'review.recorded', { review: 1, round: 1, seat: 'whole', tree: 't', session: { runtime: 'claude', id: 's' }, coverage: 'complete', findings: [{ id: 'F2', location: 'server/src/core/sum.mjs:3', what: 'a stale comment', why: 'misleads', severity: 'low', class: 'other' }], verified: [], blockers: 0 });
    await L.append(p.root, 'TK-2.1', 'finding.filed', { finding: 'F2', mode: 'digest', state: 'done', marker: 'wf:TK-2.1:finding:F2' });
    await L.append(p.root, 'TK-2.1', 'stage', { index: 1, do: 'wait-merged', state: 'waiting', repo: 'server', next: 'merge the request at the forge' });
    await ask(p.root, 'TK-3.1', { kind: 'waiver', question: 'Waive F1?', options: ['waive', 'fix'], refs: ['F1'], blocking: true });
    await L.append(p.root, 'TK-3.1', 'attempt.closed', { outcome: 'abandoned', reason: 'x' });
    await L.append(p.root, 'TK-1.1', 'decision.answered', { id: 'D99', choice: 'x', quote: 'x', via: 'turn', session: null });

    const d = await digest(p.root);
    assert.deepEqual(d.items.map((i) => [i.kind, i.attempt, i.id ?? i.repo]).sort(), [['decision', 'TK-1.1', w.id], ['decision', 'TK-2.1', 'D1'], ['diff-read', 'TK-1.1', 'D2'], ['finding', 'TK-2.1', 'F2'], ['merge', 'TK-2.1', 'server']].sort());
    assert.match(d.text, /Questions for you \(2\)/);
    assert.match(d.text, /Waive F3\? Options: waive \| fix/);
    assert.match(d.text, /F2 \(low\) server\/src\/core\/sum.mjs:3: a stale comment/);
    assert.doesNotMatch(d.text, /F1/);

    const cmd = commandHandler('digest');
    const ctx = { cwd: p.root, root: p.root, env: p.env, actor: null, json: false };
    const first = await cmd(ctx, { _: [], flags: {} });
    assert.ok(fs.existsSync(first.data.file));
    assert.match(fs.readFileSync(first.data.file, 'utf8'), /a stale comment/);
    // Same day: the same digest. A later digest (since now) drops the findings already shown, keeps open questions.
    const again = await cmd(ctx, { _: [], flags: {} });
    assert.equal(again.data.items.length, first.data.items.length);
    const later = await digest(p.root, { since: new Date(Date.now() + 1000).toISOString() });
    assert.equal(later.items.filter((i) => i.kind === 'finding').length, 0);
    assert.equal(later.items.filter((i) => i.kind === 'decision').length, 2);
  });
});

test('digest: nothing waiting says so', async (t) => {
  const p = makeProject({ adapter: false });
  t.after(p.cleanup);
  await withDoubles(fileLedger(), async () => assert.equal((await digest(p.root)).text, 'Nothing waits on you.'));
});
