import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { closureFile, commitIn, criteriaFile, goodClosure, ok, singleRepoProject, wf } from './helpers.mjs';

// 0.1.20: evidence is tamper-evident and write-protected, and verified at use. Named gaps (0.1.19): writes through MCP
// tools, Codex (no hook), gate steps and tests, run-time-decoded paths, symlinks made earlier, races and people are
// invisible to a command guard. Each attack below is made the way such a writer would make it (lifting the 0444/0555
// protection first where needed) and must be refused, with a named message, by the next engine use.

const visual = [{ id: 'ui', repo: 'app', run: 'mkdir -p shots && printf aaaa > shots/home.png', artifacts: ['shots/*.png'] }];

function gated(name, item, steps = visual) {
  const { base, root } = singleRepoProject(name, { gate: { steps } }, { '.gitignore': '.wf-evidence/\n.wf-worktrees/\nshots/\n' });
  const e = ok(wf(root, ['entry', '--item', item, '--owner', 'o', '--json'])).json();
  ok(wf(root, ['handoff', 'planner', '--agent', 'p', '--attempt', e.id]));
  ok(wf(root, ['plan', '--file', criteriaFile(base), '--attempt', e.id]));
  ok(wf(root, ['handoff', 'implementer', '--agent', 'i', '--attempt', e.id]));
  commitIn(e.repos.app.worktree, { 'src/a.txt': 'q\n' });
  const g = wf(root, ['gate', '--attempt', e.id, '--json']);
  const dir = path.join(root, '.wf-evidence', 'attempts', e.id);
  return { base, root, id: e.id, g, dir, ledger: path.join(dir, 'ledger.jsonl') };
}
const writable = (file) => {
  for (let d = path.dirname(file); d.includes('.wf-evidence'); d = path.dirname(d)) fs.chmodSync(d, 0o755);
  if (fs.existsSync(file)) fs.chmodSync(file, 0o644);
};
// Refused on open (exit 75), or reported by `wf verify` (exit 1, on stdout).
const refusedWith = (r, re) => {
  assert.ok([75, 1].includes(r.code), `${r.code}: ${r.out}${r.err}`);
  const text = r.code === 75 ? r.err : r.out;
  assert.match(text, /does not match what wf recorded/);
  assert.match(text, re);
};

test('every evidence file is recorded in the ledger and protected; `wf verify` checks them all', () => {
  const { root, id, g, dir } = gated('integrity-record', 'ENG-200');
  ok(g);
  const log = JSON.parse(g.out).steps[0].log;
  assert.equal(fs.statSync(log).mode & 0o777, 0o444, 'recorded files are read-only');
  assert.equal(fs.statSync(path.dirname(log)).mode & 0o777, 0o555, 'folders are read-only between commands');
  // Root ignores modes (Linux containers run as root by default): there only detection applies, as `wf doctor` says.
  if (process.getuid?.() !== 0) {
    assert.throws(() => fs.writeFileSync(log, 'x'), /EACCES|EPERM/, 'a careless write fails with a permission error');
    assert.throws(() => fs.writeFileSync(path.join(path.dirname(log), 'stray.txt'), 'x'), /EACCES|EPERM/);
  }
  const recorded = fs.readFileSync(path.join(dir, 'ledger.jsonl'), 'utf8').split('\n').filter(Boolean).map(JSON.parse).filter((e) => e.type === 'evidence.recorded').flatMap((e) => e.data.files);
  for (const rel of ['ui/output.log', 'ui/artifacts/shots/home.png', 'result.json']) assert.ok(recorded.some((f) => f.path.endsWith(rel) && /^[0-9a-f]{64}$/.test(f.sha256) && f.size >= 0 && f.mode === 0o444), rel);
  assert.ok(recorded.some((f) => f.path.startsWith('handoffs/')), 'handoff bundles too');
  assert.match(ok(wf(root, ['verify', '--attempt', id])).out, /verified 1 attempt\(s\): ledger chain, anchor and every recorded evidence file/);
  const anchor = JSON.parse(fs.readFileSync(path.join(root, '.wf-worktrees', '_anchor', `${id}.json`), 'utf8'));
  const head = JSON.parse(fs.readFileSync(path.join(dir, 'ledger.jsonl'), 'utf8').trim().split('\n').at(-1));
  assert.deepEqual([anchor.seq, anchor.hash], [head.seq, head.hash]);
  // Steps never get an evidence path: WF_EVIDENCE is a scratch folder the engine copies in afterwards.
  const envStep = [{ id: 'env', repo: 'app', run: 'printf "$WF_EVIDENCE" > "$WF_EVIDENCE/where.txt"' }];
  const e2 = gated('integrity-scratch', 'ENG-201', envStep);
  ok(e2.g);
  const where = fs.readFileSync(path.join(path.dirname(JSON.parse(e2.g.out).steps[0].log), 'out', 'where.txt'), 'utf8');
  assert.doesNotMatch(where, /\.wf-evidence/);
  assert.match(where, /\.wf-worktrees\/_gate\//);
});

test('attacks after the gate are refused at the next use: changed log, replaced screenshot, stray file, symlink, mode, truncated ledger, edited manifest, missing anchor', () => {
  const { root, id, g, dir, ledger } = gated('integrity-attacks', 'ENG-202');
  ok(g);
  const step = JSON.parse(g.out).steps[0];
  const log = step.log;
  const shot = step.artifacts[0].path;
  const status = () => wf(root, ['status', '--attempt', id]);
  const verify = () => wf(root, ['verify', '--attempt', id]);
  const restore = (file, bytes) => {
    writable(file);
    fs.rmSync(file, { force: true });
    fs.writeFileSync(file, bytes);
    fs.chmodSync(file, 0o444);
  };

  // A gate log edited after the gate (a different size): refused by any command.
  const logBytes = fs.readFileSync(log);
  writable(log);
  fs.appendFileSync(log, 'all tests passed\n');
  refusedWith(status(), /output\.log: size \d+, recorded \d+/);
  restore(log, logBytes);
  ok(status());

  // The same size, other bytes: even a non-content command sees it (the file's ctime changed, so it is re-hashed);
  // every content command re-hashes anyway.
  writable(log);
  fs.writeFileSync(log, Buffer.alloc(logBytes.length, 0x41));
  fs.chmodSync(log, 0o444);
  refusedWith(status(), /output\.log: content differs from its recorded sha256/);
  refusedWith(verify(), /output\.log: content differs from its recorded sha256/);
  refusedWith(wf(root, ['handoff', 'reviewer', '--agent', 'r', '--attempt', id]), /output\.log: content differs/);
  restore(log, logBytes);

  // A screenshot replaced by another image of the same size.
  const shotBytes = fs.readFileSync(shot);
  restore(shot, Buffer.from('bbbb'));
  refusedWith(verify(), /home\.png: content differs from its recorded sha256/);
  restore(shot, shotBytes);

  // A stray file, and a recorded file swapped for a symlink.
  const stray = path.join(path.dirname(log), 'extra.txt');
  writable(stray);
  fs.writeFileSync(stray, 'x');
  refusedWith(status(), /extra\.txt: extra file \(not written by wf\)/);
  fs.rmSync(stray);
  writable(shot);
  fs.rmSync(shot);
  fs.symlinkSync('/etc/hosts', shot);
  refusedWith(status(), /home\.png: symlink/);
  fs.rmSync(shot);
  restore(shot, shotBytes);

  // A recorded file made writable again.
  fs.chmodSync(log, 0o644);
  refusedWith(status(), /output\.log: mode 644, recorded 444/);
  fs.chmodSync(log, 0o444);
  ok(verify());

  // The ledger truncated (its last entries dropped): the prefix is a valid chain, the anchor is ahead of it.
  const ledgerText = fs.readFileSync(ledger, 'utf8');
  fs.writeFileSync(ledger, `${ledgerText.trim().split('\n').slice(0, -2).join('\n')}\n`);
  refusedWith(status(), /does not match its anchor .*the ledger was truncated/);
  fs.writeFileSync(ledger, ledgerText);
  ok(status());

  // A manifest entry edited in place (the recorded sha256 of the screenshot): the chain breaks.
  const lines = ledgerText.trim().split('\n');
  const at = lines.findIndex((l) => l.includes('"evidence.recorded"') && l.includes('home.png'));
  const edited = JSON.parse(lines[at]);
  for (const f of edited.data.files) if (f.path.endsWith('home.png')) f.sha256 = 'f'.repeat(64);
  lines[at] = JSON.stringify(edited);
  fs.writeFileSync(ledger, `${lines.join('\n')}\n`);
  const r = status();
  assert.notEqual(r.code, 0);
  assert.match(r.err, /hash chain broken at entry \d+; the ledger was edited by hand/);
  assert.doesNotMatch(r.err, /content differs/, 'nothing is checked against a broken chain');
  fs.writeFileSync(ledger, ledgerText);

  // The anchor removed.
  const anchor = path.join(root, '.wf-worktrees', '_anchor', `${id}.json`);
  const anchorText = fs.readFileSync(anchor, 'utf8');
  fs.rmSync(anchor, { force: true });
  refusedWith(status(), /anchor .* is missing/);
  fs.writeFileSync(anchor, anchorText);
  ok(verify());
});

test('a capture changed between collection and recording (a race inside the gate) is refused at the next full use', () => {
  // A later step overwrites the capture an earlier step's collection put into the evidence, while the gate is still
  // open; the engine records the changed bytes, but the gate's own record of what it collected (hashed from the bytes it
  // read) disagrees.
  const steps = [
    { id: 'ui', repo: 'app', run: 'mkdir -p shots && printf aaaa > shots/home.png', artifacts: ['shots/*.png'] },
    { id: 'later', repo: 'app', run: 'for f in "$WF_ROOT"/.wf-evidence/attempts/"$WF_ATTEMPT"/gate/*/ui/artifacts/shots/home.png; do printf zzzz > "$f"; done', inputs: ['src/**'] },
  ];
  const { root, id, g } = gated('integrity-race', 'ENG-203', steps);
  ok(g);
  refusedWith(wf(root, ['verify', '--attempt', id]), /home\.png: changed between the gate collecting it and wf recording it/);
  refusedWith(wf(root, ['handoff', 'reviewer', '--agent', 'r', '--attempt', id]), /changed between the gate collecting it and wf recording it/);
});

test('an attempt delivered before 0.1.20 is adopted once, as found; later changes are refused', async () => {
  const { root, id, ledger } = gated('integrity-legacy', 'ENG-204');
  // Rebuild the ledger as 0.1.19 wrote it: no manifest, no anchor (a valid chain).
  const { canonical, sha256 } = await import('../engine/util.mjs');
  let prev = null;
  const old = fs.readFileSync(ledger, 'utf8').trim().split('\n').map(JSON.parse).filter((e) => e.type !== 'evidence.recorded').map((e, i) => {
    const x = { ...e, seq: i + 1, prev, data: e.type === 'admitted' ? { ...e.data, engineVersion: '0.1.19' } : e.data };
    delete x.hash;
    x.hash = sha256(canonical(x));
    prev = x.hash;
    return x;
  });
  fs.writeFileSync(ledger, `${old.map((e) => JSON.stringify(e)).join('\n')}\n`);
  fs.rmSync(path.join(root, '.wf-worktrees', '_anchor', `${id}.json`), { force: true });
  ok(wf(root, ['status', '--attempt', id]));
  assert.ok(fs.readFileSync(ledger, 'utf8').includes('"evidence.baseline"'), 'adopted with an evidence.baseline entry');
  ok(wf(root, ['verify', '--attempt', id]));
  const log = path.join(path.dirname(ledger), 'gate');
  const stray = path.join(log, 'stray.txt');
  fs.chmodSync(log, 0o755);
  fs.writeFileSync(stray, 'x');
  refusedWith(wf(root, ['status', '--attempt', id]), /gate\/stray\.txt: extra file/);
});

test('macOS: recorded evidence carries the user-immutable flag; the engine lifts it only for its own rewrites', { skip: process.platform !== 'darwin' }, () => {
  const { base, root } = singleRepoProject('integrity-uchg', { gate: { steps: visual } }, { '.gitignore': '.wf-evidence/\n.wf-worktrees/\nshots/\n' });
  const env = { WF_EVIDENCE_FLAGS: '1' };
  try {
    const e = ok(wf(root, ['entry', '--item', 'ENG-205', '--owner', 'o', '--json'], { env })).json();
    ok(wf(root, ['handoff', 'planner', '--agent', 'p', '--attempt', e.id], { env }));
    ok(wf(root, ['plan', '--file', criteriaFile(base), '--attempt', e.id], { env }));
    const bundle = fs.readdirSync(path.join(root, '.wf-evidence', 'attempts', e.id, 'handoffs')).map((f) => path.join(root, '.wf-evidence', 'attempts', e.id, 'handoffs', f))[0];
    assert.match(spawnSync('ls', ['-lO', bundle], { encoding: 'utf8' }).stdout, /uchg/);
    fs.chmodSync(path.dirname(bundle), 0o755);
    assert.throws(() => fs.rmSync(bundle), /EPERM/, 'even with its folder writable, an immutable file cannot be removed');
    ok(wf(root, ['export', '--attempt', e.id], { env }));
    ok(wf(root, ['export', '--attempt', e.id], { env }));
    ok(wf(root, ['verify', '--attempt', e.id], { env }));
  } finally {
    spawnSync('chflags', ['-R', 'nouchg', path.join(root, '.wf-evidence')]);
    spawnSync('chmod', ['-R', 'u+w', path.join(root, '.wf-evidence')]);
  }
});
