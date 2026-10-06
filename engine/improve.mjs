// Plugin improvements: findings about the workflow itself (named correction: a "plugin lesson" is not a project lesson,
// it is a change the plugin's maintainer makes in the plugin repo). They are kept in a user-level inbox outside every
// repo (`~/.agentic-workflow/improvements/<id>.yaml`, or WF_IMPROVEMENTS_DIR), sanitised of project names, ticket ids,
// paths, emails and URLs (the owner's quote is kept verbatim in that user-level file only), worked from a plugin
// maintainer session, and closed only with the scenario test that reproduces the failure; closing writes a generic
// history entry into the plugin repo (`improvements/<id>.md`). Nothing is posted anywhere.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readRegular, writeNoFollow } from './evidence.mjs';
import { canonical, isInside, touchesEvidence } from './paths.mjs';
import { WfError, YAML, now, refuse } from './util.mjs';

export const CLASSES = ['engine', 'template', 'skill', 'guard', 'tracker', 'onboarding', 'docs', 'other'];
export const IMPROVEMENT_ID = /^I-\d{1,6}$/;
const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const inboxDir = () => path.resolve(process.env.WF_IMPROVEMENTS_DIR ?? path.join(os.homedir(), '.agentic-workflow', 'improvements'));
// The plugin repo a close writes its history into: this plugin's own checkout (a git repo), or WF_PLUGIN_REPO.
export const pluginRepo = () => path.resolve(process.env.WF_PLUGIN_REPO ?? PLUGIN_ROOT);

function checkedInbox({ create = false } = {}) {
  const dir = inboxDir();
  if (touchesEvidence(dir)) throw refuse(`${dir} is inside a project's evidence; the inbox lives outside every repo`);
  const st = fs.lstatSync(dir, { throwIfNoEntry: false });
  if (st && !st.isDirectory()) throw refuse(`${dir} is ${st.isSymbolicLink() ? 'a symlink' : 'not a folder'}; the inbox is not read or written through it`);
  if (!st && create) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

// The same stripper as the plugin repo's privacy rules: project and repo names (when a project is known), ticket ids,
// emails, URLs, absolute and home paths.
export function sanitizer(names = []) {
  const esc = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const list = [...new Set(names.filter((x) => x && x.length > 2))].sort((a, b) => b.length - a.length);
  const nameRe = list.length ? new RegExp(`\\b(?:${list.map(esc).join('|')})\\b`, 'gi') : null;
  return (text) => {
    let t = String(text ?? '');
    t = t.replace(/\bhttps?:\/\/\S+/g, '<url>').replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '<email>').replace(/(?:~|\/(?:Users|home|private|var|tmp|opt|mnt|srv))\/\S*/g, '<path>');
    t = t.replace(/\b[A-Z][A-Z0-9]+-\d+(?:\.\d+)?\b/g, '<ticket>');
    if (nameRe) t = t.replace(nameRe, '<project>');
    return t;
  };
}

export function loadImprovements() {
  const dir = checkedInbox();
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const id = e.name.replace(/\.yaml$/, '');
    if (!e.name.endsWith('.yaml') || !IMPROVEMENT_ID.test(id) || !e.isFile()) continue;
    const r = readRegular(path.join(dir, e.name));
    if (!r) continue;
    try {
      const x = YAML.parse(r.bytes.toString('utf8')) ?? {};
      if (x.id === undefined || x.id === id) out.push({ ...x, id, recurrence: Number(x.recurrence ?? 0), file: path.join(dir, e.name) });
    } catch {}
  }
  return out.sort((a, b) => Number(a.id.slice(2)) - Number(b.id.slice(2)));
}

const words = (t) => new Set(String(t ?? '').toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2));
const similar = (a, b) => {
  const x = words(a);
  const y = words(b);
  if (!x.size || !y.size) return 0;
  return [...x].filter((w) => y.has(w)).length / new Set([...x, ...y]).size;
};

function save(item, { create = false } = {}) {
  const dir = checkedInbox({ create: true });
  if (!IMPROVEMENT_ID.test(item.id)) throw refuse(`invalid improvement id ${item.id}`);
  const file = path.join(dir, `${item.id}.yaml`);
  const { file: _f, ...rest } = item;
  writeNoFollow(file, YAML.stringify(rest), { exclusive: create, mode: 0o600 });
  return file;
}

// `wf improve add`: sanitised title and description, the owner's words verbatim (inbox only). A new item matching a
// closed one (same class and a similar title, or `--regression-of I-n`) is a regression: flagged, and it outranks
// everything not regressed.
export function addImprovement(options, names = []) {
  const scrub = sanitizer(names);
  const title = String(options.title ?? '').trim();
  const what = String(options.what ?? '').trim();
  const cls = String(options.class ?? '');
  const problems = [];
  if (!title) problems.push('--title says in one line what should change in the workflow');
  if (!what) problems.push('--what says what happened');
  if (!CLASSES.includes(cls)) problems.push(`--class is one of ${CLASSES.join(', ')}`);
  if (problems.length) throw new WfError(`improvement not recorded:\n  - ${problems.join('\n  - ')}`);
  const all = loadImprovements();
  const history = pluginHistoryIds();
  const n = Math.max(0, ...[...all.map((x) => x.id), ...history].map((id) => Number(/^I-(\d+)$/.exec(id)?.[1] ?? 0))) + 1;
  const explicit = options['regression-of'] ? all.find((x) => x.id === String(options['regression-of'])) : null;
  if (options['regression-of'] && !explicit) throw refuse(`no improvement ${options['regression-of']} in the inbox`);
  const of = explicit ?? all.filter((x) => x.status === 'closed' && x.class === cls && similar(x.title, scrub(title)) >= 0.5).sort((a, b) => similar(b.title, title) - similar(a.title, title))[0] ?? null;
  const item = {
    id: `I-${n}`,
    title: scrub(title),
    what: scrub(what),
    class: cls,
    observedIn: options['observed-in'] ? scrub(String(options['observed-in'])) : null,
    quote: options.quote ? String(options.quote) : null,
    status: 'open',
    recurrence: of ? Number(of.recurrence ?? 0) + 1 : 0,
    regressionOf: of ? { id: of.id, fixedIn: of.version ?? null } : null,
    created: now(),
  };
  const file = save(item, { create: true });
  return { item, file };
}

// Open items, highest priority first: recurrence (regressions), then age.
export const nextImprovements = () => loadImprovements().filter((x) => x.status !== 'closed').sort((a, b) => b.recurrence - a.recurrence || String(a.created).localeCompare(String(b.created)));

function pluginHistoryIds() {
  const dir = path.join(pluginRepo(), 'improvements');
  try {
    return fs.readdirSync(dir).filter((f) => /^I-\d+\.md$/.test(f)).map((f) => f.replace(/\.md$/, ''));
  } catch {
    return [];
  }
}

// `wf improve close <id> --version X --test scenarios/<file>.test.mjs [--name "<test name>"] --fix "..."`: only with
// the scenario test, which must exist in the plugin repo (and contain the named test). Writes the generic history entry.
export function closeImprovement(id, options) {
  if (!IMPROVEMENT_ID.test(String(id ?? ''))) throw new WfError('usage: wf improve close I-<n> --version X --test scenarios/<file>.test.mjs --fix "what changed" [--name "<test name>"] [--commit SHA]');
  const item = loadImprovements().find((x) => x.id === id);
  if (!item) throw refuse(`no improvement ${id} in the inbox`);
  if (item.status === 'closed') throw refuse(`${id} is already closed (${item.version})`);
  const repo = pluginRepo();
  if (!fs.existsSync(path.join(repo, '.git'))) throw refuse(`${repo} is not the plugin repo checkout; run this from it (or set WF_PLUGIN_REPO)`);
  const version = String(options.version ?? '').trim();
  const test = String(options.test ?? '').trim();
  const fix = String(options.fix ?? '').trim();
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new WfError('--version is the plugin release that fixes it (x.y.z)');
  if (!fix) throw new WfError('--fix says in one line what changed');
  if (!/^scenarios\/[A-Za-z0-9._-]+\.test\.mjs$/.test(test)) throw new WfError('--test names the scenario test that reproduces the failure: scenarios/<file>.test.mjs');
  const testFile = path.join(repo, test);
  if (!isInside(canonical(testFile), canonical(path.join(repo, 'scenarios')))) throw refuse(`${test} is not inside the plugin's scenarios/`);
  const r = readRegular(testFile);
  if (!r) throw refuse(`${test} does not exist in the plugin repo (${repo}); a fix closes with the scenario test that reproduces the failure`);
  if (options.name && !r.bytes.toString('utf8').includes(String(options.name))) throw refuse(`${test} has no test named "${options.name}"`);
  const scrub = sanitizer();
  const entry = `# ${id}: ${scrub(item.title)}\n\n- **Class:** ${item.class}\n- **Fixed in:** ${version}\n- **Test:** \`${test}\`${options.name ? ` (${scrub(options.name)})` : ''}\n${options.commit ? `- **Commit:** ${String(options.commit).slice(0, 40)}\n` : ''}${item.regressionOf ? `- **Regression of:** ${item.regressionOf.id}${item.regressionOf.fixedIn ? ` (fixed in ${item.regressionOf.fixedIn})` : ''}\n` : ''}\n## Failure\n\n${scrub(item.what)}\n\n## Fix\n\n${scrub(fix)}\n`;
  const histDir = path.join(repo, 'improvements');
  fs.mkdirSync(histDir, { recursive: true });
  const hist = path.join(histDir, `${id}.md`);
  writeNoFollow(hist, entry, { exclusive: true });
  save({ ...item, status: 'closed', version, test, fix: scrub(fix), commit: options.commit ?? null, closed: now() });
  return { id, history: hist };
}

export const openCount = () => {
  try {
    return loadImprovements().filter((x) => x.status !== 'closed').length;
  } catch {
    return 0;
  }
};
