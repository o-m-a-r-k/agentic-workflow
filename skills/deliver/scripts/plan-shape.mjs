#!/usr/bin/env node
// plan-shape: can every later script read this plan, does each citation resolve at the commits it names, and did each
// check and each tests row run once on the base before the challenge, a "yes" row failing and a "no" row passing?
// Usage: node plan-shape.mjs <ticket-folder> --definition <project definition> [--definition <its .local.md>]
//        node plan-shape.mjs <ticket-folder> --print reader|approval
// Reads PLAN.md, CHECKS.json, STATE.md, evidence/ (proof.jsonl, checks/<id>.log, walk-<id>.md), git, and the definition's
// surface_kinds, oracles and test_files. Writes evidence/plan-shape.md: pass or fail, and `plan <hash>`, the plan as its
// planner last left it. Exit 0 when every item holds, 1 otherwise, 2 on a usage error.
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { ticket, definitionOf, proofRules, git, field, section, read, vals, sha, trivial, specOf, normPath, dueBefore, dueAfter } from './ticket.mjs';

const args = process.argv.slice(2);
const dir = resolve(args[0] || '.');
const T = ticket(dir);
// --print: what the orchestrator copies without reading the plan: the reader's purpose, or what a high-risk approval is of.
if (args.includes('--print')) {
  const what = vals(args, '--print')[0];
  if (what === 'reader') console.log(T.seen || '(no What people see section)');
  else if (what === 'approval') console.log(['Outcome', 'Risk', 'Surface', 'Decisions'].map((s) => `## ${s}\n${section(T.plan, s).trim()}`).join('\n\n'));
  else { console.error('--print takes reader or approval'); process.exit(2); }
  process.exit(0);
}
const def = definitionOf(args);
const R = proofRules(T, def);
const oracles = def.map('oracles'), critical = (def.list('surface_kinds') || []).map((k) => k.toLowerCase());
const kinds = [...new Set([...critical, ...Object.keys(oracles)])];
const fails = [];
const fail = (s) => fails.push(s);
if (!T.plan) fail('PLAN.md is missing');
if (!T.state) fail('STATE.md is missing');
if (!T.revision) fail('Revision: is not a number');
if (!['low', 'high'].includes(T.risk)) fail(`Risk: "${T.risk}" is not low or high`);
if (!/^(hotfix|bug|enhancement|new feature)\b/i.test(field(T.state, 'Type'))) fail(`STATE.md Type: "${field(T.state, 'Type')}" is not hotfix, bug, enhancement or new feature`);

// The commits the plan read, and their files.
const files = {}, at = {};
for (const { repo, sha: c } of T.readAt) {
  const w = T.worktrees[repo];
  if (!w?.path) fail(`Read at: ${repo} is not an existing worktree in STATE.md (its path is from the ticket folder, or absolute)`);
  else if (git(w.path, 'cat-file', '-e', `${c}^{commit}`) === null) fail(`Read at: ${repo}@${c} is not a commit in that worktree`);
  else { at[repo] = c; files[repo] = (git(w.path, 'ls-tree', '-r', '--name-only', c) || '').split('\n').filter(Boolean); }
}
if (!T.readAt.length) fail('Read at: names no <repo>@<sha>');
const exts = new Set(Object.values(files).flat().map((f) => (f.match(/\.\w+$/) || [])[0]).filter(Boolean));

// A path resolves to one file: evidence/<file>, <repo>/<path>, a repo-relative path, or the end of one path.
function locate(raw) {
  const p = normPath(raw);
  if (p.startsWith('evidence/')) return existsSync(join(dir, p)) ? { local: p } : { err: 'missing from the ticket folder' };
  const [first, ...rest] = p.split('/');
  const where = (ok) => Object.keys(files).flatMap((r) => files[r].filter(ok).map((f) => ({ repo: r, path: f })));
  let hits = where((f) => f === p);
  if (files[first]?.includes(rest.join('/'))) hits = [{ repo: first, path: rest.join('/') }, ...hits.filter((h) => h.repo !== first)];
  if (!hits.length) hits = where((f) => f.endsWith(`/${p}`));
  if (hits.length === 1) return hits[0];
  return { err: hits.length ? `ambiguous, candidates: ${hits.map((h) => `${h.repo}/${h.path}`).join(', ')}` : 'missing at the commits in Read at' };
}
const lines = (h) => (h.local ? read(join(dir, h.local)) : git(T.worktrees[h.repo].path, 'show', `${at[h.repo]}:${h.path}`) || '').split('\n');
const norm = (s) => s.replace(/\s+/g, ' ').trim();
// A citation is `<path>:<line>[-<line>]` in backticks. One that resolves is checked; one that doesn't fails when it
// looks like a file (a slash, or an extension the repos use), and is otherwise an address or a time, not a citation.
const cite = /`((?!\d[\d.]*:)[\w@./\\[\]()+-]+):(\d+)(?:-(\d+))?`/g;
const resolved = (m) => { const h = locate(m[1]); return !h.err || /[/\\]/.test(m[1]) || exts.has((m[1].match(/\.\w+$/) || [])[0]) ? h : null; };
let cites = 0;
for (const m of T.plan.matchAll(cite)) {
  const h = resolved(m);
  if (!h) continue;
  cites++;
  const ref = m[0].slice(1, -1);
  if (h.err) { fail(`${ref}: ${h.err}`); continue; }
  const L = lines(h), a = +m[2], b = +(m[3] || m[2]);
  if (a < 1 || b < a || b > L.length) { fail(`${ref}: past the end of the file (${L.length} lines)`); continue; }
  const sn = T.plan.slice(m.index + m[0].length).match(/^[ \t]*`([^`\n]+)`/);
  if (sn && !/:\d+(-\d+)?$/.test(sn[1]) && !norm(L.slice(a - 1, b).join(' ')).includes(norm(sn[1]))) fail(`${ref}: \`${sn[1]}\` is not on those lines`);
}
// Every evidence file the plan names exists, with or without a line.
for (const p of new Set(T.plan.match(/\bevidence\/[\w./-]*\w/g) || [])) if (!existsSync(join(dir, p))) fail(`${p}: missing from the ticket folder`);

// A decision's source establishes it: a cited line of code, a line of an evidence file outside its "## Proposals"
// (an agent's proposal establishes nothing), or a dated address. It names the alternative it beats.
const proposal = (h, n) => /^## proposals\b/i.test(lines(h).slice(0, n).reverse().find((l) => /^## /.test(l)) || '');
for (const d of T.decisions) {
  const id = d.split(/[:\s]/)[0], src = field(d, 'source');
  const ok = [...src.matchAll(cite)].some((m) => { const h = resolved(m); return h && !h.err && (!h.local || !proposal(h, +m[2])); });
  if (!field(d, 'beats')) fail(`${id}: no Beats`);
  if (!src) fail(`${id}: no Source`);
  else if (!ok && !/https?:\/\/\S+.*\d{4}-\d{2}-\d{2}/.test(src)) fail(`${id}: Source names no resolving \`path:line\`, evidence line outside "## Proposals", or dated address`);
}
for (const q of T.questions) fail(`${q.slice(2).split(/[:\s]/)[0]}: open; the decision judge answers it and the planner folds the answer as a decision`);
if (!T.deliveries.length) fail('Deliveries: lists no "1." line');
const beyond = (n) => n > Math.max(0, ...T.deliveries.map(Number));

// Tests rows: an id, a file that exists or "(new)", yes or no, a delivery the plan has, a "yes" row seen red on the base
// and a "no" row seen passing there, but a new one that isn't a test file (a migration run up and down).
for (const r of T.tests) {
  if (!/^T\d+$/.test(r.id)) { fail(`tests row "${r.raw}": no T<n> id`); continue; }
  if (!/^(yes|no)\b/.test(r.before)) fail(`${r.id}: "Fails before" is not yes or no`);
  else if (r.before.startsWith('yes') && !T.proofs.some((p) => R.isRed(p, r))) fail(`${r.id}: fails before, and no proof line shows it red: commit its test first on the ticket branch and run it there with proof --base (a run that ran no tests, or ran on a tree with more than tests changed, is not red; an existing test already failing there is red as it stands)`);
  else if (!r.before.startsWith('yes') && !(r.isNew && r.file && !R.isTestFile(r.file)) && !T.proofs.some((p) => R.isBasePass(p, r))) fail(`${r.id}: passes before, and no proof line shows it passing on the base: run it there with proof --base, on the base as it is or narrowed to leave the new tests out (if it fails there, it is a defect already on the change's ground: the plan takes it in and the row becomes "yes")`);
  if (r.delivery && beyond(r.delivery)) fail(`${r.id}: delivery ${r.delivery} is not in Deliveries`);
  if (r.isNew) continue;
  const h = r.file ? locate(r.file) : { err: 'names no file' };
  if (h.err) fail(`${r.id}: test file ${r.file} ${h.err}; write "(new)" for a test this change adds`);
}

// Surface: every draft line kept, a kind on each, every touched line covered by a check that can fail, through the oracle.
const unknownKinds = [];
for (const l of T.surface) {
  if (!l.kind) fail(`${l.id}: no kind; write "- ${l.id} (<kind>): …"`);
  else if (kinds.length && !kinds.includes(l.kind)) unknownKinds.push(`${l.id} (${l.kind})`);
}
for (const l of T.draft) if (!T.surface.some((s) => s.id === l.id)) fail(`${l.id}: in STATE.md's Surface draft but not in the plan's Surface (keep it, or mark it "not touched" with its source)`);
if (T.checksError) fail(`CHECKS.json: ${T.checksError}`);
const prefix = (cmd) => cmd.split(/\s+/).filter((w, i, a) => !a.slice(0, i + 1).some((x) => /[{<]/.test(x))).join(' ');
for (const l of T.surface.filter((s) => s.touched)) {
  const mine = T.checks.filter((c) => (c.surface || []).includes(l.id) && !trivial(c.expect));
  if (!mine.length) fail(`${l.id}: no check in CHECKS.json names it with an expect that can fail`);
  const o = oracles[l.kind];
  if (o && mine.length && !mine.some((c) => String(c.verify).slice(4).trim().startsWith(prefix(o)))) fail(`${l.id}: the project names an oracle for ${l.kind} (${prefix(o)}), and no check of this line runs it`);
}
// Each check due before a delivery, but a heavy one, ran once as written: its log's first line names its spec, or its
// walk file its id.
for (const c of T.checks) {
  const id = c.id || 'a check';
  for (const k of ['id', 'proves', 'verify', 'due']) if (!String(c[k] ?? '').trim()) fail(`${id}: no ${k}`);
  if (c.verify && !/^(cmd|walk):/.test(c.verify)) fail(`${id}: verify starts with neither "cmd:" nor "walk:"`);
  if (/^cmd:/.test(c.verify || '') && trivial(c.expect)) fail(`${id}: expect is empty or matches anything, so the check can't fail`);
  if (c.due && !dueBefore(c) && !dueAfter(c)) fail(`${id}: due is neither "before delivery <n>" nor "after <step> in delivery <n>"`);
  if (beyond(dueBefore(c) || dueAfter(c))) fail(`${id}: due in a delivery that is not in Deliveries`);
  if (!dueBefore(c) || c.heavy) continue;
  const ranAsWritten = /^cmd:/.test(c.verify || '') ? read(join(T.ev, 'checks', `${id}.log`)).startsWith(`check ${id} spec ${specOf(c, def)} `) : field(read(join(T.ev, `walk-${id}.md`)), 'check') === id;
  if (!ranAsWritten) fail(`${id}: never run as written: run checks (or the walk, into evidence/walk-${id}.md) on the base before the challenge`);
}

// What people see: the states screenshots will carry, as short names.
if (T.states && !T.states.length) fail('What people see has no "States: <name>, <name>" line');
for (const s of T.states || []) if (!/^[\p{L}\p{N}][\p{L}\p{N}_-]*$/u.test(s)) fail(`States: "${s}" is not a short name; widths, languages and reasons go on other lines`);
// Each question names where it is asked: "all", or states from the States line.
if (T.states) {
  const qs = ((T.seen.match(/^Questions:[^\n]*\n((?:\d+\..*\n?)*)/m) || [])[1] || '').split('\n').filter((l) => /^\d+\./.test(l));
  if (!qs.length) fail('What people see: no "Questions:" line followed by numbered questions, each "(asked at: <states> | all)"');
  for (const q of qs) {
    const at = (q.match(/\(asked at:\s*([^)]*)\)/i) || [])[1];
    if (at === undefined) { fail(`Question "${q.slice(0, 60)}": no "(asked at: <states> | all)"`); continue; }
    const names = at.split(',').map((s) => s.trim()).filter(Boolean);
    if (!names.length) fail(`Question "${q.slice(0, 60)}": asked at no state`);
    else if (!(names.length === 1 && names[0] === 'all')) for (const n of names) if (!T.states.includes(n)) fail(`Question "${q.slice(0, 60)}": asked at "${n}", which States doesn't name`);
  }
}

const hash = sha(T.surface.map((l) => l.key).join('\n'));
// For the challenger: a kept draft line whose record or touched state changed.
const pairs = T.draft.flatMap((d) => { const p = T.surface.find((l) => l.id === d.id); return p && p.key !== d.key ? [`- ${d.id} draft: ${d.text.slice(2)}`, `  ${d.id} plan:  ${p.text.slice(2)}`] : []; });
const missingKinds = critical.filter((k) => !T.surface.some((l) => l.kind === k));
const out = [
  `plan-shape: ${fails.length ? `fail ${fails.length}` : 'pass'}`,
  `revision ${T.revision || '?'}, risk ${T.risk || '?'}, ${T.plan.split(/\s+/).filter(Boolean).length} words, ${T.decisions.length} decisions, ${cites} citations, ${T.tests.length} tests rows, ${T.checks.length} checks, surface ${hash}, plan ${T.planHash}`,
  `definition: ${def.files.join(', ')}`,
  ...fails.map((f) => `- ${f}`),
  ...(pairs.length ? ['', 'Surface lines whose meaning changed from the draft (for the challenger):', ...pairs] : []),
  ...(missingKinds.length ? ['', `Critical kinds with no Surface line (for the challenger: does the change show or write one?): ${missingKinds.join(', ')}`] : []),
  ...(unknownKinds.length ? ['', `Kinds the definition doesn't name (for the challenger): ${unknownKinds.join(', ')}; it names ${kinds.join(', ') || 'none'}`] : []),
].join('\n');
mkdirSync(T.ev, { recursive: true });
writeFileSync(join(T.ev, 'plan-shape.md'), out + '\n');
console.log(out);
process.exit(fails.length ? 1 : 0);
