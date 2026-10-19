// The person's daily digest (design section 2): what waits on them across the project's attempts, in one place. Open
// reserved decisions (sign-offs, stops, priority findings), pending diff-reads, merges waiting on a click, and the
// findings outside the goal that the project sends to the digest. A blocking question is also asked at once by whoever
// asked it; the digest only gathers.
import fs from 'node:fs';
import path from 'node:path';
import { WfError, listAttempts, loadAdapter, readEvents, userDir } from './contract.mjs';
import { PROJECT_LEDGER, decisionsOf, stillHolds } from './decisions.mjs';

const clip = (s, n = 200) => (String(s).length > n ? `${String(s).slice(0, n - 1)}…` : String(s));

async function attemptFacts(root, attempt) {
  let events;
  try {
    events = await readEvents(root, attempt);
  } catch {
    return null;
  }
  const started = events.find((e) => e.type === 'attempt.started');
  if (!started || started.schema !== 2) return null; // a 0.7 ledger holds no 0.8 decision or stage
  const findings = new Map();
  const stages = new Map();
  const filed = [];
  for (const e of events) {
    if (e.type === 'review.recorded') for (const f of e.data.findings ?? []) findings.set(f.id, f);
    else if (e.type === 'stage') stages.set(e.data.index, { ...e.data, at: e.at });
    else if (e.type === 'finding.filed') filed.push({ ...e.data, at: e.at });
  }
  return { item: started.data.item, closed: events.some((e) => e.type === 'attempt.closed'), findings, stages, filed };
}

export async function digest(root, opts = {}) {
  const since = opts.since ? Date.parse(opts.since) : 0;
  const items = [];
  const question = (d, item) => ({ kind: d.kind === 'diff-read' ? 'diff-read' : 'decision', attempt: d.attempt, item, id: d.id, decision: d.kind, blocking: d.blocking, question: d.question, options: d.options, refs: d.refs, at: d.askedAt });
  const open = (d) => !d.answer || !stillHolds(d, d.answer); // an answer the transcript no longer shows is not one
  for (const d of (await decisionsOf(root, null)).values()) if (open(d)) items.push(question(d, null));
  for (const attempt of await listAttempts(root)) {
    if (attempt === PROJECT_LEDGER) continue;
    const f = await attemptFacts(root, attempt);
    if (!f || f.closed) continue;
    for (const d of (await decisionsOf(root, attempt)).values()) if (open(d)) items.push(question(d, f.item));
    for (const s of f.stages.values()) {
      if (s.do === 'wait-merged' && s.state === 'waiting') items.push({ kind: 'merge', attempt, item: f.item, repo: s.repo ?? null, evidence: s.evidence ?? null, next: s.next ?? null, at: s.at });
    }
    for (const x of f.filed) {
      if (x.mode !== 'digest' || x.priority || Date.parse(x.at) < since) continue;
      const finding = typeof x.finding === 'string' ? f.findings.get(x.finding) ?? { id: x.finding } : x.finding;
      items.push({ kind: 'finding', attempt, item: f.item, id: finding.id, location: finding.location ?? null, severity: finding.severity ?? null, what: finding.what ?? null, why: finding.why ?? null, at: x.at });
    }
  }
  return { items, text: render(items) };
}

function render(items) {
  const of = (k) => items.filter((i) => i.kind === k);
  const where = (i) => (i.attempt ? `${i.item ?? i.attempt} (${i.attempt})` : 'project');
  const approve = (i) => `wf approve ${i.id}${i.attempt ? ` --attempt ${i.attempt}` : ''} --choice <option>`;
  const lines = [];
  const section = (title, list, line) => {
    if (!list.length) return;
    lines.push(`${title} (${list.length}):`);
    for (const i of list) lines.push(`- ${line(i)}`);
    lines.push('');
  };
  section('Questions for you', of('decision'), (i) => `${where(i)} ${i.id}${i.blocking ? ', holding the ticket' : ''}: ${i.question} Options: ${i.options.join(' | ')}. Answer in the chat, or: ${approve(i)}`);
  section('Diff-reads', of('diff-read'), (i) => `${where(i)} ${i.id}: ${i.question} Options: ${i.options.join(' | ')}`);
  section('Merges waiting for your click', of('merge'), (i) => `${where(i)}${i.repo ? ` ${i.repo}` : ''}: ${clip(i.next ?? (typeof i.evidence === 'string' ? i.evidence : JSON.stringify(i.evidence)))}`);
  section('Found outside the goal', of('finding'), (i) => `${where(i)} ${i.id}${i.severity ? ` (${i.severity})` : ''}${i.location ? ` ${i.location}` : ''}: ${clip(i.what ?? '')}`);
  return lines.length ? lines.join('\n').trim() : 'Nothing waits on you.';
}

const day = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

// `wf digest`: today's digest, written to the user folder. Findings already in an earlier day's digest are not repeated;
// open questions are, until answered.
export async function cmdDigest(ctx, args = {}) {
  if (!ctx.root) throw new WfError('no agentic-workflow project here: run wf in a project folder');
  let name = path.basename(ctx.root);
  try {
    name = (await loadAdapter(ctx.root, { env: ctx.env })).name ?? name;
  } catch {}
  const dir = path.join(userDir(ctx.env ?? process.env), 'digest', name);
  const stateFile = path.join(dir, 'state.json');
  let state = {};
  try {
    state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  } catch {}
  const today = day();
  const flagSince = args.flags?.since;
  // A second run on the same day keeps that day's start, so the day's digest stays one digest.
  const since = typeof flagSince === 'string' ? flagSince : state.date === today ? state.since ?? null : state.at ?? null;
  const d = await digest(ctx.root, { since: since ?? undefined });
  const file = path.join(dir, `${today}.md`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, `Digest ${name} ${today}\n\n${d.text}\n`);
  if (typeof flagSince !== 'string') fs.writeFileSync(stateFile, `${JSON.stringify({ date: today, since, at: new Date().toISOString() })}\n`);
  return { text: `${d.text}\n\n(${file})`, data: { items: d.items, file } };
}

export const implements08 = { digest, cmdDigest };
