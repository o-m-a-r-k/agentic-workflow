import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeRepo, ok, OUT_OF_ORDER, planDoc, sh, singleRepoProject, tmp, toAccepted, wf, write } from './helpers.mjs';
import { YAML } from '../engine/util.mjs';

function sampleProject() {
  const base = tmp('onboard');
  const root = path.join(base, 'ws');
  fs.mkdirSync(root);
  makeRepo(path.join(root, 'backend'), {
    'package.json': JSON.stringify({ name: 'backend', scripts: { lint: 'node -e "process.exit(0)"', test: 'node -e "process.exit(0)"' }, dependencies: { '@nestjs/core': '1' }, devDependencies: { jest: '1' } }),
    'package-lock.json': '{}',
    'src/main.ts': 'x',
    'openapi.json': '{}',
    '.env.example': 'DATABASE_PASSWORD=\nJWT_SECRET=\nSTRIPE_API_KEY=\nPORT=3000\n',
  });
  makeRepo(path.join(root, 'platform'), {
    'api/composer.json': '{}',
    'api/phpunit.xml.dist': '<phpunit/>',
    'api/src/A.php': '<?php',
    'front/package.json': JSON.stringify({ name: 'front', scripts: { lint: 'exit 0', build: 'exit 0' }, dependencies: { react: '18' } }),
    'front/src/App.tsx': 'x',
  });
  return { base, root };
}

test('wf init detects repos, packages, components, steps and secrets, and drafts a disabled adapter', () => {
  const { root } = sampleProject();
  const r = ok(wf(root, ['init', '--json'])).json();
  const d = r.detected;
  assert.deepEqual(d.repos.map((x) => x.name).sort(), ['backend', 'platform']);
  const platform = d.repos.find((x) => x.name === 'platform');
  assert.deepEqual(platform.packages.map((p) => p.path).sort(), ['api', 'front'], 'one git root, two packages');
  assert.ok(platform.provision.clone.includes('api/vendor'));
  const kinds = Object.fromEntries(d.components.map((c) => [c.id, c.kind]));
  assert.equal(kinds.backend, 'service');
  assert.equal(kinds.front, 'web');
  assert.ok(d.components.find((c) => c.id === 'backend').provides.some((p) => p.spec === 'openapi.json'));
  const ids = d.steps.map((s) => s.id);
  for (const s of ['backend-lint', 'backend-unit', 'api-phpunit', 'front-lint', 'front-build']) assert.ok(ids.includes(s), `step ${s}`);
  assert.equal(d.steps.find((s) => s.id === 'backend-unit').workers.auto, true, 'jest gets auto workers');
  const keys = Object.fromEntries(d.secrets.map((s) => [s.key, s.kind]));
  assert.equal(keys.JWT_SECRET, 'generated');
  assert.equal(keys.STRIPE_API_KEY, 'provided');
  assert.equal(keys.PORT, undefined, 'non-secret settings are not catalogued');
  const cfg = YAML.parse(fs.readFileSync(path.join(root, '.workflow', 'project.yaml'), 'utf8'));
  assert.equal(cfg.enabled, false);
  assert.equal(wf(root, ['init']).code, 75, 'never overwrites an existing adapter without --force');
});

function onboarded(steps) {
  const { base, root } = singleRepoProject('doctor', { enabled: false, gate: { steps } });
  return { base, root };
}

test('wf doctor runs light steps on a clean base and tells config errors from red tests', () => {
  const good = onboarded([{ id: 'ok', repo: 'app', run: 'true', tier: 'light' }]);
  ok(wf(good.root, ['doctor']));
  const bad = onboarded([
    { id: 'typo', repo: 'app', run: 'definitely-not-a-command-xyz', tier: 'light' },
    { id: 'red', repo: 'app', run: 'exit 3', tier: 'light' },
    { id: 'heavy', repo: 'app', run: 'exit 9', tier: 'heavy' },
  ]);
  const r = wf(bad.root, ['doctor', '--json']);
  assert.equal(r.code, 1);
  const steps = Object.fromEntries(JSON.parse(r.out).steps.map((s) => [s.step, s]));
  assert.equal(steps.typo.kind, 'config');
  assert.equal(steps.red.kind, 'red-baseline');
  assert.equal(steps.heavy, undefined, 'heavy steps are not run by doctor');
  assert.equal(fs.existsSync(path.join(bad.root, '.wf-worktrees')) && fs.readdirSync(path.join(bad.root, '.wf-worktrees')).length, 0, 'doctor cleans its worktrees');
});

test('enable writes the AGENTS.md block and role agents; disable removes the block; status --quiet reflects it', () => {
  const { root } = onboarded([{ id: 'ok', repo: 'app', run: 'true' }]);
  write(root, 'AGENTS.md', '# Existing rules\n\nKeep me.\n');
  assert.equal(wf(root, ['status', '--quiet']).code, 3);
  ok(wf(root, ['enable']));
  assert.equal(wf(root, ['status', '--quiet']).code, 0);
  const agents = fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8');
  assert.match(agents, /Keep me\./);
  assert.match(agents, /agentic-workflow:begin[\s\S]*wf entry[\s\S]*agentic-workflow:end/);
  for (const f of ['.claude/agents/wf-reviewer.md', '.codex/agents/wf-reviewer.toml', '.claude/agents/wf-implementer.md']) assert.ok(fs.existsSync(path.join(root, f)), f);
  assert.match(fs.readFileSync(path.join(root, '.claude/agents/wf-reviewer.md'), 'utf8'), /^---\nname: wf-reviewer\n/);
  ok(wf(root, ['enable']));
  assert.equal((fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8').match(/agentic-workflow:begin/g) ?? []).length, 1, 'block is replaced, not duplicated');
  ok(wf(root, ['disable']));
  const after = fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8');
  assert.doesNotMatch(after, /agentic-workflow:begin/);
  assert.match(after, /Keep me\./);
  assert.equal(wf(root, ['entry', '--item', 'X-1']).code, 75, 'disabled projects refuse work');
});

test('sync vendors required skills for every runtime; a reviewer handoff needs them', () => {
  const { base, root } = singleRepoProject('skills', {
    requires: { skills: [{ name: 'ui-review', roles: ['reviewer'], vendor: 'skills/ui-review' }] },
    gate: { steps: [{ id: 'ok', repo: 'app', run: 'true' }] },
  }, { '.workflow/skills/ui-review/SKILL.md': '---\nname: ui-review\n---\nCheck contrast.\n' });
  const e = toAcceptedUntilGate(root, base);
  const refused = wf(root, ['handoff', 'reviewer', '--agent', 'r', '--attempt', e.id, '--runtime', 'codex']);
  assert.equal(refused.code, 75);
  assert.match(refused.err, /skill `ui-review` is not available to codex/);
  ok(wf(root, ['sync']));
  assert.ok(fs.existsSync(path.join(root, '.claude/skills/ui-review/SKILL.md')));
  assert.ok(fs.existsSync(path.join(root, '.agents/skills/ui-review/SKILL.md')));
  ok(wf(root, ['handoff', 'reviewer', '--agent', 'r', '--attempt', e.id, '--runtime', 'codex']));
});

function toAcceptedUntilGate(root, base) {
  const e = ok(wf(root, ['entry', '--item', 'S-1', '--owner', 'o', '--json'])).json();
  ok(wf(root, ['handoff', 'planner', '--agent', 'p', '--attempt', e.id]));
  const crit = path.join(base, 'c.json');
  fs.writeFileSync(crit, JSON.stringify(planDoc({ criteria: [{ id: 'C1', text: 't' }] })));
  ok(wf(root, ['plan', '--file', crit, '--attempt', e.id]));
  ok(wf(root, ['handoff', 'implementer', '--agent', 'i', '--attempt', e.id]));
  write(e.repos.app.worktree, 'src/a.txt', 'z\n');
  sh(e.repos.app.worktree, 'git add -A && git commit -q -m z');
  ok(wf(root, ['gate', ...OUT_OF_ORDER, '--attempt', e.id]));
  return e;
}

test('secrets init generates what can be generated; status never prints values', () => {
  const { root } = singleRepoProject('gen', { gate: { steps: [] } }, { '.workflow/secrets.yaml': YAML.stringify({ keys: [{ key: 'JWT_SECRET', kind: 'generated' }, { key: 'TEST_KEY', kind: 'test', from: '.env.example' }, { key: 'VENDOR_TOKEN', kind: 'provided', required: true }] }), '.env.example': 'TEST_KEY=sandbox_abc123\n' });
  const r = ok(wf(root, ['secrets', 'init', '--json'])).json();
  assert.deepEqual(r.map((x) => x.key).sort(), ['JWT_SECRET', 'TEST_KEY']);
  const env = fs.readFileSync(path.join(root, '.env.local'), 'utf8');
  const jwt = env.match(/JWT_SECRET=(.*)/)[1];
  assert.ok(jwt.length >= 32);
  const status = wf(root, ['secrets', 'status']);
  assert.equal(status.code, 1, 'VENDOR_TOKEN still missing');
  assert.doesNotMatch(status.out, new RegExp(jwt));
  assert.match(status.out, /✗ VENDOR_TOKEN/);
});

test('report summarizes attempts as CSV and HTML', () => {
  const { base, root } = singleRepoProject('report', { gate: { steps: [{ id: 'u', repo: 'app', run: 'true', inputs: ['src/**'] }] } });
  const { id } = toAccepted(root, base, { item: 'R-1' });
  ok(wf(root, ['deliver', '--attempt', id]));
  const csv = path.join(base, 'r.csv');
  const html = path.join(base, 'r.html');
  ok(wf(root, ['report', '--csv', csv, '--html', html]));
  const lines = fs.readFileSync(csv, 'utf8').trim().split('\n');
  assert.match(lines[0], /^project,id,item,lane,phase/);
  assert.match(lines[1], /R-1\.1,R-1,standard,done/);
  assert.match(fs.readFileSync(html, 'utf8'), /R-1\.1/);
});

test('installed skills are found per runtime, and a plugin whose marketplace is gone is reported as not loading', async () => {
  const { findSkill } = await import('../engine/skills.mjs');
  const home = tmp('home');
  const pluginDir = path.join(home, 'pcache', 'ux');
  write(pluginDir, '.claude/skills/ux-check/SKILL.md', '# ux\n');
  write(home, '.claude/plugins/installed_plugins.json', JSON.stringify({ plugins: { 'ux@ux-market': [{ scope: 'user', installPath: pluginDir }] } }));
  write(home, '.claude/settings.json', JSON.stringify({ enabledPlugins: { 'ux@ux-market': true } }));
  write(home, '.codex/skills/ux-check/SKILL.md', '# ux codex\n');
  assert.match(findSkill('/nowhere', 'ux-check', 'claude', home).broken, /marketplace ux-market is not registered/);
  write(home, '.claude/plugins/known_marketplaces.json', JSON.stringify({ 'ux-market': {} }));
  const claude = findSkill('/nowhere', 'ux-check', 'claude', home);
  assert.equal(claude.broken, undefined);
  assert.equal(claude.source, 'plugin ux@ux-market');
  assert.equal(findSkill('/nowhere', 'ux-check', 'codex', home).source, 'user');
  assert.equal(findSkill('/nowhere', 'missing', 'codex', home), null);
});

test('wf --version reports the released plugin version, which package.json matches', () => {
  const plugin = JSON.parse(fs.readFileSync(new URL('../.claude-plugin/plugin.json', import.meta.url), 'utf8')).version;
  const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
  const r = ok(wf(tmp('version'), ['--version']));
  assert.equal(r.out.trim(), plugin);
  assert.equal(pkg, plugin, 'package.json and plugin.json carry the same release version');
});
