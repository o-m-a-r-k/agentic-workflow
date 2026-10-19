// The project adapter, schema 2 (docs/design-0.8.md, section 5). This module is the only reader of adapter files: every
// other stream reads the adapter through `loadAdapter` in engine/contract.mjs. Only stream 7 writes adapter files.
//
// An adapter lives in one of two places:
//   - in a repo: `<root>/.workflow/project.yaml`; the project root is the folder holding `.workflow/`;
//   - in the user folder: `<userDir>/projects/<name>.yaml`, with an explicit `root:`. That folder is a git repo of its
//     own, so every version of a user-folder adapter, hand edits included, has a history.
// Both for one project is refused: two copies drift, and nothing could say which one judged an attempt.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import * as contract from './contract.mjs';

const { POLICY_KEYS, WfError, userDir } = contract;
// The one list of tracker operations (M8), shared with the engine's tracker steps. The fallback is the same list, for a
// tree where contract.mjs does not export it yet; it goes at the merge.
const OPERATIONS = contract.TRACKER_OPERATIONS ?? ['read', 'search', 'fileFollowUp', 'setStatus', 'comment', 'mergeRequest'];

const require = createRequire(import.meta.url);
const YAML = require('./vendor/yaml/dist/index.js');

export const ADAPTER_DIR = '.workflow';
export const CONFIG_FILE = 'project.yaml';

// The secrets catalogue lives beside the adapter: `<root>/.workflow/secrets.yaml` for a repo copy, and
// `<userDir>/projects/<name>.secrets.yaml` for a user-folder copy (named failure: a user-folder project had no place for
// its catalogue, so `wf secrets` and the redactor saw none). A project with no adapter yet uses the repo place.
export const SECRETS_SUFFIX = '.secrets.yaml';
export const secretsCatalogFile = (adapter, root = adapter?.root) => (adapter?.source?.location === 'user' ? path.join(path.dirname(adapter.source.file), `${path.basename(adapter.source.file, '.yaml')}${SECRETS_SUFFIX}`) : path.join(root, ADAPTER_DIR, 'secrets.yaml'));

// A repo's checkout folder (the kept secrets module reads it).
export const repoDir = (root, repo) => path.resolve(root, repo.path);

const sha256 = (text) => crypto.createHash('sha256').update(text).digest('hex');
const home = (env) => env.HOME || os.homedir();
const expandHome = (p, env) => (p === '~' ? home(env) : p.startsWith('~/') ? path.join(home(env), p.slice(2)) : p);
const real = (p) => {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
};
const inside = (dir, p) => p === dir || p.startsWith(dir.endsWith(path.sep) ? dir : dir + path.sep);
const userProjects = (env) => path.join(userDir(env), 'projects');

function parseYaml(text, file) {
  try {
    return YAML.parse(text) ?? {};
  } catch (e) {
    throw new WfError(`${file}: invalid YAML: ${e.message}`);
  }
}

// ---- Finding the project ----------------------------------------------------------------------------------------------

// The nearest folder at or above `cwd` holding `.workflow/project.yaml`. Folders inside an attempt's worktrees
// (`.wf-worktrees/`) are skipped: a repo that carries its own `.workflow/` would otherwise be taken for the project from
// where agents work. When a folder further up links its `.workflow` to the one found (a folder of several repos whose
// adapter is kept in one of them), that folder is the project (named failure 0.7.1: from inside the adapter repo the
// walk stopped there, and the project's open attempts were not found).
function repoCopy(cwd) {
  for (let dir = path.resolve(cwd); ; dir = path.dirname(dir)) {
    const inWorktree = dir.split(path.sep).includes('.wf-worktrees');
    const file = path.join(dir, ADAPTER_DIR, CONFIG_FILE);
    if (!inWorktree && fs.existsSync(file)) {
      const root = linkingRoot(dir) ?? dir;
      return { root, file: path.join(root, ADAPTER_DIR, CONFIG_FILE), location: 'repo' };
    }
    if (path.dirname(dir) === dir) return null;
  }
}
function linkingRoot(found) {
  const target = real(path.join(found, ADAPTER_DIR));
  for (let dir = path.dirname(found); dir !== path.dirname(dir); dir = path.dirname(dir)) {
    const link = path.join(dir, ADAPTER_DIR);
    if (fs.lstatSync(link, { throwIfNoEntry: false })?.isSymbolicLink() && real(link) === target) return dir;
  }
  return null;
}

// Every user-folder adapter with its `root:` (absolute, `~` expanded). A file whose root cannot be read is an error, not
// a skip: skipping it could hide a second copy of the project being worked on.
function userCopies(env) {
  const dir = userProjects(env);
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const f of fs.readdirSync(dir).filter((n) => n.endsWith('.yaml') && !n.endsWith(SECRETS_SUFFIX)).sort()) {
    const file = path.join(dir, f);
    const raw = parseYaml(fs.readFileSync(file, 'utf8'), file);
    if (typeof raw.root !== 'string' || !raw.root.trim()) throw new WfError(`${file} has no \`root:\`; a user-folder adapter names its project folder`, { hint: 'add `root: <the project folder>` to it, or move it out of the projects folder' });
    const root = expandHome(raw.root.trim(), env);
    if (!path.isAbsolute(root)) throw new WfError(`${file}: \`root: ${raw.root}\` is not an absolute path`, { hint: 'write the project folder as an absolute path or under ~/' });
    out.push({ root: real(root), file, location: 'user' });
  }
  return out;
}

function bothRefused(a, b) {
  return new WfError(`two adapters for this project: ${a.file} and ${b.file}; one copy is the project's adapter`, { hint: 'keep one copy and delete the other' });
}

/** @type {(cwd: string, opts?: { env?: Record<string, string> }) => Promise<{ root: string, file: string, location: 'user'|'repo' }|null>} */
export async function findProject(cwd, { env = process.env } = {}) {
  const here = real(cwd);
  const repo = repoCopy(here);
  const users = userCopies(env).filter((u) => inside(u.root, here));
  // The nearest user-folder root wins; two copies naming the same root are two adapters for one project.
  users.sort((a, b) => b.root.length - a.root.length);
  if (users.length > 1 && users[0].root === users[1].root) throw bothRefused(users[0], users[1]);
  const user = users[0] ?? null;
  if (repo && user) throw bothRefused(repo, user);
  return repo ?? user;
}

// ---- Checking ---------------------------------------------------------------------------------------------------------

const TOP = ['version', 'name', 'root', 'requires', 'repos', 'components', 'invariants', 'rules', 'screens', 'review', 'risk', 'ticketing', 'delivery', 'models', 'budget', 'onboarded'];
// Schema 1 keys schema 2 dropped (design section 5), so an old key is named as dropped rather than unknown.
const DROPPED = {
  enabled: 'onboarding replaces it', engine: 'the installed plugin runs', lanes: 'every ticket goes through one flow', classes: 'only a model per role remains (`models`)', panel: 'the planner panel is gone', strategy: 'the strategist is gone',
  impact: 'consumers come from `components`', leaving: 'findings are goal, regression or other', severity: 'findings are goal, regression or other', learning: 'learning is measured', gate: 'tests are `repos[].tests.fast` and `.full`',
  quality: 'it moved into the invariants file', designSystem: 'it moved to the repos\' lint', adapterRepo: 'the adapter is found by location', instructionFiles: 'the plugin reads none', tracker: 'it is `ticketing`', secrets: 'secrets are catalogued by `wf secrets`', validation: 'per-ticket steps are gone',
};
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const STAGE_KINDS = ['land', 'push', 'merge-request', 'wait-merged', 'confirm-deployed', 'deploy', 'status', 'comment', 'module'];
const STAGE_KEYS = ['do', 'branch', 'to', 'comment', 'repos', 'where', 'when', 'after', 'module'];
const MODEL_ROLES = ['planner', 'implementer', 'reviewer', 'secondReviewer', 'tester', 'drafter'];
const CAPTURE_PLACEHOLDERS = ['out', 'viewport', 'lang', 'dir', 'routes'];
const BUDGET_KEYS = ['rules', 'risk', 'modules', 'operationWords'];
const REPO_KEYS = ['name', 'path', 'base', 'remote', 'provision', 'tests', 'kinds'];
const SCREENS_KEYS = ['routes', 'shared', 'sentinel', 'langs', 'viewports', 'capture'];
const TICKETING_KEYS = ['tracker', 'via', 'idPattern', 'take', 'followUps', 'operations'];
const DELIVERY_KEYS = ['landing', 'order', 'authority', 'stages'];

// Every adapter key, as the release check counts them against budget.json (design section 8): a new key is rule-shaped.
// Sections are listed by their own keys (`screens.capture`), except those whose value is one setting or a list.
export const ADAPTER_KEYS = Object.freeze([
  'version', 'name', 'root', 'requires', 'repos', ...REPO_KEYS.map((k) => `repos.${k}`), 'components', 'invariants', 'rules',
  ...SCREENS_KEYS.map((k) => `screens.${k}`), 'review.diffRead', 'risk', ...TICKETING_KEYS.map((k) => `ticketing.${k}`),
  ...DELIVERY_KEYS.map((k) => `delivery.${k}`), 'models', 'budget.adapter', 'onboarded',
]);

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isStr = (v) => typeof v === 'string' && v.trim() !== '';

function checker() {
  const problems = [];
  const c = {
    problems,
    add: (where, what) => problems.push(`${where}: ${what}`),
    obj: (v, where, keys) => {
      if (!isObj(v)) return c.add(where, 'must be a mapping'), false;
      for (const k of Object.keys(v)) if (!keys.includes(k)) c.add(`${where}.${k}`, `unknown key (known: ${keys.join(', ')})`);
      return true;
    },
    str: (v, where) => isStr(v) || (c.add(where, 'must be a non-empty string'), false),
    strs: (v, where, { nonEmpty = false } = {}) => {
      if (!Array.isArray(v)) return c.add(where, 'must be a list of strings'), false;
      if (nonEmpty && !v.length) c.add(where, 'must list at least one entry');
      v.forEach((s, i) => isStr(s) || c.add(`${where}[${i}]`, 'must be a non-empty string'));
      return true;
    },
    oneOf: (v, where, values) => values.includes(v) || (c.add(where, `must be one of ${values.join(', ')}, not ${JSON.stringify(v)}`), false),
    rel: (v, where) => {
      if (!c.str(v, where)) return;
      if (path.isAbsolute(v) || v.split(/[\\/]/).includes('..')) c.add(where, `must be a path inside the project, not ${v}`);
    },
  };
  return c;
}

function checkModule(c, v, where, repoNames) {
  if (!c.obj(v, where, ['repo', 'path'])) return;
  if (c.str(v.repo, `${where}.repo`) && repoNames.size && !repoNames.has(v.repo)) c.add(`${where}.repo`, `\`${v.repo}\` is not a listed repo`);
  c.rel(v.path, `${where}.path`);
}

function checkTestSpec(c, v, where, repoNames) {
  if (v === null) return;
  if (!c.obj(v, where, ['run', 'module', 'lock'])) return;
  if (('run' in v) === ('module' in v)) c.add(where, 'needs exactly one of `run` and `module`');
  if ('run' in v) c.str(v.run, `${where}.run`);
  if ('module' in v) checkModule(c, v.module, `${where}.module`, repoNames);
  if ('lock' in v && c.obj(v.lock, `${where}.lock`, ['name', 'count'])) {
    c.str(v.lock.name, `${where}.lock.name`);
    if (!Number.isInteger(v.lock.count) || v.lock.count < 1) c.add(`${where}.lock.count`, 'must be a whole number of at least 1');
  }
}

function checkRepo(c, r, where, repoNames) {
  if (!c.obj(r, where, REPO_KEYS)) return;
  // A repo name is the first segment of a finding's location (`<repo>/<path>:<line>`), so it holds no slash.
  if (c.str(r.name, `${where}.name`) && !NAME.test(r.name)) c.add(`${where}.name`, `\`${r.name}\` must be letters, digits, dot, dash or underscore`);
  c.rel(r.path, `${where}.path`);
  c.str(r.base, `${where}.base`);
  if ('remote' in r) c.str(r.remote, `${where}.remote`);
  if ('provision' in r && c.obj(r.provision, `${where}.provision`, ['clone', 'fingerprint', 'install', 'copyIgnored'])) {
    for (const k of ['clone', 'fingerprint', 'copyIgnored']) if (k in r.provision) c.strs(r.provision[k], `${where}.provision.${k}`);
    if ('install' in r.provision && r.provision.install !== null) c.str(r.provision.install, `${where}.provision.install`);
  }
  if ('tests' in r && c.obj(r.tests, `${where}.tests`, ['fast', 'full'])) {
    for (const k of ['fast', 'full']) if (k in r.tests) checkTestSpec(c, r.tests[k], `${where}.tests.${k}`, repoNames);
  }
  if ('kinds' in r && c.obj(r.kinds, `${where}.kinds`, ['tests', 'other'])) {
    for (const k of ['tests', 'other']) if (k in r.kinds) c.strs(r.kinds[k], `${where}.kinds.${k}`);
  }
}

function checkStage(c, s, where, repoNames) {
  if (!c.obj(s, where, STAGE_KEYS)) return;
  if (!c.oneOf(s.do, `${where}.do`, STAGE_KINDS)) return;
  for (const k of ['branch', 'to', 'comment', 'where', 'after']) if (k in s) c.str(s[k], `${where}.${k}`);
  if (s.do === 'status' && !('to' in s)) c.add(where, 'a `status` stage needs `to`');
  if (s.do === 'comment' && !('comment' in s)) c.add(where, 'a `comment` stage needs `comment`');
  if (s.do === 'module') checkModule(c, s.module, `${where}.module`, repoNames);
  else if ('module' in s) c.add(`${where}.module`, 'only a `module` stage takes a module');
  if (['confirm-deployed', 'deploy'].includes(s.do) && !('where' in s)) c.add(where, `a \`${s.do}\` stage needs \`where\``);
  if ('repos' in s && c.strs(s.repos, `${where}.repos`, { nonEmpty: true })) for (const n of s.repos) if (repoNames.size && !repoNames.has(n)) c.add(`${where}.repos`, `\`${n}\` is not a listed repo`);
  if ('when' in s && c.obj(s.when, `${where}.when`, ['labels'])) c.strs(s.when.labels, `${where}.when.labels`, { nonEmpty: true });
}

/**
 * Problems of a raw (parsed, not normalised) schema 2 adapter; [] when it is valid. Every key the contract's Adapter type
 * names is checked, and a key outside it is a problem. `location: 'user'` also requires `root:`.
 * @type {(raw: object, opts?: { location?: 'user'|'repo' }) => Promise<string[]>}
 */
export async function checkAdapter(raw, { location } = {}) {
  return problemsOf(raw, { location });
}

function problemsOf(raw, { location } = {}) {
  const c = checker();
  if (!isObj(raw)) return ['the adapter must be a mapping'];
  if (raw.version !== 2) return [`version: must be 2, not ${JSON.stringify(raw.version ?? null)}${raw.version === 1 ? '; a 0.7 adapter is converted by `wf init --from-07`' : ''}`];
  for (const k of Object.keys(raw)) {
    if (TOP.includes(k)) continue;
    c.add(k, Object.hasOwn(DROPPED, k) ? `dropped in schema 2: ${DROPPED[k]}` : 'unknown key');
  }
  if (c.str(raw.name, 'name') && !NAME.test(raw.name)) c.add('name', `\`${raw.name}\` must be letters, digits, dot, dash or underscore (it names files)`);
  if ('root' in raw) {
    if (c.str(raw.root, 'root') && !path.isAbsolute(raw.root) && !raw.root.startsWith('~')) c.add('root', `must be an absolute path or under ~/, not ${raw.root}`);
  } else if (location === 'user') c.add('root', 'a user-folder adapter needs `root:`, the project folder');
  if ('requires' in raw && c.obj(raw.requires, 'requires', ['connectors', 'tools', 'skills'])) {
    for (const k of ['connectors', 'tools', 'skills']) if (k in raw.requires) c.strs(raw.requires[k], `requires.${k}`);
  }

  const repoNames = new Set();
  if (!Array.isArray(raw.repos) || !raw.repos.length) c.add('repos', 'must list at least one repo');
  else {
    for (const r of raw.repos) if (isObj(r) && isStr(r.name)) {
      if (repoNames.has(r.name)) c.add('repos', `\`${r.name}\` is listed twice`);
      repoNames.add(r.name);
    }
    raw.repos.forEach((r, i) => checkRepo(c, r, `repos[${i}]`, repoNames));
  }

  if ('components' in raw) {
    if (!Array.isArray(raw.components)) c.add('components', 'must be a list');
    else {
      const ids = new Set();
      raw.components.forEach((m, i) => {
        const w = `components[${i}]`;
        if (!c.obj(m, w, ['id', 'repo', 'dependsOn'])) return;
        if (c.str(m.id, `${w}.id`)) {
          if (ids.has(m.id)) c.add(`${w}.id`, `\`${m.id}\` is listed twice`);
          ids.add(m.id);
        }
        if (c.str(m.repo, `${w}.repo`) && !repoNames.has(m.repo)) c.add(`${w}.repo`, `\`${m.repo}\` is not a listed repo`);
        if (!Array.isArray(m.dependsOn)) c.add(`${w}.dependsOn`, 'must be a list of { contract: <glob> }');
        else m.dependsOn.forEach((d, j) => c.obj(d, `${w}.dependsOn[${j}]`, ['contract']) && c.str(d.contract, `${w}.dependsOn[${j}].contract`));
      });
    }
  }
  if ('invariants' in raw && raw.invariants !== null) c.rel(raw.invariants, 'invariants');
  if ('rules' in raw) {
    if (!Array.isArray(raw.rules)) c.add('rules', 'must be a list');
    else raw.rules.forEach((r, i) => {
      if (!c.obj(r, `rules[${i}]`, ['paths', 'read'])) return;
      c.strs(r.paths, `rules[${i}].paths`, { nonEmpty: true });
      if (c.strs(r.read, `rules[${i}].read`, { nonEmpty: true })) r.read.forEach((p, j) => c.rel(p, `rules[${i}].read[${j}]`));
    });
  }

  if ('screens' in raw && c.obj(raw.screens, 'screens', SCREENS_KEYS)) {
    const s = raw.screens;
    if ('routes' in s && s.routes !== null) checkModule(c, s.routes, 'screens.routes', repoNames);
    if ('shared' in s) c.strs(s.shared, 'screens.shared');
    if ('sentinel' in s) c.strs(s.sentinel, 'screens.sentinel');
    if ('langs' in s) {
      if (!Array.isArray(s.langs)) c.add('screens.langs', 'must be a list of { lang, dir }');
      else s.langs.forEach((l, i) => {
        if (!c.obj(l, `screens.langs[${i}]`, ['lang', 'dir'])) return;
        c.str(l.lang, `screens.langs[${i}].lang`);
        c.oneOf(l.dir, `screens.langs[${i}].dir`, ['ltr', 'rtl']);
      });
    }
    if ('viewports' in s) {
      if (!Array.isArray(s.viewports) || !s.viewports.length) c.add('screens.viewports', 'must list at least one width');
      else s.viewports.forEach((v, i) => (Number.isInteger(v) && v > 0) || c.add(`screens.viewports[${i}]`, 'must be a width in pixels'));
    }
    // A command (`{ run }`, or a plain string meaning the same) or a module (`{ module: { repo, path } }`).
    if ('capture' in s && s.capture !== null) {
      const run = typeof s.capture === 'string' ? s.capture : isObj(s.capture) && 'run' in s.capture ? s.capture.run : null;
      if (isObj(s.capture) && c.obj(s.capture, 'screens.capture', ['run', 'module']) && ('run' in s.capture) === ('module' in s.capture)) c.add('screens.capture', 'needs exactly one of `run` and `module`');
      else if (isObj(s.capture) && 'module' in s.capture) checkModule(c, s.capture.module, 'screens.capture.module', repoNames);
      else if (!isObj(s.capture) && typeof s.capture !== 'string') c.add('screens.capture', 'must be { run: <command> } or { module: { repo, path } }');
      if (run !== null && c.str(run, typeof s.capture === 'string' ? 'screens.capture' : 'screens.capture.run')) {
        for (const [, p] of run.matchAll(/\{(\w+)\}/g)) if (!CAPTURE_PLACEHOLDERS.includes(p)) c.add('screens.capture', `unknown placeholder {${p}} (known: ${CAPTURE_PLACEHOLDERS.map((x) => `{${x}}`).join(' ')})`);
      }
    }
  }
  if ('review' in raw && c.obj(raw.review, 'review', ['diffRead']) && 'diffRead' in raw.review) c.oneOf(raw.review.diffRead, 'review.diffRead', ['before', 'after']);

  if ('risk' in raw && raw.risk !== 'none') {
    if (!Array.isArray(raw.risk)) c.add('risk', 'must be a list of risk paths, or `none`');
    else {
      const ids = new Set();
      raw.risk.forEach((r, i) => {
        const w = `risk[${i}]`;
        if (!c.obj(r, w, ['id', 'paths', 'reason', 'tests'])) return;
        if (c.str(r.id, `${w}.id`)) {
          if (ids.has(r.id)) c.add(`${w}.id`, `\`${r.id}\` is listed twice`);
          ids.add(r.id);
        }
        c.strs(r.paths, `${w}.paths`, { nonEmpty: true });
        c.str(r.reason, `${w}.reason`);
        // A risk change needs a test under these globs that fails on the merge-base; with none listed it never could.
        c.strs(r.tests, `${w}.tests`, { nonEmpty: true });
      });
    }
  }

  if ('ticketing' in raw && c.obj(raw.ticketing, 'ticketing', TICKETING_KEYS)) {
    const t = raw.ticketing;
    if ('tracker' in t && t.tracker !== null) {
      if (isObj(t.tracker)) {
        if (c.obj(t.tracker, 'ticketing.tracker', ['module'])) checkModule(c, t.tracker.module, 'ticketing.tracker.module', repoNames);
      } else c.str(t.tracker, 'ticketing.tracker');
    }
    if ('via' in t) c.oneOf(t.via, 'ticketing.via', ['connector', 'module', 'files', 'none']);
    if (t.via === 'module' && !isObj(t.tracker) && !isStr(t.tracker)) c.add('ticketing.via', '`module` needs a tracker');
    if ('idPattern' in t && t.idPattern !== null && c.str(t.idPattern, 'ticketing.idPattern')) {
      try {
        new RegExp(t.idPattern);
      } catch (e) {
        c.add('ticketing.idPattern', `is not a regular expression: ${e.message}`);
      }
    }
    if ('take' in t && t.take !== null && c.obj(t.take, 'ticketing.take', ['status'])) c.str(t.take.status, 'ticketing.take.status');
    if ('followUps' in t && c.obj(t.followUps, 'ticketing.followUps', ['mode', 'team', 'status', 'label'])) {
      c.oneOf(t.followUps.mode, 'ticketing.followUps.mode', ['file', 'digest', 'off']);
      for (const k of ['team', 'status', 'label']) if (k in t.followUps) c.str(t.followUps[k], `ticketing.followUps.${k}`);
    }
    if ('operations' in t && c.obj(t.operations, 'ticketing.operations', OPERATIONS)) for (const [k, v] of Object.entries(t.operations)) c.str(v, `ticketing.operations.${k}`);
  }

  if ('delivery' in raw && c.obj(raw.delivery, 'delivery', DELIVERY_KEYS)) {
    const d = raw.delivery;
    if ('landing' in d) c.oneOf(d.landing, 'delivery.landing', ['queue', 'direct']);
    if ('order' in d && c.strs(d.order, 'delivery.order')) {
      const seen = new Set();
      for (const n of d.order) {
        if (!repoNames.has(n)) c.add('delivery.order', `\`${n}\` is not a listed repo`);
        if (seen.has(n)) c.add('delivery.order', `\`${n}\` is listed twice`);
        seen.add(n);
      }
      // A repo missing from the order would never be delivered.
      for (const n of repoNames) if (!seen.has(n)) c.add('delivery.order', `leaves out \`${n}\`, so its part would never be delivered`);
    }
    if ('authority' in d && c.obj(d.authority, 'delivery.authority', ['push', 'mergeRequest', 'merge'])) {
      for (const [k, v] of Object.entries(d.authority)) c.oneOf(v, `delivery.authority.${k}`, ['agent', 'person']);
    }
    if ('stages' in d) {
      if (!Array.isArray(d.stages)) c.add('delivery.stages', 'must be a list');
      else d.stages.forEach((s, i) => checkStage(c, s, `delivery.stages[${i}]`, repoNames));
    }
  }

  if ('models' in raw && c.obj(raw.models, 'models', MODEL_ROLES)) for (const [k, v] of Object.entries(raw.models)) c.str(v, `models.${k}`);
  if ('budget' in raw && c.obj(raw.budget, 'budget', ['adapter']) && 'adapter' in raw.budget && c.obj(raw.budget.adapter, 'budget.adapter', BUDGET_KEYS)) {
    for (const [k, v] of Object.entries(raw.budget.adapter)) (Number.isInteger(v) && v >= 0) || c.add(`budget.adapter.${k}`, 'must be a whole number, 0 or more');
  }
  if ('onboarded' in raw && c.obj(raw.onboarded, 'onboarded', ['at', 'engine', 'hashes'])) {
    const o = raw.onboarded;
    for (const k of ['at', 'engine']) if (k in o && o[k] !== null) c.str(o[k], `onboarded.${k}`);
    if ('hashes' in o) {
      if (!isObj(o.hashes)) c.add('onboarded.hashes', 'must be a mapping');
      else for (const [k, v] of Object.entries(o.hashes)) {
        if (!POLICY_KEYS.some((p) => k === p || k.startsWith(`${p}.`))) c.add(`onboarded.hashes.${k}`, `is not an onboarding key (${POLICY_KEYS.join(', ')})`);
        if (typeof v !== 'string' || !/^[0-9a-f]{64}$/.test(v)) c.add(`onboarded.hashes.${k}`, 'must be a sha256 hex digest');
      }
    }
  }
  return c.problems;
}

// ---- Normalising ------------------------------------------------------------------------------------------------------

const list = (v) => (Array.isArray(v) ? [...v] : []);
// screens.capture normalised: `{ run }` (a plain string is a command), `{ module: { repo, path } }`, or null.
const captureOf = (v) => (v == null ? null : typeof v === 'string' ? { run: v } : v.module ? { module: { repo: v.module.repo, path: v.module.path } } : { run: v.run });
const testSpec = (v) => (v ? { ...(v.run ? { run: v.run } : { module: { ...v.module } }), ...(v.lock ? { lock: { ...v.lock } } : {}) } : null);

function normalise(raw, root, source) {
  const repos = raw.repos.map((r) => ({
    name: r.name,
    path: r.path,
    base: r.base,
    remote: r.remote ?? 'origin',
    provision: { clone: list(r.provision?.clone), fingerprint: list(r.provision?.fingerprint), install: r.provision?.install ?? null, copyIgnored: list(r.provision?.copyIgnored) },
    tests: { fast: testSpec(r.tests?.fast), full: testSpec(r.tests?.full) },
    kinds: { tests: list(r.kinds?.tests), other: list(r.kinds?.other) },
  }));
  const s = raw.screens ?? {};
  const t = raw.ticketing ?? {};
  const d = raw.delivery ?? {};
  const o = raw.onboarded ?? {};
  const b = raw.budget?.adapter ?? {};
  return {
    version: 2,
    name: raw.name,
    root,
    source,
    requires: { connectors: list(raw.requires?.connectors), tools: list(raw.requires?.tools), skills: list(raw.requires?.skills) },
    repos,
    components: list(raw.components).map((m) => ({ id: m.id, repo: m.repo, dependsOn: m.dependsOn.map((x) => ({ contract: x.contract })) })),
    invariants: raw.invariants ?? null,
    rules: list(raw.rules).map((r) => ({ paths: [...r.paths], read: [...r.read] })),
    screens: { routes: s.routes ? { ...s.routes } : null, shared: list(s.shared), sentinel: list(s.sentinel), langs: list(s.langs).map((l) => ({ lang: l.lang, dir: l.dir })), viewports: list(s.viewports), capture: captureOf(s.capture) },
    review: { diffRead: raw.review?.diffRead ?? 'before' },
    risk: raw.risk === 'none' ? { confirmed: true, paths: [] } : Array.isArray(raw.risk) ? { confirmed: true, paths: raw.risk.map((r) => ({ id: r.id, paths: [...r.paths], reason: r.reason, tests: [...r.tests] })) } : { confirmed: false, paths: [] },
    ticketing: {
      tracker: t.tracker == null ? null : isObj(t.tracker) ? { module: { ...t.tracker.module } } : t.tracker,
      via: t.via ?? (t.tracker == null ? 'none' : isObj(t.tracker) ? 'module' : 'connector'),
      idPattern: t.idPattern ?? null,
      take: t.take ? { status: t.take.status } : null,
      followUps: t.followUps ? { ...t.followUps } : { mode: 'off' },
      operations: { ...(t.operations ?? {}) },
    },
    delivery: {
      landing: d.landing ?? 'direct',
      order: d.order ? [...d.order] : repos.map((r) => r.name),
      authority: { push: 'agent', mergeRequest: 'agent', merge: 'person', ...(d.authority ?? {}) },
      stages: list(d.stages).map((x) => structuredClone(x)),
    },
    models: { ...(raw.models ?? {}) },
    // Limits an adapter does not set are null: adapterBudget reports the counts and holds nothing over a missing limit.
    budget: { adapter: Object.fromEntries(BUDGET_KEYS.map((k) => [k, b[k] ?? null])) },
    onboarded: { at: o.at ?? null, engine: o.engine ?? null, hashes: { ...(o.hashes ?? {}) } },
  };
}

// ---- The user folder's own history ------------------------------------------------------------------------------------

const GIT_ID = ['-c', 'user.name=agentic-workflow', '-c', 'user.email=agentic-workflow@localhost', '-c', 'commit.gpgsign=false'];
function gitIn(dir, args) {
  const r = spawnSync('git', [...GIT_ID, ...args], { cwd: dir, encoding: 'utf8' });
  if (r.status !== 0) throw new WfError(`git ${args.join(' ')} in ${dir} failed: ${(r.stderr || r.stdout).trim()}`);
  return r.stdout;
}
// The user folder's projects are a git repo of their own. A version of an adapter the history does not hold yet (a hand
// edit, or the first read) is committed when it is read, so the history holds every version that judged an attempt and
// onboarding can show a hand edit against it. The hash of the last version committed is kept in `.git/wf-read/<name>`,
// so a read of an unchanged adapter spawns no git (every `wf` command reads it).
function keepHistory(file, text) {
  const dir = path.dirname(file);
  const name = path.basename(file);
  const mark = path.join(dir, '.git', 'wf-read', name);
  const hash = sha256(text);
  if (fs.existsSync(mark) && fs.readFileSync(mark, 'utf8') === hash) return;
  if (!fs.existsSync(path.join(dir, '.git'))) gitIn(dir, ['init', '--quiet']);
  if (gitIn(dir, ['status', '--porcelain', '--', name]).trim()) {
    try {
      gitIn(dir, ['add', '--', name]);
      gitIn(dir, ['commit', '--quiet', '-m', `${name} as read`, '--', name]);
    } catch (e) {
      // Parallel attempts read the same adapter: another process holding the index lock is committing this version.
      if (!/index\.lock/.test(e.message)) throw e;
      return;
    }
  }
  fs.mkdirSync(path.dirname(mark), { recursive: true });
  fs.writeFileSync(mark, hash);
}

// ---- Loading ----------------------------------------------------------------------------------------------------------

/**
 * Read, check and normalise the adapter of the project at `root` (typedef Adapter in engine/contract.mjs). Throws WfError
 * listing every problem, for a schema 1 adapter (naming `wf init --from-07`), when no adapter names this root, or when
 * both a repo copy and a user-folder copy do.
 * @type {(root: string, opts?: { env?: Record<string, string> }) => Promise<import('./contract.mjs').Adapter>}
 */
export async function loadAdapter(root, { env = process.env } = {}) {
  const dir = real(root);
  const repoFile = path.join(dir, ADAPTER_DIR, CONFIG_FILE);
  const copies = [
    ...(fs.existsSync(repoFile) ? [{ root: dir, file: repoFile, location: 'repo' }] : []),
    ...userCopies(env).filter((u) => u.root === dir),
  ];
  if (copies.length > 1) throw bothRefused(copies[0], copies[1]);
  if (!copies.length) throw new WfError(`no adapter for ${dir}: neither ${repoFile} nor a file in ${userProjects(env)} whose \`root:\` is this folder`, { hint: 'run `wf init` to onboard this project' });
  const { file, location } = copies[0];
  const text = fs.readFileSync(file, 'utf8');
  const raw = parseYaml(text, file);
  if (raw.version === 1) throw new WfError(`${file} is a 0.7 adapter (version 1); 0.8 reads schema 2 only`, { hint: 'run `wf init --from-07` to convert it' });
  const problems = problemsOf(raw, { location });
  if (location === 'user' && isStr(raw.name) && `${raw.name}.yaml` !== path.basename(file)) problems.push(`name: \`${raw.name}\` must match the file name ${path.basename(file)}`);
  if (location === 'repo' && isStr(raw.root) && real(expandHome(raw.root, env)) !== dir) problems.push(`root: \`${raw.root}\` is not ${dir}, the folder this adapter was found in`);
  if (problems.length) throw new WfError(`${file}:\n  - ${problems.join('\n  - ')}`, { hint: 'fix the adapter, or re-run `wf init`' });
  if (location === 'user') keepHistory(file, text);
  return normalise(raw, dir, { file, location, hash: sha256(text) });
}

// ---- The adapter budget -----------------------------------------------------------------------------------------------

function moduleRefs(a) {
  const refs = [];
  for (const r of a.repos) for (const k of ['fast', 'full']) if (r.tests[k]?.module) refs.push(r.tests[k].module);
  if (a.screens.routes) refs.push(a.screens.routes);
  if (a.screens.capture?.module) refs.push(a.screens.capture.module);
  if (a.ticketing.tracker?.module) refs.push(a.ticketing.tracker.module);
  for (const s of a.delivery.stages) if (s.module) refs.push(s.module);
  return refs;
}
const words = (text) => String(text).split(/\s+/).filter(Boolean).length;

/**
 * The adapter's rules, risk paths, modules (distinct `{ repo, path }` files) and operation words against
 * `budget.adapter`. `over` names each count above its limit; a limit the adapter does not set holds nothing.
 * @type {(adapter: import('./contract.mjs').Adapter) => Promise<{ counts: object, limits: object, over: string[] }>}
 */
export async function adapterBudget(adapter) {
  const counts = {
    rules: adapter.rules.length,
    risk: adapter.risk.paths.length,
    modules: new Set(moduleRefs(adapter).map((m) => `${m.repo}/${m.path}`)).size,
    operationWords: Object.values(adapter.ticketing.operations).reduce((n, t) => n + words(t), 0),
  };
  const limits = { ...adapter.budget.adapter };
  const over = BUDGET_KEYS.filter((k) => limits[k] !== null && counts[k] > limits[k]);
  return { counts, limits, over };
}

export const implements08 = { findProject, loadAdapter, checkAdapter, adapterBudget };
