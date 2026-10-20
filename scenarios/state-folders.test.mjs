import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ICLOUD_IGNORE, STATE_FOLDERS, ensureGitStateExcludes, mkdirStateDirectory, stateFolderSeams, stateFolderWarnings } from '../engine/state-folders.mjs';
import { makeRepo, sh, tmp } from './plain-repo.mjs';
import { gitEnv, makeProject, runWf, writeFiles } from './helpers/index.mjs';

// A one-repo project whose tickets are files, so `wf start` runs with no doubles.
function project() {
  const p = makeProject({
    name: 'folders',
    repos: [{ name: 'app', base: 'trunk', files: { 'src/a.mjs': 'export const a = 1;\n', 'README.md': '# app\n' } }],
    overrides: {
      repos: [{ name: 'app', path: 'app', base: 'trunk', tests: { fast: { run: 'node -e "process.exit(0)"' } }, kinds: { tests: ['test/**'], other: ['**/*.md'] } }],
      ticketing: { tracker: 'files', via: 'files', idPattern: '^TK-\\d+$' },
      delivery: { landing: 'direct', stages: [{ do: 'land' }] },
    },
  });
  writeFiles(p.root, { 'tickets/TK-1.md': '---\nid: TK-1\ntitle: A ticket\nstatus: Todo\n---\nBody.\n' });
  return p;
}

test('new state roots are marked with no-follow before recursive children and first payload writes', () => {
  const root = tmp('state-order'), marked = [];
  stateFolderSeams.platform = 'darwin';
  stateFolderSeams.xattr = (tool, args) => {
    const dir = args.at(-1);
    assert.equal(tool, '/usr/bin/xattr');
    assert.deepEqual(args.slice(0, -1), ['-s', '-w', ICLOUD_IGNORE, '1']);
    assert.deepEqual(fs.readdirSync(dir), [], 'marking must precede child creation');
    marked.push(dir);
    return { status: 0 };
  };
  try {
    for (const name of STATE_FOLDERS) {
      const child = path.join(root, name, 'attempts', 'sample');
      mkdirStateDirectory(child, { recursive: true, mode: 0o700 });
      assert.ok(marked.includes(path.join(root, name)));
      fs.writeFileSync(path.join(child, 'payload'), 'data');
      mkdirStateDirectory(child, { recursive: true });
    }
    assert.equal(marked.length, STATE_FOLDERS.length);
  } finally { stateFolderSeams.platform = null; stateFolderSeams.xattr = null; }
});

test('failed marking refuses payload creation and does not modify existing synced folders or links', () => {
  const root = tmp('state-failure');
  stateFolderSeams.platform = 'darwin';
  stateFolderSeams.xattr = () => ({ status: 1, stderr: 'attribute unavailable' });
  try {
    const folder = path.join(root, STATE_FOLDERS[0]);
    assert.throws(() => mkdirStateDirectory(path.join(folder, 'attempts'), { recursive: true }), /no payload was written/);
    assert.equal(fs.existsSync(folder), false);
    fs.mkdirSync(folder); fs.writeFileSync(path.join(folder, 'old'), 'preserve');
    assert.doesNotThrow(() => mkdirStateDirectory(path.join(folder, 'more'), { recursive: true }));
    assert.equal(fs.readFileSync(path.join(folder, 'old'), 'utf8'), 'preserve');
    const alias = path.join(root, STATE_FOLDERS[2]), outside = path.join(root, 'outside');
    fs.mkdirSync(outside); fs.symlinkSync(outside, alias);
    assert.throws(() => mkdirStateDirectory(path.join(alias, 'child'), { recursive: true }), /link/);
    assert.deepEqual(fs.readdirSync(outside), []);
  } finally { stateFolderSeams.platform = null; stateFolderSeams.xattr = null; }
});

test('state roots actually receive the native macOS ignore attribute', { skip: process.platform !== 'darwin' }, () => {
  const root = tmp('state-native');
  for (const name of STATE_FOLDERS) {
    const folder = path.join(root, name);
    mkdirStateDirectory(path.join(folder, 'child'), { recursive: true });
    const r = spawnSync('/usr/bin/xattr', ['-s', '-p', ICLOUD_IGNORE, folder], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout.trim(), '1');
  }
});

test('CLI marking failures produce a workflow refusal and leave no worktree payload', () => {
  const p = project();
  try {
    const env = { ...gitEnv(), ...p.env };
    for (const key of ['CODEX_THREAD_ID', 'CLAUDE_CODE_SESSION_ID', 'CLAUDECODE', 'GROK_SESSION_ID', 'AI_AGENT']) delete env[key];
    const script = `import { main } from ${JSON.stringify(new URL('../engine/cli.mjs', import.meta.url).href)};
      import { stateFolderSeams } from ${JSON.stringify(new URL('../engine/state-folders.mjs', import.meta.url).href)};
      stateFolderSeams.platform = 'darwin';
      stateFolderSeams.xattr = () => ({status: 1, stderr: 'attribute unavailable'});
      process.exitCode = await main(['start', 'TK-1']);`;
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], { cwd: p.root, env, encoding: 'utf8' });
    assert.equal(r.status, 75, r.stdout + r.stderr);
    assert.match(r.stderr, /wf start: refused: cannot set the iCloud ignore attribute/);
    assert.doesNotMatch(r.stderr, /at .*\.mjs:/);
    assert.equal(fs.existsSync(path.join(p.root, '.wf-worktrees')), false);
  } finally {
    p.cleanup();
  }
});

test('Git state excludes preserve existing ignores, work in linked worktrees and never touch tracked files', () => {
  const root = tmp('state-excludes');
  makeRepo(root, { '.gitignore': STATE_FOLDERS[0] + '/\n', 'file': 'fixture\n' });
  const exclude = path.join(root, '.git', 'info', 'exclude');
  fs.writeFileSync(exclude, '# keep this pattern\nlocal-cache');
  mkdirStateDirectory(path.join(root, STATE_FOLDERS[2], 'sample'), { recursive: true });
  const content = fs.readFileSync(exclude, 'utf8');
  assert.match(content, /^# keep this pattern\nlocal-cache\n/);
  assert.equal(content.includes('/' + STATE_FOLDERS[0] + '/'), false, 'already ignored folders need no duplicate pattern');
  for (const name of STATE_FOLDERS) assert.equal(spawnSync('git', ['check-ignore', '--quiet', '--', name + '/'], { cwd: root }).status, 0);
  assert.deepEqual(ensureGitStateExcludes(root), []);
  assert.equal(fs.readFileSync(exclude, 'utf8'), content);
  assert.equal(sh(root, 'git status --porcelain'), '');
  const linked = path.join(tmp('state-linked'), 'checkout');
  sh(root, `git worktree add --quiet --detach '${linked}' HEAD`);
  // Root patterns match both worktrees because info/exclude belongs to their common Git directory.
  assert.deepEqual(ensureGitStateExcludes(linked), []);
  mkdirStateDirectory(path.join(linked, STATE_FOLDERS[1], 'sample'), { recursive: true });
  assert.equal(sh(linked, 'git status --porcelain'), '');
  assert.equal(fs.readFileSync(exclude, 'utf8'), content);
});

test('Git excludes refuse links and hard links without changing their targets', () => {
  for (const kind of ['symlink', 'hardlink']) {
    const root = tmp('state-exclude-' + kind); makeRepo(root, { 'file': 'fixture' });
    const exclude = path.join(root, '.git', 'info', 'exclude'), target = path.join(tmp('state-outside'), 'keep');
    fs.writeFileSync(target, 'preserve\n'); fs.unlinkSync(exclude);
    if (kind === 'symlink') fs.symlinkSync(target, exclude); else fs.linkSync(target, exclude);
    assert.throws(() => ensureGitStateExcludes(root), /link|regular file with one name/);
    assert.equal(fs.readFileSync(target, 'utf8'), 'preserve\n');
  }
});

test('conflict diagnostics recognize numbered and UUID copies and never read linked siblings', () => {
  const root = tmp('state-conflicts'), uuid = '01234567-89ab-cdef-0123-456789abcdef';
  for (const name of STATE_FOLDERS) {
    fs.mkdirSync(path.join(root, name));
    fs.mkdirSync(path.join(root, name + ' 2')); fs.writeFileSync(path.join(root, name + ' 2', 'data'), 'preserve');
    fs.mkdirSync(path.join(root, name + ' ' + uuid));
    fs.mkdirSync(path.join(root, name + '-backup'));
    fs.symlinkSync(path.join(root, name + ' 2'), path.join(root, name + ' 3'));
  }
  const warnings = stateFolderWarnings(root);
  assert.equal(warnings.filter(w => w.check.startsWith('state folder conflict copies')).length, 4);
  assert.equal(warnings.filter(w => w.check.startsWith('empty evidence folder')).length, 2);
  assert.ok(warnings.every(w => !w.problem.includes('-backup') && !w.problem.includes(' 3')));
  for (const name of STATE_FOLDERS) assert.equal(fs.readFileSync(path.join(root, name + ' 2', 'data'), 'utf8'), 'preserve');
});

test('doctor warns about conflict copies and an empty evidence folder, and changes none of them', () => {
  const p = project();
  try {
    const folder = STATE_FOLDERS[0];
    fs.mkdirSync(path.join(p.root, folder));
    fs.mkdirSync(path.join(p.root, folder + ' 2')); fs.writeFileSync(path.join(p.root, folder + ' 2', 'data'), 'preserve');
    const checks = runWf(p, ['doctor', '--json']).json().checks;
    assert.ok(checks.some(c => c.level === 'warn' && c.check === 'state folder conflict copies: ' + folder), JSON.stringify(checks));
    assert.ok(checks.some(c => c.level === 'warn' && c.check === 'empty evidence folder: ' + folder));
    assert.equal(fs.readFileSync(path.join(p.root, folder + ' 2', 'data'), 'utf8'), 'preserve');
  } finally {
    p.cleanup();
  }
});
