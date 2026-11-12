// Tests for skills/deliver/scripts. Run: node --test test/*.test.mjs
// Each test builds a small invented project (a library app) in a temporary folder.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, realpathSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

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
    return { path: p, sha: commit(p, 'base') };
  };
  const cat = repo('catalog', { 'src/loans/renew.ts': RENEW, 'src/loans/renew.test.ts': RENEW_TEST, 'scripts/oracle.mjs': ORACLE('0 disagreements'), 'test/renew.mjs': RENEW_CHECK, 'test/none.mjs': "console.log('No tests found')\n" });
  const w = web ? repo('web', { 'src/loans/renew.ts': RENEW, 'src/pages/loan.tsx': 'export const Loan = () => null;\n', 'messages/en.json': '{}\n' }) : null;
  write(join(root, 'catalog', 'scripts', 'oracle.mjs'), ORACLE('0 disagreements'));
  const state = (extra = '') => write(join(t, 'STATE.md'), [
    '# State: EX-1', '', 'Project: library-app', 'Ticket: EX-1', 'Type: bug (named by: the person)', 'Started: 2026-01-05T09:00Z', 'Profile: none',
    `Worktree catalog: catalog on fix/EX-1, from main at ${cat.sha}`,
    ...(w ? [`Worktree web: web on fix/EX-1, from main at ${w.sha}`] : []),
    'Delivery 1: the refusal: delivered 2026-01-05T15:00Z main', extra, '', '## Surface', '- S1 (renewal-count): renewal count: loan page; equals loans.renewals', '', '## Outside the ticket', '- [surface] a late fee shown twice, src/fees.ts: hotfix EX-2 opened', '- a typo, page footer: file EX-3', '',
  ].join('\n'));
  state();
  const def = join(root, 'project.md');
  write(def, '---\nname: library-app\nchecks_allow: [node test/renew.mjs, node test/none.mjs, node ./catalog/scripts/oracle.mjs]   # runners\nnothing_ran: [No tests found, /^0 passing/m]\nscreen_paths:\n  - web/src/pages\n  - web/messages\n---\n');
  const S = (...more) => run('plan-shape', t, '--definition', def, ...more);
  const plan = (body) => { write(join(t, 'PLAN.md'), body); return S(); };
  const checks = (list) => { write(join(t, 'CHECKS.json'), JSON.stringify(list, null, 2)); return S(); };
  const L = (...more) => run('links', t, '--delivery', '1', ...more, '--definition', def);
  const C = (...more) => run('checks', t, '--delivery', '1', ...more, '--definition', def);
  return { root, t, cat, w, state, plan, checks, def, S, L, C, ev: (n) => join(t, 'evidence', n), done: () => rmSync(root, { recursive: true, force: true }) };
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
| T2 | The page shows the count | (new) \`loan.test.ts › shows the count\` | the count | no | 2 |
${extra}`;
const goodChecks = [{ id: 'C1', proves: 'the count shown equals the stored count', surface: ['S1'], verify: 'cmd: node ./catalog/scripts/oracle.mjs --stack {worktree}', in: 'catalog', expect: '0 disagreements', due: 'before delivery 1' }];
const walkCheck = { ...goodChecks[0], id: 'C5', surface: [], verify: 'walk: renew four times on the loan page' };

// What the planner runs on the base before the challenge: T1's red and each check once.
function onBase(f) {
  run('proof', f.t, '--in', 'catalog', '--test', 'T1', '--base', '--', ...RENEW_WORDS);
  f.checks(goodChecks);
  f.C();
  return f.plan(goodPlan(f.cat));
}

// A delivery whose links all hold: challenged, red then green with one command, reviewed at HEAD, checks passed.
function deliverable(f, review = 'Verdict: clean') {
  onBase(f);
  edit(join(f.cat.path, 'src/loans/renew.ts'), '>=', '>= 0 +');
  const head = commit(f.cat.path, 'fix');
  write(f.ev('challenge-1.md'), 'Revision: 2\n**Verdict:** build\n');
  write(f.ev('review-1-1.md'), `Commit: catalog@${head.slice(0, 12)}\n${review}\n`);
  run('proof', f.t, '--in', 'catalog', '--test', 'T1', '--', ...RENEW_WORDS);
  assert.equal(f.C().status, 0);
  return head;
}

test('plan-shape passes a plan whose citations resolve, whose red ran and whose checks ran on the base', () => {
  const f = ticket();
  const r = onBase(f);
  assert.equal(r.status, 0, r.stdout);
  assert.match(r.stdout, /revision 2, risk low, \d+ words, 1 decisions, 2 citations, 2 tests rows, 1 checks, surface [0-9a-f]{12}, plan [0-9a-f]{12}/);
  assert.ok(existsSync(f.ev('plan-shape.md')));
  assert.equal(run('plan-shape', f.t).status, 2, 'the definition is required');
  f.done();
});

test('plan-shape fails what a later script could not read: drifted citations, a prose source, an open question, a missing evidence file, a prose States line, a row never red, a check never run', () => {
  const f = ticket();
  f.checks([{ ...goodChecks[0], surface: [] }, { ...goodChecks[0], id: 'C2', surface: ['S9'], expect: '/.*/s' }]);
  const r = f.plan(goodPlan(f.cat, '\nSee `renew.ts:99`, `src/loans/gone.ts:1`, `renew.ts:3` `return null`, `app/[id]/page.tsx:3` and evidence/discover-ground.md, not `127.0.0.1:5432`.\n\n## Questions\n- Q1: Show the fee on the receipt?\n\n## What people see\nPurpose: a member sees renewals left.\nStates: free (390 en ar, 1440 en), taken because the loan is overdue\n')
    .replace('Risk: low', 'Risk: medium').replace('- Beats: a check in the page, which a job would skip\n', '').replace('- S1 (', '- S9 (')
    .replace(/- Source: .*/, '- Source: the discovery and the ticket'));
  assert.equal(r.status, 1);
  for (const want of [/app\/\[id\]\/page\.tsx:3: missing/, /renew\.ts:99: past the end/, /gone\.ts:1: missing/, /renew\.ts:3: `return null` is not on those lines/, /Risk: "medium"/, /D1: no Beats/, /D1: Source names no/, /C2: expect is empty or matches anything/, /S9: no check/, /S1: in STATE\.md's Surface draft/,
    /Q1: open; the decision judge answers it/, /evidence\/discover-ground\.md: missing/, /States: "taken because the loan is overdue" is not a short name/, /States: "free \(390/, /T1: fails before, and no red proof line names it/, /C1: never run on the base \(no evidence\/checks\/C1\.log\)/])
    assert.match(r.stdout, want);
  assert.doesNotMatch(r.stdout, /127\.0\.0\.1/);
  assert.match(f.plan(goodPlan(f.cat).replace(/## Deliveries\n1\..*\n/, '## Deliveries\nall at once\n')).stdout, /Deliveries: lists no "1\." line/);
  f.done();
});

test('plan-shape: a basename or a repo-prefixed path that two repos hold is ambiguous', () => {
  const f = ticket({ web: true });
  write(join(f.cat.path, 'web/src/loans/renew.ts'), RENEW);
  const sha = commit(f.cat.path, 'nested web folder');
  f.checks(goodChecks);
  const r = f.plan(goodPlan(f.cat, '\nAlso `web/src/loans/renew.ts:2`.\n').replace(/Read at: .*/, `Read at: catalog@${sha}, web@${f.w.sha}`));
  assert.equal(r.status, 1);
  assert.match(r.stdout, /loans\/renew\.ts:2: ambiguous/);
  assert.match(r.stdout, /web\/src\/loans\/renew\.ts:2: ambiguous, candidates: web\/src\/loans\/renew\.ts, catalog\/web\/src\/loans\/renew\.ts/);
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

test('rounds counts exact names only, reads only Verdict: lines, earns a narrow third review from review 2\'s fix verdict, and refuses an unplanned delivery', () => {
  const f = ticket();
  f.plan(goodPlan(f.cat));
  assert.equal(run('rounds', f.t, 'review', '1').status, 0);
  write(f.ev('review-1-1.md'), 'Verdict: fix: 2\nF1 was here and F2 too, under no heading\n');
  write(f.ev('review-1-1-draft.md'), 'notes');
  assert.match(run('rounds', f.t, 'review', '1').stdout, /next: evidence\/review-1-2\.md[\s\S]*ignored, not a round file name: review-1-1-draft\.md/);
  write(f.ev('review-1-2.md'), 'Verdict: clean\nF1 fixed at `src/loans/renew.ts:2`; F2 fixed.\n');
  assert.match(run('rounds', f.t, 'review', '1').stdout, /refused: .*review-1-2\.md exist \(cap 2\)/);
  write(f.ev('review-1-2.md'), '**Verdict:** Fix: 1 finding.\n## Findings\n- F1 `src/loans/renew.ts:2` the count is off by one [S1]\n');
  assert.match(run('rounds', f.t, 'review', '1').stdout, /next: evidence\/review-1-3\.md, the narrow review/);
  write(f.ev('review-1-3.md'), 'Verdict: clean');
  assert.match(run('rounds', f.t, 'review', '1').stdout, /refused: .*review-1-3\.md exist \(cap 3\)/);
  write(f.ev('review-1-2.md'), 'Verdict: clean\n');
  assert.equal(run('rounds', f.t, 'review', '1').status, 1);
  assert.match(run('rounds', f.t).stdout, /delivery 1: read 0\/1, review 3\/2 over/);
  assert.match(run('rounds', f.t, 'read', '2').stdout, /refused: delivery 2 is not in the plan's Deliveries \(1\)/);
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

test('checks: oracles run from the definition folder, the allow-list is a prefix, nothing-ran and trivial expects fail, walks read their own file, output goes to a log', () => {
  const f = ticket();
  write(join(f.cat.path, 'scripts/oracle.mjs'), ORACLE('rigged: 0 disagreements'));
  commit(f.cat.path, 'the branch edits its oracle');
  f.checks([
    { ...goodChecks[0], expect: '/^0 disagreements/m' },
    { ...goodChecks[0], id: 'C2', verify: 'cmd: node -e 1' },
    { ...goodChecks[0], id: 'C3', verify: 'cmd: node test/renew.mjs; rm -rf /' },
    { ...goodChecks[0], id: 'C4', verify: 'cmd: node test/none.mjs', expect: '/./' },
    { ...goodChecks[0], id: 'C6', verify: 'cmd: node test/none.mjs', expect: 'tests' },
    walkCheck,
    { ...walkCheck, id: 'C7' },
    { ...goodChecks[0], id: 'C8', verify: 'walk: x', due: 'before delivery 2' },
  ]);
  write(f.ev('walk-C5.md'), `walked at catalog@${git(f.cat.path, 'rev-parse', 'HEAD').slice(0, 9)}\nseen: three renewals, the fourth refused\n`);
  const r = f.C();
  assert.equal(r.status, 1);
  for (const want of [/C1 \[S1\]: pass/, /C2 \[S1\]: fail: "node -e" does not start with an entry of checks_allow/, /C3 \[S1\]: fail: not a plain command/, /C4 \[S1\]: fail: expect is empty or matches anything/, /C6 \[S1\]: fail: ran nothing \("No tests found"\)/, /C5: pass/, /C7: fail: no evidence\/walk-C7\.md/])
    assert.match(r.stdout, want);
  assert.doesNotMatch(r.stdout, /C8/);
  const json = JSON.parse(readFileSync(f.ev('checks.json'), 'utf8'));
  assert.deepEqual(Object.keys(json.results[0]).sort(), ['id', 'line', 'log', 'ok', 'spec', 'tree']);
  assert.deepEqual(json.trees, { catalog: git(f.cat.path, 'rev-parse', 'HEAD^{tree}') });
  assert.match(readFileSync(f.ev('checks/C1.log'), 'utf8'), new RegExp(`--stack ${realpathSync(f.cat.path).replace(/[/.]/g, '\\$&')}`));
  write(f.ev('walk-C5.md'), `walked at catalog@${git(f.cat.path, 'rev-parse', 'HEAD').slice(0, 9)}\n`);
  f.checks([walkCheck]);
  assert.match(f.C().stdout, /C5: fail: evidence\/walk-C5\.md has no "seen:" line/);
  rmSync(join(f.root, 'catalog'), { recursive: true });
  f.checks([goodChecks[0]]);
  assert.match(f.C().stdout, /C1 \[S1\]: fail: \.\/catalog\/scripts\/oracle\.mjs is not in the definition's folder/);
  f.done();
});

test('checks: a pass on an identical tree stands and a green proof line with the same words is adopted; an oracle always runs', () => {
  const f = ticket();
  write(join(f.cat.path, 'test/count.mjs'), "import { appendFileSync } from 'node:fs';\nappendFileSync('../count.ran', 'x');\nconsole.log('count ok');\n");
  write(f.def, readFileSync(f.def, 'utf8').replace('node test/none.mjs,', 'node test/none.mjs, node test/count.mjs,'));
  commit(f.cat.path, 'a counting check');
  const ran = () => (existsSync(join(f.t, 'count.ran')) ? readFileSync(join(f.t, 'count.ran'), 'utf8').length : 0);
  const count = { id: 'C2', proves: 'counts', surface: [], verify: 'cmd: node test/count.mjs', in: 'catalog', expect: 'count ok', due: 'before delivery 1' };
  f.checks([goodChecks[0], count]);
  assert.equal(f.C().status, 0);
  assert.equal(ran(), 1);
  // A merge that leaves the tree as it was: nothing in the worktree runs again, the oracle does.
  git(f.cat.path, 'commit', '-q', '--allow-empty', '-m', 'merge with an identical tree');
  const again = f.C();
  assert.match(again.stdout, /C2: pass \(stands on tree [0-9a-f]{12}\)/);
  assert.match(again.stdout, /C1 \[S1\]: pass$/m);
  assert.equal(ran(), 1);
  // A new tree: a green proof line with the check's words on it is adopted, not rerun.
  write(join(f.cat.path, 'README.md'), 'renewals\n');
  commit(f.cat.path, 'docs');
  run('proof', f.t, '--in', 'catalog', '--', 'node', 'test/count.mjs');
  assert.equal(ran(), 2);
  assert.match(f.C().stdout, /C2: pass \(adopted from proof/);
  assert.equal(ran(), 2);
  assert.match(readFileSync(f.ev('checks/C2.log'), 'utf8'), /^adopted: the proof line of .* on tree/);
  f.done();
});

test('links passes a delivery whose proof chain holds, whatever form its verdict line takes; an F<n> line outside ## Findings is not a finding', () => {
  for (const v of ['Verdict: clean', 'Verdict: Clean.', 'Verdict: **clean**', '**Verdict:** clean', 'Verdict: `clean`', 'Verdict: CLEAN (no findings)', 'Verdict: fix: 0 findings', 'Verdict: clean\nF1 of round 1 is fixed at `src/loans/renew.ts:2`.']) {
    const f = ticket();
    deliverable(f, v);
    const r = f.L();
    assert.equal(r.status, 0, `${v}\n${r.stdout}`);
    assert.match(r.stdout, /plan as its planner left it \| yes/);
    assert.match(r.stdout, /oracles \| yes \| no oracle for renewal-count: checked only by walk, as the handoff says/);
    f.done();
  }
});

test('links: a plan changed by anyone but its planner stops until the planner runs plan-shape', () => {
  const f = ticket();
  deliverable(f);
  write(join(f.t, 'CHECKS.json'), JSON.stringify([{ ...goodChecks[0], expect: 'disagreements' }]));
  assert.match(f.L().stdout, /plan as its planner left it \| no \| PLAN\.md or CHECKS\.json changed since plan-shape recorded plan [0-9a-f]{12}.* \| plan \|/);
  f.S();
  assert.match(f.L().stdout, /plan as its planner left it \| yes/);
  f.done();
});

test('links reads only Commit: and Verdict: lines, and stops on a fix verdict, a crash-only red, a nothing-ran green, a challenger\'s high risk, and an after-step check', () => {
  const f = ticket();
  const head = deliverable(f);
  write(join(f.cat.path, 'src/loans/other.ts'), 'x\n');
  const moved = commit(f.cat.path, 'unreviewed');
  write(f.ev('review-1-1.md'), `Commit: catalog@${head.slice(0, 12)}\nThe worktree has since moved to catalog@${moved}, which I did not read.\nVerdict: clean\n`);
  assert.match(f.L().stdout, /catalog reviewed \| no \| commits since .* touch files no finding names: src\/loans\/other\.ts \| review \|/);
  git(f.cat.path, 'reset', '-q', '--hard', head);
  write(f.ev('review-1-1.md'), `Commit: catalog@${head.slice(0, 12)}\nVerdict: fix: 1 finding\n## Findings\n- F1 \`src/loans/renew.ts:2\`: off by one\n`);
  assert.match(f.L().stdout, /review verdict \| no \| review-1-1\.md: fix \| implement, then review \|/);
  write(f.ev('review-1-1.md'), `Commit: catalog@${head.slice(0, 12)}\nVerdict: clean\n`);
  writeFileSync(f.ev('proof.jsonl'), '');
  run('proof', f.t, '--in', 'catalog', '--test', 'T1', '--base', '--', 'no-such-runner');
  run('proof', f.t, '--in', 'catalog', '--test', 'T1', '--', 'no-such-runner');
  run('proof', f.t, '--in', 'catalog', '--test', 'T1', '--', process.execPath, 'test/none.mjs');
  assert.match(f.L().stdout, /T1 red then green \| no \| no failing base run: run its test with --base/);
  write(f.ev('challenge-2.md'), 'Revision: 2\nRisk: high\nVerdict: build\n');
  assert.match(f.L().stdout, /approval \| no .* \| the person \|/);
  rmSync(f.ev('challenge-2.md'));
  f.checks([...goodChecks, { ...walkCheck, id: 'C2', verify: 'walk: the count after deploy', due: 'after deploy to staging in delivery 1' }]);
  f.C();
  assert.match(f.L('--final').stdout, /checks \| no \| checks due after this delivery's steps have not run/);
  assert.match(f.C('--after').stdout, /C2: fail: no evidence\/walk-C2\.md/);
  f.done();
});

test('links: review 2 asking for fixes earns a narrow review 3; a commit after review stands only within its findings', () => {
  const f = ticket();
  const head = deliverable(f, 'Verdict: fix: 1\n## Findings\n- F1 `src/loans/renew.ts:2`: off by one');
  write(f.ev('review-1-2.md'), `Commit: catalog@${head.slice(0, 12)}\n**Verdict:** fix: 2\n## Findings\n- F1 [S1] \`src/loans/renew.ts:2\` a renewed loan shows one too many\n- F2 \`src/loans/renew.ts:4\` a label\n`);
  assert.match(f.L().stdout, /review verdict \| no \| review-1-2\.md: fix \| implement, then review-1-3 on the fixes \|/);
  edit(join(f.cat.path, 'src/loans/renew.ts'), 'loan.renewals += 1;', 'loan.renewals += 1; // checked');
  write(join(f.cat.path, 'test/renew.mjs'), RENEW_CHECK.replace('1 test', 'one test'));
  const fixS1 = commit(f.cat.path, 'fix S1');
  run('proof', f.t, '--in', 'catalog', '--test', 'T1', '--', ...RENEW_WORDS);
  f.C();
  write(f.ev('review-1-3.md'), `Commit: catalog@${fixS1}\nVerdict: clean\nRead only the fixes of F1 and F2.\n`);
  const ok = f.L();
  assert.equal(ok.status, 0, ok.stdout);
  assert.match(ok.stdout, /catalog reviewed \| yes \| review-1-3\.md names HEAD's tree/);
  assert.match(ok.stdout, /T1 red then green \| yes/, 'the red stays paired although the test file changed');
  assert.match(ok.stdout, /review 3\/3/);
  write(f.ev('review-1-3.md'), `Commit: catalog@${head.slice(0, 12)}\nVerdict: fix: 1\n## Findings\n- F1 [S1] \`src/loans/renew.ts:5\`: still one too many\n`);
  assert.match(f.L().stdout, /review verdict \| no \| review-1-3\.md: fix \| none: held, reported in the handoff as not delivered \|/);
  f.done();
});

test('links compares by tree: a commit with HEAD\'s tree is HEAD for the review, the tests rows and the checks', () => {
  const f = ticket();
  deliverable(f);
  git(f.cat.path, 'commit', '-q', '--allow-empty', '-m', 'a merge that changed no byte');
  const r = f.L();
  assert.equal(r.status, 0, r.stdout);
  assert.match(r.stdout, /catalog reviewed \| yes \| review-1-1\.md names HEAD's tree/);
  f.done();
});

test('links rejects a proof from another repository, and asks for approval again only when what a Surface line must equal changes', () => {
  const f = ticket({ web: true });
  deliverable(f);
  const lines = readFileSync(f.ev('proof.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  writeFileSync(f.ev('proof.jsonl'), lines.map((l) => JSON.stringify(l.base ? l : { ...l, worktree: realpathSync(f.w.path), repository: realpathSync(join(f.w.path, '.git')) })).join('\n') + '\n');
  const hash = f.plan(goodPlan(f.cat).replace('Risk: low', 'Risk: high')).stdout.match(/surface ([0-9a-f]{12})/)[1];
  f.state(`Approval: "go ahead", 2026-01-05T10:00Z, revision 2, surface ${hash}`);
  f.C();
  let r = f.L();
  assert.match(r.stdout, /T1 red then green \| no/);
  assert.match(r.stdout, /approval \| yes/);
  f.plan(goodPlan(f.cat).replace('Risk: low', 'Risk: high').replace('renewal count:', 'the renewal count, as stored:'));
  assert.match(f.L().stdout, /approval \| yes/);
  f.plan(goodPlan(f.cat).replace('Risk: low', 'Risk: high').replace('equals loans.renewals', 'equals the page total'));
  assert.match(f.L().stdout, /approval \| no .* \| the person \|/);
  f.done();
});

test('links: a screenshot named the project\'s way stands while no screen path changed since its commit; a branch change to an oracle stops', () => {
  const f = ticket({ web: true });
  const head = deliverable(f);
  f.plan(goodPlan(f.cat, `\n## What people see\nPurpose: a member sees how many renewals are left.\nStates: limit-reached, empty\n`));
  const old = f.w.sha;
  write(f.ev('read-1.md'), `read web@${old}`);
  write(f.ev(`screens/limit-reached-390-en-light-${old.slice(0, 10)}.png`), 'png');
  write(f.ev(`screens/d1-empty-1440-ar-${head.slice(0, 10)}.png`), 'png');
  write(join(f.w.path, 'src/api.ts'), 'x\n');
  const w1 = commit(f.w.path, 'api only');
  write(f.ev('review-1-1.md'), `Commit: catalog@${head} web@${w1}\nVerdict: clean\n`);
  f.C();
  const ok = f.L();
  assert.equal(ok.status, 0, ok.stdout);
  write(join(f.w.path, 'messages/en.json'), '{"left": "left"}\n');
  const w2 = commit(f.w.path, 'words');
  write(f.ev('review-1-1.md'), `Commit: catalog@${head} web@${w2}\nVerdict: clean\n`);
  f.C();
  assert.match(f.L().stdout, /screenshot limit-reached \| no \| retake: .*touches web\/messages\/en\.json \| verify \|/);
  write(join(f.cat.path, 'scripts/oracle.mjs'), ORACLE('0 disagreements always'));
  const c2 = commit(f.cat.path, 'loosen the oracle');
  write(f.ev('review-1-1.md'), `Commit: catalog@${c2} web@${w2}\nVerdict: clean\n`);
  assert.match(f.L().stdout, /oracle \.\/catalog\/scripts\/oracle\.mjs \| no \| changed on the branch: scripts\/oracle\.mjs/);
  f.done();
});

test('a base update that leaves the change the same keeps the review and the walks', () => {
  const f = ticket();
  git(f.cat.path, 'branch', 'upstream');
  edit(join(f.t, 'STATE.md'), 'from main at', 'from upstream at');
  const head = deliverable(f);
  write(f.ev('walk-C5.md'), `walked at catalog@${head.slice(0, 9)}\nseen: the fourth renewal refused\n`);
  git(f.cat.path, 'checkout', '-q', 'upstream');
  write(join(f.cat.path, 'docs/notes.md'), 'unrelated\n');
  commit(f.cat.path, 'base moves');
  git(f.cat.path, 'checkout', '-q', 'main');
  git(f.cat.path, 'rebase', '-q', 'upstream');
  assert.notEqual(git(f.cat.path, 'rev-parse', 'HEAD'), head);
  f.checks([walkCheck]);
  assert.match(f.C().stdout, /C5: pass/);
  const r = f.L();
  assert.match(r.stdout, /catalog reviewed \| yes \| review-1-1\.md names the same change on the earlier base/);
  assert.match(r.stdout, /T1 red then green \| no \| green only on an earlier tree/);
  f.done();
});

test('record writes the counts from the files and counts earlier records as reopenings', () => {
  const f = ticket();
  f.plan(goodPlan(f.cat).replace('Risk: low', 'Risk: high').replace('## Decisions', '- S2 (fee): not touched: fees, `src/fees.ts:1`\n\n## Decisions'));
  for (const n of ['challenge-1.md', 'challenge-2.md', 'review-1-1.md', 'review-1-2.md', 'review-1-2-notes.md', 'read-1.md']) write(f.ev(n), 'x');
  write(f.ev('audit-1.md'), 'Findings: 1 confirmed\n');
  write(f.ev('missed.md'), '- the count was off by one on a renewed loan (review; already there before the change: a discovery miss)\n');
  const records = join(f.root, 'records.jsonl');
  writeFileSync(records, JSON.stringify({ project: 'library-app', ticket: 'EX-1' }) + '\n');
  assert.equal(run('record', f.t, '--records', records).status, 0);
  const line = JSON.parse(readFileSync(records, 'utf8').trim().split('\n').at(-1));
  assert.deepEqual(
    [line.type, line.risk, line.plan_revisions, line.challenge_rounds, line.read_rounds, line.review_rounds, line.rounds_over, line.reopened, line.surface_lines, line.surface_not_touched, line.surface_draft, line.surface_extras, line.decisions, line.cold_audit, line.first_delivered, line.profile],
    ['bug', 'high', 2, 2, 1, 2, false, 1, 1, 1, 1, 1, 1, 1, '2026-01-05T15:00Z', null],
  );
  assert.deepEqual([line.missed.length, line.discover_misses], [1, 1]);
  assert.deepEqual(line.audits_missing, []);
  assert.deepEqual(line.surface_kinds, ['renewal-count', 'fee']);
  write(f.ev('read-2.md'), 'a reader, named as another delivery');
  run('record', f.t, '--records', records);
  assert.equal(JSON.parse(readFileSync(records, 'utf8').trim().split('\n').at(-1)).rounds_over, true);
  assert.match(run('rounds', f.t).stdout, /delivery 2: read 1\/1, review 0\/2 \(not in the plan's Deliveries\)/);
  assert.equal(run('rounds', f.t).status, 1);
  f.done();
});

test('a walk stands after a repair within the last review\'s findings plus tests, not after any other change', () => {
  const f = ticket();
  const head = deliverable(f, 'Verdict: fix: 1\n## Findings\n- F1 `src/loans/renew.ts:4`: a label');
  write(f.ev('walk-C5.md'), `walked at catalog@${head.slice(0, 9)}\nseen: the fourth renewal refused\n`);
  f.checks([walkCheck]);
  write(join(f.cat.path, 'test/renew.mjs'), RENEW_CHECK.replace('1 test', 'one test'));
  commit(f.cat.path, 'test-only repair');
  assert.match(f.C().stdout, /C5: pass/);
  write(join(f.cat.path, 'src/loans/other.ts'), 'x\n');
  commit(f.cat.path, 'another change');
  assert.match(f.C().stdout, /C5: fail: evidence\/walk-C5\.md names neither/);
  f.done();
});

test('a booking fact flows end to end: an appointment time on the Surface, its oracle required by plan-shape, run by checks, held by links', () => {
  const f = ticket();
  write(join(f.cat.path, 'src/book.ts'), 'export const slotTime = (slot) => slot.startsAt;\n');
  const sha = commit(f.cat.path, 'booking');
  write(join(f.root, 'tools', 'time-check.mjs'), ORACLE('appointment times: 0 disagreements'));
  write(f.def, '---\nname: clinic\nchecks_allow: [node test/renew.mjs, node ./tools/time-check.mjs]\nsurface_kinds: [appointment-time, availability]\noracles:\n  appointment-time: node ./tools/time-check.mjs --stack {worktree} <spec.json>\n---\n');
  edit(join(f.t, 'STATE.md'), /- S1 .*/, '- S1 (appointment-time): the time on the confirmation; equals bookings.starts_at in the clinic\'s zone');
  const booking = goodPlan(f.cat).replace(/Read at: .*/, `Read at: catalog@${sha}`)
    .replace(/- S1 .*/, '- S1 (appointment-time): the time on the confirmation; equals bookings.starts_at in the clinic\'s zone; `src/book.ts:1` `slot.startsAt`');
  run('proof', f.t, '--in', 'catalog', '--test', 'T1', '--base', '--', ...RENEW_WORDS);
  f.checks([{ ...goodChecks[0], verify: 'walk: book the 09:30 slot and read the confirmation', expect: 'confirmation says 09:30' }]);
  write(f.ev('walk-C1.md'), `walked at catalog@${sha}\nseen: 09:30 before the change\n`);
  let r = f.plan(booking);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /S1: the project names an oracle for appointment-time \(node \.\/tools\/time-check\.mjs --stack\), and no check of this line runs it/);
  assert.match(r.stdout, /Critical kinds with no Surface line .*: availability/);
  assert.match(f.plan(booking.replace('(appointment-time)', '(time)')).stdout, /Kinds the definition doesn't name \(for the challenger\): S1 \(time\); it names appointment-time, availability/);
  assert.match(run('plan-shape', f.t, '--print', 'reader').stdout, /no What people see section/);
  f.plan(booking);
  f.checks([{ ...goodChecks[0], verify: 'cmd: node ./tools/time-check.mjs --stack {worktree} spec.json', expect: '0 disagreements' }]);
  f.C();
  r = f.S();
  assert.equal(r.status, 0, r.stdout);
  edit(join(f.cat.path, 'src/loans/renew.ts'), '>=', '>= 0 +');
  const head = commit(f.cat.path, 'fix');
  run('proof', f.t, '--in', 'catalog', '--test', 'T1', '--', ...RENEW_WORDS);
  write(f.ev('challenge-1.md'), 'Revision: 2\nVerdict: build\n');
  write(f.ev('review-1-1.md'), `Commit: catalog@${head}\nVerdict: clean\n`);
  assert.match(f.C().stdout, /C1 \[S1\]: pass/);
  r = f.L();
  assert.equal(r.status, 0, r.stdout);
  assert.doesNotMatch(r.stdout, /no oracle for/);
  f.done();
});

test('links: a diff after review 2 goes to a narrow review 3, and after it any further change holds the delivery', () => {
  const f = ticket();
  const head = deliverable(f, 'Verdict: fix: 1\n## Findings\n- F1 `src/loans/renew.ts:4`: a label');
  write(f.ev('review-1-2.md'), `Commit: catalog@${head.slice(0, 12)}\nVerdict: clean\n`);
  write(join(f.cat.path, 'src/loans/other.ts'), 'a defect verify found\n');
  const v1 = commit(f.cat.path, 'verify-found fix');
  run('proof', f.t, '--in', 'catalog', '--test', 'T1', '--', ...RENEW_WORDS);
  f.C();
  assert.match(f.L().stdout, /catalog reviewed \| no \| .*other\.ts \| review-1-3 \(narrow: reads the diff since/);
  assert.match(run('rounds', f.t, 'review', '1').stdout, /next: evidence\/review-1-3\.md, the narrow review/);
  write(f.ev('review-1-3.md'), `Commit: catalog@${v1}\nVerdict: clean\n`);
  assert.equal(f.L().status, 0);
  write(join(f.cat.path, 'src/loans/third.ts'), 'x\n');
  commit(f.cat.path, 'yet another');
  run('proof', f.t, '--in', 'catalog', '--test', 'T1', '--', ...RENEW_WORDS);
  f.C();
  assert.match(f.L().stdout, /catalog reviewed \| no \| .*third\.ts \| none: held, reported in the handoff as not delivered \|/);
  f.done();
});

test('links: every challenge of the current revision found no failing state; a new revision needs its own', () => {
  const f = ticket();
  deliverable(f);
  f.plan(goodPlan(f.cat).replace('Revision: 2', 'Revision: 3'));
  assert.match(f.L().stdout, /design challenged \| no \| no challenge-<k>\.md names revision 3 \| challenge \|/);
  write(f.ev('challenge-2.md'), 'Revision: 3\nVerdict: fix items 1\n');
  write(f.ev('challenge-3.md'), 'Revision: 3\nVerdict: build\n');
  assert.match(f.L().stdout, /design challenged \| no \| challenge-2\.md: not build \| plan, then challenge \|/);
  write(f.ev('challenge-2.md'), 'Revision: 2\nVerdict: fix items 1\n');
  assert.match(f.L().stdout, /design challenged \| yes \| challenge-3\.md: build, revision 3/);
  assert.match(run('rounds', f.t).stdout, /plan revision 3, 3 challenges/);
  f.done();
});

test('proof names several rows with one run; links names why a row is refused and lists the words to run, once per command', () => {
  const f = ticket();
  deliverable(f);
  f.plan(goodPlan(f.cat).replace('| T2 | The page shows the count | (new) `loan.test.ts › shows the count` | the count | no | 2 |', '| T2 | The count is unchanged | `test/renew.mjs › keeps the count` | count unchanged | yes | 1 |'));
  writeFileSync(f.ev('proof.jsonl'), '');
  git(f.cat.path, 'checkout', '-q', 'HEAD~1');
  run('proof', f.t, '--in', 'catalog', '--test', 'T1,T2', '--base', '--', ...RENEW_WORDS);
  git(f.cat.path, 'checkout', '-q', '-');
  run('proof', f.t, '--in', 'catalog', '--test', 'T1,T2', '--', ...RENEW_WORDS);
  const lines = readFileSync(f.ev('proof.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(lines.map((l) => l.test), ['T1', 'T2', 'T1', 'T2']);
  assert.deepEqual(lines[0].argv, RENEW_WORDS);
  assert.equal(lines[0].repository, realpathSync(join(f.cat.path, '.git')));
  assert.match(f.L().stdout, /T2 red then green \| yes \| green on HEAD's tree; red on base, same words/);
  // A later commit: both rows are green only on an earlier tree, and one listed command proves them again.
  write(join(f.cat.path, 'README.md'), 'renewals\n');
  const head = commit(f.cat.path, 'docs');
  write(f.ev('review-1-1.md'), `Commit: catalog@${head.slice(0, 12)}\nVerdict: clean\n`);
  let out = f.L().stdout;
  assert.match(out, /T1 red then green \| no \| green only on an earlier tree; run the words below/);
  const listed = out.split('\n').filter((l) => l.startsWith('- proof '));
  assert.equal(listed.length, 1);
  assert.match(listed[0], /--in catalog --test T1,T2 -- \S+ test\/renew\.mjs$/);
  run('proof', f.t, '--in', 'catalog', '--test', 'T1,T2', '--', ...RENEW_WORDS);
  out = f.L().stdout;
  assert.match(out, /T1 red then green \| yes/);
  assert.doesNotMatch(out, /^Run/m);
  // A red run with other words than any green: the red's words are listed, so both run the same.
  git(f.cat.path, 'checkout', '-q', f.cat.sha);
  run('proof', f.t, '--in', 'catalog', '--test', 'T1', '--base', '--', process.execPath, './test/renew.mjs');
  git(f.cat.path, 'checkout', '-q', '-');
  writeFileSync(f.ev('proof.jsonl'), readFileSync(f.ev('proof.jsonl'), 'utf8').split('\n').filter((l) => !(l.includes('"T1"') && l.includes('"base":true') && !l.includes('./test'))).join('\n'));
  out = f.L().stdout;
  assert.match(out, /T1 red then green \| no \| green on HEAD's tree; the base red ran other words; run the words below/);
  assert.match(out, /- proof \S+ --in catalog --test T1 -- \S+ \.\/test\/renew\.mjs$/m);
  assert.match(out, /^Run \(each once, on HEAD unless it says --base/m);
  // Untracked files in the worktree: no run there can be on HEAD's tree, and the row says so.
  write(join(f.cat.path, 'shot.png'), 'x');
  writeFileSync(f.ev('proof.jsonl'), readFileSync(f.ev('proof.jsonl'), 'utf8').split('\n').filter((l) => !(l.includes('"T1"') && l.includes('"base":false'))).join('\n') + '\n');
  run('proof', f.t, '--in', 'catalog', '--test', 'T1', '--', process.execPath, './test/renew.mjs');
  assert.match(f.L().stdout, /T1 red then green \| no \| green only on an earlier tree \(the worktree has uncommitted or untracked files/);
  f.done();
});

test('links pairs runs by repository: a red in another worktree of the same repo counts, and so does a worktree STATE moved', () => {
  const f = ticket();
  const fixed = deliverable(f);
  const side = join(f.root, 'side');
  git(f.cat.path, 'worktree', 'add', '-q', '--detach', side, f.cat.sha);
  f.state(`Worktree side: ${side}`);
  writeFileSync(f.ev('proof.jsonl'), readFileSync(f.ev('proof.jsonl'), 'utf8').split('\n').filter((l) => !l.includes('"base":true')).join('\n'));
  run('proof', f.t, '--in', 'side', '--test', 'T1', '--base', '--', ...RENEW_WORDS);
  assert.match(f.L().stdout, /T1 red then green \| yes \| green on HEAD's tree; red on base, same words/);
  const moved = join(f.root, 'moved');
  git(f.cat.path, 'worktree', 'add', '-q', '--detach', moved, fixed);
  edit(join(f.t, 'STATE.md'), /Worktree catalog: catalog/, `Worktree catalog: ${moved}`);
  assert.match(f.L().stdout, /T1 red then green \| yes/);
  f.done();
});

test('links: a red in a separate clone is named and listed as a base run here; an output path is flagged', () => {
  const f = ticket();
  deliverable(f);
  const clone = join(f.root, 'basecopy');
  git(f.root, 'clone', '-q', f.cat.path, clone);
  git(clone, 'checkout', '-q', f.cat.sha);
  f.state(`Worktree basecopy: ${clone}`);
  writeFileSync(f.ev('proof.jsonl'), readFileSync(f.ev('proof.jsonl'), 'utf8').split('\n').filter((l) => !l.includes('"base":true')).join('\n'));
  run('proof', f.t, '--in', 'basecopy', '--test', 'T1', '--base', '--', ...RENEW_WORDS);
  let out = f.L().stdout;
  assert.match(out, /T1 red then green \| no \| green on HEAD's tree; the base red ran in another repository \(.*basecopy\); run the words below with --base/);
  assert.match(out, /- proof \S+ --in catalog --test T1 --base -- \S+ test\/renew\.mjs$/m);
  writeFileSync(f.ev('proof.jsonl'), readFileSync(f.ev('proof.jsonl'), 'utf8').split('\n').filter((l) => !l.includes('"base":true')).join('\n'));
  git(f.cat.path, 'checkout', '-q', f.cat.sha);
  run('proof', f.t, '--in', 'catalog', '--test', 'T1', '--base', '--', ...RENEW_WORDS, '--reports', 'evidence/red');
  git(f.cat.path, 'checkout', '-q', '-');
  assert.match(f.L().stdout, /--test T1 -- \S+ test\/renew\.mjs --reports evidence\/red {3}\(names an output path/);
  f.done();
});

test('links: every due tests row is green on HEAD, a later delivery\'s row is not due, and "None." means no screen rows', () => {
  const f = ticket();
  deliverable(f);
  f.plan(goodPlan(f.cat).replace('| no | 2 |', '| no | 1 |') + '\n## What people see\nNone.\n');
  const r = f.L();
  assert.match(r.stdout, /T2 green \| no \| no proof line names T2: run its test with --test T2/);
  assert.doesNotMatch(r.stdout, /\| read \|/);
  f.plan(goodPlan(f.cat));
  assert.doesNotMatch(f.L().stdout, /T2/);
  f.done();
});

test('links: states match spaced, dashed or underscored names, "empty" does not take "non-empty", a repo outside screen_paths counts as screens, and a reader of older screens is reported', () => {
  const f = ticket({ web: true });
  const head = deliverable(f);
  f.plan(goodPlan(f.cat, `\n## What people see\nPurpose: a member sees renewals left.\nStates: limit-reached, empty\n`));
  write(f.ev('read-1.md'), `read catalog@${head}`);
  write(f.ev(`screens/limit_reached-390-${head.slice(0, 10)}.png`), 'png');
  write(f.ev(`screens/non-empty-390-${head.slice(0, 10)}.png`), 'png');
  write(f.ev(`screens/no-empty-1440-${head.slice(0, 10)}.png`), 'png');
  let r = f.L();
  assert.match(r.stdout, /screenshot limit-reached \| yes/);
  assert.match(r.stdout, /screenshot empty \| no \| no screenshot whose name holds "empty"/);
  write(f.ev(`screens/empty-390-${head.slice(0, 10)}.png`), 'png');
  write(join(f.cat.path, 'src/loans/renew.test.ts'), RENEW_TEST + '// more\n');
  const c2 = commit(f.cat.path, 'a test after the screenshots');
  write(f.ev('review-1-1.md'), `Commit: catalog@${c2}\nVerdict: clean\n`);
  run('proof', f.t, '--in', 'catalog', '--test', 'T1', '--', ...RENEW_WORDS);
  f.C();
  r = f.L();
  assert.match(r.stdout, /screenshot empty \| no \| retake: .*catalog\/src\/loans\/renew\.test\.ts/);
  assert.match(r.stdout, /reader catalog \| yes \| reader read .*screens changed since in catalog\/src\/loans\/renew\.test\.ts/);
  write(f.def, readFileSync(f.def, 'utf8').replace('  - web/messages', '  - web/messages\n  - "!catalog"'));
  assert.match(f.L().stdout, /screenshot empty \| yes/);
  f.done();
});

test('the test_files key and a non-ASCII kind name: a repair within a definition\'s own test pattern keeps the walk; the kind keeps its oracle', () => {
  const f = ticket();
  const head = deliverable(f, 'Verdict: fix: 1\n## Findings\n- F1 `src/loans/renew.ts:4`: a label');
  write(f.def, readFileSync(f.def, 'utf8').replace('---\n', '---\ntest_files: ["checks/**"]\n').replace(/\n---\n$/, '\noracles:\n  heure-de-rendez-vous: node ./catalog/scripts/oracle.mjs --stack {worktree}\n---\n'));
  write(f.ev('walk-C5.md'), `walked at catalog@${head.slice(0, 9)}\nseen: refused\n`);
  f.checks([walkCheck]);
  write(join(f.cat.path, 'checks/deep/renew.check.js'), 'x\n');
  commit(f.cat.path, 'a test in the project\'s own place');
  assert.match(f.C().stdout, /C5: pass/);
  f.checks([{ ...goodChecks[0], verify: 'cmd: node test/renew.mjs', expect: 'test passed' }]);
  assert.match(f.plan(goodPlan(f.cat).replace('(renewal-count)', '(heure-de-rendez-vous)')).stdout, /S1: the project names an oracle for heure-de-rendez-vous/);
  f.done();
});

test('links: a bare commit in the reader file and an unearned third review', () => {
  const f = ticket({ web: true });
  const head = deliverable(f);
  f.plan(goodPlan(f.cat, `\n## What people see\nPurpose: renewals left.\nStates: free, taken\n`));
  write(f.ev('read-1.md'), `Commit read: ${f.cat.sha}\n`);
  write(f.ev(`screens/free-390-en-${head.slice(0, 10)}.png`), 'png');
  write(f.ev('review-1-2.md'), `Commit: catalog@${head}\nVerdict: clean\n`);
  write(f.ev('review-1-3.md'), `Commit: catalog@${head}\nVerdict: clean\n`);
  const r = f.L();
  assert.match(r.stdout, /screenshot free \| yes/);
  assert.match(r.stdout, /screenshot taken \| no \| no screenshot whose name holds "taken"/);
  assert.match(r.stdout, /reader catalog \| yes \| reader read .*screens changed since in catalog\/src\/loans\/renew\.ts/);
  assert.match(r.stdout, /review 3\/2 \(over the cap/);
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

test('links needs the definition, and a delivery after a delivered one needs that one\'s audit; record sums audits and names the missing', () => {
  const f = ticket();
  deliverable(f);
  assert.equal(run('links', f.t, '--delivery', '1').status, 2);
  f.state('Delivery 2: the page: step deliver');
  f.plan(goodPlan(f.cat).replace('1. The refusal.', '1. The refusal.\n2. The page.'));
  const L2 = () => run('links', f.t, '--delivery', '2', '--definition', f.def);
  assert.match(L2().stdout, /\| audit 1 \| no \| delivery 1 is delivered and has no evidence\/audit-1\.md \| audit \|/);
  write(f.ev('audit-1.md'), 'Findings: 2\n');
  assert.match(L2().stdout, /\| audit 1 \| yes \| audit-1\.md \|/);
  f.state('Delivery 2: the page: step deliver\nDelivery 3: the report: delivered 2026-01-06T09:00Z main\nDelivery 4: the export: not delivered 2026-01-06 yet');
  assert.match(L2().stdout, /\| audit 3 \| no \|/);
  assert.doesNotMatch(L2().stdout, /\| audit 4 \|/);
  f.state('Delivery 2: the page: delivered 2026-01-06T10:00Z main');
  const records = join(f.root, 'records.jsonl');
  run('record', f.t, '--records', records);
  const line = JSON.parse(readFileSync(records, 'utf8').trim().split('\n').at(-1));
  assert.deepEqual([line.cold_audit, line.audits_missing], [2, [2]]);
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
