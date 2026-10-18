import { mkdirStateDirectory } from './state-folders.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { hostChoice, hostFor, hostIds } from './hosts/index.mjs';
import { ENGINE_PIN, WfError, YAML, assertPlainGit, git, hashValue, refuse } from './util.mjs';
import { routeProblems } from './status-route.mjs';
import { deploymentProblems } from './deployment.mjs';

export const ADAPTER_DIR = '.workflow';
export const CONFIG_FILE = 'project.yaml';

// The project root is the nearest ancestor holding `.workflow/project.yaml`.
// Inside an attempt worktree (…/.wf-worktrees/<id>/<repo>/…) the worktree's own copy is skipped, so commands
// run from where agents work resolve to the real project.
// Named failure (0.7.1, field): a multi-repo project keeps its adapter in one repo and links `<root>/.workflow` to it
// (the layout `wf init` makes). From any folder inside that repo the walk stopped at the repo's own `.workflow/` and took
// the repo for the project: `wf status` there listed no open attempts while the project had them, and `wf doctor` and
// `wf entry` failed with "`.workflow/` is not inside any listed repo". The project is the folder whose `.workflow` link
// leads to the adapter found, when one above links to it.
export function findRoot(start = process.cwd()) {
  let dir = path.resolve(start);
  for (;;) {
    const inWorktree = dir.split(path.sep).includes('.wf-worktrees');
    if (!inWorktree && fs.existsSync(path.join(dir, ADAPTER_DIR, CONFIG_FILE))) return linkingRoot(dir) ?? dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}
function linkingRoot(found) {
  let adapter;
  try {
    adapter = fs.realpathSync(path.join(found, ADAPTER_DIR));
  } catch {
    return null;
  }
  for (let dir = path.dirname(found); dir !== path.dirname(dir); dir = path.dirname(dir)) {
    const link = path.join(dir, ADAPTER_DIR);
    if (!fs.lstatSync(link, { throwIfNoEntry: false })?.isSymbolicLink()) continue;
    try {
      if (fs.realpathSync(link) === adapter) return dir;
    } catch {}
  }
  return null;
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

// Work classes: how hard a role's agent thinks, per runtime. The adapter's `classes` merge over these by name. What a
// class sets for each harness comes from that harness's adapter (`classDefaults`, engine/hosts/).
// Defaults are unmeasured starting points; guarantees (gate, blind review, frozen criteria) never depend on a class.
const CLASS_USES = {
  full: "Money, payments, audit, authorization, data isolation between customers, migrations, external protocols, and anything the project's invariants file calls a critical boundary.",
  light: 'UI wired to a frozen contract, translations, generated docs or OpenAPI output, test fixtures.',
  // Named failure (I-25, I-26): the planner and reviewer roles had no model, so they inherited the owner session's
  // weaker one; a cross-cutting plan was written in minutes and five review rounds passed defects a stronger model found
  // later. Planning and review default to this class, which pins the strongest model (`wf doctor` fails when either role
  // resolves to no model on the runtime it runs on).
  review: 'Planning and independent review: the whole change judged against the frozen criteria.',
  // 0.7.22 (D28): the planner role's own class, so planning and review can run on different models.
  planning: 'Planning: produce the plan and frozen acceptance criteria for the whole change.',
};
export function defaultClasses() {
  const out = {};
  for (const [name, use] of Object.entries(CLASS_USES)) {
    out[name] = { use };
    for (const id of hostIds()) out[name][id] = { ...(hostFor(id).classDefaults?.[name] ?? {}) };
  }
  return out;
}
export const ROLE_DEFAULT_CLASS = { planner: 'planning', reviewer: 'review', implementer: 'full', tester: 'full', strategist: 'review' };

// What the engine stops for on its own, from the adapter's `strategy:` block (engine/strategy.mjs). Only the owner's
// escalation is a number: the engine judges no work against a threshold it picked, so the amendment, file, bundle-size,
// wall-time and idle-session tripwires are gone (agents state their own expectations; the owner agent compares them with
// what happened). `enabled: false` turns the escalation off for a project.
export const STRATEGY_DEFAULTS = {
  enabled: true,
  // Handed review rounds before the owner (not the strategist) decides how to continue; again as many rounds after each answer.
  // The person's own number, not an agent-facing limit: one ticket ran 47 rounds before anyone stepped back.
  reviewRoundsEscalate: 10,
};

function mergeClasses(raw, fail) {
  const out = {};
  const ids = hostIds();
  for (const [name, c] of Object.entries(defaultClasses())) out[name] = c;
  if (raw !== undefined && (raw === null || typeof raw !== 'object' || Array.isArray(raw))) {
    fail(`\`classes\` must map class names to { use, ${ids.join(', ')} }`);
    return out;
  }
  for (const [name, c] of Object.entries(raw ?? {})) {
    // The name becomes an agent file name (wf-implementer-<class>).
    if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) fail(`class \`${name}\`: use lowercase letters, digits and dashes`);
    const prev = out[name] ?? Object.fromEntries(ids.map((id) => [id, {}]));
    out[name] = { ...prev, ...(c ?? {}) };
    for (const id of ids) out[name][id] = { ...prev[id], ...(c?.[id] ?? {}) };
  }
  for (const [name, c] of Object.entries(out)) {
    if (typeof c.use !== 'string' || !c.use.trim()) fail(`class \`${name}\` needs \`use\`: what work belongs in it (the planner assigns classes from this text)`);
    // Named failure I-29: a static effort allow-list rejected new host-supported settings until a plugin release.
    // Hosts own model/effort support. Validate only the shape here, keeping agent metadata on a single line.
    for (const runtime of ids) {
      for (const field of ['model', 'effort']) {
        const value = c[runtime]?.[field];
        if (value !== undefined && value !== null && (typeof value !== 'string' || !value.trim() || /[\u0000-\u001f\u007f]/.test(value))) {
          fail(`class \`${name}\`: ${runtime} ${field} must be a non-empty string without control characters`);
        }
      }
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
  // A planning panel's seat at another class has its own agent type, as an implementer class has (0.7.22).
  if (role !== 'implementer' && role !== 'planner') return `wf-${role}`;
  return cls === roleClass(cfg, role) ? `wf-${role}` : `wf-${role}-${cls}`;
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

// 0.7.30 (I-163, D56): each `needs` is a list of other steps of the gate, and no steps need each other in a cycle (the gate
// would wait forever). A cycle that a ticket's registered check brings in is ended by the gate's scheduler (engine/gate.mjs).
export function gateNeedsProblems(steps) {
  const out = [];
  const ids = new Set(steps.map((s) => s.id));
  for (const s of steps) {
    if (s.needs === undefined) continue;
    if (!Array.isArray(s.needs) || s.needs.some((n) => typeof n !== 'string' || !n)) {
      out.push(`step \`${s.id}\`: needs must be a list of step ids (the steps whose output it consumes)`);
      continue;
    }
    for (const n of s.needs) {
      if (n === s.id) out.push(`step \`${s.id}\`: needs names the step itself`);
      else if (!ids.has(n)) out.push(`step \`${s.id}\`: needs names unknown step \`${n}\``);
    }
  }
  if (out.length) return out;
  const needsOf = new Map(steps.map((s) => [s.id, s.needs ?? []]));
  const state = new Map();
  const cycle = (id, trail) => {
    if (state.get(id) === 'done') return null;
    if (state.get(id) === 'open') return [...trail.slice(trail.indexOf(id)), id];
    state.set(id, 'open');
    for (const n of needsOf.get(id) ?? []) {
      const c = cycle(n, [...trail, id]);
      if (c) return c;
    }
    state.set(id, 'done');
    return null;
  };
  for (const s of steps) {
    const c = cycle(s.id, []);
    if (c) return [`gate steps need each other in a cycle: ${c.join(' → ')} (\`needs\` names the steps whose output a step consumes; one of them must not need the other)`];
  }
  return out;
}

function normalize(raw, source) {
  const errors = [];
  const fail = (m) => errors.push(m);
  if (raw.version !== 1) fail('`version` must be 1');
  if (raw.leaving !== undefined && raw.leaving !== null) {
    const l = raw.leaving;
    if (typeof l !== 'object' || Array.isArray(l)) fail('`leaving` is { high, medium, low }: who lets an unfixed item of that level leave a delivery (never, person or owner)');
    else for (const [k, v] of Object.entries(l)) {
      if (!['high', 'medium', 'low'].includes(k)) fail(`\`leaving.${k}\`: the levels are high, medium and low`);
      else if (!['never', 'person', 'owner'].includes(v)) fail(`\`leaving.${k}\` is never, person or owner, not \`${v}\``);
    }
  }
  if (raw.severity !== undefined && raw.severity !== null) {
    const sv = raw.severity;
    const list = (v) => Array.isArray(v) && v.every((x) => typeof x === 'string' && x.trim());
    if (typeof sv !== 'object' || Array.isArray(sv)) fail('`severity` is { high, medium, low }: lists of the project\'s own examples added to each level of the scale');
    else for (const [k, v] of Object.entries(sv)) {
      if (!['high', 'medium', 'low'].includes(k)) fail(`\`severity.${k}\`: the levels are high, medium and low`);
      else if (!list(v)) fail(`\`severity.${k}\` is a list of examples (text)`);
    }
  }
  // 0.7.9 (D19): project learning. `enabled: false` turns the classifier off; `classifier.<runtime>` pins its model and
  // effort over the host's defaults (any non-empty string, as a class's are: I-29).
  if (raw.learning !== undefined && raw.learning !== null) {
    const ln = raw.learning;
    if (typeof ln !== 'object' || Array.isArray(ln)) fail('`learning` is { enabled, classifier: { <runtime>: { model, effort } } }');
    else {
      for (const k of Object.keys(ln)) if (!['enabled', 'classifier'].includes(k)) fail(`\`learning.${k}\`: learning takes \`enabled\` and \`classifier\``);
      if (ln.enabled !== undefined && typeof ln.enabled !== 'boolean') fail('`learning.enabled` is true or false');
      const c = ln.classifier;
      if (c !== undefined && c !== null && (typeof c !== 'object' || Array.isArray(c))) fail(`\`learning.classifier\` maps runtimes (${hostIds().join(', ')}) to { model, effort }`);
      else for (const [rt, pin] of Object.entries(c ?? {})) {
        if (!hostIds().includes(rt)) fail(`\`learning.classifier.${rt}\`: the runtimes are ${hostIds().join(', ')}`);
        else if (!pin || typeof pin !== 'object' || Array.isArray(pin)) fail(`\`learning.classifier.${rt}\` is { model, effort }`);
        else for (const [field, value] of Object.entries(pin)) {
          if (!['model', 'effort'].includes(field)) fail(`\`learning.classifier.${rt}.${field}\`: a classifier pins \`model\` and \`effort\``);
          else if (typeof value !== 'string' || !value.trim() || /[\u0000-\u001f\u007f]/.test(value)) fail(`\`learning.classifier.${rt}.${field}\` must be a non-empty string without control characters`);
        }
      }
    }
  }
  const cfg = {
    version: raw.version,
    enabled: raw.enabled === true,
    name: raw.name ?? 'project',
    engine: raw.engine ?? null,
    adapterRepo: raw.adapterRepo ?? null,
    instructionFiles: raw.instructionFiles ?? null,
    lanes: raw.lanes ?? ['quick', 'standard'],
    invariants: raw.invariants ?? null,
    // 0.7.8 (D18): who may let an unfixed item of each level leave a delivery (never, person or owner), and the project's own
    // words added to the one severity scale every role reads.
    leaving: raw.leaving ?? null,
    severity: raw.severity ?? null,
    learning: raw.learning ?? null,
    roles: raw.roles ?? {},
    focused: raw.focused ?? [],
    requires: { skills: raw.requires?.skills ?? [], connectors: raw.requires?.connectors ?? [], tools: raw.requires?.tools ?? [] },
    tracker: { kind: 'none', statuses: {}, events: null, commentRules: { forbid: [] }, ...(raw.tracker ?? {}) },
    delivery: { kind: 'push-main', ...(raw.delivery ?? {}) },
    secrets: { store: 'env-file', ...(raw.secrets ?? {}) },
    gate: { maxParallelSteps: 1, leases: {}, steps: [], ...(raw.gate ?? {}) },
    components: raw.components ?? [],
    // `integrationCheck` (default true): with several work items the combined tree passes `wf check` before a review.
    review: { rules: raw.review?.rules ?? [], integrationCheck: raw.review?.integrationCheck ?? true },
    // The project's quality bar (0.7.0): standing goals the planner turns into targets for each ticket and every role reads.
    quality: raw.quality === undefined || raw.quality === null ? [] : raw.quality,
    designSystem: raw.designSystem ?? null,
    impact: raw.impact ?? null,
    strategy: { ...STRATEGY_DEFAULTS },
    repos: [],
  };
  // The owner escalation: an unknown key or a non-positive number would silently leave the 10-round stop unwatched.
  if (raw.strategy !== undefined && raw.strategy !== null) {
    if (typeof raw.strategy !== 'object' || Array.isArray(raw.strategy)) fail(`\`strategy\` must be a mapping of strategy values (known: ${Object.keys(STRATEGY_DEFAULTS).join(', ')})`);
    else {
      for (const [k, v] of Object.entries(raw.strategy)) {
        if (!(k in STRATEGY_DEFAULTS)) fail(`strategy.${k}: unknown (known: ${Object.keys(STRATEGY_DEFAULTS).join(', ')})`);
        else if (k === 'enabled' ? typeof v !== 'boolean' : typeof v !== 'number' || !(v > 0)) fail(`strategy.${k} must be ${k === 'enabled' ? 'true or false' : 'a positive number'}`);
        else cfg.strategy[k] = v;
      }
    }
  }
  cfg.classes = mergeClasses(raw.classes, fail);
  // Impact analysis (engine/impact.mjs): which work classes need the planner's survey and impact map, and read caps.
  if (cfg.impact !== null) {
    const im = cfg.impact;
    if (typeof im !== 'object' || Array.isArray(im)) fail('`impact` must be a mapping { requiredFor: [classes], maxFileBytes, maxScanBytes, regexTimeoutMs }');
    else {
      if (im.requiredFor !== undefined && (!Array.isArray(im.requiredFor) || im.requiredFor.some((c) => !cfg.classes[c]))) fail(`\`impact.requiredFor\` must list known classes (known: ${Object.keys(cfg.classes).join(', ')})`);
      for (const k of ['maxFileBytes', 'maxScanBytes', 'regexTimeoutMs']) if (im[k] !== undefined && (!Number.isInteger(im[k]) || im[k] < 1)) fail(`\`impact.${k}\` must be a positive integer`);
    }
  }
  if (cfg.engine !== null && !ENGINE_PIN.test(String(cfg.engine).trim())) fail(`\`engine\` must be \`N.x\` (same major) or \`>=x.y.z\` (at least that release), not \`${cfg.engine}\``);
  for (const [role, rc] of Object.entries(cfg.roles)) {
    if (!rc || typeof rc !== 'object') continue;
    // Pre-launch replacement: per-role model/effort moved to classes; refusing them keeps a stale setting from being silently ignored.
    const moved = ['model', 'effort', ...hostIds()].filter((k) => k in rc);
    if (moved.length) fail(`roles.${role}: ${moved.join(', ')} moved to \`classes\`; set \`roles.${role}.class\` and the class's ${hostChoice('/')} effort and model`);
    if (rc.class !== undefined && !cfg.classes[rc.class]) fail(`roles.${role}.class \`${rc.class}\` is not a known class (known: ${Object.keys(cfg.classes).join(', ')})`);
    // 0.7.22 (D28): the planning panel's seats are classes.
    if (rc.panel !== undefined && (role !== 'planner' || !Array.isArray(rc.panel) || !rc.panel.length || rc.panel.some((c) => !cfg.classes[c]))) fail(role !== 'planner' ? `roles.${role}.panel: only the planner has a panel` : `roles.planner.panel lists the planner seats as known classes, at least one (known: ${Object.keys(cfg.classes).join(', ')})`);
    if (rc.runtime !== undefined && !hostIds().includes(rc.runtime)) fail(`roles.${role}.runtime must be ${hostChoice(' or ')}`);
  }
  for (const lane of cfg.lanes) if (!LANES.has(lane)) fail(`unknown lane \`${lane}\``);
  // A tracker is a kind (where the tasks live) and a via (how wf reaches it). A misspelt mode would silently fall back to
  // the agent flow. `agent` is the older name of `connector`.
  const VIAS = { linear: ['api', 'connector'], github: ['cli', 'api', 'connector'], files: ['files'], none: [] };
  if (cfg.tracker.via === 'agent') cfg.tracker.via = 'connector';
  if (cfg.tracker.via === undefined) cfg.tracker.via = { linear: 'connector', github: 'cli', files: 'files' }[cfg.tracker.kind] ?? 'connector';
  if (VIAS[cfg.tracker.kind] && cfg.tracker.kind !== 'none' && !VIAS[cfg.tracker.kind].includes(cfg.tracker.via)) fail(`\`tracker.via\` for ${cfg.tracker.kind} is one of ${VIAS[cfg.tracker.kind].join(', ')}, not \`${cfg.tracker.via}\``);
  if (!VIAS[cfg.tracker.kind] && !String(cfg.tracker.kind).startsWith('.')) fail(`\`tracker.kind\` is one of linear, github, files, none (or a project adapter \`./file.mjs\`), not \`${cfg.tracker.kind}\``);
  if (cfg.tracker.kind === 'github' && !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(String(cfg.tracker.repo ?? ''))) fail('`tracker.repo` names the GitHub repository holding the issues: `owner/name`');
  // 0.7.27 (I-190): the person's routing of a step's status by the ticket's labels.
  for (const problem of routeProblems(cfg.tracker)) fail(problem);
  // 0.7.27 (I-196, D42): the delivery waits after the merge for the deployment to be confirmed, for every ticket or labelled ones.
  for (const problem of deploymentProblems(cfg)) fail(problem);
  if (cfg.tracker.itemPattern !== undefined) {
    let bad = typeof cfg.tracker.itemPattern !== 'string' || !cfg.tracker.itemPattern;
    if (!bad) {
      try {
        new RegExp(cfg.tracker.itemPattern);
      } catch {
        bad = true;
      }
    }
    if (bad) fail('`tracker.itemPattern` must be a regular expression (a string) that every ticket id of this tracker matches, for example `^ENG-\\d+$`');
  }
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
  // What a quick fix's gate runs (D23): the plugin's default is the light steps; a project may set `full`.
  if (cfg.gate.quickLane !== undefined && !['light', 'full'].includes(cfg.gate.quickLane)) fail('`gate.quickLane` is `light` (the default: a quick fix runs light steps only) or `full`');
  // Extra variables gate steps and provisioning receive beyond the base list (engine/env.mjs): names, or prefixes ending in `*`.
  if (cfg.gate.env !== undefined) {
    const pass = cfg.gate.env?.pass;
    if (!cfg.gate.env || typeof cfg.gate.env !== 'object' || (pass !== undefined && (!Array.isArray(pass) || pass.some((x) => typeof x !== 'string' || !x)))) fail('`gate.env.pass` must be a list of variable names or prefixes ending in `*`');
  }
  for (const s of cfg.gate.steps) {
    if (!s.id) fail('each gate step needs an `id`');
    if (stepIds.has(s.id)) fail(`duplicate gate step \`${s.id}\``);
    // `provision:<repo>` in a secret's `usedBy` names a repo's provisioning (D14); a step of that id would receive its keys.
    if (String(s.id).startsWith('provision:')) fail(`step \`${s.id}\`: an id starting with \`provision:\` names a repo's provisioning in \`usedBy\` (D14); choose another id`);
    stepIds.add(s.id);
    if (!s.component && !repoNames.has(s.repo)) fail(`step \`${s.id}\`: unknown repo \`${s.repo}\``);
    if (s.prepare !== undefined && (typeof s.prepare !== 'string' || !s.prepare.trim())) fail(`step \`${s.id}\`: \`prepare\` is a non-empty shell command`);
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
    // 0.7.28 (I-212): the step's own spec files (globs, relative to its package): a batch member whose heavy steps are deferred
    // runs the ones its change adds or edits, through the step's `select`.
    if (s.specs !== undefined) {
      if (!Array.isArray(s.specs) || !s.specs.length || s.specs.some((g) => typeof g !== 'string' || !g.trim())) fail(`step \`${s.id}\`: specs must be a list of globs naming the step's spec files`);
      else if (!s.select || s.plugin) fail(`step \`${s.id}\`: specs needs \`run\` with \`select\` (how the runner takes spec files, with \`{suites}\`), so a run can be limited to some of them`);
    }
    // 0.7.30 (I-134, D59): which of the step's spec files a change can affect, for a standard attempt to run only those.
    if (s.affects !== undefined) {
      const globs = (g) => Array.isArray(g) && g.length && g.every((x) => typeof x === 'string' && x.trim());
      if (!Array.isArray(s.affects) || !s.affects.length || s.affects.some((a) => !a || typeof a !== 'object' || !globs(a.paths) || !globs(a.specs))) fail(`step \`${s.id}\`: affects must be a list of { paths: [globs], specs: [globs] }: the package files a change can be in, and the spec files (of \`specs\`) such a change can affect`);
      else if (!s.specs?.length) fail(`step \`${s.id}\`: affects needs \`specs\` (the step's spec files) and \`run\` with \`select\`, so a run can take only some of them`);
    }
    if (s.alsoInputs !== undefined) {
      if (!Array.isArray(s.alsoInputs)) fail(`step \`${s.id}\`: alsoInputs must be a list of repo names`);
      else for (const r of s.alsoInputs) if (!repoNames.has(r)) fail(`step \`${s.id}\`: alsoInputs names unknown repo \`${r}\``);
    }
  }
  // 0.7.30 (I-163, D56): `needs` names the steps whose output a step consumes; the gate starts it only after they finished.
  gateNeedsProblems(cfg.gate.steps).forEach(fail);
  if (typeof cfg.review.integrationCheck !== 'boolean') fail('`review.integrationCheck` must be true or false');
  if (!Array.isArray(cfg.quality) || cfg.quality.some((q) => typeof q !== 'string' || !q.trim())) fail('`quality` is a list of standing goals, each a non-empty sentence');
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

// Where `.workflow/` lives in git: the repo that contains it (`repo`, its real folder `dir`) and its path inside that
// repo (`relative`), read from the working tree. Used before an attempt exists (admission, doctor); an attempt's adapter
// is found from what its admission recorded (`attemptAdapter`).
//
// Named failure (0.5.0 adversarial review): the location was the real path of `<root>/.workflow`, so replacing it with a
// link to another folder committed at the same base (an example adapter with a weaker gate) made "the adapter committed
// at base" that folder. A real `.workflow/` folder is where it is; a link is followed only to the top-level `.workflow/`
// of a listed repo (a workspace root linking to the adapter repo's folder), and refused anywhere else.
export function adapterLocation(root, cfg) {
  const link = path.join(root, ADAPTER_DIR);
  const st = fs.lstatSync(link, { throwIfNoEntry: false });
  if (!st) throw new WfError(`${link} does not exist`);
  const real = fs.realpathSync(link);
  const candidates = cfg.adapterRepo ? cfg.repos.filter((r) => r.name === cfg.adapterRepo) : cfg.repos;
  for (const repo of candidates) {
    let dir;
    try {
      dir = fs.realpathSync(repoDir(root, repo));
    } catch {
      continue;
    }
    if (st.isSymbolicLink() ? real !== path.join(dir, ADAPTER_DIR) : !(real === dir || real.startsWith(dir + path.sep))) continue;
    return { repo, dir, relative: path.relative(dir, real) };
  }
  if (st.isSymbolicLink()) throw refuse(`${link} is a link to ${real}, which is not the top-level ${ADAPTER_DIR}/ of ${cfg.adapterRepo ? `the adapter repo \`${cfg.adapterRepo}\`` : 'a listed repo'}; the adapter at base is never read through it`, `make ${ADAPTER_DIR} a real folder, or a link to <adapter repo>/${ADAPTER_DIR}`);
  throw new WfError('`.workflow/` is not inside any listed repo, so it cannot be read at a base commit', { hint: 'set `adapterRepo` and keep `.workflow/` committed in that repo' });
}

// What admission records about the adapter: the repo's name, its real folder and the adapter folder inside it.
export function adapterRecord(root, cfg) {
  const { repo, dir, relative } = adapterLocation(root, cfg);
  return { repo: repo.name, dir, relative: relative.split(path.sep).join('/') };
}

const asLocation = (rec) => ({ repo: { name: rec.repo, path: rec.dir }, dir: rec.dir, relative: rec.relative });

// The adapter of an attempt, found from its admission record only.
//
// Named failure (0.5.0 adversarial review): every read of "the adapter at base" located it through the working tree's
// `.workflow/project.yaml` (`adapterRepo`, the repos' paths), and several callers caught the error and went on with the
// working copy. An uncommitted `adapterRepo` edit made the read throw, and then impact queries read any checkout the
// working copy named and the impact analysis could be switched off. The location is now recorded at admission and read
// back from the ledger; a missing record, a missing base or a `.workflow` that now resolves elsewhere refuses.
// Attempts admitted before the record existed are located from the working tree under the same strict rules and
// cross-checked against the adapter they read (`checkAdapter`).
export function attemptAdapter(root, state) {
  if (!state?.adapterBase) throw refuse(`${state?.id ?? 'this attempt'} has no recorded adapter base, so the adapter that judges it cannot be read`, 'abandon the attempt and admit the work again');
  const rec = state.adapter;
  if (!rec) {
    const live = adapterLocation(root, loadConfig(root));
    return { ...live, legacy: true };
  }
  if (typeof rec.repo !== 'string' || typeof rec.dir !== 'string' || typeof rec.relative !== 'string' || !path.isAbsolute(rec.dir) || rec.relative.split('/').includes('..')) throw refuse(`${state.id}'s recorded adapter location is malformed`);
  let live = null;
  try {
    live = fs.realpathSync(path.join(root, ADAPTER_DIR));
  } catch {}
  const recorded = path.join(rec.dir, ...rec.relative.split('/').filter(Boolean));
  if (live !== recorded) throw refuse(`${path.join(root, ADAPTER_DIR)} now resolves to ${live ?? 'nothing'}; the adapter of ${state.id} was recorded at admission in ${rec.repo} at ${recorded}`, `restore ${ADAPTER_DIR} (a real folder, or a link to <adapter repo>/${ADAPTER_DIR}) as it was when ${state.id} was admitted`);
  return asLocation(rec);
}

// The committed adapter must name the repo and folder it was read from: `adapterRepo` (when set) is that repo, and that
// repo's path resolves to the folder it was read in.
function checkAdapter(root, t, loc, where) {
  if (t.adapterRepo && t.adapterRepo !== loc.repo.name) throw refuse(`${where} names \`${t.adapterRepo}\` as the adapter repo, but it was read from \`${loc.repo.name}\``);
  const own = t.repos.find((r) => r.name === loc.repo.name);
  let dir = null;
  try {
    dir = own ? fs.realpathSync(repoDir(root, own)) : null;
  } catch {}
  if (dir !== loc.dir) throw refuse(`${where} does not list \`${loc.repo.name}\` at ${loc.dir}, the folder it was read from (it says ${own ? own.path : 'nothing'})`);
  return t;
}

function readAdapter(root, loc, commit) {
  assertPlainGit(loc.dir);
  const file = path.posix.join(loc.relative.split(path.sep).join('/'), CONFIG_FILE);
  const text = git(loc.dir, ['show', `${commit}:${file}`], { allowFail: true });
  if (!text) throw refuse(`adapter not found at ${loc.repo.name}@${String(commit).slice(0, 10)}:${file}`, 'commit .workflow/ to the base branch before admitting work');
  const where = `${loc.repo.name}@${String(commit).slice(0, 10)}:${file}`;
  return checkAdapter(root, parseConfig(text, where), loc, where);
}

// Before admission (entry, doctor): the adapter committed at `commit`, located from the working tree.
export function loadConfigAtCommit(root, cfg, commit) {
  return readAdapter(root, adapterLocation(root, cfg), commit);
}

// The adapter that judges an attempt: committed at its admission base (or `commit`, a later pin of the same repo),
// located from its admission record. Never falls back to the working copy.
export function trustedAdapter(root, state, commit = state?.adapterBase) {
  const loc = attemptAdapter(root, state);
  if (!commit) throw refuse(`${state.id} has no adapter commit to read`);
  return readAdapter(root, loc, commit);
}

// Materialises an adapter file (step plugin, delivery or tracker adapter) exactly as committed at `commit`,
// so a ticket cannot change the code that judges it. Single-file modules only.
//
// Named failure (0.5.0 integration review): the delivery adapter re-pin made this the path that loads code from a new
// commit, and the materialised copy was written with a plain write: a link planted at that path (or at the folder) was
// followed, so the engine wrote, then imported, a file somewhere else. The commit names a folder, so it must be a
// commit id; `rel` stays inside the adapter folder; the folder is a real folder inside the project; the copy is
// written to a fresh name without following links, then renamed over the old copy (a rename replaces a link, never
// follows it).
const COMMIT_ID = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
export function adapterFileAtCommit(root, state, commit, rel) {
  if (!COMMIT_ID.test(String(commit))) throw new WfError(`not a commit id: \`${String(commit).slice(0, 80)}\``);
  const { repo, relative } = attemptAdapter(root, state);
  assertPlainGit(repoDir(root, repo));
  const base = relative.split(path.sep).join('/');
  const file = path.posix.normalize(path.posix.join(base, String(rel)));
  if (path.posix.isAbsolute(file) || file === '..' || file.startsWith('../') || (base && file !== base && !file.startsWith(`${base}/`))) throw new WfError(`adapter file \`${rel}\` is outside the adapter folder`);
  const text = git(repoDir(root, repo), ['show', `${commit}:${file}`], { allowFail: true });
  if (!text) throw new WfError(`${rel} is not committed in ${repo.name}@${commit.slice(0, 10)}`, { hint: 'commit adapter code to the base branch; the engine only runs the committed copy' });
  // Rewritten on every load, so a modified copy is never run.
  const dir = path.join(root, '.wf-evidence', 'adapters', commit);
  mkdirStateDirectory(dir, { recursive: true });
  const realRoot = fs.realpathSync(root);
  if (fs.realpathSync(dir) !== path.join(realRoot, '.wf-evidence', 'adapters', commit)) throw new WfError(`${dir} is not a real folder inside the project (a link on its path); adapter code is not written through it`);
  const dest = path.join(dir, `${hashValue(file).slice(0, 12)}-${path.basename(file)}`);
  const tmp = `${dest}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  const fd = fs.openSync(tmp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW ?? 0), 0o644);
  try {
    fs.writeSync(fd, text);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, dest);
  return dest;
}
