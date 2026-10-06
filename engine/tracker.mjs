import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { adapterFileAtCommit, loadConfigAtCommit } from './config.mjs';
import { append, attemptDir, listAttempts, loadState } from './ledger.mjs';
import { loadCatalog, readSecret } from './secrets.mjs';
import { WfError, canonical, hashFile, now, readJson, refuse, sessionIdentity, sha256, writeImmutable } from './util.mjs';
import { home } from './provenance.mjs';
import { prepareWrite, readEvidenceFile, readRegular, writeNoFollow } from './evidence.mjs';
import { connectorCalls, ownerTranscript } from './host-record.mjs';
import { cliEnv, scrub } from './scrub.mjs';

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
  // A template file is read only inside .workflow/, without following a link (its text is posted to the tracker).
  const file = path.resolve(root, '.workflow', ref);
  const inside = file.startsWith(path.resolve(root, '.workflow') + path.sep);
  const read = inside && fs.existsSync(file) ? readRegular(file) : null;
  if (inside && fs.existsSync(file) && !read) throw new WfError(`${file} is a link or not a regular file with one name; the comment template is not read through it`);
  const text = read ? read.bytes.toString('utf8') : String(ref);
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
// reason), every anomaly the owner recorded with `wf shown` as a follow-up, and every discovered issue the owner deferred.
export function knownLimits(state) {
  const out = [];
  for (const c of state.criteria ?? []) if (typeof c.finalHandoff === 'string' && c.finalHandoff.trim()) out.push(c.finalHandoff.trim());
  for (const a of state.criteriaAmendments ?? []) for (const d of a.changes?.dropped ?? []) out.push(`Not delivered: ${d.reason}`);
  for (const a of state.delivery?.shown?.anomalies ?? []) if (a.followUp) out.push(`Follow-up: ${a.observation} (${a.followUp})`);
  // An issue found during the ticket that the owner deferred (I-18): the tester sees it with the owner's words.
  for (const d of state.discovered ?? []) if (d.status === 'deferred') out.push(`Deferred: ${d.summary} (the owner's words: "${d.deferred.decision}"; recorded ${d.deferred.source?.provenance ?? 'without a source (before 0.4.5)'}; ${d.deferred.acknowledged ? 'acknowledged at delivery' : 'not acknowledged'})`);
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
  prepareWrite(commentFile(root, state.id));
  fs.mkdirSync(path.dirname(commentFile(root, state.id)), { recursive: true });
  writeNoFollow(commentFile(root, state.id), c.body);
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
  // Posted to the tracker: read without following a link, a regular file with one name.
  const read = readRegular(path.resolve(String(file)));
  if (!read) throw refuse(`${file} is missing, a link or not a regular file with one name; the summary is not read through it`);
  const text = read.bytes.toString('utf8').replace(/\r/g, '').trim();
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

export const AGENT_REPORTED = 'agent-reported, unverified';
export const HOST_RECORDED = 'host-recorded';

const parseJson = (t) => {
  try {
    return JSON.parse(t);
  } catch {
    return null;
  }
};

// `wf tracker record --from-transcript`: the tracker's answer as the host recorded it in the owner's transcript (see
// engine/host-record.mjs), then exactly the checks a raw capture gets.
async function recordFromTranscript(root, cfg, state, options, event, pending, adapter) {
  if (cfg.tracker.via !== 'connector') throw refuse(`\`--from-transcript\` is for \`tracker.via: connector\`; with \`${cfg.tracker.via}\` the engine performs and verifies the handoff itself (\`wf tracker sync\`)`);
  const tools = adapter.connectorTools;
  if (!tools) throw refuse(`the \`${cfg.tracker.kind}\` adapter names no connector tools, so no host-recorded readback can be read; record with \`--capture\` or \`--agent-reported\``);
  const t = ownerTranscript(state.owner);
  if (t.problem) throw refuse(`no host-recorded readback: ${t.problem}`);
  const calls = await connectorCalls(t, [tools.read, tools.comments, ...(tools.comment ?? []), ...(tools.status ?? []), ...(tools.attach ?? [])]);
  const since = event === 'delivered' ? state.delivery.completedAt : state.tracker.pendingAt?.[event] ?? null;
  const after = (c) => c.result !== undefined && !c.error && (!since || (c.at && Date.parse(c.at) >= Date.parse(since)));
  const forItem = (c, ids) => [c.input?.id, c.input?.issueId, c.input?.issue].some((x) => x !== undefined && ids.includes(String(x)));
  const reads = calls.filter((c) => c.tool === tools.read && (forItem(c, [state.item]) || [parseJson(c.result)?.id, parseJson(c.result)?.identifier].includes(state.item)));
  const read = reads.filter(after).sort((a, b) => b.resultLine - a.resultLine)[0];
  if (!read) throw refuse(`no host-recorded readback: the owner's transcript has no ${tools.read} result for ${state.item}${reads.length ? ` after ${event === 'delivered' ? 'delivery' : 'the event'} (${since}); the ones there are older` : ''}`, `call the connector's ${tools.read} for ${state.item} now${pending.some((a) => a.op === 'comment') ? ` and ${tools.comments}` : ''}, then run this again`);
  const uuid = parseJson(read.result)?.uuid ?? null;
  const ids = [state.item, ...(uuid ? [uuid] : [])];
  const dir = path.join(root, '.wf-worktrees', state.id, '_host');
  fs.mkdirSync(dir, { recursive: true });
  const capture = path.join(dir, `${event}-${tools.read}-${read.resultLine}.json`);
  writeNoFollow(capture, read.result);
  let comments = null;
  if (pending.some((a) => a.op === 'comment')) {
    const list = calls.filter((c) => c.tool === tools.comments && forItem(c, ids) && after(c)).sort((a, b) => b.resultLine - a.resultLine)[0];
    if (!list) throw refuse(`no host-recorded readback: the owner's transcript has no ${tools.comments} result for ${state.item} after ${event === 'delivered' ? 'delivery' : 'the event'}`, `call the connector's ${tools.comments} for ${state.item} now, then run this again`);
    comments = path.join(dir, `${event}-${tools.comments}-${list.resultLine}.json`);
    writeNoFollow(comments, list.result);
  }
  const mine = calls.filter((c) => forItem(c, ids) && (!since || (c.calledAt && Date.parse(c.calledAt) >= Date.parse(since))));
  const posted = {
    comments: mine.filter((c) => (tools.comment ?? []).includes(c.tool)).map((c) => String(c.input?.body ?? '')),
    statuses: mine.filter((c) => (tools.status ?? []).includes(c.tool)).map((c) => c.input?.state ?? c.input?.status ?? null).filter(Boolean),
    attachments: mine.filter((c) => (tools.attach ?? []).includes(c.tool)).map((c) => ({ title: c.input?.title ?? null, subtitle: c.input?.subtitle ?? null })),
  };
  try {
    return await recordTracker(root, cfg, state, { ...options, capture, comments, 'from-transcript': undefined, hostRecorded: { runtime: t.runtime, transcript: t.file, lines: [read.resultLine], posted } });
  } finally {
    // Only the matched results go into the evidence (through the manifest); the scratch copies do not stay.
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// `wf tracker record --agent-reported --file reported.json [--comment-file posted.md]`, connector mode only. In Claude
// Code the connector's tool results arrive inline in the chat, not as saved files, so the raw-capture path could only
// be met by retyping them (named failure: ~35 KB of signed URLs retyped, which proves nothing). Here the agent reports
// what the tracker showed it, and the engine checks what it can: the item, the status, the posted comment's text (its
// sha256, the template's fixed lines, the owner's summary, an image for every delivered screenshot, no internals), the
// attachment titles and captions, and a read time after delivery that no earlier readback used. Additions the owner
// made to the comment are allowed and listed. It is recorded as agent-reported, unverified: the engine never saw the
// tracker's answer.
async function recordAgentReported(root, cfg, state, options, event, pending) {
  if (cfg.tracker.via !== 'connector') throw refuse(`\`--agent-reported\` is for \`tracker.via: connector\`; with \`${cfg.tracker.via}\` the engine performs and verifies the handoff itself (\`wf tracker sync\`)`);
  if (typeof options.file !== 'string') throw new WfError('--file <reported.json> is required: { issue, status, comment: { id, bodySha256, createdAt }, attachments: [{ title, subtitle }], readAt }');
  const reportRead = readRegular(path.resolve(options.file));
  if (!reportRead) throw refuse(`${options.file} is missing, a link or not a regular file`);
  const reportText = reportRead.bytes.toString('utf8');
  let r;
  try {
    r = JSON.parse(reportText);
  } catch (error) {
    throw new WfError(`invalid JSON in ${options.file}: ${error.message}`);
  }
  const problems = [];
  if (String(r.issue ?? '') !== state.item) problems.push(`the report is for \`${r.issue ?? '(no issue)'}\`, not ${state.item}`);
  // The roles read the ticket from the admitted readback: it must carry the description (or say there is none).
  if (event === 'admitted' && !String(r.description ?? '').trim() && r.descriptionEmpty !== true) problems.push('the admitted report needs the issue\'s `title` and `description` as the tracker shows them (or `"descriptionEmpty": true` for a title-only issue)');
  const readAt = Date.parse(r.readAt ?? '');
  const since = event === 'delivered' ? state.delivery.completedAt : state.tracker.pendingAt?.[event] ?? null;
  if (!Number.isFinite(readAt) || !/^\d{4}-\d{2}-\d{2}T/.test(String(r.readAt))) problems.push('`readAt` must be the ISO time the agent read the issue back');
  else {
    if (since && readAt < Date.parse(since)) problems.push(`\`readAt\` ${r.readAt} is before ${event === 'delivered' ? 'delivery' : 'the event'} (${since}): read the issue again now`);
    if (readAt > Date.now() + 5 * 60 * 1000) problems.push(`\`readAt\` ${r.readAt} is in the future`);
  }
  const reportSha = sha256(reportText);
  for (const id of listAttempts(root)) {
    const other = id === state.id ? state : loadState(root, id);
    for (const d of other.tracker.done) {
      if (d.readAt && d.readAt === r.readAt) problems.push(`\`readAt\` ${r.readAt} was already recorded for ${id === state.id ? `event \`${d.event}\`` : `${id} (${d.event})`}: read the issue again now`);
      else if (d.capture?.sha256 === reportSha) problems.push(`the report is byte-identical to the one recorded for ${id === state.id ? `event \`${d.event}\`` : `${id} (${d.event})`}`);
    }
  }
  let comment = null;
  const extra = [];
  for (const a of pending) {
    if (a.op === 'setStatus' && ![a.status, ...(a.unless ?? [])].includes(r.status)) problems.push(`status is \`${r.status ?? '(none)'}\`, expected \`${a.status}\``);
    if (a.op === 'comment') {
      if (typeof options['comment-file'] !== 'string') {
        problems.push('--comment-file <posted.md> is required: the comment text exactly as posted (copy it from the tracker), so the engine can check and hash it');
        continue;
      }
      const read = readRegular(path.resolve(options['comment-file']));
      if (!read) {
        problems.push(`${options['comment-file']} is missing, a link or not a regular file`);
        continue;
      }
      const body = read.bytes.toString('utf8');
      comment = { text: body, sha256: sha256(body) };
      if (r.comment?.bodySha256 !== comment.sha256) problems.push(`the posted comment's sha256 is ${comment.sha256.slice(0, 12)}…, the report declares ${String(r.comment?.bodySha256 ?? 'none').slice(0, 12)}…: report the hash of the text in --comment-file`);
      if (since && r.comment?.createdAt && Date.parse(r.comment.createdAt) < Date.parse(since)) problems.push(`the comment was written at ${r.comment.createdAt}, before ${event === 'delivered' ? 'delivery' : 'the event'}`);
      const tpl = renderTemplate(root, cfg, a.templateKey, {});
      const missingLines = fixedLines(tpl?.template ?? a.body ?? '').filter((l) => !body.includes(l));
      if (missingLines.length) problems.push(`the comment lacks the template's fixed line(s): ${missingLines.map((l) => JSON.stringify(l)).join(', ')}`);
      const hits = forbidden(cfg, body);
      if (hits.length) problems.push(`comment contains internals: ${hits.join(', ')}`);
      if (a.rendered === 'delivered') {
        const expected = deliveredComment(root, cfg, state);
        const got = canonicalComment(body);
        if (!expected?.summary) problems.push('no summary recorded for the delivered comment: `wf summary --file <summary.md>`, then post the comment `wf` renders');
        else {
          const missing = canonicalComment(expected.summary).filter((l) => !got.includes(l));
          if (missing.length) problems.push(`the comment lacks the owner's summary (first missing line: ${JSON.stringify(missing[0])})`);
        }
        const refs = imageRefs(body);
        const noImage = (state.delivery.screenshots?.screenshots ?? []).filter((f) => !refs.some((x) => x.alt === f.title || x.path.endsWith(`/${f.title}`) || x.path === f.title)).map((f) => f.title);
        if (noImage.length) problems.push(`the comment has no inline image for ${noImage.length} delivered screenshot(s): ${noImage.join(', ')} (\`![<title>](<url>)\` under each caption)`);
        // Owner additions beyond the rendered comment are allowed; they are listed in the record.
        const want = new Set(expected ? canonicalComment(expected.body) : []);
        extra.push(...got.filter((l) => !want.has(l)));
      }
    }
    if (a.op === 'attach') {
      const shown = state.delivery.shown;
      if (state.delivery.screenshots && (!shown || shown.none)) problems.push(`the ${a.files.length} delivered screenshot(s) were not shown to the owner yet: \`wf shown --file <f>\` first`);
      const listed = Array.isArray(r.attachments) ? r.attachments : [];
      for (const f of a.files) {
        const title = f.title ?? path.basename(f.path);
        const caption = shown?.screenshots?.find((x) => x.sha256 === f.sha256)?.caption ?? null;
        const named = listed.filter((x) => x.title === title || x.filename === title);
        if (!named.length) problems.push(`${title}: not among the reported attachments`);
        else if (caption && !named.some((x) => String(x.subtitle ?? '').trim() === caption)) problems.push(`${title}: reported without the subtitle "${caption}"`);
      }
    }
  }
  if (problems.length) throw refuse(`agent-reported readback for \`${event}\` refused:\n  - ${problems.join('\n  - ')}`);
  const dest = path.join(attemptDir(root, state.id), 'tracker', `${event}-reported.json`);
  writeImmutable(dest, reportText);
  let commentRec = null;
  if (comment) {
    const cdest = path.join(attemptDir(root, state.id), 'tracker', `${event}-posted-comment.md`);
    writeImmutable(cdest, comment.text);
    commentRec = { path: cdest, sha256: comment.sha256, id: r.comment?.id ?? null };
  }
  append(root, state.id, 'tracker.recorded', { event, provenance: AGENT_REPORTED, verified: false, mode: 'agent-reported', capture: { path: dest, sha256: hashFile(dest) }, readAt: r.readAt, status: r.status ?? null, ...(commentRec ? { comment: commentRec } : {}), ...(extra.length ? { extraLines: extra.slice(0, 50).map((l) => scrub(l)) } : {}), attachments: (r.attachments ?? []).map((x) => ({ title: x.title, caption: x.subtitle ?? null })) }, null);
  return loadState(root, state.id);
}

export async function recordTracker(root, cfg, state, options) {
  if (cfg.tracker.kind === 'none') throw refuse('this project has no tracker (`tracker.kind: none`)');
  const event = options.event;
  if (!event) throw new WfError('--event is required');
  const pending = state.tracker.pending.filter((a) => a.event === event);
  if (!pending.length) throw refuse(`no pending tracker actions for event \`${event}\``);
  if (options['agent-reported']) return recordAgentReported(root, cfg, state, options, event, pending);
  if (options['from-transcript']) return recordFromTranscript(root, cfg, state, options, event, pending, await loadTrackerAdapter(root, cfg, state.adapterBase));
  if (!options.capture) throw new WfError(`--capture <file> is required: the raw tracker response the agent saved${cfg.tracker.via === 'connector' ? ' (or, when the tool results are only in the chat, `--agent-reported --file <reported.json> --comment-file <posted.md>`)' : ''}`);
  const adapter = await loadTrackerAdapter(root, cfg, state.adapterBase);
  const capturePath = path.resolve(String(options.capture));
  // Read once: the bytes checked are the bytes kept (and the ones hashed for the recycled-capture check). With
  // --comments, the two saved tool results (get_issue, list_comments) are kept together, unchanged, as one list.
  const commentsPath = typeof options.comments === 'string' ? path.resolve(options.comments) : null;
  const captureText = commentsPath ? `[${fs.readFileSync(capturePath, 'utf8').trim()},\n${fs.readFileSync(commentsPath, 'utf8').trim()}]\n` : fs.readFileSync(capturePath, 'utf8');
  const provenance = options.engineCapture ? 'engine (tracker API)' : options.hostRecorded ? HOST_RECORDED : captureProvenance([capturePath, ...(commentsPath ? [commentsPath] : [])]);
  const extraLines = [];
  let raw;
  try {
    raw = JSON.parse(captureText);
  } catch (error) {
    throw new WfError(`invalid JSON in ${capturePath}: ${error.message}`);
  }
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
  const sha = sha256(captureText);
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
      const api = (adapter.api || adapter.cli) && !ENGINE_VIAS.includes(cfg.tracker.via) ? ` Prefer \`tracker.via: ${adapter.cli ? 'cli' : 'api'}\`${adapter.cli ? ' (your `gh` login)' : ' (its key through `wf secrets`)'}: the engine then performs the actions and records its own readback, so nothing is saved by hand.` : '';
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
      // The rendered comment with sections the owner added (its lines all present, in order) counts as posted.
      const contains = (got) => {
        let i = 0;
        for (const l of got) if (l === want[i]) i++;
        return i === want.length;
      };
      const exact = want ? fresh.find((c) => canonical(canonicalComment(c.body)) === canonical(want)) ?? fresh.find((c) => contains(canonicalComment(c.body))) : null;
      if (exact && want) extraLines.push(...canonicalComment(exact.body).filter((l) => !want.includes(l)));
      if (exact && want && options.hostRecorded?.posted?.comments?.length && !options.hostRecorded.posted.comments.some((b) => canonical(canonicalComment(b)) === canonical(canonicalComment(exact.body)))) problems.push('the comment on the ticket is not one the owner session posted after this event (by the transcript); post the rendered comment, then read it back');
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
          // A tracker that reports the stored bytes' sha256 (files) or size (GitHub release assets): they must match.
          else if (exact[0].sha256 && exact[0].sha256 !== f.sha256) missing.push(`${title}: the stored file's sha256 differs from the delivered screenshot`);
          else if (exact[0].size !== undefined && exact[0].size !== null && Number(exact[0].size) !== (readRegular(f.path)?.bytes.length ?? -1)) missing.push(`${title}: the stored file's size (${exact[0].size}) differs from the delivered screenshot (${readRegular(f.path)?.bytes.length ?? 'unreadable'})`);
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
  writeImmutable(dest, captureText);
  const level = options.engineCapture ? 'engine-read' : options.hostRecorded ? 'host-recorded' : provenance === 'host tool-result file' ? 'host-saved' : false;
  const host = options.hostRecorded ? { runtime: options.hostRecorded.runtime, transcript: options.hostRecorded.transcript, lines: options.hostRecorded.lines, posted: { comments: options.hostRecorded.posted.comments.map((b) => sha256(b)), statuses: options.hostRecorded.posted.statuses, attachments: options.hostRecorded.posted.attachments } } : null;
  append(root, state.id, 'tracker.recorded', { event, provenance, verified: level, capture: { path: dest, sha256: hashFile(dest) }, status: issue.status, ...(host ? { host } : {}), ...(extraLines.length ? { extraLines: extraLines.slice(0, 50).map((l) => scrub(l)) } : {}), ...(verified.length ? { attachments: verified } : {}) }, null);
  return loadState(root, state.id);
}

// Doctor: the tracker mode and what it costs. api: the key must be there. agent (connector): the readback is only what
// the agent saved, so the engine cannot prove it is the tracker's raw answer; say so and how to switch.
// What wf can verify for each kind x via, said by `wf doctor` and the docs.
export const VERIFIABLE = {
  'linear/api': 'the engine posts, uploads and reads back itself through the API: status, comment body, every attachment (title, caption) and its embedding are checked on the tracker\'s own answer; uploaded bytes are trusted (no hash from the tracker)',
  'linear/connector': 'the agent acts through its connector; the readback is host-recorded where the host keeps a transcript (`wf tracker record --from-transcript`: the tracker\'s answer as Claude Code or Codex recorded it, checked like an API readback), else a saved tool-result file, else agent-reported (`--agent-reported`: checked as reported, recorded unverified)',
  'github/cli': 'the engine calls the GitHub REST API through your `gh` login: labels (status), the comment body and release assets (name, caption label, size) are read back from GitHub itself; asset bytes are checked by size, not hash',
  'github/api': 'as github/cli, with a token from `wf secrets` instead of your `gh` login',
  'github/connector': 'agent-reported: no host-recorded readback for GitHub connectors yet; for a verified handoff use `cli` (your `gh` login) or `api`',
  'files/files': 'the engine does every action on the ticket files in the repo and reads them back: status, comment, attachments (each by sha256); anyone who can edit the repo can edit a ticket, and git history is the audit trail',
};

// Where a tracker token may go. Named finding (0.4.0 review: credential exfiltration): the GitHub adapter sent its
// token to whatever `tracker.apiUrl` / `tracker.uploadUrl` said, including a value edited in the working tree, and
// fetch followed redirects. Now an endpoint is https (plain http only on this machine's loopback), carries no
// credentials, and is the tracker's own host unless the owner committed another one in the adapter at the base commit
// (then `wf doctor` names it loudly); the engine reads every endpoint from that committed adapter, never the working
// copy, and authenticated requests never follow a redirect.
export const DEFAULT_HOSTS = { linear: ['api.linear.app'], github: ['api.github.com', 'uploads.github.com'] };
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);
export const isLoopback = (u) => LOOPBACK.has(new URL(u).hostname);
export function endpointProblem(url) {
  let u;
  try {
    u = new URL(String(url));
  } catch {
    return `\`${url}\` is not a URL`;
  }
  if (u.username || u.password) return `${u.host}: an endpoint never carries credentials in its URL`;
  if (u.protocol === 'https:') return null;
  if (u.protocol === 'http:' && LOOPBACK.has(u.hostname)) return null;
  return `${u.protocol}//${u.host}: a tracker token goes only over https (plain http only to this machine's loopback)`;
}
const ENDPOINT_KEYS = ['apiUrl', 'uploadUrl'];
function endpointNotices(cfg) {
  const out = [];
  for (const k of ENDPOINT_KEYS) {
    const v = cfg.tracker[k];
    if (v === undefined || v === null) continue;
    const problem = endpointProblem(v);
    if (problem) out.push({ fail: true, key: `tracker.${k}`, problem, fix: 'use the tracker\'s https endpoint, or remove the key for the default' });
    else if (!isLoopback(v) && !(DEFAULT_HOSTS[cfg.tracker.kind] ?? []).includes(new URL(v).hostname)) out.push({ check: 'tracker endpoint', problem: `NOTICE: the ${cfg.tracker.kind} token is sent to ${new URL(v).host} (tracker.${k}), not ${(DEFAULT_HOSTS[cfg.tracker.kind] ?? ['the default host']).join(' / ')}`, fix: 'keep it only if that host is your own tracker (for example GitHub Enterprise); it is honoured only as committed in the adapter on the base branch' });
  }
  return out;
}

export async function trackerModeChecks(root, cfg, { loadCatalog: catalog, readSecret: secret }) {
  if (cfg.tracker.kind === 'none') return [];
  const out = [];
  let adapter = null;
  try {
    adapter = await loadTrackerAdapter(root, cfg, null);
  } catch {}
  const combo = `${cfg.tracker.kind}/${cfg.tracker.via}`;
  if (VERIFIABLE[combo]) out.push({ info: true, check: `tracker ${combo}`, problem: VERIFIABLE[combo] });
  if (cfg.tracker.via === 'connector') {
    const s = sessionIdentity();
    const store = s?.runtime === 'claude' ? path.join(home(), '.claude', 'projects') : s?.runtime === 'codex' ? path.join(home(), '.codex') : null;
    const level = !adapter?.connectorTools ? 'agent-reported (this adapter names no connector tools)' : store && fs.existsSync(store) ? `host-recorded (${s.runtime === 'claude' ? 'Claude Code' : 'Codex'} transcripts at ${store}; run the connector actions, then \`wf tracker record --event <e> --from-transcript\`)` : 'agent-reported in this shell (no Claude Code or Codex session); host-recorded when the owner runs wf from Claude Code or Codex';
    out.push({ info: true, check: 'tracker readback level', problem: level });
  }
  out.push(...endpointNotices(cfg));
  if (cfg.tracker.kind === 'github') {
    const p = await publicAssetsProblem(root, cfg);
    if (p) out.push({ check: 'tracker screenshots', problem: `NOTICE: ${p.split('. Fix: ')[0]}`, fix: p.split('. Fix: ')[1] });
    else if (publicAcknowledged(root, cfg)) out.push({ info: true, check: 'tracker screenshots', problem: 'public screenshots acknowledged (`tracker.publicAssets: acknowledged`): release assets may be publicly downloadable' });
  }
  const keyName = cfg.tracker.apiKey ?? adapter?.apiKey ?? 'LINEAR_API_KEY';
  if (cfg.tracker.via === 'cli') {
    const gh = spawnSync('gh', ['auth', 'status'], { encoding: 'utf8', env: cliEnv() });
    if (gh.error) out.push({ fail: true, key: 'gh', problem: 'tracker.via is cli but the GitHub CLI `gh` is not on PATH', fix: 'install gh and sign in with `gh auth login` (wf uses your login and never prints its token)' });
    else if (gh.status !== 0) out.push({ fail: true, key: 'gh', problem: 'tracker.via is cli but `gh auth status` reports no login', fix: 'the owner runs `gh auth login` in their own terminal' });
  } else if (cfg.tracker.via === 'files') {
    const folder = path.resolve(root, cfg.tracker.folder ?? 'tickets');
    const st = fs.lstatSync(folder, { throwIfNoEntry: false });
    if (!st) out.push({ check: 'tracker files', problem: `the tickets folder ${folder} does not exist yet`, fix: `create it with one <id>.md per ticket (YAML frontmatter: id, title, status, labels)` });
    else if (!st.isDirectory()) out.push({ fail: true, key: 'tickets folder', problem: `${folder} is ${st.isSymbolicLink() ? 'a symlink' : 'not a folder'}; tickets are not read or written through it`, fix: 'make it a real folder in the repo' });
  } else if (cfg.tracker.via === 'api') {
    const entry = catalog(root).find((k) => k.key === keyName);
    if (!entry) out.push({ fail: true, key: keyName, problem: `tracker.via is api but ${keyName} is not catalogued in .workflow/secrets.yaml`, fix: `add { key: ${keyName}, kind: provided, required: true, purpose: "${cfg.tracker.kind} API key" } to .workflow/secrets.yaml, then the owner runs \`wf secrets guide ${keyName}\` in their own terminal` });
    else if (!secret(root, cfg, entry)) out.push({ fail: true, key: keyName, problem: `tracker.via is api but ${keyName} is not set`, fix: `the owner runs \`wf secrets guide ${keyName}\` in their own terminal` });
  } else if (adapter?.api || adapter?.cli) {
    const better = adapter.cli ? 'cli' : 'api';
    out.push({ check: 'tracker mode', problem: `the ${cfg.tracker.kind} tracker is driven by the agent's connector: convenient, but the handoff is agent-reported (recorded "agent-reported, unverified"), so wf cannot prove the status, the comment or the attachments are the tracker's own answer`, fix: `let the engine reach it: \`wf tracker mode ${better}\`${better === 'api' ? ` (then the owner runs \`wf secrets guide ${keyName}\`)` : ' (uses your `gh` login)'}` });
  }
  return out;
}

// Where a connector readback came from: the host's own saved tool-result file (Claude Code keeps long tool results in
// ~/.claude/projects/<project>/<session>/tool-results/), or anything else, which is only what the agent reports.
export function captureProvenance(files) {
  const home = process.env.HOME ?? '';
  const host = (f) => {
    const c = String(f);
    return Boolean(home) && c.startsWith(path.join(home, '.claude', 'projects') + path.sep) && c.split(path.sep).includes('tool-results');
  };
  return files.length && files.every(host) ? 'host tool-result file' : 'agent-reported, unverified';
}

// `tracker.via: api`: the engine performs the pending actions itself and records its own readback as the capture,
// through the same checks as an agent capture. Without the API key (or for an adapter without `api`) the pending
// actions stay for the agent flow. Returns what happened, never the key.
export const ENGINE_VIAS = ['api', 'cli', 'files'];

// The tracker's key for `via: api` (null for other routes or when unset); never printed.
function trackerToken(root, cfg, adapter) {
  if (cfg.tracker.via !== 'api') return null;
  const keyName = cfg.tracker.apiKey ?? adapter?.apiKey ?? 'LINEAR_API_KEY';
  const entry = loadCatalog(root).find((k) => k.key === keyName);
  return entry ? readSecret(root, cfg, entry) : null;
}

// Whether the owner acknowledged public screenshots: only as committed on the base branch of the adapter repo (an
// edit in a working copy does not count).
function publicAcknowledged(root, cfg) {
  try {
    const repo = cfg.adapterRepo ? cfg.repos.find((r) => r.name === cfg.adapterRepo) : cfg.repos[0];
    return loadConfigAtCommit(root, cfg, repo.base).tracker.publicAssets === 'acknowledged';
  } catch {
    return false;
  }
}

// GitHub screenshots are release assets; on a public repository anyone can download them. Returns the refusal text
// when screenshots would go to a repository that is not known to be private without the owner's acknowledgement.
export async function publicAssetsProblem(root, cfg, { screenshots = true } = {}) {
  if (cfg.tracker.kind !== 'github' || !screenshots || !['cli', 'api'].includes(cfg.tracker.via)) return null;
  if (publicAcknowledged(root, cfg)) return null;
  const adapter = await loadTrackerAdapter(root, cfg, null);
  const impl = adapter?.[cfg.tracker.via];
  const endpoint = cfg.tracker.apiUrl ?? impl?.url ?? null;
  const token = trackerToken(root, cfg, adapter);
  // The token goes only to an endpoint the credential rules accept and that is GitHub's own or this machine.
  const safe = cfg.tracker.via === 'cli' || (endpoint && !endpointProblem(endpoint) && (isLoopback(endpoint) || DEFAULT_HOSTS.github.includes(new URL(endpoint).hostname)));
  const isPrivate = safe && impl?.visibility && (cfg.tracker.via === 'cli' || token) ? await impl.visibility({ token, url: endpoint, cfg }) : null;
  return isPrivate === true ? null : `${adapter.publicNotice}. Fix: ${adapter.publicFix}`;
}
export async function performTracker(root, cfg, state) {
  const via = cfg.tracker.via;
  if (cfg.tracker.kind === 'none' || !ENGINE_VIAS.includes(via) || !state.tracker.pending.length) return { performed: [], note: null };
  const adapter = await loadTrackerAdapter(root, cfg, state.adapterBase);
  const impl = adapter?.[via];
  if (!impl?.perform) return { performed: [], note: `the \`${cfg.tracker.kind}\` tracker adapter has no \`${via}\` mode; perform the actions through the connector` };
  // Endpoints, repository and folder as committed at the attempt's base, never the working copy.
  let trusted;
  try {
    trusted = loadConfigAtCommit(root, cfg, state.adapterBase);
  } catch (error) {
    return { performed: [], note: `the adapter at the base commit is unreadable (${error.message}); the actions stay pending` };
  }
  for (const k of [...ENDPOINT_KEYS, 'repo', 'folder', 'apiKey', 'kind', 'via']) {
    if (JSON.stringify(cfg.tracker[k] ?? null) !== JSON.stringify(trusted.tracker[k] ?? null)) return { performed: [], note: `tracker.${k} in the working copy differs from the adapter at the base commit; commit it on the base branch first (the engine uses only the committed value); the actions stay pending` };
  }
  const endpoint = trusted.tracker.apiUrl ?? impl.url ?? null;
  for (const e of [endpoint, trusted.tracker.uploadUrl].filter(Boolean)) {
    const problem = endpointProblem(e);
    if (problem) return { performed: [], note: `${problem}; nothing sent, the actions stay pending` };
  }
  cfg = { ...cfg, tracker: trusted.tracker };
  let token = null;
  if (via === 'api') {
    const keyName = cfg.tracker.apiKey ?? adapter.apiKey ?? 'LINEAR_API_KEY';
    const entry = loadCatalog(root).find((k) => k.key === keyName);
    token = trackerToken(root, cfg, adapter);
    if (!token) return { performed: [], note: `${keyName} is ${entry ? 'not set (`wf secrets guide` in your terminal)' : 'not in .workflow/secrets.yaml (add it with `required: true`)'}; perform the tracker actions through the connector and record the raw readback` };
  }
  const performed = [];
  let s = state;
  while (s.tracker.pending.length) {
    const event = s.tracker.pending[0].event;
    // Attachments carry the owner's captions, so the delivered event waits for `wf shown`.
    const shownBy = s.delivery.shown && !s.delivery.shown.none ? s.delivery.shown.screenshots : null;
    const attaching = s.tracker.pending.some((a) => a.event === event && a.op === 'attach');
    if (attaching && !shownBy && s.delivery.screenshots) return { performed, note: `${event} waits for the owner: show the delivered screenshots with their captions and run \`wf shown --file <f>\`; the API then uploads them with those captions`, state: s };
    let actions;
    try {
      // Each attachment is read once here, by the one safe reader; adapters get its bytes and never open a path.
      actions = s.tracker.pending.filter((a) => a.event === event).map((a) => (a.op === 'attach' ? { ...a, files: a.files.map((f) => ({ ...f, ...readEvidenceFile(root, s.id, f), caption: shownBy?.find((x) => x.sha256 === f.sha256)?.caption ?? null })) } : a.rendered === 'delivered' ? { ...a, body: deliveredComment(root, cfg, s)?.body ?? null } : a));
    } catch (error) {
      return { performed, note: `tracker ${via} (${event}) not performed: ${error.message}; nothing was sent, the actions stay pending`, state: s };
    }
    if (actions.some((a) => a.rendered === 'delivered' && !s.delivery.summary)) return { performed, note: `${event} waits for the owner's summary: \`wf summary --file <summary.md>\``, state: s };
    let raw;
    try {
      raw = await impl.perform({ token, url: endpoint, item: s.item, actions, root, cfg, state: s });
    } catch (error) {
      // Only the message, never the error object (a fetch error's cause can carry the request), scrubbed of the key.
      return { performed, note: `tracker ${via} (${event}) failed: ${scrub(String(error?.message ?? error), [token])}; the actions stay pending` };
    }
    const file = path.join(attemptDir(root, s.id), 'tracker', `${event}-${via}-${now().replace(/[:.]/g, '-')}.json`);
    prepareWrite(file);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    writeNoFollow(file, `${JSON.stringify(raw, null, 2)}\n`);
    s = await recordTracker(root, cfg, s, { event, capture: file, engineCapture: true });
    performed.push(event);
  }
  return { performed, note: null, state: s };
}
