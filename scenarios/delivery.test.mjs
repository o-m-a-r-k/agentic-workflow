import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { closureFile, commitIn, criteriaFile, goodClosure, makeRepo, ok, postedComment, rawReadback, sh, singleRepoProject, state, summaryFile, tmp, toAccepted, wf, write, yaml } from './helpers.mjs';

const steps = [{ id: 'unit', repo: 'app', run: 'true', inputs: ['src/**'] }];

function pushToRemote(base, remote, files, msg) {
  const other = path.join(base, `other-${Date.now()}`);
  sh(base, `git clone -q ${JSON.stringify(remote)} ${JSON.stringify(other)}`);
  sh(other, 'git config user.email o@example.test && git config user.name o');
  commitIn(other, files, msg);
  sh(other, 'git push -q origin main');
}

test('base moved without touching the change: merged, gate carried, delivered', () => {
  const { base, root, remote } = singleRepoProject('advance-ok', { gate: { steps } }, { 'docs/readme.md': 'r\n' });
  const { id } = toAccepted(root, base, { item: 'ENG-30' });
  pushToRemote(base, remote, { 'docs/readme.md': 'someone else\n' }, 'unrelated');
  ok(wf(root, ['deliver', '--attempt', id]));
  assert.equal(sh(base, `git --git-dir=${remote} show main:src/a.txt`), 'b');
  assert.equal(sh(base, `git --git-dir=${remote} show main:docs/readme.md`), 'someone else');
  const s = state(root, id);
  assert.ok(s.gates.some((g) => g.carriedFrom), 'gate carried to the merged tree');
});

test('base moved and touches the change: gate reopens, rerun, then delivers', () => {
  const { base, root, remote } = singleRepoProject('advance-touch', { gate: { steps } }, { 'src/b.txt': 'b0\n' });
  const { id } = toAccepted(root, base, { item: 'ENG-31', change: { 'src/a.txt': 'mine\n', 'src/b.txt': 'mine too\n' } });
  pushToRemote(base, remote, { 'src/c.txt': 'new file\n', 'src/b.txt': 'b0\n', 'package.json': '{}\n' }, 'infra');
  // Configure package.json as shared infrastructure in a second project variant is covered by sharedInfra; here overlap is none, infra none.
  const d1 = wf(root, ['deliver', '--attempt', id]);
  assert.equal(d1.code, 0, d1.err);
  const p2 = singleRepoProject('advance-overlap', { repos: [{ name: 'app', path: '.', base: 'main', packages: [{ path: '.', sharedInfra: ['package.json'] }] }], gate: { steps } });
  const a2 = toAccepted(p2.root, p2.base, { item: 'ENG-32' });
  pushToRemote(p2.base, p2.remote, { 'package.json': '{"name":"x"}\n' }, 'deps');
  const d2 = wf(p2.root, ['deliver', '--attempt', a2.id]);
  assert.equal(d2.code, 75);
  assert.match(d2.err, /touches package\.json/);
  ok(wf(p2.root, ['gate', '--attempt', a2.id]));
  ok(wf(p2.root, ['deliver', '--attempt', a2.id]));
  assert.equal(sh(p2.base, `git --git-dir=${p2.remote} show main:package.json`), '{"name":"x"}');
});

function multiRepo(name, extra = {}) {
  const base = tmp(name);
  const root = path.join(base, 'ws');
  fs.mkdirSync(root);
  const cfg = {
    version: 1,
    enabled: true,
    name,
    adapterRepo: 'api',
    repos: [{ name: 'api', path: 'api', base: 'main' }, { name: 'web', path: 'web', base: 'main' }],
    lanes: ['quick', 'standard', 'batch'],
    components: [
      { id: 'api', kind: 'service', repo: 'api', provides: [{ contract: 'http', spec: 'openapi.json' }] },
      { id: 'web', kind: 'web', repo: 'web', dependsOn: [{ component: 'api', via: 'http', contract: 'api/openapi.json' }] },
    ],
    gate: {
      steps: [
        { id: 'api-unit', repo: 'api', run: 'true', inputs: ['src/**', 'openapi.json'] },
        { id: 'web-contract', repo: 'web', run: 'true', inputs: ['src/**'], when: { paths: ['src/**'] } },
      ],
    },
    ...extra,
  };
  makeRepo(path.join(root, 'api'), { '.workflow/project.yaml': yaml(cfg), 'openapi.json': '{}\n', 'src/a.txt': 'a\n' });
  makeRepo(path.join(root, 'web'), { 'src/w.txt': 'w\n' });
  fs.symlinkSync(path.join('api', '.workflow'), path.join(root, '.workflow'));
  return { base, root };
}

test('a changed contract pulls dependents into the gate; delivery goes providers first; partial delivery resumes', () => {
  const { base, root } = multiRepo('topology');
  const e = ok(wf(root, ['entry', '--item', 'ENG-33', '--owner', 'o', '--json'])).json();
  ok(wf(root, ['handoff', 'planner', '--agent', 'p', '--attempt', e.id]));
  ok(wf(root, ['plan', '--file', criteriaFile(base), '--attempt', e.id]));
  ok(wf(root, ['handoff', 'implementer', '--agent', 'i', '--attempt', e.id]));
  commitIn(e.repos.api.worktree, { 'openapi.json': '{"paths":{}}\n' });
  commitIn(e.repos.web.worktree, { 'README.md': 'docs only\n' });
  const g = JSON.parse(wf(root, ['gate', '--attempt', e.id, '--json']).out);
  assert.deepEqual(g.impact.dependents, ['web']);
  assert.equal(g.steps.find((s) => s.id === 'web-contract').status, 'passed', 'dependent step ran although no web src changed');
  ok(wf(root, ['handoff', 'reviewer', '--agent', 'r', '--attempt', e.id]));
  const bundle = JSON.parse(fs.readFileSync(JSON.parse(wf(root, ['resume', '--attempt', e.id, '--json']).out).handoffs.at(-1).bundle, 'utf8'));
  assert.ok(bundle.impact.crossed.some((c) => c.from === 'web' && c.to === 'api'), 'reviewer is told which contract is crossed');
  ok(wf(root, ['review', '--closure', closureFile(base, goodClosure('r')), '--attempt', e.id]));
  ok(wf(root, ['accept', '--attempt', e.id]));
  // Break the web remote so delivery stops after api.
  const webRemote = `${path.join(root, 'web')}.origin.git`;
  fs.renameSync(webRemote, `${webRemote}.moved`);
  const d1 = wf(root, ['deliver', '--attempt', e.id]);
  assert.notEqual(d1.code, 0);
  let s = state(root, e.id);
  assert.ok(s.delivery.repos.api, 'api (the provider) delivered first');
  assert.equal(s.delivery.repos.web, undefined);
  fs.renameSync(`${webRemote}.moved`, webRemote);
  ok(wf(root, ['deliver', '--attempt', e.id]));
  s = state(root, e.id);
  assert.ok(s.delivery.repos.web);
  assert.equal(s.phase, 'done');
});

test('batch: members defer heavy steps; the batch runs them once and delivers everyone', () => {
  const heavy = [{ id: 'unit', repo: 'app', run: 'true', inputs: ['src/**'] }, { id: 'e2e', repo: 'app', run: 'echo heavy >> "$WF_ROOT/../heavy.log"', tier: 'heavy' }];
  const { base, root, remote } = singleRepoProject('batch', { gate: { steps: heavy } }, { 'src/b.txt': 'b\n' });
  const m1 = toAccepted(root, base, { item: 'ENG-40', change: { 'src/a.txt': 'one\n' }, extraEntry: ['--defer-heavy'] });
  const m2 = toAccepted(root, base, { item: 'ENG-41', change: { 'src/b.txt': 'two\n' }, extraEntry: ['--defer-heavy'] });
  assert.equal(fs.existsSync(path.join(root, '..', 'heavy.log')), false, 'members did not run heavy steps');
  assert.match(wf(root, ['deliver', '--attempt', m1.id]).err, /deferred its heavy steps/);
  const b = ok(wf(root, ['batch', 'create', '--members', `${m1.id},${m2.id}`, '--owner', 'o', '--json'])).json();
  assert.equal(wf(root, ['deliver', '--attempt', m1.id]).code, 75, 'a member cannot deliver alone');
  ok(wf(root, ['gate', '--attempt', b.id]));
  assert.equal(fs.readFileSync(path.join(root, '..', 'heavy.log'), 'utf8').trim(), 'heavy', 'heavy step ran once, in the batch');
  ok(wf(root, ['handoff', 'reviewer', '--agent', 'rb', '--attempt', b.id]));
  ok(wf(root, ['review', '--closure', closureFile(base, { reviewer: 'rb', findings: [], criteria: [{ id: 'B1', evidence: { kind: 'output', ref: 'batch gate' } }], screenshotsInspected: [] }), '--attempt', b.id]));
  ok(wf(root, ['accept', '--attempt', b.id]));
  ok(wf(root, ['deliver', '--attempt', b.id]));
  assert.equal(sh(base, `git --git-dir=${remote} show main:src/a.txt`), 'one');
  assert.equal(sh(base, `git --git-dir=${remote} show main:src/b.txt`), 'two');
  for (const m of [m1.id, m2.id]) assert.equal(state(root, m).phase, 'done');
});

test('tracker: status, comment and screenshots are verified from the readback', () => {
  const visual = [{ id: 'ui', repo: 'app', run: 'mkdir -p shots && printf png > shots/home.png', artifacts: ['shots/*.png'] }];
  const { base, root } = singleRepoProject('tracker', {
    tracker: { kind: 'linear', statuses: { started: 'In Progress', delivered: 'Ready for UAT', done: 'Done' }, deliveredComment: 'uat.md' },
    gate: { steps: visual },
  }, { '.workflow/uat.md': '{id} is ready for UAT.\n\nUAT scope:\n{uatScope}\n', '.gitignore': '.wf-evidence/\n.wf-worktrees/\nshots/\n' });
  const item = 'ENG-50';
  const e = ok(wf(root, ['entry', '--item', item, '--owner', 'o', '--json'])).json();
  assert.match(ok(wf(root, ['resume', '--attempt', e.id])).out, /set status to "In Progress"/);
  const cap = (obj) => {
    const f = path.join(base, `cap-${Math.random().toString(36).slice(2)}.json`);
    fs.writeFileSync(f, JSON.stringify(obj));
    return f;
  };
  assert.equal(wf(root, ['tracker', 'record', '--event', 'admitted', '--capture', cap({ issue: { identifier: item, state: { name: 'Todo' } } }), '--attempt', e.id]).code, 75, 'wrong status refused');
  ok(wf(root, ['tracker', 'record', '--event', 'admitted', '--capture', cap({ issue: { identifier: item, description: 'Show the new text on the home screen.', state: { name: 'In Progress' } } }), '--attempt', e.id]));
  ok(wf(root, ['handoff', 'planner', '--agent', 'p', '--attempt', e.id]));
  ok(wf(root, ['plan', '--file', criteriaFile(base), '--attempt', e.id]));
  ok(wf(root, ['handoff', 'implementer', '--agent', 'i', '--attempt', e.id]));
  // Re-reading an unchanged issue gives the same bytes as the admission read: accepted for `implementing`.
  ok(wf(root, ['tracker', 'record', '--event', 'implementing', '--capture', cap({ issue: { identifier: item, description: 'Show the new text on the home screen.', state: { name: 'In Progress' } } }), '--attempt', e.id]));
  commitIn(e.repos.app.worktree, { 'src/a.txt': 'ui\n' });
  const g = JSON.parse(ok(wf(root, ['gate', '--attempt', e.id, '--json'])).out);
  const shot = g.steps[0].artifacts[0];
  ok(wf(root, ['handoff', 'reviewer', '--agent', 'r', '--attempt', e.id]));
  ok(wf(root, ['review', '--closure', closureFile(base, goodClosure('r')), '--attempt', e.id]));
  assert.match(wf(root, ['accept', '--attempt', e.id]).err, /not inspected/, 'reviewer must inspect every screenshot');
  ok(wf(root, ['review', '--closure', closureFile(base, goodClosure('r', { screenshotsInspected: [shot.sha256] })), '--attempt', e.id]));
  ok(wf(root, ['accept', '--attempt', e.id]));
  assert.match(wf(root, ['deliver', '--attempt', e.id]).err, /needs the owner's summary first[\s\S]*--summary-file/, 'the delivered comment needs a summary before anything is pushed');
  assert.match(wf(root, ['deliver', '--attempt', e.id, '--summary-file', summaryFile(base, '- Not user visible: refactor')]).err, /summary refused[\s\S]*not user visible/);
  const d = ok(wf(root, ['deliver', '--attempt', e.id, '--summary-file', summaryFile(base)]));
  // The owner is told exactly which files to show and attach, with a proposed caption for each.
  assert.match(d.out, /SHOW TO OWNER \(1 delivered screenshot\(s\) for ENG-50\)/);
  assert.match(d.out, /attach as: home\.png/);
  assert.match(d.out, /proposed caption: Home/);
  assert.match(d.out, /1\. .*\.wf-worktrees\/_exports\/ENG-50\.1\/screenshots-\w+\/home\.png\n/, 'the owner views and uploads the exported copy, never the evidence file');
  assert.match(ok(wf(root, ['resume', '--attempt', e.id])).out, /next: show the owner, in the chat, each of the 1 delivered screenshot/);
  const after = new Date(Date.now() + 1000).toISOString();
  const asset = 'https://uploads.linear.app/x/y/home';
  const upload = (subtitle) => ({ id: 'a1', title: 'home.png', subtitle, url: asset });
  const readback = (comments, attachments = [upload('Home screen showing the new text')]) => cap(rawReadback(item, 'Ready for UAT', { attachments, comments }));
  assert.match(wf(root, ['tracker', 'record', '--event', 'delivered', '--capture', readback([{ id: 'c1', body: postedComment(root, e.id, { 'home.png': asset }), createdAt: after }]), '--attempt', e.id]).err, /not shown to the owner yet/, 'the handoff waits for the owner to see the screenshots');
  const shown = (caption) => {
    const f = path.join(base, `shown-${Math.random().toString(36).slice(2)}.json`);
    fs.writeFileSync(f, JSON.stringify({ screenshots: [{ sha256: shot.sha256, caption }], anomalies: 'none seen' }));
    return f;
  };
  assert.match(wf(root, ['shown', '--file', shown('Home'), '--attempt', e.id]).err, /the engine's proposal unchanged/);
  assert.match(wf(root, ['shown', '--file', path.join(base, 'none.json'), '--attempt', e.id]).err, /ENOENT|no such file/);
  fs.writeFileSync(path.join(base, 'empty.json'), JSON.stringify({ screenshots: [] }));
  assert.match(wf(root, ['shown', '--file', path.join(base, 'empty.json'), '--attempt', e.id]).err, /home\.png .*not acknowledged/);
  ok(wf(root, ['shown', '--file', shown('Home screen showing the new text'), '--attempt', e.id]));
  const body = postedComment(root, e.id, { 'home.png': asset });
  assert.match(body, /^ENG-50 is ready for UAT\.\n\nThe home screen now shows the new text\.\n\nUAT scope:\n- a shows the new text\n\nScreenshots:\n\n\*\*1\. Home screen showing the new text\*\*\n!\[home\.png\]\(https:\/\/uploads\.linear\.app\/x\/y\/home\)\n$/, 'header, summary, user-visible UAT scope, each screenshot inline under its caption');
  const comment = [{ id: 'c1', body, createdAt: after }];
  const good = readback(comment);
  assert.match(wf(root, ['delivery', 'narrow', '--keep', shot.sha256, '--reason', 'r', '--attempt', e.id]).err, /already acknowledged with `wf shown`/, 'the set is fixed once acknowledged');
  assert.match(wf(root, ['tracker', 'record', '--event', 'delivered', '--capture', cap({ issue: { state: { name: 'Ready for UAT' } }, comments: { comments: comment, hasNextPage: false } }), '--attempt', e.id]).err, /the capture names no issue/);
  const leaky = readback([{ ...comment[0], body: `${comment[0].body}\nchanged src/app/home.tsx` }]);
  assert.match(wf(root, ['tracker', 'record', '--event', 'delivered', '--capture', leaky, '--attempt', e.id]).err, /internals: source file path/);
  const noShot = readback(comment, []);
  assert.match(wf(root, ['tracker', 'record', '--event', 'delivered', '--capture', noShot, '--attempt', e.id]).err, /1 of 1 delivered screenshot\(s\) not attached[\s\S]*home\.png .*no attachment with this title/);
  const link = readback(comment, [{ id: 'a1', title: 'home.png', url: 'https://example.test/home.png' }]);
  assert.match(wf(root, ['tracker', 'record', '--event', 'delivered', '--capture', link, '--attempt', e.id]).err, /home\.png .*attached as a link, not an uploaded file/);
  const earlier = readback(comment, [upload(null)]);
  assert.match(wf(root, ['tracker', 'record', '--event', 'delivered', '--capture', earlier, '--attempt', e.id]).err, /uploaded, but no attachment of it has the subtitle "Home screen showing the new text"/, 'an earlier upload with the same name does not count');
  ok(wf(root, ['tracker', 'record', '--event', 'delivered', '--capture', good, '--attempt', e.id]));
  const s = state(root, e.id);
  assert.equal(s.phase, 'done');
  assert.equal(s.delivery.shown.screenshots[0].caption, 'Home screen showing the new text');
  assert.deepEqual(s.tracker.done.at(-1).attachments.map((a) => a.title), ['home.png']);
});

test('wf stop pauses a running gate and finished steps are kept', async () => {
  const slow = [{ id: 'fast', repo: 'app', run: 'true', inputs: ['src/**'] }, { id: 'slow', repo: 'app', run: 'sleep 20', inputs: ['src/**'] }];
  const { base, root } = singleRepoProject('stop', { gate: { steps: slow } });
  const e = ok(wf(root, ['entry', '--item', 'ENG-60', '--owner', 'o', '--json'])).json();
  ok(wf(root, ['handoff', 'planner', '--agent', 'p', '--attempt', e.id]));
  ok(wf(root, ['plan', '--file', criteriaFile(base), '--attempt', e.id]));
  ok(wf(root, ['handoff', 'implementer', '--agent', 'i', '--attempt', e.id]));
  commitIn(e.repos.app.worktree, { 'src/a.txt': 's\n' });
  const { spawn } = await import('node:child_process');
  const { WF } = await import('./helpers.mjs');
  const env = { ...process.env, WF_CONFIG_HOME: path.join(root, '..', '.wfhome') };
  delete env.CLAUDE_CODE_SESSION_ID;
  const child = spawn(process.execPath, [WF, 'gate', '--attempt', e.id], { cwd: root, env, stdio: 'ignore' });
  const lock = path.join(root, '.wf-evidence', 'attempts', e.id, 'gate', 'gate.lock');
  // Named failure (0.4.5, Linux as root under full-suite load): the gate creates its lock with O_EXCL and writes the JSON
  // in a second call, so the lock can be read empty; JSON.parse threw and failed the test. An unreadable lock is "not
  // ready yet", as the engine's own reader treats it (engine/gate.mjs acquireGateLock).
  const ready = () => {
    try {
      return JSON.parse(fs.readFileSync(lock, 'utf8')).children.length >= 2;
    } catch {
      return false;
    }
  };
  for (let i = 0; i < 100 && !ready(); i++) await new Promise((r) => setTimeout(r, 100));
  ok(wf(root, ['stop', '--reason', 'need the machine', '--attempt', e.id]));
  const code = await new Promise((r) => child.on('exit', r));
  assert.equal(code, 1);
  const s = state(root, e.id);
  assert.equal(s.lastGate.status, 'stopped');
  assert.equal(s.lastGate.steps.find((x) => x.id === 'fast').status, 'passed');
  assert.match(ok(wf(root, ['resume', '--attempt', e.id])).out, /gate stopped \(need the machine\)/);
});

test('a project delivery adapter (merge requests) waits for merge, then reads back', () => {
  const adapter = `
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
const flag = (root) => root + '/../merged.flag';
export default {
  integrate(ctx) {
    execFileSync('git', ['push', '-q', 'origin', 'HEAD:refs/heads/' + ctx.branch], { cwd: ctx.worktree });
    return { url: 'https://git.example.test/mr/1', branch: ctx.branch };
  },
  observe(ctx) {
    if (!fs.existsSync(flag(ctx.root))) return { state: 'awaiting-merge' };
    execFileSync('git', ['push', '-q', 'origin', 'HEAD:refs/heads/main'], { cwd: ctx.worktree });
    return { state: 'integrated' };
  },
  readback(ctx) {
    execFileSync('git', ['fetch', '-q', 'origin', 'main'], { cwd: ctx.worktree });
    try { execFileSync('git', ['merge-base', '--is-ancestor', 'HEAD', 'origin/main'], { cwd: ctx.worktree }); return { ok: true }; } catch { return { ok: false }; }
  },
};`;
  const { base, root, remote } = singleRepoProject('mr', {
    delivery: { kind: './delivery/mr.mjs' },
    tracker: { kind: 'linear', statuses: { started: 'In Progress', inReview: 'In Review', delivered: 'Ready for UAT' } },
    gate: { steps },
  }, { '.workflow/delivery/mr.mjs': adapter });
  const { id } = toAccepted(root, base, { item: 'ENG-70' });
  const d1 = ok(wf(root, ['deliver', '--attempt', id]));
  assert.match(d1.out, /awaiting-merge \(https:\/\/git\.example\.test\/mr\/1\)/);
  assert.ok(state(root, id).tracker.pending.some((a) => a.event === 'integrating' && a.status === 'In Review'), 'tracker asked to move the ticket to In Review');
  fs.writeFileSync(path.join(root, '..', 'merged.flag'), '');
  ok(wf(root, ['deliver', '--attempt', id]));
  assert.equal(sh(base, `git --git-dir=${remote} show main:src/a.txt`), 'b');
  assert.equal(state(root, id).phase, 'handoff-pending');
});

// Named failure (0.4.5, delta reviews of 40da633 and b28681a): every adapter state but `integrated` took the path of a
// pending merge, so `wf deliver` exited 0 and a rejected delivery, a failed CI, a typo or no state at all read as
// success. Only `awaiting-merge` and `ci-running` wait (exit 0); `rejected`, `ci-failed` and any other value refuse.
test('a delivery adapter that reports rejected, ci-failed or an unknown state refuses; awaiting-merge and ci-running wait with exit 0', () => {
  const adapter = `
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
export default {
  integrate(ctx) {
    execFileSync('git', ['push', '-q', '-f', 'origin', 'HEAD:refs/heads/' + ctx.branch], { cwd: ctx.worktree });
    return { url: 'https://git.example.test/mr/2', branch: ctx.branch };
  },
  observe(ctx) {
    const st = fs.readFileSync(ctx.root + '/../observe.state', 'utf8').trim();
    return st === '(none)' ? { evidence: 'pipeline 7' } : { state: st, evidence: 'pipeline 7' };
  },
  readback() { return { ok: true }; },
};`;
  const { base, root } = singleRepoProject('mr-states', { delivery: { kind: './delivery/mr.mjs' }, gate: { steps } }, { '.workflow/delivery/mr.mjs': adapter });
  const { id } = toAccepted(root, base, { item: 'ENG-71' });
  const say = (st) => fs.writeFileSync(path.join(root, '..', 'observe.state'), st);
  for (const st of ['awaiting-merge', 'ci-running']) {
    say(st);
    const w = wf(root, ['deliver', '--attempt', id]);
    assert.equal(w.code, 0, w.err);
    assert.match(w.out, new RegExp(`${st} \\(https://git\\.example\\.test/mr/2\\)\\. Run \`wf deliver\` again once it is merged\\.`));
  }
  // Delta review of b28681a: only the pending states wait. An unknown state, a typo or no state at all refuses too.
  for (const st of ['failed', 'ci_failed', '(none)']) {
    say(st);
    const r = wf(root, ['deliver', '--attempt', id]);
    assert.notEqual(r.code, 0, st);
    assert.match(r.err, new RegExp(`not delivered: app: the delivery adapter reported ${st === '(none)' ? 'no state' : `an unknown state "${st}"`}; it must report one of integrated, awaiting-merge, ci-running, ci-failed, rejected`), st);
    assert.equal(state(root, id).delivery.completedAt, null, `${st}: nothing delivered`);
  }
  for (const st of ['rejected', 'ci-failed']) {
    say(st);
    const r = wf(root, ['deliver', '--attempt', id]);
    assert.notEqual(r.code, 0, st);
    assert.match(r.err, new RegExp(`not delivered: app: the delivery adapter reports ${st} \\(https://git\\.example\\.test/mr/2\\)`), st);
    assert.match(r.err, st === 'rejected' ? /the change was rejected/ : /its CI failed/);
    assert.equal(state(root, id).delivery.completedAt, null, `${st}: nothing delivered`);
  }
});

// Delta reviews of 3338382 and f250f98: the adapter is read at the attempt's base, pinned at admission, so a fixed adapter
// on the base branch does not reach the running attempt, and a shell recipe in the refusal was wrong for other lanes and
// for merged bases. The refusal states the facts and points to docs/lifecycle.md "Recovering from an adapter fault",
// whose single-repo standard-lane recipe these two scenarios follow: commit the fixed adapter, abandon, `wf entry
// --item`, `git merge --squash` the old branch and commit, then plan, gate, review and deliver. The second one runs
// `wf base merge` first.
const brokenAdapter = `export default { integrate(ctx) { return { url: 'https://git.example.test/mr/3' }; }, observe() { return { state: 'merged' }; }, readback() { return { ok: true }; } };`;
const fixedAdapter = `import { execFileSync } from 'node:child_process';
export default {
  integrate(ctx) { return { url: 'https://git.example.test/mr/3' }; },
  observe(ctx) { execFileSync('git', ['push', '-q', 'origin', 'HEAD:refs/heads/main'], { cwd: ctx.worktree }); return { state: 'integrated' }; },
  readback() { return { ok: true }; },
};`;
function recoverFromBrokenAdapter(name, { baseMerge }) {
  const { base, root, remote } = singleRepoProject(name, { delivery: { kind: './delivery/mr.mjs' }, gate: { steps } }, { '.workflow/delivery/mr.mjs': brokenAdapter, 'src/other.txt': 'o\n' });
  const e = ok(wf(root, ['entry', '--item', 'ENG-72', '--owner', 'owner-1', '--json'])).json();
  const id = e.id;
  ok(wf(root, ['handoff', 'planner', '--agent', 'plan-1', '--attempt', id, '--owner', 'owner-1']));
  ok(wf(root, ['plan', '--file', criteriaFile(base), '--attempt', id, '--owner', 'owner-1']));
  ok(wf(root, ['handoff', 'implementer', '--agent', 'impl-1', '--attempt', id, '--owner', 'owner-1']));
  commitIn(e.repos.app.worktree, { 'src/a.txt': 'b\n' });
  if (baseMerge) {
    // The base advances with an unrelated change, and the attempt merges it in.
    sh(root, "printf 'o2\\n' > src/other.txt && git commit -qam 'unrelated base change' && git push -q origin main");
    ok(wf(root, ['base', 'merge', '--attempt', id]));
  }
  ok(wf(root, ['gate', '--attempt', id]));
  ok(wf(root, ['handoff', 'reviewer', '--agent', 'rev-1', '--attempt', id, '--owner', 'owner-1']));
  ok(wf(root, ['review', '--closure', closureFile(base, goodClosure('rev-1')), '--attempt', id]));
  ok(wf(root, ['accept', '--attempt', id, '--owner', 'owner-1']));
  const r = wf(root, ['deliver', '--attempt', id]);
  assert.notEqual(r.code, 0);
  assert.match(r.err, /the delivery adapter reported an unknown state "merged"/);
  assert.match(r.err, /this attempt is pinned to the delivery adapter as of its admission, so fixing the adapter on the base branch does not change this attempt; the adapter must report one of the documented states, and the owner decides the recovery: see docs\/lifecycle\.md, "Recovering from an adapter fault"/);
  assert.doesNotMatch(r.err, /cherry-pick|abandon|wf\/ENG-72|[0-9a-f]{10}\.\./, 'no recipe, branch name or hash range in the refusal');
  // A fix committed on the base branch alone does not reach this attempt: the same refusal.
  fs.writeFileSync(path.join(root, '.workflow', 'delivery', 'mr.mjs'), fixedAdapter);
  sh(root, 'git add -A && git commit -qm "fix the delivery adapter" && git push -q origin main');
  assert.match(wf(root, ['deliver', '--attempt', id]).err, /reported an unknown state "merged"/);
  // The documented recipe. First the delivery record: `wf abandon` accepts the attempt only while no repo is recorded.
  assert.deepEqual(ok(wf(root, ['status', '--attempt', id, '--json'])).json()[0].delivery.repos, {});
  ok(wf(root, ['abandon', '--reason', 'the delivery adapter was broken', '--attempt', id]));
  const e2 = ok(wf(root, ['entry', '--item', 'ENG-72', '--owner', 'owner-1', '--json'])).json();
  sh(e2.repos.app.worktree, `git merge --squash wf/${id} && git commit -qm "ENG-72: the change from ${id}"`);
  ok(wf(root, ['handoff', 'planner', '--agent', 'plan-2', '--attempt', e2.id, '--owner', 'owner-1']));
  ok(wf(root, ['plan', '--file', criteriaFile(base), '--attempt', e2.id, '--owner', 'owner-1']));
  ok(wf(root, ['handoff', 'implementer', '--agent', 'impl-2', '--attempt', e2.id, '--owner', 'owner-1']));
  ok(wf(root, ['gate', '--attempt', e2.id]));
  ok(wf(root, ['handoff', 'reviewer', '--agent', 'rev-2', '--attempt', e2.id, '--owner', 'owner-1']));
  ok(wf(root, ['review', '--closure', closureFile(base, goodClosure('rev-2')), '--attempt', e2.id]));
  ok(wf(root, ['accept', '--attempt', e2.id, '--owner', 'owner-1']));
  ok(wf(root, ['deliver', '--attempt', e2.id]));
  assert.ok(state(root, e2.id).delivery.completedAt, 'delivered');
  assert.equal(sh(base, `git --git-dir=${remote} show main:src/a.txt`), 'b');
  if (baseMerge) assert.equal(sh(base, `git --git-dir=${remote} show main:src/other.txt`), 'o2');
}

test('a broken delivery adapter: the refusal states the facts, and the documented recovery delivers', () => {
  recoverFromBrokenAdapter('mr-broken', { baseMerge: false });
});

test('a broken delivery adapter after `wf base merge`: the documented recovery (merge --squash) still delivers', () => {
  recoverFromBrokenAdapter('mr-broken-merged', { baseMerge: true });
});

test('a step that reads another repo (alsoInputs) reruns when that repo changes, and always runs when its tree cannot be read', () => {
  const e2e = 'cat "$WF_ROOT/.wf-worktrees/$WF_ATTEMPT/web/src/w.txt" && ! grep -q bad "$WF_ROOT/.wf-worktrees/$WF_ATTEMPT/web/src/w.txt"';
  const gate = {
    steps: [
      { id: 'api-unit', repo: 'api', run: 'true', inputs: ['src/**'] },
      { id: 'api-e2e', repo: 'api', run: e2e, inputs: ['src/**'], alsoInputs: ['web'] },
    ],
  };
  const { base, root } = multiRepo('also-inputs', { gate });
  const e = ok(wf(root, ['entry', '--item', 'ENG-38', '--owner', 'o', '--json'])).json();
  ok(wf(root, ['handoff', 'planner', '--agent', 'p', '--attempt', e.id]));
  ok(wf(root, ['plan', '--file', criteriaFile(base), '--attempt', e.id]));
  ok(wf(root, ['handoff', 'implementer', '--agent', 'i', '--attempt', e.id]));
  commitIn(e.repos.api.worktree, { 'src/a.txt': 'api change\n' });
  ok(wf(root, ['gate', '--attempt', e.id]));
  commitIn(e.repos.web.worktree, { 'src/w.txt': 'bad\n' });
  const g = JSON.parse(wf(root, ['gate', '--attempt', e.id, '--json']).out);
  const step = Object.fromEntries(g.steps.map((s) => [s.id, s]));
  assert.equal(step['api-unit'].status, 'reused', 'a step that reads only its own repo is still reused');
  assert.equal(step['api-e2e'].status, 'failed', 'the cross-repo step reran against the changed sibling instead of reusing a stale pass');
  assert.equal(g.status, 'failed');

  // Fail closed: the sibling is not in this attempt and its checkout is not a readable git tree.
  const p2 = multiRepo('also-unreadable', { gate: { steps: [{ id: 'api-e2e', repo: 'api', run: 'true', inputs: ['src/**'], alsoInputs: ['web'] }] } });
  const e2 = ok(wf(p2.root, ['entry', '--item', 'ENG-39', '--owner', 'o', '--repos', 'api', '--json'])).json();
  ok(wf(p2.root, ['handoff', 'planner', '--agent', 'p', '--attempt', e2.id]));
  ok(wf(p2.root, ['plan', '--file', criteriaFile(p2.base), '--attempt', e2.id]));
  ok(wf(p2.root, ['handoff', 'implementer', '--agent', 'i', '--attempt', e2.id]));
  commitIn(e2.repos.api.worktree, { 'src/a.txt': 'api change\n' });
  fs.renameSync(path.join(p2.root, 'web', '.git'), path.join(p2.root, 'web', '.git-away'));
  const first = JSON.parse(wf(p2.root, ['gate', '--attempt', e2.id, '--json']).out).steps.find((s) => s.id === 'api-e2e');
  const second = JSON.parse(wf(p2.root, ['gate', '--attempt', e2.id, '--json']).out).steps.find((s) => s.id === 'api-e2e');
  assert.equal(first.status, 'passed');
  assert.equal(second.status, 'passed', 'a passing step whose sibling tree is unreadable is rerun, not reused');
  assert.match(second.reason, /cannot read the tree of web/);
});
