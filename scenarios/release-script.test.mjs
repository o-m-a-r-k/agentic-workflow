// 0.7.33 (D83): the maintainer's release is one command (scripts/release.mjs). Named failure: a release was some fifteen commands
// typed by hand after CI, and a step that depends on remembering it (the privacy scan of the range's commit messages, a host's plugin
// update) is the one that slips. Its dry run is tested here: the plan it prints from what is known locally, and that it runs nothing
// (no fetch, no push, no `gh`, no host command, nothing installed). Its check step is run for real on a copy of the plugin with a fake
// `gh`, for the budget (0.8.0, D98): a net growth of the rule-shaped counts that no committed proposal accounts for stops the release
// before anything is pushed. The steps after it talk to GitHub and the hosts and are never run here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { makeRepo, sh, tmp, write } from './plain-repo.mjs';

const SCRIPT = path.join(import.meta.dirname, '..', 'scripts', 'release.mjs');
const manifest = (version) => JSON.stringify({ name: 'agentic-workflow', version, repository: { type: 'git', url: 'https://github.com/example-owner/agentic-workflow.git' } });

test('the release dry run prints every step from local facts, names what each checks, and runs nothing', () => {
  const base = tmp('release-dry');
  const repo = path.join(base, 'plugin');
  const version = '0.9.1';
  makeRepo(repo, { 'package.json': manifest('0.9.0'), '.claude-plugin/plugin.json': JSON.stringify({ version: '0.9.0' }), '.codex-plugin/plugin.json': JSON.stringify({ version: '0.9.0' }) });
  // The dev worktree of this version and one of the previous version, in the folder the settings name.
  const folder = path.join(base, 'wt');
  sh(repo, `git worktree add -q -b dev/${version} ${JSON.stringify(path.join(folder, version))} && git worktree add -q -b dev/0.9.0 ${JSON.stringify(path.join(folder, '0.9.0'))}`);
  const dev = path.join(folder, version);
  for (const f of ['package.json', '.claude-plugin/plugin.json', '.codex-plugin/plugin.json']) write(dev, f, f === 'package.json' ? manifest(version) : JSON.stringify({ version }));
  write(dev, `docs/releases/v${version}.md`, `## ${version} - a release\n`);
  sh(dev, 'git add -A && git commit -q -m "release 0.9.1"');
  const sha = sh(dev, 'git rev-parse HEAD');
  // PATH holds git, and fakes of `gh` and `claude` that record any call; `codex` is not installed.
  const bin = path.join(base, 'bin');
  fs.mkdirSync(bin);
  fs.symlinkSync(sh(base, 'command -v git'), path.join(bin, 'git'));
  const ran = path.join(base, 'ran.log');
  for (const name of ['gh', 'claude']) fs.writeFileSync(path.join(bin, name), `#!/bin/sh\necho "${name} $*" >> ${JSON.stringify(ran)}\n`, { mode: 0o755 });
  const project = path.join(base, 'project-a');
  fs.mkdirSync(project);
  const denylist = path.join(base, 'denylist');
  fs.writeFileSync(denylist, 'some-private-name\n');
  const config = path.join(base, 'release.json');
  fs.writeFileSync(config, JSON.stringify({ syncRoots: [project], worktreeFolder: folder, privacyDenylist: denylist }));
  const homeDir = path.join(base, 'home');
  const refs = () => sh(`${repo}.origin.git`, 'git for-each-ref --format="%(refname) %(objectname)"');
  const before = refs();
  const dry = (extra = [], env = {}) => spawnSync(process.execPath, [SCRIPT, version, '--dry-run', '--config', config, '--repo', repo, ...extra], { cwd: repo, encoding: 'utf8', env: { PATH: bin, HOME: homeDir, ...env } });

  const r = dry([], { GH_TOKEN: 'placeholder-not-a-token' });
  assert.equal(r.status, 0, r.stderr);
  const out = r.stdout;
  const has = (text) => assert.ok(out.includes(text), `the plan says: ${text}\n---\n${out}`);
  has(`release ${version}: the plan (dry run: nothing is fetched, pushed, created or installed)`);
  has(`checkout of main: ${repo}`);
  // 1. check
  has(`git fetch --prune origin   (in ${repo})`);
  has(`origin/release/${version} must equal dev/${version} (locally at ${sha})`);
  has(`package.json, .claude-plugin/plugin.json, .codex-plugin/plugin.json at that commit say ${version}; docs/releases/v${version}.md exists there`);
  has(`node scripts/ci-passed.mjs ${sha}`);
  // 0.8.0 (L13): the improvement history left the shipped tree (it stays in git), so the release checks no improvements/ folder.
  assert.ok(!out.includes('improvements/'), 'the plan names no improvements/ folder');
  has('the budget: the rule-shaped counts at that commit (refusals, commands, events, adapter keys, words) against budget.json on origin/main');
  // 2. privacy
  has(`denylist: ${denylist}\n`);
  has('WF_PRIVACY_DENYLIST=<denylist> node --test scenarios/privacy.test.mjs there (it must run, not skip)');
  has(`every commit of origin/main..${sha}: its message, author and committer, and every line it adds, against the denylist (hits name the commit and line, never the name)`);
  // 3. main
  has(`git merge --ff-only origin/release/${version}   (in ${repo}, which must be clean)`);
  has('git push origin main');
  // 4. github: the token is used, never printed
  has('GH_TOKEN is set');
  assert.ok(!out.includes('placeholder-not-a-token'), 'the token is never printed');
  has(`gh release create v${version} --target ${sha} --title ${version} --notes-file docs/releases/v${version}.md --repo example-owner/agentic-workflow`);
  // 5. install
  const dest = path.join(homeDir, '.local', 'share', 'agentic-workflow', 'releases', version);
  has(`git archive v${version} | tar -x -C ${dest}`);
  has(`node scripts/install.mjs   (in ${dest}: links ~/.local/bin/wf to its bin/wf); its wf --version must say ${version}`);
  // 6. hosts: a host whose CLI is absent is skipped and said
  has('claude plugin marketplace update agentic-workflow\n');
  has('claude plugin update agentic-workflow@agentic-workflow\n');
  has('codex: not found on PATH: skipped');
  // 7. sync, from the settings outside the repository
  has(`node ${path.join(dest, 'bin', 'wf')} sync   (in ${project})`);
  // 8. cleanup: this version's worktree and branch, not the previous version's
  has(`git push origin --delete release/${version}`);
  has(`git worktree remove ${path.join(folder, version)}\n`);
  has(`git branch -d dev/${version}\n`);
  assert.ok(!out.includes(path.join(folder, '0.9.0')), 'another version\'s worktree is left alone');
  // Nothing ran: no host or gh command, no push, nothing installed, every worktree in place.
  assert.equal(fs.existsSync(ran), false, fs.existsSync(ran) ? fs.readFileSync(ran, 'utf8') : '');
  assert.equal(refs(), before, 'the remote is untouched');
  assert.equal(fs.existsSync(path.join(homeDir, '.local')), false, 'nothing installed');
  assert.equal(sh(repo, 'git worktree list --porcelain').split('\n').filter((l) => l.startsWith('worktree ')).length, 3);

  // Without the token, without settings and without a dev branch, the plan says which steps will stop or skip.
  const bare = spawnSync(process.execPath, [SCRIPT, version, '--dry-run', '--config', path.join(base, 'none.json'), '--repo', repo, '--dev', 'dev/none'], { cwd: repo, encoding: 'utf8', env: { PATH: bin, HOME: homeDir } });
  assert.equal(bare.status, 0, bare.stderr);
  for (const text of ['GH_TOKEN is not set: this step will stop', `settings: ${path.join(base, 'none.json')} (missing)`, 'origin/release/0.9.1 must equal dev/none (no such local branch)', `no syncRoots in ${path.join(base, 'none.json')}: skipped`, `no worktreeFolder in ${path.join(base, 'none.json')}: dev worktrees left in place`]) {
    assert.ok(bare.stdout.includes(text), `the plan says: ${text}\n---\n${bare.stdout}`);
  }
  // A version that is not one is refused before anything.
  const wrong = spawnSync(process.execPath, [SCRIPT, 'next', '--dry-run'], { cwd: repo, encoding: 'utf8', env: { PATH: bin, HOME: homeDir } });
  assert.equal(wrong.status, 2);
  assert.match(wrong.stderr, /usage: node scripts\/release\.mjs <version/);
});

// A copy of this plugin's engine, texts and budget as a plugin repo of its own: main holds the released budget, dev/<version> the release.
const PLUGIN = path.join(import.meta.dirname, '..');
function pluginRepo(base, version) {
  const repo = path.join(base, 'plugin');
  const files = { 'package.json': manifest('0.9.0'), '.claude-plugin/plugin.json': JSON.stringify({ version: '0.9.0' }), '.codex-plugin/plugin.json': JSON.stringify({ version: '0.9.0' }) };
  makeRepo(repo, files);
  for (const dir of ['engine', 'templates', 'skills']) fs.cpSync(path.join(PLUGIN, dir), path.join(repo, dir), { recursive: true });
  fs.copyFileSync(path.join(PLUGIN, 'budget.json'), path.join(repo, 'budget.json'));
  sh(repo, 'git add -A && git commit -q -m "0.9.0" && git push -q origin main');
  sh(repo, `git checkout -q -b dev/${version}`);
  for (const f of ['package.json', '.claude-plugin/plugin.json', '.codex-plugin/plugin.json']) write(repo, f, f === 'package.json' ? manifest(version) : JSON.stringify({ version }));
  write(repo, `docs/releases/v${version}.md`, `## ${version} - a release\n`);
  return repo;
}

test('the release stops at its check when the rule-shaped counts grow past the released budget, until a committed proposal accounts for it', () => {
  const base = tmp('release-budget');
  const version = '0.9.1';
  const repo = pluginRepo(base, version);
  // The release adds a refusal id to the contract.
  const contract = path.join(repo, 'engine', 'contract.mjs');
  const text = fs.readFileSync(contract, 'utf8');
  assert.ok(text.includes("'answer:not-person': {"), 'the contract lists its refusals by id');
  fs.writeFileSync(contract, text.replace("'answer:not-person': {", "'merge:extra': { stream: 1, when: 'an added check' },\n  'answer:not-person': {"));
  const release = () => {
    sh(repo, `git add -A && git commit -q -m "release ${version}" && git push -q -f origin dev/${version}:release/${version}`);
    return spawnSync(process.execPath, [SCRIPT, version, '--config', path.join(base, 'none.json'), '--repo', repo], { cwd: repo, encoding: 'utf8', env: { PATH: bin, HOME: path.join(base, 'home') } });
  };
  // PATH: git, and a `gh` that says CI passed on any commit.
  const bin = path.join(base, 'bin');
  fs.mkdirSync(bin);
  fs.symlinkSync(sh(base, 'command -v git'), path.join(bin, 'git'));
  fs.symlinkSync(process.execPath, path.join(bin, 'node'));
  fs.writeFileSync(path.join(bin, 'gh'), '#!/bin/sh\necho \'[{"conclusion":"success","status":"completed","databaseId":1}]\'\n', { mode: 0o755 });
  // main was checked out in the repo itself: the release runs from a separate checkout of main.
  sh(repo, `git worktree add -q ${JSON.stringify(path.join(base, 'main'))} main`);
  const mainBefore = sh(repo, 'git rev-parse refs/remotes/origin/main');

  const grown = release();
  assert.equal(grown.status, 1, grown.stdout + grown.stderr);
  assert.match(grown.stderr, /stopped at step 1 \(check\): the release grows the plugin beyond its budget \(budget\.json on origin\/main\)/);
  assert.match(grown.stderr, /refusals: 1 more than budget\.json \(merge:extra added\); no kept or active proposal accounts for merge:extra/);
  assert.equal(sh(repo, 'git rev-parse refs/remotes/origin/main'), mainBefore, 'nothing was pushed to main');

  // A kept plugin proposal committed in the release accounts for it: the check passes and the run goes on to the next step.
  write(repo, 'proposals/extra-check.json', JSON.stringify({ id: 'P1', scope: 'plugin', source: 'incident', status: 'kept', change: 'an added check', replaces: 'merge:untested', metric: 'rework.share', guard: 'activeMin', adds: { refusals: ['merge:extra'] } }));
  const covered = release();
  assert.match(covered.stdout, /budget: refusals 20, commands \d+, events \d+, adapter keys \d+, words \d+; against origin\/main \(rule-shaped changes, each accounted for\)/);
  assert.match(covered.stdout, /CI passed on/);
  assert.match(covered.stderr, /stopped at step 2 \(privacy\)/);
  assert.equal(sh(repo, 'git rev-parse refs/remotes/origin/main'), mainBefore, 'nothing was pushed to main');
});

test('the changelog reads the improvement history from git once improvements/ has left the shipped tree (0.8.0, L13)', () => {
  const repo = path.join(tmp('changelog'), 'plugin');
  const script = fs.readFileSync(path.join(import.meta.dirname, '..', 'scripts', 'changelog.mjs'), 'utf8');
  makeRepo(repo, {
    'scripts/changelog.mjs': script,
    'docs/releases/v0.9.0.md': '## 0.9.0 - first\n',
    'docs/releases/v0.10.0.md': '## 0.10.0 - second\n',
    'improvements/README.md': '# history\n',
    'improvements/I-1.md': '# I-1: a review read a stale tree\n\n**Fixed in:** 0.9.0\n**Test:** scenarios/a.test.mjs (the case)\n',
    'improvements/I-2.md': '# I-2: a hold was lifted by an agent\n\n**Fixed in:** 0.10.0\n**Test:** scenarios/b.test.mjs\n',
  });
  const run = () => spawnSync(process.execPath, ['scripts/changelog.mjs'], { cwd: repo, encoding: 'utf8' });
  const before = run();
  assert.equal(before.status, 0, before.stderr);
  const expected = fs.readFileSync(path.join(repo, 'CHANGELOG.md'), 'utf8');
  assert.match(expected, /## 0\.10\.0 - second\n\n## 0\.9\.0 - first/);
  assert.match(expected, /\| I-2 \| a hold was lifted by an agent \| 0\.10\.0 \| scenarios\/b\.test\.mjs \|\n\| I-1 \|/);
  assert.doesNotMatch(expected, /\]\(improvements\//, 'no link into the archived folder');
  // The folder leaves the tree, not yet committed: the history is read from HEAD.
  sh(repo, 'git rm -rq improvements');
  fs.rmSync(path.join(repo, 'CHANGELOG.md'));
  const staged = run();
  assert.equal(staged.status, 0, staged.stderr);
  assert.equal(fs.readFileSync(path.join(repo, 'CHANGELOG.md'), 'utf8'), expected, 'the same changelog, read from HEAD');
  // Committed, and a later commit touches something else: read from the tree before the removal.
  sh(repo, 'git commit -qm "archive the improvement history" && echo x > other && git add other && git commit -qm later');
  fs.rmSync(path.join(repo, 'CHANGELOG.md'));
  const after = run();
  assert.equal(after.status, 0, after.stderr);
  assert.match(after.stdout, /2 release\(s\), 2 improvement\(s\)/);
  assert.equal(fs.readFileSync(path.join(repo, 'CHANGELOG.md'), 'utf8'), expected, 'the same changelog, read from git');
});
