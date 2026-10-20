// End to end, the real `wf` with no doubles: a reserved decision (lifting the person's hold) is answered only by the
// person's own turn in a session of the project. A command line, a notification, and a hash-chained ledger line written
// by hand are not answers.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { append } from '../engine/contract.mjs';
import { makeProject, transcript } from './helpers/index.mjs';
import { events, wf } from './e2e-support.mjs';

function project() {
  const p = makeProject({
    name: 'answers',
    repos: [{ name: 'app', base: 'trunk', files: { 'src/a.mjs': 'export const a = 1;\n', 'README.md': '# app\n' } }],
    overrides: {
      ticketing: { tracker: 'files', via: 'files', idPattern: '^TK-\\d+$' },
      delivery: { landing: 'direct', stages: [{ do: 'land' }] },
    },
  });
  fs.mkdirSync(path.join(p.root, 'tickets'));
  fs.writeFileSync(path.join(p.root, 'tickets', 'TK-1.md'), '---\nid: TK-1\ntitle: One\nstatus: Todo\n---\nOne.\n');
  return p;
}

test('a reserved decision: forged answers are refused; the person\'s turn after the question answers it', async () => {
  const p = project();
  const owner = crypto.randomUUID();
  const as = { env: { CLAUDE_CODE_SESSION_ID: owner } };
  try {
    wf(p, ['start', 'TK-1'], as);
    // The person says "hold it"; the owner records it at once.
    wf(p, ['hold', '--reason', 'pause this', '--quote', 'hold TK-1, pause this'], as);
    assert.match(wf(p, ['review'], { code: 75, ...as }).err, /refused \(hold\)/);
    assert.match(wf(p, ['abandon', '--reason', 'x'], { code: 75, ...as }).err, /refused \(hold\)/);

    // Lifting it is the person's decision: wf asks it.
    const asked = wf(p, ['release'], as);
    assert.match(asked.out, /asked the person \(D1\): Lift the hold on TK-1\.1 \("pause this"\)\? Options: lift the hold \| keep the hold/);
    const question = 'Lift the hold on TK-1.1 ("pause this")?';
    assert.match(wf(p, ['status'], as).out, /next: wf release --attempt TK-1\.1/);

    // Forged 1: the agent's own command line, with no person turn after the question.
    const cmd = wf(p, ['approve', 'D1', '--attempt', 'TK-1.1', '--choice', 'lift the hold', '--quote', 'lift the hold'], { code: 75, ...as });
    assert.match(cmd.err, /refused \(answer:not-person\): D1 has no person turn after a message that showed its question/);

    // Forged 2: the question is shown, then a notification carrying the option's words. A notification is not the person.
    const t = transcript({ home: p.home, cwd: p.root, session: owner, start: new Date(Date.now() + 1000).toISOString() });
    t.human('Implement TK-1.').advance(1).say(`D1: "${question}" Options: lift the hold | keep the hold`).advance(1).notification('lift the hold').write();
    assert.equal(wf(p, ['approve', 'D1', '--attempt', 'TK-1.1', '--from-question'], { code: 75, ...as }).code, 75);
    assert.match(wf(p, ['release'], as).out, /asked the person \(D1\)/);

    // Forged 3: a hash-chained `decision.answered` appended by hand. It is re-checked against the transcript at use.
    await append(p.root, 'TK-1.1', 'decision.answered', { id: 'D1', choice: 'lift the hold', quote: 'lift the hold', via: 'turn', session: { runtime: 'claude', id: owner }, turnAt: new Date().toISOString() }, null);
    const still = wf(p, ['release'], as);
    assert.doesNotMatch(still.out, /hold lifted/);
    assert.equal(events(p, 'TK-1.1', 'release').length, 0);

    // The person's own turn, the first after the question was shown: it answers. Words that are exactly an option are
    // recorded from the question; the hold is then lifted.
    t.advance(1).human('lift the hold').write();
    const ok = wf(p, ['approve', 'D1', '--attempt', 'TK-1.1', '--from-question'], as);
    assert.match(ok.out, /Recorded D1: lift the hold, from "lift the hold" \(their turn, claude session /);
    assert.match(wf(p, ['release'], as).out, /hold lifted on TK-1\.1 by the person's answer D1 \("lift the hold"\)/);
    assert.equal(events(p, 'TK-1.1', 'release').length, 1);
    // Never asked twice: the same decision stays answered.
    assert.match(wf(p, ['approve', 'D1', '--attempt', 'TK-1.1', '--from-question'], { code: 1, ...as }).err, /D1 is already answered/);
    assert.match(wf(p, ['status'], as).out, /next: wf criteria/);
  } finally {
    p.cleanup();
  }
});
