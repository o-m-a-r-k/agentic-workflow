// A neutral fixture project for 0.8 scenarios: two git repos, each cloned from a bare remote of its own, under one project
// root, with a schema 2 adapter. Nothing here names a real project, tracker, language or branch convention: the repos are
// `server` and `client`, their bases `trunk` and `stable` (so no code can lean on a default branch name), the tracker ids
// `TK-<n>`.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
export const YAML = require('../../engine/vendor/yaml/dist/index.js');

// A fixed identity and no user or system git config, so commits are the same on every machine.
export const gitEnv = (extra = {}) => ({
  ...process.env,
  GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.test', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.test',
  GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
  ...extra,
});

export function git(cwd, args, { allowFail = false, env } = {}) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: gitEnv(env) });
  if (r.status !== 0 && !allowFail) throw new Error(`git ${args.join(' ')} failed in ${cwd}: ${r.stderr || r.stdout}`);
  return allowFail ? r : r.stdout.trim();
}

export const DEFAULT_REPOS = [
  { name: 'server', base: 'trunk', files: { 'src/core/sum.mjs': 'export const sum = (xs) => xs.reduce((a, b) => a + b, 0);\n', 'src/routes/items.controller.mjs': 'export const routes = ["/items"];\n', 'test/sum.spec.mjs': '// spec\n', 'README.md': '# server\n' } },
  { name: 'client', base: 'stable', files: { 'src/pages/items.mjs': 'export const page = "/items";\n', 'src/common/button.mjs': 'export const button = 1;\n', 'scripts/routes-of.mjs': 'export default async (files) => files.some((f) => f.includes("pages/items")) ? ["/items"] : [];\n', 'README.md': '# client\n' } },
];

// The schema 2 adapter for the fixture (raw, as written in YAML). `overrides` replace top-level keys.
export function adapterFor({ name = 'sample', root, repos = DEFAULT_REPOS, location = 'repo', overrides = {} } = {}) {
  const [first, second] = repos;
  return {
    version: 2,
    name,
    ...(location === 'user' ? { root } : {}),
    repos: repos.map((r) => ({
      name: r.name, path: r.name, base: r.base,
      tests: { fast: { run: 'node -e "process.exit(0)"' }, full: { run: 'node -e "process.exit(0)"', lock: { name: 'fixture-suite', count: 1 } } },
      kinds: { tests: ['test/**', '**/*.spec.mjs'], other: ['**/*.md'] },
    })),
    ...(second ? { components: [{ id: second.name, repo: second.name, dependsOn: [{ contract: `${first.name}/src/**/*.controller.mjs` }] }] } : {}),
    invariants: null,
    rules: [],
    ...(second ? { screens: { routes: { repo: second.name, path: 'scripts/routes-of.mjs' }, shared: [`${second.name}/src/common/**`], sentinel: ['/'], langs: [{ lang: 'l1', dir: 'ltr' }, { lang: 'l2', dir: 'rtl' }], viewports: [400, 1200], capture: 'node capture.mjs --out {out} --viewport {viewport} --lang {lang} {routes}' } } : {}),
    review: { diffRead: 'before' },
    risk: [{ id: 'sums', paths: [`${first.name}/src/core/**`], reason: 'computes values written to storage (fixture)', tests: [`${first.name}/test/**`] }],
    ticketing: { tracker: { module: { repo: first.name, path: '.workflow/tracker.mjs' } }, via: 'module', idPattern: '^TK-\\d+$', take: { status: 'Started' }, followUps: { mode: 'file', status: 'Backlog', label: 'found-in-review' } },
    delivery: { landing: 'queue', order: repos.map((r) => r.name), stages: [{ do: 'land' }, { do: 'status', to: 'Ready', comment: 'uat' }] },
    budget: { adapter: { rules: 4, risk: 3, modules: 2, operationWords: 120 } },
    ...overrides,
  };
}

// Make a project: a temporary folder holding `root/` (the repos, and `.workflow/project.yaml` when location is 'repo'),
// `remotes/<repo>.git`, `home/` (WF_USER_DIR's parent and WF_HOST_HOME) and nothing else. Returns its paths, the env a
// scenario passes to `wf`, and small git helpers. `adapter: false` writes no adapter.
export function makeProject({ name = 'sample', repos = DEFAULT_REPOS, location = 'repo', overrides = {}, adapter = true } = {}) {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wf08-')));
  const root = path.join(tmp, 'root');
  const home = path.join(tmp, 'home');
  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  const out = { tmp, root, home, repos: {}, adapterFile: null, env: { WF_USER_DIR: path.join(home, '.agentic-workflow'), WF_HOST_HOME: home, WF_NO_FORWARD: '1' } };
  for (const r of repos) {
    const origin = path.join(tmp, 'remotes', `${r.name}.git`);
    fs.mkdirSync(origin, { recursive: true });
    git(origin, ['init', '--quiet', '--bare', `--initial-branch=${r.base}`]);
    const dir = path.join(root, r.name);
    git(root, ['clone', '--quiet', origin, dir], { allowFail: true }); // an empty remote warns; the clone still exists
    git(dir, ['checkout', '--quiet', '-B', r.base]);
    writeFiles(dir, r.files ?? { 'README.md': `# ${r.name}\n` });
    git(dir, ['add', '-A']);
    git(dir, ['commit', '--quiet', '-m', 'initial']);
    git(dir, ['push', '--quiet', '-u', 'origin', r.base]);
    out.repos[r.name] = { name: r.name, dir, origin, base: r.base };
  }
  if (adapter) out.adapterFile = writeAdapterFile(out, adapterFor({ name, root, repos, location, overrides }), location);
  // Commit files on a repo's current branch (and push with `push: true`). Returns the new commit.
  out.commit = (repo, files, message = 'change', { push = false, cwd } = {}) => {
    const dir = cwd ?? out.repos[repo].dir;
    writeFiles(dir, files);
    git(dir, ['add', '-A']);
    git(dir, ['commit', '--quiet', '-m', message]);
    if (push) git(dir, ['push', '--quiet', 'origin', `HEAD:${out.repos[repo].base}`]);
    return git(dir, ['rev-parse', 'HEAD']);
  };
  // Move a repo's remote base on by one commit from a second clone (another person's push), as a landing race needs.
  out.pushElsewhere = (repo, files, message = 'elsewhere') => {
    const other = path.join(tmp, 'elsewhere', repo);
    if (!fs.existsSync(other)) git(tmp, ['clone', '--quiet', '--branch', out.repos[repo].base, out.repos[repo].origin, other]);
    git(other, ['pull', '--quiet', '--ff-only']);
    writeFiles(other, files);
    git(other, ['add', '-A']);
    git(other, ['commit', '--quiet', '-m', message]);
    git(other, ['push', '--quiet', 'origin', `HEAD:${out.repos[repo].base}`]);
    return git(other, ['rev-parse', 'HEAD']);
  };
  out.head = (repo, cwd) => git(cwd ?? out.repos[repo].dir, ['rev-parse', 'HEAD']);
  out.cleanup = () => fs.rmSync(tmp, { recursive: true, force: true });
  return out;
}

export function writeFiles(dir, files) {
  for (const [rel, content] of Object.entries(files)) {
    const file = path.join(dir, rel);
    if (content === null) {
      fs.rmSync(file, { force: true });
      continue;
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }
}

// Write the adapter where its location says: `<root>/.workflow/project.yaml`, or `<WF_USER_DIR>/projects/<name>.yaml`.
export function writeAdapterFile(project, raw, location = 'repo') {
  const file = location === 'user' ? path.join(project.env.WF_USER_DIR, 'projects', `${raw.name}.yaml`) : path.join(project.root, '.workflow', 'project.yaml');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, YAML.stringify(raw));
  return file;
}
