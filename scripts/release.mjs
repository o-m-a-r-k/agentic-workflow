#!/usr/bin/env node
// The maintainer's release, as one command once CI is green on the release branch:
//
//   node scripts/release.mjs <version> [--dry-run] [--config <file>] [--dev <branch>] [--repo <dir>]
//
// Named failure: a release was some fifteen commands typed by hand, in order, after CI (the checks, the privacy scan of the range's
// commit messages and added lines, the merge, the tag, the install, two hosts' plugin updates, each project's sync, the cleanup). A
// step that depends on remembering it is the one that slips: a project name copied into a release's files was caught only by a
// reviewer before the push, and the privacy test does not read commit messages at all.
//
// Each step says what it ran and what it saw, and the run stops at the first failure, saying what it left done and what it did not.
// A step already done (main already at the commit, the GitHub release already there, the release already extracted, the branch
// already deleted) is said and skipped, so running the command again after a fix goes on from where it stopped. `--dry-run` prints
// the plan from what is known locally and changes nothing: no fetch, no push, no `gh`, no host command.
//
// The maintainer's own settings live outside the repository, in `~/.agentic-workflow/release.json` (or WF_RELEASE_CONFIG, or
// --config): { "syncRoots": ["<a project root>", ...], "worktreeFolder": "<the folder of the dev worktrees>",
// "privacyDenylist": "<the denylist file>" }. Every field is optional; the denylist defaults to WF_PRIVACY_DENYLIST, then to
// ~/.agentic-workflow/privacy-denylist. The GitHub token comes from the environment (GH_TOKEN) and is never printed.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SCRIPTS = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN = 'agentic-workflow';
const HOSTS = {
  claude: [['plugin', 'marketplace', 'update', PLUGIN], ['plugin', 'update', `${PLUGIN}@${PLUGIN}`]],
  codex: [['plugin', 'marketplace', 'upgrade', PLUGIN], ['plugin', 'add', `${PLUGIN}@${PLUGIN}`]],
};
const VERSION_FILES = ['package.json', '.claude-plugin/plugin.json', '.codex-plugin/plugin.json'];

class Stop extends Error {}
const say = (line = '') => process.stdout.write(`${line}\n`);
const home = (p) => String(p).replace(/^~(?=$|\/)/, os.homedir());

function args(argv) {
  const o = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') o.dryRun = true;
    else if (['--config', '--dev', '--repo'].includes(a)) o[a.slice(2)] = argv[++i];
    else if (a.startsWith('--')) throw new Stop(`unknown option ${a}`);
    else o._.push(a);
  }
  return o;
}

// A command (an argument list, no shell), shown before it runs; its output is returned, and a failure stops the release unless
// `allowFail`.
function call(cmd, argv, { cwd, input, allowFail = false, quiet = false, env, binary = false } = {}) {
  if (!quiet) say(`  $ ${[cmd, ...argv].join(' ')}${cwd ? `   (in ${cwd})` : ''}`);
  const r = spawnSync(cmd, argv, { cwd, input, env: env ?? process.env, encoding: binary ? 'buffer' : 'utf8', maxBuffer: 512 * 1024 * 1024 });
  if (r.error) throw new Stop(`${cmd} could not start: ${r.error.message}`);
  if (r.status !== 0 && !allowFail) throw new Stop(`${[cmd, ...argv].join(' ')} failed (exit ${r.status}): ${String(r.stderr || r.stdout).trim().split('\n').slice(-6).join('\n    ')}`);
  return r;
}
const git = (cwd, argv, opts = {}) => String(call('git', argv, { cwd, quiet: true, allowFail: true, ...opts }).stdout ?? '').trim();
const which = (name) => (process.env.PATH ?? '').split(path.delimiter).filter(Boolean).map((d) => path.join(d, name)).find((p) => {
  try {
    fs.accessSync(p, fs.constants.X_OK);
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}) ?? null;

// What is known without the network: where things are and what the local refs say.
function facts(o) {
  const version = o._[0];
  if (!/^\d+\.\d+\.\d+$/.test(version ?? '')) throw new Stop('usage: node scripts/release.mjs <version, e.g. 0.7.33> [--dry-run] [--config <file>] [--dev <branch>] [--repo <dir>]');
  const repo = path.resolve(o.repo ?? path.join(SCRIPTS, '..'));
  const list = git(repo, ['worktree', 'list', '--porcelain']);
  const worktrees = list.split('\n\n').filter(Boolean).map((block) => ({ path: /^worktree (.+)$/m.exec(block)?.[1], branch: /^branch (.+)$/m.exec(block)?.[1] ?? null })).filter((w) => w.path);
  const main = worktrees.find((w) => w.branch === 'refs/heads/main')?.path ?? null;
  const configFile = home(o.config ?? process.env.WF_RELEASE_CONFIG ?? '~/.agentic-workflow/release.json');
  let config = {};
  if (fs.existsSync(configFile)) {
    try {
      config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
    } catch (e) {
      throw new Stop(`${configFile} is not JSON: ${e.message}`);
    }
  }
  const dev = o.dev ?? `dev/${version}`;
  const devSha = git(repo, ['rev-parse', '--verify', '--quiet', `refs/heads/${dev}`]) || null;
  const folder = config.worktreeFolder ? path.resolve(home(config.worktreeFolder)) : null;
  const real = (p) => {
    try {
      return fs.realpathSync(p);
    } catch {
      return path.resolve(p);
    }
  };
  const ofVersion = (w) => {
    const name = path.basename(w.path);
    const b = String(w.branch ?? '').replace(/^refs\/heads\//, '');
    return name === version || name.startsWith(`${version}-`) || b === `dev/${version}` || b === dev || b === `release/${version}` || b.startsWith(`${version}/`);
  };
  const cleanup = folder ? worktrees.filter((w) => w.path !== main && real(w.path).startsWith(`${real(folder)}${path.sep}`) && ofVersion(w)) : [];
  let pkgRepo = null;
  try {
    pkgRepo = /github\.com[/:]([^/]+\/[^/.]+)/.exec(JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8')).repository?.url ?? '')?.[1] ?? null;
  } catch {}
  return {
    version, repo, main, dev, devSha, configFile, config, worktrees, cleanup, folder, slug: pkgRepo,
    releaseBranch: `release/${version}`, tag: `v${version}`, notes: `docs/releases/v${version}.md`,
    denylist: home(process.env.WF_PRIVACY_DENYLIST ?? config.privacyDenylist ?? '~/.agentic-workflow/privacy-denylist'),
    dest: path.join(os.homedir(), '.local', 'share', PLUGIN, 'releases', version),
    syncRoots: (Array.isArray(config.syncRoots) ? config.syncRoots : []).map((r) => path.resolve(home(r))),
    hosts: Object.fromEntries(Object.keys(HOSTS).map((h) => [h, which(h)])),
    token: Boolean(process.env.GH_TOKEN),
  };
}

// The plan: every step, the commands it runs and what it checks. The dry run prints it; the release follows it.
function plan(f) {
  const sha = f.devSha ?? `<${f.dev}>`;
  const gh = (rest) => ['gh', 'release', ...rest, ...(f.slug ? ['--repo', f.slug] : [])].join(' ');
  return [
    { id: 'check', title: 'the release branch is the dev head, and CI passed on it', lines: [
      `git fetch --prune origin   (in ${f.main ?? '<no checkout of main>'})`,
      `origin/${f.releaseBranch} must equal ${f.dev} (${f.devSha ? `locally at ${f.devSha}` : 'no such local branch'})`,
      `${VERSION_FILES.join(', ')} at that commit say ${f.version}; ${f.notes} exists there; origin/main is an ancestor of it`,
      `node scripts/ci-passed.mjs ${sha}`,
    ] },
    { id: 'privacy', title: 'nothing private in the release', lines: [
      `denylist: ${f.denylist}${fs.existsSync(f.denylist) ? '' : ' (missing: this step will stop)'}`,
      `git worktree add --detach <temporary folder> ${sha}; WF_PRIVACY_DENYLIST=<denylist> node --test scenarios/privacy.test.mjs there (it must run, not skip)`,
      `every commit of origin/main..${sha}: its message, author and committer, and every line it adds, against the denylist (hits name the commit and line, never the name)`,
    ] },
    { id: 'main', title: 'main fast-forwards to the release', lines: [
      `git merge --ff-only origin/${f.releaseBranch}   (in ${f.main ?? '<no checkout of main>'}, which must be clean)`,
      'git push origin main   (the pre-push hook checks CI passed on the commit)',
      `origin/main must then be ${sha}`,
    ] },
    { id: 'github', title: 'the GitHub release and its tag', lines: [
      `GH_TOKEN ${f.token ? 'is set' : 'is not set: this step will stop'}`,
      `${gh(['create', f.tag, '--target', sha, '--title', f.version, '--notes-file', f.notes])}   (skipped when ${f.tag} already exists at ${sha})`,
      `origin's tag ${f.tag} must then name ${sha}`,
    ] },
    { id: 'install', title: 'the release installed here', lines: [
      `git fetch --tags origin; ${f.tag} must name ${sha}`,
      `git archive ${f.tag} | tar -x -C ${f.dest}${fs.existsSync(f.dest) ? '   (exists: reused when its package.json says the same version)' : ''}`,
      `node bin/wf install   (in ${f.dest}); its wf --version must say ${f.version}`,
    ] },
    { id: 'hosts', title: 'the hosts\' plugins updated', lines: Object.entries(HOSTS).flatMap(([h, cmds]) => (f.hosts[h] ? cmds.map((c) => [h, ...c].join(' ')) : [`${h}: not found on PATH: skipped`])) },
    { id: 'sync', title: 'each project synced', lines: f.syncRoots.length ? f.syncRoots.map((r) => `node ${path.join(f.dest, 'bin', 'wf')} sync   (in ${r}${fs.existsSync(r) ? '' : ': missing, this step will stop'})`) : [`no syncRoots in ${f.configFile}: skipped`] },
    { id: 'cleanup', title: 'the release branch and the dev worktrees removed', lines: [
      `git push origin --delete ${f.releaseBranch}; git branch -d ${f.releaseBranch} if it exists here`,
      ...(f.folder ? (f.cleanup.length ? f.cleanup.flatMap((w) => [`git worktree remove ${w.path}`, ...(w.branch ? [`git branch -d ${w.branch.replace(/^refs\/heads\//, '')}`] : [])]) : [`no worktree of ${f.version} under ${f.folder}`]) : [`no worktreeFolder in ${f.configFile}: dev worktrees left in place`]),
    ] },
  ];
}

// The privacy patterns, as scenarios/privacy.test.mjs reads them: a word, or /a regular expression/, case-insensitive.
function denyPatterns(file) {
  return fs.readFileSync(file, 'utf8').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#')).map((l) => {
    const m = /^\/(.+)\/$/.exec(l);
    return m ? new RegExp(m[1], 'i') : new RegExp(`\\b${l.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
  });
}

const STEPS = {
  check(f, s) {
    if (!f.main) throw new Stop('no checkout of main in this repository (`git worktree list` shows none): check main out somewhere first');
    call('git', ['fetch', '--prune', 'origin'], { cwd: f.main });
    const release = git(f.main, ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${f.releaseBranch}`]);
    if (!release) throw new Stop(`origin has no branch ${f.releaseBranch}: push ${f.dev} to it (\`git push origin ${f.dev}:${f.releaseBranch}\`) and run CI on it`);
    if (!f.devSha) throw new Stop(`no local branch ${f.dev} (name the dev branch with --dev)`);
    if (release !== f.devSha) throw new Stop(`origin/${f.releaseBranch} is at ${release}, ${f.dev} at ${f.devSha}: push the dev head to the release branch and run CI on it`);
    s.sha = release;
    say(`  origin/${f.releaseBranch} = ${f.dev} = ${s.sha}`);
    for (const file of VERSION_FILES) {
      const v = (() => {
        try {
          return JSON.parse(git(f.main, ['show', `${s.sha}:${file}`])).version;
        } catch {
          return null;
        }
      })();
      if (v !== f.version) throw new Stop(`${file} at ${s.sha.slice(0, 10)} says ${v ?? 'nothing'}, not ${f.version}`);
    }
    if (call('git', ['cat-file', '-e', `${s.sha}:${f.notes}`], { cwd: f.main, quiet: true, allowFail: true }).status !== 0) throw new Stop(`${f.notes} is not in ${s.sha.slice(0, 10)}`);
    const onMain = git(f.main, ['rev-parse', 'refs/remotes/origin/main']);
    if (onMain !== s.sha && call('git', ['merge-base', '--is-ancestor', onMain, s.sha], { cwd: f.main, quiet: true, allowFail: true }).status !== 0) throw new Stop(`origin/main (${onMain.slice(0, 10)}) is not an ancestor of ${s.sha.slice(0, 10)}: main cannot fast-forward; rebase the release on main and run CI again`);
    say(`  ${VERSION_FILES.join(', ')} say ${f.version}; ${f.notes} is there; origin/main ${onMain === s.sha ? 'is already there' : `(${onMain.slice(0, 10)}) fast-forwards to it`}`);
    call('node', [path.join(SCRIPTS, 'ci-passed.mjs'), s.sha], { cwd: f.main });
    say(`  CI passed on ${s.sha.slice(0, 10)}`);
    return `origin/${f.releaseBranch} = ${f.dev} = ${s.sha.slice(0, 10)}, versions ${f.version}, CI green`;
  },
  privacy(f, s) {
    if (!fs.existsSync(f.denylist)) throw new Stop(`no denylist at ${f.denylist}: the privacy test would skip; create it (one name per line) or set WF_PRIVACY_DENYLIST`);
    const patterns = denyPatterns(f.denylist);
    if (!patterns.length) throw new Stop(`${f.denylist} is empty`);
    const tmp = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'wf-release-'));
    const wt = path.join(tmp, 'tree');
    try {
      call('git', ['worktree', 'add', '--quiet', '--detach', wt, s.sha], { cwd: f.main });
      const r = call('node', ['--test', 'scenarios/privacy.test.mjs'], { cwd: wt, env: { ...process.env, WF_PRIVACY_DENYLIST: f.denylist }, allowFail: true });
      const out = `${r.stdout}${r.stderr}`;
      if (r.status !== 0) throw new Stop(`scenarios/privacy.test.mjs failed on ${s.sha.slice(0, 10)}: ${out.split('\n').filter((l) => /matches|fail/.test(l)).slice(0, 10).join('\n    ')}`);
      if (!/^(?:ℹ|#) pass 1$/m.test(out) || !/^(?:ℹ|#) skipped 0$/m.test(out)) throw new Stop('scenarios/privacy.test.mjs did not run its check (skipped): the denylist was not read');
      say('  the tracked files at the release commit hold no denylisted name');
    } finally {
      call('git', ['worktree', 'remove', '--force', wt], { cwd: f.main, quiet: true, allowFail: true });
      fs.rmSync(tmp, { recursive: true, force: true });
    }
    const range = `refs/remotes/origin/main..${s.sha}`;
    const hits = [];
    const entry = (re) => `denylist entry ${patterns.indexOf(re) + 1}`;
    const log = git(f.main, ['log', '--format=%x01%H%x02%an <%ae>%x02%cn <%ce>%x02%B', range]);
    for (const rec of log.split('\x01').filter(Boolean)) {
      const [sha, author, committer, message] = rec.split('\x02');
      for (const re of patterns) {
        if (re.test(author) || re.test(committer)) hits.push(`${sha.slice(0, 10)} author or committer (${entry(re)})`);
        if (re.test(message ?? '')) hits.push(`${sha.slice(0, 10)} commit message (${entry(re)})`);
      }
    }
    let commit = '';
    let file = '';
    let n = 0;
    for (const line of git(f.main, ['log', '-p', '--no-color', '--no-ext-diff', '--format=%x01%H', range]).split('\n')) {
      if (line.startsWith('\x01')) commit = line.slice(1, 11);
      else if (line.startsWith('+++ ')) file = line.replace(/^\+\+\+ (b\/)?/, '');
      else if (line.startsWith('@@')) n = Number(/\+(\d+)/.exec(line)?.[1] ?? 0) - 1;
      else if (line.startsWith('+')) {
        n += 1;
        for (const re of patterns) if (re.test(line.slice(1))) hits.push(`${commit} ${file}:${n} added (${entry(re)})`);
      } else if (!line.startsWith('-')) n += 1;
    }
    if (hits.length) throw new Stop(`the release range holds denylisted names (history is public once pushed: rewrite it before the release):\n    ${hits.join('\n    ')}`);
    const count = log.split('\x01').filter(Boolean).length;
    say(`  ${count} commit(s) of origin/main..${s.sha.slice(0, 10)}: messages, identities and added lines hold no denylisted name`);
    return `privacy: tracked files and ${count} commit(s) clean`;
  },
  main(f, s) {
    const remote = () => git(f.main, ['ls-remote', 'origin', 'refs/heads/main']).split(/\s/)[0];
    const now = remote();
    say(`  origin's main is at ${now || '(none)'}`);
    if (now === s.sha) {
      if (git(f.main, ['rev-parse', 'HEAD']) !== s.sha) call('git', ['merge', '--ff-only', '--quiet', s.sha], { cwd: f.main });
      say('  already there: skipped');
      return `main already at ${s.sha.slice(0, 10)}`;
    }
    const dirty = git(f.main, ['status', '--porcelain', '--untracked-files=no']);
    if (dirty) throw new Stop(`the checkout of main (${f.main}) has uncommitted changes:\n    ${dirty.split('\n').join('\n    ')}`);
    call('git', ['merge', '--ff-only', `origin/${f.releaseBranch}`], { cwd: f.main });
    if (git(f.main, ['rev-parse', 'HEAD']) !== s.sha) throw new Stop(`main did not reach ${s.sha}`);
    call('git', ['push', 'origin', 'main'], { cwd: f.main });
    const after = remote();
    if (after !== s.sha) throw new Stop(`origin's main is at ${after}, not ${s.sha}, after the push`);
    say(`  origin's main is now ${after}`);
    return `main pushed at ${s.sha.slice(0, 10)}`;
  },
  github(f, s) {
    if (!f.token) throw new Stop('GH_TOKEN is not set: run the release with the token of the account that owns the repository (GH_TOKEN="$(gh auth token --user <account>)")');
    const repo = f.slug ? ['--repo', f.slug] : [];
    const tagOnOrigin = () => {
      const lines = git(f.main, ['ls-remote', '--tags', 'origin', `refs/tags/${f.tag}`, `refs/tags/${f.tag}^{}`]).split('\n').filter(Boolean).map((l) => l.split(/\s+/));
      return (lines.find((x) => x[1].endsWith('^{}')) ?? lines[0])?.[0] ?? null;
    };
    const existing = call('gh', ['release', 'view', f.tag, ...repo, '--json', 'url'], { cwd: f.main, allowFail: true, quiet: true });
    if (existing.status === 0) {
      const at = tagOnOrigin();
      if (at !== s.sha) throw new Stop(`the GitHub release ${f.tag} exists, and its tag names ${at ?? 'nothing'}, not ${s.sha}`);
      say(`  ${f.tag} already released at ${s.sha.slice(0, 10)} (${JSON.parse(existing.stdout).url}): skipped`);
      return `${f.tag} already released`;
    }
    call('gh', ['release', 'create', f.tag, ...repo, '--target', s.sha, '--title', f.version, '--notes-file', f.notes], { cwd: f.main });
    const url = JSON.parse(call('gh', ['release', 'view', f.tag, ...repo, '--json', 'url'], { cwd: f.main, quiet: true }).stdout).url;
    const at = tagOnOrigin();
    if (at !== s.sha) throw new Stop(`the release ${f.tag} was created, but origin's tag names ${at ?? 'nothing'}, not ${s.sha}`);
    say(`  ${url}; tag ${f.tag} = ${s.sha}`);
    return `${f.tag} released (${url})`;
  },
  install(f, s) {
    call('git', ['fetch', '--tags', 'origin'], { cwd: f.main });
    const at = git(f.main, ['rev-parse', '--verify', '--quiet', `${f.tag}^{commit}`]);
    if (at !== s.sha) throw new Stop(`the local tag ${f.tag} names ${at || 'nothing'}, not ${s.sha}`);
    const pkg = path.join(f.dest, 'package.json');
    if (fs.existsSync(f.dest) && fs.readdirSync(f.dest).length) {
      const v = (() => {
        try {
          return JSON.parse(fs.readFileSync(pkg, 'utf8')).version;
        } catch {
          return null;
        }
      })();
      if (v !== f.version) throw new Stop(`${f.dest} exists and holds ${v ? `version ${v}` : 'something else'}: move it aside first`);
      say(`  ${f.dest} already holds ${f.version}: reused`);
    } else {
      fs.mkdirSync(f.dest, { recursive: true });
      say(`  $ git archive ${f.tag} | tar -x -C ${f.dest}`);
      const tar = call('git', ['archive', '--format=tar', f.tag], { cwd: f.main, quiet: true, binary: true });
      call('tar', ['-x', '-C', f.dest], { input: tar.stdout, quiet: true });
    }
    const linked = call('node', ['bin/wf', 'install'], { cwd: f.dest });
    say(`  ${String(linked.stdout).trim()}`);
    const v = String(call('node', ['bin/wf', '--version'], { cwd: f.dest, quiet: true, env: { ...process.env, WF_NO_FORWARD: '1' } }).stdout).trim();
    if (v !== f.version) throw new Stop(`the installed wf says ${v}, not ${f.version}`);
    say(`  wf --version: ${v}`);
    return `installed at ${f.dest}`;
  },
  hosts(f) {
    const done = [];
    for (const [h, cmds] of Object.entries(HOSTS)) {
      if (!f.hosts[h]) {
        say(`  ${h}: not found on PATH: skipped (update its plugin by hand: ${cmds.map((c) => [h, ...c].join(' ')).join(' && ')})`);
        done.push(`${h} skipped (no CLI)`);
        continue;
      }
      for (const c of cmds) {
        const r = call(h, c);
        const last = String(r.stdout || r.stderr).trim().split('\n').filter(Boolean).at(-1);
        if (last) say(`    ${last}`);
      }
      done.push(`${h} updated`);
    }
    return done.join(', ');
  },
  sync(f) {
    if (!f.syncRoots.length) {
      say(`  no syncRoots in ${f.configFile}: skipped`);
      return 'no project to sync';
    }
    for (const r of f.syncRoots) {
      if (!fs.existsSync(r)) throw new Stop(`${r} (syncRoots in ${f.configFile}) does not exist`);
      const out = call('node', [path.join(f.dest, 'bin', 'wf'), 'sync'], { cwd: r });
      say(`    ${String(out.stdout).trim().split('\n').join('\n    ')}`);
    }
    return `${f.syncRoots.length} project(s) synced`;
  },
  cleanup(f) {
    const notes = [];
    if (git(f.main, ['ls-remote', 'origin', `refs/heads/${f.releaseBranch}`])) {
      call('git', ['push', 'origin', '--delete', f.releaseBranch], { cwd: f.main });
      if (git(f.main, ['ls-remote', 'origin', `refs/heads/${f.releaseBranch}`])) throw new Stop(`origin still has ${f.releaseBranch}`);
      notes.push(`origin's ${f.releaseBranch} deleted`);
    } else notes.push(`origin has no ${f.releaseBranch}`);
    say(`  ${notes.at(-1)}`);
    if (git(f.main, ['rev-parse', '--verify', '--quiet', `refs/heads/${f.releaseBranch}`])) call('git', ['branch', '-d', f.releaseBranch], { cwd: f.main });
    if (!f.folder) {
      say(`  no worktreeFolder in ${f.configFile}: dev worktrees left in place`);
      return notes.join('; ');
    }
    const here = fs.realpathSync(process.cwd());
    for (const w of f.cleanup) {
      if (!fs.existsSync(w.path)) {
        call('git', ['worktree', 'prune'], { cwd: f.main });
      } else if (here === fs.realpathSync(w.path) || here.startsWith(`${fs.realpathSync(w.path)}${path.sep}`)) {
        say(`  ${w.path} is where this command runs: left; remove it after (\`git worktree remove ${w.path}\`${w.branch ? ` and \`git branch -d ${w.branch.replace(/^refs\/heads\//, '')}\`` : ''})`);
        notes.push(`${w.path} left (this command runs there)`);
        continue;
      } else {
        const dirty = git(w.path, ['status', '--porcelain']);
        if (dirty) throw new Stop(`${w.path} has changes no commit holds; commit or remove them first:\n    ${dirty.split('\n').join('\n    ')}`);
        call('git', ['worktree', 'remove', w.path], { cwd: f.main });
      }
      if (w.branch) call('git', ['branch', '-d', w.branch.replace(/^refs\/heads\//, '')], { cwd: f.main });
      notes.push(`${path.basename(w.path)} removed`);
    }
    if (!f.cleanup.length) say(`  no worktree of ${f.version} under ${f.folder}`);
    return notes.join('; ');
  },
};

function main() {
  let o;
  let f;
  try {
    o = args(process.argv.slice(2));
    f = facts(o);
  } catch (e) {
    if (!(e instanceof Stop)) throw e;
    process.stderr.write(`release: ${e.message}\n`);
    return 2;
  }
  const steps = plan(f);
  if (o.dryRun) {
    say(`release ${f.version}: the plan (dry run: nothing is fetched, pushed, created or installed)`);
    say(`  repository ${f.repo}; checkout of main: ${f.main ?? 'none'}; settings: ${fs.existsSync(f.configFile) ? f.configFile : `${f.configFile} (missing)`}`);
    steps.forEach((step, i) => {
      say(`${i + 1}. ${step.id}: ${step.title}`);
      for (const line of step.lines) say(`     ${line}`);
    });
    return 0;
  }
  const s = {};
  const done = [];
  for (const [i, step] of steps.entries()) {
    say(`== ${i + 1}/${steps.length} ${step.id}: ${step.title}`);
    try {
      done.push(`${step.id}: ${STEPS[step.id](f, s)}`);
    } catch (e) {
      const why = e instanceof Stop ? e.message : e.stack;
      process.stderr.write(`\nrelease ${f.version} stopped at step ${i + 1} (${step.id}): ${why}\n`);
      process.stderr.write(`done: ${done.length ? `\n  ${done.join('\n  ')}` : 'nothing'}\nnot done: ${steps.slice(i).map((x) => x.id).join(', ')}\n`);
      process.stderr.write(`fix the cause and run \`node scripts/release.mjs ${f.version}\` again: steps already done are seen and skipped.\n`);
      return 1;
    }
  }
  say(`\nrelease ${f.version} done:\n  ${done.join('\n  ')}`);
  return 0;
}

process.exitCode = main();
