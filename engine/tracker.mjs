import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { adapterFileAtCommit } from './config.mjs';
import { append, attemptDir, listAttempts, loadState } from './ledger.mjs';
import { loadCatalog, readSecret } from './secrets.mjs';
import { WfError, hashFile, now, readJson, refuse, writeImmutable } from './util.mjs';

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
      // The delivered set: each file uploaded (never a link) as an attachment titled `title`, its subtitle the caption
      // the owner gives it in `wf shown`.
      const shots = extra.screenshots ?? [];
      if (shots.length) actions.push({ op: 'attach', files: shots.map((f) => ({ path: f.path, sha256: f.sha256, source: f.source ?? null, title: f.title ?? path.basename(f.path) })) });
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
  const capturePath = path.resolve(String(options.capture));
  const raw = readJson(capturePath);
  const issue = adapter.normalize(raw);
  const problems = [];
  const verified = [];
  if (issue.id !== state.item) problems.push(`capture is for ${issue.id}, not ${state.item}`);
  // A hand-written capture without the issue body was accepted, and every later role then read the ticket without
  // its description. Some issues are title-only: the capture says so with "descriptionEmpty": true.
  if (event === 'admitted' && !String(issue.description ?? '').trim() && raw?.descriptionEmpty !== true) {
    problems.push('the capture has no issue description; save the raw tracker response unchanged (the whole get_issue JSON), or, if the issue really has no description, add "descriptionEmpty": true to the capture');
  }
  // A capture byte-identical to one recorded for another attempt, or for another event of this one, was accepted:
  // it was recycled, not read. `implementing` is exempt within its attempt: re-reading an unchanged issue gives the
  // same bytes as the admission read.
  const sha = hashFile(capturePath);
  for (const id of listAttempts(root)) {
    const other = id === state.id ? state : loadState(root, id);
    const hit = other.tracker.done.find((d) => d.capture?.sha256 === sha && (id !== state.id || (d.event !== event && event !== 'implementing')));
    if (hit) problems.push(`the capture is byte-identical to the one recorded for ${id === state.id ? `event \`${hit.event}\`` : `${id} (${hit.event})`}; read the issue again now and save that raw response`);
  }
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
      // Every delivered screenshot must be on the issue as an uploaded file (the adapter's `isUpload` tells an upload
      // from a link), titled with its name and subtitled with the caption the owner recorded in `wf shown`. Named
      // failures: a link attachment passed as "attached"; a reopened ticket's earlier upload with the same file name
      // satisfied a title-only check. Verified from the readback: title, upload, subtitle. Trusted: that the uploaded
      // bytes are the file (the tracker returns no hash of them).
      // An attempt delivered before 0.1.11 has no recorded set and no captions: its uploads are checked by title only.
      const shown = state.delivery.shown;
      if (state.delivery.screenshots && (!shown || shown.none)) problems.push(`the ${a.files.length} delivered screenshot(s) were not shown to the owner yet: show each in the chat with its caption, then \`wf shown --file <f>\`; the attachments' subtitles are those captions`);
      if (typeof adapter.isUpload !== 'function') problems.push(`the \`${cfg.tracker.kind}\` tracker adapter has no \`isUpload(attachment)\`, so an uploaded file cannot be told from a link; add it to the adapter`);
      else {
        const missing = [];
        for (const f of a.files) {
          const title = f.title ?? path.basename(f.path);
          const caption = shown?.screenshots?.find((x) => x.sha256 === f.sha256)?.caption ?? null;
          const named = issue.attachments.filter((x) => x.title === title || x.filename === title);
          const uploads = named.filter((x) => adapter.isUpload(x));
          const exact = caption ? uploads.filter((x) => String(x.subtitle ?? '').trim() === caption) : uploads;
          if (!named.length) missing.push(`${title} (${f.path}): no attachment with this title`);
          else if (!uploads.length) missing.push(`${title} (${f.path}): attached as a link, not an uploaded file (${named[0].url ?? 'no url in the capture'})`);
          else if (!exact.length) missing.push(`${title} (${f.path}): uploaded, but no attachment of it has the subtitle "${caption}" (an earlier attempt's file with the same name does not count)`);
          else verified.push({ title, sha256: f.sha256, attachment: exact[0].id ?? null, caption });
        }
        if (missing.length) problems.push(`${missing.length} of ${a.files.length} delivered screenshot(s) not attached to ${state.item} as uploaded files (title = the name below, subtitle = its caption):\n    - ${missing.join('\n    - ')}`);
      }
    }
  }
  if (problems.length) throw refuse(`tracker readback for \`${event}\` failed:\n  - ${problems.join('\n  - ')}`);
  const dest = path.join(attemptDir(root, state.id), 'tracker', `${event}-capture.json`);
  writeImmutable(dest, fs.readFileSync(path.resolve(String(options.capture)), 'utf8'));
  append(root, state.id, 'tracker.recorded', { event, capture: { path: dest, sha256: hashFile(dest) }, status: issue.status, ...(verified.length ? { attachments: verified } : {}) }, null);
  return loadState(root, state.id);
}

// `tracker.via: api`: the engine performs the pending actions itself and records its own readback as the capture,
// through the same checks as an agent capture. Without the API key (or for an adapter without `api`) the pending
// actions stay for the agent flow. Returns what happened, never the key.
export async function performTracker(root, cfg, state) {
  if (cfg.tracker.kind === 'none' || cfg.tracker.via !== 'api' || !state.tracker.pending.length) return { performed: [], note: null };
  const adapter = await loadTrackerAdapter(root, cfg, state.adapterBase);
  if (!adapter?.api?.perform) return { performed: [], note: `the \`${cfg.tracker.kind}\` tracker adapter has no API mode; perform the actions through the connector` };
  const keyName = cfg.tracker.apiKey ?? 'LINEAR_API_KEY';
  const entry = loadCatalog(root).find((k) => k.key === keyName);
  const token = entry ? readSecret(root, cfg, entry) : null;
  if (!token) return { performed: [], note: `${keyName} is ${entry ? 'not set (`wf secrets guide` in your terminal)' : 'not in .workflow/secrets.yaml (add it with `required: true`)'}; perform the tracker actions through the connector and record the raw readback` };
  const performed = [];
  let s = state;
  while (s.tracker.pending.length) {
    const event = s.tracker.pending[0].event;
    // Attachments carry the owner's captions, so the delivered event waits for `wf shown`.
    const shownBy = s.delivery.shown && !s.delivery.shown.none ? s.delivery.shown.screenshots : null;
    const attaching = s.tracker.pending.some((a) => a.event === event && a.op === 'attach');
    if (attaching && !shownBy && s.delivery.screenshots) return { performed, note: `${event} waits for the owner: show the delivered screenshots with their captions and run \`wf shown --file <f>\`; the API then uploads them with those captions`, state: s };
    const actions = s.tracker.pending.filter((a) => a.event === event).map((a) => (a.op === 'attach' ? { ...a, files: a.files.map((f) => ({ ...f, caption: shownBy?.find((x) => x.sha256 === f.sha256)?.caption ?? null })) } : a));
    let raw;
    try {
      raw = await adapter.api.perform({ token, url: cfg.tracker.apiUrl ?? adapter.api.url, item: s.item, actions });
    } catch (error) {
      return { performed, note: `tracker API (${event}) failed: ${String(error.message).split(token).join('[secret]')}; the actions stay pending` };
    }
    const file = path.join(attemptDir(root, s.id), 'tracker', `${event}-api-${now().replace(/[:.]/g, '-')}.json`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(raw, null, 2)}\n`);
    s = await recordTracker(root, cfg, s, { event, capture: file });
    performed.push(event);
  }
  return { performed, note: null, state: s };
}
