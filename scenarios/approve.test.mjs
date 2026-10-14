import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { ok, singleRepoProject, state, wf } from './helpers.mjs';

// 0.7.0 (D4), named failure: the owner-phrase grammar refused real approvals (15 of 18 sampled phrase refusals came
// after the person had already said yes) while most recorded "owner decisions" were the orchestrating agent's own
// command. A reserved decision is an engine record the person confirms by typing its choice at a terminal.
// 0.7.0, named failure: refusals left no record, so no check's false-positive rate (principle 13) was ever measured.

async function inProcess(root, fn) {
  const cwd = process.cwd();
  const keep = { ...process.env };
  Object.assign(process.env, { WF_EVIDENCE_FLAGS: '0', WF_CONFIG_HOME: path.join(root, '..', '.wfhome'), WF_HOME: path.join(root, '..', '.home'), WF_IMPROVEMENTS_DIR: path.join(root, '..', '.improvements') });
  process.chdir(root);
  try {
    return await fn();
  } finally {
    process.chdir(cwd);
    for (const k of Object.keys(process.env)) if (!(k in keep)) delete process.env[k];
    Object.assign(process.env, keep);
  }
}

const terminal = () => ({ input: Object.assign(new PassThrough(), { isTTY: true, setRawMode: () => {} }), output: Object.assign(new PassThrough(), { isTTY: true, columns: 80 }) });

test('0.7.0: a reserved decision is created once, refused until the person types the choice, then recorded', async () => {
  const { root } = singleRepoProject('approve-basic', {});
  const e = ok(wf(root, ['entry', '--item', 'ENG-900', '--owner', 'o', '--json'])).json();
  const { createDecision, requireYes, approvedChoice } = await import('../engine/approve.mjs');
  const { loadState } = await import('../engine/ledger.mjs');
  const { approveInTerminal } = await import('../engine/approve.mjs');
  await inProcess(root, async () => {
    let s = loadState(root, e.id);
    assert.throws(() => requireYes(root, s, { kind: 'waive-finding', key: 'R1:F1', summary: 'waive F1', what: 'waiving F1' }), /owner's decision \(A1: waive F1\)/);
    s = loadState(root, e.id);
    // The same pending decision is reused, never duplicated.
    assert.equal(createDecision(root, s, { kind: 'waive-finding', key: 'R1:F1', summary: 'waive F1' }).id, 'A1');
    assert.equal(loadState(root, e.id).decisions.length, 1);
    // Under an agent runtime: refused, nothing recorded.
    await assert.rejects(approveInTerminal(root, 'A1', { attempt: e.id }, { ...terminal(), env: { CLAUDECODE: '1' } }), /not under an agent runtime \(CLAUDECODE\)/);
    // No terminal: refused.
    await assert.rejects(approveInTerminal(root, 'A1', { attempt: e.id }, { input: new PassThrough(), output: new PassThrough(), env: {} }), /not an interactive terminal/);
    // A wrong answer: refused, nothing recorded.
    {
      const t = terminal();
      const pending = approveInTerminal(root, 'A1', { attempt: e.id }, { ...t, env: {} });
      setImmediate(() => t.input.write('maybe\n'));
      await assert.rejects(pending, /not confirmed \(typed "maybe"\)/);
    }
    assert.equal(approvedChoice(loadState(root, e.id), 'waive-finding', 'R1:F1'), null);
    // The typed choice confirms it.
    {
      const t = terminal();
      const pending = approveInTerminal(root, 'A1', { attempt: e.id }, { ...t, env: {} });
      setImmediate(() => t.input.write('yes\n'));
      assert.equal((await pending).choice, 'yes');
    }
    s = loadState(root, e.id);
    assert.equal(approvedChoice(s, 'waive-finding', 'R1:F1'), 'yes');
    assert.deepEqual(requireYes(root, s, { kind: 'waive-finding', key: 'R1:F1', summary: 'waive F1', what: 'waiving F1' }), { decision: 'A1' });
  });
  // The CLI from an agent's shell (no terminal) is refused and lists the decision.
  const r = wf(root, ['approve', 'A1', '--attempt', e.id]);
  assert.equal(r.code, 75);
  assert.match(r.err, /already decided: yes/);
  assert.match(ok(wf(root, ['decisions', '--attempt', e.id])).out, /A1 {2}waive-finding {2}decided: yes {2}waive F1/);
  assert.equal(state(root, e.id).decisions[0].approved.via, 'interactive-terminal (unverified)');
});

test('0.7.0: every refusal is logged with a check id and counted by `wf refusals`', () => {
  const { root } = singleRepoProject('refusal-log', {});
  const e = ok(wf(root, ['entry', '--item', 'ENG-901', '--owner', 'o', '--json'])).json();
  const r = wf(root, ['release', '--attempt', e.id]);
  assert.equal(r.code, 75);
  const log = path.join(root, '..', 'refusals.jsonl');
  const rows = fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(rows.at(-1).cmd, 'release');
  assert.equal(rows.at(-1).attempt, e.id);
  assert.match(rows.at(-1).id, /^attempt\.mjs:\d+$/);
  const counts = ok(wf(root, ['refusals', '--json'])).json();
  assert.equal(counts[0].id, rows.at(-1).id);
  assert.equal(counts[0].count, 1);
});

test('0.7.0: obligations follow the admission version', async () => {
  const { obligationSince } = await import('../engine/versions.mjs');
  assert.equal(obligationSince({ engineVersion: '0.6.6' }, '0.7.0'), false);
  assert.equal(obligationSince({ engineVersion: '0.7.0' }, '0.7.0'), true);
  assert.equal(obligationSince({ engineVersion: '0.10.1' }, '0.7.0'), true);
  assert.equal(obligationSince({ engineVersion: null }, '0.7.0'), false);
});
