import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { closureFile, commitIn, criteriaFile, goodClosure, ok, OUT_OF_ORDER, singleRepoProject, state, summaryFile, tmp, wf, yaml } from './helpers.mjs';
import { deliveredSeams, readEvidenceFile } from '../engine/evidence.mjs';

// 0.4.0 review finding: an adapter read a delivered screenshot by its path, so a link planted there could upload any
// local file (a key, an .env) to the tracker. Every tracker upload and export now reads through one safe reader.

const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

function evidence() {
  const root = path.join(tmp('safe-read'), 'proj');
  const dir = path.join(root, '.wf-evidence', 'attempts', 'X-1.1', 'gate', 'run', 'ui');
  fs.mkdirSync(dir, { recursive: true });
  const secret = path.join(path.dirname(root), 'id_secret');
  fs.writeFileSync(secret, 'PRIVATE KEY');
  const shot = path.join(dir, 'home.png');
  fs.writeFileSync(shot, 'png');
  return { root, dir, secret, shot, f: { path: shot, sha256: sha('png'), title: 'home.png' } };
}

test('safe read: the delivered file itself is read, hashed from the bytes read and named by its title', () => {
  const { root, f } = evidence();
  const r = readEvidenceFile(root, 'X-1.1', { ...f, title: '../../x/home.png' });
  assert.deepEqual([r.bytes.toString(), r.size, r.sha256, r.name], ['png', 3, sha('png'), 'home.png']);
});

test('safe read attacks: a symlink, a hard link, a path that resolves outside, a FIFO and a swap at open are all refused', () => {
  const { root, dir, secret, shot, f } = evidence();
  const refuses = (file, re, extra = {}) => assert.throws(() => readEvidenceFile(root, 'X-1.1', { ...f, path: file, ...extra }), re);
  const link = path.join(dir, 'link.png');
  fs.symlinkSync(secret, link);
  refuses(link, /not opened \(a symlink is never followed\)/);
  const hard = path.join(dir, 'hard.png');
  fs.linkSync(secret, hard);
  refuses(hard, /has another name \(hard link\); not read/);
  refuses(path.join(dir, '..', '..', '..', '..', '..', 'id_secret'), /outside the project's attempt evidence/);
  const linkedDir = path.join(dir, 'dirlink');
  fs.symlinkSync(path.dirname(root), linkedDir);
  refuses(path.join(linkedDir, 'id_secret'), /outside the project's attempt evidence/);
  const fifo = path.join(dir, 'fifo.png');
  assert.equal(spawnSync('mkfifo', [fifo]).status, 0);
  refuses(fifo, /is not a regular file/);
  // Swapped for a link between the folder check and the open (the test seam): the no-follow open refuses it.
  try {
    deliveredSeams.beforeOpen = (p) => {
      if (p !== shot) return;
      fs.rmSync(shot);
      fs.symlinkSync(secret, shot);
    };
    refuses(shot, /not opened \(a symlink is never followed\)/);
  } finally {
    deliveredSeams.beforeOpen = null;
  }
  // Same bytes are still required: a file whose content changed is not the delivered screenshot.
  fs.rmSync(shot);
  fs.writeFileSync(shot, 'other');
  refuses(shot, /bytes differ from the recorded sha256/);
});

test('safe read end to end: a delivered screenshot replaced by a link to a secret is never copied to the tickets', () => {
  const visual = [{ id: 'ui', repo: 'app', run: 'mkdir -p shots && printf png > shots/home.png', artifacts: ['shots/*.png'] }];
  const { base, root } = singleRepoProject('safe-read-e2e', { tracker: { kind: 'files', statuses: { started: 'In Progress', delivered: 'Ready for UAT', done: 'Done' }, deliveredComment: 'uat.md' }, gate: { steps: visual } }, { '.gitignore': '.wf-evidence/\n.wf-worktrees/\nshots/\n', '.workflow/uat.md': '{id} is ready.\n', 'tickets/ENG-1.md': `---\n${yaml({ id: 'ENG-1', title: 't', status: 'Todo' }).trim()}\n---\nd\n` });
  const secret = path.join(base, 'id_secret');
  fs.writeFileSync(secret, 'PRIVATE KEY');
  const e = ok(wf(root, ['entry', '--item', 'ENG-1', '--owner', 'o', '--json'])).json();
  ok(wf(root, ['handoff', 'planner', '--agent', 'p', '--attempt', e.id]));
  ok(wf(root, ['plan', '--file', criteriaFile(base), '--attempt', e.id]));
  ok(wf(root, ['handoff', 'implementer', '--agent', 'i', '--attempt', e.id]));
  commitIn(e.repos.app.worktree, { 'src/a.txt': 'ui\n' });
  const g = ok(wf(root, ['gate', ...OUT_OF_ORDER, '--attempt', e.id, '--json'])).json();
  ok(wf(root, ['handoff', 'reviewer', '--agent', 'r', '--attempt', e.id]));
  ok(wf(root, ['review', '--closure', closureFile(base, goodClosure('r', { screenshotsInspected: [g.steps[0].artifacts[0].sha256] })), '--attempt', e.id]));
  ok(wf(root, ['accept', '--attempt', e.id]));
  ok(wf(root, ['deliver', '--attempt', e.id, '--summary-file', summaryFile(base)]));
  const src = state(root, e.id).delivery.screenshots.screenshots[0].path;
  fs.chmodSync(path.dirname(src), 0o755);
  fs.chmodSync(src, 0o644);
  fs.rmSync(src);
  fs.symlinkSync(secret, src);
  const shown = path.join(base, 'shown.json');
  fs.writeFileSync(shown, JSON.stringify({ screenshots: [{ sha256: g.steps[0].artifacts[0].sha256, caption: 'Home' }], anomalies: 'none seen' }));
  // Two layers refuse it: the evidence check before the command, and the safe reader at the upload.
  const r = wf(root, ['shown', '--file', shown, '--attempt', e.id]);
  assert.notEqual(r.code, 0);
  assert.match(r.err, /home\.png: symlink/);
  assert.notEqual(wf(root, ['tracker', 'sync', '--attempt', e.id]).code, 0);
  const copied = [];
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).forEach((x) => (x.isDirectory() ? walk(path.join(d, x.name)) : copied.push(fs.readFileSync(path.join(d, x.name), 'utf8'))));
  walk(path.join(root, 'tickets'));
  assert.ok(copied.every((c) => !c.includes('PRIVATE KEY')), 'the secret reached no ticket file');
});

test('linear attack: an upload url off Linear storage, an authorization header in the upload headers, and a redirect are refused', async () => {
  const { default: linear } = await import('../adapters/tracker/linear.mjs');
  const issue = { id: 'u1', identifier: 'ENG-9', title: 't', description: 'd', url: 'https://linear.app/x/ENG-9', updatedAt: 'x', state: { name: 'Todo' }, comments: { nodes: [] }, attachments: { nodes: [] }, team: { states: { nodes: [] } } };
  const calls = [];
  const real = globalThis.fetch;
  const answer = (uploadUrl, headers = []) => async (url, init) => {
    calls.push({ url: String(url), method: init.method, headers: init.headers, redirect: init.redirect });
    if (init.method === 'PUT') return new Response('', { status: 200 });
    const q = JSON.parse(init.body).query;
    if (/fileUpload/.test(q)) return Response.json({ data: { fileUpload: { uploadFile: { uploadUrl, assetUrl: 'https://uploads.linear.app/a/home.png', headers } } } });
    return Response.json({ data: { issue } });
  };
  const files = [{ name: 'home.png', bytes: Buffer.from('png'), size: 3, sha256: sha('png'), caption: 'Home' }];
  const run = () => linear.api.perform({ token: 'lin_api_secret', url: 'https://api.linear.app/graphql', item: 'ENG-9', actions: [{ op: 'attach', files }] });
  try {
    globalThis.fetch = answer('https://evil.example.test/upload');
    await assert.rejects(run(), /upload host evil\.example\.test is not Linear's upload storage; not sent/);
    assert.ok(!calls.some((c) => c.method === 'PUT'), 'nothing was PUT');
    calls.length = 0;
    globalThis.fetch = answer('http://storage.googleapis.com/x');
    await assert.rejects(run(), /is not https/);
    calls.length = 0;
    globalThis.fetch = answer('https://storage.googleapis.com/linear/x', [{ key: 'Authorization', value: 'lin_api_secret' }, { key: 'x-goog-meta', value: 'ok' }]);
    await run().catch(() => {});
    const put = calls.find((c) => c.method === 'PUT');
    assert.ok(put, 'a Linear storage url is uploaded to');
    assert.ok(!Object.keys(put.headers).some((k) => /authorization/i.test(k)), 'no authorization header goes to the signed url');
    assert.ok(calls.every((c) => c.redirect === 'manual'), 'no request follows a redirect');
    globalThis.fetch = async () => new Response('', { status: 307, headers: { location: 'https://evil.example.test/' } });
    await assert.rejects(run(), /redirected \(307\); a request with the key never follows a redirect/);
  } finally {
    globalThis.fetch = real;
  }
});

test('safe read: a summary file that is a link to a secret is refused, never posted', () => {
  const { base, root } = singleRepoProject('safe-summary', { tracker: { kind: 'files', statuses: { started: 'In Progress', delivered: 'Ready for UAT', done: 'Done' }, deliveredComment: 'uat.md' } }, { '.workflow/uat.md': '{id} is ready.\n', 'tickets/ENG-2.md': `---\n${yaml({ id: 'ENG-2', title: 't', status: 'Todo' }).trim()}\n---\nd\n` });
  const secret = path.join(base, 'id_secret');
  fs.writeFileSync(secret, 'PRIVATE KEY line one\n');
  const link = path.join(base, 'summary.md');
  fs.symlinkSync(secret, link);
  const e = ok(wf(root, ['entry', '--item', 'ENG-2', '--owner', 'o', '--json'])).json();
  const r = wf(root, ['summary', '--file', link, '--attempt', e.id]);
  assert.notEqual(r.code, 0);
  assert.match(`${r.out}${r.err}`, /is a symlink; give the file itself/);
  assert.ok(!fs.readFileSync(path.join(root, 'tickets', 'ENG-2.md'), 'utf8').includes('PRIVATE KEY'));
});
