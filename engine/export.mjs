import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from './config.mjs';
import { attemptDir } from './ledger.mjs';
import { evidenceSteps, noEvidenceVerdicts, readBundle } from './lifecycle.mjs';
import { redactor } from './secrets.mjs';
import { hashFile, now } from './util.mjs';

// One readable view of an attempt, built from the ledger and evidence. It is a VIEW: the ledger and the evidence
// files stay the source of truth. Works for a half-finished attempt. Every catalogued secret value is masked.

export const exportFile = (root, id, json = false) => path.join(attemptDir(root, id), 'export', json ? 'attempt.json' : 'attempt.html');

const PLAN_KEYS = ['summary', 'contract', 'anchors', 'tests', 'doNotRun', 'externalServices', 'agentSplit'];

export function exportData(root, s) {
  // Steps whose globs matched nothing although the ticket changed their package, with the latest review's verdict.
  const noEvidence = noEvidenceVerdicts(evidenceSteps(root, s), s.review?.closure);
  const steps = (g) => (g.steps ?? []).map((x) => ({ id: x.id, status: x.status, seconds: x.durationMs !== undefined && x.status !== 'reused' ? Math.round(x.durationMs / 100) / 10 : null, reusedFrom: x.reusedFrom ?? null, reason: x.reason ?? null }));
  return {
    exportedAt: now(),
    attempt: s.id,
    item: s.item,
    lane: s.lane,
    intent: s.intent,
    phase: s.phase,
    owner: s.owner,
    hold: s.activeHold?.reason ?? null,
    repos: Object.fromEntries(Object.entries(s.repos).map(([n, r]) => [n, { base: r.base, branch: r.branch }])),
    plan: s.plan ? (typeof s.plan === 'string' ? { summary: s.plan } : s.plan) : null,
    planSource: s.planSource ? { file: s.planSource.file ?? null, sha256: s.planSource.sha256 ?? null, agent: s.planSource.agent ?? null, provenance: s.planSource.provenance ?? null } : null,
    criteria: s.criteria ?? [],
    amendments: s.criteriaAmendments.map((a) => ({ at: a.at, by: a.by, reason: a.reason, changes: a.changes })),
    work: (s.work ?? []).map((w) => ({ ...w, agents: s.handoffs.filter((h) => h.role === 'implementer' && h.work === w.id).map((h) => h.agent) })),
    handoffs: s.handoffs.map((h) => ({ at: h.at, role: h.role, agent: h.agent, agentType: h.agentType ?? null, class: h.class ?? null, effort: h.effort ?? null, work: h.work ?? null })),
    reviews: (s.reviews ?? []).map((r) => ({ at: r.at, reviewer: r.reviewer, provenance: r.provenance, findings: (r.closure?.findings ?? []).map((f) => ({ id: f.id, severity: f.severity ?? null, status: f.status ?? 'open', summary: f.summary ?? '', work: f.work ?? null })), priorFindings: r.closure?.priorFindings ?? [], noEvidence: Array.isArray(r.closure?.noEvidence) ? r.closure.noEvidence : [] })),
    accepted: s.accepted ? { at: s.accepted.at, reviewer: s.accepted.reviewer } : null,
    gates: s.gates.map((g) => ({ at: g.at, runId: g.runId, status: g.status, focused: Boolean(g.focused), carried: Boolean(g.carriedFrom), steps: steps(g) })),
    checks: (s.checks ?? []).map((g) => ({ at: g.at, runId: g.runId, status: g.status, steps: steps(g) })),
    // What the last gate collected per `artifacts` glob: exactly the files the reviewer must inspect.
    evidence: (s.lastGate?.steps ?? []).filter((x) => x.artifactGlobs?.length).flatMap((x) => x.artifactGlobs.map((g) => ({ step: x.id, glob: g.glob, expanded: g.expanded, files: g.files.map((f) => ({ source: f.source, sha256: f.sha256 })) }))),
    noEvidence,
    rules: rulesView(s),
    outsidePlan: outsideView(s),
    flaky: s.flaky ?? [],
    tracker: { pending: s.tracker.pending.map((a) => ({ event: a.event, op: a.op, status: a.status ?? null })), done: s.tracker.done.map((d) => ({ event: d.event, at: d.at })) },
    delivery: { completedAt: s.delivery.completedAt, repos: Object.values(s.delivery.repos).map((d) => ({ repo: d.repo, commit: d.commit ?? null, skipped: d.skipped ?? null })) },
    // The delivered screenshots: what the owner was shown (with the caption given) and what the ticket got.
    delivered: deliveredView(s),
    closedAt: s.closedAt,
  };
}

// The rules the latest reviewer's bundle listed, with that round's verdicts (as accepted, when accepted).
function rulesView(s) {
  const h = s.handoffs.filter((x) => x.role === 'reviewer').at(-1);
  const listed = readBundle(h?.bundle).rules ?? [];
  const review = s.reviews.filter((r) => r.handoff === h?.bundle).at(-1);
  const given = s.accepted?.rules ?? (Array.isArray(review?.closure?.rules) ? review.closure.rules : []);
  return listed.map((r) => {
    const v = given.find((x) => x?.rule === r.id);
    return { rule: r.id, docs: r.docs ?? [], matched: r.matched.length, docChangedByTicket: r.docChangedByTicket, verdict: v?.verdict ?? null, evidence: v?.evidence ?? null, finding: v?.finding ?? null, reads: review?.reads?.status ?? null };
  });
}

// Changed files outside the plan the latest reviewer's bundle listed, with that round's verdicts (as accepted).
function outsideView(s) {
  const h = s.handoffs.filter((x) => x.role === 'reviewer').at(-1);
  const listed = readBundle(h?.bundle).outsidePlan ?? [];
  const review = s.reviews.filter((r) => r.handoff === h?.bundle).at(-1);
  const given = s.accepted?.outsidePlan ?? (Array.isArray(review?.closure?.outsidePlan) ? review.closure.outsidePlan : []);
  return listed.map((file) => {
    const v = given.find((x) => x?.file === file || x?.file === file.replace(/^[^:]+:/, ''));
    return { file, verdict: v?.verdict ?? null, by: v?.by ?? v?.finding ?? null, evidence: v?.evidence ?? null };
  });
}

function deliveredView(s) {
  const set = s.delivery.screenshots;
  if (!set) return null;
  const shown = s.delivery.shown;
  const attached = s.tracker.done.find((d) => d.event === 'delivered')?.attachments ?? [];
  return {
    none: set.none,
    narrowed: s.delivery.narrowed ? { from: s.delivery.narrowed.from, to: s.delivery.narrowed.to, dropped: s.delivery.narrowed.dropped, reason: s.delivery.narrowed.reason, by: s.delivery.narrowed.by, at: s.delivery.narrowed.at } : null,
    shownAt: shown && !shown.auto ? shown.at : null,
    shownBy: shown && !shown.auto ? shown.by : null,
    screenshots: set.screenshots.map((f) => {
      const c = shown?.screenshots?.find((x) => x.sha256 === f.sha256);
      return { title: f.title, source: f.source, path: f.path, sha256: f.sha256, caption: c?.caption ?? f.proposed, captionBy: c ? 'owner' : 'proposed', attached: attached.some((a) => a.sha256 === f.sha256) };
    }),
  };
}

const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' };
// Only the delivered set is embedded, as data URIs (no external requests), and only a file whose bytes still match
// the recorded sha256; any other is listed as changed or missing.
export function embedDelivered(d) {
  const images = {};
  for (const f of d.delivered?.screenshots ?? []) {
    if (!f.path || !fs.existsSync(f.path)) images[f.sha256] = { problem: 'file missing' };
    else if (hashFile(f.path) !== f.sha256) images[f.sha256] = { problem: 'file changed since the gate collected it' };
    else images[f.sha256] = { uri: `data:${MIME[path.extname(f.path).toLowerCase()] ?? 'application/octet-stream'};base64,${fs.readFileSync(f.path).toString('base64')}` };
  }
  return images;
}

function deliveredSection(d, images) {
  const v = d.delivered;
  if (!v) return '';
  if (!v.screenshots.length) return `<section><h2>Delivered screenshots</h2><p class="muted">No screenshots for this ticket: ${esc(v.none)}</p></section>`;
  const figs = v.screenshots.map((f, i) => {
    const img = images[f.sha256];
    const pic = img?.uri ? `<label class="shot"><input type="checkbox" aria-label="enlarge ${esc(f.title)}"><img src="${img.uri}" alt="${esc(f.caption)}" loading="lazy"></label>` : `<p class="warn">${esc(img?.problem ?? 'not embedded')}</p>`;
    return `<figure>${pic}<figcaption><strong>${i + 1}. ${esc(f.caption)}</strong>${f.captionBy === 'proposed' ? ' <span class="warn">(proposed, not yet shown to the owner)</span>' : ''}<br><small>${esc(f.title)} · sha256 ${esc(f.sha256.slice(0, 12))} · ${f.attached ? 'attached to the ticket' : 'not yet verified on the ticket'}</small></figcaption></figure>`;
  }).join('');
  const narrowed = v.narrowed ? `<p class="warn">Narrowed from ${esc(v.narrowed.from)} to ${esc(v.narrowed.to)}: ${esc(v.narrowed.reason)} (${esc(v.narrowed.by)}, ${esc(v.narrowed.at)})</p>` : '';
  return `<section><h2>Delivered screenshots</h2>${narrowed}<p class="muted">${v.shownAt ? `Shown to the owner ${esc(v.shownAt)}${v.shownBy ? ` by ${esc(v.shownBy)}` : ''}.` : 'Not yet shown to the owner (`wf shown`).'} Click an image to enlarge it.</p><div class="shots">${figs}</div></section>`;
}

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const block = (v) => (v === null || v === undefined ? '<p class="muted">none</p>' : typeof v === 'string' ? `<pre>${esc(v)}</pre>` : `<pre>${esc(JSON.stringify(v, null, 2))}</pre>`);
const table = (head, rows) => (rows.length ? `<div class="scroll"><table><tr>${head.map((h) => `<th>${esc(h)}</th>`).join('')}</tr>${rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('')}</table></div>` : '<p class="muted">none yet</p>');
const badge = (s) => `<span class="b b-${esc(String(s).replace(/[^\w-]/g, ''))}">${esc(s)}</span>`;

export function exportHtml(d, images = {}) {
  const sec = (title, body) => `<section><h2>${esc(title)}</h2>${body}</section>`;
  const plan = d.plan ? PLAN_KEYS.concat(Object.keys(d.plan).filter((k) => !PLAN_KEYS.includes(k))).filter((k) => d.plan[k] !== undefined).map((k) => `<h3>${esc(k)}</h3>${block(d.plan[k])}`).join('') : '<p class="muted">not frozen yet</p>';
  const missing = d.plan ? ['contract', 'anchors'].filter((k) => d.plan[k] === undefined) : [];
  const body = [
    `<header><h1>${esc(d.item)} <small>${esc(d.attempt)}</small></h1><p>${badge(d.phase)} lane ${esc(d.lane)} · intent ${esc(d.intent)} · owner ${esc(d.owner)}${d.hold ? ` · <strong>hold: ${esc(d.hold)}</strong>` : ''}</p><p class="muted">A view of the ledger and evidence, exported ${esc(d.exportedAt)}. The ledger is the source of truth.</p></header>`,
    sec('Plan', `${missing.length ? `<p class="warn">The frozen plan has no ${missing.join(' or ')} section.</p>` : ''}${plan}${d.planSource?.file ? `<p class="muted">raw: ${esc(d.planSource.file)} (sha256 ${esc((d.planSource.sha256 ?? '').slice(0, 12))})${d.planSource.provenance ? `, provenance ${esc(d.planSource.provenance)}` : ''}</p>` : ''}`),
    sec('Work items', table(['Work', 'Class', 'Criteria', 'Repos', 'Agents', 'Why'], d.work.map((w) => [esc(w.id), esc(w.class), esc((w.criteria ?? []).join(', ')), esc((w.repos ?? []).join(', ')), esc(w.agents.join(', ')), esc(w.why ?? '')]))),
    sec('Criteria', table(['Id', 'Text', 'UAT'], d.criteria.map((c) => [esc(c.id), esc(c.text), esc(c.uat === false ? 'no' : c.uat ?? '')])) + (d.amendments.length ? `<h3>Amendments</h3>${table(['At', 'By', 'Reason', 'Changed', 'Added', 'Dropped'], d.amendments.map((a) => [esc(a.at), esc(a.by), esc(a.reason), esc((a.changes?.changed ?? []).join(', ')), esc((a.changes?.added ?? []).join(', ')), esc((a.changes?.dropped ?? []).map((x) => `${x.id} (${x.reason})`).join(', '))]))}` : '')),
    sec('Handoffs', table(['At', 'Role', 'Agent', 'Work', 'Class', 'Effort'], d.handoffs.map((h) => [esc(h.at), esc(h.role), esc(h.agent), esc(h.work ?? ''), esc(h.class ?? ''), esc(h.effort ?? '')]))),
    sec('Review rounds', d.reviews.length ? d.reviews.map((r) => `<h3>${esc(r.reviewer)} <small>${esc(r.at)}${r.provenance ? ` · provenance ${esc(r.provenance)}` : ''}</small></h3>${table(['Finding', 'Severity', 'Status', 'Summary', 'Work'], r.findings.map((f) => [esc(f.id), esc(f.severity ?? ''), badge(f.status), esc(f.summary), esc(f.work ?? '')]))}${r.priorFindings.length ? `<p class="muted">verified from earlier rounds: ${r.priorFindings.map((p) => `${esc(p.round)}:${esc(p.id)} ${esc(p.status)}`).join(', ')}</p>` : ''}${r.noEvidence.length ? `<p class="muted">no-evidence verdicts: ${r.noEvidence.map((v) => `${esc(v.step)}: ${esc(v.reason ?? '')}`).join('; ')}</p>` : ''}`).join('') + (d.accepted ? `<p>${badge('accepted')} by ${esc(d.accepted.reviewer)} at ${esc(d.accepted.at)}</p>` : '') : '<p class="muted">none yet</p>'),
    sec('Gate runs', d.gates.length ? d.gates.map((g) => `<h3>${badge(g.status)} ${esc(g.runId)}${g.focused ? ' (focused)' : ''}${g.carried ? ' (carried to merged base)' : ''}</h3>${table(['Step', 'Status', 'Seconds', 'Reused from'], g.steps.map((x) => [esc(x.id), badge(x.status), esc(x.seconds ?? ''), esc(x.reusedFrom ?? '')]))}`).join('') : '<p class="muted">none yet</p>'),
    d.checks.length ? sec('Checks (light steps, never a gate)', d.checks.map((g) => `<h3>${badge(g.status)} ${esc(g.runId)}</h3>${table(['Step', 'Status', 'Seconds'], g.steps.map((x) => [esc(x.id), badge(x.status), esc(x.seconds ?? '')]))}`).join('')) : '',
    d.evidence.length ? sec('Gate evidence (last gate)', `<p class="muted">Each step's artifacts globs, expanded for this ticket. The reviewer inspects every file listed; nothing outside them is required. A glob that matched nothing means no screenshots for this ticket from it.</p>${table(['Step', 'Glob', 'Expanded', 'Files'], d.evidence.map((e) => [esc(e.step), esc(e.glob), esc(e.expanded.join(', ')), e.files.length ? e.files.map((f) => `${esc(f.source)} <small>${esc(f.sha256.slice(0, 12))}</small>`).join('<br>') : '<span class="muted">no screenshots for this ticket</span>']))}`) : '',
    d.noEvidence.length ? sec('Steps without captures', `<p class="muted">These steps' globs matched nothing although the ticket changed their package. Acceptance needs the reviewer's verdict on each: a reason no capture is needed, or a finding.</p>${table(['Step', 'Changed files', 'Globs', 'Verdict'], d.noEvidence.map((v) => [esc(v.step), esc(v.changed), esc(v.globs.join(', ')), v.reason ? esc(v.reason) : v.finding ? `finding ${esc(v.finding)}` : '<span class="warn">no verdict yet</span>']))}`) : '',
    d.rules.length ? sec('Rules', `<p class="muted">Project rule documents this change falls under (adapter at base, matched against the changed files); the reviewer reads each and gives a verdict.</p>${table(['Rule', 'Documents', 'Files matched', 'Verdict', 'Evidence', 'Read'], d.rules.map((r) => [esc(r.rule), esc(r.docs.join(', ')) + (r.docChangedByTicket ? ' <span class="warn">(changed by this ticket)</span>' : ''), esc(r.matched), r.verdict ? `${badge(r.verdict)}${r.finding ? ` ${esc(r.finding)}` : ''}` : '<span class="warn">no verdict yet</span>', esc(r.evidence ?? ''), esc(r.reads ?? '')]))}`) : '',
    d.outsidePlan.length ? sec('Outside the plan', `<p class="muted">Changed files no plan anchor or test path names. Each needs the reviewer's verdict: covered by a criterion, or a finding.</p>${table(['File', 'Verdict', 'By', 'Evidence'], d.outsidePlan.map((o) => [esc(o.file), o.verdict ? badge(o.verdict) : '<span class="warn">no verdict yet</span>', esc(o.by ?? ''), esc(o.evidence ?? '')]))}`) : '',
    d.flaky.length ? sec('Flaky', table(['Step', 'Failed run', 'Passed run', 'Suites'], d.flaky.map((f) => [esc(f.step), esc(f.failedRun), esc(f.passedRun), esc((f.suites ?? []).join(', '))]))) : '',
    sec('Tracker', table(['Event', 'State'], [...d.tracker.done.map((t) => [esc(t.event), `${badge('recorded')} ${esc(t.at)}`]), ...d.tracker.pending.map((t) => [esc(t.event), `${badge('pending')} ${esc(t.op)}${t.status ? ` ${esc(t.status)}` : ''}`])])),
    deliveredSection(d, images),
    sec('Delivery', d.delivery.completedAt ? `<p>${badge('delivered')} ${esc(d.delivery.completedAt)}</p>${table(['Repo', 'Commit'], d.delivery.repos.map((r) => [esc(r.repo), esc(r.commit ? r.commit.slice(0, 12) : r.skipped ?? '')]))}` : '<p class="muted">not delivered yet</p>'),
  ].join('\n');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(d.item)} attempt</title>
<style>
:root{--bg:#fbfbfa;--fg:#1d2327;--muted:#5d6870;--line:#dde1e4;--card:#fff;--ok:#1e7a46;--bad:#b4232c;--warn:#8a5a00;--chip:#eef1f3}
@media (prefers-color-scheme: dark){:root{--bg:#121619;--fg:#e4e8ea;--muted:#98a3aa;--line:#2b3338;--card:#181d21;--ok:#5fcf8f;--bad:#ff7b82;--warn:#f0c060;--chip:#232a2f}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,-apple-system,Segoe UI,sans-serif}
main{max-width:980px;margin:0 auto;padding:16px}header h1{margin:8px 0 4px;font-size:1.5rem}small{color:var(--muted);font-weight:400}
section{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px 16px;margin:14px 0}h2{font-size:1.1rem;margin:4px 0 8px}h3{font-size:.95rem;margin:12px 0 6px}
pre{white-space:pre-wrap;word-break:break-word;background:var(--chip);padding:8px 10px;border-radius:6px;margin:4px 0;font:13px/1.45 ui-monospace,Menlo,monospace}
.scroll{overflow-x:auto}table{border-collapse:collapse;width:100%;font-size:14px}td,th{padding:6px 8px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top}th{color:var(--muted);font-size:12px;text-transform:uppercase}
.muted{color:var(--muted)}.warn{color:var(--warn);font-weight:600}.b{display:inline-block;padding:1px 8px;border-radius:99px;background:var(--chip);font-size:12px}
.shots{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:12px}figure{margin:0}figcaption{font-size:13px;margin-top:4px}
.shot img{width:100%;border:1px solid var(--line);border-radius:6px;cursor:zoom-in;display:block}.shot input{position:absolute;opacity:0;pointer-events:none}
.shot input:checked+img{position:fixed;inset:0;margin:auto;width:auto;max-width:96vw;max-height:96vh;z-index:10;cursor:zoom-out;box-shadow:0 0 0 100vmax rgba(0,0,0,.8);background:var(--card)}
.b-complies,.b-covered,.b-passed,.b-fixed,.b-accepted,.b-delivered,.b-recorded,.b-done,.b-verified-nonissue,.b-reused{color:var(--ok)}.b-finding,.b-failed,.b-open,.b-interrupted{color:var(--bad)}.b-pending,.b-stopped{color:var(--warn)}
</style></head><body><main>
${body}
</main></body></html>
`;
}

// Secrets are masked in the page text; the embedded images are added after masking, so base64 is never rewritten.
function redactHtml(redact, data) {
  const images = embedDelivered(data);
  const marks = {};
  for (const [sha, img] of Object.entries(images)) if (img.uri) marks[sha] = { uri: `wf-image:${sha}` };
  let html = redact(exportHtml(data, marks));
  for (const [sha, img] of Object.entries(images)) if (img.uri) html = html.split(`wf-image:${sha}`).join(img.uri);
  return html;
}

export function exportAttempt(root, state, { out = null, json = false } = {}) {
  const data = exportData(root, state);
  let redact = (x) => x;
  try {
    redact = redactor(root, loadConfig(root));
  } catch {}
  const file = out ? path.resolve(String(out)) : exportFile(root, state.id, json);
  const text = json ? redact(`${JSON.stringify(data, null, 2)}\n`) : redactHtml(redact, data);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return { file, data, text };
}
