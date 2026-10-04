import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { adapterFileAtCommit } from './config.mjs';
import { append, attemptDir, loadState } from './ledger.mjs';
import { WfError, hashFile, readJson, refuse, writeImmutable } from './util.mjs';

const BUILTIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'adapters', 'tracker');

// Project adapters are loaded as committed at the attempt's base, so a ticket cannot change how it is checked.
export async function loadTrackerAdapter(root, cfg, baseCommit) {
  const kind = cfg.tracker.kind;
  if (kind === 'none') return null;
  const file = kind.startsWith('.') ? (baseCommit ? adapterFileAtCommit(root, cfg, baseCommit, kind) : path.resolve(root, '.workflow', kind)) : path.join(BUILTIN, `${kind}.mjs`);
  if (!fs.existsSync(file)) throw new WfError(`tracker adapter \`${kind}\` not found at ${file}`);
  return (await import(pathToFileURL(file).href)).default;
}

const DEFAULT_EVENTS = {
  admitted: ['read', { setStatus: 'started' }],
  implementing: ['read', { setStatus: 'started' }],
  integrating: [{ setStatus: 'inReview' }, { comment: 'reviewComment' }],
  delivered: [{ comment: 'deliveredComment' }, { attach: 'screenshots' }, { setStatus: 'delivered' }, 'readback'],
  reopened: [{ setStatus: 'started' }],
};

function renderTemplate(root, cfg, key, vars) {
  const ref = cfg.tracker[key];
  if (!ref) return null;
  const file = path.resolve(root, '.workflow', ref);
  const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : String(ref);
  return { template: text, body: text.replace(/\{(\w+)\}/g, (m, k) => (vars[k] ?? m)) };
}

export function uatScope(state) {
  return (state.criteria ?? []).filter((c) => c.uat !== false).map((c) => `- ${c.uat ?? c.text}`).join('\n');
}

// Turns an engine event into the concrete actions the agent (or adapter) must perform.
export function trackerActions(root, cfg, state, event, extra = {}) {
  if (cfg.tracker.kind === 'none') return [];
  const spec = cfg.tracker.events?.[event] ?? DEFAULT_EVENTS[event] ?? [];
  const statuses = cfg.tracker.statuses ?? {};
  const vars = { id: state.item, uatScope: uatScope(state), url: extra.url ?? '', ...extra };
  const actions = [];
  for (const step of spec) {
    if (step === 'read') actions.push({ op: 'read', what: 'issue with all comments, attachments and status history' });
    else if (step === 'readback') actions.push({ op: 'readback', what: 'issue status, the comment and attachments, saved as one capture' });
    else if (step.setStatus) {
      const name = statuses[step.setStatus];
      if (!name) continue;
      const startEvent = ['admitted', 'implementing'].includes(event);
      actions.push({ op: 'setStatus', key: step.setStatus, status: name, unless: startEvent ? [statuses.done].filter(Boolean) : [] });
    } else if (step.comment) {
      const rendered = renderTemplate(root, cfg, step.comment, vars);
      if (rendered) actions.push({ op: 'comment', templateKey: step.comment, body: rendered.body, reuseExisting: true });
    } else if (step.attach === 'screenshots') {
      const shots = extra.screenshots ?? [];
      if (shots.length) actions.push({ op: 'attach', files: shots });
    }
  }
  return actions;
}

export function emitTrackerEvent(root, cfg, id, event, extra = {}) {
  const state = loadState(root, id);
  const actions = trackerActions(root, cfg, state, event, extra);
  if (actions.length) append(root, id, 'tracker.pending', { event, actions }, null);
  return actions;
}

// Internals that do not belong in a product-facing comment. URLs are removed first, so links never trip these.
const DEFAULT_FORBID = [
  { name: 'source file path', re: /(?<![\w/.-])[\w.-]+\/[\w./-]*\.(?:[cm]?[jt]sx?|php|py|go|java|kt|swift|rb|cs|vue|rs|scala|sql)\b/i },
  { name: 'commit hash', re: /(?<![\w-])[0-9a-f]{12,40}(?![\w-])/ },
  { name: 'evidence hash', re: /\bsha256[:=]/i },
];

function forbidden(cfg, rawBody) {
  const body = rawBody.replace(/\bhttps?:\/\/\S+/g, ' ');
  const hits = [];
  for (const f of DEFAULT_FORBID) if (f.re.test(body)) hits.push(f.name);
  for (const pattern of cfg.tracker.commentRules?.forbid ?? []) {
    let re;
    try {
      re = new RegExp(pattern, 'i');
    } catch {
      re = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    }
    if (re.test(body)) hits.push(pattern);
  }
  return hits;
}

// Fixed (non-placeholder) lines of the template must appear in the posted comment.
function fixedLines(template) {
  return template.split('\n').map((l) => l.trim()).filter((l) => l && !/\{\w+\}/.test(l));
}

export async function recordTracker(root, cfg, state, options) {
  if (cfg.tracker.kind === 'none') throw refuse('this project has no tracker (`tracker.kind: none`)');
  const event = options.event;
  if (!event) throw new WfError('--event is required');
  const pending = state.tracker.pending.filter((a) => a.event === event);
  if (!pending.length) throw refuse(`no pending tracker actions for event \`${event}\``);
  if (!options.capture) throw new WfError('--capture <file> is required: the raw tracker response the agent saved');
  const adapter = await loadTrackerAdapter(root, cfg, state.adapterBase);
  const raw = readJson(path.resolve(String(options.capture)));
  const issue = adapter.normalize(raw);
  const problems = [];
  if (issue.id !== state.item) problems.push(`capture is for ${issue.id}, not ${state.item}`);
  for (const a of pending) {
    if (a.op === 'setStatus') {
      const ok = [a.status, ...(a.unless ?? [])];
      if (!ok.includes(issue.status)) problems.push(`status is \`${issue.status}\`, expected \`${a.status}\``);
    }
    if (a.op === 'comment') {
      const since = event === 'delivered' ? state.delivery.completedAt : null;
      const tpl = renderTemplate(root, cfg, a.templateKey, {});
      const lines = fixedLines(tpl?.template ?? a.body);
      const match = issue.comments.find((c) => lines.every((l) => c.body.includes(l)) && (!since || (c.updatedAt ?? c.createdAt) >= since));
      if (!match) problems.push(`no comment ${since ? 'written after delivery ' : ''}containing the template's fixed lines: ${lines.map((l) => JSON.stringify(l)).join(', ')}`);
      else {
        const hits = forbidden(cfg, match.body);
        if (hits.length) problems.push(`comment contains internals: ${hits.join(', ')}`);
        if (event === 'delivered' && uatScope(state) && !/\n\s*[-*]\s+\S/.test(match.body)) problems.push('comment has no UAT scope bullets');
      }
    }
    if (a.op === 'attach') {
      for (const f of a.files) {
        const name = path.basename(f.path);
        const hit = issue.attachments.find((x) => x.title === name || x.filename === name);
        if (!hit) problems.push(`screenshot ${name} is not attached (attachment title must equal the file name)`);
      }
    }
  }
  if (problems.length) throw refuse(`tracker readback for \`${event}\` failed:\n  - ${problems.join('\n  - ')}`);
  const dest = path.join(attemptDir(root, state.id), 'tracker', `${event}-capture.json`);
  writeImmutable(dest, fs.readFileSync(path.resolve(String(options.capture)), 'utf8'));
  append(root, state.id, 'tracker.recorded', { event, capture: { path: dest, sha256: hashFile(dest) }, status: issue.status }, null);
  return loadState(root, state.id);
}
