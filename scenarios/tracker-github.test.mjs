import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { closureFile, commitIn, criteriaFile, goodClosure, ok, singleRepoProject, state, summaryFile, wf, yaml } from './helpers.mjs';
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
  assert.match(shown.out, /tracker: delivered performed through the API and read back; attempt closed/);
  assert.equal(state(root, e.id).phase, 'done');
  const after = JSON.parse(fs.readFileSync(db, 'utf8'));
  after.issue.labels = after.issue.labels.filter((l) => l.name !== 'bug');
  assertDelivered(after);
  assert.ok(fs.readFileSync(`${db}.argv`, 'utf8').split('\n').filter(Boolean).every((l) => !/gho_|authorization/i.test(l)), 'wf passes no token to gh');
});

test('github via api: a token from wf secrets drives the same flow; without it the actions stay pending; the token never appears', async () => {
  const { base, root } = project('gh-api', { via: 'api', apiUrl: 'http://placeholder.invalid' }, { '.workflow/secrets.yaml': yaml({ keys: [{ key: 'GITHUB_TOKEN', kind: 'provided', required: true }] }) });
  const db = path.join(base, 'github.json');
  seed(db);
  const token = 'ghp_fakeApiTokenForTests123';
  const child = spawn(process.execPath, [path.join(FIX, 'fake-github.mjs'), 'serve', db, token], { stdio: 'ignore' });
  try {
    for (let i = 0; i < 100 && !fs.existsSync(`${db}.port`); i++) await new Promise((r) => setTimeout(r, 50));
    const cfgFile = path.join(root, '.workflow', 'project.yaml');
    fs.writeFileSync(cfgFile, fs.readFileSync(cfgFile, 'utf8').replace('http://placeholder.invalid', `http://127.0.0.1:${fs.readFileSync(`${db}.port`, 'utf8')}`));
    const noKey = ok(wf(root, ['entry', '--item', 'GH-12', '--owner', 'o', '--json']));
    const id = noKey.json().id;
    assert.ok(state(root, id).tracker.pending.length, 'without the token the actions stay pending');
    ok(wf(root, ['secrets', 'set', 'GITHUB_TOKEN'], { input: 'ghp_wrongToken999' }));
    const bad = ok(wf(root, ['tracker', 'sync', '--attempt', id]));
    assert.match(bad.out, /tracker api \(admitted\) failed: GitHub API GET \/repos\/acme\/app\/issues\/12: 401 Bad credentials; the actions stay pending/);
    ok(wf(root, ['secrets', 'set', 'GITHUB_TOKEN'], { input: token }));
    assert.match(ok(wf(root, ['tracker', 'sync', '--attempt', id])).out, /tracker: admitted performed through the API and read back/);
    const { shown } = deliver(base, root, id, {});
    assert.match(shown.out, /tracker: delivered performed through the API and read back; attempt closed/);
    assertDelivered(JSON.parse(fs.readFileSync(db, 'utf8')));
    const captures = fs.readdirSync(path.join(root, '.wf-evidence', 'attempts', id, 'tracker')).map((f) => fs.readFileSync(path.join(root, '.wf-evidence', 'attempts', id, 'tracker', f), 'utf8'));
    assert.ok(captures.every((c) => !c.includes(token)), 'the token is not in any capture');
  } finally {
    child.kill();
  }
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
