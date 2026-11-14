#!/usr/bin/env node
// checks: runs the ticket's runnable checks that are due and compares each output with its expect.
// Usage: node checks.mjs <ticket-folder> [--after] --definition <project definition> [--definition <its .local.md>]
//        node checks.mjs <ticket-folder> --stop
// A check in CHECKS.json is due "before delivery", or "after <step>"; --after runs both kinds. A check whose due is
// neither fails. Heavy checks run last, one at a time like every other.
//   verify "cmd: <command>": run without a shell, only when its words start with an entry of the definition's
//     checks_allow ("npm test" allows "npm test -- renew", not "npm exec"). An entry with a word starting ./ ../ or /
//     names a file from the definition's folder (an oracle) and runs from there, never from the branch under test,
//     unless DESIGN.md's "Oracles changed:" line names it: then the worktree's copy runs. Any other runs in the worktree
//     named by "in" (default: the first in STATE.md). {worktree} and {ticket} become those folders' paths. It passes
//     when it exits 0, its output holds expect (or matches /regex/flags), and matches none of nothing_ran.
//     A pass stands while every worktree's commit it ran on stands for HEAD (ticket.mjs), and a green proof line with
//     the same words on a commit that stands is adopted; neither runs again. An oracle always runs.
//   verify "walk: <steps>": passes when evidence/walk-<id>.md has the lines "Check: <id>", "Commit: <repo>@<sha>" on a
//     commit that stands, "Result: pass" and "Seen: <what was seen>".
// One run per ticket (evidence/checks.run, see runner.mjs); --stop ends it. A stopped run writes no results, and a run
// that doesn't finish leaves none.
// Writes evidence/checks.json and evidence/checks/<id>.log, whose first line names the check, its spec and trees.
// Exit 0 when every due check passes, and at least one is due.
import { existsSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { ticket, definitionOf, proofRules, read, field, matches, trivial, spawnArgs, split, allowed, due, dueKind, specOf, normPath } from './ticket.mjs';
import { runner } from './runner.mjs';

const args = process.argv.slice(2);
const dir = resolve(args[0] || '.');
const R0 = runner(dir, 'checks.run', 'checks');
if (args.includes('--stop')) R0.stop();
const after = args.includes('--after');
const def = definitionOf(args);
const allow = def.list('checks_allow') || [], nothingRan = def.list('nothing_ran') || [];

const T = ticket(dir);
if (!existsSync(join(dir, 'STATE.md'))) { console.error(`checks: ${dir} is not a ticket folder`); process.exit(2); }
if (T.checksError) { console.error(`checks: CHECKS.json: ${T.checksError}`); process.exit(1); }
const R = proofRules(T, def);
const W = Object.fromEntries(T.repos.map((w) => [w.name, w]));
const heads = Object.fromEntries(T.repos.map((w) => [w.name, w.head])), trees = Object.fromEntries(T.repos.map((w) => [w.name, w.tree]));
const allStand = (hs = {}) => T.repos.every((w) => R.stands(w, hs[w.name]));
let last = null;
try { last = JSON.parse(read(join(T.ev, 'checks.json'))); } catch {}
R0.hold();
mkdirSync(join(T.ev, 'checks'), { recursive: true });

// The last whole result stops standing the moment a run starts replacing its logs; a run that doesn't finish leaves none.
let logsTouched = false;
const voidLast = () => { if (!logsTouched) rmSync(join(T.ev, 'checks.json'), { force: true }); logsTouched = true; };
const writeLog = (c, spec, text) => { voidLast(); writeFileSync(join(T.ev, 'checks', `${c.id}.log`), `check ${c.id} spec ${spec} trees ${JSON.stringify(trees)}\n${text}`); };

const results = [];
const label = (c) => `${c.id}${(c.surface || []).length ? ` [${c.surface.join(', ')}]` : ''}`;
const order = [...T.checks.filter((c) => !dueKind(c)), ...T.checks.filter((c) => due(c, after) && !c.heavy), ...T.checks.filter((c) => due(c, after) && c.heavy)];
for (const c of order) {
  const repo = c.in || Object.keys(W)[0], w = W[repo], spec = specOf(c, def);
  const r = { id: c.id, spec, heads, results: [] };
  results.push(r);
  const no = (reason) => Object.assign(r, { ok: false, reason });
  if (!dueKind(c)) { no(`due "${c.due ?? ''}" is neither "before delivery" nor "after <step>"`); continue; }
  if (!w) { no(`no worktree "${repo}" in STATE.md`); continue; }
  if (!/^cmd:/.test(c.verify)) {
    const file = `evidence/walk-${c.id}.md`, ev = read(join(dir, file)), [wr, ws] = field(ev, 'commit').split(/\s/)[0].split('@');
    if (!ev) no(`no ${file}`);
    else if (field(ev, 'check') !== c.id) no(`${file} has no "Check: ${c.id}" line`);
    else if (!/^pass\b/i.test(field(ev, 'result'))) no(`${file} says Result: ${field(ev, 'result') || '(none)'}`);
    else if (!field(ev, 'seen')) no(`${file} has no "Seen:" line saying what was seen`);
    else if (!W[wr] || !R.stands(W[wr], ws)) no(`${file} names ${field(ev, 'commit') || 'no commit'}, which doesn't stand for ${wr || repo} HEAD`);
    else Object.assign(r, { ok: true, log: file });
    continue;
  }
  const argv = split(c.verify.slice(4).trim());
  const entry = allowed(argv, allow);
  if (!argv?.length) { no('not a plain command: no shell operators, pipes or variables'); continue; }
  if (!entry) { no(`"${argv.slice(0, 2).join(' ')}" does not start with an entry of checks_allow; it is a walk`); continue; }
  if (trivial(c.expect)) { no("expect is empty or matches anything, so the check can't fail"); continue; }
  const own = entry.split(/\s+/).filter((x) => /^(\.{1,2})?\//.test(x));
  const changedHere = (x) => T.oraclesChanged.includes(normPath(x)) && W[normPath(x).split('/')[0]];
  const where = (x) => (changedHere(x) ? join(W[normPath(x).split('/')[0]].path, normPath(x).split('/').slice(1).join('/')) : resolve(def.dir, x));
  if (own.some((x) => !existsSync(where(x)))) { no(`${own.join(' ')} is not in ${own.some(changedHere) ? 'the worktree' : `the definition's folder ${def.dir}`}`); continue; }
  const sub = argv.map((a) => (own.includes(a) ? where(a) : a.replaceAll('{worktree}', w.path).replaceAll('{ticket}', dir)));
  const holds = (out) => !nothingRan.find((p) => matches(out, p)) && matches(out, c.expect);
  // The same check passed on commits that stand, or a green proof line ran these words on one: it stands, unrun.
  const kept = !own.length && last?.results?.find((x) => x.id === c.id && x.ok && x.spec === spec && allStand(x.heads));
  const proof = !own.length && T.proofs.findLast((p) => p.repository === w.repository && R.isGreen(p) && JSON.stringify(p.argv) === JSON.stringify(sub) && holds(p.log || ''));
  if (kept) { Object.assign(r, { ok: true, log: kept.log, heads: kept.heads, line: `${label(c)}: pass (stands from ${kept.heads[repo]?.slice(0, 12)})` }); continue; }
  if (proof) {
    writeLog(c, spec, `adopted: the proof line of ${proof.time} ran these words at ${proof.head}\n${proof.log}\n`);
    Object.assign(r, { ok: true, log: `evidence/checks/${c.id}.log`, line: `${label(c)}: pass (adopted from proof, ${proof.time})` });
    continue;
  }
  const cwd = own.length ? def.dir : w.path, s = spawnArgs(sub);
  if (s.error) { no(s.error); continue; }
  voidLast();
  const run = await R0.exec(s.argv[0], s.argv.slice(1), { cwd, env: { ...process.env, ...s.env, CHECK_WORKTREE: w.path, CHECK_TICKET: dir }, windowsVerbatimArguments: !!s.verbatim });
  const out = `${run.stdout || ''}${run.stderr || ''}${run.error ? run.error.message : ''}`;
  const empty = nothingRan.find((p) => matches(out, p));
  writeLog(c, spec, `$ ${sub.join(' ')}\n(in ${cwd})\n${out}\nexit ${run.status ?? run.signal}\n`);
  Object.assign(r, { ok: !run.error && run.status === 0 && holds(out), log: `evidence/checks/${c.id}.log` });
  if (!r.ok) r.reason = run.error ? `did not run: ${run.error.message}` : run.status !== 0 ? `exit ${run.status ?? run.signal}` : empty ? `ran nothing ("${empty}")` : `output does not hold expect "${c.expect}"`;
}

const ok = results.length > 0 && results.every((r) => r.ok);
for (const r of results) r.line ??= `${label(T.checks.find((c) => c.id === r.id))}: ${r.ok ? 'pass' : `fail: ${r.reason}`}`;
writeFileSync(join(T.ev, 'checks.json'), JSON.stringify({ after, ok, trees, heads, definition: def.files, results: results.map(({ id, ok, line, log, spec, heads: h }) => ({ id, ok, line, log, spec, heads: h })) }, null, 2) + '\n');
console.log(`checks: ${ok ? 'pass' : 'fail'} (${results.filter((r) => r.ok).length}/${results.length} due${after ? ', after steps included' : ''}; definition ${def.files.join(', ')})`);
for (const r of results) console.log(`- ${r.line}`);
if (!results.length) console.log('- no check is due');
if (!allow.length && T.checks.some((c) => due(c, after) && /^cmd:/.test(c.verify))) console.log('- no checks_allow in the project definition');
process.exit(ok ? 0 : 1);
