import fs from 'node:fs';
import path from 'node:path';
import { WfError, YAML, git, hashValue } from './util.mjs';

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
    repos: [],
  };
  for (const lane of cfg.lanes) if (!LANES.has(lane)) fail(`unknown lane \`${lane}\``);
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
  for (const s of cfg.gate.steps) {
    if (!s.id) fail('each gate step needs an `id`');
    if (stepIds.has(s.id)) fail(`duplicate gate step \`${s.id}\``);
    stepIds.add(s.id);
    if (!s.component && !repoNames.has(s.repo)) fail(`step \`${s.id}\`: unknown repo \`${s.repo}\``);
    if (!s.run && !s.plugin) fail(`step \`${s.id}\` needs \`run\` or \`plugin\``);
    if (s.tier && !['light', 'heavy'].includes(s.tier)) fail(`step \`${s.id}\`: tier must be light or heavy`);
    if (s.ignores && !Array.isArray(s.ignores)) fail(`step \`${s.id}\`: ignores must be a list of globs`);
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
