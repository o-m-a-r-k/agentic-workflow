// Learning and the budget against regrowth (design-0.8 section 8).
//
// Named failure: the old plugin added a rule after each incident and grew to 90 decisions and more than 300 refusals,
// none of them measured. In 0.8 every change of shape is a proposal judged against the telemetry rows:
//   - `wf learn` drafts only when a metric leaves its baseline band (median ± spread over the project's last 8 tickets);
//     an incident only once it recurs; a rule the person gives is a proposal with `source: person` (no drafting, the
//     same fields).
//   - The engine sets the minimum move from the baseline spread; the drafter never chooses a number.
//   - One active proposal per metric per project; one plugin proposal per release.
//   - Judged after 8 tickets or 21 days, whichever is later: kept when the metric moved by the minimum and the guard
//     held, reverted otherwise, and reverted on missing data. Kept expires after 90 days and is judged again; reverted
//     cannot come back for 60 days.
//   - Project proposals apply and revert automatically, change only what roles read (D19: `learned/<project>.md` in the
//     user folder), and count against the adapter budget. Plugin proposals go to the maintainer.
// The release script calls `checkRelease`: the five rule-shaped counts of the plugin tree against budget.json.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { CONTRACT_VERSION, WfError, adapterBudget, loadAdapter, userDir } from './contract.mjs';
import { nowMs } from './ledger.mjs';
import { REPORT_METRICS, emptyRow, median, metricValue, projectName, projectRows } from './telemetry.mjs';
import { matchesAny } from './util.mjs';

// The design's numbers (section 8). They are the person's accepted policy, not engine tuning.
export const BASELINE_N = 8;
const JUDGE_TICKETS = 8;
const JUDGE_DAYS = 21;
const KEEP_DAYS = 90;
const BLOCK_DAYS = 60;
const DAY = 86400000;

const SOURCES = ['telemetry', 'incident', 'person'];
const SCOPES = ['project', 'plugin'];
const DIRECTIONS = ['down', 'up'];
// Live: an experiment still to be judged (an expired one is being judged again). Applied: what roles read and what
// counts against the adapter budget. A replaced proposal is neither.
const LIVE = ['proposed', 'active', 'expired'];
const isLive = (p) => LIVE.includes(p.status) && !p.replacedBy;
const isApplied = (p) => ['active', 'kept', 'expired'].includes(p.status) && !p.replacedBy;
const iso = (ms) => new Date(ms).toISOString();

// ---------------------------------------------------------------------------------------------------------------------
// Storage: snapshots appended per change, the last snapshot of an id wins.
// ---------------------------------------------------------------------------------------------------------------------

export const proposalsFile = (project) => path.join(userDir(), 'proposals', `${project}.jsonl`);
export const pluginProposalsFile = () => path.join(userDir(), 'plugin-proposals.jsonl');
export const incidentsFile = (project) => path.join(userDir(), 'incidents', `${project}.jsonl`);
export const learnedFile = (project) => path.join(userDir(), 'learned', `${project}.md`);

function readJsonl(file) {
  let text = '';
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  return text.split('\n').filter(Boolean).flatMap((l) => {
    try {
      return [JSON.parse(l)];
    } catch {
      return [];
    }
  });
}
function appendJsonl(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(value)}\n`);
}
function latest(file) {
  const by = new Map();
  for (const p of readJsonl(file)) by.set(p.id, p);
  return [...by.values()];
}
const fileOf = (p) => (p.scope === 'plugin' ? pluginProposalsFile() : proposalsFile(p.project));
const save = (p) => appendJsonl(fileOf(p), p);

// What roles read: the change of every active or kept project proposal (D19). Rewritten on every apply and revert.
function writeLearned(project) {
  const live = latest(proposalsFile(project)).filter(isApplied);
  const file = learnedFile(project);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, live.length ? live.map((p) => `- ${p.change} (${p.id}, ${p.metric})`).join('\n') + '\n' : '');
}

// ---------------------------------------------------------------------------------------------------------------------
// Baselines
// ---------------------------------------------------------------------------------------------------------------------

// Spread: the median absolute deviation, so one outlier ticket does not widen the band.
export function baselineOf(values) {
  const v = values.filter((x) => typeof x === 'number' && Number.isFinite(x));
  if (!v.length) return { median: null, spread: null, n: 0 };
  const m = median(v);
  return { median: m, spread: median(v.map((x) => Math.abs(x - m))), n: v.length };
}

// The newest ticket's value against the band of the 8 tickets before it. null: fewer than 9 tickets hold the metric.
export function bandExit(rows, metric) {
  const vals = rows.map((r) => metricValue(r, metric)).filter((x) => x !== null);
  if (vals.length < BASELINE_N + 1) return null;
  const baseline = baselineOf(vals.slice(-(BASELINE_N + 1), -1));
  const value = vals.at(-1);
  const out = value > baseline.median + baseline.spread || value < baseline.median - baseline.spread;
  return { metric, value, baseline, out, direction: value > baseline.median ? 'down' : 'up' };
}

const ROW_FIELDS = new Set(Object.keys(emptyRow()));
const isRowField = (m) => typeof m === 'string' && ROW_FIELDS.has(m.split('.')[0]) && !['schema', 'project', 'item', 'attempt', 'engine', 'outcome', 'start', 'end'].includes(m.split('.')[0]);

async function rowsFor(root) {
  if (root) return (await projectRows(root)).rows;
  // Plugin proposals with no project: every project's stored rows.
  const dir = path.join(userDir(), 'telemetry');
  let files = [];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
  } catch {
    files = [];
  }
  return files.flatMap((f) => readJsonl(path.join(dir, f))).sort((a, b) => Date.parse(a.end) - Date.parse(b.end));
}

const normalise = (s) => String(s ?? '').trim().replace(/\s+/g, ' ').toLowerCase();

function validAdds(adds) {
  if (adds === undefined) return null;
  if (!adds || typeof adds !== 'object') return '`adds` must be an object';
  for (const k of ['refusals', 'commands', 'events', 'adapterKeys']) if (adds[k] !== undefined && !(Array.isArray(adds[k]) && adds[k].every((x) => typeof x === 'string'))) return `\`adds.${k}\` must be a list of names`;
  if (adds.words !== undefined && !(Number.isInteger(adds.words) && adds.words >= 0)) return '`adds.words` must be a whole number';
  return null;
}

// ---------------------------------------------------------------------------------------------------------------------
// Incidents
// ---------------------------------------------------------------------------------------------------------------------

/** Record one incident under a key the owner chooses for the same failure. It becomes a proposal only once it recurs. */
export async function recordIncident(root, key, what) {
  if (!key || !what) throw new WfError('an incident needs a key and what happened');
  const { name } = await projectName(root);
  appendJsonl(incidentsFile(name), { at: iso(nowMs()), key: String(key), what: String(what) });
  return readJsonl(incidentsFile(name)).filter((i) => i.key === String(key)).length;
}
const incidentCount = (project, key) => readJsonl(incidentsFile(project)).filter((i) => i.key === key).length;

// ---------------------------------------------------------------------------------------------------------------------
// propose and judge
// ---------------------------------------------------------------------------------------------------------------------

/** Record a proposal. Refuses (WfError) every rule above that the draft breaks. */
export async function propose(root, draft) {
  const d = draft ?? {};
  const problems = [];
  if (!SOURCES.includes(d.source)) problems.push(`source must be one of ${SOURCES.join(', ')}`);
  if (!SCOPES.includes(d.scope)) problems.push(`scope must be one of ${SCOPES.join(', ')}`);
  if (Object.hasOwn(d, 'whyNotReplace')) problems.push('`whyNotReplace` was removed: name what the change replaces in `replaces`');
  for (const k of ['change', 'replaces']) if (typeof d[k] !== 'string' || !d[k].trim()) problems.push(`\`${k}\` is required`);
  for (const k of ['metric', 'guard']) if (!isRowField(d[k])) problems.push(`\`${k}\` must be a telemetry row field (${d[k] ?? 'missing'})`);
  if (!d.expires || !Number.isFinite(Date.parse(d.expires))) problems.push('`expires` must be a date');
  for (const k of ['direction', 'guardDirection']) if (d[k] !== undefined && !DIRECTIONS.includes(d[k])) problems.push(`\`${k}\` must be down or up`);
  const addsProblem = validAdds(d.adds);
  if (addsProblem) problems.push(addsProblem);
  if (d.scope === 'project' && !root) problems.push('a project proposal needs the project');
  if (problems.length) throw new WfError(`proposal refused:\n  - ${problems.join('\n  - ')}`);

  const now = nowMs();
  const project = root ? (await projectName(root)).name : null;
  const rows = await rowsFor(root);
  const metricVals = rows.map((r) => metricValue(r, d.metric)).filter((x) => x !== null);
  let baseline = baselineOf(metricVals.slice(-BASELINE_N));
  let direction = d.direction ?? 'down';
  if (d.source === 'telemetry') {
    const exit = bandExit(rows, d.metric);
    if (!exit) throw new WfError(`proposal refused: ${d.metric} has no baseline band yet (${metricVals.length} ticket(s) hold it; a band needs ${BASELINE_N} before the newest)`);
    if (!exit.out) throw new WfError(`proposal refused: ${d.metric} is inside its band (${exit.value} against ${exit.baseline.median} ± ${exit.baseline.spread}); a telemetry proposal is drafted only when a metric leaves it`);
    baseline = exit.baseline;
    direction = d.direction ?? exit.direction;
  }
  let occurrences = null;
  if (d.source === 'incident') {
    occurrences = project && d.incident ? incidentCount(project, String(d.incident)) : Array.isArray(d.occurrences) ? d.occurrences.length : 0;
    if (occurrences < 2) throw new WfError(`proposal refused: an incident becomes a proposal only once it recurs (${occurrences} recorded${d.incident ? ` under \`${d.incident}\`` : ''})`);
  }

  const scopeList = latest(d.scope === 'plugin' ? pluginProposalsFile() : proposalsFile(project));
  if (d.scope === 'project') {
    const live = scopeList.find((p) => p.metric === d.metric && isLive(p));
    if (live) throw new WfError(`proposal refused: ${live.id} is already active on ${d.metric}; one active proposal per metric per project`);
  } else {
    const same = scopeList.find((p) => p.release === CONTRACT_VERSION && p.status !== 'reverted');
    if (same) throw new WfError(`proposal refused: ${same.id} is this release's plugin proposal (${CONTRACT_VERSION}); one plugin proposal per release`);
  }
  const blocked = scopeList.find((p) => p.status === 'reverted' && p.metric === d.metric && normalise(p.change) === normalise(d.change) && Date.parse(p.blockedUntil) > now);
  if (blocked) throw new WfError(`proposal refused: the same change was reverted as ${blocked.id}; it cannot be proposed again before ${blocked.blockedUntil}`);

  // Project proposals count against the adapter budget: a net increase must replace an active one.
  let replacing = null;
  if (d.scope === 'project') {
    const liveCount = scopeList.filter(isApplied).length;
    replacing = scopeList.find((p) => p.id === d.replaces.trim() && isApplied(p)) ?? null;
    let budget = null;
    try {
      budget = await adapterBudget(await loadAdapter(root));
    } catch (error) {
      throw new WfError(`proposal refused: the adapter budget cannot be read (${error.message})`);
    }
    const used = budget.counts.rules + liveCount + (replacing ? 0 : 1);
    if (used > budget.limits.rules) throw new WfError(`proposal refused: over the adapter budget (${budget.counts.rules} rule(s) and ${liveCount} active proposal(s) against ${budget.limits.rules}); replace an active proposal by naming its id in \`replaces\``);
  }

  const guardVals = rows.map((r) => metricValue(r, d.guard)).filter((x) => x !== null);
  const id = `P${scopeList.reduce((m, p) => Math.max(m, Number(/^P(\d+)$/.exec(p.id)?.[1] ?? 0)), 0) + 1}`;
  const p = {
    id, source: d.source, scope: d.scope, project: d.scope === 'plugin' ? null : project,
    change: d.change.trim(), replaces: d.replaces.trim(), metric: d.metric, guard: d.guard,
    direction, guardDirection: d.guardDirection ?? 'down',
    minMove: baseline.spread, baseline, guardBaseline: baselineOf(guardVals.slice(-BASELINE_N)),
    created: iso(now), expires: new Date(Date.parse(d.expires)).toISOString(),
    status: d.scope === 'project' ? 'active' : 'proposed', judgeFrom: iso(now), release: CONTRACT_VERSION,
    ...(d.adds ? { adds: d.adds } : {}), ...(d.incident ? { incident: String(d.incident) } : {}), ...(occurrences !== null ? { occurrences } : {}),
  };
  if (replacing) save({ ...replacing, status: 'expired', replacedBy: id, endedAt: iso(now) });
  save(p);
  if (p.scope === 'project') writeLearned(project);
  return p;
}

function findProposal(project, id) {
  const own = project ? latest(proposalsFile(project)).find((p) => p.id === id) : null;
  return own ?? latest(pluginProposalsFile()).find((p) => p.id === id) ?? null;
}

/** Judge one proposal. */
export async function judge(root, id, { now } = {}) {
  const at = now ? Date.parse(now) : nowMs();
  const project = root ? (await projectName(root)).name : null;
  let p = findProposal(project, id);
  if (!p) throw new WfError(`no proposal ${id}`);
  if (p.status === 'kept') {
    if (at < Date.parse(p.expires)) return { verdict: 'not-yet', reason: `kept until ${p.expires}` };
    p = { ...p, status: 'expired', judgeFrom: p.expires };
    save(p);
  }
  if (p.replacedBy) return { verdict: 'not-yet', reason: `${id} was replaced by ${p.replacedBy}` };
  if (!['active', 'expired'].includes(p.status)) return { verdict: 'not-yet', reason: `${id} is ${p.status}${p.status === 'proposed' ? ' (a plugin proposal waits for the maintainer to apply it)' : ''}` };
  const from = Date.parse(p.judgeFrom ?? p.created);
  const rows = (await rowsFor(root)).filter((r) => Date.parse(r.end) > from);
  const days = (at - from) / DAY;
  if (rows.length < JUDGE_TICKETS || days < JUDGE_DAYS) return { verdict: 'not-yet', reason: `${rows.length} of ${JUDGE_TICKETS} tickets and ${Math.floor(days)} of ${JUDGE_DAYS} days since ${p.judgeFrom}` };

  const decide = (verdict, reason, extra = {}) => {
    const next = verdict === 'kept'
      ? { ...p, ...extra, status: 'kept', keptAt: iso(at), expires: iso(at + KEEP_DAYS * DAY), reason }
      : { ...p, ...extra, status: 'reverted', revertedAt: iso(at), blockedUntil: iso(at + BLOCK_DAYS * DAY), reason };
    save(next);
    if (next.scope === 'project') writeLearned(next.project);
    return { verdict, reason };
  };
  const vals = rows.map((r) => metricValue(r, p.metric)).filter((x) => x !== null);
  const gvals = rows.map((r) => metricValue(r, p.guard)).filter((x) => x !== null);
  if (p.baseline?.median == null || p.minMove == null) return decide('reverted', `missing data: ${p.metric} had no baseline`);
  if (vals.length < JUDGE_TICKETS) return decide('reverted', `missing data: ${vals.length} of ${rows.length} tickets hold ${p.metric}`);
  if (p.guardBaseline?.median == null) return decide('reverted', `missing data: ${p.guard} had no baseline`);
  if (gvals.length < JUDGE_TICKETS) return decide('reverted', `missing data: ${gvals.length} of ${rows.length} tickets hold ${p.guard}`);
  const after = median(vals);
  const guardAfter = median(gvals);
  const moved = p.direction === 'down' ? p.baseline.median - after : after - p.baseline.median;
  const movedEnough = p.minMove > 0 ? moved >= p.minMove : moved > 0;
  const gb = p.guardBaseline;
  const held = p.guardDirection === 'down' ? guardAfter <= gb.median + gb.spread : guardAfter >= gb.median - gb.spread;
  const facts = `${p.metric} ${p.baseline.median} → ${after} (minimum move ${p.minMove} ${p.direction}); ${p.guard} ${gb.median} → ${guardAfter} (band ± ${gb.spread})`;
  const extra = { result: { after, guardAfter, tickets: rows.length } };
  if (!movedEnough) return decide('reverted', `the metric did not move by the minimum: ${facts}`, extra);
  if (!held) return decide('reverted', `the guard did not hold: ${facts}`, extra);
  return decide('kept', facts, extra);
}

// ---------------------------------------------------------------------------------------------------------------------
// wf learn
// ---------------------------------------------------------------------------------------------------------------------

const flag = (args, k) => {
  const v = args?.flags?.[k];
  return Array.isArray(v) ? v.at(-1) : v;
};

/** `wf learn`: judge what is due, list band exits and recurring incidents for drafting; `--propose <file>` records a
 * draft (JSON), `--judge <id>` judges one, `--incident <key> --what "<words>"` records an incident, `--plugin` prints the
 * plugin proposals for the maintainer. */
export async function cmdLearn(ctx, args = { _: [], flags: {} }) {
  const root = ctx?.root ?? null;
  const proposeFile = flag(args, 'propose');
  if (proposeFile) {
    if (proposeFile === true) throw new WfError('--propose needs a file holding the draft as JSON');
    let draft;
    try {
      draft = JSON.parse(fs.readFileSync(path.resolve(ctx.cwd ?? '.', proposeFile), 'utf8'));
    } catch (error) {
      throw new WfError(`cannot read the draft ${proposeFile}: ${error.message}`);
    }
    const p = await propose(root, draft);
    return { text: `${p.id} ${p.status}: ${p.change}\n  metric ${p.metric} (baseline ${p.baseline.median} ± ${p.baseline.spread}, minimum move ${p.minMove} ${p.direction}), guard ${p.guard}`, data: { proposal: p } };
  }
  const judgeId = flag(args, 'judge');
  if (judgeId) {
    if (judgeId === true) throw new WfError('--judge needs a proposal id');
    const v = await judge(root, String(judgeId));
    return { text: `${judgeId}: ${v.verdict} (${v.reason})`, data: v };
  }
  const incident = flag(args, 'incident');
  if (incident) {
    const what = flag(args, 'what');
    if (incident === true || !what || what === true) throw new WfError('--incident needs a key and --what "<what happened>"');
    if (!root) throw new WfError('an incident belongs to a project: run wf learn inside one');
    const n = await recordIncident(root, incident, what);
    return { text: `incident ${incident}: ${n} occurrence(s)${n >= 2 ? '; it recurs, so it may be drafted as a proposal (source incident)' : ''}`, data: { key: incident, occurrences: n } };
  }
  if (flag(args, 'plugin')) {
    const list = latest(pluginProposalsFile());
    return { text: list.length ? list.map((p) => `${p.id} ${p.status} ${p.release}: ${p.change} (replaces ${p.replaces}; ${p.metric}, guard ${p.guard})`).join('\n') : 'no plugin proposals', data: { proposals: list } };
  }

  if (!root) throw new WfError('no project here: run wf learn inside a project');
  const { project, rows } = await projectRows(root);
  const lines = [];
  const judged = [];
  for (const p of latest(proposalsFile(project)).filter(isApplied)) {
    const v = await judge(root, p.id);
    judged.push({ id: p.id, ...v });
    lines.push(`${p.id} (${p.metric}): ${v.verdict}, ${v.reason}`);
  }
  const all = latest(proposalsFile(project));
  const exits = [];
  for (const m of REPORT_METRICS) {
    const e = bandExit(rows, m);
    if (!e?.out) continue;
    const live = all.find((p) => p.metric === m && isLive(p));
    exits.push({ ...e, minMove: e.baseline.spread, active: live?.id ?? null });
  }
  const proposedIncidents = new Set(all.map((p) => p.incident).filter(Boolean));
  const counts = new Map();
  for (const i of readJsonl(incidentsFile(project))) counts.set(i.key, (counts.get(i.key) ?? 0) + 1);
  const recurring = [...counts].filter(([k, n]) => n >= 2 && !proposedIncidents.has(k)).map(([key, occurrences]) => ({ key, occurrences }));
  if (exits.length) lines.push('', 'metrics outside their band (draft a proposal for one without an active proposal):', ...exits.map((e) => `  ${e.metric}: ${e.value} against ${e.baseline.median} ± ${e.baseline.spread}${e.active ? ` (active: ${e.active})` : ''}`));
  if (recurring.length) lines.push('', 'recurring incidents:', ...recurring.map((r) => `  ${r.key}: ${r.occurrences} times`));
  if (!lines.length) lines.push(`${project}: ${rows.length} ticket(s); nothing to judge, no metric outside its band`);
  return { text: lines.join('\n').trim(), data: { project, judged, exits, recurring } };
}

// ---------------------------------------------------------------------------------------------------------------------
// The release check (scripts/release.mjs calls it; stream 8 owns the script)
// ---------------------------------------------------------------------------------------------------------------------

const KINDS = ['refusals', 'commands', 'events', 'adapterKeys'];
const SKIP_DIRS = new Set(['.git', 'node_modules', 'vendor']);

function walk(dir, base = dir, out = []) {
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) walk(path.join(dir, e.name), base, out);
    } else if (e.isFile()) out.push(path.relative(base, path.join(dir, e.name)).split(path.sep).join('/'));
  }
  return out;
}

const countWords = (s) => String(s).split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;

// The words a text says: all of a prose file; for code and JSON (hooks), only what its string literals say.
export function textWords(file, text) {
  if (!/\.(m?js|cjs|json)$/.test(file)) return countWords(text);
  let words = 0;
  const s = String(text);
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '/' && s[i + 1] === '/') {
      i = s.indexOf('\n', i);
      if (i < 0) break;
    } else if (c === '/' && s[i + 1] === '*') {
      i = s.indexOf('*/', i + 2);
      if (i < 0) break;
      i++;
    } else if (c === '"' || c === "'" || c === '`') {
      let j = i + 1;
      let lit = '';
      while (j < s.length && s[j] !== c) {
        if (s[j] === '\\') {
          lit += ' ';
          j += 2;
          continue;
        }
        lit += s[j++];
      }
      words += countWords(lit.replace(/\$\{[^}]*\}/g, ' '));
      i = j;
    }
  }
  return words;
}

/** The five rule-shaped counts of a plugin tree. `adapterKeys` comes from config.mjs's ADAPTER_KEYS export (stream 6),
 * or from the caller; null when neither has it. */
export async function countRuleShapes(pluginRoot, budget, { adapterKeys } = {}) {
  const contractFile = path.join(pluginRoot, 'engine', 'contract.mjs');
  const c = await import(`${pathToFileURL(contractFile).href}?count=${Date.now()}`);
  let keys = adapterKeys ?? null;
  const configFile = path.join(pluginRoot, 'engine', 'config.mjs');
  if (!keys && fs.existsSync(configFile) && fs.readFileSync(configFile, 'utf8').includes('ADAPTER_KEYS')) {
    const m = await import(`${pathToFileURL(configFile).href}?count=${Date.now()}`);
    if (Array.isArray(m.ADAPTER_KEYS)) keys = [...m.ADAPTER_KEYS];
  }
  const globs = budget?.words?.texts ?? [];
  const texts = {};
  for (const f of walk(pluginRoot)) if (matchesAny(f, globs)) texts[f] = textWords(f, fs.readFileSync(path.join(pluginRoot, f), 'utf8'));
  return {
    refusals: Object.keys(c.REFUSALS),
    commands: Object.keys(c.COMMANDS),
    events: Object.keys(c.EVENTS),
    adapterKeys: keys,
    words: { total: Object.values(texts).reduce((a, b) => a + b, 0), texts },
  };
}

/** What a change of counts adds and removes, by name (lists) and by total (words). Rule-shaped: it adds any of the five. */
export function classifyRuleShapes(before, after) {
  const out = { ruleShaped: false };
  for (const k of KINDS) {
    const b = before?.[k];
    const a = after?.[k];
    if (!Array.isArray(a) || !Array.isArray(b)) {
      out[k] = null;
      continue;
    }
    const added = a.filter((x) => !b.includes(x));
    const removed = b.filter((x) => !a.includes(x));
    out[k] = { added, removed, net: added.length - removed.length };
    if (added.length) out.ruleShaped = true;
  }
  const bw = typeof before?.words === 'number' ? before.words : before?.words?.total ?? 0;
  const aw = typeof after?.words === 'number' ? after.words : after?.words?.total ?? 0;
  out.words = { before: bw, after: aw, net: aw - bw };
  if (aw > bw) out.ruleShaped = true;
  return out;
}

const ROLE_TEXTS = ['templates/agents/**', 'skills/**/SKILL.md'];

/** The release check: the tree's five counts against budget.json. Any net increase fails unless a kept or active plugin
 * proposal accounts for it (its `adds`); a role text over `words.roleMax` fails; an uncounted kind fails.
 * proposals: plugin proposals (default: none). Returns { ok, counts, classification, problems }. */
export async function checkRelease({ pluginRoot, budget, proposals = [], adapterKeys } = {}) {
  if (!pluginRoot) throw new WfError('checkRelease needs the plugin root');
  const b = budget ?? JSON.parse(fs.readFileSync(path.join(pluginRoot, 'budget.json'), 'utf8'));
  const counts = await countRuleShapes(pluginRoot, b, { adapterKeys });
  const classification = classifyRuleShapes({ ...b, words: b.words?.total ?? 0 }, { ...counts, words: counts.words.total });
  const accounting = proposals.filter((p) => p.scope === 'plugin' && (p.status === 'kept' || p.status === 'active') && p.adds);
  const problems = [];
  for (const k of KINDS) {
    const c = classification[k];
    if (!c) {
      problems.push(`${k}: not counted (${counts[k] === null ? 'the tree does not list them' : 'budget.json does not list them'})`);
      continue;
    }
    if (c.net <= 0) continue;
    const covered = new Set(accounting.flatMap((p) => p.adds[k] ?? []));
    const uncovered = c.added.filter((x) => !covered.has(x));
    if (uncovered.length) problems.push(`${k}: ${c.net} more than budget.json (${c.added.join(', ')} added${c.removed.length ? `; ${c.removed.join(', ')} removed` : ''}); no kept or active proposal accounts for ${uncovered.join(', ')}`);
  }
  const coveredWords = accounting.reduce((s, p) => s + (p.adds.words ?? 0), 0);
  if (classification.words.net > coveredWords) problems.push(`words: ${classification.words.after} against ${classification.words.before} in budget.json (+${classification.words.net}; proposals account for ${coveredWords})`);
  const roleMax = b.words?.roleMax;
  if (roleMax) for (const [f, n] of Object.entries(counts.words.texts)) if (matchesAny(f, ROLE_TEXTS) && n > roleMax) problems.push(`${f}: ${n} words, over the ${roleMax}-word role limit`);
  return { ok: problems.length === 0, counts, classification, problems };
}

export const implements08 = { propose, judge, cmdLearn };
