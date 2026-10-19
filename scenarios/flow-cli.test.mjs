// Stream 1: the cli. WF_DOUBLES only under WF_TEST=1; every command through its handler facade; a refusal exits 75,
// prints its id and is counted; `wf status` names exactly one next command per attempt along the whole flow.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ledgerLines, runWf, writeDoubles } from './helpers/index.mjs';
import { commitWt, setup } from './flow-fixture.mjs';
import { reviewerTranscript } from './helpers/index.mjs';

const T = { WF_TEST: '1' };

test('WF_DOUBLES is ignored unless WF_TEST=1', () => {
  const p = setup();
  try {
    const doubles = writeDoubles(p, 'marker', "findProject: async () => { throw new Error('the double ran'); },");
    const prod = runWf(p, ['status'], { doubles });
    assert.doesNotMatch(prod.err, /the double ran/, 'production ignores WF_DOUBLES');
    const testRun = runWf(p, ['status'], { doubles, env: T });
    assert.match(testRun.err, /the double ran/);
  } finally {
    p.done();
  }
});

test('usage: help lists the commands; an unknown command is a usage error', () => {
  const p = setup();
  try {
    const h = runWf(p, ['help']);
    assert.equal(h.code, 0);
    for (const c of ['start', 'criteria', 'review', 'status', 'close']) assert.match(h.out, new RegExp(`\\b${c}\\b`));
    const u = runWf(p, ['entry', '--item', 'TK-1'], { doubles: p.doublesFile(), env: T });
    assert.equal(u.code, 1);
    assert.match(u.err, /unknown command `entry`/);
  } finally {
    p.done();
  }
});

test('the flow through the cli: status names one next command at every step; a refusal exits 75 and is counted', () => {
  const p = setup();
  try {
    const doubles = p.doublesFile();
    const wf = (args, env = {}) => runWf(p, args, { doubles, env: { ...T, ...env } });
    const next = () => {
      const r = wf(['status', '--json']);
      assert.equal(r.code, 0, r.err);
      const rows = r.json().attempts;
      assert.equal(rows.length, 1);
      assert.equal(typeof rows[0].command, 'string');
      return rows[0].command;
    };
    assert.equal(wf(['start', 'tk-7']).code, 0);
    assert.match(next(), /^wf criteria --file/);
    const crit = path.join(p.tmp, 'criteria.json');
    fs.writeFileSync(crit, JSON.stringify({ criteria: ['the items route accepts an id'], areas: ['server routes'] }));
    assert.equal(wf(['criteria', '--file', crit]).code, 0);
    assert.match(next(), /^wf handoff implementer/);
    assert.equal(wf(['handoff', 'implementer', '--session', 'claude:impl-7']).code, 0);
    commitWt(p, 'TK-7.1', 'server', { 'src/routes/items.controller.mjs': 'export const routes = ["/items", "/items/:id"];\n' });
    assert.match(next(), /^wf review --attempt TK-7\.1/);
    const launched = wf(['review']);
    assert.equal(launched.code, 0, launched.err);
    assert.match(next(), /^wf review --record/);
    const h = ledgerLines(p.root, 'TK-7.1').find((e) => e.type === 'handoff' && e.data.role === 'reviewer');
    const bundleDir = path.join(p.root, '.wf-evidence', 'attempts', 'TK-7.1', 'reviews', fs.readdirSync(path.join(p.root, '.wf-evidence', 'attempts', 'TK-7.1', 'reviews'))[0]);
    const b = JSON.parse(fs.readFileSync(path.join(bundleDir, 'bundle-whole.json'), 'utf8'));
    // A coverage refusal: the reviewer read nothing.
    reviewerTranscript({ home: p.home, cwd: p.root, files: [], session: h.data.session.id });
    fs.writeFileSync(b.output, JSON.stringify({ findings: [], verified: [] }));
    const refused = wf(['review', '--record', b.output]);
    assert.equal(refused.code, 75);
    assert.match(refused.err, /refused \(review:coverage\)/);
    assert.deepEqual(fs.readFileSync(path.join(p.root, '.wf-test-refusals.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l).id), ['review:coverage']);
    reviewerTranscript({ home: p.home, cwd: p.root, files: [path.join(p.wt('TK-7.1', 'server'), 'src/routes/items.controller.mjs')], session: h.data.session.id });
    const rec = wf(['review', '--record', b.output]);
    assert.equal(rec.code, 0, rec.err);
    assert.match(next(), /^wf deliver --attempt TK-7\.1/);
    // A hold names the release, and refuses the owner's own steps.
    assert.equal(wf(['hold', '--reason', 'not now']).code, 0);
    assert.match(next(), /^wf release/);
    const h2 = wf(['handoff', 'implementer', '--session', 'claude:impl-8']);
    assert.equal(h2.code, 75);
    assert.match(h2.err, /refused \(hold\)/);
  } finally {
    p.done();
  }
});
