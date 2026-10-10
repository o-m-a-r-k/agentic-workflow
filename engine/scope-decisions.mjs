// Named failure: unrelated baseline diagnostics silently expanded a tooling-only change into product repairs.
// Scope is causal, not a filename list. Missing metadata always remains blocking.
import path from 'node:path';
import { ownerTranscript } from './host-record.mjs';
import { actor, openState } from './attempt.mjs';
import { append, loadState, attemptDir } from './ledger.mjs';
import { ownerAuthority } from './owner.mjs';
import { readRegular } from './evidence.mjs';
import { hashValue, hashFile, sha256, writeImmutable, refuse, WfError } from './util.mjs';

const text = (x) => typeof x === 'string' ? x.trim() : '';
const settled = (f) => ['fixed', 'verified-nonissue'].includes(f.status);
export function extraScope(f) {
  const s = f?.scope;
  return s?.kind === 'extra' && text(s.issue) && text(s.reason) && text(s.baseEvidence) && text(s.currentEvidence)
    && s.requiredByRequest === false && s.causedByChange === false
    && s.affectsChangedContract === false && s.requiredValidation === false;
}
export function scopeProblems(findings) {
  const problems = [];
  for (const f of findings ?? []) {
    if (!f.scope) continue; // Older closures remain conservative: every finding blocks.
    if (!['in', 'extra', 'uncertain'].includes(f.scope.kind)) problems.push(`${f.id}: scope.kind is in, extra or uncertain`);
    if (f.scope.kind === 'extra' && !extraScope(f)) problems.push(`${f.id}: extra scope needs a stable issue key, reason, base/current evidence and four explicit false causal checks`);
  }
  return problems;
}
export const scopeKey = (f) => extraScope(f) ? hashValue({ issue: f.scope.issue, base: f.scope.baseEvidence, current: f.scope.currentEvidence, reason: f.scope.reason }) : null;
export function disposition(state, f) {
  if (!extraScope(f)) return null;
  return (state.scopeDecisions ?? []).filter((d) => d.keys.includes(scopeKey(f))).at(-1) ?? (state.scopeDecisions ?? []).filter((d) => d.all && d.choice === 'expand').at(-1) ?? null;
}
export const waivedFinding = (state, f) => ['ignore', 'ticketed'].includes(disposition(state, f)?.choice);
export const blockingFindings = (state, review = state.review) => (review?.closure?.findings ?? []).filter((f) => !settled(f) && !waivedFinding(state, f));

export function scopeFindings(state) {
  const last = new Map();
  for (const r of state.reviews ?? []) last.set(r.handoff ?? r.reviewer, r);
  const rows = new Map();
  for (const r of last.values()) for (const f of r.closure?.findings ?? []) {
    if (!extraScope(f)) continue;
    const key = scopeKey(f);
    if (settled(f)) { rows.delete(key); continue; }
    rows.set(key, { key, finding: `${r.reviewer}:${f.id}`, summary: f.summary, scope: f.scope, at: r.at, decision: disposition(state, f) });
  }
  for (const d of state.discovered ?? []) if (d.status === 'open' && extraScope(d)) {
    const key = scopeKey(d);
    rows.set(key, { key, finding: `discovered:${d.id}`, summary: d.summary, scope: d.scope, at: d.at, decision: disposition(state, d) });
  }
  return [...rows.values()];
}
export const pendingScope = (state) => scopeFindings(state).filter((r) => !r.decision || r.decision.choice === 'ticket');
export function scopeGuidance(state) {
  const rows = pendingScope(state);
  if (!rows.length) return null;
  if (rows.every((r) => r.decision?.choice === 'ticket')) return `Create the owner-authorized follow-up tickets for ${rows.map((r) => r.finding).join(', ')} and record each actual raw readback with \`wf scope ticket --finding <id> --capture <raw.json>\`; creation failure stays pending. In-scope repairs still block.`;
  return `Scope increase: ${rows.map((r) => `${r.finding}: ${r.summary}`).join('; ')}. These findings are unrelated to the requested changes; no repair is authorized yet. Run \`wf scope ask\`, report their impact and base/current evidence, and ask: increase scope and fix, create tickets for later, or ignore for this attempt. In-scope and uncertain findings still require repairs.`;
}
export function scopeHandoffProblems(state) {
  const problems = [];
  if (pendingScope(state).length) problems.push('extra-scope findings await the owner decision or ticket readback; use `wf scope ask`');
  for (const row of scopeFindings(state).filter((r) => r.decision?.choice === 'expand')) {
    if (!(state.criteriaAmendments ?? []).some((a) => a.at >= row.decision.at && a.at >= row.at && (a.scopeKeys ?? []).includes(row.key))) problems.push('approved scope increase needs a criteria/impact amendment with `scopeFindings` before implementation');
  }
  return problems;
}
const signature = (rows) => hashValue(rows.map((r) => r.key).sort());
export function askScope(root, options) {
  const state = openState(root, options);
  const rows = pendingScope(state).filter((r) => !r.decision);
  if (!rows.length) throw refuse('no unrelated finding awaits a scope choice; pending ticket creation needs `wf scope ticket --capture <raw readback>`');
  const keys = rows.map((r) => r.key).sort();
  const prior = state.scopePrompt;
  if (!prior || prior.owner !== state.owner || signature(rows) !== prior.signature) {
    const host = ownerTranscript(state.owner);
    const captured = !host.problem && readRegular(host.file);
    if (!captured && /^(?:codex|claude):/.test(state.owner)) throw refuse('owner transcript cannot be anchored; no scope question can grant authority');
    const anchor = captured ? { file: host.file, size: captured.bytes.length, sha256: sha256(captured.bytes) } : null;
    append(root, state.id, 'scope.asked', { keys, signature: signature(rows), anchor, owner: state.owner }, actor(options));
  }
  return { state: loadState(root, state.id), findings: rows, prompt: 'These existing defects are unrelated to this change. Fixing them increases scope. Choose: increase scope and fix; create tickets for later; or ignore for this attempt. You can also say continue fixing all to authorize future extra-scope repairs in this attempt.' };
}
export function decideScope(root, options) {
  const state = openState(root, options);
  const choice = text(options.choice);
  if (!['expand', 'expand-all', 'ticket', 'ignore'].includes(choice)) throw new WfError('--choice is expand, expand-all, ticket or ignore');
  const rows = pendingScope(state).filter((r) => !r.decision);
  const prompt = state.scopePrompt;
  if (!prompt || !rows.length || prompt.signature !== signature(rows)) throw refuse('show the current findings with `wf scope ask` before recording a decision');
  // Only the direct human reply after this precise question supplies authority. Existing owner decisions are unchanged.
  const authority = ownerAuthority(root, { ...state, admittedAt: prompt.at }, `scope ${state.id}:${choice}`, {
    what: `choosing ${choice} for the reported scope increase`, decision: `scope:${state.id}:${prompt.signature}:${choice}`,
    scopeChoice: choice, scopeAnchor: prompt.anchor, interactive: true,
  });
  append(root, state.id, 'scope.decided', { keys: prompt.keys, choice: choice === 'expand-all' ? 'expand' : choice, all: choice === 'expand-all', authority, prompt: prompt.signature }, actor(options));
  return loadState(root, state.id);
}
export function completeScopeTicket(root, options) {
  const state = openState(root, options);
  const row = scopeFindings(state).find((r) => r.finding === options.finding);
  if (!row || row.decision?.choice !== 'ticket') throw refuse('this finding has no owner-authorized pending ticket choice');
  if (typeof options.capture !== 'string') throw new WfError('--capture is the tracker raw readback saved after creating the follow-up');
  const raw = readRegular(path.resolve(options.capture));
  if (!raw || raw.bytes.length > 1024 * 1024) throw refuse('ticket readback must be a regular file at most 1 MiB');
  let data;
  try { data = JSON.parse(raw.bytes.toString('utf8')); } catch { throw refuse('ticket readback is not JSON'); }
  const issue = data.issue ?? data;
  const id = text(issue.identifier) || text(issue.id);
  const url = text(issue.url) || text(issue.web_url);
  if (!id || !text(issue.title) || !/^https:\/\//.test(url)) throw refuse('raw ticket readback must contain issue id/identifier, title and HTTPS url; failed creation stays pending');
  const file = path.join(attemptDir(root, state.id), 'scope', `${row.key}.ticket.json`);
  writeImmutable(file, raw.bytes.toString('utf8'));
  append(root, state.id, 'scope.ticketed', { keys: [row.key], choice: 'ticketed', raw: { file, sha256: hashFile(file) }, ticket: { id, url, title: issue.title, capture: file, provenance: 'agent-reported-raw-readback' }, authority: row.decision.authority }, actor(options));
  return loadState(root, state.id);
}

export function effectiveDiscoveries(state, entries = state.discovered ?? []) {
  return entries.map((d) => waivedFinding(state, d) ? { ...d, status: 'deferred', deferred: { decision: disposition(state, d).authority?.text, source: disposition(state, d).authority, scopeDecision: true } } : d);
}
