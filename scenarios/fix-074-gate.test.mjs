import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { WF, closureFile, commitIn, criteriaFile, goodClosure, ok, singleRepoProject, spawnHome, wf } from './helpers.mjs';

// 0.7.4 stream 2 (gate, evidence reads, provisioning). Each test names the failure it reproduces and fails on 0.7.3.

const steps = [{ id: 'unit', repo: 'app', run: 'true', inputs: ['src/**'] }];
const admitted = (f, item) => ok(wf(f.root, ['entry', '--item', item, '--json'])).json();
const planned = (f, item) => {
  const e = admitted(f, item);
  ok(wf(f.root, ['handoff', 'planner', '--agent', 'p', '--attempt', e.id]));
  ok(wf(f.root, ['plan', '--file', criteriaFile(f.base), '--attempt', e.id]));
  return e;
};
// A changed tree with a clean code review on it: the next `wf gate` is in the order of work.
const reviewedTree = (f, e) => {
  ok(wf(f.root, ['handoff', 'implementer', '--agent', 'i', '--attempt', e.id]));
  commitIn(e.repos.app.worktree, { 'src/a.txt': 'changed\n' });
  ok(wf(f.root, ['handoff', 'reviewer', '--agent', 'r0', '--attempt', e.id]));
  ok(wf(f.root, ['review', '--closure', closureFile(f.base, goodClosure('r0')), '--attempt', e.id]));
};
const evidenceDir = (f, id) => path.join(f.root, '.wf-evidence', 'attempts', id);
const registerProject = (f) => {
  const home = path.join(f.base, '.wfhome');
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, 'projects.json'), JSON.stringify({ projects: [{ root: f.root }] }));
};
const noCrash = (r, what) => assert.doesNotMatch(`${r.out}\n${r.err}`, /TypeError|ReferenceError|ERR_INVALID_ARG|\n\s+at \S+ \(|\n\s+at file:/, `${what} must report, not crash:\n${r.err}`);

// ---------------------------------------------------------------------------------------------------------------------
// I-78 (residual). Named failure: `wf verify` printed "verified 1 attempt(s)" for a ledger.jsonl of 0 bytes whose anchor
// recorded an entry (every anchor check in verifyInner was written `head && ...`), and `wf resume` / `wf status` crashed on
// the same ledger with a TypeError.
test('I-78: an emptied ledger is reported by verify, resume, status and every other command, never verified and never a crash', () => {
  const f = singleRepoProject('empty-ledger', { gate: { steps } });
  registerProject(f);
  const e = admitted(f, 'ENG-1');
  const dir = evidenceDir(f, e.id);
  const anchor = path.join(f.root, '.wf-worktrees', '_anchor', `${e.id}.json`);
  assert.equal(JSON.parse(fs.readFileSync(anchor, 'utf8')).seq, 1, 'the anchor records the admission entry');
  fs.chmodSync(dir, 0o755);
  fs.chmodSync(path.join(dir, 'ledger.jsonl'), 0o644);
  fs.writeFileSync(path.join(dir, 'ledger.jsonl'), '');

  for (const args of [['verify', '--attempt', e.id], ['verify', '--all']]) {
    const v = wf(f.root, args);
    noCrash(v, args.join(' '));
    assert.equal(v.code, 1, `wf ${args.join(' ')} fails: ${v.out}`);
    assert.doesNotMatch(v.out, /verified \d+ attempt/);
    assert.match(v.out, new RegExp(`${e.id}: 1 problem\\(s\\)[\\s\\S]*ledger\\.jsonl holds no entry \\(no admission entry\\), but its anchor records entry 1`));
  }
  // Every command that opens the attempt refuses with the same problem list and names the command that lists it.
  for (const args of [['resume', '--attempt', e.id], ['resume'], ['status'], ['status', '--attempt', e.id], ['status', '--json'], ['evidence', 'list', '--attempt', e.id], ['export', '--attempt', e.id], ['gate', '--attempt', e.id], ['abandon', '--attempt', e.id, '--reason', 'x'], ['signals', '--attempt', e.id]]) {
    const r = wf(f.root, args);
    noCrash(r, args.join(' '));
    assert.equal(r.code, 75, `wf ${args.join(' ')}: ${r.err}`);
    assert.match(r.err, /ledger\.jsonl holds no entry \(no admission entry\), but its anchor records entry 1/);
    assert.match(r.err, new RegExp(`wf verify --attempt ${e.id.replace('.', '\\.')}`));
  }
  // The listing across projects shows the attempt as damaged instead of reading a state that has no id.
  const all = wf(f.root, ['status', '--all']);
  noCrash(all, 'status --all');
  assert.equal(all.code, 0);
  assert.match(all.out, new RegExp(`${e.id}  DAMAGED: ledger empty\\n  next: \`wf verify --attempt ${e.id.replace('.', '\\.')}\``));
  assert.equal(JSON.parse(wf(f.root, ['status', '--all', '--json']).out)[0].damaged, true);
  // The doctor lists it among the attempt checks.
  const doctor = wf(f.root, ['doctor']);
  noCrash(doctor, 'doctor');
  assert.match(doctor.out, /ledger\.jsonl holds no entry/);

  // The anchor gone too: still not verified (it was a green "verified" before as well).
  fs.rmSync(anchor);
  const bare = wf(f.root, ['verify', '--attempt', e.id]);
  assert.equal(bare.code, 1, bare.out);
  assert.match(bare.out, /ledger\.jsonl holds no entry \(no admission entry\), and ENG-1\.1 has no anchor either/);
});

// Same class: with the whole evidence folder of an attempt renamed away, `wf verify --all` verified the attempts left and never
// mentioned the one its anchor still records.
test('I-78: wf verify --all reports an attempt whose anchor survives but whose ledger is gone', () => {
  const f = singleRepoProject('lost-ledger', { gate: { steps } });
  const lost = admitted(f, 'ENG-1');
  const kept = admitted(f, 'ENG-2');
  assert.match(ok(wf(f.root, ['verify', '--all'])).out, /verified 2 attempt\(s\)/);
  const dir = evidenceDir(f, lost.id);
  fs.chmodSync(path.dirname(dir), 0o755);
  fs.renameSync(dir, `${dir}-moved`);

  const all = wf(f.root, ['verify', '--all']);
  assert.equal(all.code, 1, all.out);
  assert.doesNotMatch(all.out, /verified \d+ attempt/);
  assert.match(all.out, new RegExp(`${lost.id.replace('.', '\\.')}: 1 problem\\(s\\)[\\s\\S]*ledger\\.jsonl is missing, but its anchor records entry 1`));
  assert.doesNotMatch(all.out, new RegExp(`${kept.id.replace('.', '\\.')}: `), 'the attempt that is intact is not blamed');
  const one = wf(f.root, ['verify', '--attempt', lost.id]);
  assert.equal(one.code, 75);
  assert.match(one.err, /ENG-1\.1 has no ledger here, so nothing was verified; its anchor records it, so its evidence folder was renamed, moved or deleted/);

  fs.renameSync(`${dir}-moved`, dir);
  assert.match(ok(wf(f.root, ['verify', '--all'])).out, /verified 2 attempt\(s\)/);
});
