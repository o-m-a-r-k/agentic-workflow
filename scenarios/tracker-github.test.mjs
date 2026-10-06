import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { closureFile, commitIn, criteriaFile, goodClosure, ok, singleRepoProject, state, summaryFile, tmp, wf, yaml } from './helpers.mjs';
import { seed } from './fixtures/fake-github.mjs';

// 0.4.0: GitHub Issues through `gh` (the owner's login) or the REST API (a token from `wf secrets`), against a fake
// GitHub (no network). Status is a label, screenshots are release assets, everything is read back by the engine.

const statuses = { started: 'In Progress', delivered: 'Ready for UAT', done: 'Done' };
const FIX = path.join(import.meta.dirname, 'fixtures');

function ghOnPath(base) {
  const bin = path.join(base, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, 'gh'), `#!/bin/sh\nexec "${process.execPath}" "${path.join(FIX, 'fake-gh.mjs')}" "$@"\n`, { mode: 0o755 });
  return `${bin}${path.delimiter}${process.env.PATH}`;
}

function project(name, tracker, files = {}) {
  const visual = [{ id: 'ui', repo: 'app', run: 'mkdir -p shots && printf png > shots/home.png', artifacts: ['shots/*.png'] }];
  return singleRepoProject(name, { tracker: { kind: 'github', repo: 'acme/app', statuses, deliveredComment: 'uat.md', ...tracker }, gate: { steps: visual } }, { '.gitignore': '.wf-evidence/\n.wf-worktrees/\nshots/\n', '.workflow/uat.md': '{id} is ready for UAT.\n\nUAT scope:\n{uatScope}\n', ...files });
}

// Plan, implement, gate, review, accept, deliver and show: returns the gate's screenshot.
function deliver(base, root, id, env) {
  ok(wf(root, ['handoff', 'planner', '--agent', 'p', '--attempt', id], { env }));
  ok(wf(root, ['plan', '--file', criteriaFile(base), '--attempt', id], { env }));
  ok(wf(root, ['handoff', 'implementer', '--agent', 'i', '--attempt', id], { env }));
  commitIn(state(root, id).repos.app.worktree, { 'src/a.txt': 'ui\n' });
  const g = ok(wf(root, ['gate', '--attempt', id, '--json'], { env })).json();
  ok(wf(root, ['handoff', 'reviewer', '--agent', 'r', '--attempt', id], { env }));
  ok(wf(root, ['review', '--closure', closureFile(base, goodClosure('r', { screenshotsInspected: [g.steps[0].artifacts[0].sha256] })), '--attempt', id], { env }));
  ok(wf(root, ['accept', '--attempt', id], { env }));
  ok(wf(root, ['deliver', '--attempt', id, '--summary-file', summaryFile(base)], { env }));
  const shown = path.join(base, 'shown.json');
  fs.writeFileSync(shown, JSON.stringify({ screenshots: [{ sha256: g.steps[0].artifacts[0].sha256, caption: 'Home screen with the new text' }], anomalies: 'none seen' }));
  return { shot: g.steps[0].artifacts[0], shown: ok(wf(root, ['shown', '--file', shown, '--attempt', id], { env })) };
}

function assertDelivered(db) {
  assert.deepEqual(db.issue.labels.map((l) => l.name), ['Ready for UAT'], 'one status label; the started one was removed');
  const rel = db.releases.find((r) => r.tag_name === 'wf-attachments');
  assert.ok(rel?.prerelease, 'screenshots go to one prerelease');
  assert.deepEqual(rel.assets.map((a) => [a.name, a.label, a.size]), [['GH-12--home.png', 'Home screen with the new text', 3]]);
  assert.match(db.comments.at(-1).body, /GH-12 is ready for UAT\.\n\nThe home screen now shows the new text\.[\s\S]*!\[home\.png\]\(https:\/\/github\.com\/acme\/app\/releases\/download\/wf-attachments\/GH-12--home\.png\)/);
  assert.ok(db.log.indexOf('upload GH-12--home.png') < db.log.lastIndexOf('comment'), 'uploaded before the comment that embeds it');
}

test('github via cli: the engine labels, uploads, comments and reads back through `gh`; doctor never prints the token', () => {
  const { base, root } = project('gh-cli', { via: 'cli' });
  const db = path.join(base, 'github.json');
  seed(db, { labels: ['bug'] });
  const env = { PATH: ghOnPath(base), FAKE_GH_STATE: db };
  const d = ok(wf(root, ['doctor', '--no-steps'], { env }));
  assert.match(d.out, /tracker github\/cli\n {4}verifiable: the engine calls the GitHub REST API through your `gh` login/);
  assert.doesNotMatch(`${d.out}${d.err}`, /gho_/, 'the gh token is never printed');
  const out = wf(root, ['doctor', '--no-steps'], { env: { ...env, FAKE_GH_LOGGED_OUT: '1' } });
  assert.notEqual(out.code, 0);
  assert.match(out.out, /`gh auth status` reports no login\n {4}fix: the owner runs `gh auth login` in their own terminal/);

  const e = ok(wf(root, ['entry', '--item', 'GH-12', '--owner', 'o', '--json'], { env })).json();
  assert.deepEqual(state(root, e.id).tracker.done.map((t) => [t.event, t.provenance]), [['admitted', 'engine (tracker API)']]);
  assert.deepEqual(JSON.parse(fs.readFileSync(db, 'utf8')).issue.labels.map((l) => l.name), ['bug', 'In Progress'], 'other labels are kept');
  const { shown } = deliver(base, root, e.id, env);
  assert.match(shown.out, /tracker: delivered performed through `gh` and read back; attempt closed/);
  assert.equal(state(root, e.id).phase, 'done');
  const after = JSON.parse(fs.readFileSync(db, 'utf8'));
  after.issue.labels = after.issue.labels.filter((l) => l.name !== 'bug');
  assertDelivered(after);
  assert.ok(fs.readFileSync(`${db}.argv`, 'utf8').split('\n').filter(Boolean).every((l) => !/gho_|authorization/i.test(l)), 'wf passes no token to gh');
});

async function serve(mode, file, ...args) {
  const child = spawn(process.execPath, [path.join(FIX, 'fake-github.mjs'), mode, file, ...args], { stdio: 'ignore' });
  for (let i = 0; i < 100 && !fs.existsSync(`${file}.port`); i++) await new Promise((r) => setTimeout(r, 50));
  return { url: `http://127.0.0.1:${fs.readFileSync(`${file}.port`, 'utf8')}`, stop: () => child.kill() };
}
const keys = { '.workflow/secrets.yaml': yaml({ keys: [{ key: 'GITHUB_TOKEN', kind: 'provided', required: true }] }) };
const TOKEN = 'ghp_fakeApiTokenForTests123';

test('github via api: a token from wf secrets drives the same flow; without it the actions stay pending; the token never appears', async () => {
  const db = path.join(tmp('gh-api-db'), 'github.json');
  seed(db);
  const server = await serve('serve', db, TOKEN);
  try {
    const { base, root } = project('gh-api', { via: 'api', apiUrl: server.url }, keys);
    const noKey = ok(wf(root, ['entry', '--item', 'GH-12', '--owner', 'o', '--json']));
    const id = noKey.json().id;
    assert.ok(state(root, id).tracker.pending.length, 'without the token the actions stay pending');
    ok(wf(root, ['secrets', 'set', 'GITHUB_TOKEN'], { input: 'ghp_wrongToken999' }));
    const bad = ok(wf(root, ['tracker', 'sync', '--attempt', id]));
    assert.match(bad.out, /tracker api \(admitted\) failed: GitHub API GET \/repos\/acme\/app\/issues\/12: 401 Bad credentials; the actions stay pending/);
    ok(wf(root, ['secrets', 'set', 'GITHUB_TOKEN'], { input: TOKEN }));
    assert.match(ok(wf(root, ['tracker', 'sync', '--attempt', id])).out, /tracker: admitted performed through the API and read back/);
    const { shown } = deliver(base, root, id, {});
    assert.match(shown.out, /tracker: delivered performed through the API and read back; attempt closed/);
    assertDelivered(JSON.parse(fs.readFileSync(db, 'utf8')));
    const dir = path.join(root, '.wf-evidence', 'attempts', id);
    const all = [];
    const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).forEach((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : all.push(fs.readFileSync(path.join(d, e.name)))));
    walk(dir);
    assert.ok(all.every((b) => !b.includes(TOKEN)), 'the token is in no capture, ledger entry or bundle');
    assert.ok(!ok(wf(root, ['export', '--attempt', id])).out.includes(TOKEN));
  } finally {
    server.stop();
  }
});

test('github attack: an endpoint edited in the working copy, a plain-http host, or a redirect never receives the token', async () => {
  const sinkLog = path.join(tmp('gh-sink'), 'sink.log');
  const sink = await serve('sink', sinkLog);
  const db = path.join(tmp('gh-redirect-db'), 'github.json');
  seed(db);
  const server = await serve('serve', db, TOKEN);
  try {
    // 1. apiUrl pointed at the attacker in the working copy only (an agent's edit): the committed adapter rules.
    const a = project('gh-attack-edit', { via: 'api', apiUrl: server.url }, keys);
    ok(wf(a.root, ['secrets', 'set', 'GITHUB_TOKEN'], { input: TOKEN }));
    const cfgFile = path.join(a.root, '.workflow', 'project.yaml');
    fs.writeFileSync(cfgFile, fs.readFileSync(cfgFile, 'utf8').replace(server.url, sink.url));
    const r1 = ok(wf(a.root, ['entry', '--item', 'GH-12', '--owner', 'o']));
    assert.match(r1.out, /tracker\.apiUrl in the working copy differs from the adapter at the base commit; commit it on the base branch first/);
    // 2. A committed plain-http host that is not this machine: refused before any request; doctor fails.
    const b = project('gh-attack-http', { via: 'api', apiUrl: 'http://tracker.example.test' }, keys);
    ok(wf(b.root, ['secrets', 'set', 'GITHUB_TOKEN'], { input: TOKEN }));
    assert.match(ok(wf(b.root, ['entry', '--item', 'GH-12', '--owner', 'o'])).out, /http:\/\/tracker\.example\.test: a tracker token goes only over https .*; nothing sent, the actions stay pending/);
    assert.match(wf(b.root, ['doctor', '--no-steps']).out, /✗ .*tracker\.apiUrl — http:\/\/tracker\.example\.test: a tracker token goes only over https/);
    // A committed https host other than GitHub's is honoured, and doctor says so loudly.
    const c = project('gh-attack-ghe', { via: 'api', apiUrl: 'https://ghe.example.test/api/v3' }, keys);
    assert.match(wf(c.root, ['doctor', '--no-steps']).out, /NOTICE: the github token is sent to ghe\.example\.test \(tracker\.apiUrl\), not api\.github\.com \/ uploads\.github\.com/);
    // 3. The tracker answers with a redirect to another host: not followed.
    const d = project('gh-attack-redirect', { via: 'api', apiUrl: server.url }, keys);
    ok(wf(d.root, ['secrets', 'set', 'GITHUB_TOKEN'], { input: TOKEN }));
    fs.writeFileSync(db, JSON.stringify({ ...JSON.parse(fs.readFileSync(db, 'utf8')), redirectTo: sink.url }));
    const r3 = ok(wf(d.root, ['entry', '--item', 'GH-12', '--owner', 'o']));
    assert.match(r3.out, /redirected \(302\); a request with the token never follows a redirect/);
    for (const r of [r1, r3]) assert.ok(!`${r.out}${r.err}`.includes(TOKEN));
    assert.equal(fs.existsSync(sinkLog) ? fs.readFileSync(sinkLog, 'utf8') : '', '', 'the attacker host received no request at all');
  } finally {
    sink.stop();
    server.stop();
  }
});

test('github attack: an issue title with shell syntax and a label that looks like a flag are data, never arguments', () => {
  const { base, root } = project('gh-attack-data', { via: 'cli' });
  const db = path.join(base, 'github.json');
  const pwned = path.join(base, 'pwned');
  seed(db, { title: `$(touch ${pwned})\n\`touch ${pwned}\`; touch ${pwned}`, labels: ['--hostname=evil.example.test', `In Progress\n-X DELETE`] });
  const env = { PATH: ghOnPath(base), FAKE_GH_STATE: db };
  const e = ok(wf(root, ['entry', '--item', 'GH-12', '--owner', 'o', '--json'], { env })).json();
  assert.equal(state(root, e.id).tracker.done.length, 1, 'admitted and read back');
  assert.equal(fs.existsSync(pwned), false, 'nothing from the issue ran');
  const argv = fs.readFileSync(`${db}.argv`, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  for (const args of argv) {
    assert.equal(args[0], 'api');
    assert.ok(args.every((x) => !/hostname|evil|DELETE/.test(x)), `issue data never becomes an argument: ${JSON.stringify(args)}`);
    assert.match(args[3], /^(\/repos\/acme\/app\/|https:\/\/uploads\.github\.com\/)/, 'the request target is always the configured repository');
  }
  assert.deepEqual(JSON.parse(fs.readFileSync(db, 'utf8')).issue.labels.map((l) => l.name), ['--hostname=evil.example.test', 'In Progress\n-X DELETE', 'In Progress'], 'only the configured status label was added; the others are untouched');
});

test('github: an item that is not an issue number is refused before any call', () => {
  const { base, root } = project('gh-item', { via: 'cli' });
  const db = path.join(base, 'github.json');
  seed(db);
  const env = { PATH: ghOnPath(base), FAKE_GH_STATE: db };
  const e = ok(wf(root, ['entry', '--item', 'ENG-abc', '--owner', 'o', '--json'], { env })).json();
  assert.match(ok(wf(root, ['tracker', 'sync', '--attempt', e.id], { env })).out, /a GitHub issue item is its number \(`123` or `GH-123`\), not `ENG-abc`/);
  assert.equal(fs.existsSync(`${db}.argv`), false, 'gh was not called');
});
