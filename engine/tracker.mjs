import { mkdirStateDirectory } from './state-folders.mjs';
import fs from 'node:fs';
import { detectOwner, findHost, hostIds, hostLabels, optional } from './hosts/index.mjs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { adapterFileAtCommit, loadConfigAtCommit, trustedAdapter } from './config.mjs';
import { append, attemptDir, listAttempts, loadState, recordedTogether } from './ledger.mjs';
import { loadCatalog, readSecret } from './secrets.mjs';
import { WfError, canonical, hashFile, now, readJson, refuse, sha256, writeImmutable } from './util.mjs';
import { home } from './provenance.mjs';
import { prepareWrite, readEvidenceFile, readRegular, writeNoFollow } from './evidence.mjs';
import { connectorCalls, ownerTranscript } from './host-record.mjs';
import { screenshots } from './gate.mjs';
import { findingSummary, lastReviewSeenAt, unreachedSince } from './review-policy.mjs';
import { cliEnv, scrub } from './scrub.mjs';

const BUILTIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'adapters', 'tracker');

// Project adapters are loaded as committed at the attempt's base, so a ticket cannot change how it is checked.
// `state` null: no attempt (doctor, a public-assets check), the working copy's file.
export async function loadTrackerAdapter(root, cfg, state) {
  const kind = cfg.tracker.kind;
  if (kind === 'none') return null;
  const file = kind.startsWith('.') ? (state ? adapterFileAtCommit(root, state, state.adapterBase, kind) : path.resolve(root, '.workflow', kind)) : path.join(BUILTIN, `${kind}.mjs`);
  if (!fs.existsSync(file)) throw new WfError(`tracker adapter \`${kind}\` not found at ${file}`);
  return (await import(pathToFileURL(file).href)).default;
}

// Named failure: a chat page id (a 32-character UUID) was admitted as the ticket item, worktrees were provisioned and a
// planner ran, and only the admission readback then refused it because the tracker named the ticket by its own
// identity. A ticket id is the tracker's identity: checked at entry, before anything is created. `tracker.itemPattern`
// (a regular expression) states it for a project adapter; the built-in trackers know theirs.
const ITEM_PATTERNS = { linear: '^[A-Za-z][A-Za-z0-9]*-\\d+$', github: '^(?:[A-Za-z][A-Za-z0-9]*-)?\\d{1,9}$' };
export function itemProblem(cfg, item) {
  const pattern = cfg.tracker.itemPattern ?? ITEM_PATTERNS[cfg.tracker.kind];
  if (!pattern || new RegExp(pattern).test(String(item))) return null;
  return `\`${item}\` is not a ticket id of the \`${cfg.tracker.kind}\` tracker (it must match ${pattern}); the tracker names a ticket by its own identity, so pass that id, not a page or database id`;
}

// Screenshots are uploaded before the comment, so the comment can embed each one by its asset url.
const DEFAULT_EVENTS = {
  admitted: ['read', { setStatus: 'started' }],
  implementing: ['read', { setStatus: 'started' }],
  integrating: [{ setStatus: 'inReview' }, { comment: 'reviewComment' }],
  delivered: [{ attach: 'screenshots' }, { comment: 'deliveredComment' }, { setStatus: 'delivered' }, 'readback'],
  reopened: [{ setStatus: 'started' }],
};

// I-11. Named failure: the owner saw zero images on the ticket. With no delivered comment template (or an events list
// that attaches screenshots without a comment) the screenshots went to the ticket only as attachments, which a tracker
// shows as link rows, and nothing checked that they were visible. A delivery with screenshots always posts the delivered
// comment that embeds them, from this built-in template when the project names none. A delivery without screenshots
// and without a template posts no comment, as before.
export const DEFAULT_DELIVERED_TEMPLATE = '{id} is ready for UAT.\n\nUAT scope:\n{uatScope}\n';
const hasShots = (state) => (state.delivery?.screenshots ? state.delivery.screenshots.screenshots.length : screenshots(state).length) > 0;
const templateRef = (cfg, key, state = null) => cfg.tracker[key] ?? (state && key === deliveredKey(cfg) && hasShots(state) ? DEFAULT_DELIVERED_TEMPLATE : null);

function renderTemplate(root, cfg, key, vars, state = null) {
  const ref = templateRef(cfg, key, state);
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

// I-142: an item whose level is always fixed in the delivery, left out because the person directed it, says so in their words
// (independent review of 0.7.12: the words lived only in the question, and the list read like any low left for later).
// The plain line the owner gave for an item when the person was asked about it (`--explain`), if any.
const plainFor = (state, id) => (id ? (state.decisions ?? []).find((x) => x.id === id)?.what : null) ?? null;
const directedBy = (state, id) => {
  const words = id ? (state.decisions ?? []).find((x) => x.id === id)?.personDirected : null;
  return words ? ` Left out at the person's direction: "${words}".` : '';
};

// Known limits and follow-ups, for the tester who reads the delivered comment: every item, once, in plain words. Nothing is
// counted away or capped: the tester sees each known issue, each scope a review named as not checked, each fix no reviewer
// saw and each follow-up. The engine's bookkeeping (ids, ratings, who decided, why it waits) stays in `wf deliver`'s output
// and `wf export`. Each line is the item's tester wording: the owner's line for it (`wf summary --explain`), else the plain
// line the person was asked with, else the first sentence its writer recorded (the role texts make that sentence plain; the
// detail after it is for engineers). Two items worded the same show once, so the owner can join items that read alike.
// Named failure (0.7.17): one delivered comment carried 53 lines, 25 of them per-round reviewer notes with file paths and
// test counts; the first fix counted the minor items away instead, hiding two a tester needed to see.
const firstSentence = (t) => {
  const s = String(t ?? '').replace(/^left by [^:]+:\s*/, '').replace(/^F\d+:\s*/, '').trim().replace(/\s+/g, ' ');
  // The end of the first sentence: a full stop or semicolon outside brackets, followed by a space or the end, after a word
  // longer than two letters (not "e.g", "i.e").
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    if ('(['.includes(s[i])) depth++;
    else if (')]'.includes(s[i]) && depth > 0) depth--;
    else if (!depth && '.;'.includes(s[i]) && (i + 1 === s.length || s[i + 1] === ' ') && !/[\s.][A-Za-z]{1,2}$/.test(s.slice(0, i))) return s.slice(0, i).replace(/[.\s]+$/, '');
  }
  return s.replace(/[.\s]+$/, '');
};
const ownLine = (state, ref) => {
  const own = state.delivery?.summary?.lines?.[ref];
  return typeof own === 'string' && own.trim() ? own.trim().replace(/\s+/g, ' ').replace(/[.\s]+$/, '') : null;
};
// One item's tester wording, never empty: the item's ref when nothing else is recorded.
const wording = (state, ref, text, decision = null) => ownLine(state, ref) ?? (plainFor(state, decision) ? firstSentence(plainFor(state, decision)) : null) ?? (firstSentence(text) || ref);

// Every item the delivered comment lists, with the ref the owner words it by (`ref: null` for lines already written for the
// tester: a criterion's `finalHandoff`, a dropped criterion's reason, a screenshot follow-up, a ticket).
export function limitItems(state, { load = null } = {}) {
  const items = [];
  const add = (ref, line) => items.push({ ref, line: line.replace(/\s*\n\s*/g, ' ') });
  for (const c of state.criteria ?? []) if (typeof c.finalHandoff === 'string' && c.finalHandoff.trim()) add(null, c.finalHandoff.trim());
  for (const a of state.criteriaAmendments ?? []) for (const d of a.changes?.dropped ?? []) add(null, `Not delivered: ${d.reason}`);
  // What is still known to be wrong (I-18), with the person's words when they directed it out of the ticket (I-142).
  for (const d of state.discovered ?? []) if (d.status === 'deferred') add(d.id, `Known issue: ${wording(state, d.id, d.summary, d.deferred?.source?.decision)}.${directedBy(state, d.deferred?.source?.decision)}`);
  for (const d of state.scopeDecisions ?? []) if (d.choice === 'deferred') for (const k of d.keys ?? []) add(k, `Known issue: ${wording(state, k, d.summaries?.[k] ?? findingSummary(state, k), d.decisionFor?.[k])}.${directedBy(state, d.decisionFor?.[k])}`);
  // Named failure (I-69): a review named scope it did not reach (`notReached`) and nothing the tester reads said so. Every
  // round since the last complete full audit counts: a delta round does not go back over an earlier round's gaps.
  for (const u of unreachedSince(state)) u.notReached.forEach((n, i) => add(`${u.round ?? u.reviewer ?? 'review'}:U${i + 1}`, `Not checked by review: ${wording(state, `${u.round ?? u.reviewer ?? 'review'}:U${i + 1}`, n)}.`));
  for (const a of state.delivery?.shown?.anomalies ?? []) if (a.followUp) add(null, `Follow-up: ${a.observation} (${a.followUp})`);
  // An item closed as fixed after the last review was not verified by any reviewer (0.7.8: information, not a stop).
  const lastReviewAt = lastReviewSeenAt(state) ?? '';
  for (const d of state.discovered ?? []) if (d.status === 'fixed' && d.kind !== 'bookkeeping' && !d.fixed?.verifiedBy && d.fixed?.at > lastReviewAt) add(d.id, `Fixed after the last review, not verified by a reviewer: ${wording(state, d.id, d.summary)}.`);
  for (const d of state.scopeDecisions ?? []) if (d.choice === 'fixed' && d.at > lastReviewAt) for (const k of d.keys ?? []) add(k, `Fixed after the last review, not verified by a reviewer: ${wording(state, k, findingSummary(state, k))}.`);
  // A review finding that is not fixed here (0.7.0): ticketed for later, or moved to a sibling attempt of the batch.
  for (const d of state.scopeDecisions ?? []) {
    if (d.choice === 'ticketed') add(null, `Follow-up ticket: ${d.ticket?.title ?? ''} ${d.ticket?.url ?? ''}`.trim() + [...new Set((d.keys ?? []).map((k) => directedBy(state, d.decisionFor?.[k])).filter(Boolean))].join(''));
    else if (d.choice === 'moved') {
      // I-123: a sibling that left this delivery (ejected, abandoned) still owes the item; the tester reads that it did not ship.
      let sib = null;
      try {
        sib = load ? load(d.sibling) : null;
      } catch {
        sib = null;
      }
      const together = sib && sib.phase !== 'abandoned' && (sib.batchOf ?? null) !== null && sib.batchOf === (state.batchOf ?? state.id);
      for (const k of d.keys ?? []) {
        const what = wording(state, k, findingSummary(state, k));
        add(k, sib && !together ? `Moved to ${d.sibling}, which is not in this delivery${sib.phase === 'abandoned' ? ' (abandoned)' : ''}: ${what} is still open there${d.reason ? ` (${d.reason})` : ''}` : `Follow-up moved to ${d.sibling}: ${what}${d.reason ? ` (${d.reason})` : ''}`);
      }
    }
  }
  return items;
}

export function knownLimits(state, options = {}) {
  const seen = new Set();
  const out = [];
  for (const { line } of limitItems(state, options)) {
    if (seen.has(line.toLowerCase())) continue;
    seen.add(line.toLowerCase());
    out.push(`- ${line}`);
  }
  return out.join('\n');
}

// For the owner (`wf summary`, `wf deliver`): each item the comment lists, by the ref to word it with.
export const limitItemsText = (state, { cfg = null, ...options } = {}) => {
  const items = limitItems(state, options).filter((x) => x.ref);
  // A line the readback would refuse as internals (a file path, a hash) is marked here, before the comment is posted.
  const flag = (line) => {
    const hits = cfg ? forbidden(cfg, line) : [];
    return hits.length ? `  [carries ${hits.join(', ')}: word it]` : '';
  };
  return items.length ? `\nknown limits by item, as the tester reads them (word any of them plainly for the tester: \`wf summary --explain <lines.json>\` with { "<ref>": "<one plain line>" }, merged into earlier wording, "" drops one; items worded the same show once):\n${items.map((x) => `  ${x.ref}  ${x.line}${flag(x.line)}`).join('\n')}` : '';
};

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

// The delivered event's steps: one that attaches screenshots always has the delivered comment after the uploads.
function deliveredSpec(cfg) {
  const spec = cfg.tracker.events?.delivered ?? DEFAULT_EVENTS.delivered;
  if (spec.some((x) => x?.comment) || !spec.some((x) => x?.attach === 'screenshots')) return spec;
  const at = spec.findIndex((x) => x?.attach === 'screenshots');
  return [...spec.slice(0, at + 1), { comment: 'deliveredComment' }, ...spec.slice(at + 1)];
}
function deliveredKey(cfg) {
  return deliveredSpec(cfg).find((s) => s?.comment)?.comment ?? null;
}

// Whether delivering this attempt posts a delivered comment (and so needs the owner's summary).
export function needsSummary(cfg, state) {
  if (cfg.tracker.kind === 'none' || ['quick', 'batch'].includes(state.lane)) return false;
  const key = deliveredKey(cfg);
  return Boolean(key && templateRef(cfg, key, state));
}

// The delivered comment: the template (its fixed lines are the header), the owner's plain-language summary, the UAT
// scope (user-visible criteria only), each delivered screenshot under its caption as an inline image, and the known
// limits. A template without `{summary}`, `{screenshots}` or `{limits}` gets them in that order: the summary after the
// first paragraph, the others at the end.
export function deliveredComment(root, cfg, state, assets = {}) {
  const key = deliveredKey(cfg);
  if (!key || !templateRef(cfg, key, state)) return null;
  const summary = state.delivery?.summary?.text ?? null;
  const limitsText = knownLimits(state, { load: (id) => loadState(root, id) });
  const vars = { id: state.item, url: '', uatScope: uatScope(state) || '- No user-visible change to check in the product.', summary: summary ?? '', screenshots: screenshotSection(state, assets), limits: limitsText ? `Known limits and follow-ups:\n${limitsText}` : '' };
  const rendered = renderTemplate(root, cfg, key, vars, state);
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
// Named failure (I-109): the file was written (and, on a refresh, rewritten in place) with no transaction and recorded in the
// manifest only when the process ended, so a `wf status` run in between was refused with "extra file (not written by wf)" or a
// size mismatch. It is written and recorded in one transaction.
export function writeDeliveredComment(root, cfg, state) {
  const c = deliveredComment(root, cfg, state);
  if (!c) return null;
  const file = commentFile(root, state.id);
  recordedTogether(root, state.id, () => {
    prepareWrite(file);
    mkdirStateDirectory(path.dirname(file), { recursive: true });
    writeNoFollow(file, c.body);
  });
  return file;
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
  // `--explain` alone words items against the summary already recorded.
  const keep = (!file || file === true) && options.explain !== undefined && state.delivery?.summary?.text ? state.delivery.summary.text : null;
  if ((!file || file === true) && keep === null) throw new WfError('--file <summary.md> is required: a few plain-language lines on what changed, for the person who tests it');
  if (!needsSummary(cfg, state)) throw refuse(`${state.id} posts no delivered comment (${cfg.tracker.kind === 'none' ? 'no tracker' : `lane ${state.lane}, or no delivered comment template`}); no summary is needed`);
  if (state.tracker.done.some((d) => d.event === 'delivered')) throw refuse('the delivered comment is already verified on the ticket; the summary can no longer change');
  // Posted to the tracker: read without following a link, a regular file with one name.
  const read = keep === null ? readRegular(path.resolve(String(file))) : null;
  if (keep === null && !read) throw refuse(`${file} is missing, a link or not a regular file with one name; the summary is not read through it`);
  const text = keep ?? read.bytes.toString('utf8').replace(/\r/g, '').trim();
  const problems = [];
  if (!text) problems.push('the summary is empty');
  if (/not user[- ]?visible/i.test(text)) problems.push('it contains "not user visible": write what changed for the person who tests it, and leave internal-only criteria out');
  const lines = text.split('\n').map((l) => l.replace(/^\s*[-*+]\s*/, '').trim().toLowerCase()).filter(Boolean);
  const verbatim = (state.criteria ?? []).filter((c) => String(c.text ?? '').trim().length >= 20 && lines.includes(String(c.text).trim().toLowerCase())).map((c) => c.id);
  if (verbatim.length) problems.push(`it repeats criteria text verbatim (${verbatim.join(', ')}); the UAT scope is added from the criteria, the summary says in plain words what changed`);
  const hits = forbidden(cfg, text);
  if (hits.length) problems.push(`it contains internals: ${hits.join(', ')}`);
  // The owner's tester wording for known-limit items (`--explain <lines.json>`: { "<ref>": "<one plain line>" }), merged per
  // ref into what earlier summaries recorded; "" or null drops a ref's wording.
  let own = null;
  if (options.explain !== undefined) {
    const rawLines = options.explain === true ? null : readRegular(path.resolve(String(options.explain)));
    let parsed = null;
    try {
      parsed = rawLines ? JSON.parse(rawLines.bytes.toString('utf8')) : null;
    } catch {
      parsed = null;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) problems.push('--explain is a regular JSON file { "<ref>": "<one plain line for the tester>" }, with the refs `wf summary` lists');
    else {
      const refs = new Set(limitItems(state).map((x) => x.ref).filter(Boolean));
      own = { ...(state.delivery?.summary?.lines ?? {}) };
      for (const [ref, v] of Object.entries(parsed)) {
        const line = String((typeof v === 'object' && v !== null ? v.what : v) ?? '').replace(/\s+/g, ' ').trim();
        if (!line && (refs.has(ref) || ref in own)) delete own[ref];
        else if (!refs.has(ref)) problems.push(`--explain names ${ref}, which is not a known-limit item of ${state.id} (its refs: ${[...refs].join(', ') || 'none'})`);
        else {
          const bad = forbidden(cfg, line);
          if (bad.length) problems.push(`--explain wording for ${ref} contains internals: ${bad.join(', ')}`);
          own[ref] = line;
        }
      }
    }
  }
  if (problems.length) throw refuse(`summary refused:\n  - ${problems.join('\n  - ')}`);
  const n = (state.delivery.summaries ?? 0) + 1;
  const raw = path.join(attemptDir(root, state.id), 'delivery', `summary-${n}.raw.md`);
  // Named failure (I-109): the raw summary was written, and the comment refreshed from it, outside any transaction and recorded
  // only when the process ended (`wf deliver --summary-file` goes on to push for minutes). One transaction holds the summary, its
  // ledger entry and the refreshed comment.
  return recordedTogether(root, state.id, () => {
    writeImmutable(raw, `${text}\n`);
    append(root, state.id, 'delivery.summary', { text, sha256: sha256(text), raw: { path: raw, sha256: hashFile(raw) }, ...(own ? { lines: own } : {}) }, options.actorId ?? null);
    const after = loadState(root, state.id);
    if (after.delivery.completedAt) writeDeliveredComment(root, cfg, after);
    return after;
  });
}

// Turns an engine event into the concrete actions the agent (or adapter) must perform.
export function trackerActions(root, cfg, state, event, extra = {}) {
  if (cfg.tracker.kind === 'none') return [];
  const spec = event === 'delivered' ? deliveredSpec(cfg) : cfg.tracker.events?.[event] ?? DEFAULT_EVENTS[event] ?? [];
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
      if (event === 'delivered' && templateRef(cfg, step.comment, state)) {
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
  mkdirStateDirectory(dir, { recursive: true });
  const capture = path.join(dir, `${event}-${tools.read}-${read.resultLine}.json`);
  writeNoFollow(capture, read.result);
  let comments = null;
  // A comment edited in place is saved by the comment's own id, with no issue named; it is the owner's when the ticket's
  // comment list holds that id (named failure, 0.7.17 review: an edited comment was refused as not posted by the owner).
  let listedIds = [];
  if (pending.some((a) => a.op === 'comment')) {
    const list = calls.filter((c) => c.tool === tools.comments && forItem(c, ids) && after(c)).sort((a, b) => b.resultLine - a.resultLine)[0];
    if (!list) throw refuse(`no host-recorded readback: the owner's transcript has no ${tools.comments} result for ${state.item} after ${event === 'delivered' ? 'delivery' : 'the event'}`, `call the connector's ${tools.comments} for ${state.item} now, then run this again`);
    const listed = parseJson(list.result);
    listedIds = (Array.isArray(listed) ? listed : (listed?.comments ?? listed?.nodes ?? [])).map((c) => c?.id).filter((x) => x !== undefined && x !== null).map(String);
    comments = path.join(dir, `${event}-${tools.comments}-${list.resultLine}.json`);
    writeNoFollow(comments, list.result);
  }
  const edit = (c) => (tools.comment ?? []).includes(c.tool) && c.input?.id !== undefined && listedIds.includes(String(c.input.id));
  const mine = calls.filter((c) => (forItem(c, ids) || edit(c)) && (!since || (c.calledAt && Date.parse(c.calledAt) >= Date.parse(since))));
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

// `wf tracker record --agent-reported --file reported.json [--comment-file posted.md]`, connector mode only. In some
// harnesses the connector's tool results arrive inline in the chat, not as saved files, so the raw-capture path could only
// be met by retyping them (named failure: ~35 KB of signed URLs retyped, which proves nothing). Here the agent reports
// what the tracker showed it, and the engine checks what it can: the item, the status, the posted comment's text (its
// sha256, the template's fixed lines, the owner's summary, an image for every delivered screenshot, no internals), the
// attachment titles and captions, and a read time after delivery that no earlier readback used. Additions the owner
// made to the comment are allowed and listed. It is recorded as agent-reported, unverified: the engine never saw the
// tracker's answer.
// Named failure (0.5.0 integration review): the agent-reported attachment urls were written to the ledger as reported,
// signed query strings included, so a tracker's upload signature (a credential for the file) was kept in the evidence
// that `wf export` renders. Only an https url without its query or fragment is recorded.
function reportedAssetUrl(x) {
  const u = String(x?.assetUrl ?? x?.url ?? '').split(/[?#]/)[0];
  return /^https:\/\/[^\s@]+$/.test(u) ? u.slice(0, 2048) : null;
}

async function recordAgentReported(root, cfg, state, options, event, pending) {
  if (cfg.tracker.via !== 'connector') throw refuse(`\`--agent-reported\` is for \`tracker.via: connector\`; with \`${cfg.tracker.via}\` the engine performs and verifies the handoff itself (\`wf tracker sync\`)`);
  if (typeof options.file !== 'string') throw new WfError('--file <reported.json> is required: { issue, status, comment: { id, bodySha256, createdAt }, attachments: [{ title, subtitle, assetUrl }], readAt }');
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
      const tpl = renderTemplate(root, cfg, a.templateKey, {}, state);
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
        // I-11: an image counts only by the url of the upload the agent reports for that screenshot. Named failure: an
        // image matched by its alt text alone passed, so a comment still holding `{assetUrl:<title>}` (no image on the
        // ticket) was recorded as delivered.
        const refs = imageRefs(body);
        const listed = Array.isArray(r.attachments) ? r.attachments : [];
        const noImage = [];
        for (const f of state.delivery.screenshots?.screenshots ?? []) {
          const asset = listed.filter((x) => x.title === f.title || x.filename === f.title).map((x) => String(x.assetUrl ?? x.url ?? '').split('?')[0]).find((u) => /^https:\/\/\S+$/.test(u));
          if (!asset) noImage.push(`${f.title}: the report gives no \`assetUrl\` (https) for its upload`);
          else if (!refs.some((x) => x.path === asset)) noImage.push(`${f.title}: no \`![${f.title}](${asset})\` in the comment`);
        }
        const left = body.match(/\{assetUrl:[^}]*\}/g);
        if (left) problems.push(`the comment still holds ${left.length} placeholder(s) (${[...new Set(left)].join(', ')}): the ticket shows no image there; replace each with the assetUrl its upload returned`);
        if (noImage.length) problems.push(`the comment shows no image for ${noImage.length} delivered screenshot(s); an attachment alone shows on the ticket only as a link row, so each screenshot is embedded as \`![<title>](<assetUrl>)\` under its caption, by the assetUrl of its upload:\n    - ${noImage.join('\n    - ')}`);
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
  // Named failure (I-109): the report and the posted comment were written outside any transaction and recorded in the manifest only
  // when the process ended. The files, their entry in the ledger and their record in the manifest are one transaction now.
  recordedTogether(root, state.id, () => {
    writeImmutable(dest, reportText);
    let commentRec = null;
    if (comment) {
      const cdest = path.join(attemptDir(root, state.id), 'tracker', `${event}-posted-comment.md`);
      writeImmutable(cdest, comment.text);
      commentRec = { path: cdest, sha256: comment.sha256, id: r.comment?.id ?? null };
    }
    append(root, state.id, 'tracker.recorded', { event, provenance: AGENT_REPORTED, verified: false, mode: 'agent-reported', capture: { path: dest, sha256: hashFile(dest) }, readAt: r.readAt, status: r.status ?? null, ...(commentRec ? { comment: commentRec } : {}), ...(extra.length ? { extraLines: extra.slice(0, 50).map((l) => scrub(l)) } : {}), attachments: (Array.isArray(r.attachments) ? r.attachments : []).slice(0, 200).map((x) => ({ title: x?.title ?? null, caption: x?.subtitle ?? null, assetUrl: reportedAssetUrl(x) })) }, null);
  });
  return loadState(root, state.id);
}

// The engine's own readback as the tracker answered it, kept beside the capture that cites it (inside a recorded transaction).
function writeEngineAnswer(engine) {
  prepareWrite(engine.file);
  mkdirStateDirectory(path.dirname(engine.file), { recursive: true });
  writeNoFollow(engine.file, engine.text);
}

export async function recordTracker(root, cfg, state, options) {
  if (cfg.tracker.kind === 'none') throw refuse('this project has no tracker (`tracker.kind: none`)');
  const event = options.event;
  if (!event) throw new WfError('--event is required');
  const pending = state.tracker.pending.filter((a) => a.event === event);
  if (!pending.length) throw refuse(`no pending tracker actions for event \`${event}\``);
  if (options['agent-reported']) return recordAgentReported(root, cfg, state, options, event, pending);
  if (options['from-transcript']) return recordFromTranscript(root, cfg, state, options, event, pending, await loadTrackerAdapter(root, cfg, state));
  // The engine's own readback (`performTracker`) arrives as { file, text }: its bytes are in hand, and the file they are kept in is
  // written with the rest of the record, not before (below).
  const engine = options.engineCapture && typeof options.engineCapture === 'object' ? options.engineCapture : null;
  if (!options.capture && !engine) throw new WfError(`--capture <file> is required: the raw tracker response the agent saved${cfg.tracker.via === 'connector' ? ' (or, when the tool results are only in the chat, `--agent-reported --file <reported.json> --comment-file <posted.md>`)' : ''}`);
  // The engine's own answer is kept whatever stops its reading (final review of 0.7.4: an adapter that failed to load or to
  // read the answer lost it, though the engine had already acted on the tracker).
  const keepingAnswer = (error) => {
    if (engine) recordedTogether(root, state.id, () => writeEngineAnswer(engine));
    throw error;
  };
  const adapter = await loadTrackerAdapter(root, cfg, state).catch(keepingAnswer);
  const capturePath = engine ? engine.file : path.resolve(String(options.capture));
  // Read once: the bytes checked are the bytes kept (and the ones hashed for the recycled-capture check). With
  // --comments, the two saved tool results (get_issue, list_comments) are kept together, unchanged, as one list.
  const commentsPath = typeof options.comments === 'string' ? path.resolve(options.comments) : null;
  const captureText = engine ? engine.text : commentsPath ? `[${fs.readFileSync(capturePath, 'utf8').trim()},\n${fs.readFileSync(commentsPath, 'utf8').trim()}]\n` : fs.readFileSync(capturePath, 'utf8');
  const provenance = options.engineCapture ? 'engine (tracker API)' : options.hostRecorded ? HOST_RECORDED : captureProvenance([capturePath, ...(commentsPath ? [commentsPath] : [])]);
  const extraLines = [];
  let raw;
  try {
    raw = JSON.parse(captureText);
  } catch (error) {
    keepingAnswer(new WfError(`invalid JSON in ${capturePath}: ${error.message}`));
  }
  let issue;
  try {
    issue = adapter.normalize(raw);
  } catch (error) {
    keepingAnswer(error);
  }
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
      const tpl = renderTemplate(root, cfg, a.templateKey, {}, state);
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
          problems.push(`the posted comment is not the one \`wf\` rendered (summary sha256 ${expected.summary ? sha256(expected.summary).slice(0, 12) : 'none'}); first difference at line ${at + 1}: expected ${JSON.stringify(want[at] ?? '(end)')}, posted ${JSON.stringify(got[at] ?? '(end)')}. Post ${commentFile(root, state.id)} unchanged, with each {assetUrl:<title>} replaced by that upload's assetUrl; when a comment is already posted, edit that comment to it in place (an edited comment counts), so the ticket keeps one`);
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
  if (problems.length) {
    // The engine had already acted on the tracker when it read this answer back: the answer is kept though it failed the checks, so
    // the failure can be read against what the tracker holds (as it always was), written and recorded in one transaction.
    if (engine) recordedTogether(root, state.id, () => writeEngineAnswer(engine));
    throw refuse(`tracker readback for \`${event}\` failed:\n  - ${problems.join('\n  - ')}`);
  }
  const dest = path.join(attemptDir(root, state.id), 'tracker', `${event}-capture.json`);
  const level = options.engineCapture ? 'engine-read' : options.hostRecorded ? 'host-recorded' : provenance === 'host tool-result file' ? 'host-saved' : false;
  const host = options.hostRecorded ? { runtime: options.hostRecorded.runtime, transcript: options.hostRecorded.transcript, lines: options.hostRecorded.lines, posted: { comments: options.hostRecorded.posted.comments.map((b) => sha256(b)), statuses: options.hostRecorded.posted.statuses, attachments: options.hostRecorded.posted.attachments } } : null;
  // Named failure (I-109): the capture was written (and, for the engine's own readback, the raw answer beside it) with no
  // transaction and recorded in the manifest only when the process ended; the engine's tracker loop made the next network call
  // with the previous event's files still unrecorded, so a `wf status` run meanwhile was refused with "extra file (not written
  // by wf)". The readback is awaited first and the files, the ledger entry and their record follow in one transaction.
  recordedTogether(root, state.id, () => {
    if (engine) writeEngineAnswer(engine);
    writeImmutable(dest, captureText);
    append(root, state.id, 'tracker.recorded', { event, provenance, verified: level, capture: { path: dest, sha256: hashFile(dest) }, status: issue.status, ...(host ? { host } : {}), ...(extraLines.length ? { extraLines: extraLines.slice(0, 50).map((l) => scrub(l)) } : {}), ...(verified.length ? { attachments: verified } : {}) }, null);
  });
  return loadState(root, state.id);
}

// Doctor: the tracker mode and what it costs. api: the key must be there. agent (connector): the readback is only what
// the agent saved, so the engine cannot prove it is the tracker's raw answer; say so and how to switch.
// What wf can verify for each kind x via, said by `wf doctor` and the docs.
export const VERIFIABLE = {
  'linear/api': 'the engine posts, uploads and reads back itself through the API: status, comment body, every attachment (title, caption) and its embedding are checked on the tracker\'s own answer; uploaded bytes are trusted (no hash from the tracker)',
  'linear/connector': 'the agent acts through its connector; the readback is host-recorded where the host keeps a transcript (`wf tracker record --from-transcript`: the tracker\'s answer as ' + hostLabels() + ' recorded it, checked like an API readback), else a saved tool-result file, else agent-reported (`--agent-reported`: checked as reported, recorded unverified)',
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
    const s = detectOwner();
    const owning = findHost(s?.runtime);
    const store = optional(owning, 'storeDir')?.(home()) ?? null;
    const level = !adapter?.connectorTools ? 'agent-reported (this adapter names no connector tools)' : store && fs.existsSync(store) ? `host-recorded (${owning.label} transcripts at ${store}; run the connector actions, then \`wf tracker record --event <e> --from-transcript\`)` : `agent-reported in this shell (no ${hostLabels()} session); host-recorded when the owner runs wf from ${hostLabels()}`;
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

// Where a connector readback came from: a tool-result file a harness saved itself (its adapter says which files those
// are), or anything else, which is only what the agent reports.
export function captureProvenance(files) {
  const home = process.env.HOME ?? '';
  const saved = (f) => hostIds().some((id) => optional(findHost(id), 'isSavedToolResult')?.(String(f), { home }));
  return files.length && files.every(saved) ? 'host tool-result file' : 'agent-reported, unverified';
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
  const adapter = await loadTrackerAdapter(root, cfg, state);
  const impl = adapter?.[via];
  if (!impl?.perform) return { performed: [], note: `the \`${cfg.tracker.kind}\` tracker adapter has no \`${via}\` mode; perform the actions through the connector` };
  // Endpoints, repository and folder as committed at the attempt's base, never the working copy.
  let trusted;
  try {
    trusted = trustedAdapter(root, state);
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
    // The network answer is in hand; nothing is written into the evidence until `recordTracker` writes it with the record that
    // cites it, in one transaction (I-109). The lock is never held across the call above.
    const file = path.join(attemptDir(root, s.id), 'tracker', `${event}-${via}-${now().replace(/[:.]/g, '-')}.json`);
    s = await recordTracker(root, cfg, s, { event, engineCapture: { file, text: `${JSON.stringify(raw, null, 2)}\n` } });
    performed.push(event);
  }
  return { performed, note: null, state: s };
}
