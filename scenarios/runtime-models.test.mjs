import { test } from 'node:test';
import assert from 'node:assert/strict';
import { commitIn, ok, singleRepoProject, state, wf, yaml, sh } from './helpers.mjs';

// 0.7.30 (I-151, D60): the attempt follows its base branch's adapter, models included, so a model committed and pushed there
// reaches the attempt's next handoff with no refresh; `wf models refresh` stays for a tip the attempt has not taken yet.
test('I-44, I-151: doctor reports the attempt pin; a model committed on the base branch reaches the next handoff by itself; overrides are refused', () => {
  const initial = { classes: { review: { codex: {} }, planning: { codex: { model: null } } }, gate: { steps: [{ id: 'unit', repo: 'app', run: 'true' }] } };
  const { root } = singleRepoProject('runtime-refresh', initial);
  const id = ok(wf(root, ['entry', '--item', 'ENG-81', '--json'])).json().id;
  const admission = state(root, id).adapterBase;
  const before = wf(root, ['doctor', '--runtime', 'codex', '--no-steps', '--attempt', id, '--json']);
  assert.equal(before.code, 1, 'current configuration must not conceal the missing attempt model');
  assert.match(before.out, /commit the model on the base branch/);
  const cfg = { version: 1, enabled: true, name: 'runtime-refresh', repos: [{ name: 'app', path: '.', base: 'main' }], ...initial,
    classes: { planning: { use: 'Plan the work', codex: { model: 'future-planner', effort: 'high' } }, review: { codex: { model: 'future-reviewer', effort: 'high' } }, full: { codex: { model: 'future-implementer', effort: 'xhigh' } } },
    roles: { planner: { class: 'planning' } }, gate: { steps: [{ id: 'unit', repo: 'app', run: 'true' }] }
  };
  commitIn(root, { '.workflow/project.yaml': yaml(cfg) });
  assert.match(ok(wf(root, ['handoff', 'planner', '--agent', 'missing', '--runtime', 'codex', '--attempt', id])).err, /cannot launch/, 'a commit not pushed is not read');
  assert.equal(wf(root, ['handoff', 'run', '--agent', 'missing', '--attempt', id]).code, 75);
  sh(root, 'git push -q origin main');
  ok(wf(root, ['doctor', '--runtime', 'codex', '--no-steps', '--attempt', id]));
  const s = state(root, id);
  assert.equal(s.adapterBase, admission);
  assert.equal(s.adapterPin, sh(root, 'git rev-parse HEAD'));
  const h = ok(wf(root, ['handoff', 'planner', '--agent', 'planner-new', '--runtime', 'codex', '--attempt', id, '--json'])).json();
  assert.equal(h.model, 'future-planner');
  assert.equal(h.effort, 'high');
  assert.equal(h.class, 'planning', 'admission class semantics stay frozen (0.7.22: the planner\'s own class)');
  assert.equal(ok(wf(root, ['models', 'refresh', '--attempt', id, '--json'])).json().changed, false, 'nothing left to refresh');
  assert.equal(wf(root, ['models', 'refresh', '--model', 'arbitrary', '--attempt', id]).code, 75);
  assert.equal(wf(root, ['handoff', 'planner', '--model', 'arbitrary', '--agent', 'bad', '--attempt', id]).code, 75);
});

test('I-44, I-151: a handoff keeps the execution settings it was made with; later handoffs take the adapter the attempt follows, its role appendix included', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const { trustedAdapter } = await import('../engine/config.mjs');
  const initial = { classes: { review: { codex: { model: 'legacy-model', effort: 'low' } }, planning: { codex: { model: 'legacy-model', effort: 'low' } } }, gate: { steps: [{ id: 'unit', repo: 'app', run: 'true' }] } };
  const { base, root } = singleRepoProject('runtime-handoff-pin', initial);
  const id = ok(wf(root, ['entry', '--item', 'ENG-83', '--json'])).json().id;
  ok(wf(root, ['handoff', 'planner', '--agent', 'old', '--runtime', 'codex', '--attempt', id]));
  const original = state(root, id).handoffs[0];
  const admitted = trustedAdapter(root, state(root, id));
  const cfg = { version: 1, enabled: true, name: 'runtime-handoff-pin', repos: [{ name: 'app', path: '.', base: 'main' }], ...initial,
    classes: { planning: { use: 'Different plan instructions must not be imported', codex: { model: 'new-planner', effort: 'high' } }, review: { codex: { model: 'new-reviewer', effort: 'high' } } },
    roles: { planner: { class: 'planning', appendix: 'new.md' } },
    gate: { steps: [{ id: 'unsafe', repo: 'app', run: 'false' }] }, tracker: { kind: 'none', statuses: { ready: 'untrusted' } }, review: { requireScreenshots: false },
  };
  commitIn(root, { '.workflow/project.yaml': yaml(cfg), '.workflow/new.md': 'Newer role instructions committed on the base branch.' });
  sh(root, 'git push -q origin main');
  assert.deepEqual(state(root, id).handoffs[0], original);
  assert.notDeepEqual(trustedAdapter(root, state(root, id)), admitted, 'the attempt reads the adapter its base branch holds now');
  assert.equal(trustedAdapter(root, state(root, id)).roles.planner.appendix, 'new.md');
  ok(wf(root, ['handoff', 'planner', '--agent', 'new', '--runtime', 'codex', '--attempt', id]));
  const bin = path.join(base, 'bin');
  fs.mkdirSync(bin);
  const probe = path.join(base, 'launch.json');
  const mock = [
    '#!/usr/bin/env node',
    "import fs from 'node:fs';",
    'fs.readFileSync(0,"utf8");',
    'fs.writeFileSync(' + JSON.stringify(probe) + ',JSON.stringify(process.argv.slice(2)));',
    'console.log(JSON.stringify({type:"thread.started",thread_id:process.env.NATIVE_SESSION}));',
    'console.log(JSON.stringify({type:"turn.completed"}));',
    'process.exit(process.env.NATIVE_FAIL ? 1 : 0);',
  ].join('\n');
  fs.writeFileSync(path.join(bin, 'codex'), mock, { mode: 0o755 });
  const env = { PATH: bin + path.delimiter + process.env.PATH, NATIVE_SESSION: '01a110b4-1637-7a42-b353-d0ad25e60100' };
  ok(wf(root, ['handoff', 'run', '--agent', 'old', '--attempt', id], { env }));
  assert.ok(JSON.parse(fs.readFileSync(probe)).includes('legacy-model'));
  ok(wf(root, ['handoff', 'run', '--agent', 'new', '--attempt', id], { env: { ...env, NATIVE_SESSION: '01a110b4-1637-7a42-b353-d0ad25e60200' } }));
  const args = JSON.parse(fs.readFileSync(probe));
  assert.ok(args.includes('new-planner'));
  assert.ok(args.includes('model_reasoning_effort="high"'));
  assert.ok(args.some((a) => a.includes('Newer role instructions committed on the base branch.')), 'the role appendix the base branch holds');
  assert.equal(wf(root, ['handoff', 'run', '--agent', 'new', '--model', 'arbitrary', '--attempt', id], { env }).code, 75);
  assert.equal(state(root, id).handoffs[1].launch.status, 'completed');
});
