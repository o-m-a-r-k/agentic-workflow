import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { adapterFileAtCommit } from './config.mjs';
import { append, attemptDir, listAttempts, loadState } from './ledger.mjs';
import { loadCatalog, readSecret } from './secrets.mjs';
import { WfError, canonical, hashFile, now, readJson, refuse, sha256, writeImmutable } from './util.mjs';

const BUILTIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'adapters', 'tracker');

// Project adapters are loaded as committed at the attempt's base, so a ticket cannot change how it is checked.
export async function loadTrackerAdapter(root, cfg, baseCommit) {
  const kind = cfg.tracker.kind;
  if (kind === 'none') return null;
  const file = kind.startsWith('.') ? (baseCommit ? adapterFileAtCommit(root, cfg, baseCommit, kind) : path.resolve(root, '.workflow', kind)) : path.join(BUILTIN, `${kind}.mjs`);
  if (!fs.existsSync(file)) throw new WfError(`tracker adapter \`${kind}\` not found at ${file}`);
  return (await import(pathToFileURL(file).href)).default;
}

// Screenshots are uploaded before the comment, so the comment can embed each one by its asset url.
const DEFAULT_EVENTS = {
  admitted: ['read', { setStatus: 'started' }],
  implementing: ['read', { setStatus: 'started' }],
  integrating: [{ setStatus: 'inReview' }, { comment: 'reviewComment' }],
  delivered: [{ attach: 'screenshots' }, { comment: 'deliveredComment' }, { setStatus: 'delivered' }, 'readback'],
  reopened: [{ setStatus: 'started' }],
};

function renderTemplate(root, cfg, key, vars) {
  const ref = cfg.tracker[key];
  if (!ref) return null;
  const file = path.resolve(root, '.workflow', ref);
  const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : String(ref);
  return { template: text, body: text.replace(/\{(\w+)\}/g, (m, k) => (vars[k] ?? m)) };
}

// A criterion a person can check in the product. Named failure: every criterion's UAT text was pasted into the
// delivered comment verbatim, "Not user visible…" lines included, and the owner had to discard it.
const NOT_VISIBLE = /^\s*(not user[- ]?visible|no user[- ]?visible|not applicable|n\/a\b|none\b|internal\b)/i;
export const userVisible = (c) => c.uat !== false && !(typeof c.uat === 'string' && NOT_VISIBLE.test(c.uat));

export function uatScope(state) {
  return (state.criteria ?? []).filter(userVisible).map((c) => `- ${String(c.uat ?? c.text).trim()}`).join('\n');
}

// Known limits and follow-ups: a criterion's `finalHandoff` note, a criterion dropped by an amendment (with its
// reason), and every anomaly the owner recorded with `wf shown` as a follow-up.
export function knownLimits(state) {
  const out = [];
  for (const c of state.criteria ?? []) if (typeof c.finalHandoff === 'string' && c.finalHandoff.trim()) out.push(c.finalHandoff.trim());
  for (const a of state.criteriaAmendments ?? []) for (const d of a.changes?.dropped ?? []) out.push(`Not delivered: ${d.reason}`);
  for (const a of state.delivery?.shown?.anomalies ?? []) if (a.followUp) out.push(`Follow-up: ${a.observation} (${a.followUp})`);
  return out.map((l) => `- ${l.replace(/\s*\n\s*/g, ' ')}`).join('\n');
}

// In an agent-posted comment the owner replaces each placeholder with the `assetUrl` the upload returned; the API mode
// substitutes it itself. Linear signs the url when the comment is read.
export const assetPlaceholder = (title) => `{assetUrl:${title}}`;

function screenshotSection(state, assets = {}) {
  const set = state.delivery?.screenshots?.screenshots ?? [];
  if (!set.length) return '';
  const shown = state.delivery.shown?.screenshots ?? [];
  const rows = set.map((f, i) => {
    const caption = shown.find((x) => x.sha256 === f.sha256)?.caption ?? f.proposed;
    return `**${i + 1}. ${caption}**\n![${f.title}](${assets[f.title] ?? assetPlaceholder(f.title)})`;
  });
  return `Screenshots:\n\n${rows.join('\n\n')}`;
}

const deliveredKey = (cfg) => {
  const spec = cfg.tracker.events?.delivered ?? DEFAULT_EVENTS.delivered;
  return spec.find((s) => s?.comment)?.comment ?? null;
};

// Whether delivering this attempt posts a delivered comment (and so needs the owner's summary).
export function needsSummary(cfg, state) {
  if (cfg.tracker.kind === 'none' || ['quick', 'batch'].includes(state.lane)) return false;
  const key = deliveredKey(cfg);
  return Boolean(key && cfg.tracker[key]);
}

// The delivered comment: the template (its fixed lines are the header), the owner's plain-language summary, the UAT
// scope (user-visible criteria only), each delivered screenshot under its caption as an inline image, and the known
// limits. A template without `{summary}`, `{screenshots}` or `{limits}` gets them in that order: the summary after the
// first paragraph, the others at the end.
export function deliveredComment(root, cfg, state, assets = {}) {
  const key = deliveredKey(cfg);
  if (!key || !cfg.tracker[key]) return null;
  const summary = state.delivery?.summary?.text ?? null;
  const vars = { id: state.item, url: '', uatScope: uatScope(state) || '- No user-visible change to check in the product.', summary: summary ?? '', screenshots: screenshotSection(state, assets), limits: knownLimits(state) ? `Known limits and follow-ups:\n${knownLimits(state)}` : '' };
  const rendered = renderTemplate(root, cfg, key, vars);
  const tpl = rendered.template;
  let body = rendered.body.replace(/\s+$/, '');
  if (summary && !/\{summary\}/.test(tpl)) {
    const cut = body.indexOf('\n\n');
    body = cut < 0 ? `${body}\n\n${summary}` : `${body.slice(0, cut)}\n\n${summary}${body.slice(cut)}`;
  }
  for (const k of ['screenshots', 'limits']) if (vars[k] && !new RegExp(`\\{${k}\\}`).test(tpl)) body = `${body}\n\n${vars[k]}`;
  return { key, template: tpl, body: `${body.replace(/\n{3,}/g, '\n\n')}\n`, summary };
}

export const commentFile = (root, id) => path.join(attemptDir(root, id), 'delivery', 'delivered-comment.md');

// The comment to post, refreshed whenever what it shows changes (summary, captions). Engine-written; read it, never edit it.
export function writeDeliveredComment(root, cfg, state) {
  const c = deliveredComment(root, cfg, state);
  if (!c) return null;
  fs.mkdirSync(path.dirname(commentFile(root, state.id)), { recursive: true });
  fs.writeFileSync(commentFile(root, state.id), c.body);
  return commentFile(root, state.id);
}

// Normalised for comparison with what the tracker returns: placeholders and signed urls become one token per image,
// list markers and markdown escapes the tracker may rewrite are evened out, blank lines dropped.
export function canonicalComment(body) {
  return String(body ?? '')
    .replace(/\r/g, '')
    .replace(/\{assetUrl:[^}]*\}/g, 'ASSET')
    .replace(/!\[([^\]]*)\]\([^)\s]*\)/g, '![$1](ASSET)')
    .split('\n')
    .map((l) => l.trim().replace(/\\([\\`*_{}[\]()#+\-.!])/g, '$1').replace(/^[*+]\s+/, '- ').replace(/\s+/g, ' '))
    .filter(Boolean);
}

export const imageRefs = (body) => [...String(body ?? '').matchAll(/!\[([^\]]*)\]\(([^)\s]+)\)/g)].map((m) => ({ alt: m[1], url: m[2], path: m[2].split('?')[0] }));

// `wf summary --file f.md` (or `wf deliver --summary-file f.md`): the owner's plain-language summary of what changed,
// written for the person who tests it. Refused when it is empty, carries internals, or repeats the criteria verbatim.
export function recordSummary(root, cfg, state, options) {
  const file = options['summary-file'] ?? options.file;
  if (!file || file === true) throw new WfError('--file <summary.md> is required: a few plain-language lines on what changed, for the person who tests it');
  if (!needsSummary(cfg, state)) throw refuse(`${state.id} posts no delivered comment (${cfg.tracker.kind === 'none' ? 'no tracker' : `lane ${state.lane}, or no delivered comment template`}); no summary is needed`);
  if (state.tracker.done.some((d) => d.event === 'delivered')) throw refuse('the delivered comment is already verified on the ticket; the summary can no longer change');
  const text = fs.readFileSync(path.resolve(String(file)), 'utf8').replace(/\r/g, '').trim();
  const problems = [];
  if (!text) problems.push('the summary is empty');
  if (/not user[- ]?visible/i.test(text)) problems.push('it contains "not user visible": write what changed for the person who tests it, and leave internal-only criteria out');
  const lines = text.split('\n').map((l) => l.replace(/^\s*[-*+]\s*/, '').trim().toLowerCase()).filter(Boolean);
  const verbatim = (state.criteria ?? []).filter((c) => String(c.text ?? '').trim().length >= 20 && lines.includes(String(c.text).trim().toLowerCase())).map((c) => c.id);
  if (verbatim.length) problems.push(`it repeats criteria text verbatim (${verbatim.join(', ')}); the UAT scope is added from the criteria, the summary says in plain words what changed`);
  const hits = forbidden(cfg, text);
  if (hits.length) problems.push(`it contains internals: ${hits.join(', ')}`);
  if (problems.length) throw refuse(`summary refused:\n  - ${problems.join('\n  - ')}`);
  const n = (state.delivery.summaries ?? 0) + 1;
  const raw = path.join(attemptDir(root, state.id), 'delivery', `summary-${n}.raw.md`);
  writeImmutable(raw, `${text}\n`);
  append(root, state.id, 'delivery.summary', { text, sha256: sha256(text), raw: { path: raw, sha256: hashFile(raw) } }, options.actorId ?? null);
  const after = loadState(root, state.id);
  if (after.delivery.completedAt) writeDeliveredComment(root, cfg, after);
  return after;
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
      // The delivered comment is rendered from the ledger when it is shown or posted (summary, captions, asset urls).
      if (event === 'delivered' && cfg.tracker[step.comment]) {
        actions.push({ op: 'comment', templateKey: step.comment, rendered: 'delivered', body: null, reuseExisting: true });
        continue;
      }
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
  if (issue.id === undefined || issue.id === null || issue.id === '') problems.push(`the capture names no issue (no \`identifier\` or \`id\` found); save the raw tracker responses unchanged${adapter.captureShape ? `, shaped ${adapter.captureShape}` : ''}`);
  else if (issue.id !== state.item) problems.push(`capture is for ${issue.id}, not ${state.item}`);
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
  // Raw readbacks only. Named failure: a hand-built readback (signatures stripped, comment body abridged) was accepted.
  // Every capture the agent saves for `delivered` must have the shape the tracker's tools return; the engine's own API
  // readback is exempt (it is written by the engine).
  if (event === 'delivered' && !options.engineCapture && typeof adapter.rawProblems === 'function') {
    const shape = adapter.rawProblems(raw, { comments: pending.some((a) => a.op === 'comment') });
    if (shape.length) {
      const api = adapter.api && cfg.tracker.via !== 'api' ? ` Prefer \`tracker.via: api\` (its key through \`wf secrets\`): the engine then performs the actions and records its own readback, so nothing is saved by hand.` : '';
      problems.push(`the capture is not the unmodified tracker output (${shape.join('; ')}). Save each tool result unchanged, never rebuilt, abridged or reformatted: ${adapter.saveRaw ?? 'write the tool\'s whole JSON output to a file byte for byte'}.${api}`);
    }
  }
  const verifiedAttachments = new Map();
  // Attachments are checked first: the comment must embed each verified upload by its asset.
  const ordered = [...pending].sort((x, y) => (x.op === 'attach' ? -1 : 0) - (y.op === 'attach' ? -1 : 0));
  for (const a of ordered) {
    if (a.op === 'setStatus') {
      const ok = [a.status, ...(a.unless ?? [])];
      if (!ok.includes(issue.status)) problems.push(`status is \`${issue.status}\`, expected \`${a.status}\``);
    }
    if (a.op === 'comment') {
      const since = event === 'delivered' ? state.delivery.completedAt : null;
      const tpl = renderTemplate(root, cfg, a.templateKey, {});
      const lines = fixedLines(tpl?.template ?? a.body ?? '');
      const fresh = issue.comments.filter((c) => !since || (c.updatedAt ?? c.createdAt) >= since);
      const expected = a.rendered === 'delivered' ? deliveredComment(root, cfg, state) : null;
      if (a.rendered === 'delivered' && !expected?.summary) problems.push('no summary recorded for the delivered comment: `wf summary --file <summary.md>` (plain language, for the person who tests it), then post the comment `wf` renders');
      const want = expected ? canonicalComment(expected.body) : null;
      const exact = want ? fresh.find((c) => canonical(canonicalComment(c.body)) === canonical(want)) : null;
      const match = exact ?? fresh.find((c) => lines.every((l) => c.body.includes(l)));
      if (!match) problems.push(`no comment ${since ? 'written after delivery ' : ''}containing the template's fixed lines: ${lines.map((l) => JSON.stringify(l)).join(', ')}${expected ? `; post the body in ${commentFile(root, state.id)}` : ''}`);
      else {
        const hits = forbidden(cfg, match.body);
        if (hits.length) problems.push(`comment contains internals: ${hits.join(', ')}`);
        if (event === 'delivered' && uatScope(state) && !/\n\s*[-*]\s+\S/.test(match.body)) problems.push('comment has no UAT scope bullets');
        if (want && !exact) {
          const got = canonicalComment(match.body);
          const i = want.findIndex((l, k) => got[k] !== l);
          const at = i < 0 ? want.length : i;
          problems.push(`the posted comment is not the one \`wf\` rendered (summary sha256 ${expected.summary ? sha256(expected.summary).slice(0, 12) : 'none'}); first difference at line ${at + 1}: expected ${JSON.stringify(want[at] ?? '(end)')}, posted ${JSON.stringify(got[at] ?? '(end)')}. Post ${commentFile(root, state.id)} unchanged, with each {assetUrl:<title>} replaced by that upload's assetUrl`);
        }
        // Screenshots must be visible on the ticket: an attachment alone shows only as "added N links".
        if (a.rendered === 'delivered') {
          const refs = imageRefs(match.body);
          const notEmbedded = [];
          for (const f of state.delivery.screenshots?.screenshots ?? []) {
            const att = verifiedAttachments.get(f.sha256);
            const byAsset = att?.url ? refs.some((r) => r.path === String(att.url).split('?')[0]) : false;
            if (!byAsset) notEmbedded.push(`${f.title}${att ? ` (attachment ${att.id ?? '?'}, asset ${String(att.url ?? '').split('?')[0] || 'unknown'})` : ''}`);
          }
          if (notEmbedded.length) problems.push(`the comment does not embed ${notEmbedded.length} delivered screenshot(s) as an inline image of its uploaded asset; attachments alone show on the ticket only as "added N links". Put \`![<title>](<assetUrl>)\` under each caption:\n    - ${notEmbedded.join('\n    - ')}`);
        }
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
          else {
            verified.push({ title, sha256: f.sha256, attachment: exact[0].id ?? null, caption });
            verifiedAttachments.set(f.sha256, exact[0]);
          }
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
    const actions = s.tracker.pending.filter((a) => a.event === event).map((a) => (a.op === 'attach' ? { ...a, files: a.files.map((f) => ({ ...f, caption: shownBy?.find((x) => x.sha256 === f.sha256)?.caption ?? null })) } : a.rendered === 'delivered' ? { ...a, body: deliveredComment(root, cfg, s)?.body ?? null } : a));
    if (actions.some((a) => a.rendered === 'delivered' && !s.delivery.summary)) return { performed, note: `${event} waits for the owner's summary: \`wf summary --file <summary.md>\``, state: s };
    let raw;
    try {
      raw = await adapter.api.perform({ token, url: cfg.tracker.apiUrl ?? adapter.api.url, item: s.item, actions });
    } catch (error) {
      return { performed, note: `tracker API (${event}) failed: ${String(error.message).split(token).join('[secret]')}; the actions stay pending` };
    }
    const file = path.join(attemptDir(root, s.id), 'tracker', `${event}-api-${now().replace(/[:.]/g, '-')}.json`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(raw, null, 2)}\n`);
    s = await recordTracker(root, cfg, s, { event, capture: file, engineCapture: true });
    performed.push(event);
  }
  return { performed, note: null, state: s };
}
