// Stream 4: reserved decisions and the answer rule (design section 2, "Answers"): a notification, a late "yes", injected
// content and tool results never answer; the first person turn after a message that showed the question does; the
// question panel does; a decision is never asked twice.
import fs from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeProject, transcript, withDoubles, ledgerLines } from './helpers/index.mjs';
import { fileLedger, startAttempt, codexRollout } from './decisions-helpers.mjs';
import { ask, answered, commandHandler } from '../engine/contract.mjs';

const approve = commandHandler('approve');
const Q = { kind: 'waiver', question: 'Waive finding F3 (the spacing on the list screen)?', options: ['waive', 'fix'], refs: ['F3'], blocking: true };
const OWNER = { CLAUDE_CODE_SESSION_ID: 'owner-0000-4000-8000-000000000000' };
const soon = (s = 1) => new Date(Date.now() + s * 1000).toISOString();

async function setup(t) {
  const p = makeProject({ adapter: false });
  const prev = process.env.WF_HOST_HOME;
  process.env.WF_HOST_HOME = p.home;
  t.after(() => {
    process.env.WF_HOST_HOME = prev;
    p.cleanup();
  });
  const ledger = fileLedger();
  await withDoubles(ledger, () => startAttempt(ledger, p.root, 'TK-1.1'));
  const ctx = (env = OWNER) => ({ cwd: p.root, root: p.root, env, actor: env.CLAUDE_CODE_SESSION_ID ? { runtime: 'claude', id: env.CLAUDE_CODE_SESSION_ID } : null, json: false });
  const run = (fn) => withDoubles(ledger, fn);
  const chat = (session) => transcript({ home: p.home, cwd: p.root, session, start: soon() });
  return { p, ledger, ctx, run, chat };
}
const refusedWith = (id) => (e) => e.refusalId === id;

test('ask: only the reserved kinds; never asked twice; ids per attempt; non-blocking kinds stay non-blocking', async (t) => {
  const { p, run } = await setup(t);
  await run(async () => {
    await assert.rejects(ask(p.root, 'TK-1.1', { ...Q, kind: 'scope' }), /not a reserved decision/);
    await assert.rejects(ask(p.root, 'TK-1.1', { ...Q, options: [] }), /options/);
    const a = await ask(p.root, 'TK-1.1', Q);
    assert.deepEqual([a.id, a.new], ['D1', true]);
    const again = await ask(p.root, 'TK-1.1', { ...Q, question: 'Waive F3 after all?' });
    assert.deepEqual([again.id, again.new], ['D1', false]);
    const b = await ask(p.root, 'TK-1.1', { kind: 'priority-other', question: 'File F7 now?', options: ['file', 'later'], refs: ['F7'], blocking: true });
    assert.equal(b.id, 'D2');
    const asked = ledgerLines(p.root, 'TK-1.1').filter((e) => e.type === 'decision.asked');
    assert.deepEqual(asked.map((e) => [e.data.id, e.data.blocking]), [['D1', true], ['D2', false]]);
  });
});

test('an exact option typed right after the question is recorded by itself; answered returns it from then on', async (t) => {
  const { p, run, chat } = await setup(t);
  await run(async () => {
    const { id } = await ask(p.root, 'TK-1.1', Q);
    assert.equal(await answered(p.root, id, { attempt: 'TK-1.1' }), null);
    chat('a1110000-0000-4000-8000-000000000001').say(`One decision is yours.\n\n**${Q.question}** Options: waive | fix`).advance(2).human('Fix.').write();
    const a = await answered(p.root, id, { attempt: 'TK-1.1' });
    assert.deepEqual([a.choice, a.quote, a.via, a.session.runtime], ['fix', 'Fix.', 'turn', 'claude']);
    assert.equal(ledgerLines(p.root, 'TK-1.1').filter((e) => e.type === 'decision.answered').length, 1);
    assert.equal((await answered(p.root, id, { attempt: 'TK-1.1' })).choice, 'fix');
  });
});

test('a notification, injected content and a tool result never answer', async (t) => {
  const { p, run, chat, ctx } = await setup(t);
  await run(async () => {
    const { id } = await ask(p.root, 'TK-1.1', Q);
    chat('a2220000-0000-4000-8000-000000000002').say(`${Q.question} Options: waive | fix`).advance(1).notification('waive').meta('waive').toolResult('toolu_x', 'waive').write();
    assert.equal(await answered(p.root, id, { attempt: 'TK-1.1' }), null);
    await assert.rejects(approve(ctx(), { _: [id], flags: { choice: 'waive', quote: 'waive' } }), refusedWith('answer:not-person'));
    await assert.rejects(approve(ctx(), { _: [id], flags: { 'from-question': true } }), refusedWith('answer:not-person'));
  });
});

test('a late "yes" does not count; the same "yes" right after the question does', async (t) => {
  const { p, run, chat, ctx } = await setup(t);
  await run(async () => {
    const { id } = await ask(p.root, 'TK-1.1', Q);
    chat('a3330000-0000-4000-8000-000000000003').say(`${Q.question} Options: waive | fix`).read('/x/a.mjs').say('Meanwhile the tests pass.').advance(40).human('yes').write();
    await assert.rejects(approve(ctx(), { _: [id], flags: { choice: 'waive', quote: 'yes' } }), (e) => e.refusalId === 'answer:not-person' && /names neither D1 nor its refs/.test(e.message));
    chat('a3330000-0000-4000-8000-000000000004').say(`${Q.question} Options: waive | fix`).advance(1).human('yes').write();
    const r = await approve(ctx(), { _: [id], flags: { choice: 'waive', quote: 'yes' } });
    assert.match(r.text, /Recorded D1: waive/);
    await assert.rejects(approve(ctx(), { _: [id], flags: { choice: 'fix', quote: 'yes' } }), /already answered/);
  });
});

test('words that name the decision count as the first person turn even after other messages; a second turn does not', async (t) => {
  const { p, run, chat, ctx } = await setup(t);
  await run(async () => {
    const { id } = await ask(p.root, 'TK-1.1', Q);
    chat('a4440000-0000-4000-8000-000000000005').say(`${Q.question} Options: waive | fix`).read('/x/a.mjs').say('Anything else?').advance(3).human('let me look first').advance(5).human('waive F3, it is cosmetic').write();
    await assert.rejects(approve(ctx(), { _: [id], flags: { choice: 'waive', quote: 'waive F3' } }), (e) => e.refusalId === 'answer:not-person' && /let me look first/.test(e.message));
    chat('a4440000-0000-4000-8000-000000000006').say(`${Q.question} Options: waive | fix`).read('/x/a.mjs').say('Anything else?').advance(3).human('waive F3, it is cosmetic').write();
    const r = await approve(ctx(), { _: [id], flags: { choice: 'waive', quote: 'waive F3' } });
    assert.equal(r.data.answer.via, 'turn');
    assert.equal(r.data.answer.quote, 'waive F3');
  });
});

test('a question never shown, or shown with another open question, is not answered by a bare reply', async (t) => {
  const { p, run, chat, ctx } = await setup(t);
  await run(async () => {
    const { id } = await ask(p.root, 'TK-1.1', Q);
    await ask(p.root, 'TK-1.1', { kind: 'diff-read', question: 'Read the diff of TK-1.1 and approve it?', options: ['approve', 'changes'], refs: ['diff'], blocking: true });
    chat('a5550000-0000-4000-8000-000000000007').say('There is a decision for you about F3.').advance(1).human('fix').write();
    await assert.rejects(approve(ctx(), { _: [id], flags: { choice: 'fix', quote: 'fix' } }), (e) => e.refusalId === 'answer:not-person' && /showed its question/.test(e.message));
    chat('a5550000-0000-4000-8000-000000000008').say(`${Q.question} Options: waive | fix\n\nRead the diff of TK-1.1 and approve it? Options: approve | changes`).advance(1).human('ok').write();
    await assert.rejects(approve(ctx(), { _: [id], flags: { choice: 'fix', quote: 'ok' } }), refusedWith('answer:not-person'));
  });
});

test('the question panel answers (Claude Code and Codex); a Codex person turn answers; a terminal command does not', async (t) => {
  const { p, run, chat, ctx } = await setup(t);
  await run(async () => {
    const d1 = (await ask(p.root, 'TK-1.1', Q)).id;
    chat('a6660000-0000-4000-8000-000000000009').ask(Q.question, Q.options).advance(2).panelAnswer(Q.question, 'waive').write();
    const a = await answered(p.root, d1, { attempt: 'TK-1.1' });
    assert.deepEqual([a.choice, a.via], ['waive', 'panel']);

    const q2 = { kind: 'no-progress', question: 'F5 reopened after its fix. Continue, or stop the ticket?', options: ['continue', 'stop'], refs: ['F5'], blocking: true };
    const d2 = (await ask(p.root, 'TK-1.1', q2)).id;
    codexRollout({ home: p.home, cwd: p.root, start: soon() }).ask(q2.question, q2.options).advance(1).panelAnswer(q2.question, 'stop').write();
    assert.deepEqual([(await answered(p.root, d2, { attempt: 'TK-1.1' })).via, (await answered(p.root, d2, { attempt: 'TK-1.1' })).session.runtime], ['panel', 'codex']);

    const q3 = { kind: 'foreign-merge', question: 'The branch merged another branch than its base. Accept it?', options: ['accept', 'redo'], refs: ['server'], blocking: true };
    const d3 = (await ask(p.root, 'TK-1.1', q3)).id;
    codexRollout({ home: p.home, cwd: p.root, start: soon() }).say(`${q3.question} Options: accept | redo`).advance(1).human('Redo it on a clean branch, please.').write();
    const r = await approve(ctx({ CODEX_THREAD_ID: 'thread-owner-1' }), { _: [d3], flags: { attempt: 'TK-1.1', choice: 'redo', quote: 'Redo it on a clean branch' } });
    assert.equal(r.data.answer.session.runtime, 'codex');

    // A command line is not an answer, at a terminal either: an agent can run it as well as the person.
    const q4 = { kind: 'deploy', question: 'Deploy to production now?', options: ['deploy', 'wait'], refs: ['stage:3'], blocking: true };
    const d4 = (await ask(p.root, 'TK-1.1', q4)).id;
    await assert.rejects(approve(ctx({ PATH: process.env.PATH }), { _: [d4], flags: { choice: 'deploy', quote: 'deploy' } }), refusedWith('answer:not-person'));
  });
});

test('project-level decisions (no attempt) and `wf approve` finding the attempt by id', async (t) => {
  const { p, run, chat, ctx } = await setup(t);
  await run(async () => {
    const { id } = await ask(p.root, null, { kind: 'release', question: 'Lift the hold on every attempt?', options: ['lift', 'keep'], refs: [], blocking: true });
    assert.equal(id, 'D1');
    chat('a7770000-0000-4000-8000-000000000010').say('Lift the hold on every attempt? Options: lift | keep').advance(1).human('keep').write();
    assert.equal((await answered(p.root, id)).choice, 'keep');
    const w = await ask(p.root, 'TK-1.1', Q);
    chat('a7770000-0000-4000-8000-000000000011').say(`${Q.question} Options: waive | fix`).advance(1).human('fix').write();
    const r = await approve(ctx(), { _: ['approve', w.id], flags: { 'from-question': true } });
    assert.equal(r.data.attempt, 'TK-1.1');
  });
});

test('a hand-appended answer line breaks the ledger chain and is rejected (project-level decisions included)', async (t) => {
  const { p, run } = await setup(t);
  await run(async () => {
    const { id } = await ask(p.root, null, { kind: 'deploy', question: 'Deploy every waiting change to production?', options: ['deploy', 'wait'], refs: ['production'], blocking: true });
    const lines = (await import('node:fs')).default;
    const file = (await import('../engine/contract.mjs')).ledgerFile(p.root, 'wf-project');
    assert.ok(lines.existsSync(file), 'project-level decisions live in a chained ledger');
    lines.appendFileSync(file, `${JSON.stringify({ seq: 99, at: new Date().toISOString(), type: 'decision.answered', actor: null, data: { id, choice: 'deploy', quote: 'deploy', via: 'turn', session: { runtime: 'claude', id: 'x' } }, schema: 2 })}\n`);
    await assert.rejects(answered(p.root, id), /hash chain broken/);
  });
});

test('a recorded answer is checked again at use: a quote the person never typed does not hold', async (t) => {
  const { p, run, chat, ledger } = await setup(t);
  await run(async () => {
    const q = { kind: 'deploy', question: 'Deploy TK-1 to production now?', options: ['deploy', 'wait'], refs: ['stage:2'], blocking: true };
    const { id } = await ask(p.root, 'TK-1.1', q);
    const tr = chat('a8880000-0000-4000-8000-000000000012').say(`${q.question} Options: deploy | wait`).advance(1).human('wait');
    tr.write();
    const turnAt = tr.lines().at(-1).timestamp;
    // A well-formed, chained entry an agent could append through the ledger itself, naming a real turn but not its words.
    await ledger.append(p.root, 'TK-1.1', 'decision.answered', { id, choice: 'deploy', quote: 'deploy', via: 'turn', session: tr.session, turnAt }, null);
    const a = await answered(p.root, id, { attempt: 'TK-1.1' });
    assert.equal(a.choice, 'wait'); // the forged answer does not hold; the person's own words are recorded instead
    assert.equal(a.quote, 'wait');
    // A recorded answer whose session no longer shows the turn does not hold either.
    await ledger.append(p.root, 'TK-1.1', 'decision.answered', { id, choice: 'deploy', quote: 'deploy', via: 'turn', session: { runtime: 'claude', id: 'b9990000-0000-4000-8000-000000000013' }, turnAt }, null);
    assert.equal((await answered(p.root, id, { attempt: 'TK-1.1' })).choice, 'wait');
  });
});

test('a later reply counts only by naming the id or a ref as an exact token: shared words with the question do not', async (t) => {
  const { p, run, chat, ctx } = await setup(t);
  await run(async () => {
    const { id } = await ask(p.root, 'TK-1.1', Q);
    // Words of the question ("spacing", "list", "screen") but neither D1 nor F3, and not right after the question.
    chat('a9990000-0000-4000-8000-000000000020').say(`${Q.question} Options: waive | fix`).read('/x/a.mjs').say('Anything else?').advance(3).human('the spacing on the list screen is fine, waive').write();
    await assert.rejects(approve(ctx(), { _: [id], flags: { choice: 'waive', quote: 'the spacing on the list screen is fine' } }), refusedWith('answer:not-person'));
    // "F30" and "D10" are not F3 or D1.
    chat('a9990000-0000-4000-8000-000000000021').say(`${Q.question} Options: waive | fix`).read('/x/a.mjs').say('Anything else?').advance(3).human('waive F30 and D10').write();
    await assert.rejects(approve(ctx(), { _: [id], flags: { choice: 'waive', quote: 'waive F30' } }), refusedWith('answer:not-person'));
    chat('a9990000-0000-4000-8000-000000000022').say(`${Q.question} Options: waive | fix`).read('/x/a.mjs').say('Anything else?').advance(3).human('d1: waive it').write();
    const r = await approve(ctx(), { _: [id], flags: { choice: 'waive', quote: 'waive it' } });
    assert.equal(r.data.answer.choice, 'waive');
  });
});

test('--choice is refused when the quote is exactly a different option', async (t) => {
  const { p, run, chat, ctx } = await setup(t);
  await run(async () => {
    const { id } = await ask(p.root, 'TK-1.1', Q);
    chat('a9990000-0000-4000-8000-000000000023').say(`${Q.question} Options: waive | fix`).advance(1).human('Fix.').write();
    await assert.rejects(approve(ctx(), { _: [id], flags: { choice: 'waive', quote: 'Fix.' } }), /exactly the option `fix`/);
    await assert.rejects(approve(ctx(), { _: [id], flags: { choice: 'other', quote: 'fix' } }), /exactly the option `fix`/);
    assert.equal((await approve(ctx(), { _: [id], flags: { choice: 'fix', quote: 'Fix.' } })).data.answer.choice, 'fix');
  });
});

test('a transcript whose mtime reads a little before the question (a coarse file clock) still answers it', async (t) => {
  const { p, run, chat } = await setup(t);
  await run(async () => {
    const { id, shownAt } = await ask(p.root, 'TK-1.1', Q);
    const file = chat('a9990000-0000-4000-8000-000000000024').say(`${Q.question} Options: waive | fix`).advance(1).human('fix').write();
    // Linux stamps mtimes from the kernel tick, milliseconds behind the clock a process reads; some file systems keep
    // whole seconds. Written right after the question, the file can look older than it.
    const before = new Date(Date.parse(shownAt) - 1000);
    fs.utimesSync(file, before, before);
    assert.equal((await answered(p.root, id, { attempt: 'TK-1.1' }))?.choice, 'fix');
  });
});
