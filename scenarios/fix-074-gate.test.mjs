import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { WF, closureFile, commitIn, criteriaFile, goodClosure, ok, singleRepoProject, spawnHome, state, wf, yaml } from './helpers.mjs';

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
  // A bare `wf status` lists it as damaged, with the check to run, and exits 0 (independent review of 0.7.4: it refused, and so
  // hid every healthy attempt beside it).
  for (const args of [['status'], ['status', '--json']]) {
    const r = wf(f.root, args);
    noCrash(r, args.join(' '));
    assert.equal(r.code, 0, `wf ${args.join(' ')}: ${r.err}`);
    assert.match(r.out, /ledger\.jsonl holds no entry \(no admission entry\), but its anchor records entry 1/);
    if (!args.includes('--json')) assert.match(r.out, new RegExp(`wf verify --attempt ${e.id.replace('.', '\\.')}`));
  }
  for (const args of [['resume', '--attempt', e.id], ['resume'], ['status', '--attempt', e.id], ['evidence', 'list', '--attempt', e.id], ['export', '--attempt', e.id], ['gate', '--attempt', e.id], ['abandon', '--attempt', e.id, '--reason', 'x'], ['signals', '--attempt', e.id]]) {
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
  const away = path.join(f.base, `moved-${lost.id}`);
  fs.chmodSync(path.dirname(dir), 0o755);
  fs.renameSync(dir, away);

  const all = wf(f.root, ['verify', '--all']);
  assert.equal(all.code, 1, all.out);
  assert.doesNotMatch(all.out, /verified \d+ attempt/);
  assert.match(all.out, new RegExp(`${lost.id.replace('.', '\\.')}: 1 problem\\(s\\)[\\s\\S]*ledger\\.jsonl is missing, but its anchor records entry 1`));
  assert.doesNotMatch(all.out, new RegExp(`${kept.id.replace('.', '\\.')}: `), 'the attempt that is intact is not blamed');
  const one = wf(f.root, ['verify', '--attempt', lost.id]);
  assert.equal(one.code, 75);
  assert.match(one.err, /ENG-1\.1 has no ledger here, so nothing was verified; its anchor records it, so its evidence folder was renamed, moved or deleted/);

  fs.renameSync(away, dir);
  assert.match(ok(wf(f.root, ['verify', '--all'])).out, /verified 2 attempt\(s\)/);
});

// ---------------------------------------------------------------------------------------------------------------------
// Helpers for the gate tests below: a `wf` process that runs on while the test acts on it, in the scenario's own WF_CONFIG_HOME
// (its lease folder is the only one these tests touch).
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (what, fn, ms = 20000) => {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(50);
  }
};
const homeOf = (f) => path.join(f.base, '.wfhome');
const leasesOf = (f) => path.join(homeOf(f), 'leases');
const startWf = (f, args) => {
  const env = { ...process.env, WF_CONFIG_HOME: homeOf(f), ...spawnHome(f.root), WF_EVIDENCE_FLAGS: '0' };
  for (const k of ['CLAUDE_CODE_SESSION_ID', 'CLAUDECODE', 'CODEX_THREAD_ID', 'CODEX_SANDBOX', 'AI_AGENT', 'GROK_SESSION_ID']) delete env[k];
  const child = spawn(process.execPath, [WF, ...args], { cwd: f.root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (out += d));
  const ended = new Promise((resolve) => child.once('close', (code) => resolve(code)));
  return { child, ended, text: () => out };
};
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const lockOf = (f, id) => path.join(evidenceDir(f, id), 'gate', 'gate.lock');
const lockData = (f, id) => {
  try {
    return JSON.parse(fs.readFileSync(lockOf(f, id), 'utf8'));
  } catch {
    return null;
  }
};
const setLeases = (f, leases) => {
  const file = path.join(f.root, '.workflow', 'project.yaml');
  const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
  fs.writeFileSync(file, JSON.stringify({ ...cfg, gate: { ...cfg.gate, leases } }, null, 2));
};
const holdFile = (f) => path.join(f.base, 'hold');
// A gate step that holds its lease for as long as the `hold` marker exists.
const holdStep = { id: 'stack', repo: 'app', run: 'while [ -f "$WF_ROOT/../hold" ]; do sleep 0.2; done', lease: 'docker', inputs: ['src/**'] };
const committed = (f, item, content) => {
  const e = admitted(f, item);
  commitIn(e.repos.app.worktree, { 'src/a.txt': content });
  return e;
};

// ---------------------------------------------------------------------------------------------------------------------
// I-88 (residual). Named failure: `capacityOf` re-read `gate.leases` for a waiting check and gate, but `wf run --lease` read the
// capacity once: with docker.1 held and the project's config raised to 2, it kept waiting for a slot that existed.
test('I-88: wf run --lease waiting on a full lease starts when the project raises the lease capacity', async () => {
  const f = singleRepoProject('run-lease-raise', { gate: { leases: { docker: 1 }, steps } });
  fs.mkdirSync(leasesOf(f), { recursive: true });
  fs.writeFileSync(path.join(leasesOf(f), 'docker.1'), String(process.pid)); // held by a live process
  const r = startWf(f, ['run', '--lease', 'docker', '--', 'echo', 'ran-it']);
  try {
    await until('the wait notice', () => /waiting for a `docker` lease/.test(r.text()));
    await sleep(1200);
    assert.equal(r.child.exitCode, null, 'it waits while the only docker slot is held');
    setLeases(f, { docker: 2 });
    const code = await Promise.race([r.ended, sleep(15000).then(() => 'timeout')]);
    assert.equal(code, 0, r.text());
    assert.match(r.text(), /ran-it/);
    assert.match(r.text(), /lease `docker` now allows 2 slot\(s\) \(it was 1\)/);
    assert.match(r.text(), /held by pid \d+ \(no details recorded\)/, 'the wait says who holds the slot (a holder that recorded nothing is named by its pid)');
    assert.match(r.text(), /raise `gate\.leases\.docker` in the project's \.workflow\/project\.yaml/, 'and how capacity is raised');
  } finally {
    r.child.kill('SIGKILL');
    fs.rmSync(path.join(leasesOf(f), 'docker.1'), { force: true });
  }
  assert.deepEqual(fs.readdirSync(leasesOf(f)), [], 'the slot it took is freed, with its holder note');
});

// ---------------------------------------------------------------------------------------------------------------------
// I-113 (part 2, with I-88). Named failure: a check waiting for a full lease printed nothing after "N to run", and `wf status`
// said only "running: none (waiting for a lease)": neither named the lease, who held it, or how to allow more.
test('I-113: a check waiting for a full lease says which lease, who holds it and how capacity is raised, in its output and in wf status', async () => {
  const f = singleRepoProject('lease-wait-text', { gate: { leases: { docker: 1 }, steps: [holdStep] } });
  fs.writeFileSync(holdFile(f), '');
  const first = committed(f, 'ENG-1', 'one\n');
  const second = committed(f, 'ENG-2', 'two\n');
  const a = startWf(f, ['check', '--attempt', first.id]);
  let b;
  try {
    await until('the first check to hold the slot', () => fs.existsSync(path.join(leasesOf(f), 'docker.1')) && /start\s+stack/.test(a.text()));
    b = startWf(f, ['check', '--attempt', second.id]);
    await until('the second check to say it waits', () => /waiting\s+stack/.test(b.text()));
    assert.match(b.text(), new RegExp(`waiting\\s+stack\\s+for lease docker \\(1 slot\\(s\\), all held\\): held by pid ${a.child.pid} \\(${first.id.replace('.', '\\.')} step stack\\) since \\d\\d:\\d\\d:\\d\\dZ\\. To allow more at once, raise \`gate\\.leases\\.docker\` in the project's \\.workflow/project\\.yaml`));

    // `wf status` and `wf resume` name the lease and its holder where they used to say only "waiting for a lease".
    await until('the wait in the progress file', () => /waiting: stack/.test(wf(f.root, ['status', '--attempt', second.id]).out));
    for (const args of [['status', '--attempt', second.id], ['resume', '--attempt', second.id]]) {
      const view = ok(wf(f.root, args)).out;
      assert.match(view, /running: none\n/);
      assert.match(view, new RegExp(`waiting: stack for lease docker \\(1 slot\\(s\\), all held\\) for \\d+s: held by pid ${a.child.pid} \\(${first.id.replace('.', '\\.')} step stack\\)`));
      assert.match(view, /raise `gate\.leases\.docker`/);
      assert.doesNotMatch(view, /none \(waiting for a lease\)/);
    }
    fs.rmSync(holdFile(f));
    assert.equal(await a.ended, 0, a.text());
    assert.equal(await b.ended, 0, b.text());
    assert.deepEqual(fs.readdirSync(leasesOf(f)), [], 'both checks freed their slots');
  } finally {
    fs.rmSync(holdFile(f), { force: true });
    a.child.kill('SIGKILL');
    b?.child.kill('SIGKILL');
  }
});

// ---------------------------------------------------------------------------------------------------------------------
// I-113 (part 1). Named failure: a stopped check records its class and reason, but `wf status` and `wf resume` printed only
// "last check: stopped (run…)", so a tree change could not be told from an owner decision after the fact.
test('I-113: wf status and wf resume show the class and reason of a stopped check and of a stopped gate', async () => {
  const f = singleRepoProject('stopped-reason', { gate: { steps: [{ id: 'slow', repo: 'app', run: 'while [ -f "$WF_ROOT/../hold" ]; do sleep 0.2; done', inputs: ['src/**'] }] } });
  const e = planned(f, 'ENG-1');
  reviewedTree(f, e);
  fs.writeFileSync(holdFile(f), '');
  try {
    const check = startWf(f, ['check', '--attempt', e.id]);
    await until('the check to run its step', () => lockData(f, e.id)?.children?.length >= 1);
    ok(wf(f.root, ['stop', '--class', 'tree-change', '--reason', 'two fixes still to commit', '--attempt', e.id]));
    assert.equal(await check.ended, 1, check.text());
    for (const args of [['status', '--attempt', e.id], ['resume', '--attempt', e.id]]) {
      const view = ok(wf(f.root, args)).out;
      assert.match(view, /last check: stopped \(tree-change: two fixes still to commit\) \(/, `wf ${args[0]}:\n${view}`);
    }

    const gate = startWf(f, ['gate', '--attempt', e.id]);
    await until('the gate to run its step', () => lockData(f, e.id)?.runId && lockData(f, e.id)?.children?.length >= 1 && lockData(f, e.id)?.kind === 'gate');
    ok(wf(f.root, ['stop', '--class', 'owner-decision', '--reason', 'the owner wants another plan', '--attempt', e.id]));
    assert.equal(await gate.ended, 1, gate.text());
    for (const args of [['status', '--attempt', e.id], ['resume', '--attempt', e.id]]) {
      const view = ok(wf(f.root, args)).out;
      assert.match(view, /last gate: stopped \(owner-decision: the owner wants another plan\) \(/, `wf ${args[0]}:\n${view}`);
      assert.match(view, /last check: stopped \(tree-change: two fixes still to commit\) \(/);
    }
  } finally {
    fs.rmSync(holdFile(f), { force: true });
  }
});

// ---------------------------------------------------------------------------------------------------------------------
// I-91 (residual). Named failure: step completions were retried while the evidence was locked, but any other unexpected error in
// the gate's scheduler (writing `progress.json`, reading a lease slot) left the callback of a timer or of a finished step, so
// nothing caught it: the runner died with exit 1, a step's process still running and `gate.lock` behind.
const parallel = { gate: { maxParallelSteps: 2, leases: { docker: 1 }, steps: [
  { id: 'long', repo: 'app', run: 'while [ -f "$WF_ROOT/../hold" ]; do sleep 0.2; done', inputs: ['src/**'] },
  { id: 'queued', repo: 'app', run: 'true', lease: 'docker', inputs: ['src/**'] },
] } };
const killGroup = (pid) => {
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {}
};

// The pids the run's lock names, collected while it runs: after a crash the lock is the only record of them.
const watchChildren = (f, id) => {
  const seen = new Set();
  const timer = setInterval(() => {
    for (const pid of lockData(f, id)?.children ?? []) seen.add(pid);
  }, 30);
  return { seen, stop: () => clearInterval(timer) };
};

test('I-91: a progress file that cannot be written ends the run: every child is signalled, the lock and the lease slot are freed, the run is recorded failed', async () => {
  const f = singleRepoProject('scheduler-escape', parallel);
  const e = committed(f, 'ENG-1', 'one\n');
  fs.writeFileSync(holdFile(f), '');
  fs.mkdirSync(leasesOf(f), { recursive: true });
  fs.writeFileSync(path.join(leasesOf(f), 'docker.1'), String(process.pid)); // `queued` waits for this slot
  const r = startWf(f, ['check', '--attempt', e.id]);
  const watch = watchChildren(f, e.id);
  let progress = null;
  try {
    const lock = await until('the long step to run', () => (lockData(f, e.id)?.children?.length >= 1 ? lockData(f, e.id) : null));
    progress = path.join(evidenceDir(f, e.id), 'gate', lock.runId, 'progress.json');
    await until('the long step to start', () => /start\s+long/.test(r.text()));
    await sleep(1300); // `queued` has been tried against the held slot more than once
    // The live view is swapped for a link while the run goes on; the next time the scheduler writes it, it is refused.
    fs.rmSync(progress, { force: true });
    fs.symlinkSync(path.join(f.base, 'elsewhere.json'), progress);
    fs.rmSync(path.join(leasesOf(f), 'docker.1')); // the slot frees: `queued` is started, and the progress write fails
    const code = await Promise.race([r.ended, sleep(20000).then(() => 'timeout')]);
    await sleep(300);
    assert.deepEqual([...watch.seen].filter(alive), [], `no step process outlives the runner (runner exit ${code}):\n${r.text()}`);
    assert.equal(lockData(f, e.id), null, `gate.lock is removed:\n${r.text()}`);
    assert.deepEqual(fs.readdirSync(leasesOf(f)), [], 'the lease slot the run took is freed');
    assert.equal(code, 1, `the runner ends as a failed check, not a crash: ${r.text()}`);
    assert.doesNotMatch(r.text(), /TypeError|\n\s+at /, 'no stack trace');
    assert.match(r.text(), /wf check: aborting: .*progress\.json is a symlink/);
    // The link stays where it was put until the owner removes it (the next command refuses it, as it refuses any link in the evidence).
    assert.match(wf(f.root, ['status', '--attempt', e.id]).err, /progress\.json: .*symlink/);
    fs.chmodSync(path.dirname(progress), 0o755);
    fs.rmSync(progress);
    const last = state(f.root, e.id).checks.at(-1);
    assert.equal(last.status, 'failed');
    assert.match(last.error, /progress\.json is a symlink/);
    assert.deepEqual(last.steps.map((x) => `${x.id}:${x.status}`).sort(), ['long:interrupted', 'queued:not-started']);
    assert.match(ok(wf(f.root, ['status', '--attempt', e.id])).out, /last check: failed \(.*progress\.json is a symlink/);
  } finally {
    watch.stop();
    r.child.kill('SIGKILL');
    for (const pid of watch.seen) killGroup(pid);
    fs.rmSync(holdFile(f), { force: true });
  }
});

// The lease slot read, the other escape the triage named: a slot that cannot be read is held by someone we cannot judge.
test('I-91: a lease slot that vanishes or cannot be read is waited for, not an error that kills the runner', async () => {
  const f = singleRepoProject('lease-slot-read', parallel);
  const e = committed(f, 'ENG-1', 'one\n');
  fs.writeFileSync(holdFile(f), '');
  fs.mkdirSync(leasesOf(f), { recursive: true });
  const slot = path.join(leasesOf(f), 'docker.1');
  fs.symlinkSync(path.join(f.base, 'nowhere'), slot); // exists for the exclusive create, reads as ENOENT
  const r = startWf(f, ['check', '--attempt', e.id]);
  const watch = watchChildren(f, e.id);
  try {
    await until('the long step to start', () => /start\s+long/.test(r.text()));
    await sleep(1500);
    assert.equal(r.child.exitCode, null, `the runner is alive and waiting, not crashed:\n${r.text()}`);
    assert.deepEqual([...watch.seen].filter((pid) => !alive(pid)), [], 'and the step it started is running');
    fs.rmSync(slot);
    fs.mkdirSync(slot); // a folder where a slot file should be: EISDIR on read
    await sleep(1500);
    assert.equal(r.child.exitCode, null, `still waiting, not crashed:\n${r.text()}`);
    fs.rmdirSync(slot);
    fs.rmSync(holdFile(f));
    assert.equal(await Promise.race([r.ended, sleep(20000).then(() => 'timeout')]), 0, r.text());
    assert.equal(state(f.root, e.id).checks.at(-1).status, 'passed');
  } finally {
    watch.stop();
    r.child.kill('SIGKILL');
    for (const pid of watch.seen) killGroup(pid);
    fs.rmSync(holdFile(f), { force: true });
  }
});

// Defense in depth for the same failure: an error thrown from a timer inside a step plugin (which runs in the runner's process)
// is an uncaught exception; it used to kill the runner, with the other steps' processes running on.
test('I-91: an error thrown from a step plugin\'s timer ends the run failed and signals the other steps\' processes', async () => {
  const plugin = `let release;
export default {
  async run() {
    setTimeout(() => { throw new Error('plugin-timer-boom'); }, 700);
    await new Promise((resolve) => { release = resolve; });
    return { status: 'passed', suites: [] };
  },
  async cleanup() { release?.(); },
};`;
  const f = singleRepoProject('plugin-timer', { gate: { maxParallelSteps: 2, steps: [
    { id: 'long', repo: 'app', run: 'while [ -f "$WF_ROOT/../hold" ]; do sleep 0.2; done', inputs: ['src/**'] },
    { id: 'boom', repo: 'app', plugin: 'steps/boom.mjs', inputs: ['src/**'] },
  ] } }, { '.workflow/steps/boom.mjs': plugin });
  const e = committed(f, 'ENG-1', 'one\n');
  fs.writeFileSync(holdFile(f), '');
  const r = startWf(f, ['check', '--attempt', e.id]);
  const watch = watchChildren(f, e.id);
  try {
    const code = await Promise.race([r.ended, sleep(20000).then(() => 'timeout')]);
    await sleep(300);
    assert.deepEqual([...watch.seen].filter(alive), [], `no step process outlives the runner (runner exit ${code}):\n${r.text()}`);
    assert.equal(lockData(f, e.id), null, `gate.lock is removed:\n${r.text()}`);
    assert.equal(code, 1, r.text());
    assert.match(r.text(), /wf check: aborting: plugin-timer-boom/);
    const last = state(f.root, e.id).checks.at(-1);
    assert.equal(last.status, 'failed');
    assert.equal(last.error, 'plugin-timer-boom');
    assert.deepEqual(last.steps.map((x) => `${x.id}:${x.status}`).sort(), ['boom:interrupted', 'long:interrupted']);
  } finally {
    watch.stop();
    r.child.kill('SIGKILL');
    for (const pid of watch.seen) killGroup(pid);
    fs.rmSync(holdFile(f), { force: true });
  }
});

// ---------------------------------------------------------------------------------------------------------------------
// I-109 (part 2). Named failure: the strategist's bundle was written into the evidence and the handoff appended to the ledger
// with no transaction, and the file was recorded only when the process ended: a `wf` command another session ran in between
// refused with "extra file (not written by wf)". The writer here stops for a moment right after the bundle is on disk (the
// rename that publishes it); a `wf status` started then must neither see the bundle as an extra file nor be refused.
test('I-109: a strategist handoff is written, entered in the ledger and recorded in one transaction: a command running meanwhile never sees an extra file', async () => {
  const f = singleRepoProject('strategist-transaction', { gate: { steps } });
  const e = planned(f, 'ENG-1');
  const engine = path.resolve(path.dirname(WF), '..', 'engine');
  const probe = path.join(f.base, 'probe.out');
  const runner = path.join(f.base, 'strategist-runner.mjs');
  fs.writeFileSync(runner, `import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { main } from ${JSON.stringify(path.join(engine, 'cli.mjs'))};
let fired = false;
const rename = fs.renameSync;
fs.renameSync = function (from, to) {
  const result = rename.apply(this, arguments);
  if (!fired && String(to).endsWith('-strategist.json')) {
    fired = true; // the bundle is on disk; the ledger entry and the manifest record are not written yet
    const command = ${JSON.stringify(`${JSON.stringify(process.execPath)} ${JSON.stringify(WF)} status --attempt ${e.id} > ${JSON.stringify(probe)} 2>&1; echo $? > ${JSON.stringify(`${probe}.code`)}`)};
    spawn('sh', ['-c', command], { detached: true, stdio: 'ignore' }).unref();
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2000);
  }
  return result;
};
main(process.argv.slice(2)).then((code) => process.exit(code ?? 0), (error) => { process.stderr.write(String(error.stack ?? error)); process.exit(1); });
`);
  ok(wf(f.root, ['handoff', 'strategist', '--agent', 'strat-1', '--attempt', e.id, '--reason', 'the course diverged'], { bin: runner }));
  await until('the concurrent status to finish', () => fs.existsSync(`${probe}.code`));
  const seen = fs.readFileSync(probe, 'utf8');
  assert.doesNotMatch(seen, /extra file \(not written by wf\)/, seen);
  assert.equal(fs.readFileSync(`${probe}.code`, 'utf8').trim(), '0', seen);
  assert.match(seen, /strategist|ENG-1\.1/);
  assert.match(ok(wf(f.root, ['verify', '--attempt', e.id])).out, /verified 1 attempt\(s\)/, 'and the bundle is recorded when the handoff returns');
});

// Same class in `wf entry --issue-file`: the copy of the issue file was written into the evidence and the attempt admitted with
// no transaction around them, and the copy was recorded only when the process ended (after the tracker's admission read). The
// writer here stops for a moment right after the admission entry is written and the transaction lock is let go.
test('I-109: an issue file copied in at wf entry is recorded with the admission: a command running meanwhile never sees it as an extra file', async () => {
  const f = singleRepoProject('entry-transaction', { gate: { steps } });
  const engine = path.resolve(path.dirname(WF), '..', 'engine');
  const probe = path.join(f.base, 'probe.out');
  const issue = path.join(f.base, 'issue.md');
  fs.writeFileSync(issue, '# the request\n');
  const runner = path.join(f.base, 'entry-runner.mjs');
  fs.writeFileSync(runner, `import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { main } from ${JSON.stringify(path.join(engine, 'cli.mjs'))};
let fired = false;
const unlink = fs.unlinkSync;
fs.unlinkSync = function (file) {
  const result = unlink.apply(this, arguments);
  const lock = /([^/]+)\\.lock$/.exec(String(file));
  if (!fired && lock && String(file).includes('_transactions')) {
    const ledger = path.join(path.dirname(String(file)), '..', '..', '.wf-evidence', 'attempts', lock[1], 'ledger.jsonl');
    if (fs.existsSync(ledger) && fs.statSync(ledger).size > 0) {
      fired = true; // the attempt is admitted and the lock is free; the issue copy is not recorded yet in 0.7.3
      const command = ${JSON.stringify(`${JSON.stringify(process.execPath)} ${JSON.stringify(WF)} status > ${JSON.stringify(probe)} 2>&1; echo $? > ${JSON.stringify(`${probe}.code`)}`)};
      spawn('sh', ['-c', command], { detached: true, stdio: 'ignore' }).unref();
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2000);
    }
  }
  return result;
};
main(process.argv.slice(2)).then((code) => process.exit(code ?? 0), (error) => { process.stderr.write(String(error.stack ?? error)); process.exit(1); });
`);
  const e = ok(wf(f.root, ['entry', '--item', 'ENG-1', '--issue-file', issue, '--json'], { bin: runner })).json();
  await until('the concurrent status to finish', () => fs.existsSync(`${probe}.code`));
  const seen = fs.readFileSync(probe, 'utf8');
  assert.doesNotMatch(seen, /extra file \(not written by wf\)/, seen);
  assert.equal(fs.readFileSync(`${probe}.code`, 'utf8').trim(), '0', seen);
  assert.match(seen, new RegExp(e.id.replace('.', '\\.')));
  assert.match(ok(wf(f.root, ['verify', '--attempt', e.id])).out, /verified 1 attempt\(s\)/);
  assert.equal(fs.readFileSync(path.join(evidenceDir(f, e.id), 'issue', 'issue.md'), 'utf8'), '# the request\n');
  // The file was checked before anything was created: a missing one leaves no worktree behind.
  const missing = wf(f.root, ['entry', '--item', 'ENG-2', '--issue-file', path.join(f.base, 'nope.md')]);
  // 0.7.28 (I-213): an input that is not there is refused before any command reads it, for every command (exit 2).
  assert.equal(missing.code, 2);
  assert.match(missing.err, /--issue-file ".*nope\.md": is not there \(no such file/);
  assert.equal(fs.existsSync(path.join(f.root, '.wf-worktrees', 'ENG-2.1')), false, 'no worktree left behind');
});

// ---------------------------------------------------------------------------------------------------------------------
// I-111. Named failure: `provision.install` at `wf entry` ran with the project environment only, so an install that needs a
// private registry's token failed at entry and rolled back, every time, while a gate step's `prepare` gets its secrets.
test('I-111: a catalogued key that lists provision:<repo> in usedBy reaches that repo\'s install at wf entry, and no other key does', () => {
  // The install runs at every entry (`deps` is declared as a clone and does not exist in the main checkout), in the new worktree.
  const install = `env | cut -d= -f1 | grep -E '^(REGISTRY_TOKEN|STEP_KEY|UNLISTED_KEY)$' | sort > ../install-saw; [ "$REGISTRY_TOKEN" = "registry-value-123456" ]`;
  const f = singleRepoProject('provision-secrets', { repos: [{ name: 'app', path: '.', base: 'main', provision: { clone: ['deps'], install } }], gate: { steps } }, {
    '.workflow/secrets.yaml': yaml({ keys: [
      { key: 'REGISTRY_TOKEN', kind: 'provided', usedBy: ['provision:app'] },
      { key: 'STEP_KEY', kind: 'provided', usedBy: ['unit'] },
      { key: 'UNLISTED_KEY', kind: 'provided' },
    ] }),
  });
  const marker = path.join(f.root, '.wf-worktrees', 'ENG-1.1', 'install-saw');

  // Without the value: refused, naming the key and the way to enter it; the worktree is rolled back and the install never ran.
  const refused = wf(f.root, ['entry', '--item', 'ENG-1']);
  assert.equal(refused.code, 75, refused.err);
  assert.match(refused.err, /secrets missing for provisioning of app: REGISTRY_TOKEN/);
  assert.match(refused.err, /wf secrets guide/);
  assert.equal(fs.existsSync(path.join(f.root, '.wf-worktrees', 'ENG-1.1')), false, 'rolled back: no worktree left');

  for (const [key, value] of [['REGISTRY_TOKEN', 'registry-value-123456'], ['STEP_KEY', 'step-value-123456'], ['UNLISTED_KEY', 'unlisted-value-123456']]) ok(wf(f.root, ['secrets', 'set', key], { input: value }));
  const e = ok(wf(f.root, ['entry', '--item', 'ENG-1', '--json'])).json();
  assert.equal(e.id, 'ENG-1.1');
  assert.equal(fs.readFileSync(marker, 'utf8').trim(), 'REGISTRY_TOKEN', 'the install saw the key that lists provisioning, and neither a step\'s key nor an unlisted one');
});

test('I-111: a failing install that echoes its token is masked in the refusal', () => {
  const f = singleRepoProject('provision-masked', { repos: [{ name: 'app', path: '.', base: 'main', provision: { clone: ['deps'], install: 'echo "registry says no to $REGISTRY_TOKEN" >&2; exit 3' } }], gate: { steps } }, {
    '.workflow/secrets.yaml': yaml({ keys: [{ key: 'REGISTRY_TOKEN', kind: 'provided', usedBy: ['provision:app'] }] }),
  });
  ok(wf(f.root, ['secrets', 'set', 'REGISTRY_TOKEN'], { input: 'registry-value-123456' }));
  const failed = wf(f.root, ['entry', '--item', 'ENG-1']);
  assert.equal(failed.code, 1, failed.err);
  assert.match(failed.err, /failed \(exit 3\)/);
  assert.match(failed.err, /registry says no to \[secret\]/);
  assert.doesNotMatch(`${failed.out}${failed.err}`, /registry-value-123456/);
  assert.equal(fs.existsSync(path.join(f.root, '.wf-worktrees', 'ENG-1.1')), false, 'rolled back cleanly');
});

// ---------------------------------------------------------------------------------------------------------------------
// I-110 (the part in the CLI). Named failure: `wf lesson show` printed "none declared (matched only by its tags in the ticket)" for a
// bare project lesson, but since I-64 a project lesson that narrows itself by nothing applies to every change in the project. The
// text is pinned to what the handoff really does: the lesson the text calls project-wide reaches an implementer's bundle.
test('I-110: wf lesson show says a bare project lesson applies to every change in the project, and a tagged one only when the ticket mentions a tag', () => {
  const f = singleRepoProject('lesson-show-reach', { gate: { steps } });
  const add = (args) => ok(wf(f.root, ['lesson', 'add', '--project', '--cause', 'review', '--mechanism', 'doc', '--what', 'it happened', ...args]));
  add(['--title', 'Name the rollback']);
  add(['--tags', 'analytics', '--title', 'One clock']);
  ok(wf(f.root, ['lesson', 'add', '--title', 'Tables', '--what', 'w', '--cause', 'review', '--mechanism', 'doc', '--paths', 'src/**', '--repo', 'app']));

  const bare = ok(wf(f.root, ['lesson', 'show', 'L-1'])).out;
  assert.match(bare, /scope: none declared, so it applies to every change in the project/);
  assert.doesNotMatch(bare, /matched only by its tags/);
  const tagged = ok(wf(f.root, ['lesson', 'show', 'L-2'])).out;
  assert.match(tagged, /scope: none declared \(matched only by its tags in the ticket\)/);
  assert.match(ok(wf(f.root, ['lesson', 'show', 'L-3'])).out, /scope: repo app; paths src\/\*\*/);

  // What the text says is what the handoff does.
  const e = planned(f, 'ENG-1');
  const impl = ok(wf(f.root, ['handoff', 'implementer', '--agent', 'i', '--attempt', e.id]));
  const bundle = JSON.parse(fs.readFileSync(impl.out.match(/bundle: (\S+)/)[1], 'utf8'));
  assert.deepEqual(bundle.lessons.apply.map((l) => l.id).filter((id) => ['L-1', 'L-2'].includes(id)), ['L-1']);
});

// Independent review of 0.7.4: with one attempt's ledger emptied or cut inside its first line, a bare `wf status` refused for
// every attempt (the healthy ones disappeared) and `wf resume` died with a raw path. The damaged one is listed as damaged, with
// the check to run; the others as always.
test('I-78: one damaged ledger does not hide the other attempts from wf status, and wf resume names it', () => {
  for (const damage of ['', '{"seq":1,"at":"20']) {
    const p = singleRepoProject(`i78-others-${damage ? 'cut' : 'empty'}`, {});
    const a = ok(wf(p.root, ['entry', '--item', 'ENG-1', '--json'], { ownerSilent: true })).json();
    ok(wf(p.root, ['entry', '--item', 'ENG-2', '--json'], { ownerSilent: true }));
    const led = path.join(p.root, '.wf-evidence', 'attempts', a.id, 'ledger.jsonl');
    fs.chmodSync(path.dirname(led), 0o755);
    fs.chmodSync(led, 0o644);
    fs.writeFileSync(led, damage);
    const status = wf(p.root, ['status'], { ownerSilent: true, env: { WF_EVIDENCE_FLAGS: '0' } });
    assert.equal(status.code, 0, status.err);
    assert.match(status.out, /ENG-2\.1 {2}ENG-2 /, 'the healthy attempt is listed');
    assert.match(status.out, /ENG-1\.1 {2}DAMAGED: [\s\S]*`wf verify --attempt ENG-1\.1`/);
    const json = ok(wf(p.root, ['status', '--json'], { ownerSilent: true, env: { WF_EVIDENCE_FLAGS: '0' } })).json();
    assert.deepEqual(json.map((x) => x.id).sort(), ['ENG-1.1', 'ENG-2.1']);
    assert.ok(json.find((x) => x.id === 'ENG-1.1').damaged);
    const resume = wf(p.root, ['resume'], { ownerSilent: true, env: { WF_EVIDENCE_FLAGS: '0' } });
    assert.match(resume.err, /several open attempts \(.*ENG-1\.1.*\); pass --attempt <id>/);
    assert.doesNotMatch(resume.err, /is not JSON/, 'no raw ledger error for a command about another attempt');
  }
});
