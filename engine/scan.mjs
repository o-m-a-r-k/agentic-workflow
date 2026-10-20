// The onboarding scan (design-0.8 section 5, stream 7): the repos as structural facts. It never writes.
//
// The plugin ships no domain vocabulary. Facts name project shapes only: a CI pipeline file, a test script, a mobile app,
// the project's instruction and invariants documents. What a change risks is judged per change by its reviewers, never
// read from the scan.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const YAML = require('./vendor/yaml/dist/index.js');

const MAX_BYTES = 1024 * 1024; // larger files are generated or data; reading them would only slow the scan
const SKIP_DIRS = new Set(['.git', 'node_modules', 'vendor', 'dist', 'build', '.next', '.wf-worktrees', '.wf-evidence', 'Pods', '.gradle', 'target', 'coverage']);
const LOCKFILES = /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|composer\.lock|Gemfile\.lock|poetry\.lock|Cargo\.lock|go\.sum)$/;

// A test file: a tests folder anywhere on its path, or a test/spec suffix. Settings for an environment named `test`
// (`config/packages/test/*.yaml`, `config/services_test.yaml`: a settings file under a config folder) are configuration, not tests.
export const TEST_DIR = /^(tests?|__tests__|specs?|e2e|cypress|playwright|integration-tests?)$/i;
const CONFIG_DIR = /^(config|configs|conf|settings)$/i;
const SETTINGS_FILE = /\.(ya?ml|json|xml|pem|key|crt|ini|toml|env|neon|conf|properties)$/i;
export const isTestConfig = (p) => {
  const segs = p.split('/').slice(0, -1);
  const c = segs.findIndex((x) => CONFIG_DIR.test(x));
  return c >= 0 && SETTINGS_FILE.test(p) && (segs.slice(c + 1).some((x) => TEST_DIR.test(x)) || /[._-](test|spec)\.[a-z]+$/i.test(p));
};
export const isTestFile = (p) => !isTestConfig(p) && (p.split('/').slice(0, -1).some((s) => TEST_DIR.test(s)) || /[._-](test|spec)\.[a-z]+$/i.test(p) || /Test\.(php|java|kt|cs|swift)$/.test(p));
// The project's instruction documents, by the names agent hosts and contributors read.
export const isInstructionDoc = (p) => /(^|\/)(AGENTS|CLAUDE|GEMINI|CONTRIBUTING)\.md$/i.test(p) || /(^|\/)\.(claude|cursor)\/rules\/.+\.mdc?$/i.test(p) || /(^|\/)\.github\/copilot-instructions\.md$/i.test(p);
export const isInvariantsDoc = (p) => /invariant[^/]*\.(md|txt|ya?ml)$/i.test(p);

const TEST_SCRIPT = /^(test|tests|unit|lint|typecheck|type-check|types|check|verify|e2e|integration|spec)([:_-].*)?$/i;

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
  const add = (kind, rel, evidence) => facts.push({ kind, path: `${prefix}${rel}`, evidence: clip(evidence) });
  const tests = [];
  const configTests = [];
  for (const f of files) {
    if (LOCKFILES.test(f)) continue;
    if (isInvariantsDoc(f) || isInstructionDoc(f)) {
      add(isInvariantsDoc(f) ? 'invariants-doc' : 'instruction-doc', f, (read(f) ?? '').split('\n').find((l) => l.trim())?.trim() ?? '(empty)');
      continue;
    }
    if (f.startsWith('.workflow/')) continue;
    const ci = ciShape(f, /\.ya?ml$|file$/i.test(f) ? read(f) ?? '' : '');
    if (ci) add('ci-file', f, ci);
    if (isTestFile(f)) tests.push(`${prefix}${f}`);
    else if (isTestConfig(f)) configTests.push(`${prefix}${f}`);
  }
  for (const m of mobileFacts(files, read)) add('mobile-app', m.path, m.evidence);
  for (const s of testScripts(dir, files)) facts.push({ kind: 'test-script', path: `${prefix}${s.path}`, evidence: s.evidence, ...(s.command ? { command: s.command, name: s.name } : {}), ...(s.containers ? { containers: true } : {}) });

  return { name: repo.name, path: repo.path, facts, tests, configTests };
}

/** scan(root, { repos? }) → ScanFacts (engine/contract.mjs). Each repo also carries `tests`: its test files, relative to
 * the root, from which onboarding proposes `kinds.tests`, and `configTests`: configuration under a test-named folder. */
export async function scan(root, { repos } = {}) {
  const list = repos?.length ? repos.map((r) => ({ name: r.name, path: r.path })) : discoverRepos(root);
  return { root, repos: list.map((r) => scanRepo(root, r)) };
}

export const implements08 = { scan };

// The scan's library lists (named failure: lists of library and framework names grow one project at a time until the
// generic scan carries every project's stack). scenarios/onboard-library-cap.test.mjs caps their size.
export const LIBRARY_LISTS = Object.freeze({ SKIP_DIRS, TEST_SCRIPT, LOCKFILES, TEST_DIR, CONFIG_DIR, SETTINGS_FILE });
