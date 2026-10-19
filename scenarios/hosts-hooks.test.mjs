// Stream 4: the plugin's hooks. Only the session rules remain (no evidence guard); they are filled from the adapter and
// the project's invariants, and print nothing outside a project.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { makeProject, withDoubles } from './helpers/index.mjs';
import { rulesFor } from '../hooks/session-rules.mjs';

const HOOKS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'hooks');

test('hooks.json runs only the session rules, at session and subagent start; the guard is gone', () => {
  const cfg = JSON.parse(fs.readFileSync(path.join(HOOKS, 'hooks.json'), 'utf8'));
  assert.deepEqual(Object.keys(cfg.hooks).sort(), ['SessionStart', 'SubagentStart']);
  assert.ok(!fs.existsSync(path.join(HOOKS, 'guard-evidence.mjs')));
  assert.ok(JSON.stringify(cfg).includes('session-rules.mjs'));
});

test('session rules: filled from the adapter with the invariants as written; nothing outside a project', async (t) => {
  const p = makeProject({ adapter: false });
  t.after(p.cleanup);
  fs.writeFileSync(path.join(p.root, 'INVARIANTS.md'), 'Totals never go negative.\n');
  const adapter = { name: 'sample', root: p.root, invariants: 'INVARIANTS.md', ticketing: { tracker: { module: { repo: 'server', path: 't.mjs' } } }, delivery: { stages: [{ do: 'land' }, { do: 'status' }] } };
  const text = await withDoubles({ findProject: async (cwd) => (cwd.startsWith(p.root) ? { root: p.root, file: 'x', location: 'repo' } : null), loadAdapter: async () => adapter }, async () => {
    assert.equal(await rulesFor(p.tmp), null);
    return rulesFor(path.join(p.root, 'server'));
  });
  assert.match(text, /\(sample;/);
  assert.match(text, /Totals never go negative\./);
  assert.doesNotMatch(text, /\{(project|tracker|delivery|invariants)\}/);
  // As a hook process outside any project: no output, exit 0.
  const r = spawnSync(process.execPath, [path.join(HOOKS, 'session-rules.mjs')], { input: JSON.stringify({ cwd: p.tmp, hook_event_name: 'SessionStart' }), encoding: 'utf8', env: { ...process.env, ...p.env } });
  assert.deepEqual([r.status, r.stdout], [0, '']);
});
