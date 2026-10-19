// The onboarding scan (design-0.8 section 5, stream 7): the repos as structural facts. It never writes.
//
// The plugin ships no domain vocabulary. Facts name code shapes only (a decimal type, an outbound client, a migration
// folder, a CI pipeline file, a test script); the areas they sit in are named by the project's own directories, and what the
// project treats as critical is read from its own instruction and invariants documents, quoted as written.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const YAML = require('./vendor/yaml/dist/index.js');

const MAX_BYTES = 1024 * 1024; // larger files are generated or data; reading them would only slow the scan
const SKIP_DIRS = new Set(['.git', 'node_modules', 'vendor', 'dist', 'build', '.next', '.wf-worktrees', '.wf-evidence', 'Pods', '.gradle', 'target', 'coverage']);
const CODE = /\.(m?[jt]sx?|c[jt]s|php|py|rb|go|java|kt|kts|scala|cs|swift|rs|exs?|dart|sql)$/i;
const LOCKFILES = /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|composer\.lock|Gemfile\.lock|poetry\.lock|Cargo\.lock|go\.sum)$/;

// A test file: a tests folder anywhere on its path, or a test/spec suffix.
export const isTestFile = (p) => /(^|\/)(tests?|__tests__|specs?|e2e|cypress|playwright|integration-tests?)\//i.test(p) || /[._-](test|spec)\.[a-z]+$/i.test(p) || /Test\.(php|java|kt|cs|swift)$/.test(p);
// The project's instruction documents, by the names agent hosts and contributors read.
export const isInstructionDoc = (p) => /(^|\/)(AGENTS|CLAUDE|GEMINI|CONTRIBUTING)\.md$/i.test(p) || /(^|\/)\.(claude|cursor)\/rules\/.+\.mdc?$/i.test(p) || /(^|\/)\.github\/copilot-instructions\.md$/i.test(p);
export const isInvariantsDoc = (p) => /invariant[^/]*\.(md|txt|ya?ml)$/i.test(p);

// Folders that hold modules rather than being one; the first folder below them names the area.
const CONTAINERS = new Set(['src', 'source', 'sources', 'app', 'apps', 'lib', 'libs', 'packages', 'modules', 'services', 'internal', 'pkg', 'main', 'java', 'kotlin', 'scala', 'features', 'domains', 'domain', 'com', 'org']);
export function areaOf(rel) {
  const segs = rel.split('/').slice(0, -1);
  const out = [];
  for (const s of segs) {
    out.push(s);
    if (!CONTAINERS.has(s.toLowerCase())) return out.join('/');
  }
  return out.length ? out.join('/') : '.';
}

// Content shapes, one regex per kind. Each names a language, library or storage construct, never a business word.
const CONTENT = [
  ['decimal-type', /\b(BigDecimal|Decimal\b|decimal\.Decimal|NUMERIC\s*\(|DECIMAL\s*\(|type:\s*['"](decimal|numeric)['"]|@db\.Decimal|bc(add|sub|mul|div)\s*\(|BigNumber|big\.js|decimal\.js|precision:\s*\d+\s*,\s*scale)/],
  ['currency-type', /\b(currency(Code)?\s*[:=(]|Currency\b|currency_code|ISO.?4217|minor_?units?|Intl\.NumberFormat\([^)]*currency)/i],
  ['rounding', /\b(ROUND_HALF\w*|HALF_(EVEN|UP|DOWN)|RoundingMode|setScale\s*\(|toFixed\s*\(|Math\.(round|floor|ceil)\s*\(|round\s*\(\s*[\w.$]+\s*,\s*\d)/],
  ['auth', /\b(passport|jsonwebtoken|jwt\.(sign|verify)|bcrypt|argon2|AuthGuard|@UseGuards|password_(hash|verify)|Authorization['"]?\s*[:,]\s*[`'"]Bearer|OAuth2?Client|signIn\s*\(|authenticate\s*\()/],
  ['permission', /\b(hasPermission|hasRole|isGranted|@Roles\s*\(|@PreAuthorize|permission_required|checkPermission|requirePermission|authorize\s*\(|Voter\b|->can\s*\()/],
  ['outbound-client', /\b(axios|node-fetch|undici|superagent|got\s*\(|HttpService|HttpClient|GuzzleHttp|requests\.(get|post|put|patch|delete)\s*\(|httpx\.|http\.NewRequest|URLSession|OkHttpClient|Retrofit|RestTemplate|WebClient|fetch\s*\(\s*[`'"]https?:)/],
  ['webhook-handler', /webhook/i],
  ['queue-consumer', /(@Processor\s*\(|@Process\s*\(|@EventPattern|@MessagePattern|AsMessageHandler|MessageHandlerInterface|@shared_task|@KafkaListener|@RabbitListener|@SqsListener|@Cron\s*\(|cron\.schedule\s*\(|\bnew Worker\s*\(|\.consume\s*\()/],
  ['schema', /(@Entity\s*\(|ORM\\Entity|#\[ORM\\|CREATE TABLE|createTable\s*\(|Schema::create|models\.Model\b)/i],
];
const PATHS = [
  ['auth', /(^|\/)(auth|authn|authentication|login|sessions?|oauth|sso|jwt|identity)(\/|[._-])/i],
  ['permission', /(^|\/)(permissions?|roles?|polic(y|ies)|acl|rbac|guards?|voters?|abilit(y|ies))(\/|[._-])/i],
  ['webhook-handler', /webhook/i],
  ['queue-consumer', /(^|\/)(consumers?|workers?|jobs|queues?|processors?)\//i],
  ['schema', /(^|\/)(schema\.prisma|schema\.rb|[^/]+\.entity\.[jt]s)$/i],
];
const WRITE_CALL = /\b(post|put|patch|delete)\b|method:\s*['"](POST|PUT|PATCH|DELETE)/i;
const MIGRATION_DIR = /(^|\/)(migrations?|migrate|alembic)\//i;
const TEST_SCRIPT = /^(test|tests|unit|lint|typecheck|type-check|types|check|verify|e2e|integration|spec)([:_-].*)?$/i;
const CRITICAL_LINE = /\b(critical|invariant|never|must|always|boundar(y|ies)|irreversible|idempotent)\b/i;

const clip = (s, n = 140) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

function gitOut(cwd, args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  return r.status === 0 ? r.stdout : null;
}

// Tracked files of a repo (relative to it); a folder that is not a git work tree is walked.
export function repoFiles(dir) {
  const out = gitOut(dir, ['ls-files', '-z', '--cached', '--others', '--exclude-standard']);
  if (out !== null) return [...new Set(out.split('\0').filter(Boolean))].filter((f) => !f.split('/').some((s) => SKIP_DIRS.has(s)));
  const files = [];
  const walk = (d, rel) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (SKIP_DIRS.has(e.name)) continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path.join(d, e.name), r);
      else if (e.isFile()) files.push(r);
    }
  };
  walk(dir, '');
  return files;
}

const isGitTop = (dir) => fs.existsSync(path.join(dir, '.git'));

// The repos under a project root: the root itself when it is a git work tree, and folders up to two levels down that are.
export function discoverRepos(root) {
  const found = [];
  if (isGitTop(root)) found.push({ name: path.basename(root), path: '.' });
  const visit = (dir, rel, depth) => {
    if (depth > 2) return;
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (!e.isDirectory() || SKIP_DIRS.has(e.name)) continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      const d = path.join(dir, e.name);
      if (isGitTop(d)) found.push({ name: e.name, path: r });
      else visit(d, r, depth + 1);
    }
  };
  if (!found.length || found[0].path !== '.') visit(root, '', 1);
  return found;
}

function readText(file) {
  try {
    const st = fs.statSync(file);
    if (!st.isFile() || st.size > MAX_BYTES) return null;
    const buf = fs.readFileSync(file);
    if (buf.includes(0)) return null;
    return buf.toString('utf8');
  } catch {
    return null;
  }
}

// A CI pipeline, recognised by shape: a YAML file at the top of the repo or in a top-level dot-folder whose top-level keys
// describe jobs or stages, or a top-level `*file` that declares a pipeline.
function ciShape(rel, text) {
  const top = !rel.includes('/') || /^\.[^/]+\//.test(rel);
  if (!top || rel.startsWith('.workflow/')) return null;
  if (/\.ya?ml$/i.test(rel)) {
    let doc;
    try {
      doc = YAML.parse(text);
    } catch {
      return null;
    }
    if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return null;
    const keys = Object.keys(doc).filter((k) => ['jobs', 'stages', 'pipelines', 'steps', 'workflows'].includes(k));
    return keys.length ? `top-level ${keys.join(', ')}` : null;
  }
  if (/^[A-Z]\w*file$/.test(rel) && /\bpipeline\s*\{/.test(text)) return 'declares a pipeline';
  return null;
}

function runnerOf(files) {
  if (files.includes('yarn.lock')) return 'yarn';
  if (files.includes('pnpm-lock.yaml')) return 'pnpm';
  if (files.includes('bun.lockb') || files.includes('bun.lock')) return 'bun run';
  return 'npm run';
}

// The test scripts a repo declares: package.json and composer.json scripts and Makefile targets whose names say test,
// lint, typecheck, check, verify, e2e or integration, and the test-runner config files.
function testScripts(dir, files) {
  const out = [];
  const pkgs = files.filter((f) => /(^|\/)package\.json$/.test(f) && f.split('/').length <= 3);
  for (const f of pkgs) {
    let pkg;
    try {
      pkg = JSON.parse(readText(path.join(dir, f)) ?? 'null');
    } catch {
      continue;
    }
    const prefix = path.dirname(f) === '.' ? '' : `cd ${path.dirname(f)} && `;
    const runner = runnerOf(files.filter((x) => path.dirname(x) === path.dirname(f)).map((x) => path.basename(x)));
    for (const [name, cmd] of Object.entries(pkg?.scripts ?? {})) if (TEST_SCRIPT.test(name)) out.push({ path: f, name, command: `${prefix}${runner} ${name}`, evidence: `"${name}": "${clip(String(cmd), 100)}"`, containers: /docker|compose|podman|testcontainers/i.test(String(cmd)) });
  }
  if (files.includes('composer.json')) {
    try {
      const c = JSON.parse(readText(path.join(dir, 'composer.json')) ?? 'null');
      for (const [name, cmd] of Object.entries(c?.scripts ?? {})) if (TEST_SCRIPT.test(name)) out.push({ path: 'composer.json', name, command: `composer run ${name}`, evidence: `"${name}": ${clip(JSON.stringify(cmd), 100)}`, containers: /docker|compose/i.test(JSON.stringify(cmd)) });
    } catch {}
  }
  if (files.includes('Makefile')) {
    for (const m of (readText(path.join(dir, 'Makefile')) ?? '').matchAll(/^([A-Za-z][\w:-]*)\s*:(?!=)/gm)) if (TEST_SCRIPT.test(m[1])) out.push({ path: 'Makefile', name: m[1], command: `make ${m[1]}`, evidence: `target ${m[1]}`, containers: false });
  }
  for (const f of files) if (/(^|\/)(jest|vitest|playwright|cypress|karma)\.config\.[a-z]+$|(^|\/)phpunit[^/]*\.xml(\.dist)?$|(^|\/)(pytest\.ini|tox\.ini)$/i.test(f)) out.push({ path: f, name: null, command: null, evidence: 'test runner configuration', containers: false });
  return out;
}

function mobileFacts(files, read) {
  const out = [];
  const seen = new Set();
  const add = (where, evidence) => {
    if (seen.has(where)) return;
    seen.add(where);
    out.push({ path: where, evidence });
  };
  for (const f of files) {
    if (/(^|\/)Podfile$|\.xcodeproj\/project\.pbxproj$/.test(f)) add(f.replace(/\/[^/]*\.xcodeproj\/project\.pbxproj$|\/?Podfile$/, '') || '.', `iOS project (${f})`);
    else if (/(^|\/)AndroidManifest\.xml$/.test(f)) add(f.split('/src/')[0].replace(/\/?AndroidManifest\.xml$/, '') || '.', `Android manifest (${f})`);
    else if (/(^|\/)pubspec\.yaml$/.test(f)) add(path.dirname(f), `Flutter app (${f})`);
    else if (/(^|\/)package\.json$/.test(f) && /"(react-native|expo)"\s*:/.test(read(f) ?? '')) add(path.dirname(f), `React Native app (${f})`);
  }
  return out;
}

// Facts for one repo. Paths in facts are relative to the project root.
function scanRepo(root, repo) {
  const dir = path.resolve(root, repo.path);
  const prefix = repo.path === '.' ? '' : `${repo.path.replace(/\/$/, '')}/`;
  const files = repoFiles(dir).sort();
  const cache = new Map();
  const read = (f) => {
    if (!cache.has(f)) cache.set(f, readText(path.join(dir, f)));
    return cache.get(f);
  };
  const facts = [];
  const add = (kind, rel, evidence, area) => facts.push({ kind, path: `${prefix}${rel}`, evidence: clip(evidence), ...(area !== undefined ? { area: area === '.' ? prefix.replace(/\/$/, '') || '.' : `${prefix}${area}` } : {}) });
  const tests = [];
  const migrationDirs = new Map();

  for (const f of files) {
    if (LOCKFILES.test(f)) continue;
    const material = f.startsWith('.workflow/');
    if (isInvariantsDoc(f) || isInstructionDoc(f)) {
      const kind = isInvariantsDoc(f) ? 'invariants-doc' : 'instruction-doc';
      const text = read(f) ?? '';
      const lines = text.split('\n');
      add(kind, f, lines.find((l) => l.trim())?.trim() ?? '(empty)');
      lines.forEach((l, i) => {
        const t = l.trim();
        if (t && (kind === 'invariants-doc' ? /^([-*]|\d+\.)\s|^#/.test(t) || CRITICAL_LINE.test(t) : CRITICAL_LINE.test(t))) add(kind, `${f}:${i + 1}`, t.replace(/^[-*#\s]+/, ''));
      });
      continue;
    }
    if (material) continue;
    const ci = ciShape(f, /\.ya?ml$|file$/i.test(f) ? read(f) ?? '' : '');
    if (ci) add('ci-file', f, ci);
    if (isTestFile(f)) {
      tests.push(`${prefix}${f}`);
      continue;
    }
    const mdir = MIGRATION_DIR.exec(f);
    if (mdir) {
      const d = f.slice(0, mdir.index + mdir[0].length - 1);
      migrationDirs.set(d, (migrationDirs.get(d) ?? 0) + 1);
      continue;
    }
    if (!CODE.test(f)) continue;
    const area = areaOf(f);
    for (const [kind, re] of PATHS) if (re.test(f)) add(kind, f, `path ${f}`, area);
    const text = read(f);
    if (!text) continue;
    const lines = text.split('\n');
    for (const [kind, re] of CONTENT) {
      const i = lines.findIndex((l) => re.test(l));
      if (i < 0) continue;
      if (facts.some((x) => x.kind === kind && x.path === `${prefix}${f}`)) continue;
      add(kind, `${f}:${i + 1}`, lines[i].trim(), area);
      if (kind === 'outbound-client' && WRITE_CALL.test(text)) facts[facts.length - 1].writes = true;
    }
  }
  for (const [d, n] of migrationDirs) add('migration', d, `${n} migration file${n === 1 ? '' : 's'} in ${d}/`, d);
  for (const m of mobileFacts(files, read)) add('mobile-app', m.path, m.evidence);
  for (const s of testScripts(dir, files)) facts.push({ kind: 'test-script', path: `${prefix}${s.path}`, evidence: s.evidence, ...(s.command ? { command: s.command, name: s.name } : {}), ...(s.containers ? { containers: true } : {}) });

  const dirs = [...new Set(files.filter((f) => f.includes('/')).map((f) => f.split('/')[0]))].sort();
  const modules = [...new Set(files.filter((f) => CODE.test(f) && !isTestFile(f) && !f.startsWith('.workflow/')).map(areaOf).filter((a) => a !== '.'))].sort();
  return { name: repo.name, path: repo.path, dirs, modules, facts, tests, files: files.map((f) => `${prefix}${f}`) };
}

/** scan(root, { repos? }) → ScanFacts (engine/contract.mjs). Each repo also carries `tests` (test files) and `files` (every
 * scanned file), both relative to the root, so risk globs and their tests can be checked against what exists. */
export async function scan(root, { repos } = {}) {
  const list = repos?.length ? repos.map((r) => ({ name: r.name, path: r.path })) : discoverRepos(root);
  return { root, repos: list.map((r) => scanRepo(root, r)) };
}

export const implements08 = { scan };
