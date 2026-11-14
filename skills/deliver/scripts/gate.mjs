#!/usr/bin/env node
// gate: the one proof run on the settled tree: the definition's gate entries that the change reaches, one at a time.
// Usage: node gate.mjs <ticket-folder> --definition <project definition> [--definition <its .local.md>] [--check]
//        node gate.mjs <ticket-folder> --stop
// The definition's `gate:` is a list of "<repo> | <when> | <command>" lines, with an optional fourth field "heavy".
// <when> selects the entry from the files each worktree (build lanes left out) changed from its base to HEAD:
//   always              the repo has any change
//   <glob>, <glob>      a changed file of the repo, repo-relative, is taken by them ("!<glob>" leaves files out)
//   boundary:<kind>     a changed file in any repo, repo-prefixed, is in that boundary of the definition's boundaries
// In the command, {files} becomes the changed files that selected the entry, deletions left out (an entry whose
// {files} would be empty is not selected; a boundary entry can't use {files}), {worktree} and {ticket} those folders.
// It runs without a shell, only when its words start with an entry of checks_allow, in the repo's worktree; but a word
// of that entry starting ./ ../ or / names a file of the definition's folder (an oracle), and then it runs from there,
// never the branch's copy. It passes when it exits 0 and its output matches none of nothing_ran. Heavy entries run
// last, and not after a failure.
// A pass is kept: an entry that passed on earlier trees is not run again while the files changed since those trees
// are none it reaches (always: no file of its repo; globs: none they take; boundary: none of that boundary, any repo).
// Lists for the verifier, from the diff since each base: test files deleted, test files changed, and added lines of
// test files that hold a skip marker (the definition's skip_markers, or common ones).
// Records per repo whether HEAD contains its base ref's tip. A dirty worktree is refused (exit 2). One run per ticket
// (evidence/gate.run, see runner.mjs); --stop ends it.
// Writes evidence/gate/<n>-<repo>.log, evidence/gate.json (kept as each entry ends) and evidence/gate.md.
// Exit 0 when at least one entry is selected and every selected entry passed or was kept; 1 otherwise.
// --check runs and writes nothing: exit 0 only when every worktree is clean and contains its base's tip, at least one
// entry is selected, and gate.json shows each selected entry passed on trees that still stand for HEAD (ticket.mjs's
// gateCheck, which ready.mjs shares); 1 otherwise.
import { existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { ticket, definitionOf, read, matches, spawnArgs, testFiles, addedLines, gatePlan, gateCheck, shortTrees } from './ticket.mjs';
import { runner } from './runner.mjs';

const args = process.argv.slice(2);
const dir = resolve(args[0] || '.');
const R0 = runner(dir, 'gate.run', 'gate');
if (args.includes('--stop')) R0.stop();
const check = args.includes('--check');
const def = definitionOf(args);
if (!existsSync(join(dir, 'STATE.md'))) { console.error(`gate: ${dir} is not a ticket folder`); process.exit(2); }
const T = ticket(dir);
const P = gatePlan(T, def);
const { W, entries, counted, trees } = P;

if (check) {
  if (R0.busy()) { console.log('gate --check: fail, a gate run is in progress'); process.exit(1); }
  const c = gateCheck(T, def, P);
  console.log(`gate --check: ${c.ok ? 'pass' : 'fail'} (${c.lines.filter((l) => l.ok).length}/${c.lines.length} selected entries stand for ${shortTrees(trees)})`);
  for (const b of c.blockers) console.log(`- fail, ${b}`);
  for (const l of c.lines) console.log(`- ${l.text}`);
  process.exit(c.ok ? 0 : 1);
}
if (P.errors.length) { console.error(`gate: ${P.errors.join('; ')}`); process.exit(2); }
if (P.dirty.length) { console.error(`gate: uncommitted changes in ${P.dirty.join(', ')}: commit them, then run the gate on the settled tree`); process.exit(2); }

// Lists for the verifier: deleted and changed test files, and skip markers on added lines of test files.
const isTestFile = testFiles(def);
const markers = def.list('skip_markers') || ['.skip(', '.only(', 'xit(', 'xdescribe(', '.todo(', '@skip', '@Disabled', '@Ignore'];
const tests = { deleted: [], changed: [], skips: [] };
for (const w of T.repos) for (const c of P.changes[w.name].filter((x) => isTestFile(x.path))) {
  if (c.status === 'D') { tests.deleted.push(`${w.name}/${c.path}`); continue; }
  if (c.status === 'M') tests.changed.push(`${w.name}/${c.path}`);
  for (const a of addedLines(w.path, w.base, 'HEAD', c.path)) if (markers.some((m) => a.text.includes(m))) tests.skips.push({ file: `${w.name}/${c.path}`, line: a.line, text: a.text.trim().slice(0, 160) });
}

let rec = {};
try { rec = JSON.parse(read(join(T.ev, 'gate.json'))) || {}; } catch {}
const passes = rec.passes || {};
R0.hold();
mkdirSync(join(T.ev, 'gate'), { recursive: true });
let runs = +rec.runs || 0;
const results = new Map();
const save = (done) => {
  const out = entries.map((e) => ({ n: e.n, repo: e.repo, when: e.when, command: e.command, heavy: e.heavy, spec: e.spec, selected: !!e.selected, files: e.files || [], ...(results.get(e) || { result: e.bad ? 'fail' : e.selected ? 'pending' : 'not selected', reason: e.bad || '' }), passedOn: passes[e.spec]?.trees || null }));
  const pass = done && counted.length > 0 && counted.every((e) => ['pass', 'kept'].includes(results.get(e)?.result));
  writeFileSync(join(T.ev, 'gate.json'), JSON.stringify({ time: new Date().toISOString(), definition: def.files, done, pass, bases: P.bases, heads: P.heads, trees, contains: P.contains, runs, entries: out, selected: counted.map((e) => e.n), passes, tests }, null, 2) + '\n');
  return pass;
};
const set = (e, r) => results.set(e, r);
for (const e of entries.filter((x) => x.bad)) set(e, { result: 'fail', reason: e.bad });
const order = [...counted.filter((e) => !e.bad && !e.heavy), ...counted.filter((e) => !e.bad && e.heavy)];
for (const e of order) {
  const w = W[e.repo], p = passes[e.spec];
  if (!w) { set(e, { result: 'fail', reason: `no worktree "${e.repo}" in STATE.md: add one at its base to run it` }); continue; }
  if (p && !P.reaches(e, p.trees)) { set(e, { result: 'kept', reason: `passed on ${shortTrees(p.trees)}; nothing it reaches changed since`, log: p.log }); continue; }
  if (e.heavy && [...results.values()].some((r) => r.result === 'fail')) { set(e, { result: 'fail', reason: 'not run: an earlier entry failed' }); continue; }
  if (!e.words?.length) { set(e, { result: 'fail', reason: 'not a plain command: no shell operators, pipes or variables' }); continue; }
  if (!e.allowedBy) { set(e, { result: 'fail', reason: `"${e.words.slice(0, 2).join(' ')}" does not start with an entry of checks_allow` }); continue; }
  const missing = e.own.filter((x) => !existsSync(resolve(def.dir, x)));
  if (missing.length) { set(e, { result: 'fail', reason: `${missing.join(' ')} is not in the definition's folder ${def.dir}` }); continue; }
  const argv = e.words.flatMap((a) => (a === '{files}' ? e.files : e.own.includes(a) ? [resolve(def.dir, a)] : [a.replaceAll('{worktree}', w.path).replaceAll('{ticket}', dir)]));
  const cwd = e.own.length ? def.dir : w.path, s = spawnArgs(argv);
  if (s.error) { set(e, { result: 'fail', reason: s.error }); continue; }
  // The pass it had stops standing the moment its log is replaced; a run that doesn't finish leaves none.
  delete passes[e.spec];
  const log = `evidence/gate/${e.n}-${e.repo}.log`;
  set(e, { result: 'running', reason: '', log });
  runs++;
  save(false);
  const run = await R0.exec(s.argv[0], s.argv.slice(1), { cwd, env: { ...process.env, ...s.env, GATE_WORKTREE: w.path, GATE_TICKET: dir }, windowsVerbatimArguments: !!s.verbatim });
  const out = `${run.stdout || ''}${run.stderr || ''}${run.error ? run.error.message : ''}`;
  const empty = P.nothingRan.find((x) => matches(out, x));
  writeFileSync(join(dir, log), `gate ${e.n} ${e.repo} spec ${e.spec} trees ${JSON.stringify(trees)}\n$ ${argv.join(' ')}\n(in ${cwd})\n${out}\nexit ${run.status ?? run.signal}\n`);
  const ok = !run.error && run.status === 0 && !empty;
  set(e, { result: ok ? 'pass' : 'fail', reason: ok ? '' : run.error ? `did not run: ${run.error.message}` : run.status !== 0 ? `exit ${run.status ?? run.signal}` : `ran nothing ("${empty}")`, log });
  if (ok) passes[e.spec] = { trees, heads: P.heads, time: new Date().toISOString(), log, n: e.n };
  save(false);
}
const pass = save(true);

const ran = [...results.values()].filter((r) => ['pass', 'fail'].includes(r.result) && r.log).length;
const line = (e) => { const r = results.get(e); return `- ${e.n} ${e.repo} | ${e.when} | ${e.command}: ${r.result}${r.reason ? `, ${r.reason}` : ''}${r.log && r.result !== 'kept' ? ` (${r.log})` : ''}`; };
const md = [
  `gate: ${pass ? 'pass' : 'fail'} (${counted.filter((e) => ['pass', 'kept'].includes(results.get(e)?.result)).length}/${counted.length} selected entries pass; ${ran} ran now; definition ${def.files.join(', ')})`,
  `Trees: ${T.repos.map((w) => `${w.name}@${w.tree.slice(0, 12)} (HEAD ${w.head.slice(0, 12)}, base ${w.base.slice(0, 12)}${P.contains[w.name] === true ? '' : P.contains[w.name] === false ? `; behind ${w.baseRef}` : '; no base ref found locally'})`).join(', ')}`,
  ...counted.map(line),
  ...(counted.length ? [] : ['- the diff selects no gate entry']),
  ...(entries.some((e) => !e.selected && !e.bad) ? [`Not selected: ${entries.filter((e) => !e.selected && !e.bad).map((e) => e.n).join(', ')}`] : []),
  '',
  'For the verifier to judge:',
  `- Test files deleted: ${tests.deleted.join(', ') || 'none'}`,
  `- Test files changed: ${tests.changed.join(', ') || 'none'}`,
  `- Skip markers on added lines: ${tests.skips.length ? '' : 'none'}`,
  ...tests.skips.map((s) => `  - ${s.file}:${s.line}: ${s.text}`),
].join('\n');
writeFileSync(join(T.ev, 'gate.md'), md + '\n');
console.log(md);
process.exit(pass ? 0 : 1);
