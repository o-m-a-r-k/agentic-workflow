// End to end from `wf init`, the way a stranger (or an agent following the skills) would use it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { WF, closureFile, commitIn, criteriaFile, goodClosure, makeRepo, ok, sh, singleRepoProject, state, tmp, wf, write } from './helpers.mjs';
import { YAML } from '../engine/util.mjs';

const testRunner = "const ok=require('../index.js').add(1,2)===3;console.log(ok?'pass':'FAIL');process.exit(ok?0:1)";

function nodeProject() {
  const base = tmp('e2e');
  const root = path.join(base, 'app');
  makeRepo(root, {
    'package.json': JSON.stringify({ name: 'app', scripts: { test: 'node test/add.test.js' } }),
    'index.js': 'exports.add=(a,b)=>a+b\n',
    'test/add.test.js': testRunner,
    'README.md': '# app\n',
  });
  return { base, root };
}

test('a drafted adapter fails the gate when code outside any test folder breaks', () => {
  const { base, root } = nodeProject();
  ok(wf(root, ['init']));
  const draft = YAML.parse(fs.readFileSync(path.join(root, '.workflow', 'project.yaml'), 'utf8'));
  assert.ok(draft.gate.steps.some((s) => s.id === 'app-unit'));
  sh(root, 'git add -A && git commit -q -m adapter && git push -q origin main');
  ok(wf(root, ['doctor']));
  ok(wf(root, ['enable']));
  const e = ok(wf(root, ['entry', '--item', 'E2E-1', '--owner', 'o', '--json'])).json();
  ok(wf(root, ['handoff', 'planner', '--agent', 'p', '--attempt', e.id]));
  ok(wf(root, ['plan', '--file', criteriaFile(base), '--attempt', e.id]));
  ok(wf(root, ['handoff', 'implementer', '--agent', 'i', '--attempt', e.id]));
  commitIn(e.repos.app.worktree, { 'README.md': '# app\nmore docs\n' });
  ok(wf(root, ['gate', '--attempt', e.id]));
  commitIn(e.repos.app.worktree, { 'index.js': 'exports.add=(a,b)=>a-b\n' });
  const g = wf(root, ['gate', '--attempt', e.id, '--json']);
  assert.equal(g.code, 1, 'broken code must fail the gate');
  assert.equal(JSON.parse(g.out).steps.find((s) => s.id === 'app-unit').status, 'failed');
});

test('wf works from inside an attempt worktree', () => {
  const { root } = singleRepoProject('inside', { gate: { steps: [{ id: 'u', repo: 'app', run: 'true' }] } });
  const e = ok(wf(root, ['entry', '--item', 'IN-1', '--owner', 'o', '--json'])).json();
  const r = wf(e.repos.app.worktree, ['resume']);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /IN-1\.1/);
  assert.equal(wf(e.repos.app.worktree, ['status', '--quiet']).code, 0);
});

test('a failed entry leaves nothing behind, so a retry works', () => {
  const { root } = singleRepoProject('rollback', { repos: [{ name: 'app', path: '.', base: 'main', provision: { clone: ['node_modules'], install: 'exit 7' } }], gate: { steps: [] } });
  const first = wf(root, ['entry', '--item', 'RB-1', '--owner', 'o']);
  assert.notEqual(first.code, 0);
  assert.equal(sh(root, 'git branch --list "wf/*"'), '', 'branch removed');
  assert.equal(fs.existsSync(path.join(root, '.wf-worktrees', 'RB-1.1')), false, 'worktree removed');
  fs.writeFileSync(path.join(root, '..', 'ok.flag'), '');
  // the install now passes because the flag exists; a retry admits cleanly
  const cfgFile = path.join(root, '.workflow', 'project.yaml');
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
  cfg.repos[0].provision = { install: 'true', fingerprint: [], clone: ['node_modules'] };
  fs.writeFileSync(cfgFile, JSON.stringify(cfg));
  sh(root, 'git add -A && git commit -q -m fix && git push -q origin main');
  ok(wf(root, ['entry', '--item', 'RB-1', '--owner', 'o']));
});

test('files a step writes into the tree do not block the next gate; abandon removes the worktree', () => {
  const steps = [{ id: 'unit', repo: 'app', run: `printf '<testsuites><testsuite name="s"><testcase name="t"/></testsuite></testsuites>' > junit.xml`, report: { junit: 'junit.xml' }, inputs: ['src/**'] }];
  const { base, root } = singleRepoProject('untracked', { gate: { steps } });
  const e = ok(wf(root, ['entry', '--item', 'UT-1', '--owner', 'o', '--json'])).json();
  ok(wf(root, ['handoff', 'planner', '--agent', 'p', '--attempt', e.id]));
  ok(wf(root, ['plan', '--file', criteriaFile(base), '--attempt', e.id]));
  ok(wf(root, ['handoff', 'implementer', '--agent', 'i', '--attempt', e.id]));
  commitIn(e.repos.app.worktree, { 'src/a.txt': '1\n' });
  ok(wf(root, ['gate', '--attempt', e.id]));
  commitIn(e.repos.app.worktree, { 'src/a.txt': '2\n' });
  ok(wf(root, ['gate', '--attempt', e.id]));
  write(e.repos.app.worktree, 'src/forgot.txt', 'not added\n');
  assert.match(wf(root, ['gate', '--attempt', e.id]).err, /commit changes before the gate/, 'a new untracked file still blocks');
  ok(wf(root, ['abandon', '--reason', 'superseded', '--attempt', e.id]));
  assert.equal(fs.existsSync(e.repos.app.worktree), false);
});

test('init on a workspace monorepo keeps the root package and links dependent packages', () => {
  const base = tmp('mono');
  const root = path.join(base, 'mono');
  makeRepo(root, {
    'package.json': JSON.stringify({ name: 'mono', private: true, workspaces: ['packages/*'], scripts: { lint: 'true' } }),
    'package-lock.json': '{}',
    'tsconfig.base.json': '{}',
    'packages/core/package.json': JSON.stringify({ name: '@m/core', scripts: { test: 'true' } }),
    'packages/web/package.json': JSON.stringify({ name: '@m/web', dependencies: { '@m/core': '*', react: '18' }, scripts: { test: 'true' } }),
  });
  const d = ok(wf(root, ['init', '--json'])).json().detected;
  const repo = d.repos[0];
  assert.deepEqual(repo.packages.map((p) => p.path), ['.', 'packages/core', 'packages/web']);
  assert.ok(repo.sharedInfra.includes('package-lock.json') && repo.sharedInfra.includes('tsconfig*.json'));
  assert.equal(repo.provision.install, 'npm ci', 'one install at the root');
  const web = d.components.find((c) => c.id === 'web');
  assert.deepEqual(web.dependsOn.map((x) => x.component), ['core']);
  const text = fs.readFileSync(path.join(root, '.workflow', 'project.yaml'), 'utf8');
  assert.doesNotMatch(text, /[&*]a\d/, 'no YAML anchors linking steps together');
});

test('init in a multi-repo folder writes the adapter into a repo and links it from the folder', () => {
  const base = tmp('multi');
  const root = path.join(base, 'ws');
  fs.mkdirSync(root);
  makeRepo(path.join(root, 'api'), { 'package.json': JSON.stringify({ name: 'api', scripts: { test: 'true' } }) });
  makeRepo(path.join(root, 'web'), { 'package.json': JSON.stringify({ name: 'web', scripts: { test: 'true' } }) });
  ok(wf(root, ['init']));
  assert.ok(fs.lstatSync(path.join(root, '.workflow')).isSymbolicLink());
  assert.ok(fs.existsSync(path.join(root, 'api', '.workflow', 'project.yaml')));
  sh(path.join(root, 'api'), 'git add -A && git commit -q -m adapter && git push -q origin main');
  ok(wf(root, ['doctor']));
});

test('leases are machine-wide: two gates from different attempts never share a docker slot', async () => {
  const stamp = "node -e \"const f=process.env.WF_CONFIG_HOME+'/../times.txt';require('fs').appendFileSync(f,process.env.WF_ATTEMPT+' '+Date.now()+' start\\n');setTimeout(()=>require('fs').appendFileSync(f,process.env.WF_ATTEMPT+' '+Date.now()+' end\\n'),700)\"";
  const steps = [{ id: 'e2e', repo: 'app', run: stamp, lease: 'docker', inputs: ['src/**'] }];
  const { base, root } = singleRepoProject('machine-lease', { gate: { leases: { docker: 1 }, steps } });
  const ids = [];
  for (const item of ['ML-1', 'ML-2']) {
    const e = ok(wf(root, ['entry', '--item', item, '--owner', 'o', '--json'])).json();
    ok(wf(root, ['handoff', 'planner', '--agent', 'p', '--attempt', e.id]));
    ok(wf(root, ['plan', '--file', criteriaFile(base), '--attempt', e.id]));
    ok(wf(root, ['handoff', 'implementer', '--agent', 'i', '--attempt', e.id]));
    commitIn(e.repos.app.worktree, { 'src/a.txt': `${item}\n` });
    ids.push(e.id);
  }
  const home = path.join(root, '..', '.wfhome');
  const env = { ...process.env, WF_CONFIG_HOME: home };
  delete env.CLAUDE_CODE_SESSION_ID;
  const run = (id) => new Promise((resolve) => spawn(process.execPath, [WF, 'gate', '--attempt', id], { cwd: root, env, stdio: 'ignore' }).on('exit', resolve));
  const codes = await Promise.all(ids.map(run));
  assert.deepEqual(codes, [0, 0]);
  const t = {};
  for (const [a, ts, kind] of fs.readFileSync(path.join(home, '..', 'times.txt'), 'utf8').trim().split('\n').map((l) => l.split(' '))) (t[a] ??= {})[kind] = Number(ts);
  const [x, y] = ids;
  assert.ok(t[x].end <= t[y].start || t[y].end <= t[x].start, 'the two docker steps did not overlap');
});

test('the reviewer hint says what to do with open findings', () => {
  const { base, root } = singleRepoProject('hints', { gate: { steps: [{ id: 'u', repo: 'app', run: 'true' }] } });
  const e = ok(wf(root, ['entry', '--item', 'H-1', '--owner', 'o', '--json'])).json();
  ok(wf(root, ['handoff', 'planner', '--agent', 'p', '--attempt', e.id]));
  ok(wf(root, ['plan', '--file', criteriaFile(base), '--attempt', e.id]));
  ok(wf(root, ['handoff', 'implementer', '--agent', 'i', '--attempt', e.id]));
  commitIn(e.repos.app.worktree, { 'src/a.txt': 'h\n' });
  ok(wf(root, ['gate', '--attempt', e.id]));
  ok(wf(root, ['handoff', 'reviewer', '--agent', 'r', '--attempt', e.id]));
  ok(wf(root, ['review', '--closure', closureFile(base, goodClosure('r', { findings: [{ id: 'F1', severity: 'major', summary: 's', status: 'open', evidence: 'x' }] })), '--attempt', e.id]));
  assert.match(ok(wf(root, ['resume', '--attempt', e.id])).out, /fix the open findings \(F1\)/);
  ok(wf(root, ['review', '--closure', closureFile(base, goodClosure('r')), '--attempt', e.id]));
  assert.match(ok(wf(root, ['resume', '--attempt', e.id])).out, /accept the review: `wf accept`/);
  void state;
});

test('narrow inputs fail closed: a change outside them reruns the step instead of reusing a pass', () => {
  const steps = [{ id: 'app-unit', repo: 'app', run: 'node test/add.test.js', inputs: ['test/**'] }];
  const { base, root } = singleRepoProject('narrow', { gate: { steps } }, { 'index.js': 'exports.add=(a,b)=>a+b\n', 'test/add.test.js': testRunner });
  const e = ok(wf(root, ['entry', '--item', 'N-1', '--owner', 'o', '--json'])).json();
  ok(wf(root, ['handoff', 'planner', '--agent', 'p', '--attempt', e.id]));
  ok(wf(root, ['plan', '--file', criteriaFile(base), '--attempt', e.id]));
  ok(wf(root, ['handoff', 'implementer', '--agent', 'i', '--attempt', e.id]));
  commitIn(e.repos.app.worktree, { 'test/add.test.js': `${testRunner}\n` });
  ok(wf(root, ['gate', '--attempt', e.id]));
  commitIn(e.repos.app.worktree, { 'index.js': 'exports.add=(a,b)=>a-b\n' });
  const g = JSON.parse(wf(root, ['gate', '--attempt', e.id, '--json']).out);
  assert.equal(g.status, 'failed');
  assert.match(g.steps[0].reason ?? '', /outside (this|every) step's inputs/);
});

test('the guard hook resolves relative write targets after cd', async () => {
  const { check } = await import('../hooks/guard-evidence.mjs');
  const blocked = (command, cwd = '/p') => Boolean(check({ cwd, tool_input: { command } }));
  assert.equal(blocked('cd /p/.wf-evidence && echo x > ledger.jsonl'), true);
  assert.equal(blocked('cd .wf-evidence/attempts && rm -f A/ledger.jsonl'), true);
  assert.equal(blocked('echo x >> ledger.jsonl', '/p/.wf-evidence/attempts/A'), true);
  assert.equal(blocked('cd .wf-evidence && cp /tmp/x ./a'), true);
  assert.equal(blocked("cd .wf-evidence && node -e \"require('fs').writeFileSync('x','1')\""), true);
  assert.equal(blocked('cd /p/.wf-evidence && cat a && grep -r FAIL . 2>/dev/null'), false);
  assert.equal(blocked('cp .wf-evidence/a /tmp/x'), false);
  assert.equal(blocked('echo "a > .wf-evidence/x"'), false);
});

test('the guard hook lets interpreters read evidence and still blocks their writes', async () => {
  const { check } = await import('../hooks/guard-evidence.mjs');
  const gateDir = '/p/.wf-evidence/attempts/A/gate';
  const blocked = (command, cwd = gateDir) => Boolean(check({ cwd, tool_input: { command } }));
  // The read-only command the hook refused on a real ticket.
  assert.equal(blocked(`python3 -c "import json,glob; p=sorted(glob.glob('*/progress.json'))[-1]; d=json.load(open(p)); print([s['id'] for s in d['steps']])"`), false);
  assert.equal(blocked(`python3 -c "print(open('/p/.wf-evidence/x.json', 'r', encoding='utf8').read())"`, '/p'), false);
  assert.equal(blocked(`node -e "const d=JSON.parse(require('fs').readFileSync('progress.json','utf8')); console.log(d.steps.length)"`), false);
  assert.equal(blocked(`perl -ne 'print if /FAIL/' output.log`), false);
  assert.equal(blocked(`python3 -c "open('progress.json','w').write('{}')"`), true);
  assert.equal(blocked(`python3 -c "from pathlib import Path; Path('x').open('a')"`), true);
  assert.equal(blocked(`python3 -c "import json; json.dump({}, open('/p/.wf-evidence/x', mode='w'))"`, '/p'), true);
  assert.equal(blocked(`python3 -c "import shutil; shutil.rmtree('A')"`), true);
  assert.equal(blocked(`python3 -c "import os; os.remove('ledger.jsonl')"`), true);
  assert.equal(blocked(`python3 -c "import subprocess; subprocess.run(['rm','x'])"`), true);
  assert.equal(blocked(`python3 -c "m='w'; open('x', m)"`), true, 'a mode that is not a literal counts as a write');
  assert.equal(blocked(`node -e "require('fs').openSync('x','w')"`), true);
  assert.equal(blocked(`node -e "require('fs').rmSync('x')"`), true);
  assert.equal(blocked(`perl -pi -e 's/failed/passed/' output.log`), true);
  assert.equal(blocked(`ruby -e "File.write('x', '1')"`), true);
  assert.equal(blocked(`python3 -c "open('x','w')"`, '/p'), false, 'outside evidence nothing is checked');
});

test('one step with narrow inputs is not reused just because another step covers the changed file', () => {
  const steps = [
    { id: 'lint', repo: 'app', run: 'true', inputs: ['**'] },
    { id: 'unit', repo: 'app', run: 'node test/add.test.js', inputs: ['test/**'] },
  ];
  const { base, root } = singleRepoProject('narrow-two', { gate: { steps } }, { 'index.js': 'exports.add=(a,b)=>a+b\n', 'test/add.test.js': testRunner });
  const e = ok(wf(root, ['entry', '--item', 'N-2', '--owner', 'o', '--json'])).json();
  ok(wf(root, ['handoff', 'planner', '--agent', 'p', '--attempt', e.id]));
  ok(wf(root, ['plan', '--file', criteriaFile(base), '--attempt', e.id]));
  ok(wf(root, ['handoff', 'implementer', '--agent', 'i', '--attempt', e.id]));
  commitIn(e.repos.app.worktree, { 'test/add.test.js': `${testRunner}\n` });
  ok(wf(root, ['gate', '--attempt', e.id]));
  commitIn(e.repos.app.worktree, { 'index.js': 'exports.add=(a,b)=>a-b\n' });
  const g = JSON.parse(wf(root, ['gate', '--attempt', e.id, '--json']).out);
  assert.equal(g.status, 'failed', 'unit must rerun and fail');
  const unit = g.steps.find((s) => s.id === 'unit');
  assert.equal(unit.status, 'failed');
  assert.match(unit.reason, /outside this step's inputs since its last pass: index\.js/);
});

test('files an install creates in a worktree (node_modules, a new lockfile) do not block the gate', () => {
  const steps = [{ id: 'unit', repo: 'app', run: 'true', inputs: ['src/**'] }];
  const { base, root } = singleRepoProject('install-output', { repos: [{ name: 'app', path: '.', base: 'main', provision: { clone: ['node_modules'], install: 'mkdir -p node_modules/x && echo m > node_modules/x/i.js && echo "{}" > package-lock.json' } }], gate: { steps } }, { '.gitignore': '.wf-evidence/\n.wf-worktrees/\n' });
  const e = ok(wf(root, ['entry', '--item', 'IO-1', '--owner', 'o', '--json'])).json();
  ok(wf(root, ['handoff', 'planner', '--agent', 'p', '--attempt', e.id]));
  ok(wf(root, ['plan', '--file', criteriaFile(base), '--attempt', e.id]));
  ok(wf(root, ['handoff', 'implementer', '--agent', 'i', '--attempt', e.id]));
  commitIn(e.repos.app.worktree, { 'src/a.txt': 'x\n' }); // commitIn adds everything: keep provisioning output untracked instead
  sh(e.repos.app.worktree, 'git rm -q --cached -r node_modules package-lock.json && git commit -q -m "keep install output untracked"');
  assert.ok(fs.existsSync(path.join(e.repos.app.worktree, 'node_modules/x/i.js')));
  ok(wf(root, ['gate', '--attempt', e.id]));
  ok(wf(root, ['gate', '--attempt', e.id]));
});

test('a copied node_modules missing a declared dependency is reinstalled, even when lockfiles match', () => {
  const marker = 'echo installed > "$PWD/node_modules/.reinstalled" && mkdir -p node_modules/newdep && echo "{}" > node_modules/newdep/package.json';
  const { root } = singleRepoProject('stale-deps', { repos: [{ name: 'app', path: '.', base: 'main', provision: { clone: ['node_modules'], fingerprint: ['yarn.lock'], install: marker } }], gate: { steps: [] } }, {
    'package.json': JSON.stringify({ name: 'x', dependencies: { olddep: '1', newdep: '1' } }),
    'yarn.lock': 'lock\n',
  });
  // The main checkout's node_modules predates `newdep`.
  write(root, 'node_modules/olddep/package.json', '{}');
  const e = ok(wf(root, ['entry', '--item', 'SD-1', '--owner', 'o', '--json'])).json();
  assert.equal(e.repos.app.provisioned.stale, true);
  assert.equal(e.repos.app.provisioned.installed, true);
  assert.ok(fs.existsSync(path.join(e.repos.app.worktree, 'node_modules', 'newdep', 'package.json')));
});
