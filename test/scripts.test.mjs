// Tests for skills/deliver/scripts. Run: node --test test/*.test.mjs
// Each test builds a small invented project (a library app) in a temporary folder.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, realpathSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { spawnArgs, verdict } from '../skills/deliver/scripts/ticket.mjs';

const scripts = join(dirname(fileURLToPath(import.meta.url)), '..', 'skills', 'deliver', 'scripts');
const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
const git = (cwd, ...a) => execFileSync('git', a, { cwd, env, encoding: 'utf8' }).trim();
const run = (name, ...a) => spawnSync(process.execPath, [join(scripts, `${name}.mjs`), ...a], { env, encoding: 'utf8' });
const write = (p, t) => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, t); };
const edit = (p, from, to) => writeFileSync(p, readFileSync(p, 'utf8').replace(from, to));
const commit = (p, msg) => { git(p, 'add', '-A'); git(p, 'commit', '-qm', msg); return git(p, 'rev-parse', 'HEAD'); };

const RENEW = ['export function renew(loan, limit) {', '  if (loan.renewals >= limit) {', "    throw new Error('limit');", '  }', '  loan.renewals += 1;', '  return loan;', '}', ''].join('\n');
const RENEW_TEST = "import { renew } from './renew.ts';\n// refuses the fourth renewal\n";
const RENEW_CHECK = "import { readFileSync } from 'node:fs';\nconsole.log('1 test passed');\nprocess.exit(readFileSync('src/loans/renew.ts', 'utf8').includes('>= limit)') ? 1 : 0);\n";
const ORACLE = (says) => `console.log(${JSON.stringify(says)});\n`;
const RENEW_WORDS = [process.execPath, 'test/renew.mjs'];

// A ticket folder with one worktree ("catalog"), optionally a second ("web"), and a project definition whose folder
// holds a canonical copy of the catalog's oracle. f.plan and f.checks write as the planner does: then run plan-shape.
function ticket({ web = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'aw-test-'));
  const t = join(root, 'EX-1');
  const repo = (name, files) => {
    const p = join(t, name);
    mkdirSync(p, { recursive: true });
    git(p, 'init', '-q', '-b', 'main');
    for (const [f, c] of Object.entries(files)) write(join(p, f), c);
    const sha = commit(p, 'base');
    git(p, 'checkout', '-q', '-b', 'fix/EX-1');
    return { path: p, sha };
  };
  const cat = repo('catalog', { 'src/loans/renew.ts': RENEW, 'src/loans/renew.test.ts': RENEW_TEST, 'scripts/oracle.mjs': ORACLE('0 disagreements'), 'test/renew.mjs': RENEW_CHECK, 'test/none.mjs': "console.log('No tests found')\n", Dockerfile: 'FROM node\nRUN true\n' });
  const w = web ? repo('web', { 'src/loans/renew.ts': RENEW, 'src/pages/loan.tsx': 'export const Loan = () => null;\n', 'messages/en.json': '{}\n' }) : null;
  write(join(root, 'catalog', 'scripts', 'oracle.mjs'), ORACLE('0 disagreements'));
  const state = (extra = '') => write(join(t, 'STATE.md'), [
    '# State: EX-1', '', 'Project: library-app', 'Ticket: EX-1', 'Type: bug (named by: the person)', 'Size: small', 'Started: 2026-01-05T09:00Z', 'Profile: none',
    `Worktree catalog: catalog on fix/EX-1, from main at ${cat.sha}`,
    ...(w ? [`Worktree web: web on fix/EX-1, from main at ${w.sha}`] : []),
    'Delivery 1: the refusal: delivered 2026-01-05T15:00Z main', extra, '', '## Surface', '- S1 (renewal-count): renewal count: loan page; equals loans.renewals', '', '## Outside the ticket', '- [surface] a late fee shown twice, src/fees.ts: hotfix EX-2 opened', '- a typo, page footer: file EX-3', '',
  ].join('\n'));
  state();
  const def = join(root, 'project.md');
  write(def, '---\nname: library-app\nchecks_allow: [node test/renew.mjs, node test/none.mjs, node test/count.mjs, node ./catalog/scripts/oracle.mjs]   # runners\nnothing_ran: [No tests found, /^0 passing/m]\nscreen_paths:\n  - web/src/pages\n  - web/messages\n---\n');
  const S = (...more) => run('plan-shape', t, '--definition', def, ...more);
  const plan = (body) => { write(join(t, 'PLAN.md'), body); return S(); };
  const checks = (list) => { write(join(t, 'CHECKS.json'), JSON.stringify(list, null, 2)); return S(); };
  const hash = () => readFileSync(join(t, 'evidence', 'plan-shape.md'), 'utf8').match(/plan ([0-9a-f]{12})/)[1];
  const challenge = (k, v = 'build', extra = '') => write(join(t, 'evidence', `challenge-${k}.md`), `Plan: ${hash()}\n${extra}Verdict: ${v}\n`);
  const L = (...more) => run('links', t, '--delivery', '1', ...more, '--definition', def);
  const C = (...more) => run('checks', t, '--delivery', '1', ...more, '--definition', def);
  return { root, t, cat, w, state, plan, checks, def, S, L, C, hash, challenge, ev: (n) => join(t, 'evidence', n), done: () => rmSync(root, { recursive: true, force: true }) };
}

const goodPlan = (cat, extra = '') => `# Plan: EX-1 A fourth renewal is refused

Revision: 2
Risk: low
Read at: catalog@${cat.sha.slice(0, 12)}

## Deliveries
1. The refusal.

## Surface
- S1 (renewal-count): renewal count: loan page; equals loans.renewals; \`src/loans/renew.ts:5\` \`loan.renewals += 1\`

## Decisions
### D1: Where the limit is enforced
- Choice: in renew()
- Source: \`loans/renew.ts:2\` \`if (loan.renewals >= limit)\`
- Beats: a check in the page, which a job would skip

## Tests
| ID | Behaviour | Test (file › name) | Asserts | Fails before | Delivery |
|---|---|---|---|---|---|
| T1 | A fourth renewal is refused | \`test/renew.mjs › refuses the fourth renewal\` | throws, count unchanged | yes | 1 |
| T2 | The page shows the count | (new) \`loan.test.ts › shows the count\` | the count | no | 1 |
${extra}`;
const goodChecks = [{ id: 'C1', proves: 'the count shown equals the stored count', surface: ['S1'], verify: 'cmd: node ./catalog/scripts/oracle.mjs --stack {worktree}', in: 'catalog', expect: '0 disagreements', due: 'before delivery 1' }];
const walkCheck = { ...goodChecks[0], id: 'C5', surface: [], verify: 'walk: renew four times on the loan page' };
const walked = (f, id, sha, result = 'pass') => write(f.ev(`walk-${id}.md`), `Check: ${id}\nCommit: catalog@${sha}\nResult: ${result}\nSeen: three renewals, the fourth refused\n`);

// What the planner does before the challenge: the tests first, as the ticket branch's first commit, T1 red there,
// and each check run once.
function onBase(f) {
  write(join(f.cat.path, 'test/renew.mjs'), RENEW_CHECK + '// T1: refuses the fourth renewal\n');
  const first = commit(f.cat.path, 'tests first');
  run('proof', f.t, '--in', 'catalog', '--test', 'T1', '--base', '--', ...RENEW_WORDS);
  f.checks(goodChecks);
  f.C();
  return { first, r: f.plan(goodPlan(f.cat)) };
}

// A delivery whose links all hold: challenged, red then green with one command, reviewed at HEAD, checks passed.
function deliverable(f, review = 'Verdict: clean') {
  onBase(f);
  f.challenge(1);
  edit(join(f.cat.path, 'src/loans/renew.ts'), '>=', '>= 0 +');
  const head = commit(f.cat.path, 'fix');
  write(f.ev('review-1-1.md'), `Commit: catalog@${head.slice(0, 12)}\n${review}\n`);
  run('proof', f.t, '--in', 'catalog', '--test', 'T1,T2', '--', ...RENEW_WORDS);
  assert.equal(f.C().status, 0);
  return head;
}

test('plan-shape passes a plan whose citations resolve, whose red ran and whose checks ran on the base; CRLF reads the same; the definition must exist', () => {
  const f = ticket();
  const { r } = onBase(f);
  assert.equal(r.status, 0, r.stdout);
  assert.match(r.stdout, /revision 2, risk low, \d+ words, 1 decisions, 2 citations, 2 tests rows, 1 checks, surface ([0-9a-f]{12}), plan [0-9a-f]{12}\ndefinition: .*project\.md/);
  const surface = r.stdout.match(/surface ([0-9a-f]{12})/)[1];
  const crlf = f.plan(goodPlan(f.cat).replace(/\n/g, '\r\n'));
  assert.equal(crlf.status, 0, crlf.stdout);
  assert.equal(crlf.stdout.match(/surface ([0-9a-f]{12})/)[1], surface);
  assert.equal(run('plan-shape', f.t).status, 2, 'the definition is required');
  assert.match(run('plan-shape', f.t, '--definition', join(f.root, 'nowhere.md')).stderr, /no definition at .*nowhere\.md/);
  write(f.def, readFileSync(f.def, 'utf8').replace(/\n/g, '\r\n'));
  assert.match(f.C().stdout, /C1 \[S1\]: pass/, 'a CRLF definition reads the same');
  f.done();
});

test('plan-shape fails what a later script could not read or what was never run: drifted citations, a proposal as a source, an open question, a missing evidence file, a prose States line, a row never red, a check never run, a delivery the plan lacks', () => {
  const f = ticket();
  write(f.ev('discover-ground.md'), '# Ground\n\n## Findings\n- the limit is checked at renew.ts:2\n\n## Proposals\n- refuse with 409\n');
  f.checks([{ ...goodChecks[0], surface: [] }, { ...goodChecks[0], id: 'C2', surface: ['S9'], expect: '/.*/s' }, { ...goodChecks[0], id: 'C3', due: 'before delivery 4' }]);
  const r = f.plan(goodPlan(f.cat, '\nSee `renew.ts:99`, `src/loans/gone.ts:1`, `renew.ts:3` `return null`, `app/[id]/page.tsx:3` and evidence/discover-angle.md, not `127.0.0.1:5432`, `db.local:5432` or `10:30`.\n\n## Questions\n- Q1: Show the fee on the receipt?\n\n## What people see\nPurpose: a member sees renewals left.\nStates: free (390 en ar, 1440 en), taken because the loan is overdue\n')
    .replace('Risk: low', 'Risk: medium').replace('- Beats: a check in the page, which a job would skip\n', '').replace('- S1 (', '- S9 (')
    .replace(/- Source: .*/, '- Source: `evidence/discover-ground.md:7`').replace('| no | 1 |', '| no | 3 |'));
  assert.equal(r.status, 1);
  for (const want of [/app\/\[id\]\/page\.tsx:3: missing/, /renew\.ts:99: past the end/, /gone\.ts:1: missing/, /renew\.ts:3: `return null` is not on those lines/, /Risk: "medium"/, /D1: no Beats/, /D1: Source names no resolving/, /C2: expect is empty or matches anything/, /S9: no check/, /S1: in STATE\.md's Surface draft/,
    /Q1: open; the decision judge answers it/, /evidence\/discover-angle\.md: missing/, /States: "taken because the loan is overdue" is not a short name/, /States: "free \(390/, /T1: fails before, and no proof line shows it red/, /C1: never run as written/, /C3: due in a delivery that is not in Deliveries/, /T2: delivery 3 is not in Deliveries/])
    assert.match(r.stdout, want);
  assert.doesNotMatch(r.stdout, /127\.0\.0\.1|db\.local|10:30/);
  assert.match(f.plan(goodPlan(f.cat).replace('- Source: `loans/renew.ts:2`', '- Source: `evidence/discover-ground.md:4`')).stdout, /plan-shape: fail \d+\n/);
  assert.doesNotMatch(f.S().stdout, /D1: Source/, 'an evidence line outside Proposals is a source');
  assert.match(f.plan(goodPlan(f.cat).replace(/## Deliveries\n1\..*\n/, '## Deliveries\nall at once\n  1. indented\n')).stdout, /Deliveries: lists no "1\." line/);
  f.done();
});

test('plan-shape: path forms resolve the same; a basename two repos hold is ambiguous; an extensionless file is a citation', () => {
  const f = ticket({ web: true });
  write(join(f.cat.path, 'web/src/loans/renew.ts'), RENEW);
  const sha = commit(f.cat.path, 'nested web folder');
  f.checks(goodChecks);
  const r = f.plan(goodPlan(f.cat, '\nAlso `web/src/loans/renew.ts:2`, `./src/pages/loan.tsx:1`, `src\\pages\\loan.tsx:1` and `Dockerfile:9`.\n').replace(/Read at: .*/, `Read at: catalog@${sha}, web@${f.w.sha}`));
  assert.equal(r.status, 1);
  assert.match(r.stdout, /loans\/renew\.ts:2: ambiguous/);
  assert.match(r.stdout, /web\/src\/loans\/renew\.ts:2: ambiguous, candidates: web\/src\/loans\/renew\.ts, catalog\/web\/src\/loans\/renew\.ts/);
  assert.match(r.stdout, /Dockerfile:9: past the end of the file \(2 lines\)/);
  assert.doesNotMatch(r.stdout, /loan\.tsx:1/);
  f.done();
});

test('the Surface hash ignores wording and citations, changes with what a line must equal, and plan-shape shows the drift', () => {
  const f = ticket();
  f.checks(goodChecks);
  const hash = (body) => f.plan(body).stdout.match(/surface ([0-9a-f]{12})/)[1];
  const base = hash(goodPlan(f.cat));
  assert.equal(hash(goodPlan(f.cat).replace('renewal count: loan page', 'the renewal count (the stored count): loan page').replace(':5`', ':6`')), base);
  assert.notEqual(hash(goodPlan(f.cat).replace('equals loans.renewals', 'equals the renewals shown last week')), base);
  assert.match(f.S().stdout, /S1 draft: S1 \(renewal-count\): renewal count: loan page; equals loans\.renewals\n  S1 plan:  S1 \(renewal-count\): renewal count: loan page; equals the renewals shown last week/);
  f.done();
});

test('a verdict is one whole Verdict: line; a fix count equals the findings, clean has none', () => {
  const F = (n) => `## Findings\n${Array.from({ length: n }, (_, i) => `- F${i + 1} \`src/a.ts:${i + 1}\` x`).join('\n')}\n`;
  for (const [t, want] of [['Verdict: clean', 'clean'], ['**Verdict:** Clean.', 'clean'], ['Verdict: `clean`', 'clean'], [`Verdict: fix: 2\n${F(2)}`, 'fix'], [`Verdict: fix: 2 findings\n${F(2)}`, 'fix'], ['Verdict: build', 'build'], ['Verdict: fix items 2, 4', 'fix'],
    ['Verdict: cleanup needed', 'invalid'], [`Verdict: fix: 0 blocking, 4 others\n${F(4)}`, 'invalid'], [`Verdict: clean\n${F(2)}`, 'invalid'], [`Verdict: fix: 3\n${F(2)}`, 'invalid'], ['Verdict: clean\nVerdict: fix: 1', 'invalid'], ['no verdict', 'invalid'],
    ['Verdict: clean\nF1 of round 1 is fixed at `src/a.ts:2`.', 'clean']])
    assert.equal(verdict(t), want, t);
});

test('rounds names the next file with no cap, a re-read of changed screens included, and refuses an unplanned delivery', () => {
  const f = ticket();
  f.plan(goodPlan(f.cat));
  for (const k of [1, 2, 3, 4]) write(f.ev(`review-1-${k}.md`), 'Verdict: fix: 1');
  write(f.ev('review-1-1-draft.md'), 'notes');
  assert.match(run('rounds', f.t, 'review', '1').stdout, /next: evidence\/review-1-5\.md[\s\S]*ignored, not a round file name: review-1-1-draft\.md/);
  assert.match(run('rounds', f.t, 'read', '1').stdout, /next: evidence\/read-1\.md/);
  write(f.ev('read-1.md'), 'x');
  assert.match(run('rounds', f.t, 'read', '1').stdout, /next: evidence\/read-1-2\.md/);
  const r = run('rounds', f.t, 'read', '2');
  assert.equal(r.status, 1);
  assert.match(r.stdout, /refused: delivery 2 is not in the plan's Deliveries \(1\)/);
  f.done();
});

test('proof records the exit and the working tree, untracked files included, and a command that never ran', () => {
  const f = ticket();
  run('proof', f.t, '--in', 'catalog', '--test', 'T1', '--base', '--', ...RENEW_WORDS);
  write(join(f.cat.path, 'src/loans/new.ts'), 'x\n');
  run('proof', f.t, '--in', 'catalog', '--test', 'T1', '--', 'no-such-runner');
  const [a, b] = readFileSync(f.ev('proof.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual([a.base, a.exit, b.base, b.exit], [true, 1, false, null]);
  assert.match(b.error, /ENOENT/);
  assert.equal(a.tree, git(f.cat.path, 'rev-parse', 'HEAD^{tree}'));
  assert.notEqual(b.tree, a.tree);
  assert.equal(git(f.cat.path, 'status', '--porcelain'), '?? src/loans/new.ts');
  assert.equal(run('proof', f.t, '--in', 'nowhere', '--', 'true').status, 2);
  f.done();
});

test('on Windows a word with a quote is refused before cmd.exe sees it', () => {
  const bin = mkdtempSync(join(tmpdir(), 'aw-bin-'));
  write(join(bin, 'runner.CMD'), '@echo off\n');
  const e = { PATH: bin, PATHEXT: '.CMD' };
  assert.match(spawnArgs(['runner', 'a"&calc'], true, e).error, /quote/);
  assert.deepEqual(Object.values(spawnArgs(['runner', 'a&b'], true, e).env).map((x) => x.toLowerCase()), [join(bin, 'runner.CMD').toLowerCase(), 'a&b']);
  rmSync(bin, { recursive: true });
});

test('checks: oracles run from the definition folder, the allow-list is a prefix, nothing-ran and trivial expects fail, walks need their fields, logs name the spec', () => {
  const f = ticket();
  write(join(f.cat.path, 'scripts/oracle.mjs'), ORACLE('rigged: 0 disagreements'));
  const head = commit(f.cat.path, 'the branch edits its oracle');
  f.checks([
    { ...goodChecks[0], expect: '/^0 disagreements/m' },
    { ...goodChecks[0], id: 'C2', verify: 'cmd: node -e 1' },
    { ...goodChecks[0], id: 'C3', verify: 'cmd: node test/renew.mjs; rm -rf /' },
    { ...goodChecks[0], id: 'C4', verify: 'cmd: node test/none.mjs', expect: '/./' },
    { ...goodChecks[0], id: 'C6', verify: 'cmd: node test/none.mjs', expect: 'tests' },
    walkCheck, { ...walkCheck, id: 'C7' }, { ...walkCheck, id: 'C9' },
    { ...goodChecks[0], id: 'C8', verify: 'walk: x', due: 'before delivery 2' },
  ]);
  walked(f, 'C5', head);
  walked(f, 'C9', f.cat.sha);
  write(f.ev('walk-C7.md'), `walked at catalog@${head}\nseen: fine\n`);
  const r = f.C();
  assert.equal(r.status, 1);
  for (const want of [/C1 \[S1\]: pass/, /C2 \[S1\]: fail: "node -e" does not start with an entry of checks_allow/, /C3 \[S1\]: fail: not a plain command/, /C4 \[S1\]: fail: expect is empty or matches anything/, /C6 \[S1\]: fail: ran nothing \("No tests found"\)/, /C5: pass/, /C7: fail: evidence\/walk-C7\.md has no "Check: C7" line/, /C9: fail: .*doesn't stand for catalog HEAD/])
    assert.match(r.stdout, want);
  assert.doesNotMatch(r.stdout, /C8/);
  assert.match(readFileSync(f.ev('checks/C1.log'), 'utf8'), new RegExp(`^check C1 spec [0-9a-f]{12} trees [\\s\\S]*--stack ${realpathSync(f.cat.path).replace(/[/.]/g, '\\$&')}`));
  walked(f, 'C5', head, 'fail');
  f.checks([walkCheck]);
  assert.match(f.C().stdout, /C5: fail: evidence\/walk-C5\.md says Result: fail/);
  f.checks([{ ...walkCheck, due: 'after deploy in delivery 1' }]);
  assert.match(f.C().stdout, /checks: fail \(0\/0[\s\S]*no check is due for delivery 1/);
  rmSync(join(f.root, 'catalog'), { recursive: true });
  f.checks([goodChecks[0]]);
  assert.match(f.C().stdout, /C1 \[S1\]: fail: \.\/catalog\/scripts\/oracle\.mjs is not in the definition's folder/);
  f.done();
});

test('checks: a pass stands while its commits stand and a green proof line with the same words is adopted; an oracle always runs; heavy waits for a clean review; a named oracle change runs the worktree\'s copy', () => {
  const f = ticket();
  write(join(f.cat.path, 'test/count.mjs'), "import { appendFileSync } from 'node:fs';\nappendFileSync('../count.ran', 'x');\nconsole.log('count ok');\n");
  commit(f.cat.path, 'a counting check');
  write(join(f.cat.path, 'src/loans/renew.ts'), RENEW + '// changed\n');
  const head = commit(f.cat.path, 'the change');
  const ran = () => (existsSync(join(f.t, 'count.ran')) ? readFileSync(join(f.t, 'count.ran'), 'utf8').length : 0);
  const count = { id: 'C2', proves: 'counts', surface: [], verify: 'cmd: node test/count.mjs', in: 'catalog', expect: 'count ok', due: 'before delivery 1' };
  f.checks([goodChecks[0], count]);
  assert.equal(f.C().status, 0);
  assert.equal(ran(), 1);
  git(f.cat.path, 'commit', '-q', '--allow-empty', '-m', 'merge with an identical tree');
  git(f.cat.path, 'checkout', '-q', 'main');
  write(join(f.cat.path, 'docs/notes.md'), 'unrelated\n');
  commit(f.cat.path, 'the base moves, away from the change\'s files');
  git(f.cat.path, 'checkout', '-q', 'fix/EX-1');
  git(f.cat.path, 'merge', '-q', '--no-edit', 'main');
  const again = f.C();
  assert.match(again.stdout, /C2: pass \(stands from [0-9a-f]{12}\)/);
  assert.match(again.stdout, /C1 \[S1\]: pass$/m);
  assert.equal(ran(), 1);
  write(join(f.cat.path, 'src/loans/renew.ts'), RENEW + '// changed again\n');
  commit(f.cat.path, 'a fix to the change');
  run('proof', f.t, '--in', 'catalog', '--', 'node', 'test/count.mjs');
  assert.equal(ran(), 2);
  assert.match(f.C().stdout, /C2: pass \(adopted from proof/);
  assert.equal(ran(), 2);
  f.checks([{ ...count, heavy: true }]);
  assert.match(f.C().stdout, /C2: fail: heavy: waits for the newest review/);
  write(f.ev('review-1-1.md'), `Commit: catalog@${git(f.cat.path, 'rev-parse', 'HEAD')}\nVerdict: clean\n`);
  assert.match(f.C().stdout, /C2: pass/);
  write(join(f.cat.path, 'scripts/oracle.mjs'), ORACLE('worktree oracle: 0 disagreements'));
  commit(f.cat.path, 'the oracle the outcome needs');
  f.checks([{ ...goodChecks[0], expect: 'worktree oracle' }]);
  assert.match(f.C().stdout, /C1 \[S1\]: fail: output does not hold/);
  f.plan(goodPlan(f.cat).replace('Read at:', 'Oracles changed: ./catalog/scripts/oracle.mjs\nRead at:'));
  assert.match(f.C().stdout, /C1 \[S1\]: pass/);
  assert.ok(head);
  f.done();
});

test('links passes a delivery whose proof chain holds; an invalid verdict sends a fresh review', () => {
  const f = ticket();
  deliverable(f);
  const r = f.L();
  assert.equal(r.status, 0, r.stdout);
  assert.match(r.stdout, /plan as its planner left it \| yes/);
  assert.match(r.stdout, /design challenged \| yes/);
  assert.match(r.stdout, /oracles \| yes \| no oracle for renewal-count/);
  edit(f.ev('review-1-1.md'), 'Verdict: clean', 'Verdict: cleanup needed');
  assert.match(f.L().stdout, /review verdict \| no \| review-1-1\.md: invalid \| review \|/);
  f.done();
});

test('links: a plan changed by anyone but its planner, or failing plan-shape, stops; a fold re-run through plan-shape needs a new challenge', () => {
  const f = ticket();
  deliverable(f);
  write(join(f.t, 'CHECKS.json'), JSON.stringify([{ ...goodChecks[0], expect: 'disagreements' }]));
  assert.match(f.L().stdout, /plan as its planner left it \| no \| PLAN\.md or CHECKS\.json changed since plan-shape recorded plan .* \| plan \|/);
  f.S();
  assert.match(f.L().stdout, /plan as its planner left it \| no \| plan-shape fails on plan .*C1: never run as written/);
  assert.match(f.L().stdout, /checks \| no \| stale for C1/);
  f.C();
  f.S();
  const r = f.L().stdout;
  assert.match(r, /plan as its planner left it \| yes/);
  assert.match(r, /design challenged \| no \| no challenge-<k>\.md has "Plan: [0-9a-f]{12}" \| challenge \|/);
  f.plan(goodPlan(f.cat, '\n## Questions\n- Q1: Fee?\n'));
  assert.match(f.L().stdout, /plan as its planner left it \| no \| plan-shape fails on plan/);
  f.done();
});

test('links: a challenge upheld after a ruling, folded into the plan, passes; an objection open on the current plan stops', () => {
  const f = ticket();
  deliverable(f);
  f.challenge(2, 'fix items 2');
  assert.match(f.L().stdout, /design challenged \| no \| challenge-2\.md: fix \| plan, then challenge \|/);
  f.plan(goodPlan(f.cat).replace('- Beats: a check', '- Ruling: the objection to item 2 is refuted, `evidence/challenge-2.md:1`\n- Beats: a check'));
  f.challenge(3);
  assert.match(f.L().stdout, /design challenged \| yes \| challenge-3\.md: build/);
  f.done();
});

test('links: reviews go on while one names a failing state; a Commit: sha must exist; commits that stand keep the review', () => {
  const f = ticket();
  const head = deliverable(f);
  write(f.ev('review-1-1.md'), `Commit: catalog@deadbeefdead\nVerdict: clean\n`);
  assert.match(f.L().stdout, /catalog reviewed \| no \| review-1-1\.md names deadbeefdead: not a commit here/);
  write(join(f.cat.path, 'src/loans/other.ts'), 'x\n');
  commit(f.cat.path, 'unreviewed');
  write(f.ev('review-1-1.md'), `Commit: catalog@${head.slice(0, 12)}\nVerdict: clean\n`);
  assert.match(f.L().stdout, /catalog reviewed \| no \| .*changed since outside its findings \| review \|/);
  git(f.cat.path, 'reset', '-q', '--hard', head);
  for (const k of [2, 3]) write(f.ev(`review-1-${k}.md`), `Commit: catalog@${head}\nVerdict: fix: 1\n## Findings\n- F1 \`src/loans/renew.ts:2\` off by one\n`);
  assert.match(f.L().stdout, /review verdict \| no \| review-1-3\.md: fix \| implement, then review \|/);
  write(f.ev('review-1-4.md'), `Commit: catalog@${head}\nVerdict: clean\n`);
  git(f.cat.path, 'commit', '-q', '--allow-empty', '-m', 'a merge that changed no byte');
  const r = f.L();
  assert.equal(r.status, 0, r.stdout);
  assert.match(r.stdout, /rounds: review 4/);
  f.done();
});

test('a base update that leaves the change\'s files alone keeps the review, the rows, the checks and the walks; one that touches them does not', () => {
  const f = ticket();
  git(f.cat.path, 'branch', 'upstream');
  edit(join(f.t, 'STATE.md'), 'from main at', 'from upstream at');
  const head = deliverable(f);
  walked(f, 'C5', head);
  f.checks([...goodChecks, walkCheck]);
  f.challenge(2);
  f.C();
  git(f.cat.path, 'checkout', '-q', 'upstream');
  write(join(f.cat.path, 'docs/notes.md'), 'unrelated\n');
  commit(f.cat.path, 'base moves');
  git(f.cat.path, 'checkout', '-q', 'fix/EX-1');
  git(f.cat.path, 'merge', '-q', '--no-edit', 'upstream');
  let r = f.L();
  assert.equal(r.status, 0, r.stdout);
  git(f.cat.path, 'reset', '-q', '--hard', head);
  git(f.cat.path, 'rebase', '-q', 'upstream');
  assert.match(f.C().stdout, /C5: pass/);
  assert.equal(f.L().status, 0);
  git(f.cat.path, 'checkout', '-q', 'upstream');
  edit(join(f.cat.path, 'src/loans/renew.ts'), 'return loan;', 'return { ...loan };');
  commit(f.cat.path, 'base touches the change\'s file');
  git(f.cat.path, 'checkout', '-q', 'fix/EX-1');
  git(f.cat.path, 'merge', '-q', '--no-edit', 'upstream');
  r = f.L().stdout;
  assert.match(r, /catalog reviewed \| no/);
  assert.match(r, /T1 red then green \| no \| not green on a commit that stands/);
  f.done();
});

test('a red counts only on a tree that changes tests alone, the row\'s own among them, and never when nothing ran; the HEAD green uses the red\'s words', () => {
  const f = ticket();
  deliverable(f);
  f.plan(goodPlan(f.cat).replace('| T2 | The page shows the count | (new) `loan.test.ts › shows the count` | the count | no | 1 |', '| T2 | The count is unchanged | `src/loans/renew.test.ts › keeps the count` | count unchanged | yes | 1 |'));
  let r = f.L().stdout;
  assert.match(r, /T1 red then green \| yes/);
  assert.match(r, /T2 red then green \| no \| no red on the base/, 'a T1,T2 red counts only for the row whose test changed');
  writeFileSync(f.ev('proof.jsonl'), '');
  git(f.cat.path, 'checkout', '-q', f.cat.sha);
  write(join(f.cat.path, 'test/renew.mjs'), RENEW_CHECK + '// T1\n');
  write(join(f.cat.path, 'src/loans/renew.ts'), RENEW + '// half a fix\n');
  run('proof', f.t, '--in', 'catalog', '--test', 'T1', '--base', '--', ...RENEW_WORDS);
  git(f.cat.path, 'checkout', '-q', '.');
  write(join(f.cat.path, 'test/renew.mjs'), "console.log('No tests found'); process.exit(1);\n");
  run('proof', f.t, '--in', 'catalog', '--test', 'T1', '--base', '--', ...RENEW_WORDS);
  git(f.cat.path, 'checkout', '-q', '.');
  git(f.cat.path, 'checkout', '-q', 'fix/EX-1');
  run('proof', f.t, '--in', 'catalog', '--test', 'T1', '--', ...RENEW_WORDS);
  assert.match(f.L().stdout, /T1 red then green \| no \| no red on the base/);
  writeFileSync(f.ev('proof.jsonl'), '');
  git(f.cat.path, 'checkout', '-q', 'HEAD~1');
  run('proof', f.t, '--in', 'catalog', '--test', 'T1', '--base', '--', ...RENEW_WORDS);
  git(f.cat.path, 'checkout', '-q', 'fix/EX-1');
  run('proof', f.t, '--in', 'catalog', '--test', 'T1', '--', process.execPath, './test/renew.mjs');
  r = f.L().stdout;
  assert.match(r, /T1 red then green \| no \| the base red and the green ran different words/);
  assert.match(r, /- proof \S+ --in catalog --test T1 -- \S+ test\/renew\.mjs$/m);
  f.done();
});

test('links: risk is the plan\'s or the last a challenger stated; the approval names the plan it approved', () => {
  const f = ticket();
  deliverable(f);
  f.challenge(2, 'build', 'Risk: high\n');
  assert.match(f.L().stdout, /approval \| no .*does not name plan .* \| the person \|/);
  f.state(`Approval: "go ahead", 2026-01-05T10:00Z, plan ${f.hash()}`);
  assert.match(f.L().stdout, /approval \| yes/);
  f.plan(goodPlan(f.cat).replace('renewal count:', 'the renewal count, as stored:'));
  f.challenge(3);
  assert.match(f.L().stdout, /approval \| no/, 'a changed plan is approved again');
  f.challenge(4, 'build', 'Risk: low\n');
  assert.doesNotMatch(f.L().stdout, /approval/, 'a later challenger lowered it');
  f.done();
});

test('links: a failing check names who fixes it from verify\'s classification', () => {
  const f = ticket();
  deliverable(f);
  write(join(f.root, 'catalog/scripts/oracle.mjs'), ORACLE('3 disagreements'));
  f.C();
  assert.match(f.L().stdout, /checks \| no \| failing: C1 \| verify \|/);
  write(f.ev('verify-1.md'), 'Failing C1: product, the count is off by one\n');
  assert.match(f.L().stdout, /checks \| no \| failing: C1 \(product, .*\| implement \|/);
  write(f.ev('verify-1.md'), 'Failing C1: check, it reads the wrong table\n');
  assert.match(f.L().stdout, /checks \| no \| failing: C1 \(check, .*\| plan \(the checks\)/);
  f.done();
});

test('links: a screenshot stands while no screen path changed since its commit; screens changed after the read are read again; a branch change to an oracle needs the plan to name it', () => {
  const f = ticket({ web: true });
  const head = deliverable(f);
  f.plan(goodPlan(f.cat, `\n## What people see\nPurpose: a member sees how many renewals are left.\nStates: limit-reached, empty\n`));
  f.challenge(2);
  const old = f.w.sha;
  write(f.ev('read-1.md'), `Commit: web@${old}`);
  write(f.ev(`screens/limit_reached-390-en-light-${old.slice(0, 10)}.png`), 'png');
  write(f.ev(`screens/non-empty-1440-ar-${head.slice(0, 10)}.png`), 'png');
  write(join(f.w.path, 'src/api.ts'), 'x\n');
  const w1 = commit(f.w.path, 'api only');
  write(f.ev('review-1-1.md'), `Commit: catalog@${head} web@${w1}\nVerdict: clean\n`);
  f.C();
  let r = f.L();
  assert.match(r.stdout, /screenshot limit-reached \| yes/);
  assert.match(r.stdout, /screenshot empty \| no \| no screenshot whose name holds "empty"/);
  write(f.ev(`screens/d1-empty-1440-ar-${head.slice(0, 10)}.png`), 'png');
  assert.equal(f.L().status, 0);
  write(join(f.w.path, 'messages/en.json'), '{"left": "left"}\n');
  const w2 = commit(f.w.path, 'words');
  write(f.ev('review-1-1.md'), `Commit: catalog@${head} web@${w2}\nVerdict: clean\n`);
  f.C();
  r = f.L().stdout;
  assert.match(r, /screenshot limit-reached \| no \| retake: .*touches web\/messages\/en\.json \| verify \|/);
  assert.match(r, /read \| no \| read-1\.md: screens changed since in web\/messages\/en\.json; read those screens again \| read \|/);
  write(join(f.cat.path, 'scripts/oracle.mjs'), ORACLE('0 disagreements always'));
  commit(f.cat.path, 'loosen the oracle');
  assert.match(f.L().stdout, /oracle catalog\/scripts\/oracle\.mjs \| no \| changed on the branch: scripts\/oracle\.mjs; the plan names it/);
  f.done();
});

test('record writes the counts and the decisions from the files, and counts earlier records as reopenings', () => {
  const f = ticket();
  f.plan(goodPlan(f.cat).replace('Risk: low', 'Risk: high').replace('## Decisions', '- S2 (fee): not touched: fees, `src/fees.ts:1`\n\n## Decisions'));
  for (const n of ['challenge-1.md', 'challenge-2.md', 'review-1-1.md', 'review-1-2.md', 'review-1-2-notes.md', 'read-1.md']) write(f.ev(n), 'x');
  write(f.ev('audit-1.md'), 'Findings: 1 confirmed\n');
  write(f.ev('missed.md'), '- the count was off by one on a renewed loan (review; already there before the change: a Discover miss)\n- a label (reader)\n');
  const records = join(f.root, 'records.jsonl');
  writeFileSync(records, JSON.stringify({ project: 'library-app', ticket: 'EX-1' }) + '\n');
  assert.equal(run('record', f.t, '--records', records).status, 0);
  const line = JSON.parse(readFileSync(records, 'utf8').trim().split('\n').at(-1));
  assert.deepEqual(
    [line.type, line.size, line.risk, line.plan_revisions, line.challenge_rounds, line.read_rounds, line.review_rounds, line.reopened, line.surface_lines, line.surface_not_touched, line.surface_draft, line.surface_extras, line.cold_audit, line.first_delivered, line.profile, line.discover_misses],
    ['bug', 'small', 'high', 2, 2, 1, 2, 1, 1, 1, 1, 1, 1, '2026-01-05T15:00Z', null, 1],
  );
  assert.deepEqual(line.decisions, [{ title: 'D1: Where the limit is enforced', choice: 'in renew()', source: '`loans/renew.ts:2` `if (loan.renewals >= limit)`', reversible: false }]);
  assert.deepEqual(line.audits_missing, []);
  assert.deepEqual(line.surface_kinds, ['renewal-count', 'fee']);
  f.done();
});

test('a walk stands after a repair within the last review\'s findings plus tests, not after any other change, and never on the base', () => {
  const f = ticket();
  const head = deliverable(f, `Verdict: fix: 1\n## Findings\n- F1 \`catalog/src/loans/renew.ts:4\`: a label`);
  walked(f, 'C5', head);
  f.checks([walkCheck]);
  edit(join(f.cat.path, 'src/loans/renew.ts'), "'limit'", "'over the limit'");
  commit(f.cat.path, 'the finding\'s repair');
  assert.match(f.C().stdout, /C5: pass/);
  write(join(f.cat.path, 'src/loans/other.ts'), 'x\n');
  commit(f.cat.path, 'another change');
  assert.match(f.C().stdout, /C5: fail: .*doesn't stand/);
  f.done();
});

test('a booking fact flows end to end: an appointment time on the Surface, its oracle required by plan-shape, run by checks, held by links', () => {
  const f = ticket();
  write(join(f.root, 'tools', 'time-check.mjs'), ORACLE('appointment times: 0 disagreements'));
  write(f.def, '---\nname: clinic\nchecks_allow: [node test/renew.mjs, node ./tools/time-check.mjs]\nsurface_kinds: [appointment-time, availability]\noracles:\n  appointment-time: node ./tools/time-check.mjs --stack {worktree} <spec.json>\n---\n');
  edit(join(f.t, 'STATE.md'), /- S1 .*/, '- S1 (appointment-time): the time on the confirmation; equals bookings.starts_at in the clinic\'s zone');
  onBase(f);
  const booking = goodPlan(f.cat).replace(/- S1 .*/, '- S1 (appointment-time): the time on the confirmation; equals bookings.starts_at in the clinic\'s zone; `src/loans/renew.ts:1`');
  f.checks([{ ...goodChecks[0], verify: 'walk: book the 09:30 slot and read the confirmation', expect: 'confirmation says 09:30' }]);
  walked(f, 'C1', f.cat.sha, 'fail');
  let r = f.plan(booking);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /S1: the project names an oracle for appointment-time \(node \.\/tools\/time-check\.mjs --stack\), and no check of this line runs it/);
  assert.match(r.stdout, /Critical kinds with no Surface line .*: availability/);
  assert.match(f.plan(booking.replace('(appointment-time)', '(time)')).stdout, /Kinds the definition doesn't name \(for the challenger\): S1 \(time\); it names appointment-time, availability/);
  assert.match(run('plan-shape', f.t, '--print', 'reader').stdout, /no What people see section/);
  assert.match(run('plan-shape', f.t, '--print', 'approval').stdout, /## Surface\n- S1 \(time\)/);
  f.checks([{ ...goodChecks[0], verify: 'cmd: node ./tools/time-check.mjs --stack {worktree} spec.json', expect: '0 disagreements' }]);
  f.C();
  r = f.plan(booking);
  assert.equal(r.status, 0, r.stdout);
  f.challenge(1);
  edit(join(f.cat.path, 'src/loans/renew.ts'), '>=', '>= 0 +');
  const head = commit(f.cat.path, 'fix');
  run('proof', f.t, '--in', 'catalog', '--test', 'T1,T2', '--', ...RENEW_WORDS);
  write(f.ev('review-1-1.md'), `Commit: catalog@${head}\nVerdict: clean\n`);
  assert.match(f.C().stdout, /C1 \[S1\]: pass/);
  r = f.L();
  assert.equal(r.status, 0, r.stdout);
  assert.doesNotMatch(r.stdout, /no oracle for/);
  f.done();
});

test('proof names several rows with one run; links lists the words to run once per command; a red in another worktree of the same repo counts', () => {
  const f = ticket();
  const fixed = deliverable(f);
  const lines = readFileSync(f.ev('proof.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(lines.map((l) => l.test), ['T1', 'T1', 'T2']);
  assert.equal(lines[0].repository, realpathSync(join(f.cat.path, '.git')));
  write(join(f.cat.path, 'src/loans/renew.ts'), readFileSync(join(f.cat.path, 'src/loans/renew.ts'), 'utf8') + '// later\n');
  const head = commit(f.cat.path, 'a later change');
  write(f.ev('review-1-1.md'), `Commit: catalog@${head}\nVerdict: clean\n`);
  const out = f.L().stdout;
  assert.match(out, /T1 red then green \| no \| not green on a commit that stands for HEAD; run the words below/);
  const listed = out.split('\n').filter((l) => l.startsWith('- proof '));
  assert.equal(listed.length, 1);
  assert.match(listed[0], /--in catalog --test T1,T2 -- \S+ test\/renew\.mjs$/);
  // The red ran in a second worktree of the same repository, named as a lane.
  const side = join(f.root, 'side');
  git(f.cat.path, 'worktree', 'add', '-q', '--detach', side, fixed);
  git(side, 'checkout', '-q', 'HEAD~1');
  f.state(`Lane side: ${side}`);
  writeFileSync(f.ev('proof.jsonl'), '');
  run('proof', f.t, '--in', 'side', '--test', 'T1', '--base', '--', ...RENEW_WORDS);
  run('proof', f.t, '--in', 'catalog', '--test', 'T1,T2', '--', ...RENEW_WORDS);
  const r = f.L().stdout;
  assert.match(r, /T1 red then green \| yes/);
  assert.doesNotMatch(r, /side clean/, 'a lane is not delivered');
  f.done();
});

test('links: a later delivery\'s row is not due; "None." means no screen rows; a delivery after a delivered one needs its audit; record sums audits', () => {
  const f = ticket();
  deliverable(f);
  assert.equal(run('links', f.t, '--delivery', '1').status, 2);
  f.plan(goodPlan(f.cat).replace('1. The refusal.', '1. The refusal.\n2. The page.').replace('| no | 1 |', '| no | 2 |') + '\n## What people see\nNone.\n');
  f.challenge(2);
  assert.doesNotMatch(f.L().stdout, /T2|\| read \|/);
  f.state('Delivery 2: the page: step deliver');
  const L2 = () => run('links', f.t, '--delivery', '2', '--definition', f.def);
  assert.match(L2().stdout, /\| audit 1 \| no \| delivery 1 is delivered and has no evidence\/audit-1\.md \| audit \|/);
  write(f.ev('audit-1.md'), 'Findings: 2\n');
  assert.match(L2().stdout, /\| audit 1 \| yes \| audit-1\.md \|/);
  f.state('Delivery 2: the page: delivered 2026-01-06T10:00Z main');
  const records = join(f.root, 'records.jsonl');
  run('record', f.t, '--records', records);
  const line = JSON.parse(readFileSync(records, 'utf8').trim().split('\n').at(-1));
  assert.deepEqual([line.cold_audit, line.audits_missing], [2, [2]]);
  f.done();
});

test('plan-shape and checks share one rule for an expect that can\'t fail', () => {
  const f = ticket();
  f.plan(goodPlan(f.cat));
  for (const [expect, can] of [['ok', true], ['/./', false], ['', false], ['0 disagreements', true]]) {
    assert.equal(/can't fail|can fail/.test(f.checks([{ ...goodChecks[0], expect }]).stdout), !can, `plan-shape on "${expect}"`);
    assert.equal(/can't fail/.test(f.C().stdout), !can, `checks on "${expect}"`);
  }
  f.done();
});

test('checks --stop ends its own ticket\'s run and the command it started; a stopped run writes nothing and a ticket has one run', async () => {
  const f = ticket();
  const other = ticket();
  const SLOW = "import { spawn } from 'node:child_process';\nimport { writeFileSync } from 'node:fs';\nconst c = spawn('sleep', ['120'], { stdio: 'inherit' });\nwriteFileSync(process.env.CHECK_TICKET + '/sleep.pid', String(c.pid));\nc.on('close', () => process.exit(0));\n";
  for (const x of [f, other]) { write(join(x.cat.path, 'test/renew.mjs'), SLOW); commit(x.cat.path, 'slow'); x.checks([{ id: 'C1', surface: [], due: 'before delivery 1', verify: 'cmd: node test/renew.mjs', expect: 'never' }]); }
  const start = (x) => spawn(process.execPath, [join(scripts, 'checks.mjs'), x.t, '--delivery', '1', '--definition', x.def], { env, stdio: 'ignore' });
  const closed = (p) => new Promise((done) => p.on('close', (code, signal) => done(code ?? signal)));
  const pidOf = async (x) => { for (let i = 0; i < 100 && !existsSync(join(x.t, 'sleep.pid')); i++) await new Promise((d) => setTimeout(d, 100)); return +readFileSync(join(x.t, 'sleep.pid'), 'utf8'); };
  const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  const [p, q] = [start(f), start(other)];
  const [pc, qc] = [closed(p), closed(q)];
  const [sleep, otherSleep] = [await pidOf(f), await pidOf(other)];
  assert.equal(f.C().status, 2, 'a second run on the ticket is refused');
  assert.ok(existsSync(f.ev('checks.run')), 'the refused run leaves the holder in place');
  assert.match(run('checks', f.t, '--stop').stdout, /stopped run/);
  assert.equal(await pc, 143);
  assert.equal(alive(sleep), false);
  assert.equal(existsSync(f.ev('checks.run')), false);
  assert.equal(existsSync(f.ev('checks.json')), false);
  assert.ok(alive(otherSleep), 'the other ticket keeps running');
  assert.match(run('checks', f.t, '--stop').stdout, /no run in progress/);
  run('checks', other.t, '--stop');
  await qc;
  write(join(f.cat.path, 'test/renew.mjs'), "console.log('quick');\n");
  commit(f.cat.path, 'quick');
  write(f.ev('checks.run'), '999999\n');
  assert.equal(f.C().status, 1, 'a file left by a crashed run does not hold the ticket');
  f.done(); other.done();
}, { timeout: 60000 });

test('checks: an unfinished run leaves no result; --stop refuses a wrong folder and ends what a killed run left', async () => {
  const f = ticket();
  const SLOW = "import { spawn } from 'node:child_process';\nimport { writeFileSync } from 'node:fs';\nconst c = spawn('sleep', ['120'], { stdio: 'inherit' });\nwriteFileSync(process.env.CHECK_TICKET + '/sleep.pid', String(c.pid));\nc.on('close', () => process.exit(0));\n";
  write(join(f.cat.path, 'test/renew.mjs'), SLOW);
  write(join(f.cat.path, 'test/none.mjs'), "console.log('none done');\n");
  commit(f.cat.path, 'commands');
  const base = { surface: [], due: 'before delivery 1' };
  const quick = { ...base, id: 'C1', verify: 'cmd: node test/none.mjs', expect: 'none done' };
  f.checks([quick]);
  assert.equal(f.C().status, 0);
  assert.equal(run('checks', join(f.t, 'nope'), '--stop').status, 2);
  rmSync(join(f.t, 'sleep.pid'), { force: true });
  f.checks([quick, { ...base, id: 'C2', verify: 'cmd: node test/renew.mjs', expect: 'never' }]);
  const pidOf = async () => { for (let i = 0; i < 100 && !existsSync(join(f.t, 'sleep.pid')); i++) await new Promise((d) => setTimeout(d, 100)); return +readFileSync(join(f.t, 'sleep.pid'), 'utf8'); };
  const p = spawn(process.execPath, [join(scripts, 'checks.mjs'), f.t, '--delivery', '1', '--definition', f.def], { env, stdio: 'ignore' });
  const closed = new Promise((d) => p.on('close', d));
  const sleep = await pidOf();
  assert.equal(existsSync(f.ev('checks.json')), false, 'replacing logs voids the last result');
  p.kill('SIGKILL');
  await closed;
  const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  assert.ok(alive(sleep));
  assert.match(run('checks', f.t, '--stop').stdout, /ended the command a killed run left/);
  for (let i = 0; i < 50 && alive(sleep); i++) await new Promise((d) => setTimeout(d, 100));
  assert.equal(alive(sleep), false);
  assert.equal(existsSync(f.ev('checks.run')), false);
  f.done();
}, { timeout: 60000 });
