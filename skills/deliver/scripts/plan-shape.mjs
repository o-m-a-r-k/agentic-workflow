#!/usr/bin/env node
// plan-shape: does PLAN.md have the shape the plan judge needs, and does every citation resolve at the commits it names?
// Usage: node plan-shape.mjs <ticket-folder>
// Reads PLAN.md, CHECKS.json, STATE.md and git. Writes evidence/plan-shape.md. Exit 0 when every item holds, 1 otherwise.
import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve, basename } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const dir = resolve(process.argv[2] || '.');
const read = (p) => (existsSync(p) ? readFileSync(p, 'utf8') : '');
const field = (t, k) => (t.match(new RegExp(`^${k}:[ \\t]*(.*)$`, 'm')) || [])[1]?.trim() ?? '';
const section = (t, name) => {
  const s = t.split(/^## /m).find((c) => c.split('\n')[0].trim() === name);
  return s ? s.slice(s.indexOf('\n') + 1) : '';
};
const git = (cwd, ...a) => {
  try {
    return execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 1 << 28 });
  } catch {
    return null;
  }
};

const plan = read(join(dir, 'PLAN.md'));
const state = read(join(dir, 'STATE.md'));
const fails = [];
if (!plan) fails.push('PLAN.md is missing');
if (!state) fails.push('STATE.md is missing');

// Header fields
if (!/^\d+$/.test(field(plan, 'Revision'))) fails.push('Revision: is not a number');
const risk = field(plan, 'Risk');
if (!['low', 'high'].includes(risk)) fails.push(`Risk: "${risk}" is not low or high`);
if (risk === 'low' && /\|\s*high\s*\|/i.test(section(plan, 'Risk'))) fails.push('Risk: low, but the Risk table says high; the higher stands');
const type = field(state, 'Type').toLowerCase();
if (!/^(hotfix|bug|enhancement|new feature)\b/.test(type)) fails.push(`STATE.md Type: "${type}" is not hotfix, bug, enhancement or new feature`);

// The commits the plan read
const trees = {};
for (const m of state.matchAll(/^Worktree ([\w.-]+):[ \t]*(\S+)/gm)) trees[m[1]] = resolve(dir, m[2]);
const at = {};
for (const m of field(plan, 'Read at').matchAll(/([\w.-]+)@([0-9a-f]{7,40})/g)) {
  if (!trees[m[1]]) fails.push(`Read at: ${m[1]} is not a worktree in STATE.md`);
  else if (git(trees[m[1]], 'cat-file', '-e', `${m[2]}^{commit}`) === null) fails.push(`Read at: ${m[1]}@${m[2]} is not a commit in that worktree`);
  else at[m[1]] = m[2];
}
if (!Object.keys(at).length) fails.push('Read at: names no <repo>@<sha>');
const files = {};
for (const [r, sha] of Object.entries(at)) files[r] = (git(trees[r], 'ls-tree', '-r', '--name-only', sha) || '').split('\n').filter(Boolean);

// A path resolves to one file: <repo>/<path>, a repo-relative path, or the end of one path (a basename, or
// utils/x.ts for src/modules/a/utils/x.ts); more than one match fails with the candidates.
function locate(p) {
  if (p.startsWith('evidence/')) return existsSync(join(dir, p)) ? { local: p } : { err: 'missing from the ticket folder' };
  const [first, ...rest] = p.split('/');
  const repos = Object.keys(files);
  const where = (test) => repos.flatMap((r) => files[r].filter(test).map((f) => ({ repo: r, path: f })));
  let hits = where((f) => f === p);
  if (files[first]?.includes(rest.join('/'))) hits = [{ repo: first, path: rest.join('/') }, ...hits.filter((h) => h.repo !== first)];
  if (!hits.length) hits = where((f) => f.endsWith(`/${p}`));
  if (hits.length === 1) return hits[0];
  return { err: hits.length ? `ambiguous, candidates: ${hits.map((h) => `${h.repo}/${h.path}`).join(', ')}` : 'missing at the commits in Read at' };
}
const cache = {};
const lines = (h) => {
  const key = h.local || `${h.repo}:${h.path}`;
  const text = () => (h.local ? read(join(dir, h.local)) : git(trees[h.repo], 'show', `${at[h.repo]}:${h.path}`) || '');
  return (cache[key] ??= text().replace(/\n$/, '').split('\n'));
};
const norm = (s) => s.replace(/\s+/g, ' ').trim();
// A citation is `<path>:<line>[-<line>]` whose path has a / or a . and isn't a number or an address.
const PATH = '(?=[^\\s`:]*[/.])(?!\\d[\\d.]*:)[\\w@./\\[\\]()+-]+';
const isCite = (s) => new RegExp(`^${PATH}:\\d+(-\\d+)?$`).test(s);

// Every `path:line` resolves; a backtick snippet right after one is on those lines.
let cites = 0;
const cite = new RegExp(`\`(${PATH}):(\\d+)(?:-(\\d+))?\``, 'g');
for (let m; (m = cite.exec(plan)); ) {
  cites++;
  const ref = m[0].slice(1, -1);
  const h = locate(m[1]);
  if (h.err) { fails.push(`${ref}: ${h.err}`); continue; }
  const L = lines(h), a = +m[2], b = +(m[3] || m[2]);
  if (a < 1 || b < a || b > L.length) { fails.push(`${ref}: past the end of the file (${L.length} lines)`); continue; }
  const sn = plan.slice(cite.lastIndex).match(/^[ \t]*`([^`\n]+)`/);
  if (sn && !isCite(sn[1]) && !norm(L.slice(a - 1, b).join(' ')).includes(norm(sn[1]))) fails.push(`${ref}: \`${sn[1]}\` is not on those lines`);
}

// Decisions name a source and the alternative they beat; memos carry a recommendation.
const has = (block, k) => new RegExp(`^-[ \\t]*\\**${k}:\\**[ \\t]*\\S`, 'm').test(block);
const decisions = section(plan, 'Decisions').split(/^### /m).slice(1);
for (const d of decisions) {
  for (const k of ['Source', 'Beats']) if (!has(d, k)) fails.push(`${d.split(/[:\s]/)[0]}: no ${k}`);
  const src = (d.match(/^-[ \t]*\**Source:\**(.*)$/m) || [])[1] || '';
  if (has(d, 'Source') && !(cite.test(src) || /evidence\/\S+|https?:\/\/\S+.*\d{4}-\d{2}-\d{2}|\b(query|sql)\b/i.test(src)))
    fails.push(`${d.split(/[:\s]/)[0]}: Source names no \`path:line\`, evidence file, query or dated URL`);
  cite.lastIndex = 0;
}
for (const d of section(plan, 'Memos').split(/^### /m).slice(1)) {
  if (!has(d, 'Recommendation')) fails.push(`${d.split(/[:\s]/)[0]}: no Recommendation`);
  if (!/^-[ \t]*\**Due:\**[ \t]*before delivery \d+/m.test(d)) fails.push(`${d.split(/[:\s]/)[0]}: no "Due: before delivery <n>"`);
}
const listed = section(plan, 'Deliveries').match(/^\s*\d+\./gm) || [];
if (!listed.length) fails.push('Deliveries: lists no "1." line');

// Tests rows: an id, a file that exists or "(new)", and whether it fails before the change.
const rows = section(plan, 'Tests').split('\n').filter((l) => l.trim().startsWith('|')).slice(2);
for (const l of rows) {
  const [id = '', , test = '', , before = ''] = l.split('|').slice(1, -1).map((s) => s.trim());
  if (!/^T\d+$/.test(id)) { fails.push(`tests row "${norm(l)}": no T<n> id`); continue; }
  if (!/^(yes|no)\b/i.test(before)) fails.push(`${id}: "Fails before" is not yes or no`);
  if (/\(new\)/.test(test)) continue;
  const f = test.replace(/`/g, '').split('›')[0].trim();
  const h = f ? locate(f) : { err: 'names no file' };
  if (h.err) fails.push(`${id}: test file ${f || ''} ${h.err}; write "(new)" for a test this change adds`);
}

// Surface: every draft line kept, every touched line covered by a check with an expect.
const surface = section(plan, 'Surface').split('\n').filter((l) => /^- S\d+:/.test(l)).map((l) => l.trim());
const ids = surface.map((l) => l.match(/^- (S\d+)/)[1]);
for (const m of section(state, 'Surface').matchAll(/^- (S\d+):/gm))
  if (!ids.includes(m[1])) fails.push(`${m[1]}: in STATE.md's Surface draft but not in the plan's Surface (keep it, or mark it "not touched" with its source)`);
let checks = [];
try {
  checks = JSON.parse(read(join(dir, 'CHECKS.json')) || '[]');
  if (!Array.isArray(checks)) throw new Error('is not a list');
} catch (e) {
  fails.push(`CHECKS.json: ${e.message}`);
  checks = [];
}
const trivial = (e) => {
  const rx = String(e ?? '').match(/^\/(.*)\/([a-z]*)$/s);
  try { return !String(e ?? '').trim() || (!!rx && ['', 'x', 'ok'].some((o) => new RegExp(rx[1], rx[2]).test(o))); } catch { return true; }
};
for (const l of surface) {
  if (/^- S\d+:[ \t]*not touched\b/i.test(l)) continue;
  const id = l.match(/^- (S\d+)/)[1];
  if (!checks.some((c) => (c.surface || []).includes(id) && !trivial(c.expect))) fails.push(`${id}: no check in CHECKS.json names it with an expect that can fail`);
}
for (const c of checks) {
  const id = c.id || 'a check';
  for (const k of ['id', 'proves', 'verify', 'due']) if (!String(c[k] ?? '').trim()) fails.push(`${id}: no ${k}`);
  if (c.verify && !/^(cmd|walk):/.test(c.verify)) fails.push(`${id}: verify starts with neither "cmd:" nor "walk:"`);
  if (/^cmd:/.test(c.verify || '') && trivial(c.expect)) fails.push(`${id}: expect is empty or matches anything, so the check can't fail`);
  if (c.due && !/^(before delivery \d+|after .+ in delivery \d+)$/.test(c.due)) fails.push(`${id}: due is neither "before delivery <n>" nor "after <step> in delivery <n>"`);
  if (c.passes !== false) fails.push(`${id}: passes is not false`);
}

// The hash covers what approval is of: each line's id, whether it is touched, and what it must equal; not wording.
const equals = (l) => ((l.replace(/`[^`]*`/g, '').match(/\bequals\b([^;]*)/i) || [])[1] || '').replace(/\s+/g, ' ').trim().toLowerCase();
const key = (l) => `${l.match(/^- (S\d+)/)[1]}|${/^- S\d+:[ \t]*not touched\b/i.test(l) ? 'not touched' : 'touched'}|${equals(l)}`;
const hash = createHash('sha256').update(surface.map(key).join('\n')).digest('hex').slice(0, 12);
// For the judge: a kept draft line whose source of truth or touched state changed.
const pairs = [...section(state, 'Surface').matchAll(/^- (S\d+):.*$/gm)].flatMap((m) => {
  const p = surface.find((l) => l.startsWith(`- ${m[1]}:`));
  return p && key(p) !== key(m[0].trim()) ? [`- ${m[1]} draft: ${m[0].slice(2).trim()}`, `  ${m[1]} plan:  ${p.slice(2)}`] : [];
});
const words = plan.split(/\s+/).filter(Boolean).length;
const out = [
  `plan-shape: ${fails.length ? `fail ${fails.length}` : 'pass'}`,
  `revision ${(field(plan, 'Revision').match(/^\d+/) || ['?'])[0]}, risk ${risk || '?'}, ${words} words, ${decisions.length} decisions, ${cites} citations, ${rows.length} tests rows, ${checks.length} checks, surface ${hash}`,
  ...fails.map((f) => `- ${f}`),
  ...(pairs.length ? ['', 'Surface lines whose meaning changed from the draft (for the judge):', ...pairs] : []),
].join('\n');
mkdirSync(join(dir, 'evidence'), { recursive: true });
writeFileSync(join(dir, 'evidence', 'plan-shape.md'), out + '\n');
console.log(out);
process.exit(fails.length ? 1 : 0);
