// The tracker (design 0.8, sections 2 and 5; stream 3). The project brings its tracker; the plugin ships only the
// generic files tracker (adapters/tracker/files.mjs) and names no vendor.
//
// `ticketing.via` says who performs an operation:
//   module     the engine calls the tracker module's TrackerDriver (`ticketing.tracker: { module: { repo, path } }`);
//   files      the engine calls the built-in files tracker (`<root>/tickets/<id>.md`);
//   connector  the owner agent performs the operation through its host's connector, in the words of
//              `ticketing.operations` (merged over the module's own `operations` export when the tracker is a module),
//              and the engine reads the result back from the owner's transcript (D68): a tool call whose input carries
//              the operation's marker (or, for a status, the item and the status);
//   none       no tracker.
// Every write carries an idempotency marker (`wf:<attempt>:<stage>`), and the engine searches for it before writing.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import { WfError, attemptDir, attemptState, callerSession, connectorCalls, loadAdapter, marker, userDir } from './contract.mjs';
import { filesTracker } from '../adapters/tracker/files.mjs';

// Ids become folder and branch names: the same allowlist as the files tracker.
const SAFE_ID = /^[A-Za-z0-9_](?:[A-Za-z0-9_.-]{0,62}[A-Za-z0-9_])?$/;
const BUILTIN = { files: (root) => filesTracker(root) };

// The generic words for a connector operation the adapter gives none for.
const GENERIC = {
  read: 'Read the issue, with its status and labels.',
  search: 'Search the tracker.',
  fileFollowUp: 'Search the tracker for the marker first; when no issue carries it, create one issue with this title and body.',
  setStatus: 'Set the issue\'s status.',
  comment: 'Search the issue\'s comments for the marker first; when none carries it, add this comment.',
  mergeRequest: 'Open a merge request.',
};

export const gitEnv = (env = process.env) => ({ ...env, GIT_NO_REPLACE_OBJECTS: '1', GIT_GRAFT_FILE: '/dev/null' });
export function git(cwd, args, { allowFail = false, input } = {}) {
  const r = spawnSync('git', args, { cwd, env: gitEnv(), encoding: 'utf8', input, maxBuffer: 256 * 1024 * 1024 });
  if (r.error) throw new WfError(`git failed to start in ${cwd}: ${r.error.message}`);
  if (r.status !== 0 && !allowFail) throw new WfError(`git ${args.join(' ')} failed (exit ${r.status}) in ${cwd}: ${(r.stderr || r.stdout).trim()}`);
  return allowFail ? r : r.stdout.trim();
}

// A project module `{ repo, path }`, loaded only as committed at the repo's fetched base, never from an attempt's
// worktree or the checkout's working files: a ticket cannot change the code that decides its own delivery (mark itself
// merged, skip a confirmation, write to the tracker). A ticket's change to a module ships through delivery and takes
// effect after it lands. The committed bytes are copied to a content-addressed cache in the user folder and imported
// from there, so the import is exactly what the base holds. `attempt` is accepted for the call sites and not used.
const fetchedBases = new Set();
export function baseRefOf(dir, spec) {
  const remote = spec.remote ?? 'origin';
  if (!git(dir, ['remote']).split('\n').includes(remote)) return spec.base;
  const key = `${dir}\0${remote}\0${spec.base}`;
  if (!fetchedBases.has(key)) {
    git(dir, ['fetch', '--quiet', remote, `+refs/heads/${spec.base}:refs/remotes/${remote}/${spec.base}`], { allowFail: true });
    fetchedBases.add(key);
  }
  return `${remote}/${spec.base}`;
}
export async function loadModule(root, adapter, ref, attempt = null) { // eslint-disable-line no-unused-vars
  const spec = adapter.repos.find((r) => r.name === ref?.repo);
  if (!spec) throw new WfError(`module ${JSON.stringify(ref)}: no repo named \`${ref?.repo}\` in the adapter`);
  const rel = path.posix.normalize(String(ref.path ?? '').replaceAll('\\', '/'));
  if (!rel || rel.startsWith('../') || rel === '..' || path.posix.isAbsolute(rel)) throw new WfError(`module ${ref.repo}/${ref.path}: the path must be inside the repo`);
  const dir = path.join(root, spec.path);
  const baseRef = baseRefOf(dir, spec);
  const shown = git(dir, ['show', `${baseRef}:${rel}`], { allowFail: true });
  if (shown.status !== 0) throw new WfError(`module ${ref.repo}/${rel} is not committed on ${baseRef}: project modules are loaded only as the base holds them`);
  const bytes = shown.stdout;
  const cache = path.join(userDir(), 'modules');
  fs.mkdirSync(cache, { recursive: true });
  const file = path.join(cache, `${crypto.createHash('sha256').update(bytes).digest('hex')}.mjs`);
  if (!fs.existsSync(file)) {
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, bytes);
    fs.renameSync(tmp, file);
  }
  return import(pathToFileURL(file).href);
}

/**
 * The project's tracker: { via, driver, operations, normalise }. driver: the TrackerDriver the engine calls (module and
 * files), else null. operations: the words for the owner (connector).
 */
export async function trackerOf(root, adapter, { attempt = null } = {}) {
  const t = adapter.ticketing ?? {};
  const via = t.via ?? 'none';
  let mod = null;
  if (t.tracker && typeof t.tracker === 'object' && t.tracker.module) mod = await loadModule(root, adapter, t.tracker.module, attempt);
  let driver = null;
  if (mod) {
    const d = mod.default;
    driver = typeof d === 'function' ? await d({ root, adapter }) : d ?? null;
  } else if (typeof t.tracker === 'string') {
    if (!BUILTIN[t.tracker]) throw new WfError(`ticketing.tracker \`${t.tracker}\` is not a built-in tracker (built in: ${Object.keys(BUILTIN).join(', ')}); a project brings its own as { module: { repo, path } }`);
    driver = BUILTIN[t.tracker](root);
  } else if (via === 'files') driver = BUILTIN.files(root);
  const operations = { ...(mod?.operations ?? driver?.operations ?? {}), ...(t.operations ?? {}) };
  const normalise = typeof driver?.normalise === 'function' ? (raw) => driver.normalise(raw) : null;
  if (via === 'module' || via === 'files') {
    if (!driver) throw new WfError(`ticketing.via is ${via} but no tracker driver was found (ticketing.tracker: ${JSON.stringify(t.tracker ?? null)})`);
    return { via, driver, operations, normalise };
  }
  return { via, driver: null, operations, normalise: via === 'connector' ? normalise : null };
}

// The words for one connector operation: the adapter's own first (D68), else the generic ones.
export const wordsFor = (tr, op) => tr.operations?.[op] ?? GENERIC[op];

// The owner session whose transcript holds connector calls: the attempt's owner, else the session running wf.
async function sessionFor(root, attempt) {
  let s = null;
  if (attempt) {
    try {
      s = (await attemptState(root, attempt)).owner ?? null;
    } catch {}
  }
  return s ?? (await callerSession(process.env));
}

/**
 * A connector operation: done when a tool call in the owner's transcript carries `match` (every string in it, in the
 * call's input), else pending with the adapter's words. Tool names are matched by suffix; the empty suffix reads every
 * call, since the adapter names connectors, not tool names.
 */
export async function connectorStep(root, attempt, { op, tr, match, details = {}, mark = null }) {
  const session = await sessionFor(root, attempt);
  if (session) {
    const calls = await connectorCalls(session, ['']);
    const want = [].concat(match).filter(Boolean).map(String);
    const found = want.length ? calls.find((c) => {
      const input = JSON.stringify(c.input ?? {});
      return want.every((w) => input.includes(w) || input.includes(JSON.stringify(w).slice(1, -1)));
    }) : null;
    if (found) return { state: 'done', value: found };
  }
  return { state: 'pending', operation: wordsFor(tr, op), marker: mark, details };
}

// A tracker id pattern without its anchors, to find ids inside a URL or a tool result.
const unanchored = (p) => p.replace(/^\^/, '').replace(/\$$/, '');
const idsIn = (text, pattern) => (pattern ? [...String(text ?? '').matchAll(new RegExp(unanchored(pattern), 'g'))].map((m) => m[0]) : []);

// The generic normalisation, with no tracker: the raw id trimmed, then upper- and lower-cased, then each id the pattern
// finds inside it (a tracker URL); the first that matches the whole pattern. No pattern: the trimmed id.
function genericId(raw, pattern) {
  const s = String(raw ?? '').trim();
  if (!pattern) return SAFE_ID.test(s) ? s : null;
  const re = new RegExp(pattern);
  const found = idsIn(s, pattern);
  const candidates = [s, s.toUpperCase(), s.toLowerCase(), ...found, ...found.map((x) => x.toUpperCase()), ...found.map((x) => x.toLowerCase())];
  return candidates.find((c) => re.test(c)) ?? null;
}

// The tracker's spelling of an item, without a tracker read: the driver's normalise, else the generic one.
export async function canonicalItem(root, adapter, raw, tr = null) {
  tr ??= await trackerOf(root, adapter);
  const pattern = adapter.ticketing?.idPattern ?? null;
  let id = null;
  if (tr.normalise) {
    try {
      id = await tr.normalise(String(raw).trim());
    } catch {
      id = null;
    }
  }
  if (id && pattern && !new RegExp(pattern).test(id)) id = null;
  return id ?? genericId(raw, pattern);
}

// The items earlier attempts used: attempt folders (`<item>.<n>`, 0.7 and 0.8) and branches `wf/<item>.<n>` in every repo.
function priorItems(root, adapter) {
  const items = new Set();
  const add = (id) => {
    const m = /^(.+)\.(\d+)$/.exec(id);
    if (m) items.add(m[1]);
  };
  const dir = path.join(root, '.wf-evidence', 'attempts');
  if (fs.existsSync(dir)) for (const n of fs.readdirSync(dir)) add(n);
  for (const r of adapter.repos ?? []) {
    const repoDir = path.join(root, r.path);
    if (!fs.existsSync(repoDir)) continue;
    const out = git(repoDir, ['for-each-ref', '--format=%(refname)', 'refs/heads/wf/', 'refs/remotes/'], { allowFail: true });
    for (const ref of String(out.stdout ?? '').split('\n')) {
      const m = /^refs\/(?:heads|remotes\/[^/]+)\/wf\/(.+)$/.exec(ref.trim());
      if (m) add(m[1]);
    }
  }
  return [...items].sort();
}

/**
 * The tracker's canonical id for a raw item (contract normaliseId). One item reached by different raw ids resolves to one
 * id; when earlier attempts (their ledgers or branches) spelled the same item differently, that spelling is returned,
 * so attempt numbers continue and no second folder of the same name differing in case is made. `canonical` is the
 * tracker's spelling; tracker calls use it.
 */
export async function normaliseId(root, raw) {
  const adapter = await loadAdapter(root);
  const pattern = adapter.ticketing?.idPattern ?? null;
  if (!String(raw ?? '').trim()) throw new WfError('an item id is needed');
  const tr = await trackerOf(root, adapter);
  const canonical = await canonicalItem(root, adapter, raw, tr);
  if (!canonical) throw new WfError(`\`${String(raw).slice(0, 80)}\` is not an item id of this project${pattern ? ` (ticketing.idPattern: ${pattern})` : ''}`);
  if (!SAFE_ID.test(canonical)) throw new WfError(`\`${canonical.slice(0, 80)}\` cannot name an attempt: letters, digits, -, _ and inner dots only, at most 64`);
  let item = canonical;
  for (const prior of priorItems(root, adapter)) {
    if (prior !== canonical && (await canonicalItem(root, adapter, prior, tr)) === canonical) {
      item = prior;
      break;
    }
  }
  let verified = false;
  if (tr.driver) {
    let issue;
    try {
      issue = await tr.driver.read(canonical);
    } catch {
      issue = undefined; // unreachable: not verified, not refused
    }
    if (issue === null) throw new WfError(`no item ${canonical} in the tracker`);
    verified = issue !== undefined;
  }
  return { item, verified, canonical };
}

/** Search the tracker (contract search): open issues by text, or anything carrying a marker. */
export async function search(root, q = {}, { attempt = null } = {}) {
  const adapter = await loadAdapter(root);
  const tr = await trackerOf(root, adapter, { attempt });
  if (tr.via === 'none') return { state: 'done', value: [] };
  if (tr.driver) return { state: 'done', value: await tr.driver.search(q) };
  const what = q.marker ?? q.text;
  const r = await connectorStep(root, attempt, { op: 'search', tr, match: what, mark: q.marker ?? null, details: q });
  if (r.state !== 'done') return r;
  // Through a connector the engine reads only ids from the result; their labels are unknown (null, never empty).
  const ids = [...new Set(idsIn(r.value.result, adapter.ticketing?.idPattern))];
  return { state: 'done', value: ids.map((id) => ({ id, title: null, status: null, labels: null, url: null })) };
}

const titleOf = (f) => String(f.what ?? '').split('\n')[0].trim().slice(0, 120) || `Finding ${f.id}`;

/**
 * File one `other` finding per `ticketing.followUps` (contract fileFollowUp). Opt-in: only mode `file` files. The team,
 * status and label come from the adapter; the item's own labels are never copied. Searches the marker first (already
 * filed), then open issues with the same title (a duplicate), then creates.
 */
export async function fileFollowUp(root, attempt, finding) {
  const adapter = await loadAdapter(root);
  const fu = adapter.ticketing?.followUps ?? { mode: 'off' };
  if (fu.mode !== 'file') return { state: 'done', value: null };
  const tr = await trackerOf(root, adapter, { attempt });
  if (tr.via === 'none') throw new WfError('ticketing.followUps.mode is file, but the project has no tracker (ticketing.via: none)');
  const state = await attemptState(root, attempt);
  const m = marker(attempt, `finding:${finding.id}`);
  const title = titleOf(finding);
  const body = [
    finding.what,
    '',
    `Why it matters: ${finding.why}`,
    `Where: ${finding.location}`,
    `Severity: ${finding.severity}`,
    `Found in review while working on ${state.item}; outside that work.`,
    '',
    m,
  ].join('\n');
  const fields = { title, body, ...(fu.team ? { team: fu.team } : {}), ...(fu.status ? { status: fu.status } : {}), ...(fu.label ? { label: fu.label } : {}), marker: m };
  if (tr.driver) {
    const filed = await tr.driver.search({ marker: m });
    if (filed.length) return { state: 'done', value: { id: filed[0].id, duplicateOf: null } };
    const same = (await tr.driver.search({ text: title })).find((i) => i.title === title);
    if (same) return { state: 'done', value: { id: null, duplicateOf: same.id } };
    const { id } = await tr.driver.create(fields);
    return { state: 'done', value: { id, duplicateOf: null } };
  }
  const dir = path.join(attemptDir(root, attempt), 'followups');
  fs.mkdirSync(dir, { recursive: true });
  const bodyFile = path.join(dir, `${finding.id}.md`);
  fs.writeFileSync(bodyFile, `${body}\n`);
  const r = await connectorStep(root, attempt, { op: 'fileFollowUp', tr, match: m, mark: m, details: { ...fields, body: undefined, bodyFile } });
  if (r.state !== 'done') return r;
  const item = await canonicalItem(root, adapter, state.item, tr);
  const id = idsIn(r.value.result, adapter.ticketing?.idPattern).find((x) => x !== item) ?? null;
  return { state: 'done', value: { id, duplicateOf: null } };
}

export const implements08 = { normaliseId, search, fileFollowUp };
