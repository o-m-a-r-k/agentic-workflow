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

test('digest: credentials in a finding, a question or a stage are masked (catalogued values, prefixed tokens, query keys)', async (t) => {
  const p = makeProject({ adapter: false });
  t.after(p.cleanup);
  const VALUE = 'cv-0123456789abcdef-fixture';
  fs.mkdirSync(`${p.root}/.workflow`, { recursive: true });
  fs.writeFileSync(`${p.root}/.workflow/secrets.yaml`, 'keys:\n  - { key: SERVICE_KEY, repo: server, required: true }\n');
  fs.writeFileSync(`${p.root}/server/.env.local`, `SERVICE_KEY=${VALUE}\n`);
  const L = fileLedger();
  const adapter = { name: 'sample', repos: [{ name: 'server', path: 'server' }] };
  await withDoubles({ ...L, loadAdapter: async () => adapter }, async () => {
    await startAttempt(L, p.root, 'TK-1.1');
    await ask(p.root, 'TK-1.1', { kind: 'waiver', question: `Waive F3? It logs ${VALUE}.`, options: ['waive', 'fix'], refs: ['F3'], blocking: true });
    await L.append(p.root, 'TK-1.1', 'review.recorded', { review: 1, round: 1, seat: 'whole', tree: 't', session: { runtime: 'claude', id: 's' }, coverage: 'complete', findings: [{ id: 'F2', location: 'server/a.mjs:1', what: 'calls https://x.test/api?token=abc123def456&page=2 with Authorization: Bearer abcdefghijklmnop1234', why: 'ghp_0123456789abcdefghij leaks', severity: 'low', class: 'other' }], verified: [], blockers: 0 });
    await L.append(p.root, 'TK-1.1', 'finding.filed', { finding: 'F2', mode: 'digest', state: 'done', marker: 'm' });
    const d = await digest(p.root);
    const all = `${d.text}\n${JSON.stringify(d.items)}`;
    for (const leak of [VALUE, 'abc123def456', 'abcdefghijklmnop1234', 'ghp_0123456789abcdefghij']) assert.ok(!all.includes(leak), `${leak} leaked`);
    assert.match(d.text, /\[secret\]/);
    assert.match(d.text, /token=\[redacted\]&page=2/);
  });
});

test('digest: an attempt closed outside its stages (by patch-id) is shown once, on the day it closed', async (t) => {
  const p = makeProject({ adapter: false });
  t.after(p.cleanup);
  const L = fileLedger();
  await withDoubles({ ...L, loadAdapter: async () => ({ name: 'sample' }) }, async () => {
    await startAttempt(L, p.root, 'TK-4.1');
    await startAttempt(L, p.root, 'TK-5.1');
    await L.append(p.root, 'TK-4.1', 'attempt.closed', { outcome: 'shipped', reason: 'its commits are on the base', outsideStages: true });
    await L.append(p.root, 'TK-5.1', 'attempt.closed', { outcome: 'shipped', reason: 'delivered' });
    const d = await digest(p.root);
    assert.deepEqual(d.items.map((i) => [i.kind, i.attempt]), [['outside', 'TK-4.1'], ['shipped', 'TK-4.1'], ['shipped', 'TK-5.1']]);
    // Each shipped attempt is one line, with the reviewer's risk judgement (none was recorded here).
    assert.match(d.text, /Shipped \(2\):\n- TK-4 \(TK-4\.1\): no risk judgement recorded\n- TK-5 \(TK-5\.1\): no risk judgement recorded/);
    assert.match(d.text, /Closed outside its stages \(1\):\n- TK-4 \(TK-4\.1\): closed shipped by its patch-ids/);
    assert.equal((await digest(p.root, { since: new Date(Date.now() + 1000).toISOString() })).items.length, 0);
  });
});

test('0.8.1 review: each shipped attempt is one digest line with the reviewer\'s risk judgement and any dropped need', async (t) => {
  const p = makeProject({ adapter: false });
  t.after(p.cleanup);
  const L = fileLedger();
  await withDoubles({ ...L, loadAdapter: async () => ({ name: 'sample' }) }, async () => {
    await startAttempt(L, p.root, 'TK-6.1');
    const base = { round: 1, seat: 'whole', tree: 't', session: { runtime: 'claude', id: 'r1' }, coverage: 'complete', findings: [], verified: [], blockers: 0 };
    await L.append(p.root, 'TK-6.1', 'review.recorded', { ...base, review: 1, risk: { level: 'high', why: 'it grants access', needs: ['diff-read', 'second-review'] } });
    await L.append(p.root, 'TK-6.1', 'review.recorded', { ...base, review: 2, round: 2, risk: { level: 'low', why: 'narrowed', needs: [], drop: [{ need: 'diff-read', why: 'the role check is unchanged' }] } });
    await L.append(p.root, 'TK-6.1', 'attempt.closed', { outcome: 'shipped', reason: 'delivered' });
    const d = await digest(p.root);
    assert.match(d.text, /Shipped \(1\):\n- TK-6 \(TK-6\.1\): Reviewer's risk: high – it grants access; dropped: diff-read \(the role check is unchanged\)/);
  });
});
