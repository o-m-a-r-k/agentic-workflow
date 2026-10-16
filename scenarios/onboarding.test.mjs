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

const OLD_BLOCK = '<!-- agentic-workflow:begin -->\n\n## agentic-workflow (old)\n\nOld rules: medium is your judgement.\n<!-- agentic-workflow:end -->\n';

// 0.7.24 (D30): the plugin writes nothing into the project's instruction files; the session rules come from its SessionStart
// hook. Named failure: the block put the plugin's text into each project's AGENTS.md, so a plugin release was a commit in
// every project. The person: "this is part of the workflow plugin or adapter setup. not agents.md".
test('enable writes role agents and nothing into AGENTS.md; a block an older release wrote is removed; status --quiet reflects it', () => {
  const { root } = onboarded([{ id: 'ok', repo: 'app', run: 'true' }]);
  write(root, 'AGENTS.md', '# Existing rules\n\nKeep me.\n');
  assert.equal(wf(root, ['status', '--quiet']).code, 3);
  ok(wf(root, ['enable']));
  assert.equal(wf(root, ['status', '--quiet']).code, 0);
  assert.equal(fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8'), '# Existing rules\n\nKeep me.\n', 'the project\'s file is untouched');
  for (const f of ['.claude/agents/wf-reviewer.md', '.codex/agents/wf-reviewer.toml', '.claude/agents/wf-implementer.md']) assert.ok(fs.existsSync(path.join(root, f)), f);
  assert.match(fs.readFileSync(path.join(root, '.claude/agents/wf-reviewer.md'), 'utf8'), /^---\nname: wf-reviewer\n/);
  // A block an older release wrote, between authored text, is removed and the authored text kept byte for byte.
  write(root, 'AGENTS.md', `# Existing rules\n\nKeep me.\n\n${OLD_BLOCK}\n## Authored appendix\n\nKeep the suffix.\n`);
  const synced = ok(wf(root, ['sync']));
  assert.match(synced.out, /removed the agentic-workflow block an older release wrote from 1 file\(s\); commit the removal \(the rules now come from the plugin\):\n  AGENTS\.md\nwrote \d+ generated file\(s\):/);
  assert.doesNotMatch(synced.out.split('wrote ')[0], /\.claude\/agents/, 'role files are generated, not files a block was removed from');
  assert.equal(fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8'), '# Existing rules\n\nKeep me.\n\n## Authored appendix\n\nKeep the suffix.\n');
  ok(wf(root, ['sync']));
  assert.equal(fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8'), '# Existing rules\n\nKeep me.\n\n## Authored appendix\n\nKeep the suffix.\n', 'a second sync changes nothing');
  write(root, 'AGENTS.md', `# Existing rules\n\n${OLD_BLOCK}`);
  ok(wf(root, ['disable']));
  assert.equal(fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8'), '# Existing rules\n');
  assert.equal(wf(root, ['entry', '--item', 'X-1']).code, 75, 'disabled projects refuse work');
});

test('removing an older release\'s block changes only the block and its seam: fences, CRLF endings, quoted markers and a second block', () => {
  const { root } = onboarded([{ id: 'ok', repo: 'app', run: 'true' }]);
  const file = path.join(root, 'AGENTS.md');
  const fence = '# Rules\n\n```md\n<!-- agentic-workflow:begin -->\nquoted, not a block\n\n\n\nthree blank lines kept\n<!-- agentic-workflow:end -->\n```\n';
  write(root, 'AGENTS.md', `${fence}\n${OLD_BLOCK}\n## Tail   \n`);
  ok(wf(root, ['sync']));
  assert.equal(fs.readFileSync(file, 'utf8'), `${fence}\n## Tail   \n`, 'the fenced example and the trailing spaces stay');
  const crlf = '# Rules\r\n\r\nKeep.\r\n\r\n' + OLD_BLOCK.replace(/\n/g, '\r\n') + '\r\n## More\r\n';
  fs.writeFileSync(file, crlf);
  ok(wf(root, ['sync']));
  assert.equal(fs.readFileSync(file, 'utf8'), '# Rules\r\n\r\nKeep.\r\n\r\n## More\r\n');
  write(root, 'AGENTS.md', `A\n\n${OLD_BLOCK}\nB\n\n${OLD_BLOCK}\nC\n`);
  ok(wf(root, ['sync']));
  assert.equal(fs.readFileSync(file, 'utf8'), 'A\n\nB\n\nC\n');
  // A damaged block (a BEGIN with no END of its own) is left alone, and the authored text after it is never taken.
  const damaged = `# Mine\n\n<!-- agentic-workflow:begin -->\nrules\n\nMiddle, authored.\n\n${OLD_BLOCK}`;
  write(root, 'AGENTS.md', damaged);
  ok(wf(root, ['sync']));
  assert.match(fs.readFileSync(file, 'utf8'), /Middle, authored\./);
});

test('the session rules come from the plugin\'s SessionStart hook, in an enabled project only, with where the adapter keeps its invariants', async () => {
  const { root } = singleRepoProject('session-rules', { enabled: false, invariants: 'AGENTS.invariants.md', gate: { steps: [{ id: 'ok', repo: 'app', run: 'true' }] } }, { '.workflow/AGENTS.invariants.md': '- Money is exact.\n' });
  const { spawnSync } = await import('node:child_process');
  const hook = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'hooks', 'session-rules.mjs');
  const run = (cwd) => spawnSync(process.execPath, [hook], { input: JSON.stringify({ hook_event_name: 'SessionStart', cwd }), encoding: 'utf8', env: { ...process.env, WF_HOME: path.join(root, '..', '.home'), WF_CONFIG_HOME: path.join(root, '..', '.wfhome') } });
  const disabled = run(root);
  assert.equal(disabled.status, 0);
  assert.equal(disabled.stdout, '', 'nothing in a disabled project');
  ok(wf(root, ['enable']));
  const enabled = run(path.join(root, 'src'));
  assert.equal(enabled.status, 0);
  const out = JSON.parse(enabled.stdout).hookSpecificOutput;
  assert.equal(out.hookEventName, 'SessionStart');
  assert.match(out.additionalContext, /^agentic-workflow runs changes in this project \(/);
  assert.match(out.additionalContext, /Reserved decisions \(.*\) are the user's\. Ask them in plain words, one question per item, never one they already answered; a typed answer and the question panel both count\./);
  assert.match(out.additionalContext, /critical invariants \(`\.workflow\/AGENTS\.invariants\.md`\):\n\n- Money is exact\./, 'the adapter\'s own text, as written');
  const hooks = JSON.parse(fs.readFileSync(path.join(path.dirname(hook), 'hooks.json'), 'utf8')).hooks;
  // A subagent gets the same rules when it starts (it does not see its session's SessionStart context).
  const sub = spawnSync(process.execPath, [hook], { input: JSON.stringify({ hook_event_name: 'SubagentStart', cwd: root }), encoding: 'utf8' });
  assert.equal(JSON.parse(sub.stdout).hookSpecificOutput.hookEventName, 'SubagentStart');
  assert.match(hooks.SubagentStart?.[0]?.hooks?.[0]?.command ?? '', /hooks\/session-rules\.mjs/);
  // A role has them in its bundle, whatever its harness.
  const e = ok(wf(root, ['entry', '--item', 'SR-1', '--owner', 'o', '--json'])).json();
  const h = ok(wf(root, ['handoff', 'planner', '--agent', 'p', '--attempt', e.id, '--json'])).json();
  assert.match(JSON.parse(fs.readFileSync(h.bundle, 'utf8')).workflowRules, /^agentic-workflow runs changes in this project/);
  const outside = run(tmp('no-project'));
  assert.equal(outside.stdout, '', 'nothing outside a project');
  assert.match(hooks.SessionStart[0].hooks[0].command, /hooks\/session-rules\.mjs/);
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

test('doctor validates planner and reviewer models for the selected Codex runtime', () => {
  // Named failure I-36: Claude pins made Codex look configured, and Codex-only pins failed Claude-only checks.
  const missing = singleRepoProject('codex-model-missing', { classes: { review: { claude: { model: 'opus' }, codex: { model: null } }, planning: { claude: { model: 'opus' }, codex: { model: null } } } });
  const bad = wf(missing.root, ['doctor', '--runtime', 'codex', '--no-steps', '--json']);
  assert.equal(bad.code, 1);
  assert.equal(bad.json().config.filter((c) => !c.ok && /planner model|reviewer model/.test(c.check)).length, 2);
  assert.match(JSON.stringify(bad.json().config), /codex\.model/);
  const pinned = singleRepoProject('codex-model-pinned', { classes: { review: { claude: { model: null }, codex: { model: 'future-codex-model', effort: 'max' } }, planning: { claude: { model: null }, codex: { model: 'future-codex-model', effort: 'max' } } } });
  const good = ok(wf(pinned.root, ['doctor', '--runtime', 'codex', '--no-steps', '--json'])).json();
  assert.equal(good.config.filter((c) => c.ok && c.runtime === 'codex' && /model: future-codex-model/.test(c.check)).length, 2);
});

test('Codex plugin skills follow the enabled installed version, not the newest cached version', async () => {
  // Named failure I-37: native Codex plugins were invisible to skill lookup and doctor.
  const { findSkill } = await import('../engine/skills.mjs');
  const home = tmp('codex-plugin-home');
  write(home, '.codex/plugins/cache/ux-market/ux/1.0.0/skills/ux-check/SKILL.md', '# installed\n');
  write(home, '.codex/plugins/cache/ux-market/ux/2.0.0/skills/ux-check/SKILL.md', '# cached only\n');
  const provider = { codexPlugins: () => ({ installed: [{ name: 'ux', pluginId: 'ux@ux-market', version: '1.0.0', installed: true, enabled: true }] }) };
  const skill = findSkill('/nowhere', 'ux:ux-check', 'codex', home, provider);
  assert.ok(skill);
  assert.match(skill.path, /ux\/1\.0\.0\/skills\/ux-check\/SKILL\.md$/);
  assert.equal(skill.source, 'plugin ux@ux-market');
  assert.equal(findSkill('/nowhere', 'ux-check', 'codex', home, { codexPlugins: () => ({ installed: [{ name: 'ux', version: '1.0.0', installed: true, enabled: false }] }) }), null);
  assert.equal(findSkill('/nowhere', 'ux-check', 'codex', home, { codexPlugins: () => ({ installed: [] }) }), null);
});

test('wf --version reports the released plugin version, which package.json matches', () => {
  // Named failure I-76: the Codex manifest retained an older version, so installation reused a stale cache.
  const plugin = JSON.parse(fs.readFileSync(new URL('../.claude-plugin/plugin.json', import.meta.url), 'utf8')).version;
  const codex = JSON.parse(fs.readFileSync(new URL('../.codex-plugin/plugin.json', import.meta.url), 'utf8')).version;
  const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
  const r = ok(wf(tmp('version'), ['--version']));
  assert.equal(r.out.trim(), plugin);
  assert.equal(pkg, plugin, 'package.json and plugin.json carry the same release version');
  assert.equal(codex, plugin, 'Codex and Claude manifests carry the same release version');
});

// 0.7.11, named failure: two projects' AGENTS.md carried a rule three releases old ("medium is your judgement") because the
// block was refreshed only by a `wf sync` nobody ran, and an agent escalated the contradiction to the person. Generated files
// git does not track follow the installed plugin by themselves; tracked ones are named with the one command.
test('generated files follow the installed plugin: untracked role files are refreshed at a handoff, a tracked block an older release wrote is named', () => {
  const { root } = onboarded([{ id: 'ok', repo: 'app', run: 'true' }]);
  ok(wf(root, ['enable']));
  write(root, 'AGENTS.md', `# Rules\n\n${OLD_BLOCK}`);
  sh(root, 'git add AGENTS.md && git commit -q -m "an old block"');
  const role = path.join(root, '.claude', 'agents', 'wf-planner.md');
  assert.equal(spawnStatus(root, role), 1, 'the role file is not tracked');
  const e = ok(wf(root, ['entry', '--item', 'ENG-1', '--owner', 'o', '--json'])).json();
  const current = fs.readFileSync(role, 'utf8');
  fs.writeFileSync(role, current.replace('You are the planner', 'You are the old planner'));
  // A role file a person wrote (no generated marker) is theirs: never refreshed.
  const mine = path.join(root, '.claude', 'agents', 'wf-mine.md');
  fs.writeFileSync(mine, 'my own role\n');
  const h = ok(wf(root, ['handoff', 'planner', '--agent', 'p', '--attempt', e.id]));
  assert.match(h.err, /role files refreshed to the installed plugin/);
  assert.equal(fs.readFileSync(role, 'utf8'), current);
  assert.equal(fs.readFileSync(mine, 'utf8'), 'my own role\n');
  assert.match(ok(wf(root, ['resume', '--attempt', e.id])).out, /AGENTS\.md still holds the agentic-workflow block an older release wrote \(the rules now come from the plugin, [^)]+\): run `wf sync` and commit the removal/);
  assert.match(fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8'), /medium is your judgement/, 'a tracked file is never rewritten behind the project');
});
const spawnStatus = (cwd, file) => (sh(cwd, `git ls-files --error-unmatch ${JSON.stringify(path.relative(cwd, file))} >/dev/null 2>&1; echo $?`) === '0' ? 0 : 1);
