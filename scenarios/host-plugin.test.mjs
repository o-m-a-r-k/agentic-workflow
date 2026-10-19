// A new harness plugs in by adding one host module (D8): a throwaway `grok` host is registered from outside the engine, with
// its own session variable, credential prefix and transcript layout. With no engine file changed, the engine knows its
// sessions (the caller of a command, recorded on the ledger), reads what they read and did, and keeps its credentials out of
// project commands. Without the module the same session is a plain terminal.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { gitEnv, makeProject, runWf, writeFiles } from './helpers/index.mjs';
import { callerSession, filesRead, findHost, registerHost, sessionActivity, sessionVariables, unregisterHost } from '../engine/hosts/index.mjs';
import { projectEnv } from '../engine/env.mjs';

const WRAPPER = path.join(import.meta.dirname, 'host-plugin-wf.mjs');
const SESSION = 'grok-session-0001';

// The host module. Its transcripts are `<home>/.grok/sessions/<id>.json`: { cwd, events: [{ at, kind, ... }] }.
const HOST = `import fs from 'node:fs';
import path from 'node:path';
export default {
  id: 'grok', name: 'Grok', label: 'Grok CLI',
  sessionEnv: ['GROK_TEST_SESSION'], markerEnv: [], envPrefixes: ['GROK_TEST_'],
  detect: (env) => env.GROK_TEST_SESSION || null,
  transcript: (id, home) => { const f = path.join(home, '.grok', 'sessions', id + '.json'); return fs.existsSync(f) ? f : null; },
  timeline(file) {
    const t = JSON.parse(fs.readFileSync(file, 'utf8'));
    const items = [];
    for (const [i, e] of t.events.entries()) {
      if (e.kind === 'read') items.push({ type: 'call', at: e.at, id: 'c' + i, name: 'Read', input: { file_path: e.file }, cwd: t.cwd }, { type: 'result', at: e.at, id: 'c' + i, text: e.ok ? 'contents' : 'no such file', error: !e.ok });
      if (e.kind === 'person') items.push({ type: 'person', at: e.at, text: e.text });
      if (e.kind === 'usage') items.push({ type: 'usage', at: e.at, key: 'r' + i, model: e.model, input: e.input, output: e.output });
    }
    return { cwd: t.cwd, items };
  },
};
`;

function hostModule(dir) {
  const file = path.join(dir, 'grok-host.mjs');
  fs.writeFileSync(file, HOST);
  return file;
}

test('a registered host is read like a built-in one: its caller session, files read, turns and usage; its credentials stay out of project commands', async (t) => {
  const p = makeProject({ adapter: false });
  t.after(() => {
    unregisterHost('grok');
    p.cleanup();
  });
  const env = { GROK_TEST_SESSION: SESSION, GROK_TEST_TOKEN: 'not-a-real-token', PATH: process.env.PATH };
  assert.equal(callerSession(env), null, 'unknown before its module is registered');
  registerHost((await import(pathToFileURL(hostModule(p.tmp)).href)).default);
  assert.equal(findHost('grok').label, 'Grok CLI');
  assert.deepEqual(callerSession(env), { runtime: 'grok', id: SESSION });
  assert.ok(sessionVariables().includes('GROK_TEST_SESSION'), 'a launched role never inherits its session variable');
  const file = path.join(p.root, 'server', 'src', 'core', 'sum.mjs');
  writeFiles(path.join(p.home, '.grok', 'sessions'), {
    [`${SESSION}.json`]: JSON.stringify({ cwd: p.root, events: [
      { at: '2026-01-05T09:00:00.000Z', kind: 'person', text: 'review it' },
      { at: '2026-01-05T09:01:00.000Z', kind: 'read', file, ok: true },
      { at: '2026-01-05T09:02:00.000Z', kind: 'read', file: path.join(p.root, 'missing.mjs'), ok: false },
      { at: '2026-01-05T09:03:00.000Z', kind: 'usage', model: 'grok-test-model', input: 100, output: 20 },
    ] }),
  });
  const session = { runtime: 'grok', id: SESSION };
  assert.deepEqual(filesRead(session, { home: p.home }), [file], 'a failed read is not a read');
  const act = sessionActivity(session, { home: p.home });
  assert.deepEqual([act.turns.length, act.turns[0].human, act.tokens.input, act.tokens.output, act.model], [4, true, 100, 20, 'grok-test-model']);
  assert.equal(filesRead({ runtime: 'grok', id: 'no-such-session' }, { home: p.home }), null);
  const passed = projectEnv(null, {}, env);
  assert.equal(passed.GROK_TEST_TOKEN, undefined, 'its credential prefix never reaches a project command');
  assert.equal(passed.PATH, process.env.PATH);
});

test('through the real cli, a command run from the registered host\'s session records that session as its actor; without the module it is a terminal', () => {
  const p = makeProject({
    name: 'plug',
    repos: [{ name: 'app', base: 'trunk', files: { 'src/a.mjs': 'export const a = 1;\n', 'README.md': '# app\n' } }],
    overrides: {
      repos: [{ name: 'app', path: 'app', base: 'trunk', tests: { fast: { run: 'node -e "process.exit(0)"' } }, kinds: { tests: ['test/**'], other: ['**/*.md'] } }],
      risk: 'none',
      ticketing: { tracker: 'files', via: 'files', idPattern: '^TK-\\d+$' },
      delivery: { landing: 'direct', stages: [{ do: 'land' }] },
    },
  });
  try {
    writeFiles(p.root, { 'tickets/TK-1.md': '---\nid: TK-1\ntitle: A ticket\nstatus: Todo\n---\nBody.\n' });
    const started = runWf(p, ['start', 'TK-1']);
    assert.equal(started.code, 0, started.err);
    const env = { ...gitEnv(), ...p.env, GROK_TEST_SESSION: SESSION, WF_TEST_HOST_ADAPTER: hostModule(p.tmp) };
    for (const k of ['CLAUDE_CODE_SESSION_ID', 'CLAUDECODE', 'CODEX_THREAD_ID', 'CODEX_SANDBOX', 'AI_AGENT', 'GROK_SESSION_ID']) delete env[k];
    const held = spawnSync(process.execPath, [WRAPPER, 'hold', '--reason', 'wait for the person', '--attempt', 'TK-1.1'], { cwd: p.root, env, encoding: 'utf8' });
    assert.equal(held.status, 0, held.stderr);
    const plain = runWf(p, ['hold', '--reason', 'still waiting', '--attempt', 'TK-1.1'], { env: { GROK_TEST_SESSION: SESSION } });
    assert.equal(plain.code, 0, plain.err);
    const ledger = fs.readFileSync(path.join(p.root, '.wf-evidence', 'attempts', 'TK-1.1', 'ledger.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const holds = ledger.filter((e) => e.type === 'hold');
    assert.deepEqual(holds[0].actor, { runtime: 'grok', id: SESSION });
    // The plain wf does not know the host: the same variable is no session.
    assert.equal(holds[1].actor, null);
  } finally {
    p.cleanup();
  }
});
