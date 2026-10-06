import fs from 'node:fs';
import path from 'node:path';
import { ENGINE_PIN, WfError, YAML, git, hashValue } from './util.mjs';

export const ADAPTER_DIR = '.workflow';
export const CONFIG_FILE = 'project.yaml';

// The project root is the nearest ancestor holding `.workflow/project.yaml`.
// Inside an attempt worktree (…/.wf-worktrees/<id>/<repo>/…) the worktree's own copy is skipped, so commands
// run from where agents work resolve to the real project.
export function findRoot(start = process.cwd()) {
  let dir = path.resolve(start);
  for (;;) {
    const inWorktree = dir.split(path.sep).includes('.wf-worktrees');
    if (!inWorktree && fs.existsSync(path.join(dir, ADAPTER_DIR, CONFIG_FILE))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export function requireRoot(start) {
  const root = findRoot(start);
  if (!root) throw new WfError('no .workflow/project.yaml found here or above', { hint: 'run `wf init` to onboard this project' });
  return root;
}

export function parseConfig(text, source) {
  let raw;
  try {
    raw = YAML.parse(text);
  } catch (error) {
    throw new WfError(`${source}: invalid YAML: ${error.message}`);
  }
  return normalize(raw ?? {}, source);
}

export function loadConfig(root) {
  const file = path.join(root, ADAPTER_DIR, CONFIG_FILE);
  return parseConfig(fs.readFileSync(file, 'utf8'), file);
}

const LANES = new Set(['quick', 'standard', 'batch']);

// Work classes: how hard a role's agent thinks, per runtime. The adapter's `classes` merge over these by name.
// Defaults are unmeasured starting points; guarantees (gate, blind review, frozen criteria) never depend on a class.
export const DEFAULT_CLASSES = {
  full: {
    use: "Money, payments, audit, authorization, data isolation between customers, migrations, external protocols, and anything the project's invariants file calls a critical boundary.",
    claude: { effort: 'high' },
    codex: {},
  },
  light: {
    use: 'UI wired to a frozen contract, translations, generated docs or OpenAPI output, test fixtures.',
    claude: { effort: 'low' },
    codex: {},
  },
};
// The effort values each runtime documents today. Checked so a typo fails at load instead of silently running at the
// inherited effort; a runtime that adds a value needs it added here.
export const EFFORTS = { claude: ['low', 'medium', 'high', 'xhigh', 'max'], codex: ['minimal', 'low', 'medium', 'high', 'xhigh'] };
export const ROLE_DEFAULT_CLASS = { planner: 'full', reviewer: 'full', implementer: 'full', tester: 'full' };

function mergeClasses(raw, fail) {
  const out = {};
  for (const [name, c] of Object.entries(DEFAULT_CLASSES)) out[name] = { ...c, claude: { ...c.claude }, codex: { ...c.codex } };
  if (raw !== undefined && (raw === null || typeof raw !== 'object' || Array.isArray(raw))) {
    fail('`classes` must map class names to { use, claude, codex }');
    return out;
  }
  for (const [name, c] of Object.entries(raw ?? {})) {
    // The name becomes an agent file name (wf-implementer-<class>).
    if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) fail(`class \`${name}\`: use lowercase letters, digits and dashes`);
    const prev = out[name] ?? { claude: {}, codex: {} };
    out[name] = { ...prev, ...(c ?? {}), claude: { ...prev.claude, ...(c?.claude ?? {}) }, codex: { ...prev.codex, ...(c?.codex ?? {}) } };
  }
  for (const [name, c] of Object.entries(out)) {
    if (typeof c.use !== 'string' || !c.use.trim()) fail(`class \`${name}\` needs \`use\`: what work belongs in it (the planner assigns classes from this text)`);
    for (const runtime of Object.keys(EFFORTS)) {
      const e = c[runtime]?.effort;
      if (e !== undefined && e !== null && !EFFORTS[runtime].includes(e)) fail(`class \`${name}\`: ${runtime} effort \`${e}\` is not one of ${EFFORTS[runtime].join(', ')}`);
    }
  }
  return out;
}

// The class a role runs at, and what it declares per runtime.
export function roleClass(cfg, role) {
  const rc = cfg.roles?.[role];
  return (rc && typeof rc === 'object' ? rc.class : null) ?? ROLE_DEFAULT_CLASS[role] ?? 'full';
}
export function agentTypeFor(cfg, role, cls = roleClass(cfg, role)) {
  if (role !== 'implementer') return `wf-${role}`;
  return cls === roleClass(cfg, 'implementer') ? 'wf-implementer' : `wf-implementer-${cls}`;
}
export function declared(cfg, cls, runtime) {
  const c = cfg.classes[cls] ?? {};
  return { effort: c[runtime]?.effort ?? null, model: c[runtime]?.model ?? null };
}

// Placeholders an `artifacts` glob may carry, expanded per attempt when the gate collects artifacts. They let a step
// collect one ticket's evidence (`e2e/.evidence/{itemLower}/**/*.png`) instead of every screenshot the suite writes:
// a real ticket was refused because a placeholder-less glob made 1,300 other tickets' screenshots required evidence.
export const ARTIFACT_PLACEHOLDERS = ['item', 'itemLower', 'attempt'];
// `{name}` without a comma is a placeholder; `{a,b}` stays glob alternation.
export const placeholdersIn = (glob) => [...String(glob).matchAll(/\{(\w+)\}/g)].map((m) => m[1]);

// Each glob once per unit ({ item, attempt }: the attempt, plus every member of a batch), duplicates dropped.
export function expandArtifactGlob(glob, units) {
  if (!placeholdersIn(glob).length) return [glob];
  const vars = (u) => ({ item: u.item, itemLower: String(u.item).toLowerCase(), attempt: u.attempt });
  return [...new Set(units.map((u) => glob.replace(/\{(\w+)\}/g, (m, k) => vars(u)[k] ?? m)))];
}

function normalize(raw, source) {
  const errors = [];
  const fail = (m) => errors.push(m);
  if (raw.version !== 1) fail('`version` must be 1');
  const cfg = {
    version: raw.version,
    enabled: raw.enabled === true,
    name: raw.name ?? 'project',
    engine: raw.engine ?? null,
    adapterRepo: raw.adapterRepo ?? null,
    instructionFiles: raw.instructionFiles ?? null,
    lanes: raw.lanes ?? ['quick', 'standard'],
    invariants: raw.invariants ?? null,
    roles: raw.roles ?? {},
    focused: raw.focused ?? [],
    requires: { skills: raw.requires?.skills ?? [], connectors: raw.requires?.connectors ?? [], tools: raw.requires?.tools ?? [] },
    tracker: { kind: 'none', statuses: {}, events: null, commentRules: { forbid: [] }, ...(raw.tracker ?? {}) },
    delivery: { kind: 'push-main', ...(raw.delivery ?? {}) },
    secrets: { store: 'env-file', ...(raw.secrets ?? {}) },
    gate: { maxParallelSteps: 1, leases: {}, steps: [], ...(raw.gate ?? {}) },
    components: raw.components ?? [],
    review: { rules: raw.review?.rules ?? [] },
    designSystem: raw.designSystem ?? null,
    repos: [],
  };
  cfg.classes = mergeClasses(raw.classes, fail);
  if (cfg.engine !== null && !ENGINE_PIN.test(String(cfg.engine).trim())) fail(`\`engine\` must be \`N.x\` (same major) or \`>=x.y.z\` (at least that release), not \`${cfg.engine}\``);
  for (const [role, rc] of Object.entries(cfg.roles)) {
    if (!rc || typeof rc !== 'object') continue;
    // Pre-launch replacement: per-role model/effort moved to classes; refusing them keeps a stale setting from being silently ignored.
    const moved = ['model', 'effort', 'claude', 'codex'].filter((k) => k in rc);
    if (moved.length) fail(`roles.${role}: ${moved.join(', ')} moved to \`classes\`; set \`roles.${role}.class\` and the class's claude/codex effort and model`);
    if (rc.class !== undefined && !cfg.classes[rc.class]) fail(`roles.${role}.class \`${rc.class}\` is not a known class (known: ${Object.keys(cfg.classes).join(', ')})`);
  }
  for (const lane of cfg.lanes) if (!LANES.has(lane)) fail(`unknown lane \`${lane}\``);
  // A misspelt mode would silently fall back to the agent flow.
  if (cfg.tracker.via !== undefined && !['agent', 'api'].includes(cfg.tracker.via)) fail('`tracker.via` must be `agent` (the agent records captures) or `api` (the engine calls the tracker)');
  if (!Array.isArray(raw.repos) || raw.repos.length === 0) fail('`repos` must list at least one git root');
  const names = new Set();
  for (const r of raw.repos ?? []) {
    if (!r?.name || !r?.path) {
      fail('each repo needs `name` and `path`');
      continue;
    }
    if (names.has(r.name)) fail(`duplicate repo \`${r.name}\``);
    names.add(r.name);
    const packages = (r.packages ?? [{ path: '.' }]).map((p, i) => ({
      name: p.name ?? (p.path === '.' ? r.name : p.path),
      path: p.path ?? '.',
      sharedInfra: p.sharedInfra ?? [],
      docsOnly: p.docsOnly ?? [],
      index: i,
    }));
    cfg.repos.push({
      name: r.name,
      path: r.path,
      base: r.base ?? 'main',
      remote: r.remote ?? 'origin',
      sharedInfra: r.sharedInfra ?? [],
      packages,
      provision: { clone: [], fingerprint: [], install: null, copyIgnored: [], onWorktreeCreate: null, ...(r.provision ?? {}) },
    });
  }
  const repoNames = new Set(cfg.repos.map((r) => r.name));
  if (cfg.adapterRepo && !repoNames.has(cfg.adapterRepo)) fail(`adapterRepo \`${cfg.adapterRepo}\` is not a listed repo`);
  const stepIds = new Set();
  for (const [name, n] of Object.entries(cfg.gate.leases ?? {})) if (!Number.isInteger(n) || n < 1) fail(`lease \`${name}\` must allow at least 1 holder`);
  // Extra variables gate steps and provisioning receive beyond the base list (engine/env.mjs): names, or prefixes ending in `*`.
  if (cfg.gate.env !== undefined) {
    const pass = cfg.gate.env?.pass;
    if (!cfg.gate.env || typeof cfg.gate.env !== 'object' || (pass !== undefined && (!Array.isArray(pass) || pass.some((x) => typeof x !== 'string' || !x)))) fail('`gate.env.pass` must be a list of variable names or prefixes ending in `*`');
  }
  for (const s of cfg.gate.steps) {
    if (!s.id) fail('each gate step needs an `id`');
    if (stepIds.has(s.id)) fail(`duplicate gate step \`${s.id}\``);
    stepIds.add(s.id);
    if (!s.component && !repoNames.has(s.repo)) fail(`step \`${s.id}\`: unknown repo \`${s.repo}\``);
    if (!s.run && !s.plugin) fail(`step \`${s.id}\` needs \`run\` or \`plugin\``);
    if (s.tier && !['light', 'heavy'].includes(s.tier)) fail(`step \`${s.id}\`: tier must be light or heavy`);
    if (s.ignores && !Array.isArray(s.ignores)) fail(`step \`${s.id}\`: ignores must be a list of globs`);
    if (s.artifacts !== undefined) {
      if (!Array.isArray(s.artifacts) || s.artifacts.some((g) => typeof g !== 'string' || !g)) fail(`step \`${s.id}\`: artifacts must be a list of globs`);
      else for (const g of s.artifacts) {
        const unknown = placeholdersIn(g).filter((p) => !ARTIFACT_PLACEHOLDERS.includes(p));
        if (unknown.length) fail(`step \`${s.id}\`: artifacts glob \`${g}\` uses unknown placeholder(s) ${unknown.map((p) => `{${p}}`).join(', ')} (known: ${ARTIFACT_PLACEHOLDERS.map((p) => `{${p}}`).join(', ')})`);
      }
    }
    if (s.alsoInputs !== undefined) {
      if (!Array.isArray(s.alsoInputs)) fail(`step \`${s.id}\`: alsoInputs must be a list of repo names`);
      else for (const r of s.alsoInputs) if (!repoNames.has(r)) fail(`step \`${s.id}\`: alsoInputs names unknown repo \`${r}\``);
    }
  }
  // Review rules: documents a reviewer reads when the change touches the paths they govern (engine/rules.mjs).
  if (!Array.isArray(cfg.review.rules)) fail('`review.rules` must be a list of { id, repo?, paths?, read: [documents] }');
  else {
    const ruleIds = new Set();
    for (const r of cfg.review.rules) {
      if (!r?.id || typeof r.id !== 'string') {
        fail('each review rule needs a string `id`');
        continue;
      }
      if (ruleIds.has(r.id)) fail(`duplicate review rule \`${r.id}\``);
      ruleIds.add(r.id);
      if (!Array.isArray(r.read) || !r.read.length || r.read.some((d) => typeof d !== 'string' || !d)) fail(`review rule \`${r.id}\`: \`read\` must list at least one document path`);
      if (r.paths !== undefined && (!Array.isArray(r.paths) || !r.paths.length || r.paths.some((g) => typeof g !== 'string' || !g))) fail(`review rule \`${r.id}\`: \`paths\` must be a list of globs (omit it to use the first document's \`paths:\` frontmatter)`);
      if (r.repo !== undefined && !repoNames.has(r.repo)) fail(`review rule \`${r.id}\`: unknown repo \`${r.repo}\``);
    }
  }
  // Design system: the shared components and machine-checkable bans run over the attempt's added lines (engine/rules.mjs).
  if (cfg.designSystem !== null) {
    const ds = cfg.designSystem;
    const regex = (where, v) => {
      try {
        new RegExp(v);
        return true;
      } catch (error) {
        fail(`${where}: invalid regex \`${v}\` (${error.message})`);
        return false;
      }
    };
    const globs = (v) => v === undefined || (Array.isArray(v) && v.length && v.every((g) => typeof g === 'string' && g));
    if (typeof ds !== 'object' || Array.isArray(ds)) fail('`designSystem` must be a mapping { components: [{ name, path, use }], rules: [{ id, description, forbidPattern | pattern + requireWith, paths, except, read }] }');
    else {
      if (ds.components !== undefined && (!Array.isArray(ds.components) || ds.components.some((c) => !c?.name))) fail('`designSystem.components` must be a list of { name, path?, use? }');
      if (!Array.isArray(ds.rules ?? [])) fail('`designSystem.rules` must be a list');
      const ids = new Set();
      for (const r of ds.rules ?? []) {
        const where = `designSystem rule \`${r?.id ?? '?'}\``;
        if (!r?.id || typeof r.id !== 'string') {
          fail('each designSystem rule needs a string `id`');
          continue;
        }
        if (ids.has(r.id)) fail(`duplicate designSystem rule \`${r.id}\``);
        ids.add(r.id);
        if (!String(r.description ?? '').trim()) fail(`${where}: \`description\` says what the rule requires, in words the reviewer answers`);
        const trigger = r.forbidPattern ?? r.pattern;
        if (typeof trigger !== 'string' || !trigger) fail(`${where}: needs \`forbidPattern\` (a regex an added line must not match) or \`pattern\` with \`requireWith\``);
        else regex(where, trigger);
        if (r.forbidPattern !== undefined && r.pattern !== undefined) fail(`${where}: give \`forbidPattern\` or \`pattern\`, not both`);
        if (r.requireWith !== undefined) {
          if (!Array.isArray(r.requireWith) || !r.requireWith.length || r.requireWith.some((x) => typeof x !== 'string' || !x)) fail(`${where}: \`requireWith\` must be a list of regexes the changed file must also match`);
          else r.requireWith.forEach((x) => regex(where, x));
        } else if (r.pattern !== undefined) fail(`${where}: \`pattern\` needs \`requireWith\` (use \`forbidPattern\` for a ban)`);
        if (!globs(r.paths) || !globs(r.except)) fail(`${where}: \`paths\` and \`except\` must be lists of globs`);
        if (r.repo !== undefined && !repoNames.has(r.repo)) fail(`${where}: unknown repo \`${r.repo}\``);
        if (r.read !== undefined && typeof r.read !== 'string' && !(Array.isArray(r.read) && r.read.every((x) => typeof x === 'string'))) fail(`${where}: \`read\` is a document path (or a list of them)`);
      }
    }
  }
  for (const sk of cfg.requires.skills) {
    const w = sk?.when;
    const okWhen = w === undefined || w === null || w === 'visual' || (w && typeof w === 'object' && Array.isArray(w.paths) && w.paths.length && w.paths.every((g) => typeof g === 'string' && g));
    if (!okWhen) fail(`requires.skills \`${sk?.name}\`: \`when\` must be \`visual\` or { paths: [globs] }`);
  }
  const compIds = new Set(cfg.components.map((c) => c.id));
  for (const c of cfg.components) {
    if (!repoNames.has(c.repo)) fail(`component \`${c.id}\`: unknown repo \`${c.repo}\``);
    for (const d of c.dependsOn ?? []) if (!compIds.has(d.component)) fail(`component \`${c.id}\` depends on unknown \`${d.component}\``);
  }
  for (const s of cfg.gate.steps) {
    if (s.component) {
      const comp = cfg.components.find((c) => c.id === s.component);
      if (!comp) fail(`step \`${s.id}\`: unknown component \`${s.component}\``);
      else {
        s.repo = comp.repo;
        s.package = s.package ?? comp.package;
      }
    }
  }
  if (errors.length) throw new WfError(`${source}:\n  - ${errors.join('\n  - ')}`);
  return cfg;
}

export const repoDir = (root, repo) => path.resolve(root, repo.path);

// Where `.workflow/` lives in git: the repo that contains it, and its path inside that repo.
export function adapterLocation(root, cfg) {
  const real = fs.realpathSync(path.join(root, ADAPTER_DIR));
  const candidates = cfg.adapterRepo ? cfg.repos.filter((r) => r.name === cfg.adapterRepo) : cfg.repos;
  for (const repo of candidates) {
    const dir = fs.realpathSync(repoDir(root, repo));
    if (real === dir || real.startsWith(dir + path.sep)) return { repo, relative: path.relative(dir, real) };
  }
  throw new WfError('`.workflow/` is not inside any listed repo, so it cannot be read at a base commit', { hint: 'set `adapterRepo` and keep `.workflow/` committed in that repo' });
}

// The gate trusts the adapter as committed at the recorded base, never the ticket's copy.
export function loadConfigAtCommit(root, cfg, commit) {
  const { repo, relative } = adapterLocation(root, cfg);
  const file = path.posix.join(relative.split(path.sep).join('/'), CONFIG_FILE);
  const text = git(repoDir(root, repo), ['show', `${commit}:${file}`], { allowFail: true });
  if (!text) throw new WfError(`adapter not found at ${repo.name}@${commit.slice(0, 10)}:${file}`, { hint: 'commit .workflow/ to the base branch before admitting work' });
  return parseConfig(text, `${repo.name}@${commit.slice(0, 10)}:${file}`);
}

// Materialises an adapter file (step plugin, delivery or tracker adapter) exactly as committed at `commit`,
// so a ticket cannot change the code that judges it. Single-file modules only.
export function adapterFileAtCommit(root, cfg, commit, rel) {
  const { repo, relative } = adapterLocation(root, cfg);
  const file = path.posix.normalize(path.posix.join(relative.split(path.sep).join('/'), rel));
  const text = git(repoDir(root, repo), ['show', `${commit}:${file}`], { allowFail: true });
  if (!text) throw new WfError(`${rel} is not committed in ${repo.name}@${commit.slice(0, 10)}`, { hint: 'commit adapter code to the base branch; the engine only runs the committed copy' });
  // Rewritten on every load, so a modified copy is never run.
  const dest = path.join(root, '.wf-evidence', 'adapters', commit, `${hashValue(file).slice(0, 12)}-${path.basename(rel)}`);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, text);
  return dest;
}
