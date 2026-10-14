// Impact analysis (I-26) and fix-round pattern sweeps (I-25).
//
// Named failure (I-26): a cross-cutting ticket was planned in minutes from a count of where one component appeared; the
// planner never characterised how each consumer behaved (data source, limits, empty, error, phone, sorting, totals,
// write paths) and never opened the other repo. Its bundle's impact field was empty because the engine derives impact
// from a diff, and none exists before planning. Most of the work added later, and most review findings, were one search
// away on the base commits. The planner now writes two stages: a `survey` of what exists around the issue (before the
// design) and an `impact` map derived from the chosen design. Every list names the structured query it came from and its
// hit count; `wf plan` re-runs each query itself and refuses invented or stale counts, survey entries the design neither
// covers nor excludes with a reason, and impact entries that cite no element of the design.
//
// Queries are data, never shell: { id, pattern, kind: literal|regex, repo?, paths?, exclude?, unit?: files|lines,
// ignoreCase? }. The engine lists the files of a committed tree (git ls-tree) and reads their blobs (git cat-file),
// applies the pattern per line in this process, and caps what it reads.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { repoDir, trustedAdapter } from './config.mjs';
import { WfError, YAML, assertPlainGit, git, gitEnv, globProblem, matchesAny, refuse } from './util.mjs';

export const IMPACT_DEFAULTS = { requiredFor: ['full'], maxFileBytes: 2 * 1024 * 1024, maxScanBytes: 512 * 1024 * 1024, regexTimeoutMs: 20000 };
// One row per affected component: each column is a behaviour the change can break. A value may be `none` or `n/a`, but
// it must be stated: a column left out is a behaviour nobody looked at.
export const COMPONENT_COLUMNS = ['endpoint', 'limit', 'writePaths', 'paging', 'empty', 'loading', 'error', 'permission', 'mobile', 'rtl', 'publicApi', 'sorting', 'reorder', 'clientTotals', 'rawEnums', 'tests'];
const SURVEY_LISTS = ['components', 'consumers', 'flows', 'patterns'];
export const DESIGN_KEYS = ['plan', 'summary', 'contract', 'anchors', 'tests', 'doNotRun', 'externalServices', 'agentSplit', 'criteria', 'work'];
const KINDS = ['literal', 'regex'];

const text = (v) => (typeof v === 'string' ? v.trim() : '');
const present = (v) => v !== undefined && v !== null && !(typeof v === 'string' && !v.trim());
const list = (v) => (Array.isArray(v) ? v : []);

export function impactSettings(cfg) {
  return { ...IMPACT_DEFAULTS, ...(cfg?.impact ?? {}) };
}

// Whether this attempt's plan must carry the two stages: the lane has a planner and some work item (or, without work
// items, the implementer role) runs at a class the adapter lists under `impact.requiredFor` (default: full).
export function impactRequired(cfg, { plannerNeeded, work, implementerClass }) {
  if (!plannerNeeded) return false;
  const classes = work?.length ? work.map((w) => w.class) : [implementerClass];
  const req = impactSettings(cfg).requiredFor ?? [];
  return classes.some((c) => req.includes(c));
}

// ---- Structured queries ----

function validateQuery(q, cfg, problems) {
  const where = `query \`${q?.id ?? '?'}\``;
  if (!q || typeof q !== 'object' || !text(q.id)) {
    problems.push('each query needs an `id`');
    return false;
  }
  if (typeof q.pattern !== 'string' || !q.pattern) problems.push(`${where}: \`pattern\` must be a non-empty string`);
  const kind = q.kind ?? 'literal';
  if (!KINDS.includes(kind)) problems.push(`${where}: \`kind\` is literal or regex, not \`${kind}\``);
  if (kind === 'regex' && typeof q.pattern === 'string') {
    try {
      new RegExp(q.pattern, q.ignoreCase ? 'i' : '');
    } catch (error) {
      problems.push(`${where}: invalid regex (${error.message})`);
    }
  }
  if (q.repo !== undefined && !cfg.repos.some((r) => r.name === q.repo)) problems.push(`${where}: unknown repo \`${q.repo}\` (repos: ${cfg.repos.map((r) => r.name).join(', ')})`);
  for (const k of ['paths', 'exclude']) {
    if (q[k] !== undefined && (!Array.isArray(q[k]) || q[k].some((g) => typeof g !== 'string' || !g))) problems.push(`${where}: \`${k}\` must be a list of globs`);
    // A glob that expands into too many alternatives is refused here, before any tree is read (0.5.0 adversarial review).
    else for (const g of q[k] ?? []) if (globProblem(g)) problems.push(`${where}: \`${k}\`: ${globProblem(g)}`);
  }
  if (q.unit !== undefined && !['files', 'lines'].includes(q.unit)) problems.push(`${where}: \`unit\` is files or lines`);
  return true;
}

export function validateQueryShape(q, cfg) {
  const problems = [];
  validateQuery(q, cfg, problems);
  return problems;
}

// Named failure (0.5.0 integration review): queries took their repos (and so the folders they read) and their read
// limits from the working tree's `.workflow/project.yaml`, which any agent can edit: a repo path pointed at another
// checkout was read and its file names printed, and the limits could be lifted. Both come from the adapter as committed
// at the attempt's base, like every other rule that judges the ticket.
// Named failure (0.5.0 adversarial review): this fell back to the working copy when the adapter at base could not be read
// (an uncommitted `adapterRepo` edit made the read throw) or when no base was recorded, and the queries then read any
// checkout the working copy named. Nothing falls back: an attempt without a readable adapter at base runs no query.
const trustedCache = new Map();
function trustedConfig(root, cfg, state) {
  if (!state?.id) throw refuse('impact queries run only for an attempt (`--attempt <id>`), with the adapter at its base');
  const key = `${root}\0${state.id}\0${state.adapterBase}`;
  if (!trustedCache.has(key)) trustedCache.set(key, trustedAdapter(root, state));
  return trustedCache.get(key);
}
const trustedLimits = (t, settings) => ({ ...settings, maxFileBytes: settings.maxFileBytes === Infinity ? Infinity : impactSettings(t).maxFileBytes, maxScanBytes: settings.maxScanBytes === Infinity ? Infinity : impactSettings(t).maxScanBytes });

// The committed tree a query reads in one repo: the attempt's worktree HEAD for a repo in the attempt, else the base
// branch of the repo's main checkout (the remote's when fetched). Uncommitted edits are never read.
function treeOf(root, cfg, state, name) {
  const r = state.repos?.[name];
  if (r?.worktree && fs.existsSync(r.worktree)) {
    assertPlainGit(r.worktree);
    return { dir: r.worktree, ref: git(r.worktree, ['rev-parse', 'HEAD']) };
  }
  // Named failure (0.5.0 second review, fail-open): a repo of the attempt whose worktree was gone was read at its base
  // branch instead, so a query counted the code before the change and the count still matched. Refused.
  if (r) throw refuse(`the worktree of ${name} (${r.worktree ?? 'none recorded'}) is missing, so the attempt's committed tree cannot be read`, '`wf verify` the attempt; restore the worktree or abandon the attempt');
  const repo = cfg.repos.find((x) => x.name === name);
  if (!repo) throw refuse(`repo \`${name}\` is not in the adapter at the attempt's base`);
  const dir = repoDir(root, repo);
  assertPlainGit(dir);
  const remote = git(dir, ['rev-parse', '--verify', '--quiet', `${repo.remote}/${repo.base}^{commit}`], { allowFail: true });
  return { dir, ref: remote || git(dir, ['rev-parse', `${repo.base}^{commit}`]) };
}

function blobs(dir, ids) {
  if (!ids.length) return new Map();
  const r = spawnSync('git', ['cat-file', '--batch'], { cwd: dir, env: gitEnv(), input: `${ids.join('\n')}\n`, maxBuffer: 1024 * 1024 * 1024 });
  if (r.status !== 0) throw new WfError(`git cat-file failed in ${dir}: ${String(r.stderr)}`);
  // Named failure (0.5.0 second review, fail-open): a `missing` answer or a short read ended the parse early, and every
  // file after it was silently left out of the count. Any answer that is not a whole blob is an error.
  const out = new Map();
  const buf = r.stdout;
  let i = 0;
  while (i < buf.length) {
    const nl = buf.indexOf(10, i);
    if (nl < 0) throw new WfError(`git cat-file in ${dir}: truncated answer`);
    const [sha, type, size] = buf.subarray(i, nl).toString().split(' ');
    const n = Number(size);
    if (type !== 'blob' || !Number.isInteger(n) || n < 0 || nl + 1 + n > buf.length) throw new WfError(`git cat-file in ${dir} could not read ${sha}: ${buf.subarray(i, nl).toString()}`);
    out.set(sha, buf.subarray(nl + 1, nl + 1 + n));
    i = nl + 1 + n + 1;
  }
  for (const id of ids) if (!out.has(id)) throw new WfError(`git cat-file in ${dir} returned no content for ${id}`);
  return out;
}

// Reads every text file of the committed trees of `names` that the globs select, once, and hands each to `onFile` as
// (`repo:path`, lines). Returns { skipped, refs }.
function scanTrees(root, working, state, { names, paths, exclude, settings: asked, what }, onFile) {
  const cfg = trustedConfig(root, working, state);
  const settings = trustedLimits(cfg, asked);
  const skipped = [];
  const refs = {};
  let scanned = 0;
  for (const name of names) {
    const { dir, ref } = treeOf(root, cfg, state, name);
    refs[name] = ref;
    const entries = git(dir, ['ls-tree', '-r', '-z', '--long', ref]).split('\0').filter(Boolean).map((l) => {
      const tab = l.indexOf('\t');
      const [mode, type, sha, size] = l.slice(0, tab).trim().split(/\s+/);
      return { mode, type, sha, size: Number(size), file: l.slice(tab + 1) };
    });
    const wanted = entries.filter((e) => e.type === 'blob' && e.mode !== '120000' && (!paths?.length || matchesAny(e.file, paths)) && !matchesAny(e.file, exclude ?? []));
    const read = [];
    const tooLarge = [];
    for (const e of wanted) {
      if (!Number.isInteger(e.size)) throw new WfError(`git ls-tree in ${dir}: no size for ${e.file}`);
      if (e.size > settings.maxFileBytes) {
        // Named failure (0.5.0 second review, fail-open): a text file over the size cap was skipped and the query's
        // count went on without it, as if it had no hit. A binary file (a NUL in its first 8000 bytes, as git decides)
        // holds no line to match and is listed; a text file the engine cannot read refuses the query.
        const head = spawnSync('git', ['cat-file', 'blob', e.sha], { cwd: dir, env: gitEnv(), maxBuffer: 8000 });
        if (head.stdout?.subarray(0, 8000).includes(0)) skipped.push(`${name}:${e.file}`);
        else tooLarge.push(`${name}:${e.file} (${e.size} bytes)`);
        continue;
      }
      scanned += e.size;
      if (scanned > settings.maxScanBytes) throw refuse(`${what} reads more than ${settings.maxScanBytes} bytes; narrow its \`paths\``);
      read.push(e);
    }
    if (tooLarge.length) throw refuse(`${what} cannot read ${tooLarge.length} text file(s) over impact.maxFileBytes (${settings.maxFileBytes} bytes), so its count would leave them out: ${tooLarge.slice(0, 10).join(', ')}${tooLarge.length > 10 ? ', ...' : ''}`, 'exclude them (`exclude: [globs]`), narrow its `paths`, or raise `impact.maxFileBytes` in the adapter on the base branch');
    const content = blobs(dir, [...new Set(read.map((e) => e.sha))]);
    for (const e of read) {
      const b = content.get(e.sha);
      if (!b) throw new WfError(`${name}:${e.file} could not be read from ${ref.slice(0, 10)}`);
      if (b.subarray(0, 8000).includes(0)) {
        skipped.push(`${name}:${e.file}`);
        continue;
      }
      onFile(`${name}:${e.file}`, b.toString('utf8').split('\n'));
    }
  }
  return { skipped, refs };
}

// Named failure (0.5.0 integration review): a regex query (written by the planner, a sweep file or `wf impact run
// --query`) ran in the engine's own process, so a pattern with catastrophic backtracking hung `wf plan`, `wf review` and
// the reviewer handoff with no way out. A regex runs in a child process that is killed after `impact.regexTimeoutMs`
// (default 20 s); a literal query never backtracks and runs here.
const REGEX_CHILD = `let s='';process.stdin.setEncoding('utf8');process.stdin.on('data',(d)=>{s+=d});process.stdin.on('end',()=>{const {pattern,flags,texts}=JSON.parse(s);const re=new RegExp(pattern,flags);const out=[];for(const [f,lines] of texts){let n=0;for(const l of lines)if(re.test(l))n++;if(n)out.push([f,n]);}process.stdout.write(JSON.stringify(out));});`;
function regexCounts(q, texts, timeoutMs) {
  if (!texts.length) return [];
  const r = spawnSync(process.execPath, ['-e', REGEX_CHILD], { input: JSON.stringify({ pattern: q.pattern, flags: q.ignoreCase ? 'i' : '', texts }), timeout: timeoutMs, maxBuffer: 256 * 1024 * 1024, encoding: 'utf8', killSignal: 'SIGKILL' });
  if (r.error?.code === 'ETIMEDOUT' || r.signal) throw refuse(`query \`${q.id}\`: the regex ran longer than ${Math.round(timeoutMs / 1000)} s and was stopped (a pattern that backtracks without end, or too many files)`, 'simplify the pattern (no nested quantifiers such as `(a+)+`), use `kind: literal`, or narrow its `paths`');
  if (r.status !== 0) throw new WfError(`query \`${q.id}\`: the regex could not run: ${String(r.stderr).split('\n').find((l) => /Error/.test(l)) ?? r.stderr}`);
  return JSON.parse(r.stdout);
}

const queryRepos = (cfg, state, q) => (q.repo ? [q.repo] : Object.keys(state.repos ?? {}).length ? Object.keys(state.repos) : cfg.repos.map((r) => r.name));

// Runs one query and returns { id, hits, files, lines, skipped, refs }. Files are named `repo:path`.
export function runQuery(root, working, state, q, settings = impactSettings(working)) {
  const cfg = trustedConfig(root, working, state);
  if (q.repo !== undefined && !cfg.repos.some((r) => r.name === q.repo)) throw refuse(`query \`${q.id}\`: unknown repo \`${q.repo}\` in the adapter at the attempt's base`);
  const regex = (q.kind ?? 'literal') === 'regex';
  const needle = q.ignoreCase ? String(q.pattern).toLowerCase() : String(q.pattern);
  const match = q.ignoreCase ? (line) => line.toLowerCase().includes(needle) : (line) => line.includes(needle);
  const files = [];
  let lines = 0;
  const texts = [];
  const { skipped, refs } = scanTrees(root, cfg, state, { names: queryRepos(cfg, state, q), paths: q.paths, exclude: q.exclude, settings, what: `query \`${q.id}\`` }, (file, text) => {
    if (regex) return void texts.push([file, text]);
    const n = text.filter(match).length;
    if (n) {
      files.push(file);
      lines += n;
    }
  });
  if (regex) {
    for (const [file, n] of regexCounts(q, texts, impactSettings(cfg).regexTimeoutMs)) {
      files.push(file);
      lines += n;
    }
  }
  return { id: q.id, hits: q.unit === 'lines' ? lines : files.length, unit: q.unit ?? 'files', files, lines, skipped, refs };
}

// ---- The two stages ----

// Key order of the plan file: the survey is written before the design, the impact map after it.
export function stageOrderProblems(doc) {
  const keys = Object.keys(doc ?? {});
  const design = keys.findIndex((k) => DESIGN_KEYS.includes(k) && k !== 'criteria' && k !== 'work');
  const firstDesign = design >= 0 ? design : keys.findIndex((k) => DESIGN_KEYS.includes(k));
  const out = [];
  const s = keys.indexOf('survey');
  const i = keys.indexOf('impact');
  if (s >= 0 && firstDesign >= 0 && s > firstDesign) out.push('`survey` comes after the design: write the survey of what exists first (before `plan`), then the design, then `impact`');
  if (i >= 0 && firstDesign >= 0 && i < firstDesign) out.push('`impact` comes before the design: the impact map is derived from the chosen design, so it follows `plan`');
  if (s >= 0 && i >= 0 && i < s) out.push('`impact` comes before `survey`');
  return out;
}

// Every query of a stage, run now; counts compared with what the planner recorded.
function runAll(root, cfg, state, queries, problems, settings) {
  const results = {};
  for (const q of queries) {
    const own = [];
    validateQuery(q, cfg, own);
    if (!own.length && results[q.id]) own.push(`duplicate query id \`${q.id}\``);
    if (!own.length && !Number.isInteger(q.hits)) own.push(`query \`${q.id}\`: \`hits\` must be the count the query returned`);
    problems.push(...own);
    if (own.length) continue;
    const r = runQuery(root, cfg, state, q, settings);
    results[q.id] = { ...r, query: q, recorded: q.hits };
    if (Number.isInteger(q.hits) && q.hits !== r.hits) problems.push(`query \`${q.id}\`: recorded ${q.hits} hit(s), the engine finds ${r.hits} (${Object.entries(r.refs).map(([n, ref]) => `${n}@${ref.slice(0, 10)}`).join(', ')})`);
  }
  return results;
}

// An entry names its query and that query's hit count.
function entryQuery(where, e, results, problems, known) {
  if (!text(e?.query)) {
    problems.push(`${where}: names no \`query\` (every list entry names the recorded query it came from)`);
    return null;
  }
  const r = results[e.query];
  if (!r) {
    if (!known.has(e.query)) problems.push(`${where}: query \`${e.query}\` is not defined under \`survey.queries\` or \`impact.queries\``);
    return null;
  }
  return r;
}
function entryHits(where, e, results, problems, known) {
  const r = entryQuery(where, e, results, problems, known);
  if (!r) return;
  if (!Number.isInteger(e.hits)) problems.push(`${where}: \`hits\` must state the count of query \`${e.query}\` (${r.hits})`);
  else if (e.hits !== r.hits) problems.push(`${where}: states ${e.hits} hit(s) for query \`${e.query}\`, which returns ${r.hits}`);
}

const hasFile = (r, file) => r.files.includes(file) || r.files.some((f) => f.slice(f.indexOf(':') + 1) === file);

function validateSurvey(survey, results, known, problems) {
  const ids = new Set();
  if (!survey || typeof survey !== 'object' || Array.isArray(survey)) {
    problems.push('`survey` must be a mapping { queries, components, consumers, flows, patterns }');
    return ids;
  }
  for (const k of SURVEY_LISTS) if (survey[k] !== undefined && !Array.isArray(survey[k])) problems.push(`survey.${k} must be a list`);
  if (!SURVEY_LISTS.some((k) => list(survey[k]).length)) problems.push('`survey` is empty: list the components, consumers, flows and patterns around the issue, each from a recorded query');
  for (const k of SURVEY_LISTS) {
    list(survey[k]).forEach((e, n) => {
      const where = `survey.${k}[${n}]${e?.id ? ` (${e.id})` : ''}`;
      if (!text(e?.id)) problems.push(`${where}: needs an \`id\``);
      else if (ids.has(e.id)) problems.push(`${where}: duplicate survey id`);
      else ids.add(e.id);
      if (k === 'components') {
        if (!text(e?.file)) problems.push(`${where}: needs \`file\` (one row per affected component)`);
        // 0.7.0 (goals, not forms): the component columns are what to look at, not a form to fill; a planner states the
        // ones that matter for this change (named cost: planners needed two or three runs on form alone).
        const r = entryQuery(where, e, results, problems, known);
        if (r && text(e?.file) && !hasFile(r, e.file)) problems.push(`${where}: ${e.file} is not a hit of query \`${e.query}\``);
      } else {
        entryHits(where, e, results, problems, known);
        if (k === 'flows') {
          if (!text(e?.flow)) problems.push(`${where}: needs \`flow\` (the end-to-end path)`);
          if (!text(e?.failure)) problems.push(`${where}: needs \`failure\` (what the user sees when a step of the flow fails)`);
        }
        if (k === 'consumers' && !text(e?.symbol)) problems.push(`${where}: needs \`symbol\``);
      }
    });
  }
  return ids;
}

// A cite names an element of the design: a criterion, a work item, or text of an anchor or of the contract.
function citeValid(c, design) {
  const s = text(String(c ?? ''));
  if (!s) return false;
  if (design.criteria.has(s) || design.work.has(s)) return true;
  return design.anchors.some((a) => a.includes(s)) || design.contract.includes(s);
}

function validateChanges(changes, ctx, problems, { allowEmpty = false } = {}) {
  const { results, known, design, surveyIds } = ctx;
  const covered = new Set();
  const ids = new Set();
  if (!Array.isArray(changes) || (!changes.length && !allowEmpty)) {
    problems.push('`impact.changes` must list every changed symbol, endpoint, DTO, error code and migration of the design');
    return { covered, ids };
  }
  changes.forEach((c, n) => {
    const where = `impact.changes[${n}]${c?.id ? ` (${c.id})` : ''}`;
    if (!text(c?.id)) problems.push(`${where}: needs an \`id\``);
    else if (ids.has(c.id)) problems.push(`${where}: duplicate impact id`);
    else ids.add(c.id);
    if (!text(c?.element)) problems.push(`${where}: needs \`element\` (the symbol, endpoint, DTO, error code or migration the design changes)`);
    if (!text(c?.kind)) problems.push(`${where}: needs \`kind\` (symbol, endpoint, dto, error-code, migration, ...)`);
    const cites = Array.isArray(c?.cites) ? c.cites : c?.cites ? [c.cites] : [];
    if (!cites.some((x) => citeValid(x, design))) problems.push(`${where}: cites no element of the design (\`cites\`: a criterion id, a work item id, or text from an anchor or the contract)`);
    if (!c?.consumers || typeof c.consumers !== 'object') problems.push(`${where}: needs \`consumers: { query, hits }\``);
    else entryHits(`${where}.consumers`, c.consumers, results, problems, known);
    if (!list(c?.flows).length) problems.push(`${where}: needs \`flows\` (end to end, including failure paths)`);
    list(c?.flows).forEach((f, k) => {
      entryHits(`${where}.flows[${k}]`, f, results, problems, known);
      if (!text(f?.flow) || !text(f?.failure)) problems.push(`${where}.flows[${k}]: needs \`flow\` and \`failure\``);
    });
    if (!Array.isArray(c?.contracts)) problems.push(`${where}: needs \`contracts\` (contracts crossed; an empty list when none)`);
    list(c?.contracts).forEach((x, k) => entryHits(`${where}.contracts[${k}]`, x, results, problems, known));
    if (!list(c?.suites).length) problems.push(`${where}: needs \`suites\` (the suites that must run for this change)`);
    list(c?.suites).forEach((x, k) => {
      entryHits(`${where}.suites[${k}]`, x, results, problems, known);
      if (!text(x?.suite)) problems.push(`${where}.suites[${k}]: needs \`suite\``);
      // 0.7.0: `doNotRun` is no longer a restriction (named failure: it banned suites a change needed); nothing to check.
    });
    if (design.work.size) {
      const w = Array.isArray(c?.work) ? c.work : c?.work ? [c.work] : [];
      if (!w.length) problems.push(`${where}: needs \`work\` (the work items that build it, so every hit it covers maps to one)`);
      for (const x of w) if (!design.work.has(String(x))) problems.push(`${where}: unknown work item \`${x}\``);
    }
    for (const s of list(c?.covers)) {
      if (!surveyIds.has(String(s))) problems.push(`${where}: covers unknown survey entry \`${s}\``);
      covered.add(String(s));
    }
  });
  return { covered, ids };
}

function designOf(plan, criteria, work) {
  const doNotRun = plan?.doNotRun === undefined || plan?.doNotRun === null ? [] : (Array.isArray(plan.doNotRun) ? plan.doNotRun : [plan.doNotRun]).map(String).filter((d) => !/^none$/i.test(d.trim()));
  return {
    criteria: new Set((criteria ?? []).map((c) => String(c.id))),
    work: new Set((work ?? []).map((w) => String(w.id))),
    anchors: (Array.isArray(plan?.anchors) ? plan.anchors : plan?.anchors ? [plan.anchors] : []).map((a) => (typeof a === 'string' ? a : JSON.stringify(a))),
    contract: typeof plan?.contract === 'string' ? plan.contract : plan?.contract ? JSON.stringify(plan.contract) : '',
    doNotRun,
  };
}

function excludedIds(excluded, surveyIds, problems, where = 'impact.excluded') {
  const out = new Set();
  if (excluded !== undefined && !Array.isArray(excluded)) {
    problems.push(`${where} must be a list of { survey, reason }`);
    return out;
  }
  list(excluded).forEach((x, n) => {
    if (!surveyIds.has(String(x?.survey))) problems.push(`${where}[${n}]: unknown survey entry \`${x?.survey}\``);
    else if (!text(x?.reason)) problems.push(`${where}[${n}] (${x.survey}): an exclusion needs a \`reason\``);
    else out.add(String(x.survey));
  });
  return out;
}

const queriesOf = (doc) => [...list(doc?.survey?.queries), ...list(doc?.impact?.queries)];

// Validates both stages of a plan file. Returns the record kept with the frozen plan, or null when the plan has neither
// stage and none is required. Throws one refusal listing every problem.
export function validatePlanImpact(root, cfg, state, doc, { plan, criteria, work, required }) {
  const hasSurvey = doc?.survey !== undefined;
  const hasImpact = doc?.impact !== undefined;
  if (!hasSurvey && !hasImpact && !required) return null;
  const problems = [...stageOrderProblems(doc)];
  if (!hasSurvey) problems.push('the plan has a design but no `survey`: inventory what exists around the issue (components, consumers, flows, patterns, each from a recorded query) before designing');
  if (!hasImpact) problems.push('the plan has no `impact` map: for every changed symbol, endpoint, DTO, error code and migration of the design, list consumers, flows with failure paths, contracts crossed and suites that must run, and which survey entries it covers or excludes');
  const settings = impactSettings(cfg);
  const queries = queriesOf(doc);
  const known = new Set(queries.map((q) => q?.id).filter(Boolean));
  if (hasSurvey && !list(doc.survey?.queries).length) problems.push('`survey.queries` is empty: every survey list comes from a recorded query');
  const results = runAll(root, cfg, state, queries, problems, settings);
  const surveyIds = hasSurvey ? validateSurvey(doc.survey, results, known, problems) : new Set();
  let covered = new Set();
  let excluded = new Set();
  if (hasImpact) {
    if (!doc.impact || typeof doc.impact !== 'object' || Array.isArray(doc.impact)) problems.push('`impact` must be a mapping { queries, changes, excluded }');
    else {
      ({ covered } = validateChanges(doc.impact.changes, { results, known, design: designOf(plan, criteria, work), surveyIds }, problems));
      excluded = excludedIds(doc.impact.excluded, surveyIds, problems);
    }
  }
  if (hasSurvey && hasImpact) {
    const loose = [...surveyIds].filter((s) => !covered.has(s) && !excluded.has(s));
    if (loose.length) problems.push(`survey entr${loose.length === 1 ? 'y' : 'ies'} the impact map neither covers nor excludes: ${loose.join(', ')} (add it to a change's \`covers\`, or to \`impact.excluded\` with a reason)`);
  }
  if (problems.length) throw refuse(`plan refused: the impact analysis is incomplete:\n  - ${problems.join('\n  - ')}`, 'fix the plan file (or ask the planner for a corrected YAML block) and run `wf plan` again; `wf impact run --file <plan>` shows what each query returns now');
  return { survey: doc.survey, impact: doc.impact, results: summarise(results) };
}

const summarise = (results) => Object.fromEntries(Object.entries(results).map(([id, r]) => [id, { query: r.query, hits: r.hits, unit: r.unit, refs: r.refs, files: r.files, skipped: r.skipped }]));

// An amendment's impact addendum: new queries and survey entries, the changes the added scope makes, or a stated reason
// the amendment adds no element (`unchanged`).
export function validateAmendImpact(root, cfg, state, addendum, { plan, criteria, work }) {
  const problems = [];
  if (!addendum || typeof addendum !== 'object' || Array.isArray(addendum)) throw refuse('`impact` in an amendment must be a mapping { queries, survey, changes, excluded } or { unchanged: "<why the amendment adds no element>" }');
  if (text(addendum.unchanged) && !addendum.changes && !addendum.survey) return { unchanged: addendum.unchanged.trim(), results: {} };
  const queries = [...list(addendum.queries), ...list(addendum.survey?.queries)];
  const recorded = allRecordedQueries(state);
  const known = new Set([...queries.map((q) => q?.id).filter(Boolean), ...Object.keys(recorded)]);
  for (const q of queries) if (recorded[q?.id]) problems.push(`query \`${q.id}\` is already recorded; give a new id`);
  const results = { ...rerun(root, cfg, state, recorded), ...runAll(root, cfg, state, queries, problems, impactSettings(cfg)) };
  const surveyIds = addendum.survey ? validateSurvey(addendum.survey, results, known, problems) : new Set();
  const prior = new Set(SURVEY_LISTS.flatMap((k) => [...list(state.impact?.survey?.[k]), ...(state.impact?.addenda ?? []).flatMap((a) => list(a.survey?.[k]))]).map((e) => String(e.id)));
  for (const s of surveyIds) if (prior.has(s)) problems.push(`survey id \`${s}\` is already recorded`);
  const all = new Set([...prior, ...surveyIds]);
  const { covered } = validateChanges(addendum.changes, { results, known, design: designOf(plan, criteria, work), surveyIds: all }, problems);
  const excluded = excludedIds(addendum.excluded, all, problems);
  const loose = [...surveyIds].filter((s) => !covered.has(s) && !excluded.has(s));
  if (loose.length) problems.push(`survey entr${loose.length === 1 ? 'y' : 'ies'} the addendum neither covers nor excludes: ${loose.join(', ')}`);
  if (problems.length) throw refuse(`amendment refused: its impact addendum is incomplete:\n  - ${problems.join('\n  - ')}`);
  const own = Object.fromEntries(Object.entries(results).filter(([id]) => !recorded[id]));
  return { survey: addendum.survey ?? null, changes: addendum.changes, excluded: addendum.excluded ?? [], queries, results: summarise(own) };
}

// Every query recorded for the attempt: the plan's and each addendum's.
export function allRecordedQueries(state) {
  const out = {};
  for (const [id, r] of Object.entries(state.impact?.results ?? {})) out[id] = r.query;
  for (const a of state.impact?.addenda ?? []) for (const [id, r] of Object.entries(a.results ?? {})) out[id] = r.query;
  return out;
}

export function rerun(root, cfg, state, queries = allRecordedQueries(state)) {
  const out = {};
  for (const [id, q] of Object.entries(queries)) out[id] = { ...runQuery(root, cfg, state, q), query: q };
  return out;
}

// Ids the reviewer may sample: survey entries and impact changes, from the plan and every addendum.
export function inventory(state) {
  const ids = [];
  const add = (survey, changes) => {
    for (const k of SURVEY_LISTS) for (const e of list(survey?.[k])) if (e?.id) ids.push(String(e.id));
    for (const c of list(changes)) if (c?.id) ids.push(String(c.id));
  };
  add(state.impact?.survey, state.impact?.impact?.changes);
  for (const a of state.impact?.addenda ?? []) add(a.survey, a.changes);
  return [...new Set(ids)];
}

// ---- Documentation and provenance files ----

// Named failure (I-96): a ticket that committed a package of documentation (verification records, manifests and captures kept
// beside the change) had 12 such files of 500 lines counted as product code by the review division, which read them as
// unmapped integration work and turned a division into two separable flows into a single reviewer; and the symbol scan of
// the final diff took declarations out of the same files. A file is documentation when it is prose by its extension, when it
// lies in a docs folder (whatever it is: a manifest, a capture), or when the adapter lists it under its package's
// `docsOnly` (the notion the gate and the scope checks already use). Documentation is still reviewed (the integration
// reviewer is handed every such file); it is not product code, so it neither weighs on a division nor yields symbols.
// The built-in notion is the file type alone: prose formats and licence files. A folder name is not used (independent review
// of 0.7.4: `docs/` at any depth also matched `src/docs/renderer.ts` and `apps/docs/app/page.tsx`, so product code dropped
// out of the division and the symbol scan); a project names a folder of documentation assets with `docsOnly`.
const PROSE = /\.(md|mdx|markdown|rst|adoc|asciidoc)$/i;
const LEGAL = /(^|\/)(LICENSE|LICENCE|NOTICE|COPYING)(\.(md|txt))?$/;
export const isDocumentationFile = (file) => PROSE.test(file) || LEGAL.test(file);

const insidePackage = (file, dir) => dir === '.' || dir === '' || file === dir || file.startsWith(`${dir.replace(/\/$/, '')}/`);
const relativeToPackage = (file, dir) => (dir === '.' || dir === '' ? file : file.slice(dir.replace(/\/$/, '').length + 1));
// `(repo, file) => boolean` for the files an adapter's packages declare documentation-only, besides the built-in notion.
export function documentationMatcher(cfg) {
  const packages = new Map((cfg?.repos ?? []).map((r) => [r.name, (r.packages ?? []).filter((p) => p.docsOnly?.length)]));
  return (repo, file) => isDocumentationFile(file) || (packages.get(repo) ?? []).some((p) => insidePackage(file, p.path) && matchesAny(relativeToPackage(file, p.path), p.docsOnly));
}

// ---- The final diff, re-derived ----

// Symbols the final diff declares or edits inside: declarations on changed lines and the enclosing function git names
// in each hunk header. Their callers outside every file the impact map lists are what the map missed.
const DECL = [
  /\b(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function\*?|class|interface|type|enum)\s+([A-Za-z_$][\w$]{3,})/g,
  /\b(?:export\s+)(?:const|let|var)\s+([A-Za-z_$][\w$]{3,})/g,
  /^\s*(?:async\s+)?def\s+([A-Za-z_]\w{3,})/g,
  /^\s*class\s+([A-Za-z_]\w{3,})/g,
];
function symbolsIn(line) {
  const out = [];
  for (const re of DECL) for (const m of line.matchAll(new RegExp(re.source, re.flags))) out.push(m[1]);
  return out;
}

export function deriveFromDiff(root, cfg, state, { limit = 100, queryResults = null } = {}) {
  const symbols = new Map();
  // Named failure: equal symbol names hid declaration origins and the 200-symbol cap was silently reported complete.
  // This remains textual discovery, not an import graph or proof that a matching file is a real consumer.
  const addSymbol = (symbol, origin) => {
    if (!symbols.has(symbol)) symbols.set(symbol, new Set());
    symbols.get(symbol).add(origin);
  };
  const changed = new Set();
  // Named failure (I-96): declarations in documentation files are not product declarations (see isDocumentationFile).
  // (The adapter at the base is read for its `docsOnly`; where it cannot be read here the scan below says so itself, so only the
  // built-in notion applies until then.)
  let documentation;
  try {
    documentation = documentationMatcher(trustedConfig(root, cfg, state));
  } catch {
    documentation = documentationMatcher(null);
  }
  for (const [name, r] of Object.entries(state.repos ?? {})) {
    const base = git(r.worktree, ['merge-base', r.baseRef ?? r.base, 'HEAD'], { allowFail: true }) || r.base;
    for (const f of git(r.worktree, ['diff', '--name-only', base, 'HEAD']).split('\n').filter(Boolean)) changed.add(`${name}:${f}`);
    const diff = git(r.worktree, ['diff', '-U0', '--no-color', base, 'HEAD'], { allowFail: true }) ?? '';
    let oldFile = null, newFile = null;
    for (const line of diff.split('\n')) {
      // Named failure: deleted declarations were attributed to /dev/null; renames lost the removed-side origin.
      if (line.startsWith('diff --git ')) { oldFile = null; newFile = null; }
      else if (line.startsWith('--- ')) oldFile = line.slice(4) === '/dev/null' ? null : line.slice(4).replace(/^a\//, '');
      else if (line.startsWith('+++ ')) newFile = line.slice(4) === '/dev/null' ? null : line.slice(4).replace(/^b\//, '');
      else if (line.startsWith('@@')) {
        const file = newFile ?? oldFile;
        if (file && !documentation(name, file)) for (const s of symbolsIn(line.replace(/^@@[^@]*@@/, ''))) addSymbol(s, `${name}:${file}`);
      } else if (line.startsWith('+') || line.startsWith('-')) {
        const file = line.startsWith('+') ? newFile : oldFile;
        if (file && !documentation(name, file)) for (const s of symbolsIn(line.slice(1))) addSymbol(s, `${name}:${file}`);
      }
    }
  }
  const mapped = new Set();
  // A handoff already computed these results on its prepared tree; closure recording still performs a fresh rerun.
  for (const r of Object.values(queryResults ?? rerun(root, cfg, state))) for (const f of r.files) mapped.add(f);
  for (const k of SURVEY_LISTS) for (const e of [...list(state.impact?.survey?.[k]), ...(state.impact?.addenda ?? []).flatMap((a) => list(a.survey?.[k]))]) if (e?.file) mapped.add(String(e.file));
  const outside = [];
  let total = 0;
  const found = [...symbols].slice(0, 200);
  if (found.length) {
    // One read of every repo for all symbols (the scan cap does not apply: this is the engine's own derivation).
    const any = new RegExp(`(?<![\\w$])(${found.map(([x]) => x.replace(/\$/g, '\\$')).join('|')})(?![\\w$])`, 'g');
    const from = new Map(found.map(([symbol, origins]) => [symbol, [...origins]]));
    const uses = new Map();
    scanTrees(root, cfg, state, { names: Object.keys(state.repos ?? {}), settings: { ...impactSettings(cfg), maxFileBytes: Infinity, maxScanBytes: Infinity }, what: 'the derived callers' }, (file, text) => {
      for (const line of text) for (const m of line.matchAll(any)) uses.set(`${m[1]}\0${file}`, [m[1], file]);
    });
    for (const [symbol, f] of uses.values()) {
      if (changed.has(f) || mapped.has(f) || mapped.has(f.slice(f.indexOf(':') + 1))) continue;
      // The adapter folder names components and patterns; it is workflow configuration, not a caller.
      if (/(^|\/)\.workflow\//.test(f.slice(f.indexOf(':') + 1))) continue;
      total += 1;
      if (outside.length < limit) outside.push({ symbol, declaredIn: from.get(symbol)[0], declarationOrigins: from.get(symbol), originAmbiguous: from.get(symbol).length > 1, matchKind: 'textual', file: f });
    }
  }
  const symbolsTruncated = symbols.size > found.length;
  return { mode: 'textual', extraction: 'regex-diff-and-hunk', resolvedReferences: false,
    structuralCoverage: 'unsupported',
    limitations: ['Only regex-recognized declarations and hunk names are extracted; this is not a count of all changed declarations.', 'Comments, strings and unrelated equal names can match; imports, aliases, members, dynamic registration and generated relationships are not structurally resolved.'],
    totalSymbols: symbols.size, analyzedSymbols: found.length, symbolsTruncated,
    incomplete: symbolsTruncated || total > outside.length,
    declarationOrigins: Object.fromEntries(found.map(([symbol, origins]) => [symbol, [...origins]])),
    symbols: found.map(([symbol]) => symbol), outside, total, truncated: total > outside.length };
}

// ---- The reviewer's closure ----

// Named failure (0.7.0): the reviewer-side checks refused closures on shape, not substance: a sample of at least ten
// inventory entries, a verdict per derived caller, a hit count restated for every query. Reviewers filled the shapes and
// the real misses (a consumer the map did not list) were still found by reading. Impact completeness stays a planner-side
// fact (`wf plan` re-runs every query and refuses a count that does not match); the reviewer reports what the map missed
// as a finding with `category: impact-gap` and may record what it checked, in any shape, under `impactChecked`.
export function impactCheckProblems() {
  return [];
}

// ---- Fix rounds: pattern sweeps (I-25) ----
//
// Named failure (I-25): fix briefs targeted single findings, so the same defect pattern recurred over many review rounds
// (an empty later page, a failed Next, raw enum codes). A fix handoff now carries a sweep per open finding: a structured
// query for other instances, run by the engine; the implementer answers each in a commit trailer and the next reviewer
// sees the sweep, its hits then and now, and the answer.

// Named failure (0.7.0): a sweep was answered hit by hit. Eleven findings produced 1,059 sweep hits and 431 changed
// files, because every hit read as an instance to edit and the reviewer sampled them again. Findings that share a
// `family` now share one sweep, and the sweep is answered by one mechanical proof: a command (a query, a lint rule, a
// test) and the result it must give, which the reviewer re-runs. `fixed` and `clean` answers remain for a finding that
// has no family.
const SWEEP_ACK = /^Sweep (S\d+): (fixed|clean|proof)\s*[-:\u2014]\s*(\S.*)$/;
const PROOF = /^(\S.*?)\s*=>\s*(\S.*)$/;
const familyKey = (f) => (text(f.family) || `${f.round}:${f.id}`);

export function readSweepFile(file) {
  const raw = fs.readFileSync(path.resolve(String(file)), 'utf8');
  return { raw, doc: String(file).endsWith('.json') ? JSON.parse(raw) : YAML.parse(raw) };
}

export function buildSweeps(root, cfg, state, doc, { owed, startAt }) {
  const entries = Array.isArray(doc?.sweeps) ? doc.sweeps : Array.isArray(doc) ? doc : null;
  if (!entries?.length) throw refuse('the sweep file needs `sweeps: [{ finding: "<round>:<id>" or family: "<family>", query: { pattern, kind, repo, paths, exclude } }]`', 'one sweep per family; a finding with no family is its own', { id: 'sweep:empty' });
  const problems = [];
  const out = [];
  const ref = (f) => `${f.round}:${f.id}`;
  entries.forEach((s, n) => {
    const where = `sweeps[${n}]`;
    const named = text(s?.finding), fam = text(s?.family);
    const member = named ? owed.find((f) => ref(f) === named) : null;
    const group = fam ? owed.filter((f) => text(f.family) === fam) : member ? owed.filter((f) => familyKey(f) === familyKey(member)) : [];
    if (!named && !fam) problems.push(`${where}: names no \`finding\` (\`<reviewer>:<id>\`) or \`family\``);
    else if (!group.length) problems.push(`${where}: \`${named || fam}\` is not an open finding or family (open: ${owed.map(ref).join(', ') || 'none'})`);
    const q = { ...(s?.query ?? {}), id: `S${startAt + out.length}` };
    const qp = [];
    validateQuery(q, cfg, qp);
    problems.push(...qp.map((p) => `${where}: ${p}`));
    if (!qp.length && group.length) {
      const r = runQuery(root, cfg, state, q);
      out.push({ id: q.id, finding: ref(group[0]), findings: group.map(ref), family: text(group[0].family) || null, why: text(s?.why) || null, query: { ...s.query }, hits: r.hits, files: r.files });
    }
  });
  // A sweep is optional (0.7.0): a file that names some families is accepted; the others are answered by the implementer's
  // proof in its report (refusal audit of 0.7.0).
  if (problems.length) throw refuse(`fix handoff refused: the pattern sweep is incomplete:\n  - ${problems.join('\n  - ')}`, null, { id: 'sweep:incomplete' });
  return out;
}

// Each handed sweep's commit-trailer answer, or its absence. A sweep with a family is answered by a proof
// (`Sweep S1: proof - <command> => <expected result>`); `sinceReview` leaves out the sweeps of fix passes the last review
// has already judged (the reviewer is handed this fix pass, not the attempt's history).
export function sweepAnswers(state, { sinceReview = false } = {}) {
  const lastReview = sinceReview ? state.reviews?.at(-1)?.at ?? null : null;
  const handed = state.handoffs.filter((h) => h.role === 'implementer' && (!lastReview || h.at > lastReview)).flatMap((h) => h.sweeps ?? []);
  const found = new Map();
  for (const [name, r] of Object.entries(state.repos)) {
    if (!r.worktree || !fs.existsSync(r.worktree)) continue;
    const log = git(r.worktree, ['log', '--format=%H%n%B%n--wf-end--', `${r.base}..HEAD`], { allowFail: true }) ?? '';
    for (const chunk of log.split('--wf-end--')) {
      const lines = chunk.trim().split('\n');
      for (const line of lines.slice(1)) {
        const m = SWEEP_ACK.exec(line.trim());
        if (!m || found.has(m[1])) continue;
        const proof = m[2] === 'proof' ? PROOF.exec(m[3].trim()) : null;
        if (m[2] === 'proof' && !proof) continue;
        found.set(m[1], { answer: m[2], line: m[3].trim(), repo: name, commit: lines[0], ...(proof ? { command: proof[1].trim(), expected: proof[2].trim() } : {}) });
      }
    }
  }
  const accepted = (s) => { const a = found.get(s.id); return Boolean(a) && (!s.family || a.answer === 'proof'); };
  return { handed, answers: handed.map((s) => ({ ...s, answer: found.get(s.id) ?? null })), missing: handed.filter((s) => !accepted(s)).map((s) => s.id) };
}

// ---- Restrictions the diff has outgrown (I-25) ----
//
// Named failure: a plan's doNotRun banned one repo's suites ("no source changes there"); the ticket later changed that
// repo, the ban stayed, and a stale public-API test reached review that the banned suite would have caught.
export function staleRestrictions(cfg, state, changed) {
  const plan = state.plan ?? {};
  const restrictions = [
    ...(plan.externalServices ? [{ kind: 'externalServices', text: typeof plan.externalServices === 'string' ? plan.externalServices : JSON.stringify(plan.externalServices) }] : []),
  ];
  const touched = Object.entries(changed).filter(([, files]) => files.length).map(([r]) => r);
  const steps = (cfg.gate?.steps ?? []).filter((s) => touched.includes(s.repo));
  const out = [];
  const word = (w) => new RegExp(`(^|[^\\w-])${String(w).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^\\w-]|$)`, 'i');
  for (const r of restrictions) {
    for (const repo of touched) if (word(repo).test(r.text)) out.push({ ...r, names: repo, why: `this attempt now changes repo ${repo}` });
    for (const s of steps) if (word(s.id).test(r.text) && !out.some((o) => o.text === r.text && o.names === s.id)) out.push({ ...r, names: s.id, why: `this attempt changes ${s.repo}, which step ${s.id} tests` });
  }
  return out;
}

export const staleRestrictionLines = (list) => list.map((s) => `plan ${s.kind} "${s.text}" names ${s.names}, but ${s.why}: amend the plan restriction (\`wf criteria amend\`) or confirm it still holds`);
