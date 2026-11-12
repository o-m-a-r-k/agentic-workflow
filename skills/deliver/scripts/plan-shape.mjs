#!/usr/bin/env node
// plan-shape: can every later script read this plan, does each citation resolve at the commits it names, and did each
// check and each "fails before: yes" row run once on the base before the judge?
// Usage: node plan-shape.mjs <ticket-folder> --definition <project definition> [--definition <its .local.md>]
//        node plan-shape.mjs <ticket-folder> --print reader
// Reads PLAN.md, CHECKS.json, STATE.md, evidence/ (proof.jsonl, checks/<id>.log, walk-<id>.md), git, and the definition's
// surface_kinds and oracles. Writes evidence/plan-shape.md, whose `plan <hash>` is the plan as its planner last left it.
// Exit 0 when every item holds, 1 otherwise, 2 on a usage error.
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { ticket, definition, git, field, section, read, vals, sha, trivial } from './ticket.mjs';

const args = process.argv.slice(2);
const dir = resolve(args[0] || '.');
const T = ticket(dir);
// --print reader: the plan's "What people see" (the sealed reader's purpose), word for word, so the orchestrator copies
// it without reading the plan. It writes nothing.
if (args.includes('--print')) {
  if (vals(args, '--print')[0] !== 'reader') { console.error('--print takes reader'); process.exit(2); }
  console.log(T.seen || '(no What people see section)');
  process.exit(0);
}
if (!vals(args, '--definition').length) { console.error('plan-shape: --definition <project definition> is required: its kinds and oracles decide items'); process.exit(2); }
const def = definition(vals(args, '--definition'));
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

// A path resolves to one file: <repo>/<path>, a repo-relative path, or the end of one path; more than one match fails.
function locate(p) {
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
// A citation is `<path>:<line>[-<line>]` whose path has a / or a . and isn't a number or an address; a backtick snippet
// right after one must be on those lines.
const PATH = '(?=[^\\s`:]*[/.])(?!\\d[\\d.]*:)[\\w@./\\[\\]()+-]+';
const cite = new RegExp(`\`(${PATH}):(\\d+)(?:-(\\d+))?\``, 'g');
let cites = 0;
for (let m; (m = cite.exec(T.plan)); ) {
  cites++;
  const ref = m[0].slice(1, -1), h = locate(m[1]);
  if (h.err) { fail(`${ref}: ${h.err}`); continue; }
  const L = lines(h), a = +m[2], b = +(m[3] || m[2]);
  if (a < 1 || b < a || b > L.length) { fail(`${ref}: past the end of the file (${L.length} lines)`); continue; }
  const sn = T.plan.slice(cite.lastIndex).match(/^[ \t]*`([^`\n]+)`/);
  if (sn && !new RegExp(`^${PATH}:\\d+(-\\d+)?$`).test(sn[1]) && !norm(L.slice(a - 1, b).join(' ')).includes(norm(sn[1]))) fail(`${ref}: \`${sn[1]}\` is not on those lines`);
}
// Every evidence file the plan names exists, with or without a line.
for (const p of new Set(T.plan.match(/\bevidence\/[\w./-]*\w/g) || [])) if (!existsSync(join(dir, p))) fail(`${p}: missing from the ticket folder`);

// Decisions name a source and the alternative they beat; questions are answered before the judge.
const has = (block, k) => new RegExp(`^-[ \\t]*\\**${k}:\\**[ \\t]*\\S`, 'm').test(block);
for (const d of T.decisions) {
  const id = d.split(/[:\s]/)[0];
  for (const k of ['Source', 'Beats']) if (!has(d, k)) fail(`${id}: no ${k}`);
  const src = (d.match(/^-[ \t]*\**Source:\**(.*)$/m) || [])[1] || '';
  if (has(d, 'Source') && !(new RegExp(`\`${PATH}:\\d+`).test(src) || /evidence\/\S+|https?:\/\/\S+.*\d{4}-\d{2}-\d{2}|\b(query|sql)\b/i.test(src))) fail(`${id}: Source names no \`path:line\`, evidence file, query or dated URL`);
}
for (const q of T.questions) fail(`${q.slice(2).split(/[:\s]/)[0]}: open; the decision judge answers it and the planner folds the answer as a decision`);
if (!T.deliveries.length) fail('Deliveries: lists no "1." line');

// Tests rows: an id, a file that exists or "(new)", yes or no, and a "yes" row seen red on the base.
const red = (id) => T.proofs.some((p) => p.test === id && p.base && typeof p.exit === 'number' && p.exit !== 0);
for (const r of T.tests) {
  if (!/^T\d+$/.test(r.id)) { fail(`tests row "${r.raw}": no T<n> id`); continue; }
  if (!/^(yes|no)\b/.test(r.before)) fail(`${r.id}: "Fails before" is not yes or no`);
  else if (r.before.startsWith('yes') && !red(r.id)) fail(`${r.id}: fails before, and no red proof line names it: write the test and run it with proof --base on the base`);
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
for (const c of T.checks) {
  const id = c.id || 'a check';
  for (const k of ['id', 'proves', 'verify', 'due']) if (!String(c[k] ?? '').trim()) fail(`${id}: no ${k}`);
  if (c.verify && !/^(cmd|walk):/.test(c.verify)) fail(`${id}: verify starts with neither "cmd:" nor "walk:"`);
  if (/^cmd:/.test(c.verify || '') && trivial(c.expect)) fail(`${id}: expect is empty or matches anything, so the check can't fail`);
  if (c.due && !/^(before delivery \d+|after .+ in delivery \d+)$/.test(c.due)) fail(`${id}: due is neither "before delivery <n>" nor "after <step> in delivery <n>"`);
  const ran = /^cmd:/.test(c.verify || '') ? `evidence/checks/${id}.log` : `evidence/walk-${id}.md`;
  if (/^before/.test(c.due || '') && !existsSync(join(dir, ran))) fail(`${id}: never run on the base (no ${ran}): run it once before the judge`);
}

// What people see: the states screenshots will carry, as short names.
if (T.states && !T.states.length) fail('What people see has no "States: <name>, <name>" line');
for (const s of T.states || []) if (!/^[\p{L}\p{N}][\p{L}\p{N}_-]*$/u.test(s)) fail(`States: "${s}" is not a short name; widths, languages and reasons go on other lines`);

const hash = sha(T.surface.map((l) => l.key).join('\n'));
// For the judge: a kept draft line whose record or touched state changed.
const pairs = T.draft.flatMap((d) => { const p = T.surface.find((l) => l.id === d.id); return p && p.key !== d.key ? [`- ${d.id} draft: ${d.text.slice(2)}`, `  ${d.id} plan:  ${p.text.slice(2)}`] : []; });
const missingKinds = critical.filter((k) => !T.surface.some((l) => l.kind === k));
const out = [
  `plan-shape: ${fails.length ? `fail ${fails.length}` : 'pass'}`,
  `revision ${T.revision || '?'}, risk ${T.risk || '?'}, ${T.plan.split(/\s+/).filter(Boolean).length} words, ${T.decisions.length} decisions, ${cites} citations, ${T.tests.length} tests rows, ${T.checks.length} checks, surface ${hash}, plan ${T.planHash}`,
  ...fails.map((f) => `- ${f}`),
  ...(pairs.length ? ['', 'Surface lines whose meaning changed from the draft (for the judge):', ...pairs] : []),
  ...(missingKinds.length ? ['', `Critical kinds with no Surface line (for the judge: does the change show or write one?): ${missingKinds.join(', ')}`] : []),
  ...(unknownKinds.length ? ['', `Kinds the definition doesn't name (for the judge): ${unknownKinds.join(', ')}; it names ${kinds.join(', ') || 'none'}`] : []),
].join('\n');
mkdirSync(T.ev, { recursive: true });
writeFileSync(join(T.ev, 'plan-shape.md'), out + '\n');
console.log(out);
process.exit(fails.length ? 1 : 0);
