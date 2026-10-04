import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ADAPTER_DIR, CONFIG_FILE, adapterLocation, findRoot, loadConfig, loadConfigAtCommit, repoDir } from './config.mjs';
import { provision } from './attempt.mjs';
import { chooseWorkers } from './host.mjs';
import { missingFor, redactor, status as secretsStatus, stepEnv } from './secrets.mjs';
import { ENGINE_VERSION, WfError, YAML, git, refuse, run, shellQuote } from './util.mjs';

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const exists = (...p) => fs.existsSync(path.join(...p));
const readJsonSafe = (f) => {
  try {
    return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch {
    return null;
  }
};

// ---------- registry of enabled projects (for `wf status --all`) ----------
const registryFile = () => path.join(process.env.WF_CONFIG_HOME ?? path.join(os.homedir(), '.config', 'agentic-workflow'), 'projects.json');
export function registry() {
  return readJsonSafe(registryFile()) ?? { projects: [] };
}
export function register(root, enabled) {
  const r = registry();
  r.projects = r.projects.filter((p) => p.root !== root);
  if (enabled) r.projects.push({ root, registeredAt: new Date().toISOString() });
  fs.mkdirSync(path.dirname(registryFile()), { recursive: true });
  fs.writeFileSync(registryFile(), `${JSON.stringify(r, null, 2)}\n`);
}

// ---------- detection ----------
function isGitRoot(dir) {
  return exists(dir, '.git');
}

function defaultBranch(dir) {
  const head = git(dir, ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD'], { allowFail: true });
  if (head) return head.replace('refs/remotes/origin/', '');
  return git(dir, ['branch', '--show-current'], { allowFail: true }) || 'main';
}

function packageManager(dir) {
  if (exists(dir, 'yarn.lock')) return 'yarn';
  if (exists(dir, 'pnpm-lock.yaml')) return 'pnpm';
  if (exists(dir, 'bun.lock') || exists(dir, 'bun.lockb')) return 'bun';
  if (exists(dir, 'package-lock.json')) return 'npm';
  return exists(dir, 'package.json') ? 'npm' : null;
}

const MANIFESTS = ['package.json', 'composer.json', 'pyproject.toml', 'go.mod', 'build.gradle', 'build.gradle.kts', 'Cargo.toml', 'Gemfile'];
const SKIP = new Set(['node_modules', 'vendor', '.git', 'dist', 'build', '.next', 'Pods', '.wf-worktrees', '.wf-evidence', 'coverage', 'tmp', 'var']);

function findPackages(repoPath) {
  const found = [];
  const walk = (dir, depth) => {
    if (depth > 2) return;
    const rel = path.relative(repoPath, dir) || '.';
    if (MANIFESTS.some((m) => exists(dir, m)) || fs.readdirSync(dir).some((f) => f.endsWith('.xcodeproj'))) found.push(rel);
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory() && !SKIP.has(e.name) && !e.name.startsWith('.')) walk(path.join(dir, e.name), depth + 1);
    }
  };
  walk(repoPath, 0);
  // Monorepo: the nested packages plus the root (root lockfile, root config and root scripts belong to it).
  const nested = found.filter((p) => p !== '.');
  return nested.length && found.includes('.') ? ['.', ...nested] : nested.length ? nested : ['.'];
}

function isWorkspaceRoot(dir) {
  const pkg = readJsonSafe(path.join(dir, 'package.json'));
  return Boolean(pkg?.workspaces) || ['pnpm-workspace.yaml', 'lerna.json', 'nx.json', 'turbo.json'].some((f) => exists(dir, f));
}

function stepsFor(repoName, repoPath, pkgPath, sources) {
  const dir = path.join(repoPath, pkgPath);
  const steps = [];
  const id = (s) => `${pkgPath === '.' ? repoName : path.basename(pkgPath)}-${s}`;
  const add = (s, source) => {
    steps.push({ repo: repoName, ...(pkgPath === '.' ? {} : { package: pkgPath }), ...s });
    sources.push({ step: s.id, source });
  };
  const pkg = readJsonSafe(path.join(dir, 'package.json'));
  if (pkg?.scripts) {
    const pm = packageManager(dir) ?? 'npm';
    const runner = pm === 'npm' ? 'npm run' : pm;
    const has = (n) => pkg.scripts[n] !== undefined;
    // Everything in the package counts as input; docs-only changes are skipped through `docsOnly`, and any change a
    // narrower list would miss still forces the step to run.
    const inputs = ['**'];
    if (has('lint')) add({ id: id('lint'), run: `${runner} lint`, inputs, tier: 'light' }, `${pkgPath}/package.json scripts.lint`);
    if (has('typecheck')) add({ id: id('typecheck'), run: `${runner} typecheck`, inputs, tier: 'light' }, `${pkgPath}/package.json scripts.typecheck`);
    if (has('test')) {
      const jest = /jest/.test(pkg.scripts.test) || pkg.devDependencies?.jest || pkg.dependencies?.jest;
      const vitest = /vitest/.test(pkg.scripts.test) || pkg.devDependencies?.vitest;
      const s = { id: id('unit'), run: `${runner} test`, inputs, tier: 'light' };
      if (jest) Object.assign(s, { run: `${runner} test -- --maxWorkers={workers}`, workers: { auto: true, min: 2, max: 8, perWorkerGiB: 2 } });
      if (vitest) Object.assign(s, { run: `${runner} test -- --reporter=default --reporter=junit --outputFile.junit={evidence}/junit.xml`, report: { junit: '{evidence}/junit.xml' } });
      add(s, `${pkgPath}/package.json scripts.test`);
    }
    for (const n of ['test:e2e', 'e2e']) {
      if (has(n)) {
        const playwright = pkg.devDependencies?.['@playwright/test'];
        add({ id: id('e2e'), run: `${runner} ${n}`, tier: 'heavy', ...(playwright ? { lease: 'browser', artifacts: ['test-results/**/*.png'] } : { lease: 'docker' }) }, `${pkgPath}/package.json scripts.${n}`);
        break;
      }
    }
    if (has('build') && !has('test')) add({ id: id('build'), run: `${runner} build`, inputs, tier: 'light' }, `${pkgPath}/package.json scripts.build`);
  }
  if (exists(dir, 'composer.json')) {
    if (exists(dir, 'phpstan.neon') || exists(dir, 'phpstan.dist.neon') || exists(dir, 'phpstan.neon.dist')) add({ id: id('phpstan'), run: 'vendor/bin/phpstan analyse --no-progress', inputs: ['src/**'], tier: 'light' }, `${pkgPath}/phpstan config`);
    if (exists(dir, 'phpunit.xml') || exists(dir, 'phpunit.xml.dist')) add({ id: id('phpunit'), run: 'vendor/bin/phpunit --log-junit {evidence}/phpunit.xml', report: { junit: '{evidence}/phpunit.xml' }, inputs: ['src/**', 'tests/**', 'config/**'], tier: 'light' }, `${pkgPath}/phpunit.xml`);
    if (exists(dir, 'codeception.yml')) add({ id: id('codecept'), run: 'vendor/bin/codecept run --xml', report: { junit: 'tests/_output/report.xml' }, tier: 'heavy', lease: 'docker' }, `${pkgPath}/codeception.yml`);
  }
  if (exists(dir, 'pyproject.toml') && (exists(dir, 'tests') || /pytest/.test(fs.readFileSync(path.join(dir, 'pyproject.toml'), 'utf8')))) add({ id: id('pytest'), run: 'pytest --junitxml={evidence}/pytest.xml', report: { junit: '{evidence}/pytest.xml' }, inputs: ['**/*.py'], tier: 'light' }, `${pkgPath}/pyproject.toml`);
  if (exists(dir, 'go.mod')) add({ id: id('go-test'), run: 'go test ./...', inputs: ['**/*.go', 'go.mod', 'go.sum'], tier: 'light' }, `${pkgPath}/go.mod`);
  if (exists(dir, 'gradlew')) add({ id: id('gradle-test'), run: './gradlew test', report: { junit: '**/build/test-results/**/*.xml' }, tier: 'heavy' }, `${pkgPath}/gradlew`);
  const xcode = fs.readdirSync(dir).find((f) => f.endsWith('.xcworkspace') || f.endsWith('.xcodeproj'));
  if (xcode) add({ id: id('xcode-test'), run: `xcodebuild test -${xcode.endsWith('.xcworkspace') ? 'workspace' : 'project'} ${xcode} -scheme CHANGE_ME -destination 'platform=iOS Simulator,name=iPhone 16'`, tier: 'heavy', lease: 'simulator' }, `${pkgPath}/${xcode} (scheme must be set)`);
  return steps;
}

function componentsFor(repoName, repoPath, pkgPath) {
  const dir = path.join(repoPath, pkgPath);
  const name = pkgPath === '.' ? repoName : path.basename(pkgPath);
  const pkg = readJsonSafe(path.join(dir, 'package.json'));
  const deps = { ...(pkg?.dependencies ?? {}), ...(pkg?.devDependencies ?? {}) };
  let kind = 'library';
  if (fs.readdirSync(dir).some((f) => f.endsWith('.xcodeproj'))) kind = 'mobile-ios';
  else if (exists(dir, 'app', 'src', 'main', 'AndroidManifest.xml') || exists(dir, 'AndroidManifest.xml')) kind = 'mobile-android';
  else if (deps['@nestjs/core'] || deps.express || deps.fastify || deps.koa || exists(dir, 'composer.json') || exists(dir, 'go.mod') || exists(dir, 'manage.py')) kind = 'service';
  else if (deps.next || deps.react || deps.vue || deps.svelte || deps['@angular/core']) kind = 'web';
  const specs = [];
  const walk = (d, depth) => {
    if (depth > 3) return;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory() && !SKIP.has(e.name) && !e.name.startsWith('.')) walk(path.join(d, e.name), depth + 1);
      else if (/^(openapi|swagger)[\w.-]*\.(json|ya?ml)$/i.test(e.name) || /\.proto$/.test(e.name) || /^schema\.graphql$/.test(e.name)) specs.push(path.relative(dir, path.join(d, e.name)));
    }
  };
  walk(dir, 0);
  return { id: name, kind, repo: repoName, ...(pkgPath === '.' ? {} : { package: pkgPath }), ...(specs.length ? { provides: specs.map((s) => ({ contract: s.endsWith('.proto') ? 'grpc' : s.endsWith('.graphql') ? 'graphql' : 'http', spec: s })) } : {}) };
}

const GENERATED = /(JWT|SESSION|COOKIE|ENCRYPTION|APP|SIGNING|CSRF)_?(SECRET|KEY)$/i;
const SECRETISH = /(SECRET|TOKEN|PASSWORD|PASS|API_?KEY|PRIVATE|CREDENTIAL|DSN|_KEY)$/i;

function secretsFor(repoName, repoPath) {
  const out = [];
  for (const f of ['.env.example', '.env.sample', '.env.dist', '.env.template']) {
    const file = path.join(repoPath, f);
    if (!fs.existsSync(file)) continue;
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*)$/);
      if (!m || !SECRETISH.test(m[1])) continue;
      out.push({ key: m[1], repo: repoName, kind: GENERATED.test(m[1]) ? 'generated' : 'provided', purpose: '', detectedIn: `${repoName}/${f}` });
    }
    break;
  }
  return out;
}

export function detect(root) {
  const repos = [];
  if (isGitRoot(root)) repos.push({ name: path.basename(root), path: '.' });
  else {
    for (const e of fs.readdirSync(root, { withFileTypes: true })) {
      if (e.isDirectory() && !e.name.startsWith('.') && isGitRoot(path.join(root, e.name))) repos.push({ name: e.name, path: e.name });
    }
  }
  if (!repos.length) throw new WfError(`no git repository at ${root} or in its direct subfolders`);
  const sources = [];
  const steps = [];
  const components = [];
  const secrets = [];
  const compose = [];
  for (const r of repos) {
    const rp = path.join(root, r.path);
    r.base = defaultBranch(rp);
    const pkgs = findPackages(rp);
    const workspace = isWorkspaceRoot(rp);
    r.sharedInfra = workspace ? ['package.json', 'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'tsconfig*.json', '.eslintrc*', 'eslint.config.*'].filter((f) => f.includes('*') || exists(rp, f)) : [];
    r.packages = pkgs.map((p) => {
      const dir = path.join(rp, p);
      const lock = ['yarn.lock', 'pnpm-lock.yaml', 'package-lock.json', 'composer.lock', 'Gemfile.lock', 'poetry.lock', 'go.sum'].filter((l) => exists(dir, l)).map((l) => (p === '.' ? l : `${p}/${l}`));
      return { path: p, sharedInfra: [...lock.map((l) => (p === '.' ? l : path.basename(l))), ...['package.json', 'composer.json', 'docker-compose.yml', 'docker-compose.yaml', 'compose.yaml'].filter((f) => exists(dir, f))], docsOnly: ['**/*.md', 'docs/**'] };
    });
    const clone = [];
    const fingerprint = [];
    const installs = [];
    for (const p of pkgs) {
      const dir = path.join(rp, p);
      const pre = p === '.' ? '' : `${p}/`;
      const pm = packageManager(dir);
      if (pm) {
        clone.push(`${pre}node_modules`);
        const lock = { yarn: 'yarn.lock', pnpm: 'pnpm-lock.yaml', npm: 'package-lock.json', bun: 'bun.lock' }[pm];
        const locked = exists(dir, lock);
        if (locked) fingerprint.push(`${pre}${lock}`);
        // In a workspace monorepo the root install covers every package.
        if (!(workspace && p !== '.')) {
          const cmd = locked ? { yarn: 'yarn install --immutable', pnpm: 'pnpm install --frozen-lockfile', npm: 'npm ci', bun: 'bun install --frozen-lockfile' }[pm] : { yarn: 'yarn install', pnpm: 'pnpm install', npm: 'npm install', bun: 'bun install' }[pm];
          installs.push(p === '.' ? cmd : `(cd ${shellQuote(p)} && ${cmd})`);
        }
      }
      if (exists(dir, 'composer.json')) {
        clone.push(`${pre}vendor`);
        if (exists(dir, 'composer.lock')) fingerprint.push(`${pre}composer.lock`);
        installs.push(`(cd ${shellQuote(p)} && composer install --no-interaction)`);
      }
      if (exists(dir, 'Podfile')) {
        clone.push(`${pre}Pods`);
        if (exists(dir, 'Podfile.lock')) fingerprint.push(`${pre}Podfile.lock`);
        installs.push(`(cd ${shellQuote(p)} && pod install)`);
      }
      steps.push(...stepsFor(r.name, rp, p, sources));
      if (!(workspace && p === '.')) components.push(componentsFor(r.name, rp, p));
      for (const f of ['docker-compose.yml', 'docker-compose.yaml', 'compose.yaml']) if (exists(dir, f)) compose.push(`${r.name}/${pre}${f}`);
    }
    const ignored = ['.env.local', '.env'].filter((f) => exists(rp, f));
    r.provision = { clone, fingerprint, install: installs.length ? installs.join(' && ') : null, copyIgnored: ignored };
    secrets.push(...secretsFor(r.name, rp));
  }
  if (new Set(components.map((c) => c.id)).size !== components.length) components.forEach((c) => (c.id = `${c.repo}-${c.id}`));
  // Workspace packages that depend on each other: a change in the provider re-runs the consumer's steps.
  for (const c of components) {
    const repo = repos.find((r) => r.name === c.repo);
    const pkg = readJsonSafe(path.join(root, repo.path, c.package ?? '.', 'package.json'));
    const deps = Object.keys({ ...(pkg?.dependencies ?? {}), ...(pkg?.devDependencies ?? {}), ...(pkg?.peerDependencies ?? {}) });
    for (const other of components) {
      if (other === c || other.repo !== c.repo) continue;
      const name = readJsonSafe(path.join(root, repo.path, other.package ?? '.', 'package.json'))?.name;
      if (name && deps.includes(name)) (c.dependsOn ??= []).push({ component: other.id, via: 'package', contract: path.posix.join(repo.path, other.package ?? '.', '**') });
    }
  }
  return { root, repos, steps, components, secrets, compose, sources, agentsMd: repos.map((r) => ({ repo: r.name, exists: exists(root, r.path, 'AGENTS.md') })) };
}

export function writeDraft(root, detected, { force = false } = {}) {
  const dir = path.join(root, ADAPTER_DIR);
  const file = path.join(dir, CONFIG_FILE);
  if (fs.existsSync(file) && !force) throw refuse(`${file} already exists`, 'pass --force to overwrite, or edit it directly');
  const multi = detected.repos.length > 1 || detected.repos[0].path !== '.';
  // Multi-repo workspace: the adapter lives in the first repo (so the gate can read it at a base commit) and the
  // workspace root links to it.
  const adapterHome = multi ? path.join(root, detected.repos[0].path, ADAPTER_DIR) : dir;
  if (multi) {
    if (fs.existsSync(path.join(adapterHome, CONFIG_FILE)) && !force) throw refuse(`${path.join(adapterHome, CONFIG_FILE)} already exists`, 'pass --force to overwrite, or edit it directly');
    fs.mkdirSync(adapterHome, { recursive: true });
    if (!fs.existsSync(dir)) fs.symlinkSync(path.relative(root, adapterHome), dir);
  }
  const draft = {
    version: 1,
    enabled: false,
    name: path.basename(root),
    engine: '0.x',
    ...(multi ? { adapterRepo: detected.repos[0].name } : {}),
    repos: detected.repos.map((r) => ({ name: r.name, path: r.path, base: r.base, ...(r.sharedInfra?.length ? { sharedInfra: r.sharedInfra } : {}), packages: r.packages, provision: r.provision })),
    components: detected.components,
    lanes: ['quick', 'standard'],
    tracker: { kind: 'none' },
    delivery: { kind: 'push-main' },
    gate: { maxParallelSteps: 2, leases: { docker: 1, browser: 1, simulator: 1 }, steps: detected.steps },
    invariants: 'AGENTS.invariants.md',
  };
  fs.mkdirSync(dir, { recursive: true });
  const header = `# agentic-workflow adapter, drafted by \`wf init\` on ${new Date().toISOString().slice(0, 10)}.\n# Review every value, then run \`wf doctor\` and \`wf enable\`.\n`;
  fs.writeFileSync(file, header + YAML.stringify(draft, { lineWidth: 0, aliasDuplicateObjects: false }));
  if (detected.secrets.length && !fs.existsSync(path.join(dir, 'secrets.yaml'))) {
    fs.writeFileSync(path.join(dir, 'secrets.yaml'), `# Names only. Values are entered with \`wf secrets guide\` and never committed.\n${YAML.stringify({ keys: detected.secrets.map(({ detectedIn, ...k }) => ({ ...k, usedBy: [], obtain: { url: '', steps: [] } })) })}`);
  }
  if (!fs.existsSync(path.join(dir, 'AGENTS.invariants.md'))) {
    fs.writeFileSync(path.join(dir, 'AGENTS.invariants.md'), '# Project invariants\n\nRules every agent must keep in this project (security, data, contracts, product stage).\n\n- Product stage: pre-launch | live (choose one and say what it means for compatibility)\n');
  }
  if (multi) return file; // evidence and worktrees live at the workspace root, outside every repo
  const ignoreTarget = path.join(root, '.gitignore');
  const ignore = fs.existsSync(ignoreTarget) ? fs.readFileSync(ignoreTarget, 'utf8') : '';
  const add = ['.wf-evidence/', '.wf-worktrees/'].filter((l) => !ignore.split('\n').includes(l));
  if (add.length) fs.writeFileSync(ignoreTarget, `${ignore}${ignore && !ignore.endsWith('\n') ? '\n' : ''}${add.join('\n')}\n`);
  return file;
}

// ---------- sync: AGENTS.md block, role agents, vendored skills ----------
const BEGIN = '<!-- agentic-workflow:begin -->';
const END = '<!-- agentic-workflow:end -->';

export function instructionFiles(root, cfg) {
  if (cfg.instructionFiles) return cfg.instructionFiles.map((f) => path.resolve(root, f));
  if (cfg.repos.length === 1 && cfg.repos[0].path === '.') return [path.join(root, 'AGENTS.md')];
  return cfg.repos.map((r) => path.join(repoDir(root, r), 'AGENTS.md'));
}

function agentsBlock(root, cfg) {
  const tpl = fs.readFileSync(path.join(PLUGIN_ROOT, 'templates', 'AGENTS.block.md'), 'utf8');
  const invariants = cfg.invariants && fs.existsSync(path.join(root, ADAPTER_DIR, cfg.invariants)) ? fs.readFileSync(path.join(root, ADAPTER_DIR, cfg.invariants), 'utf8').trim() : '_No project invariants recorded yet._';
  return tpl
    .replace('{project}', cfg.name)
    .replace('{lanes}', cfg.lanes.join(', '))
    .replace('{tracker}', cfg.tracker.kind)
    .replace('{delivery}', cfg.delivery.kind)
    .replace('{invariants}', invariants)
    .trim();
}

export function writeBlock(file, block) {
  const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const wrapped = `${BEGIN}\n${block}\n${END}`;
  let next;
  if (text.includes(BEGIN) && text.includes(END) && text.indexOf(END) > text.indexOf(BEGIN)) next = text.slice(0, text.indexOf(BEGIN)) + wrapped + text.slice(text.indexOf(END) + END.length);
  else next = `${text}${text && !text.endsWith('\n') ? '\n' : ''}${text ? '\n' : ''}${wrapped}\n`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, next);
}

export function removeBlock(file) {
  if (!fs.existsSync(file)) return;
  const text = fs.readFileSync(file, 'utf8');
  if (!text.includes(BEGIN) || !text.includes(END) || text.indexOf(END) < text.indexOf(BEGIN)) return; // never guess at a damaged block
  const next = (text.slice(0, text.indexOf(BEGIN)) + text.slice(text.indexOf(END) + END.length)).replace(/\n{3,}/g, '\n\n');
  if (next.trim()) fs.writeFileSync(file, next.trimEnd() + '\n');
  else fs.rmSync(file);
}

const RUNTIMES = {
  claude: { agents: '.claude/agents', skills: '.claude/skills' },
  codex: { agents: '.codex/agents', skills: '.agents/skills' },
};

export function sync(root) {
  const cfg = loadConfig(root);
  const written = [];
  if (cfg.enabled) {
    const block = agentsBlock(root, cfg);
    for (const f of instructionFiles(root, cfg)) {
      writeBlock(f, block);
      written.push(f);
    }
  }
  const roles = ['planner', 'implementer', 'reviewer', ...(cfg.roles?.tester ? ['tester'] : [])];
  for (const [runtime, dirs] of Object.entries(RUNTIMES)) {
    for (const role of roles) {
      // Role templates live under templates/ so the plugin does not register them as agents in every project.
      const tpl = fs.readFileSync(path.join(PLUGIN_ROOT, 'templates', 'agents', `${role}.md`), 'utf8');
      const rc = cfg.roles?.[role] ?? {};
      const model = rc[runtime]?.model ?? (runtime === 'claude' ? rc.model : null);
      const effort = rc[runtime]?.effort ?? rc.effort;
      const appendix = rc.appendix && fs.existsSync(path.join(root, ADAPTER_DIR, rc.appendix)) ? `\n\n## Project additions\n\n${fs.readFileSync(path.join(root, ADAPTER_DIR, rc.appendix), 'utf8').trim()}\n` : '';
      const front = ['---', `name: wf-${role}`, runtime === 'claude' ? `description: ${tpl.match(/^description: (.*)$/m)?.[1] ?? role}` : null, model ? `model: ${model}` : null, effort ? `effort: ${effort}` : null, runtime === 'claude' && role !== 'implementer' ? 'tools: Read, Grep, Glob, Bash' : null, '---'].filter(Boolean).join('\n');
      const body = tpl.replace(/^---[\s\S]*?---\n/, '');
      const file = path.join(root, dirs.agents, `wf-${role}.md`);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, `${front}\n<!-- generated by \`wf sync\` from agentic-workflow; edit .workflow/ instead -->\n${body.trimEnd()}${appendix}\n`);
      written.push(file);
    }
    for (const s of cfg.requires.skills ?? []) {
      if (!s.vendor) continue;
      const src = path.resolve(root, ADAPTER_DIR, s.vendor.replace(/^\.workflow\//, ''));
      if (!fs.existsSync(src)) continue;
      const dest = path.join(root, dirs.skills, s.name);
      // Replace only copies this command made; a same-named skill someone else installed is left alone.
      if (fs.existsSync(dest) && !fs.existsSync(path.join(dest, '.wf-vendored'))) throw refuse(`${dest} exists and was not installed by \`wf sync\`; rename the skill or remove that folder yourself`);
      fs.rmSync(dest, { recursive: true, force: true });
      fs.cpSync(src, dest, { recursive: true });
      fs.writeFileSync(path.join(dest, '.wf-vendored'), `${s.vendor}\n`);
      written.push(dest);
    }
  }
  return written;
}

export function setEnabled(root, enabled) {
  const file = path.join(root, ADAPTER_DIR, CONFIG_FILE);
  const text = fs.readFileSync(file, 'utf8');
  // Edit the one line so comments and layout survive; fall back to a rewrite only when no line exists.
  let next;
  if (/^enabled:\s*(true|false)\s*$/m.test(text)) next = text.replace(/^enabled:\s*(true|false)\s*$/m, `enabled: ${enabled}`);
  else if (/"enabled"\s*:\s*(true|false)/.test(text)) next = text.replace(/"enabled"\s*:\s*(true|false)/, `"enabled": ${enabled}`);
  else next = YAML.stringify({ ...YAML.parse(text), enabled });
  fs.writeFileSync(file, next);
  const cfg = loadConfig(root);
  if (enabled) sync(root);
  else for (const f of instructionFiles(root, cfg)) removeBlock(f);
  register(root, enabled);
  return cfg;
}

// ---------- doctor ----------
export async function doctor(root, { runSteps = true } = {}) {
  const report = { config: [], tools: [], secrets: [], skills: [], connectors: [], steps: [], ok: true };
  const bad = (section, item) => {
    report[section].push({ ...item, ok: false });
    report.ok = false;
  };
  let cfg;
  try {
    cfg = loadConfig(root);
    report.config.push({ ok: true, check: 'project.yaml is valid' });
  } catch (error) {
    bad('config', { check: 'project.yaml', problem: error.message });
    return report;
  }
  let adapterBase = null;
  try {
    const { repo } = adapterLocation(root, cfg);
    const dir = repoDir(root, repo);
    const hasRemote = git(dir, ['remote']).split('\n').includes(repo.remote);
    if (hasRemote) run('git', ['fetch', '--quiet', repo.remote, repo.base], { cwd: dir, allowFail: true });
    const ref = hasRemote && git(dir, ['rev-parse', '--verify', '--quiet', `${repo.remote}/${repo.base}`], { allowFail: true }) ? `${repo.remote}/${repo.base}` : repo.base;
    adapterBase = git(dir, ['rev-parse', ref], { allowFail: true }) || null;
    if (adapterBase) {
      loadConfigAtCommit(root, cfg, adapterBase);
      report.config.push({ ok: true, check: `adapter committed on ${repo.name} ${ref}` });
    } else bad('config', { check: 'adapter at base', problem: `branch ${repo.base} not found in ${repo.name}` });
  } catch (error) {
    bad('config', { check: 'adapter at base', problem: error.message.split('\n')[0], fix: 'commit .workflow/ on the base branch of the adapter repo and push it; the gate trusts only the adapter on the base it starts from' });
    adapterBase = null;
  }
  const major = ENGINE_VERSION.split('.')[0];
  if (cfg.engine && /^\d+\.x$/.test(cfg.engine) && cfg.engine.split('.')[0] !== major) bad('config', { check: 'engine version', problem: `project pins engine ${cfg.engine}, this is ${ENGINE_VERSION}`, fix: `install agentic-workflow ${cfg.engine} or update the pin` });
  for (const t of cfg.requires.tools ?? []) {
    const r = run('sh', ['-c', t.check ?? `command -v ${t.name}`], { allowFail: true });
    const have = (r.stdout + r.stderr).match(/(\d+)(?:\.(\d+))?/);
    const want = String(t.version ?? '').match(/^>=\s*(\d+)(?:\.(\d+))?/);
    const tooOld = want && have && (Number(have[1]) < Number(want[1]) || (Number(have[1]) === Number(want[1]) && Number(have[2] ?? 0) < Number(want[2] ?? 0)));
    if (r.status === 0 && tooOld) bad('tools', { tool: t.name, problem: `version ${have[0]} is older than ${t.version}`, fix: t.install ?? `upgrade ${t.name}` });
    else if (r.status === 0) report.tools.push({ ok: true, tool: t.name });
    else bad('tools', { tool: t.name, problem: `\`${t.check}\` failed`, fix: t.install ?? `install ${t.name}` });
  }
  for (const s of secretsStatus(root, cfg)) {
    if (s.state === 'filled') report.secrets.push({ ok: true, key: s.key });
    else if (!s.usedBy.length) report.secrets.push({ ok: true, key: s.key, note: `${s.state}; no gate step uses it (set \`usedBy\` in secrets.yaml if one does)` });
    else bad('secrets', { key: s.key, problem: s.state, fix: s.kind === 'generated' || s.kind === 'test' ? 'run `wf secrets init`' : `run \`wf secrets guide ${s.key}\` in your terminal` });
  }
  for (const s of cfg.requires.skills ?? []) {
    for (const [runtime, dirs] of Object.entries(RUNTIMES)) {
      if (fs.existsSync(path.join(root, dirs.skills, s.name, 'SKILL.md'))) report.skills.push({ ok: true, skill: s.name, runtime });
      else bad('skills', { skill: s.name, runtime, problem: 'not installed for this runtime', fix: s.vendor ? 'run `wf sync`' : `install ${s.name} for ${runtime}` });
    }
  }
  for (const c of cfg.requires.connectors ?? []) report.connectors.push({ ok: true, connector: c.name, note: `not checkable from the CLI: the agent confirms ${c.name} with one read-only call` });
  if (runSteps && adapterBase) {
    const id = `_doctor-${Date.now()}`;
    const trusted = loadConfigAtCommit(root, cfg, adapterBase);
    const made = [];
    try {
      for (const repo of trusted.repos) {
        const dir = repoDir(root, repo);
        const wt = path.join(root, '.wf-worktrees', id, repo.name);
        const rref = git(dir, ['rev-parse', '--verify', '--quiet', `${repo.remote}/${repo.base}`], { allowFail: true }) ? `${repo.remote}/${repo.base}` : repo.base;
        run('git', ['worktree', 'add', '--quiet', '--detach', wt, rref], { cwd: dir });
        made.push({ dir, wt });
        provision(root, trusted, repo, wt);
      }
      for (const step of trusted.gate.steps.filter((s) => (s.tier ?? 'light') === 'light')) {
        if (!step.run) {
          report.steps.push({ ok: true, step: step.id, note: 'plugin step: not run by doctor' });
          continue;
        }
        const missing = missingFor(root, trusted, step.id);
        if (missing.length) {
          bad('steps', { step: step.id, problem: `needs secrets ${missing.join(', ')}`, fix: 'wf secrets guide' });
          continue;
        }
        const repo = trusted.repos.find((r) => r.name === step.repo);
        const pkg = step.package ? repo.packages.find((p) => p.path === step.package || p.name === step.package) : repo.packages[0];
        const cwd = path.join(root, '.wf-worktrees', id, repo.name, pkg?.path ?? '.');
        const evidence = path.join(root, '.wf-evidence', 'doctor', id, step.id);
        fs.mkdirSync(evidence, { recursive: true });
        const command = step.run.replace(/\{workers\}/g, String(chooseWorkers(step).n)).replace(/\{evidence\}/g, shellQuote(evidence)).replace(/\{(select|suites)\}/g, '').replace(/\{shards?\}/g, '1');
        if (!fs.existsSync(cwd)) {
          bad('steps', { step: step.id, kind: 'config', problem: `directory ${path.relative(root, cwd)} does not exist at ${repo.base}` });
          continue;
        }
        const r = run('sh', ['-c', command], { cwd, allowFail: true, env: { ...process.env, ...stepEnv(root, trusted, step.id), WF_ROOT: root, WF_EVIDENCE: evidence } });
        const redact = redactor(root, trusted);
        fs.writeFileSync(path.join(evidence, 'output.log'), redact(`${r.stdout}\n${r.stderr}`));
        if (r.status === 0) report.steps.push({ ok: true, step: step.id });
        else {
          const configError = r.status === 127 || /command not found|not found:|No such file or directory|Missing script/i.test(r.stderr + r.stdout);
          bad('steps', { step: step.id, kind: configError ? 'config' : 'red-baseline', problem: `exit ${r.status}`, log: path.join(evidence, 'output.log'), fix: configError ? 'fix the command or path in project.yaml' : 'tests already fail on a clean base: fix them as the first quick fix' });
        }
      }
    } finally {
      for (const m of made) run('git', ['worktree', 'remove', '--force', m.wt], { cwd: m.dir, allowFail: true });
      fs.rmSync(path.join(root, '.wf-worktrees', id), { recursive: true, force: true });
    }
  }
  return report;
}

export { findRoot };
