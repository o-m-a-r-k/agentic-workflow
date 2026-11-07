#!/usr/bin/env node
// checks: runs the runnable checks due for a delivery and compares each output with its expect.
// Usage: node checks.mjs <ticket-folder> --delivery <n> [--after] --definition <project definition> [--definition <its .local.md>]
// A check is due when its due is "before delivery <n>", a Surface check also when due before an earlier one, and with
// --after (run once the delivery's steps are taken) also when due "after <step> in delivery <n>".
//   verify "cmd: <command>": run without a shell, in the worktree named by "in" (default: the first in STATE.md), only
//     when its words start with an entry of the definition's checks_allow ("npm test" allows "npm test -- renew", not
//     "npm exec"); it passes when it exits 0 and its output holds expect
//     (or matches it, when expect is written /regex/flags).
//   verify "walk: <steps>": passes when passes is true and its evidence file exists and names that worktree's HEAD.
// Writes evidence/checks.json. Exit 0 when every due check passes, 1 otherwise.
import { readFileSync, existsSync, writeFileSync, mkdirSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';

const args = process.argv.slice(2);
const dir = resolve(args[0] || '.');
const vals = (k) => args.flatMap((a, i) => (a === k ? [args[i + 1]] : []));
const delivery = +vals('--delivery')[0];
const after = args.includes('--after');
if (!delivery) {
  console.error('usage: node checks.mjs <ticket-folder> --delivery <n> --definition <file> [--definition <file>]');
  process.exit(2);
}
const read = (p) => (existsSync(p) ? readFileSync(p, 'utf8') : '');

// checks_allow from the definition's front matter, as [a, b] or a block list; the first definition that sets it wins.
function list(text, key) {
  const fm = (text.match(/^---\n([\s\S]*?)\n---/) || [])[1] || '';
  const m = fm.match(new RegExp(`^${key}:[ \\t]*(.*)$((?:\\n[ \\t]+- .*)*)`, 'm'));
  if (!m) return null;
  const v = m[1].replace(/(^|\s+)#.*$/, '').trim();
  const items = v.startsWith('[') ? v.slice(1, v.lastIndexOf(']')).split(',') : m[2].split('\n').map((l) => l.replace(/^\s*-\s*/, ''));
  return items.map((s) => s.replace(/\s+#.*$/, '').trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
}
const allow = vals('--definition').map((p) => list(read(resolve(p)), 'checks_allow')).find(Boolean) || [];

// A command split like a shell would, quotes only; anything that needs a shell is refused.
function split(s) {
  const out = [];
  let cur = '', q = null, quoted = false;
  for (const ch of s) {
    if (q) { if (ch === q) q = null; else cur += ch; continue; }
    if (ch === '"' || ch === "'") { q = ch; quoted = true; continue; }
    if (/\s/.test(ch)) { if (cur || quoted) out.push(cur); cur = ''; quoted = false; continue; }
    if (/[;&|<>`$]/.test(ch)) return null;
    cur += ch;
  }
  if (q) return null;
  if (cur || quoted) out.push(cur);
  return out;
}

const state = read(join(dir, 'STATE.md'));
const trees = {};
for (const m of state.matchAll(/^Worktree ([\w.-]+):[ \t]*(\S+)/gm)) if (existsSync(resolve(dir, m[2]))) trees[m[1]] = realpathSync(resolve(dir, m[2]));
const heads = {};
for (const [r, p] of Object.entries(trees)) {
  try { heads[r] = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: p, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { heads[r] = null; }
}
let checks;
try {
  checks = JSON.parse(read(join(dir, 'CHECKS.json')));
} catch (e) {
  console.error(`checks: CHECKS.json: ${e.message}`);
  process.exit(1);
}

const dueBefore = (c) => +((String(c.due).match(/^before delivery (\d+)$/) || [])[1] || 0);
const dueAfter = (c) => +((String(c.due).match(/^after .+ in delivery (\d+)$/) || [])[1] || 0);
const due = (c) => dueBefore(c) === delivery || ((c.surface || []).length > 0 && dueBefore(c) > 0 && dueBefore(c) < delivery) || (after && dueAfter(c) === delivery);
const matches = (out, expect) => {
  const rx = String(expect).match(/^\/(.*)\/([a-z]*)$/s);
  return rx ? new RegExp(rx[1], rx[2]).test(out) : out.includes(String(expect).trim());
};

const results = [];
for (const c of checks) {
  if (!due(c)) continue;
  const repo = c.in || Object.keys(trees)[0];
  const r = { id: c.id, surface: c.surface || [], in: repo };
  if (!trees[repo]) Object.assign(r, { ok: false, reason: `no worktree "${repo}" in STATE.md` });
  else if (/^cmd:/.test(c.verify)) {
    const argv = split(c.verify.slice(4).trim());
    r.command = c.verify.slice(4).trim();
    if (!argv || !argv.length) Object.assign(r, { ok: false, reason: 'not a plain command: no shell operators, pipes or variables' });
    else if (!allow.some((a) => a.split(/\s+/).every((w, i) => argv[i] === w))) Object.assign(r, { ok: false, reason: `"${argv.slice(0, 2).join(' ')}" does not start with an entry of checks_allow; it is a walk` });
    else {
      const run = spawnSync(argv[0], argv.slice(1), { cwd: trees[repo], encoding: 'utf8', maxBuffer: 1 << 28, timeout: 3600000 });
      const out = `${run.stdout || ''}${run.stderr || ''}${run.error ? run.error.message : ''}`;
      const ok = run.status === 0 && matches(out, c.expect ?? '');
      Object.assign(r, { ok, exit: run.status, head: heads[repo], output: out.replace(/\n$/, '').split('\n').slice(-20).join('\n') });
      if (!ok) r.reason = run.error ? `did not run: ${run.error.message}` : run.status !== 0 ? `exit ${run.status ?? run.signal}` : `output does not hold expect "${c.expect}"`;
    }
  } else {
    const head7 = (heads[repo] || '').slice(0, 7);
    const ev = c.evidence ? read(join(dir, c.evidence)) : '';
    if (c.passes !== true) Object.assign(r, { ok: false, reason: 'passes is not true' });
    else if (!ev) Object.assign(r, { ok: false, reason: `evidence file ${c.evidence || '(none)'} is missing` });
    else if (!head7 || !ev.includes(head7)) Object.assign(r, { ok: false, reason: `evidence does not name ${repo} HEAD ${head7}` });
    else Object.assign(r, { ok: true, head: heads[repo] });
  }
  results.push(r);
}

const ok = results.every((r) => r.ok);
mkdirSync(join(dir, 'evidence'), { recursive: true });
writeFileSync(join(dir, 'evidence', 'checks.json'), JSON.stringify({ delivery, after, ok, heads, results }, null, 2) + '\n');
console.log(`checks: ${ok ? 'pass' : 'fail'} (${results.filter((r) => r.ok).length}/${results.length} due for delivery ${delivery})`);
for (const r of results) console.log(`- ${r.id}${r.surface.length ? ` [${r.surface.join(', ')}]` : ''}: ${r.ok ? 'pass' : `fail: ${r.reason}`}`);
if (!allow.length && checks.some((c) => due(c) && /^cmd:/.test(c.verify))) console.log('- no checks_allow in the project definition');
process.exit(ok ? 0 : 1);
