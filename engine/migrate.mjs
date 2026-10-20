// Migration from 0.7 (design-0.8 section 9, stream 7).
//   - The adapter: an onboarding run seeded from the schema 1 adapter (`wf init --from-07`); `from07` builds the seed, the
//     policy draft, the dropped-key list and the product imports into `.workflow/`.
//   - `wf migrate attempts`: open 0.7 attempts are closed as superseded (branches kept), or as shipped when git cherry finds
//     every commit already on the base; held attempts are skipped and listed.
//   - `wf migrate material`: what of `.workflow/` the new adapter no longer references, and product code that imports it.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { TRACKER_OPERATIONS, WfError, append, listAttempts, loadAdapter, readEvents } from './contract.mjs';
import { importBaseModule, moduleFolder } from './base-module.mjs';
import { repoFiles } from './scan.mjs';

const TERMINAL = ['closed', 'abandoned', 'analysis.closed', 'shipped.closed', 'attempt.closed'];
const clip = (s, n = 140) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

function git(cwd, args, input) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', input, maxBuffer: 64 * 1024 * 1024 });
  return { ok: r.status === 0, out: (r.stdout ?? '').trim(), err: (r.stderr ?? '').trim() };
}

// ---------------------------------------------------------------------------------------------------------------------
// Product code that imports workflow material
// ---------------------------------------------------------------------------------------------------------------------

const IMPORT = /\b(import|require|require_once|include|include_once|from|source|load)\b[^'"`\n]*['"`][^'"`\n]*\.workflow\/[^'"`\n]*['"`]/;

/** Lines of product code (outside `.workflow/`) that import or require a file under `.workflow/`: removing the material
 * breaks them, so each removal ticket fixes them too. */
export function productImports(root, repos) {
  const out = [];
  for (const r of repos ?? []) {
    const dir = path.resolve(root, r.path);
    if (!fs.existsSync(dir)) continue;
    const prefix = r.path === '.' ? '' : `${r.path}/`;
    for (const f of repoFiles(dir)) {
      if (f.startsWith('.workflow/') || !/\.(m?[jt]sx?|c[jt]s|php|py|rb|sh|bash|go|java|kt|swift|dart)$/i.test(f)) continue;
      let text;
      try {
        text = fs.readFileSync(path.join(dir, f), 'utf8');
      } catch {
        continue;
      }
      if (!text.includes('.workflow/')) continue;
      text.split('\n').forEach((l, i) => IMPORT.test(l) && out.push({ repo: r.name, file: `${prefix}${f}`, line: i + 1, at: `${prefix}${f}:${i + 1}`, text: clip(l.trim()) }));
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------
// Project modules: loaded only as committed on the repo's fetched base, from their own folder
// ---------------------------------------------------------------------------------------------------------------------

const REL_IMPORT = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|^\s*import\s+)['"`](\.{1,2}\/[^'"`]+)['"`]/gm;

/** The modules an adapter (raw or normalised) names, each with its kind: tests, tracker, delivery stages, screens routes
 * and capture. */
export function moduleRefsOf(a) {
  return [
    ...(a.repos ?? []).flatMap((r) => ['fast', 'full'].map((k) => r.tests?.[k]?.module && { what: `tests.${r.name}.${k}`, kind: 'tests', ...r.tests[k].module }).filter(Boolean)),
    ...(a.ticketing?.tracker?.module ? [{ what: 'ticketing.tracker', kind: 'tracker', ...a.ticketing.tracker.module }] : []),
    ...(a.delivery?.stages ?? []).map((s, i) => s.module && { what: `delivery.stages[${i}]`, kind: 'stage', ...s.module }).filter(Boolean),
    ...(a.screens?.routes ? [{ what: 'screens.routes', kind: 'routes', ...a.screens.routes }] : []),
    ...(a.screens?.capture?.module ? [{ what: 'screens.capture', kind: 'capture', ...a.screens.capture.module }] : []),
  ];
}

// What each kind of module must export by default, as the engine calls it (engine/tests.mjs, delivery.mjs, tracker.mjs,
// screens.mjs). Printed when a module is not usable as is.
const DRIVER_METHODS = ['read', 'search', 'create', 'setStatus', 'comment'];
export const MODULE_CONTRACTS = {
  tests: 'export default async ({ cwd, env, repo, kind, attempt }) => ({ pass: boolean, log?: string }); cwd is the tree under test, kind is fast, full or risk-base',
  stage: 'export default async ({ root, attempt, item, index, stage, marker, repos, observed }) => ({ state: \'done\'|\'waiting\'|\'pending\'|\'skipped\', evidence?, next? }); repos maps each repo to { dir, branch, base, remote, tip }',
  tracker: `export default async ({ root, adapter }) => driver, or the driver itself: an object with ${DRIVER_METHODS.join(', ')} (and optionally normalise)`,
  routes: 'export default async (changedFiles: string[]) => string[] (the routes those files reach)',
  capture: 'export default async (ctx) => ..., called with ctx.cwd set to the attempt folder (docs/adapter.md, `screens.capture`)',
};
const shapeOf = (v) => (v === undefined ? 'no default export' : v === null ? 'a default export of null' : Array.isArray(v) ? 'an array' : typeof v === 'object' ? `an object (${Object.keys(v).join(', ') || 'no keys'})` : `a ${typeof v}`);
// The export's shape problem for the module's kind, or null when it is usable as is. `via` is the adapter's
// `ticketing.via`: the engine calls a tracker's driver methods only with `via: module`; through a connector the module
// gives the owner its `operations` words, as a named export or on the default object.
export function exportProblem(kind, def, { via = 'module', operations } = {}) {
  if (typeof def === 'function') return null;
  if (kind === 'tracker' && via === 'connector') {
    const ops = operations ?? (def && typeof def === 'object' ? def.operations : undefined);
    if (ops && typeof ops === 'object' && !Array.isArray(ops)) return null;
    return `exports ${shapeOf(def)} by default and no \`operations\`: with \`ticketing.via: connector\` the module gives the owner its words for each operation. Export \`operations\` (named, or on the default object), keyed by ${TRACKER_OPERATIONS.join(', ')}`;
  }
  if (kind === 'tracker' && via !== 'module') return null; // files and none call no project driver
  if (kind === 'tracker' && def && typeof def === 'object') {
    const missing = DRIVER_METHODS.filter((m) => typeof def[m] !== 'function');
    if (!missing.length) return null;
    return `exports ${shapeOf(def)} by default, which lacks ${missing.join(', ')}: it is not usable as is. Rewrite it for the 0.8 tracker contract: ${MODULE_CONTRACTS.tracker}`;
  }
  return `exports ${shapeOf(def)} by default, not a function: it is not usable as is. Rewrite it for the 0.8 ${kind === 'stage' ? 'delivery stage' : kind} contract: ${MODULE_CONTRACTS[kind]}`;
}

/** Problems of each module as it would load (engine/base-module.mjs, the shared loader): not committed on its repo's
 * fetched base; importing (itself or a helper in its folder) a file outside its top-level folder in the repo, which does
 * not resolve because only that folder is extracted at the base (a module at the repo's root extracts the whole repo);
 * failing to load; or exports its kind cannot use (`via`: the adapter's `ticketing.via`). */
export async function moduleProblems(root, repos, refs, { fetch = true, via = 'module' } = {}) {
  const out = [];
  const seen = new Set();
  for (const m of refs) {
    const key = `${m.repo}/${m.path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const repo = repos.find((r) => r.name === m.repo);
    if (!repo) {
      out.push({ what: m.what, module: key, problem: `names repo \`${m.repo}\`, which the adapter does not list` });
      continue;
    }
    const dir = path.resolve(root, repo.path);
    const remote = repo.remote ?? 'origin';
    if (fetch) git(dir, ['fetch', '--quiet', remote, repo.base]);
    const ref = git(dir, ['rev-parse', '--verify', '--quiet', `refs/remotes/${remote}/${repo.base}`]).ok ? `${remote}/${repo.base}` : repo.base;
    if (!git(dir, ['cat-file', '-e', `${ref}:${m.path}`]).ok) {
      out.push({ what: m.what, module: key, problem: `is not committed on ${ref}, so it cannot load: commit and push it to ${repo.base}` });
      continue;
    }
    const before = out.length;
    const folder = moduleFolder(m.path);
    if (folder) {
      const listed = git(dir, ['ls-tree', '-r', '--name-only', ref, '--', folder]);
      for (const f of listed.ok ? listed.out.split('\n').filter((x) => /\.(m?[jt]s|c[jt]s)$/.test(x)) : []) {
        const text = git(dir, ['show', `${ref}:${f}`]).out;
        for (const [, spec] of text.matchAll(REL_IMPORT)) {
          const target = path.posix.normalize(path.posix.join(path.posix.dirname(f), spec));
          if (!target.startsWith(`${folder}/`)) out.push({ what: m.what, module: key, problem: `${f} imports ${spec}, outside the module's folder ${folder}/, which will not resolve` });
        }
      }
    }
    if (out.length > before || !m.kind) continue;
    // Its default export, loaded from the base as the engine loads it.
    let mod;
    try {
      mod = await importBaseModule(root, { repos }, { repo: m.repo, path: m.path }, { what: m.what });
    } catch (e) {
      out.push({ what: m.what, module: key, problem: `does not load from ${ref}: ${String(e?.message ?? e).split('\n')[0]}` });
      continue;
    }
    const problem = exportProblem(m.kind, mod.default, { via, operations: mod.operations });
    if (problem) out.push({ what: m.what, module: key, problem, contract: MODULE_CONTRACTS[m.kind] });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------
// The 0.7 adapter → seed, draft and dropped keys
// ---------------------------------------------------------------------------------------------------------------------

// Step ids 0.7 ledgers registered per ticket (`validation.added`, and their corrections and carries).
async function perTicketSteps(root) {
  const ids = new Map();
  for (const id of await listAttempts(root).catch(() => [])) {
    for (const e of await readEvents(root, id).catch(() => [])) {
      if (!['validation.added', 'validation.corrected', 'validation.carried'].includes(e.type)) continue;
      for (const s of e.data?.steps ?? []) {
        const sid = typeof s === 'string' ? s : s?.id;
        if (sid && !ids.has(sid)) ids.set(sid, id);
      }
    }
  }
  return ids;
}

const ORDER = ['version', 'name', 'root', 'requires', 'repos', 'components', 'invariants', 'rules', 'screens', 'review', 'ticketing', 'delivery', 'models', 'budget'];

/** from07(root, raw, { env }) → { seed, draft, data, report(), afterWrite() }. */
export async function from07(root, raw, { env = process.env } = {}) {
  const dropped = [];
  const notes = [];
  const drop = (key, why) => dropped.some((d) => d.key === key) || dropped.push({ key, why });
  const repos = raw.repos ?? [];
  const adapterRepo = repos.find((r) => r.name === raw.adapterRepo) ?? repos[0];
  if (!adapterRepo) throw new WfError('the 0.7 adapter lists no repos');
  const workflowDir = path.posix.join(adapterRepo.path === '.' ? '' : adapterRepo.path, '.workflow');
  // A 0.7 module path (`./x.mjs`) is relative to `.workflow/` in the adapter repo.
  const mod = (rel) => ({ repo: adapterRepo.name, path: path.posix.join('.workflow', String(rel).replace(/^\.\//, '')) });
  const isMod = (v) => typeof v === 'string' && v.startsWith('.');
  const perTicket = await perTicketSteps(root);

  for (const [k, why] of Object.entries({ enabled: 'the adapter\'s presence enables a project', engine: 'the installed plugin runs', adapterRepo: 'module paths name their repo', instructionFiles: '`wf doctor` reads the instruction files itself', lanes: 'every ticket goes through one flow', classes: 'only a model per role remains (`models`)', roles: 'role texts are the plugin\'s; the project\'s rules reach roles through `rules`', panel: 'the planning panel is gone', strategy: 'the strategist is gone', impact: 'consumers come from `components`', leaving: 'findings are goal, regression or other', severity: 'findings are goal, regression or other', learning: 'learning is measured', focused: 'no lanes', designSystem: 'design-system checks belong to the repos\' lint', secrets: 'the catalogue beside the adapter (`wf secrets check` names it) keeps `store` and `file`' })) if (raw[k] !== undefined) drop(k, why);

  // repos
  const seedRepos = repos.map((r) => {
    for (const p of r.packages ?? []) if (p.sharedInfra) drop(`repos.${r.name}.packages.${p.path}.sharedInfra`, 'no impact analysis');
    const other = [...new Set((r.packages ?? []).flatMap((p) => (p.docsOnly ?? []).map((g) => (p.path === '.' ? g : `${p.path}/${g}`))))];
    if (r.packages) drop(`repos.${r.name}.packages`, 'docs-only globs moved to `kinds.other`');
    const prov = r.provision ? Object.fromEntries(['clone', 'fingerprint', 'install', 'copyIgnored'].filter((k) => r.provision[k] !== undefined).map((k) => [k, r.provision[k]])) : null;
    return { name: r.name, path: r.path, base: r.base, ...(r.remote ? { remote: r.remote } : {}), ...(prov && Object.keys(prov).length ? { provision: prov } : {}), kinds: { tests: [], other: other.length ? other : ['**/*.md'] } };
  });

  // requires: names only. A tool stays only as a plain command name, which `wf doctor` finds with `command -v`; a tool
  // named by a phrase, a path or a version, or checked by a different command, is dropped and listed.
  const names = (xs) => (xs ?? []).map((x) => (typeof x === 'string' ? x : x?.name)).filter(Boolean);
  const toolDrops = [];
  const plainTool = (x) => {
    const name = typeof x === 'string' ? x : x?.name;
    if (typeof name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._+-]*$/.test(name)) return toolDrops.push({ tool: String(name ?? JSON.stringify(x)), why: 'not a plain command name' }), false;
    const check = typeof x === 'object' ? String(x.check ?? '').trim() : '';
    const runs = check.replace(/^command\s+-v\s+/, '').split(/\s+/)[0];
    if (check && runs !== name) return toolDrops.push({ tool: name, why: `checked by \`${check}\`, not by its name` }), false;
    return true;
  };
  const requires = raw.requires ? Object.fromEntries(['connectors', 'tools', 'skills'].map((k) => [k, k === 'tools' ? names((raw.requires.tools ?? []).filter(plainTool)) : names(raw.requires[k])]).filter(([, v]) => v.length)) : null;
  for (const t of toolDrops) drop(`requires.tools.${t.tool}`, `${t.why}; \`requires.tools\` keeps command names that \`command -v\` finds`);
  for (const k of ['connectors', 'tools', 'skills']) if ((raw.requires?.[k] ?? []).some((x) => typeof x === 'object' && Object.keys(x).some((f) => f !== 'name'))) drop(`requires.${k}[].{${[...new Set(raw.requires[k].flatMap((x) => Object.keys(x ?? {}).filter((f) => f !== 'name')))].join(',')}}`, 'only names remain');

  // components
  const components = (raw.components ?? []).filter((c) => c.dependsOn?.length).map((c) => ({ id: c.id, repo: c.repo, dependsOn: c.dependsOn.filter((d) => d.contract).map((d) => ({ contract: d.contract })) })).filter((c) => c.dependsOn.length);
  if ((raw.components ?? []).some((c) => c.kind || c.provides || c.package || (c.dependsOn ?? []).some((d) => d.component || d.via))) drop('components[].{kind,provides,package,dependsOn.component,dependsOn.via}', 'consumers are found from contract globs alone');

  // gate → tests per repo
  const gate = raw.gate ?? {};
  const steps = gate.steps ?? [];
  const droppedSteps = steps.filter((s) => perTicket.has(s.id)).map((s) => ({ id: s.id, attempt: perTicket.get(s.id) }));
  for (const s of droppedSteps) drop(`gate.steps.${s.id}`, `per-ticket validation step (registered by ${s.attempt})`);
  if (gate.maxParallelSteps !== undefined) drop('gate.maxParallelSteps', 'each repo runs one `fast` and one `full`');
  const kept = steps.filter((s) => !perTicket.has(s.id));
  const specFor = (repo, list, kind) => {
    if (!list.length) return null;
    const plugins = list.filter((s) => s.plugin);
    const leases = list.map((s) => s.lease).filter(Boolean);
    const leaseName = leases.sort((a, b) => leases.filter((x) => x === b).length - leases.filter((x) => x === a).length)[0];
    const lock = leaseName ? { lock: { name: leaseName, count: gate.leases?.[leaseName] ?? 1 } } : {};
    if (new Set(leases).size > 1) notes.push(`tests.${repo}.${kind}: one lock remains (${leaseName}); ${[...new Set(leases)].filter((l) => l !== leaseName).join(', ')} dropped`);
    for (const s of list) for (const f of ['select', 'inputs', 'alsoInputs', 'tier', 'when', 'report', 'junit', 'artifacts', 'deferrable', 'failOnSkipped', 'package']) if (s[f] !== undefined && !(f === 'package' && s.package === '.')) drop(`gate.steps.${s.id}.${f}`, f === 'artifacts' ? 'screens are captured by `screens.capture`' : 'a test spec is one command or one module');
    if (!plugins.length) return { run: list.map((s) => `${s.package && s.package !== '.' ? `(cd ${s.package} && ${s.run})` : s.run}`.replace(/\s*\{select\}/g, '')).join(' && '), ...lock };
    const counts = new Map();
    for (const s of plugins) counts.set(s.plugin, (counts.get(s.plugin) ?? 0) + 1);
    const main = [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
    const extra = Object.keys(plugins[0]).filter((k) => !['id', 'repo', 'plugin', 'lease', 'tier', 'inputs', 'package'].includes(k));
    notes.push(`tests.${repo}.${kind}: the per-step settings of ${list.map((s) => s.id).join(', ')}${extra.length ? ` (${[...new Set(list.flatMap((s) => Object.keys(s)))].filter((k) => !['id', 'repo', 'plugin', 'lease', 'tier'].includes(k)).join(', ')})` : ''} move into ${workflowDir}/${main.replace(/^\.\//, '')}`);
    runners.add(path.posix.join(workflowDir, main.replace(/^\.\//, '')));
    for (const s of list) if (s.plugin !== main) drop(`gate.steps.${s.id}`, `runs ${s.plugin}; a test spec takes one module (${main})`);
    return { module: mod(main), ...lock };
  };
  const tests = {};
  const runners = new Set();
  for (const r of repos) {
    const mine = kept.filter((s) => s.repo === r.name);
    const fast = specFor(r.name, mine.filter((s) => s.tier !== 'heavy'), 'fast');
    const full = specFor(r.name, mine, 'full');
    if (fast || full) tests[r.name] = { fast, full };
  }
  if (gate.leases) drop('gate.leases', 'each lease became the `lock` of the tests that used it');

  // screens.capture from the step that collected artifacts, only when its command writes each screen to {out}: one that
  // does not would capture nothing. Screens are optional; with no capture there are none.
  const shotStep = kept.find((s) => s.artifacts) ?? steps.find((s) => s.artifacts);
  let capture = null;
  let unseeded = null;
  if (shotStep) {
    const repo = repos.find((r) => r.name === shotStep.repo) ?? adapterRepo;
    const where = path.posix.join(repo.path, shotStep.package && shotStep.package !== '.' ? shotStep.package : '');
    const cmd = shotStep.run ? shotStep.run.replace(/\s*\{select\}/g, '') : shotStep.plugin ? `node ${path.posix.join(workflowDir, shotStep.plugin.replace(/^\.\//, ''))}` : null;
    if (cmd && cmd.includes('{out}')) capture = { value: `cd ${where} && ${cmd.replace(/\{\w+\}/g, (m) => (['{out}', '{viewport}', '{lang}', '{dir}', '{routes}'].includes(m) ? m : ''))}`.replace(/\s+/g, ' ').trim(), step: shotStep.id, artifacts: shotStep.artifacts };
    else unseeded = { step: shotStep.id, plugin: shotStep.plugin ?? null };
  }

  // tracker → ticketing, statuses → stages. Item ids: the tracker's prefix and every prefix the old attempt folders show
  // (`<prefix>-<n>.<attempt>`, such as the 0.7 quick-fix items), so no earlier kind of item is refused after migration.
  const tr = raw.tracker ?? {};
  const esc = (x) => String(x).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const oldIds = (await listAttempts(root).catch(() => [])).filter((id) => /\.\d+$/.test(id));
  const prefixes = [...new Set([...(tr.idPrefix ? [String(tr.idPrefix)] : []), ...oldIds.map((id) => /^([A-Za-z][A-Za-z0-9_]*)-\d+\.\d+$/.exec(id)?.[1]).filter(Boolean)])].sort().map(esc);
  const kind = tr.kind ?? 'none';
  const ticketing = {
    tracker: isMod(kind) ? { module: mod(kind) } : kind,
    via: tr.via ?? (isMod(kind) ? 'module' : ['none', 'files'].includes(kind) ? kind : 'connector'),
    ...(prefixes.length ? { idPattern: prefixes.length === 1 ? `^${prefixes[0]}-\\d+$` : `^(?:${prefixes.join('|')})-\\d+$` } : {}),
    ...(tr.statuses?.started ? { take: { status: tr.statuses.started } } : {}),
    followUps: { mode: 'off', ...(tr.team ? { team: String(tr.team) } : {}) },
  };
  if (kind === 'none') delete ticketing.tracker;
  // Items of old attempts the derived pattern does not take (a UUID, say): `wf start <id>` would refuse them.
  const offPattern = ticketing.idPattern ? [...new Set(oldIds.map((id) => id.replace(/\.\d+$/, '')))].filter((item) => !new RegExp(ticketing.idPattern).test(item)).sort() : [];
  for (const k of Object.keys(tr)) if (!['kind', 'via', 'idPrefix', 'statuses', 'statusByLabel', 'team'].includes(k)) drop(`tracker.${k}`, /Comment$/.test(k) ? 'the owner writes each comment of its kind in product language' : 'not part of 0.8 ticketing');
  if (tr.statuses?.done) drop('tracker.statuses.done', 'Done is set by a stage or by the person');
  const status = (event, comment, when) => {
    const out = [];
    if (tr.statuses?.[event]) out.push({ do: 'status', to: tr.statuses[event], comment, ...(when ? { when } : {}) });
    for (const [label, to] of Object.entries(tr.statusByLabel?.[event] ?? {})) out.push({ do: 'status', to, comment, when: { labels: [label] } });
    return out;
  };
  const dl = raw.delivery ?? {};
  const dkind = dl.kind ?? 'push-main';
  const stages = [];
  if (dkind === 'push-main') stages.push({ do: 'land' });
  else stages.push({ do: 'merge-request' }, { do: 'wait-merged' });
  // A 0.7 delivery module (an object of integrate, observe and readback) is not a 0.8 stage: delivery becomes a merge
  // request the person opens and merges, until the module is rewritten for the stage contract.
  const deliveryModule = isMod(dkind) ? path.posix.join(workflowDir, dkind.replace(/^\.\//, '')) : null;
  if (deliveryModule) notes.push(`delivery: ${deliveryModule} is a 0.7 delivery module and needs rewriting before 0.8 can run it; until then delivery is a merge request, opened and merged by the person. Rewritten for the stage contract (${MODULE_CONTRACTS.stage}), it goes in as a \`module\` stage`);
  stages.push(...status('delivered', 'uat'));
  if (dl.deployment) {
    const when = dl.deployment.labels?.length ? { labels: dl.deployment.labels } : undefined;
    stages.push({ do: 'confirm-deployed', where: dl.deployment.where ?? 'production', ...(when ? { when } : {}) });
    stages.push(...status('deployed', 'deployed', when));
  }
  for (const k of Object.keys(dl)) if (!['kind', 'deployment'].includes(k)) drop(`delivery.${k}`, 'not part of 0.8 delivery');
  if (tr.statusByLabel) drop('tracker.statusByLabel', 'moved into the delivery stages (`when: labels`)');
  if (dl.deployment) drop('delivery.deployment', 'moved into the delivery stages (`confirm-deployed`)');

  // review.rules → rules
  const rules = (raw.review?.rules ?? []).map((r) => {
    const repo = repos.find((x) => x.name === r.repo);
    const at = (p) => (repo && repo.path !== '.' ? `${repo.path}/${p}` : p);
    return { paths: (r.paths ?? []).map(at), read: [].concat(r.read ?? []).map(at) };
  }).filter((r) => r.paths.length && r.read.length);
  if (raw.review && Object.keys(raw.review).some((k) => k !== 'rules')) drop(`review.{${Object.keys(raw.review).filter((k) => k !== 'rules').join(',')}}`, 'one whole-diff review');
  if ((raw.review?.rules ?? []).some((r) => r.id)) drop('review.rules[].id', 'rules are matched by path');

  // invariants (0.7: relative to `.workflow/`), quality moves into it
  let invariants = null;
  if (raw.invariants) {
    const inWorkflow = path.posix.join(workflowDir, raw.invariants);
    invariants = fs.existsSync(path.join(root, inWorkflow)) ? inWorkflow : raw.invariants;
  }
  const quality = Array.isArray(raw.quality) ? raw.quality.filter((q) => typeof q === 'string' && q.trim()) : [];
  if (quality.length && !invariants) invariants = path.posix.join(workflowDir, 'invariants.md');

  const seed = {
    version: 2,
    name: String(raw.name ?? path.basename(root)).trim().replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[^A-Za-z0-9]+/, '') || 'project',
    ...(requires && Object.keys(requires).length ? { requires } : {}),
    repos: seedRepos,
    ...(components.length ? { components } : {}),
    ...(invariants ? { invariants } : {}),
    ...(rules.length ? { rules } : {}),
    ticketing,
    delivery: { landing: dkind === 'push-main' ? 'queue' : 'direct', order: repos.map((r) => r.name), ...(deliveryModule ? { authority: { mergeRequest: 'person', merge: 'person' } } : {}) },
  };
  const draft = {
    tests,
    delivery: { stages },
    // Why each seeded key is proposed, shown in place of "from the draft".
    reasons: { tests: 'from the 0.7 gate steps', 'delivery.stages': 'from the 0.7 delivery (tracker statuses and labels)' },
    screens: capture ? { capture: { run: capture.value }, reasons: { capture: `seeded from the 0.7 step \`${capture.step}\`, which collected ${[].concat(capture.artifacts).join(', ')}` } } : {},
  };
  const imports = productImports(root, repos);
  const modules = await moduleProblems(root, seedRepos, moduleRefsOf({ repos: seedRepos.map((r) => ({ ...r, tests: tests[r.name] })), ticketing, delivery: { stages } }), { via: ticketing.via });
  const data = { dropped, notes, perTicketSteps: droppedSteps, offPattern, imports, modules, quality, invariants, capture, runners: [...runners], deliveryModule };

  // Both hosts installed: the second reviewer's default is the other one (launch.mjs `reviewerHosts`).
  const { reviewerHosts } = await import('./launch.mjs');
  const secondHost = raw.models?.secondReviewer ? null : reviewerHosts(null).other?.label ?? null;
  const report = () => {
    const out = [];
    if (droppedSteps.length) out.push('', `Per-ticket steps dropped: ${droppedSteps.map((s) => s.id).join(', ')}`);
    out.push('', 'Dropped or moved 0.7 keys:', ...dropped.map((d) => `  ${d.key}: ${d.why}`));
    if (quality.length) out.push('', `\`quality\` (${quality.length} line${quality.length === 1 ? '' : 's'}) moves into ${invariants} when the adapter is written.`);
    if (notes.length) out.push('', 'Notes:', ...notes.map((n) => `  ${n}`));
    if (unseeded) out.push('', `Screens: the 0.7 step \`${unseeded.step}\` collected screenshots, but ${unseeded.plugin ? `it runs as a 0.7 plugin (${unseeded.plugin}), not a command that writes each screen to {out}` : 'its command does not write each one to {out}'}, so no capture is proposed. With none there are no screens; a draft may set \`screens.capture\` later.`);
    if (secondHost) out.push('', `Second reviews: \`models.secondReviewer\` is unset, so a second review a reviewer asks for runs on ${secondHost}, the other installed host, on its own model.`);
    for (const r of runners) out.push('', `No tests run until ${r} is rewritten for the 0.8 runner contract:`, `  ${MODULE_CONTRACTS.tests}`);
    if (offPattern.length) out.push('', `Items of earlier attempts that ticketing.idPattern (${ticketing.idPattern}) does not match: wf start refuses them as they are. Start one with \`wf start --no-tracker <id>\`, or give the tracker module a \`normalise\` export that maps it to a tracker id:`, ...offPattern.map((i) => `  ${i}`));
    if (modules.length) out.push('', 'Modules that cannot run as named (each loads only as committed on its repo\'s base, from its own folder):', ...modules.map((m) => `  ${m.what}: ${m.module} ${m.problem}`));
    if (imports.length) out.push('', `Product code importing .workflow/ (removing the material breaks these; one removal ticket per repo fixes them):`, ...imports.map((i) => `  ${i.at}: ${i.text}`));
    return out;
  };
  // After the adapter is written: the quality lines join the invariants file (idempotent: lines already there are skipped).
  const afterWrite = async () => {
    if (!quality.length) return [];
    const file = path.join(root, invariants);
    const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    const add = quality.filter((q) => !text.includes(q.trim()));
    if (!add.length) return [];
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${text}${text && !text.endsWith('\n') ? '\n' : ''}${text ? '\n' : ''}## Quality\n\n${add.map((q) => `- ${q.trim()}`).join('\n')}\n`);
    return [`Moved ${add.length} \`quality\` line${add.length === 1 ? '' : 's'} into ${invariants}.`];
  };
  return { seed: Object.fromEntries(ORDER.filter((k) => k in seed).map((k) => [k, seed[k]])), draft, data, report, afterWrite };
}

// ---------------------------------------------------------------------------------------------------------------------
// wf migrate attempts
// ---------------------------------------------------------------------------------------------------------------------

function fold07(events) {
  const s = { admitted: null, held: null, review: null, terminal: null };
  for (const e of events) {
    if (e.type === 'admitted') s.admitted = e.data;
    else if (e.type === 'hold') s.held = { reason: e.data?.reason ?? null, at: e.at };
    else if (e.type === 'release') s.held = null;
    else if (e.type === 'review.recorded') {
      const fs_ = e.data?.closure?.findings ?? e.data?.findings ?? [];
      s.review = { at: e.at, verdict: e.data?.closure?.verdict ?? null, open: fs_.filter((f) => !f.status || f.status === 'open').length, accepted: false };
    } else if (e.type === 'review.accepted' && s.review) s.review.accepted = true;
    else if (TERMINAL.includes(e.type)) s.terminal ??= e.type;
  }
  return s;
}
// The base branch of a 0.7 attempt's repo. 0.7 recorded `base` as the commit the attempt started from and `baseRef` as the
// ref it was read at (`<remote>/<branch>`, or the local branch with no remote): the branch is `baseRef` without the remote.
// Named failure: the sha taken for a branch compared the work with where it started, so work already on the base by
// cherry-pick or squash counted as unmerged and a shipped attempt closed as superseded.
export function baseBranch07(r, remote = 'origin') {
  const ref = typeof r?.baseRef === 'string' ? r.baseRef.replace(/^refs\/remotes\//, '') : null;
  if (ref) return ref.startsWith(`${remote}/`) ? ref.slice(remote.length + 1) : ref;
  return typeof r?.base === 'string' && !/^[0-9a-f]{40}$/.test(r.base) ? r.base : null;
}
const reviewText = (r) => (!r ? 'no review recorded' : r.accepted ? `accepted (${r.at})` : `${r.verdict ?? 'recorded'}, ${r.open} open finding${r.open === 1 ? '' : 's'} (${r.at})`);

function cherry(dir, remote, base, branch) {
  if (!git(dir, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]).ok) return null;
  git(dir, ['fetch', '--quiet', remote, base]);
  const ref = git(dir, ['rev-parse', '--verify', '--quiet', `refs/remotes/${remote}/${base}`]).ok ? `${remote}/${base}` : base;
  const r = git(dir, ['cherry', ref, branch]);
  if (!r.ok) return { ref, error: r.err };
  const lines = r.out.split('\n').filter(Boolean).map((l) => ({ mark: l[0], sha: l.slice(2) }));
  return { ref, unmerged: lines.filter((l) => l.mark === '+').map((l) => l.sha), onBase: lines.filter((l) => l.mark === '-').map((l) => l.sha) };
}
const patchId = (dir, sha) => git(dir, ['patch-id', '--stable'], git(dir, ['show', sha]).out).out.split(' ')[0] || null;

async function migrateAttempts(ctx, { dryRun }) {
  const env = ctx.env ?? process.env;
  const root = ctx.root;
  let adapter = null;
  try {
    adapter = await loadAdapter(root, { env });
  } catch {}
  const repoOf = (name) => adapter?.repos.find((r) => r.name === name) ?? { name, path: name, remote: 'origin' };
  const pendingTracker = (adapter?.delivery.stages ?? []).filter((s) => ['status', 'comment'].includes(s.do)).map((s) => (s.do === 'status' ? `status → ${s.to}` : `comment ${s.comment}`) + (s.when?.labels ? ` (labels ${s.when.labels.join(', ')})` : ''));
  const result = { held: [], superseded: [], shipped: [], kept: [] };
  const lines = [];
  for (const id of await listAttempts(root)) {
    const events = await readEvents(root, id);
    if (!events.length || events.some((e) => e.schema === 2)) continue;
    const s = fold07(events);
    if (s.terminal) continue;
    const item = s.admitted?.item ?? id.replace(/\.\d+$/, '');
    const repos = Object.entries(s.admitted?.repos ?? {});
    const branches = repos.map(([name, r]) => `${name}:${r.branch}`).join(', ') || 'no branch';
    if (s.held) {
      result.held.push({ id, item, reason: s.held.reason, review: s.review });
      lines.push(`${id} (${item}) ${branches}: held ("${s.held.reason}"), skipped; last review: ${reviewText(s.review)}`);
      continue;
    }
    const per = [];
    for (const [name, r] of repos) {
      const repo = repoOf(name);
      const dir = path.resolve(root, repo.path);
      const remote = repo.remote ?? 'origin';
      const c = fs.existsSync(dir) ? cherry(dir, remote, baseBranch07(r, remote) ?? repo.base, r.branch) : null;
      per.push({ name, dir, branch: r.branch, ...(c ?? { missing: true }) });
    }
    const counted = per.filter((p) => p.unmerged);
    const unmerged = counted.reduce((n, p) => n + p.unmerged.length, 0);
    const onBase = counted.reduce((n, p) => n + p.onBase.length, 0);
    const shipped = counted.length > 0 && unmerged === 0 && onBase > 0;
    const commits = per.map((p) => (p.missing ? `${p.name}: no branch` : p.error ? `${p.name}: ${p.error}` : `${p.name}: ${p.unmerged.length} unmerged${p.onBase.length ? `, ${p.onBase.length} on ${p.ref}` : ''}`)).join('; ');
    const patchIds = shipped ? counted.flatMap((p) => p.onBase.map((sha) => ({ repo: p.name, sha, patchId: patchId(p.dir, sha) }))) : [];
    // Worktrees: clean ones are removed (the branches stay); one with changes is kept and named.
    const worktrees = [];
    for (const p of per) {
      const wt = path.join(root, '.wf-worktrees', id, p.name);
      if (!fs.existsSync(wt)) continue;
      const dirty = git(wt, ['status', '--porcelain']).out;
      if (dirty) worktrees.push(`${wt} kept: uncommitted changes`);
      else if (!dryRun) {
        const rm = git(p.dir, ['worktree', 'remove', wt]);
        worktrees.push(rm.ok ? `${wt} removed` : `${wt} kept: ${rm.err}`);
      } else worktrees.push(`${wt} would be removed`);
    }
    if (!dryRun) {
      try {
        fs.rmdirSync(path.join(root, '.wf-worktrees', id));
      } catch {}
      await append(root, id, 'attempt.closed', shipped ? { outcome: 'shipped', reason: 'migrated to 0.8: every commit is on its base by patch-id', patchIds } : { outcome: 'superseded', reason: 'migrated to 0.8; the branch is kept' }, ctx.actor ?? null);
    }
    const entry = { id, item, branches, commits, review: s.review, worktrees, ...(shipped ? { patchIds, pending: pendingTracker } : {}) };
    result[shipped ? 'shipped' : 'superseded'].push(entry);
    lines.push(`${id} (${item}) ${branches}: ${dryRun ? 'would close' : 'closed'} as ${shipped ? 'shipped' : 'superseded'}; ${commits}; last review: ${reviewText(s.review)}${shipped ? `; pending tracker step: ${pendingTracker.join(', ') || 'none in the adapter'}` : ''}${worktrees.length ? `; ${worktrees.join('; ')}` : ''}`);
  }
  if (!lines.length) lines.push('No open 0.7 attempts.');
  if (result.held.length) lines.push('', `Held attempts stay as they are, for you to decide: ${result.held.map((h) => h.id).join(', ')}.`);
  lines.push('', 'Tracker statuses were not changed.');
  return { text: lines.join('\n'), data: result };
}

// ---------------------------------------------------------------------------------------------------------------------
// wf migrate material
// ---------------------------------------------------------------------------------------------------------------------

async function migrateMaterial(ctx) {
  const env = ctx.env ?? process.env;
  const root = ctx.root;
  const adapter = await loadAdapter(root, { env });
  const referenced = new Set([
    adapter.invariants,
    adapter.source?.file ? path.relative(fs.realpathSync(root), fs.realpathSync(adapter.source.file)) : null,
    ...adapter.rules.flatMap((r) => r.read),
    ...[
      ...adapter.repos.flatMap((r) => [r.tests.fast?.module, r.tests.full?.module]),
      adapter.ticketing.tracker?.module,
      adapter.screens.routes,
      ...adapter.delivery.stages.map((s) => s.module),
    ].filter(Boolean).map((m) => {
      const repo = adapter.repos.find((r) => r.name === m.repo);
      return path.posix.join(repo?.path ?? m.repo, m.path);
    }),
  ].filter(Boolean).map((p) => path.posix.normalize(p)));
  const unreferenced = [];
  for (const r of adapter.repos) {
    const dir = path.resolve(root, r.path);
    const prefix = r.path === '.' ? '' : `${r.path}/`;
    const tracked = git(dir, ['ls-files', '--', '.workflow']);
    for (const f of tracked.ok ? tracked.out.split('\n').filter(Boolean) : []) if (!referenced.has(`${prefix}${f}`) && !/secrets\.ya?ml$/.test(f)) unreferenced.push({ repo: r.name, file: `${prefix}${f}` });
  }
  const imports = productImports(root, adapter.repos);
  const byRepo = new Map();
  for (const u of unreferenced) byRepo.set(u.repo, [...(byRepo.get(u.repo) ?? []), u.file]);
  const lines = [];
  for (const [repo, files] of byRepo) lines.push(`${repo}: ${files.length} tracked file${files.length === 1 ? '' : 's'} under .workflow/ the adapter does not reference`, ...files.map((f) => `  ${f}`));
  if (imports.length) lines.push('', 'Product code importing .workflow/ (each removal ticket fixes these):', ...imports.map((i) => `  ${i.at}: ${i.text}`));
  if (!lines.length) lines.push('No workflow material left in the repos.');
  else lines.push('', '0.8 reads none of it. One removal ticket per repo removes it and fixes the imports.');
  return { text: lines.join('\n'), data: { unreferenced, imports } };
}

export async function cmdMigrate(ctx, args) {
  const [sub] = (args._ ?? []).filter((x) => x !== 'migrate');
  const root = ctx.root ?? path.resolve(ctx.cwd);
  if (sub === 'attempts') return migrateAttempts({ ...ctx, root }, { dryRun: Boolean(args.flags?.['dry-run']) });
  if (sub === 'material') return migrateMaterial({ ...ctx, root });
  throw new WfError(`wf migrate ${sub ?? ''}`.trim() + ': the subcommands are attempts and material', { hint: 'the adapter is migrated by `wf init --from-07`' });
}

export const implements08 = { cmdMigrate };
