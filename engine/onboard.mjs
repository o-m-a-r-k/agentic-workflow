// Onboarding (design-0.8 section 5, stream 7): the project's policy, proposed from the scan, confirmed by the person, and
// written only here. Re-runnable: a re-run shows a per-key diff, hand edits first, and writes only what is confirmed; a run
// with nothing to change writes nothing. The engine never calls a model: a draft (from the onboard skill) is an input.
//
// Also the handlers `wf doctor`, `wf init` (alias onboard), `wf sync` and `wf secrets`.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import {
  COMMANDS, COMMAND_ALIASES, CONTRACT_VERSION, POLICY_KEYS, WfError, adapterBudget, canonicalJson, checkAdapter, listAttempts,
  loadAdapter, readEvents, scan, userDir,
} from './contract.mjs';
import { SECRETS_SUFFIX, secretsCatalogFile } from './config.mjs';
import { isInstructionDoc, repoFiles } from './scan.mjs';
import { stateFolderWarnings } from './state-folders.mjs';
import { matchesAny } from './util.mjs';

const require = createRequire(import.meta.url);
const YAML = require('./vendor/yaml/dist/index.js');

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
export const policyHash = (value) => sha(canonicalJson(value ?? null));
const clip = (s, n = 160) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const show = (v) => (v === null || v === undefined ? 'unset' : clip(typeof v === 'string' ? v : JSON.stringify(v)));
const same = (a, b) => canonicalJson(a ?? null) === canonicalJson(b ?? null);
const SCREEN_KEYS = ['routes', 'shared', 'sentinel', 'langs', 'viewports', 'capture'];
const COST = { money: 'money computed', external: 'writes to external systems', data: 'data migrated', access: 'access granted' };

// The shape `wf init --draft <file>` reads (JSON or YAML): any subset of the policy keys, adapter-shaped.
export const DRAFT_SHAPE = `{
  "risk": [{ "id": "<area>", "paths": ["<repo>/<dir>/**"], "reason": "<what a mistake costs, citing scanned files>", "tests": ["<repo>/<tests>/**"] }] or "none",
  "review": { "diffRead": "before" | "after" },
  "delivery": { "stages": [{ "do": "land" }, { "do": "status", "to": "<status>" }] },
  "ticketing": { "operations": { "<operation>": "<plain words>" } },
  "tests": { "<repo>": { "fast": { "run": "<command>" }, "full": { "run": "<command>" } } },
  "screens": { "capture": { "run": "<command with {out} {viewport} {lang} {routes}>" } or { "module": { "repo": "<repo>", "path": "<file>" } }, "routes": { "repo": "<repo>", "path": "<file>" }, "shared": [], "sentinel": [], "langs": [{ "lang": "<code>", "dir": "ltr" }], "viewports": [<width>] }
}`;

// ---------------------------------------------------------------------------------------------------------------------
// Where the adapter lives (only this stream writes it)
// ---------------------------------------------------------------------------------------------------------------------

const expandHome = (p, env) => (typeof p === 'string' && p.startsWith('~') ? path.join(env.HOME ?? process.env.HOME ?? '', p.slice(1)) : p);
const real = (p) => {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
};
const readYaml = (file) => {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  try {
    return YAML.parse(text) ?? {};
  } catch (error) {
    throw new WfError(`${file}: not readable YAML: ${error.message}`);
  }
};

// The adapter file of a root: `<root>/.workflow/project.yaml`, or a user-folder adapter whose `root:` is this root.
export function locate(root, env = process.env) {
  const repoFile = path.join(root, '.workflow', 'project.yaml');
  const found = [];
  if (fs.existsSync(repoFile)) found.push({ file: repoFile, location: 'repo' });
  const dir = path.join(userDir(env), 'projects');
  for (const f of fs.existsSync(dir) ? fs.readdirSync(dir).filter((x) => /\.ya?ml$/.test(x) && !x.endsWith(SECRETS_SUFFIX)) : []) {
    const raw = readYaml(path.join(dir, f));
    if (raw?.root && real(expandHome(raw.root, env)) === real(root)) found.push({ file: path.join(dir, f), location: 'user' });
  }
  if (found.length > 1) throw new WfError(`two adapters for ${root}: ${found.map((x) => x.file).join(' and ')}; keep one`);
  return found[0] ? { ...found[0], raw: readYaml(found[0].file) } : null;
}

// ---------------------------------------------------------------------------------------------------------------------
// Policy values: one canonical form per POLICY_KEYS key, read from a raw adapter (or a normalised one)
// ---------------------------------------------------------------------------------------------------------------------

const normRisk = (r) => ({ id: r.id, paths: r.paths ?? [], reason: r.reason ?? '', tests: r.tests ?? [] });
const normTest = (t) => (t ? { ...(t.run ? { run: t.run } : {}), ...(t.module ? { module: { repo: t.module.repo, path: t.module.path } } : {}), ...(t.lock ? { lock: { name: t.lock.name, count: t.lock.count ?? 1 } } : {}) } : null);
export function policyOf(raw) {
  const risk = raw?.risk === 'none' ? 'none' : Array.isArray(raw?.risk) ? raw.risk.map(normRisk)
    : raw?.risk && typeof raw.risk === 'object' && 'confirmed' in raw.risk ? (raw.risk.confirmed ? (raw.risk.paths.length ? raw.risk.paths.map(normRisk) : 'none') : null) : null;
  return {
    risk,
    'review.diffRead': raw?.review?.diffRead ?? null,
    'delivery.stages': raw?.delivery?.stages ?? null,
    'ticketing.operations': raw?.ticketing?.operations ?? {},
    tests: Object.fromEntries((raw?.repos ?? []).map((r) => [r.name, { fast: normTest(r.tests?.fast), full: normTest(r.tests?.full) }])),
    screens: Object.fromEntries(SCREEN_KEYS.map((k) => [k, raw?.screens?.[k] ?? null])),
  };
}
const topOf = (key) => POLICY_KEYS.find((k) => key === k || key.startsWith(`${k}.`));

// The raw adapter behind a normalised one (its file), so hashes compare what onboarding wrote with what is there now.
function rawOf(current) {
  if (!current) return null;
  const file = current.source?.file;
  if (file && fs.existsSync(file)) return readYaml(file);
  return current;
}
export const handEditedKeys = (raw) => {
  const cur = policyOf(raw);
  const stored = raw?.onboarded?.hashes ?? {};
  return POLICY_KEYS.filter((k) => stored[k] && stored[k] !== policyHash(cur[k]));
};

// ---------------------------------------------------------------------------------------------------------------------
// Risk from facts: what a mistake costs, per area; areas are the project's own folders
// ---------------------------------------------------------------------------------------------------------------------

const factFile = (p) => p.replace(/:\d+$/, '');
const docLines = (facts, kinds) => facts.repos.flatMap((r) => r.facts.filter((f) => kinds.includes(f.kind) && /:\d+$/.test(f.path)));
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const wordIn = (name, text) => name.length >= 3 && new RegExp(`\\b${escapeRe(name.replace(/s$/i, ''))}s?\\b`, 'i').test(text);

// Tests for an area: test files under it or named after it; else the repo's test folders; else where its tests would go.
function testGlobs(repo, area, name) {
  const prefix = repo.path === '.' ? '' : `${repo.path}/`;
  const own = repo.tests.filter((t) => t.startsWith(`${area}/`) || t.split('/').slice(0, -1).includes(name) || path.basename(t).toLowerCase().startsWith(name.toLowerCase()));
  const dirs = [...new Set(own.map((t) => path.posix.dirname(t)))];
  if (own.length && dirs.length <= 3) return dirs.map((d) => `${d}/**`);
  const roots = [...new Set(repo.tests.map((t) => {
    const segs = t.slice(prefix.length).split('/');
    const i = segs.findIndex((s) => /^(tests?|__tests__|specs?|e2e)$/i.test(s));
    return i >= 0 ? `${prefix}${segs.slice(0, i + 1).join('/')}` : null;
  }).filter(Boolean))];
  return roots.length ? roots.slice(0, 3).map((d) => `${d}/**`) : [`${area}/**/*.{test,spec}.*`];
}

/** Risk areas from the scan, ranked: named by the project's documents first, then by how many kinds of cost they carry. */
export function riskFromFacts(facts) {
  const lines = docLines(facts, ['invariants-doc', 'instruction-doc']);
  const invariantLines = docLines(facts, ['invariants-doc']);
  const areas = new Map();
  const areaFor = (repo, area) => {
    if (!areas.has(area)) areas.set(area, { repo, area, name: area.split('/').pop(), costs: new Map(), rounding: null });
    return areas.get(area);
  };
  for (const repo of facts.repos) {
    for (const f of repo.facts) {
      if (!f.area) continue;
      if (f.kind === 'rounding') areaFor(repo, f.area).rounding ??= f;
      const cost = { 'decimal-type': 'money', 'currency-type': 'money', 'webhook-handler': 'external', 'queue-consumer': 'external', migration: 'data', auth: 'access', permission: 'access', 'outbound-client': f.writes ? 'external' : null }[f.kind];
      if (!cost) continue;
      const a = areaFor(repo, f.area);
      if (!a.costs.has(cost)) a.costs.set(cost, []);
      a.costs.get(cost).push(f);
    }
    // A module the project's invariants name, even with no cost fact of its own.
    for (const m of repo.modules) {
      const area = repo.path === '.' ? m : `${repo.path}/${m}`;
      if (!areas.has(area) && invariantLines.some((l) => wordIn(area.split('/').pop(), l.evidence))) areaFor(repo, area);
    }
  }
  const out = [];
  for (const a of areas.values()) {
    const named = lines.find((l) => wordIn(a.name, l.evidence)) ?? null;
    if (a.rounding && a.costs.has('money')) a.costs.get('money').push(a.rounding);
    if (!a.costs.size && !named) continue;
    const cites = [...a.costs.entries()].map(([cost, xs]) => `${COST[cost]}: ${[...new Set(xs.map((f) => `${f.kind} ${f.path}`))].slice(0, 3).join(', ')}`);
    if (named) cites.push(`named in ${named.path}: "${clip(named.evidence, 90)}"`);
    if (!a.costs.size) cites.unshift(`files: ${a.repo.files.filter((f) => f.startsWith(`${a.area}/`)).slice(0, 3).join(', ')}`);
    const files = [...a.costs.values()].flat().map((f) => factFile(f.path));
    out.push({ id: a.name, area: a.area, rank: [named ? 1 : 0, a.costs.size, files.length], files, entry: { id: a.name, paths: [`${a.area}/**`], reason: cites.join('; '), tests: testGlobs(a.repo, a.area, a.name) } });
  }
  out.sort((x, y) => y.rank[0] - x.rank[0] || y.rank[1] - x.rank[1] || y.rank[2] - x.rank[2] || x.area.localeCompare(y.area));
  const ids = new Map();
  for (const x of out) ids.set(x.id, (ids.get(x.id) ?? 0) + 1);
  for (const x of out) if (ids.get(x.id) > 1) x.entry.id = x.id = x.area.replace(/[^\w-]+/g, '-');
  return out;
}

// A draft's risk entry must guard files that exist and give a reason that cites a scanned file.
function draftRiskProblems(list, facts) {
  const files = facts.repos.flatMap((r) => r.files);
  const problems = [];
  for (const r of list) {
    if (!r?.id || !Array.isArray(r.paths) || !r.paths.length) {
      problems.push(`risk entry ${JSON.stringify(r?.id ?? r)} needs an id and paths`);
      continue;
    }
    if (!files.some((f) => matchesAny(f, r.paths))) problems.push(`risk \`${r.id}\`: its paths (${r.paths.join(', ')}) match no file in the scan, so they guard nothing`);
    const cited = String(r.reason ?? '').match(/[\w.@-]+(?:\/[\w.@-]+)+/g) ?? [];
    if (!cited.some((c) => files.includes(c.replace(/:\d+$/, '')) || files.some((f) => f.startsWith(`${c.replace(/\/$/, '')}/`)))) problems.push(`risk \`${r.id}\`: its reason cites no scanned file (name the files the scan found)`);
  }
  return problems;
}

// ---------------------------------------------------------------------------------------------------------------------
// proposePolicy
// ---------------------------------------------------------------------------------------------------------------------

// A policy shape from an adapter-shaped draft: only the keys it sets.
function draftPolicy(draft) {
  if (!draft) return {};
  const out = {};
  if (draft.risk !== undefined) out.risk = draft.risk === 'none' ? 'none' : (draft.risk ?? []).map(normRisk);
  if (draft.review?.diffRead !== undefined) out['review.diffRead'] = draft.review.diffRead;
  if (draft.delivery?.stages !== undefined) out['delivery.stages'] = draft.delivery.stages;
  if (draft.ticketing?.operations !== undefined) out['ticketing.operations'] = draft.ticketing.operations;
  const tests = draft.tests ?? (Array.isArray(draft.repos) ? Object.fromEntries(draft.repos.filter((r) => r.tests).map((r) => [r.name, r.tests])) : null);
  if (tests && Object.keys(tests).length) out.tests = Object.fromEntries(Object.entries(tests).map(([k, v]) => [k, { fast: normTest(v?.fast), full: normTest(v?.full) }]));
  if (draft.screens) out.screens = draft.screens;
  return out;
}

function testsFromFacts(repo) {
  const scripts = repo.facts.filter((f) => f.kind === 'test-script' && f.command);
  const pick = (names) => names.map((n) => scripts.find((s) => s.name === n)).filter(Boolean);
  const fast = pick(['lint', 'typecheck', 'type-check', 'types', 'test', 'test:unit', 'unit']);
  const slow = pick(['test:e2e', 'e2e', 'test:integration', 'integration', 'verify']).filter((s) => !fast.includes(s));
  const spec = (xs) => (xs.length ? { run: xs.map((s) => s.command).join(' && ') } : null);
  return { value: { fast: spec(fast), full: spec([...fast, ...slow]) }, cites: [...fast, ...slow].map((s) => `${s.path} ${s.evidence}`) };
}

/** proposePolicy(facts, current, draft?) → PolicyDiff (engine/contract.mjs), plus `overBudget`: risk areas not proposed
 * because the adapter's risk budget is full. Hand-edited keys come first, marked, and are never part of `--confirm all`. */
export async function proposePolicy(facts, current, draft) {
  const raw = rawOf(current);
  const cur = policyOf(raw);
  const handEdited = new Set(handEditedKeys(raw));
  const want = draftPolicy(draft);
  const changes = [];
  const change = (key, from, to, reason) => {
    if (!same(from, to)) changes.push({ key, from: from ?? null, to: to ?? null, reason, handEdited: handEdited.has(topOf(key)) });
  };

  // risk
  let overBudget = [];
  if (want.risk !== undefined) {
    if (want.risk !== 'none') {
      const problems = draftRiskProblems(want.risk, facts);
      if (problems.length) throw new WfError(`the draft's risk paths are refused:\n- ${problems.join('\n- ')}`);
    }
    if (want.risk === 'none' || !Array.isArray(cur.risk)) change('risk', cur.risk, want.risk, want.risk === 'none' ? 'the draft finds nothing whose mistake costs money, external writes, data or access' : `the draft's risk paths: ${want.risk.map((r) => `${r.id} (${r.reason})`).join('; ')}`);
    else {
      for (const r of want.risk) change(`risk.${r.id}`, cur.risk.find((x) => x.id === r.id), r, r.reason);
      for (const r of cur.risk) if (!want.risk.some((x) => x.id === r.id)) change(`risk.${r.id}`, r, null, 'the draft drops it');
    }
  } else {
    const found = riskFromFacts(facts);
    const curList = Array.isArray(cur.risk) ? cur.risk : [];
    const files = facts.repos.flatMap((r) => r.files);
    const covered = (x) => curList.some((r) => x.files.some((f) => matchesAny(f, r.paths)) || matchesAny(`${x.area}/x`, r.paths));
    let fresh = found.filter((x) => !covered(x) && !curList.some((r) => r.id === x.id));
    const limit = raw?.budget?.adapter?.risk;
    if (Number.isInteger(limit) && curList.length + fresh.length > limit) {
      const room = Math.max(0, limit - curList.length);
      overBudget = fresh.slice(room).map((x) => ({ id: x.id, paths: x.entry.paths, reason: x.entry.reason }));
      fresh = fresh.slice(0, room);
    }
    if (cur.risk === null && !found.length) change('risk', null, 'none', 'the scan found no decimal or currency code, external writes, migrations or access code, and no area the project\'s documents name');
    for (const x of fresh) change(`risk.${x.id}`, null, x.entry, x.entry.reason);
    for (const r of curList) if (!files.some((f) => matchesAny(f, r.paths))) change(`risk.${r.id}`, r, null, `its paths (${r.paths.join(', ')}) match no file now`);
  }

  // review.diffRead, delivery.stages
  const pick = (key, fallback, why) => change(key, cur[key], want[key] !== undefined ? want[key] : cur[key] ?? fallback, want[key] !== undefined ? 'from the draft' : why);
  pick('review.diffRead', 'before', 'not set: the person reads a risk diff before it merges (`after` merges first and keeps the revert)');
  pick('delivery.stages', [{ do: 'land' }], 'not set: each repo\'s part lands on its base');

  // ticketing.operations, per operation
  const ops = want['ticketing.operations'];
  if (ops) for (const op of new Set([...Object.keys(cur['ticketing.operations']), ...Object.keys(ops)])) change(`ticketing.operations.${op}`, cur['ticketing.operations'][op], ops[op] ?? null, 'from the draft');

  // tests, per repo
  for (const repo of facts.repos) {
    const from = cur.tests[repo.name] ?? null;
    if (want.tests?.[repo.name]) change(`tests.${repo.name}`, from, want.tests[repo.name], want.tests.reasons?.[repo.name] ?? 'from the draft');
    else if (!from?.fast && !from?.full) {
      const t = testsFromFacts(repo);
      if (t.value.fast || t.value.full) change(`tests.${repo.name}`, from, t.value, `the repo's own scripts: ${t.cites.slice(0, 4).join('; ')}`);
    }
  }
  for (const [name, t] of Object.entries(want.tests ?? {})) if (!facts.repos.some((r) => r.name === name)) change(`tests.${name}`, cur.tests[name] ?? null, t, 'from the draft');

  // screens, per setting
  for (const k of SCREEN_KEYS) if (want.screens && k in want.screens) change(`screens.${k}`, cur.screens[k], want.screens[k], want.screens.reasons?.[k] ?? 'from the draft');

  // A hand edit with no proposed change is still shown, so it is never adopted or overwritten silently.
  for (const k of handEdited) if (!changes.some((c) => topOf(c.key) === k)) changes.push({ key: k, from: cur[k], to: cur[k], reason: 'edited by hand since onboarding wrote it; confirm the key to keep it as the onboarded value', handEdited: true });
  changes.sort((a, b) => Number(b.handEdited) - Number(a.handEdited));
  const unchanged = POLICY_KEYS.filter((k) => !changes.some((c) => topOf(c.key) === k));
  return { changes, unchanged, overBudget };
}

// ---------------------------------------------------------------------------------------------------------------------
// writeAdapter
// ---------------------------------------------------------------------------------------------------------------------

function applyChange(js, c) {
  const top = topOf(c.key);
  const sub = c.key.slice(top.length + 1);
  if (top === 'risk') {
    if (!sub) {
      js.risk = c.to;
      return;
    }
    const list = Array.isArray(js.risk) ? js.risk : [];
    const i = list.findIndex((r) => r.id === sub);
    if (c.to === null) {
      if (i >= 0) list.splice(i, 1);
    } else if (i >= 0) list[i] = c.to;
    else list.push(c.to);
    js.risk = list.length ? list : 'none';
  } else if (top === 'tests') {
    const repo = (js.repos ?? []).find((r) => r.name === sub);
    if (!repo) throw new WfError(`tests.${sub}: no repo named \`${sub}\` in the adapter`);
    repo.tests = Object.fromEntries(Object.entries(c.to ?? {}).filter(([, v]) => v));
  } else {
    const keys = [...top.split('.'), ...(sub ? [sub] : [])];
    let o = js;
    for (const k of keys.slice(0, -1)) o = o[k] ??= {};
    if (c.to === null || c.to === undefined) delete o[keys.at(-1)];
    else o[keys.at(-1)] = c.to;
  }
}

// The confirmed changes of a diff: exact keys, a top key for all of its parts, or `all` for every change not edited by hand.
export function confirmedChanges(diff, confirmed) {
  const keys = [].concat(confirmed ?? []).flatMap((k) => String(k).split(',')).map((k) => k.trim()).filter(Boolean);
  const unknown = keys.filter((k) => k !== 'all' && !diff.changes.some((c) => c.key === k || c.key.startsWith(`${k}.`)));
  if (unknown.length) throw new WfError(`no proposed change for ${unknown.map((k) => `\`${k}\``).join(', ')}; the proposed keys are: ${diff.changes.map((c) => c.key).join(', ') || 'none'}`);
  return diff.changes.filter((c) => keys.some((k) => (k === 'all' ? !c.handEdited : c.key === k || c.key.startsWith(`${k}.`))));
}

function commitUserFolder(file, message) {
  const dir = path.dirname(file);
  const g = (args) => spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
  if (!fs.existsSync(path.join(dir, '.git'))) g(['init', '--quiet']);
  g(['add', '--', path.basename(file)]);
  g(['-c', 'user.name=agentic-workflow', '-c', 'user.email=agentic-workflow@localhost', 'commit', '--quiet', '-m', message, '--', path.basename(file)]);
}

// What a finished onboarding must hold: `risk` confirmed; with `screens.capture`, a capture module or a command writing
// to {out}.
const captureSet = (c) => Boolean(c?.module) || /\{out\}/.test(typeof c === 'string' ? c : c?.run ?? '');
const unfinished = (js, finish) => finish.filter((k) => (k === 'risk' ? js.risk !== 'none' && !Array.isArray(js.risk) : k === 'screens.capture' ? !captureSet(js.screens?.capture) : false));

/** writeAdapter(root, diff, confirmed, { location?, finish?, env? }) → { written, file, keys }. `diff.seed` is the raw
 * adapter started from when there is none yet (or when it replaces a 0.7 one). `finish`: keys the result must hold
 * (`risk`, `screens.capture`); while one is unset the write is refused and nothing is written. The result passes
 * checkAdapter and the adapter budget, or nothing is written. */
export async function writeAdapter(root, diff, confirmed, { location, finish = [], env = process.env } = {}) {
  const found = locate(root, env);
  const replacing = !found || found.raw?.version !== 2;
  if (found && found.raw?.version !== 2 && !diff.seed) throw new WfError(`${found.file} is a 0.7 adapter`, { hint: 'run `wf init --from-07`' });
  const before = replacing ? null : found.raw;
  const js = structuredClone(before ?? diff.seed ?? null);
  if (!js) throw new WfError('no adapter yet and no seed in the diff to start one');
  const picked = confirmedChanges(diff, confirmed);
  for (const c of picked) applyChange(js, c);
  const keys = picked.map((c) => c.key);

  const missing = unfinished(js, finish);
  if (missing.length) throw new WfError(`onboarding cannot finish: ${missing.map((k) => (k === 'risk' ? '`risk` is unconfirmed (confirm the proposed areas, or `risk: none`)' : '`screens.capture` is unset, or its command does not write to {out}')).join('; ')}; nothing written`);

  // Hashes: every policy key a confirmed change touched, and on a new adapter every key it holds.
  const pol = policyOf(js);
  const empty = policyOf({});
  const hashes = { ...(before?.onboarded?.hashes ?? {}) };
  const touched = new Set(picked.map((c) => topOf(c.key)));
  for (const k of POLICY_KEYS) if (touched.has(k) || (replacing && !same(pol[k], empty[k]))) hashes[k] = policyHash(pol[k]);
  const { onboarded: _o, ...restNew } = js;
  const { onboarded: _p, ...restOld } = before ?? {};
  if (!replacing && same(restNew, restOld) && same(hashes, before?.onboarded?.hashes ?? {})) return { written: false, file: found.file, keys: [] };
  js.onboarded = { at: new Date().toISOString(), engine: CONTRACT_VERSION, hashes };

  const where = location ?? found?.location ?? 'repo';
  if (where === 'user') js.root ??= root;
  const problems = await checkAdapter(js, { location: where });
  if (problems.length) throw new WfError(`the adapter would be invalid; nothing written:\n- ${problems.join('\n- ')}`);
  const file = found && found.location === where ? found.file : where === 'user' ? path.join(userDir(env), 'projects', `${js.name}.yaml`) : path.join(root, '.workflow', 'project.yaml');
  if (found && found.file !== file) throw new WfError(`the adapter is at ${found.file}; moving it to the ${where} folder is not done by onboarding`, { hint: 'move the file yourself, then re-run `wf init`' });
  const beforeBudget = before ? await adapterBudget(await loadAdapter(root, { env })).catch(() => null) : null;
  const oldText = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
  const put = (value) => {
    // A copy with no shared objects, so the YAML holds no anchors or aliases the person would have to read through.
    const obj = JSON.parse(JSON.stringify(value));
    let text;
    if (!replacing && oldText !== null) {
      // Edit in place, so the person's comments and order survive.
      const doc = YAML.parseDocument(oldText);
      const now = doc.toJSON() ?? {};
      for (const [k, v] of Object.entries(obj)) if (!same(now[k], v)) doc.set(k, v);
      for (const k of Object.keys(now)) if (!(k in obj)) doc.delete(k);
      text = doc.toString();
    } else text = YAML.stringify(obj);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  };
  const restore = () => (oldText === null ? fs.rmSync(file, { force: true }) : fs.writeFileSync(file, oldText));
  put(js);
  try {
    const budget = await adapterBudget(await loadAdapter(root, { env }));
    if (!js.budget?.adapter) {
      // The first onboarding sets the project's budget to what it wrote; growth from here needs a proposal.
      js.budget = { ...(js.budget ?? {}), adapter: { ...budget.counts } };
      put(js);
    } else if (budget.over.length) {
      const grew = budget.over.filter((k) => !beforeBudget || budget.counts[k] > beforeBudget.counts[k]);
      if (grew.length) throw new WfError(`over the adapter budget (${grew.map((k) => `${k} ${budget.counts[k]} > ${budget.limits[k]}`).join(', ')}); nothing written`, { hint: 'a net increase needs a project proposal (`wf learn`), or confirm fewer keys' });
    }
  } catch (error) {
    restore();
    throw error;
  }
  if (where === 'user') commitUserFolder(file, `onboarding: ${keys.join(', ') || 'new adapter'}`);
  return { written: true, file, keys };
}

// ---------------------------------------------------------------------------------------------------------------------
// wf init
// ---------------------------------------------------------------------------------------------------------------------

const flagList = (v) => (v === undefined ? [] : [].concat(v).filter((x) => x !== true));
function readDraft(file, cwd) {
  const f = path.resolve(cwd, file);
  if (!fs.existsSync(f)) throw new WfError(`--draft ${file}: no such file`);
  const text = fs.readFileSync(f, 'utf8');
  try {
    return /\.json$/i.test(f) ? JSON.parse(text) : YAML.parse(text);
  } catch (error) {
    throw new WfError(`--draft ${file}: ${error.message}`, { hint: `the draft is JSON or YAML of this shape:\n${DRAFT_SHAPE}` });
  }
}

function git(cwd, args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : null;
}

// The base of a repo: its remote's default branch, else the checked-out branch (facts from git).
function baseOf(dir) {
  const head = git(dir, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']);
  return head ? head.replace(/^origin\//, '') : git(dir, ['branch', '--show-current']) || null;
}

// The test-file globs of a repo for `kinds.tests`, from the test files the scan found (relative to the repo).
export function testKinds(repo) {
  const prefix = repo.path === '.' ? '' : `${repo.path}/`;
  return [...new Set(repo.tests.map((t) => {
    const rel = t.slice(prefix.length);
    const segs = rel.split('/');
    const i = segs.findIndex((s) => /^(tests?|__tests__|specs?|e2e)$/i.test(s));
    if (i >= 0) return `${segs.slice(0, i + 1).join('/')}/**`;
    const m = /[._-](test|spec)(\.[a-z]+)$/i.exec(rel);
    return m ? `**/*${m[0]}` : null;
  }).filter(Boolean))].sort();
}

function freshSeed(root, facts) {
  const ci = facts.repos.some((r) => r.facts.some((f) => f.kind === 'ci-file'));
  const inv = facts.repos.flatMap((r) => r.facts.filter((f) => f.kind === 'invariants-doc' && !/:\d+$/.test(f.path)));
  return {
    version: 2,
    name: path.basename(root).replace(/^[^A-Za-z0-9]+/, '').replace(/[^A-Za-z0-9._-]+/g, '-') || 'project',
    repos: facts.repos.map((r) => ({ name: r.name, path: r.path, base: baseOf(path.resolve(root, r.path)), kinds: { tests: testKinds(r), other: ['**/*.md'] } })),
    ...(inv.length === 1 ? { invariants: inv[0].path } : {}),
    delivery: { landing: ci ? 'direct' : 'queue', order: facts.repos.map((r) => r.name) },
  };
}

export function renderDiff(name, diff, extra = []) {
  const out = [];
  const hand = diff.changes.filter((c) => c.handEdited);
  const rest = diff.changes.filter((c) => !c.handEdited);
  out.push(`Onboarding ${name}: ${rest.length} proposed change${rest.length === 1 ? '' : 's'}${hand.length ? `, ${hand.length} hand-edited` : ''}.`);
  if (hand.length) {
    out.push('', 'Edited by hand since onboarding wrote them (kept unless you confirm the key):');
    for (const c of hand) out.push(`  ${c.key}: now ${show(c.from)}${same(c.from, c.to) ? '' : `\n    proposed: ${show(c.to)}`}`, `    why: ${c.reason}`);
  }
  if (rest.length) {
    out.push('', 'Proposed:');
    for (const c of rest) out.push(`  ${c.key}: ${show(c.from)} → ${show(c.to)}`, `    why: ${c.reason}`);
  }
  if (diff.overBudget?.length) out.push('', `Not proposed, over the adapter's risk budget: ${diff.overBudget.map((x) => x.id).join(', ')}`);
  if (diff.unchanged.length) out.push('', `Unchanged: ${diff.unchanged.join(', ')}`);
  return [...out, ...extra].join('\n');
}

export async function cmdInit(ctx, args) {
  const f = args.flags ?? {};
  const env = ctx.env ?? process.env;
  const root = real(ctx.root ?? ctx.cwd);
  const from07 = Boolean(f['from-07']);
  const draft = typeof f.draft === 'string' ? readDraft(f.draft, ctx.cwd) : null;
  const confirm = flagList(f.confirm);
  const location = f.location === undefined ? undefined : String(f.location);
  if (location && !['user', 'repo'].includes(location)) throw new WfError('--location is `user` or `repo`');
  const found = locate(root, env);
  let current = null;
  let migration = null;
  if (from07) {
    if (!found || found.raw?.version !== 1) throw new WfError(`--from-07: no 0.7 adapter at ${found?.file ?? path.join(root, '.workflow', 'project.yaml')}`);
    const { from07: convert } = await import('./migrate.mjs');
    migration = await convert(root, found.raw, { env });
  } else if (found && found.raw?.version !== 2) throw new WfError(`${found.file} is a 0.7 adapter`, { hint: 'run `wf init --from-07`' });
  else if (found) current = await loadAdapter(root, { env });

  const facts = await scan(root, { repos: (current?.repos ?? migration?.seed.repos)?.map((r) => ({ name: r.name, path: r.path })) });
  const merged = migration ? { ...migration.draft, ...(draft ?? {}), screens: { ...migration.draft.screens, ...(draft?.screens ?? {}) } } : draft;
  const diff = await proposePolicy(facts, current, merged);
  if (!current) {
    diff.seed = migration?.seed ?? freshSeed(root, facts);
    for (const r of diff.seed.repos ?? []) {
      const scanned = facts.repos.find((x) => x.name === r.name);
      if (scanned && !r.kinds?.tests?.length) r.kinds = { ...(r.kinds ?? {}), tests: testKinds(scanned), other: r.kinds?.other ?? ['**/*.md'] };
    }
  }
  const extra = migration ? migration.report() : [];
  const name = current?.name ?? diff.seed?.name ?? path.basename(root);
  const data = { diff, draftShape: DRAFT_SHAPE, facts: { root, repos: facts.repos.map((r) => ({ name: r.name, path: r.path, modules: r.modules, facts: r.facts.map(({ kind, path: p, evidence }) => ({ kind, path: p, evidence })) })) }, ...(migration ? { migration: migration.data } : {}) };
  if (!confirm.length) {
    if (!diff.changes.length) return { text: `${renderDiff(name, diff, extra)}\n\nNothing to change; nothing written.`, data };
    const how = [
      'Nothing written.',
      'To refine it, have a model draft the policy from the facts (`wf init --json` prints them) and pass it back with `--draft <file>`, JSON or YAML of this shape (any subset):',
      DRAFT_SHAPE,
      'To write, confirm keys: `wf init --confirm <key>` (repeatable; a top key takes all of its parts; `--confirm all` takes every change not edited by hand). Pass the same `--draft` again when confirming.',
    ];
    return { text: `${renderDiff(name, diff, extra)}\n\n${how.join('\n')}`, data };
  }
  const finish = migration ? ['risk', 'screens.capture'] : ['risk'];
  const res = await writeAdapter(root, diff, confirm, { location, finish, env });
  const after = res.written && migration ? await migration.afterWrite(res) : [];
  data.written = res;
  return { text: `${renderDiff(name, diff, extra)}\n\n${res.written ? `Wrote ${res.file}: ${res.keys.join(', ') || 'the adapter'}.` : 'Nothing to change; nothing written.'}${after.length ? `\n${after.join('\n')}` : ''}`, data };
}

// ---------------------------------------------------------------------------------------------------------------------
// wf doctor
// ---------------------------------------------------------------------------------------------------------------------

// Lines of the project's instruction files that name a command 0.8 does not have, or a 0.7 flag or lane.
export function staleInstructionLines(root, files) {
  const known = new Set([...Object.keys(COMMANDS), ...Object.keys(COMMAND_ALIASES)]);
  const out = [];
  for (const rel of files) {
    let text;
    try {
      text = fs.readFileSync(path.join(root, rel), 'utf8');
    } catch {
      continue;
    }
    text.split('\n').forEach((line, i) => {
      const words = [...line.matchAll(/`wf\s+([a-z][a-z-]*)|\bwf\s+([a-z][a-z-]*)/g)].map((m) => m[1] ?? m[2]).filter((w) => !known.has(w));
      const flags = line.match(/--intent\s+analysis|--defer-heavy|--lane\b|\blanes?\s*:|\b(quick|standard|batch)\s+lane\b/g) ?? [];
      if (words.length || flags.length) out.push({ file: rel, line: i + 1, names: [...new Set([...words.map((w) => `wf ${w}`), ...flags])], text: clip(line.trim(), 120) });
    });
  }
  return out;
}

function instructionFiles(root, repos) {
  const out = new Set();
  for (const r of repos?.length ? repos : [{ path: '.' }]) {
    const dir = path.resolve(root, r.path);
    if (!fs.existsSync(dir)) continue;
    const prefix = r.path === '.' ? '' : `${r.path}/`;
    for (const f of repoFiles(dir)) if (isInstructionDoc(f)) out.add(`${prefix}${f}`);
  }
  for (const f of ['AGENTS.md', 'CLAUDE.md']) if (fs.existsSync(path.join(root, f))) out.add(f);
  return [...out].sort();
}

const TERMINAL07 = ['closed', 'abandoned', 'analysis.closed', 'shipped.closed', 'attempt.closed'];

export async function cmdDoctor(ctx) {
  const env = ctx.env ?? process.env;
  const root = real(ctx.root ?? ctx.cwd);
  const checks = [];
  const add = (level, check, detail, fix = null) => checks.push({ level, check, detail, fix });
  let found = null;
  try {
    found = locate(root, env);
    if (!found) add('fail', 'adapter', `no adapter for ${root}`, 'run `wf init`');
  } catch (error) {
    add('fail', 'adapter', error.message);
  }
  let adapter = null;
  if (found && found.raw?.version !== 2) add('fail', 'adapter', `${found.file} is a 0.7 adapter`, 'run `wf init --from-07`');
  else if (found) {
    try {
      adapter = await loadAdapter(root, { env });
      add('ok', 'adapter', `${found.file} (${found.location})`);
    } catch (error) {
      add('fail', 'adapter', error.message, 'fix the adapter, or re-run `wf init`');
    }
  }
  if (adapter) {
    if (!adapter.risk?.confirmed) add('fail', 'risk', 'risk paths are unconfirmed', 'run `wf init` and confirm the proposed areas (or `risk: none`)');
    else add('ok', 'risk', adapter.risk.paths.length ? adapter.risk.paths.map((r) => r.id).join(', ') : 'none (confirmed)');
    const edited = handEditedKeys(found.raw);
    if (edited.length) add('warn', 'hand edits', `edited by hand since onboarding wrote them: ${edited.join(', ')}`, 're-run `wf init` to review them; confirming a key keeps it');
    try {
      const b = await adapterBudget(adapter);
      const line = Object.entries(b.counts).map(([k, v]) => `${k} ${v}/${b.limits?.[k] ?? '-'}`).join(', ');
      if (b.over.length) add('fail', 'adapter budget', `over on ${b.over.join(', ')} (${line})`, 'a net increase needs a project proposal (`wf learn`)');
      else add('ok', 'adapter budget', line);
    } catch (error) {
      add('fail', 'adapter budget', error.message);
    }
    for (const r of adapter.repos) {
      const dir = path.resolve(root, r.path);
      if (!fs.existsSync(dir)) {
        add('fail', `repo ${r.name}`, `${dir} does not exist`);
        continue;
      }
      const remote = r.remote ?? 'origin';
      if (git(dir, ['rev-parse', '--verify', '--quiet', `refs/remotes/${remote}/${r.base}`]) === null && git(dir, ['rev-parse', '--verify', '--quiet', `refs/heads/${r.base}`]) === null) add('fail', `repo ${r.name}`, `base \`${r.base}\` is neither ${remote}/${r.base} nor a local branch`, `git -C ${r.path} fetch ${remote}`);
      if (!r.tests?.fast && !r.tests?.full) add('warn', `repo ${r.name}`, 'no tests set', 're-run `wf init`');
    }
    try {
      const { moduleProblems, moduleRefsOf } = await import('./migrate.mjs');
      for (const m of await moduleProblems(root, adapter.repos, moduleRefsOf(adapter))) add('fail', m.what, `${m.module} ${m.problem}`);
    } catch (error) {
      add('warn', 'modules', `not checked: ${error.message}`);
    }
    if (adapter.invariants && !fs.existsSync(path.resolve(root, adapter.invariants))) add('fail', 'invariants', `${adapter.invariants} does not exist`);
    if (!adapter.screens?.capture) add('warn', 'screens', '`screens.capture` is unset: no screens are captured', 're-run `wf init` with the capture command');
    else if (!adapter.screens.routes) add('warn', 'screens', '`screens.routes` is unset: only a change to a `shared` path captures screens (the `sentinel` set)', 're-run `wf init` with the routes module');
    for (const t of adapter.requires?.tools ?? []) if (spawnSync('sh', ['-c', 'command -v "$1"', 'sh', String(t)]).status !== 0) add('fail', 'tools', `\`${t}\` is not on PATH`);
  }
  for (const s of staleInstructionLines(root, instructionFiles(root, adapter?.repos ?? found?.raw?.repos))) add('warn', 'instruction files', `${s.file}:${s.line} names ${s.names.join(', ')}: ${s.text}`, 'reword or remove the line: 0.8 has no such command');
  try {
    const { productImports } = await import('./migrate.mjs');
    const imports = productImports(root, adapter?.repos ?? found?.raw?.repos ?? []);
    if (imports.length) add('warn', 'workflow material', `${imports.length} line${imports.length === 1 ? '' : 's'} of product code import from .workflow/ (first: ${imports[0].at})`, 'see `wf migrate material`');
  } catch (error) {
    add('warn', 'workflow material', `not checked: ${error.message}`);
  }
  try {
    const open07 = [];
    for (const id of await listAttempts(root)) {
      const ev = await readEvents(root, id);
      if (ev.length && !ev.some((e) => e.schema === 2) && !ev.some((e) => TERMINAL07.includes(e.type))) open07.push(id);
    }
    if (open07.length) add('warn', '0.7 attempts', `open: ${open07.join(', ')}`, 'run `wf migrate attempts`');
  } catch (error) {
    add('warn', '0.7 attempts', `not checked: ${error.message}`);
  }
  try {
    const { rows } = await secretsStatus(root, adapter);
    const missing = rows.filter((r) => r.needed && r.state !== 'filled').map((r) => r.key);
    if (rows.length) add(missing.length ? 'fail' : 'ok', 'secrets', missing.length ? `missing or invalid: ${missing.join(', ')}` : `${rows.length} catalogued, all filled`, missing.length ? 'run `wf secrets guide` in your own terminal' : null);
  } catch (error) {
    add('warn', 'secrets', `not checked: ${error.message}`);
  }
  // Named failure: cloud sync conflict copies left the evidence folder empty while a sibling copy held the ledgers.
  for (const w of stateFolderWarnings(root)) add('warn', w.check, w.problem, w.fix ?? null);
  const mark = { ok: '✓', warn: '!', fail: '✗' };
  const text = checks.map((c) => `${mark[c.level]} ${c.check}: ${c.detail}${c.fix ? `\n    fix: ${c.fix}` : ''}`).join('\n');
  return { text, data: { checks }, exitCode: checks.some((c) => c.level === 'fail') ? 1 : 0 };
}

// ---------------------------------------------------------------------------------------------------------------------
// wf sync: (re-)register the project in the person's registry and check the skills it requires
// ---------------------------------------------------------------------------------------------------------------------

export const registryFile = (env = process.env) => path.join(userDir(env), 'registry.json');
export async function cmdSync(ctx) {
  const env = ctx.env ?? process.env;
  const root = real(ctx.root ?? ctx.cwd);
  const found = locate(root, env);
  if (!found) throw new WfError(`no adapter for ${root}`, { hint: 'run `wf init`' });
  if (found.raw?.version !== 2) throw new WfError(`${found.file} is a 0.7 adapter`, { hint: 'run `wf init --from-07`' });
  const adapter = await loadAdapter(root, { env });
  const file = registryFile(env);
  let reg = { projects: [] };
  try {
    reg = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {}
  const entry = { name: adapter.name, root, file: found.file, location: found.location };
  const prior = reg.projects.find((p) => p.root === root);
  const changed = !prior || !same({ ...prior, at: undefined }, entry);
  if (changed) {
    reg.projects = [...reg.projects.filter((p) => p.root !== root), { ...entry, at: new Date().toISOString() }].sort((a, b) => a.name.localeCompare(b.name));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(reg, null, 2)}\n`);
  }
  const lines = [`${changed ? 'Registered' : 'Already registered'}: ${adapter.name} at ${root}.`];
  const skills = adapter.requires?.skills ?? [];
  const runtime = ctx.actor?.runtime ?? null;
  if (skills.length && !runtime) lines.push(`Required skills not checked at a plain terminal: ${skills.join(', ')}`);
  else if (skills.length) {
    try {
      const { findSkill } = await import('./skills.mjs');
      for (const s of skills) {
        const where = findSkill(root, s, runtime);
        lines.push(`Skill ${s}: ${where ? 'found' : `not found for ${runtime}`}`);
      }
    } catch (error) {
      lines.push(`Required skills not checked: ${error.message}`);
    }
  }
  return { text: lines.join('\n'), data: { registered: entry, changed } };
}

// ---------------------------------------------------------------------------------------------------------------------
// wf secrets guide|check: names and states only; no value is ever printed
// ---------------------------------------------------------------------------------------------------------------------

// The catalogue beside the adapter (config.mjs secretsCatalogFile): the repo copy's `.workflow/`, or the user folder.
function secretsCfg(root, adapter) {
  const catalogFile = secretsCatalogFile(adapter, root);
  const catalog = readYaml(catalogFile);
  const top = catalog && !Array.isArray(catalog) ? catalog : {};
  return { name: adapter?.name ?? path.basename(root), catalogFile, repos: adapter?.repos ?? [{ name: path.basename(root), path: '.' }], secrets: { store: top.store ?? 'env-file', ...(top.file ? { file: top.file } : {}) } };
}
async function secretsStatus(root, adapter) {
  if (!fs.existsSync(secretsCatalogFile(adapter, root))) return { rows: [] };
  const secrets = await import('./secrets.mjs');
  return { rows: secrets.status(root, secretsCfg(root, adapter)) };
}

export async function cmdSecrets(ctx, args) {
  const env = ctx.env ?? process.env;
  const root = real(ctx.root ?? ctx.cwd);
  const [sub = 'check', key] = (args._ ?? []).filter((x) => x !== 'secrets');
  const adapter = locate(root, env)?.raw?.version === 2 ? await loadAdapter(root, { env }) : null;
  if (sub === 'check') {
    const { rows } = await secretsStatus(root, adapter);
    if (!rows.length) return { text: `No secrets catalogued (${secretsCatalogFile(adapter, root)}).`, data: { rows } };
    const missing = rows.filter((r) => r.needed && r.state !== 'filled');
    return { text: rows.map((r) => `${r.state === 'filled' ? '✓' : '✗'} ${r.key}: ${r.state}${r.needed ? '' : ' (no step needs it)'}`).join('\n'), data: { rows }, exitCode: missing.length ? 1 : 0 };
  }
  if (sub === 'guide') {
    if (!process.stdin.isTTY) throw new WfError('`wf secrets guide` asks for values with hidden input: run it in your own terminal');
    const secrets = await import('./secrets.mjs');
    await secrets.guide(root, secretsCfg(root, adapter), key);
    return { text: '' };
  }
  throw new WfError(`wf secrets ${sub}: the subcommands are guide and check`);
}

export const implements08 = { proposePolicy, writeAdapter, cmdDoctor, cmdInit, cmdSync, cmdSecrets };
