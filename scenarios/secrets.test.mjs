// Agents never handle secret values (principle 9). The person fills them in their own terminal (`wf secrets guide`); the
// engine reads them only to hand a command the keys that list it (D14: `usedBy: [provision:<repo>]` reaches that repo's
// install and nothing else), and prints names and states, never a value: in `wf secrets check`, in `wf doctor` and in a
// failed install's output. Agent-runtime credentials never reach a project command.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeProject, runWf, writeFiles } from './helpers/index.mjs';
import { projectEnv } from '../engine/env.mjs';

const VALUE = 'sv-0123456789abcdef-fixture';
const OTHER = 'ov-fedcba9876543210-fixture';

// A one-repo project with tickets as files and a secrets catalogue: REGISTRY_TOKEN is for the app's install, API_KEY for
// nothing the engine runs. The install writes what it received into the worktree, then fails when FAIL is in it.
function project({ install, filled = true }) {
  const p = makeProject({
    name: 'keys',
    repos: [{ name: 'app', base: 'trunk', files: { 'src/a.mjs': 'export const a = 1;\n', 'README.md': '# app\n', '.gitignore': '.env.local\nnode_modules/\ngot.txt\n' } }],
    overrides: {
      repos: [{ name: 'app', path: 'app', base: 'trunk', provision: { clone: ['node_modules'], install }, tests: { fast: { run: 'node -e "process.exit(0)"' } }, kinds: { tests: ['test/**'], other: ['**/*.md'] } }],
      ticketing: { tracker: 'files', via: 'files', idPattern: '^TK-\\d+$' },
      delivery: { landing: 'direct', stages: [{ do: 'land' }] },
    },
  });
  writeFiles(p.root, {
    'tickets/TK-1.md': '---\nid: TK-1\ntitle: A ticket\nstatus: Todo\n---\nBody.\n',
    '.workflow/secrets.yaml': 'keys:\n  - { key: REGISTRY_TOKEN, usedBy: [provision:app], purpose: the package registry }\n  - { key: API_KEY, purpose: a service the app calls, required: true }\n',
  });
  if (filled) writeFiles(path.join(p.root, 'app'), { '.env.local': `REGISTRY_TOKEN=${VALUE}\nAPI_KEY=${OTHER}\n` });
  return p;
}
const all = (r) => `${r.out}${r.err}`;

test('secrets check and doctor name each key and its state, never its value', () => {
  const p = project({ install: 'true' });
  try {
    const check = runWf(p, ['secrets', 'check']);
    assert.equal(check.code, 0, all(check));
    assert.match(check.out, /✓ REGISTRY_TOKEN: filled/);
    assert.match(check.out, /✓ API_KEY: filled/);
    const doctor = runWf(p, ['doctor']);
    assert.match(doctor.out, /secrets: 2 catalogued, all filled/);
    fs.writeFileSync(path.join(p.root, 'app', '.env.local'), `REGISTRY_TOKEN=${VALUE}\n`);
    const missing = runWf(p, ['secrets', 'check']);
    assert.equal(missing.code, 1);
    assert.match(missing.out, /✗ API_KEY: missing/);
    for (const r of [check, doctor, missing]) for (const v of [VALUE, OTHER]) assert.ok(!all(r).includes(v), 'no value is printed');
  } finally {
    p.cleanup();
  }
});

test('D14: provisioning gets only the keys that list it; a failed install with a secret prints none of its output', () => {
  const p = project({ install: 'printf "%s|%s" "$REGISTRY_TOKEN" "$API_KEY" > got.txt; echo "token is $REGISTRY_TOKEN"; [ ! -f FAIL ]' });
  try {
    const ok = runWf(p, ['start', 'TK-1']);
    assert.equal(ok.code, 0, all(ok));
    assert.equal(fs.readFileSync(path.join(p.root, '.wf-worktrees', 'TK-1.1', 'app', 'got.txt'), 'utf8'), `${VALUE}|`, 'the install got its key and not the other');
    assert.ok(!all(ok).includes(VALUE));
    // A failing install: the error names the command and its exit, and leaves out the output that echoed the value.
    p.commit('app', { FAIL: 'x\n' }, 'make the install fail', { push: true });
    writeFiles(p.root, { 'tickets/TK-2.md': '---\nid: TK-2\ntitle: Another\nstatus: Todo\n---\nBody.\n' });
    const failed = runWf(p, ['start', 'TK-2']);
    assert.notEqual(failed.code, 0);
    assert.match(failed.err, /provisioning app failed: .* exited 1/);
    assert.ok(!all(failed).includes(VALUE), 'the echoed value is not printed');
  } finally {
    p.cleanup();
  }
});

test('D14: an unfilled provisioning key refuses the start by name and points the person to their own terminal', () => {
  const p = project({ install: 'true', filled: false });
  try {
    const r = runWf(p, ['start', 'TK-1']);
    assert.notEqual(r.code, 0);
    assert.match(r.err, /secrets missing for provisioning app: REGISTRY_TOKEN/);
    assert.match(r.err, /`wf secrets guide` in their terminal/);
  } finally {
    p.cleanup();
  }
});

test('agent-runtime credentials and session ids never reach a project command; the toolchain and wf variables do', () => {
  const source = { PATH: '/bin', HOME: '/h', WF_ROOT: '/r', ANTHROPIC_API_KEY: 'x', CLAUDE_CODE_SESSION_ID: 's', CODEX_THREAD_ID: 't', OPENAI_API_KEY: 'y', SOME_SERVICE_TOKEN: 'z' };
  assert.deepEqual(projectEnv(null, { REGISTRY_TOKEN: VALUE }, source), { PATH: '/bin', HOME: '/h', WF_ROOT: '/r', REGISTRY_TOKEN: VALUE });
});

test('scrub masks catalogued values, prefixed and bearer tokens, auth headers and query credentials; hashes stay; scrubbing twice changes nothing', async () => {
  const { scrub, secretValues } = await import('../engine/scrub.mjs');
  const hash = 'a'.repeat(64);
  const text = `value ${VALUE} at https://x.test/f?X-Amz-Signature=abc123&size=2 Authorization: token zzz999yyy Bearer abcdefghijklmnop1234 ghp_0123456789abcdefghij xoxb-0123456789-abc sha ${hash}`;
  const out = scrub(text, { secrets: [VALUE, 'short'] });
  for (const leak of [VALUE, 'abc123', 'zzz999yyy', 'abcdefghijklmnop1234', 'ghp_0123456789abcdefghij', 'xoxb-0123456789-abc']) assert.ok(!out.includes(leak), `${leak} leaked: ${out}`);
  assert.ok(out.includes(hash) && out.includes('&size=2'));
  assert.equal(scrub(out, { secrets: [VALUE] }), out);
  assert.equal(scrub('a short word', { secrets: ['short'] }), 'a short word');
  const p = project({ install: 'true' });
  try {
    assert.deepEqual(secretValues(p.root, { name: 'keys', repos: [{ name: 'app', path: 'app' }] }).sort(), [OTHER, VALUE].sort());
    assert.deepEqual(secretValues(p.tmp, null), []);
    // A user-folder adapter: the catalogue beside it is the one read.
    const userFile = path.join(p.tmp, 'projects', 'keys.yaml');
    fs.mkdirSync(path.dirname(userFile), { recursive: true });
    fs.renameSync(path.join(p.root, '.workflow', 'secrets.yaml'), path.join(p.tmp, 'projects', 'keys.secrets.yaml'));
    const user = { name: 'keys', repos: [{ name: 'app', path: 'app' }], source: { location: 'user', file: userFile } };
    assert.deepEqual(secretValues(p.root, user).sort(), [OTHER, VALUE].sort());
    assert.deepEqual(secretValues(p.root, { name: 'keys', repos: user.repos }), [], 'the repo place holds none now');
  } finally {
    p.cleanup();
  }
});
