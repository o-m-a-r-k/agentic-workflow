import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { ok, singleRepoProject, state, tmp, wf, yaml } from './helpers.mjs';
import { seed } from './fixtures/fake-github.mjs';
import { cliEnv, scrub } from '../engine/scrub.mjs';

// 0.4.2 review: credential exfiltration in the tracker paths. A token, an Authorization value, another service's key
// in the owner's environment, or a signed-URL signature must not leave the process in an error, a record, a child's
// environment or an export.

const statuses = { started: 'In Progress', delivered: 'Ready for UAT', done: 'Done' };
const FIX = path.join(import.meta.dirname, 'fixtures');
const keys = (k) => ({ '.workflow/secrets.yaml': yaml({ keys: [{ key: k, kind: 'provided', required: true }] }) });

test('scrub masks secret values, signatures, Authorization values and prefixed tokens, and keeps hashes', () => {
  const h = 'a'.repeat(64);
  const s = scrub(`token mysecret123 at https://u.test/x.png?X-Amz-Signature=abc&signature=def sha256 ${h} Authorization: Bearer abcdefghijklmnop ghp_abcdefghijklmnopqrstuv lin_api_abcdefghijklmnopqrst`, ['mysecret123']);
  assert.equal(s, `token [secret] at https://u.test/x.png?X-Amz-Signature=[redacted]&signature=[redacted] sha256 ${h} Authorization: Bearer [secret] [secret] [secret]`);
  const env = cliEnv({ PATH: '/bin', HOME: '/h', GH_TOKEN: 'gh', LINEAR_API_KEY: 'x', AWS_SECRET_ACCESS_KEY: 'y', LC_ALL: 'C' });
  assert.deepEqual(Object.keys(env).sort(), ['GH_PROMPT_DISABLED', 'GH_TOKEN', 'HOME', 'LC_ALL', 'NO_COLOR', 'PATH']);
});

test('gh gets a minimal environment: no other service key of the owner reaches it', () => {
  const p = singleRepoProject('exfil-gh-env', { tracker: { kind: 'github', repo: 'acme/app', via: 'cli', statuses, publicAssets: 'acknowledged' } });
  const db = path.join(p.base, 'github.json');
  seed(db);
  const bin = path.join(p.base, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'gh'), `#!/bin/sh\nexec "${process.execPath}" "${path.join(FIX, 'fake-gh.mjs')}" "$@"\n`, { mode: 0o755 });
  ok(wf(p.root, ['entry', '--item', 'GH-12', '--owner', 'o'], { env: { PATH: `${bin}${path.delimiter}${process.env.PATH}`, WF_TEST_GH_STATE: db, LINEAR_API_KEY: 'lin_api_canary000000000000', STRIPE_SECRET_KEY: 'sk_live_canary' } }));
  const seen = fs.readFileSync(`${db}.env`, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.ok(seen.length > 0);
  for (const names of seen) {
    assert.ok(!names.includes('LINEAR_API_KEY') && !names.includes('STRIPE_SECRET_KEY'), `gh saw ${names.join(',')}`);
    assert.ok(names.includes('WF_TEST_GH_STATE') && names.includes('PATH'));
  }
});

test('a tracker error that echoes the token never shows or records it', async () => {
  const token = 'ghp_echoedTokenValue12345';
  const dbDir = tmp('exfil-echo');
  const db = path.join(dbDir, 'github.json');
  seed(db);
  fs.writeFileSync(db, JSON.stringify({ ...JSON.parse(fs.readFileSync(db, 'utf8')), echoAuth: true }));
  const child = spawn(process.execPath, [path.join(FIX, 'fake-github.mjs'), 'serve', db, 'the-right-token'], { stdio: 'ignore' });
  try {
    for (let i = 0; i < 100 && !fs.existsSync(`${db}.port`); i++) await new Promise((r) => setTimeout(r, 50));
    const url = `http://127.0.0.1:${fs.readFileSync(`${db}.port`, 'utf8')}`;
    const p = singleRepoProject('exfil-echo-proj', { tracker: { kind: 'github', repo: 'acme/app', via: 'api', apiUrl: url, statuses } }, keys('GITHUB_TOKEN'));
    ok(wf(p.root, ['secrets', 'set', 'GITHUB_TOKEN'], { input: token }));
    const r = ok(wf(p.root, ['entry', '--item', 'GH-12', '--owner', 'o', '--json']));
    const id = r.json().id;
    const sync = ok(wf(p.root, ['tracker', 'sync', '--attempt', id]));
    assert.match(sync.out, /401 Bad credentials for Bearer \[secret\]/, 'the echoed value is masked');
    const status = ok(wf(p.root, ['status', '--attempt', id])).out;
    const files = [];
    const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).forEach((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : files.push(fs.readFileSync(path.join(d, e.name), 'utf8'))));
    walk(path.join(p.root, '.wf-evidence'));
    for (const text of [r.out, r.err, sync.out, sync.err, status, ...files]) assert.ok(!text.includes(token) && !text.includes('echoedTokenValue'), 'the token appears nowhere');
    assert.ok(state(p.root, id).tracker.pending.length, 'nothing was recorded');
  } finally {
    child.kill();
  }
});

test('a hostile Linear endpoint (plain http, credentials in the URL) never receives the key', () => {
  for (const apiUrl of ['http://evil.example.test/graphql', 'https://user:pw@api.linear.app/graphql']) {
    const p = singleRepoProject(`exfil-linear-${apiUrl.length}`, { tracker: { kind: 'linear', via: 'api', apiUrl, statuses } }, keys('LINEAR_API_KEY'));
    ok(wf(p.root, ['secrets', 'set', 'LINEAR_API_KEY'], { input: 'lin_api_hostileTest000000000' }));
    const r = ok(wf(p.root, ['entry', '--item', 'ENG-80', '--owner', 'o']));
    assert.match(r.out, /(a tracker token goes only over https|an endpoint never carries credentials in its URL).*; nothing sent, the actions stay pending/);
    assert.ok(!r.out.includes('lin_api_hostileTest'));
  }
  const ok2 = singleRepoProject('exfil-linear-other', { tracker: { kind: 'linear', via: 'api', apiUrl: 'https://linear.example.test/graphql', statuses } }, keys('LINEAR_API_KEY'));
  assert.match(wf(ok2.root, ['doctor', '--no-steps']).out, /NOTICE: the linear token is sent to linear\.example\.test \(tracker\.apiUrl\), not api\.linear\.app/);
});
