// Tests for skills/deliver/scripts. Run: node --test test/*.test.mjs
// Each test builds a small invented project (a library app) in a temporary folder.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, realpathSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const scripts = join(dirname(fileURLToPath(import.meta.url)), '..', 'skills', 'deliver', 'scripts');
const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
const git = (cwd, ...a) => execFileSync('git', a, { cwd, env, encoding: 'utf8' }).trim();
const run = (name, ...a) => spawnSync(process.execPath, [join(scripts, `${name}.mjs`), ...a], { env, encoding: 'utf8' });
const write = (p, t) => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, t); };

const RENEW = ['export function renew(loan, limit) {', '  if (loan.renewals >= limit) {', "    throw new Error('limit');", '  }', '  loan.renewals += 1;', '  return loan;', '}', ''].join('\n');
const RENEW_TEST = "import { renew } from './renew.ts';\n// refuses the fourth renewal\n";

// A ticket folder with one worktree ("catalog"), optionally a second ("web").
function ticket({ web = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'aw-test-'));
  const t = join(root, 'EX-1');
  const repo = (name, files) => {
    const p = join(t, name);
    mkdirSync(p, { recursive: true });
    git(p, 'init', '-q', '-b', 'main');
    for (const [f, c] of Object.entries(files)) write(join(p, f), c);
    git(p, 'add', '-A');
    git(p, 'commit', '-qm', 'base');
    return { path: p, sha: git(p, 'rev-parse', 'HEAD') };
  };
  const cat = repo('catalog', { 'src/loans/renew.ts': RENEW, 'src/loans/renew.test.ts': RENEW_TEST, 'test/pass.mjs': "console.log('0 disagreements')\n", 'test/renew.mjs': "import { readFileSync } from 'node:fs';\nprocess.exit(readFileSync('src/loans/renew.ts', 'utf8').includes('>= limit)') ? 1 : 0);\n", 'test/fail.mjs': 'process.exit(3)\n' });
  const w = web ? repo('web', { 'src/loans/renew.ts': RENEW, 'src/pages/loan.tsx': 'export const Loan = () => null;\n', 'messages/en.json': '{}\n' }) : null;
  const state = (extra = '') => write(join(t, 'STATE.md'), [
    '# State: EX-1', '', 'Project: library-app', 'Ticket: EX-1', 'Type: bug (named by: the person)', 'Started: 2026-01-05T09:00Z', 'Profile: none',
    `Worktree catalog: catalog on fix/EX-1, from main at ${cat.sha}`,
    ...(w ? [`Worktree web: web on fix/EX-1, from main at ${w.sha}`] : []),
    'Delivery 1: the refusal: delivered 2026-01-05T15:00Z main', extra, '', '## Surface', '- S1: renewal count: loan page; equals loans.renewals', '', '## Outside the ticket', '- [surface] a late fee shown twice, src/fees.ts: hotfix EX-2 started', '- a typo, page footer: file EX-3', '',
  ].join('\n'));
  state();
  const plan = (body) => write(join(t, 'PLAN.md'), body);
  const checks = (list) => write(join(t, 'CHECKS.json'), JSON.stringify(list, null, 2));
  const def = join(root, 'project.md');
  write(def, '---\nname: library-app\nchecks_allow: [node]   # runners\nscreen_paths:\n  - web/src/pages\n  - web/messages\n---\n');
  return { root, t, cat, w, state, plan, checks, def, done: () => rmSync(root, { recursive: true, force: true }) };
}

const goodPlan = (cat, extra = '') => `# Plan: EX-1 A fourth renewal is refused

Revision: 2
Risk: low
Read at: catalog@${cat.sha.slice(0, 12)}

## Surface
- S1: renewal count: loan page; equals loans.renewals; \`src/loans/renew.ts:5\` \`loan.renewals += 1\`

## Decisions
### D1: Where the limit is enforced
- Choice: in renew()
- Source: \`renew.ts:2\` \`if (loan.renewals >= limit)\`
- Beats: a check in the page, which a job would skip

## Tests
| ID | Behaviour | Test (file › name) | Asserts | Fails before |
|---|---|---|---|---|
| T1 | A fourth renewal is refused | \`src/loans/renew.test.ts › refuses the fourth renewal\` | throws, count unchanged | yes |
| T2 | The page shows the count | (new) \`loan.test.ts › shows the count\` | the count | no |
${extra}`;
const goodChecks = [{ id: 'C1', proves: 'the count shown equals the stored count', surface: ['S1'], verify: 'cmd: node test/pass.mjs', in: 'catalog', expect: '0 disagreements', due: 'before delivery 1', passes: false, evidence: null }];

test('plan-shape passes a plan whose citations resolve and whose Surface has checks', () => {
  const f = ticket();
  f.plan(goodPlan(f.cat));
  f.checks(goodChecks);
  const r = run('plan-shape', f.t);
  assert.equal(r.status, 0, r.stdout);
  assert.match(r.stdout, /plan-shape: pass/);
  assert.match(r.stdout, /1 decisions, 2 citations, 2 tests rows, 1 checks, surface [0-9a-f]{12}/);
  assert.ok(existsSync(join(f.t, 'evidence', 'plan-shape.md')));
  f.done();
});

test('plan-shape fails past-EOF, missing, wrong-snippet, medium risk, no Beats, an uncovered Surface line and a dropped draft line', () => {
  const f = ticket();
  f.plan(goodPlan(f.cat, '\nSee `renew.ts:99` and `src/loans/gone.ts:1` and `renew.ts:3` `return null` and `app/[id]/page.tsx:3`, not `127.0.0.1:5432`.\n')
    .replace('Risk: low', 'Risk: medium').replace('- Beats: a check in the page, which a job would skip\n', '').replace('- S1:', '- S9:'));
  f.checks([{ ...goodChecks[0], surface: [] }]);
  const r = run('plan-shape', f.t);
  assert.equal(r.status, 1);
  for (const want of [/app\/\[id\]\/page\.tsx:3: missing/, /renew\.ts:99: past the end/, /gone\.ts:1: missing/, /renew\.ts:3: `return null` is not on those lines/, /Risk: "medium"/, /D1: no Beats/, /S9: no check/, /S1: in STATE\.md's Surface draft/])
    assert.match(r.stdout, want);
  assert.doesNotMatch(r.stdout, /127\.0\.0\.1/);
  f.plan(goodPlan(f.cat).replace(/- Source: .*/, '- Source:'));
  assert.match(run('plan-shape', f.t).stdout, /D1: no Source/);
  f.done();
});

test('plan-shape names both candidates for a basename present in two repos', () => {
  const f = ticket({ web: true });
  f.plan(goodPlan(f.cat).replace(/Read at: .*/, `Read at: catalog@${f.cat.sha}, web@${f.w.sha}`));
  f.checks(goodChecks);
  const r = run('plan-shape', f.t);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /renew\.ts:2: ambiguous, candidates: catalog\/src\/loans\/renew\.ts, web\/src\/loans\/renew\.ts/);
  f.done();
});

test('rounds refuses a third review and counts a renamed review file', () => {
  const f = ticket();
  write(join(f.t, 'evidence', 'judge-1.md'), 'x');
  assert.equal(run('rounds', f.t, 'review', '1').status, 0);
  write(join(f.t, 'evidence', 'review-1-1.md'), 'x');
  write(join(f.t, 'evidence', 'review-1-final.md'), 'x');
  const r = run('rounds', f.t, 'review', '1');
  assert.equal(r.status, 1);
  assert.match(r.stdout, /refused: evidence\/review-1-1\.md, evidence\/review-1-final\.md exist \(cap 2\)/);
  assert.equal(run('rounds', f.t, 'judge', '1').status, 1);
  assert.equal(run('rounds', f.t, 'judge', '2').status, 0);
  assert.match(run('rounds', f.t).stdout, /delivery 1: judge 1\/1, read 0\/1, review 2\/2/);
  f.done();
});

test('proof records the exit and the working tree, untracked files included', () => {
  const f = ticket();
  const r1 = run('proof', f.t, '--in', 'catalog', '--test', 'T1', '--base', '--', process.execPath, 'test/fail.mjs');
  assert.equal(r1.status, 0);
  write(join(f.cat.path, 'src/loans/new.ts'), 'x\n');
  run('proof', f.t, '--in', 'catalog', '--test', 'T1', '--', process.execPath, 'test/pass.mjs');
  const [a, b] = readFileSync(join(f.t, 'evidence', 'proof.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual([a.base, a.exit, b.base, b.exit], [true, 3, false, 0]);
  assert.equal(a.tree, git(f.cat.path, 'rev-parse', 'HEAD^{tree}'));
  assert.notEqual(b.tree, a.tree);
  assert.equal(git(f.cat.path, 'status', '--porcelain'), '?? src/loans/new.ts');
  assert.equal(run('proof', f.t, '--in', 'nowhere', '--', 'true').status, 2);
  f.done();
});

test('checks runs allow-listed commands without a shell and fails the rest', () => {
  const f = ticket();
  const list = [
    goodChecks[0],
    { ...goodChecks[0], id: 'C2', verify: 'cmd: sh -c true' },
    { ...goodChecks[0], id: 'C3', verify: 'cmd: node test/pass.mjs; rm -rf /' },
    { ...goodChecks[0], id: 'C4', verify: 'cmd: node test/pass.mjs', expect: '/^2 disagreements/m' },
    { ...goodChecks[0], id: 'C5', surface: [], verify: 'walk: renew three times on the loan page', passes: true, evidence: 'evidence/walk.md' },
    { ...goodChecks[0], id: 'C6', verify: 'walk: x', due: 'before delivery 2' },
  ];
  f.checks(list);
  write(join(f.t, 'evidence', 'walk.md'), `walked at catalog@${f.cat.sha.slice(0, 7)}\n`);
  const r = run('checks', f.t, '--delivery', '1', '--definition', f.def);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /C1 \[S1\]: pass/);
  assert.match(r.stdout, /C2 \[S1\]: fail: "sh -c" does not start with an entry of checks_allow/);
  assert.match(r.stdout, /C3 \[S1\]: fail: not a plain command/);
  assert.match(r.stdout, /C4 \[S1\]: fail: output does not hold expect/);
  assert.match(r.stdout, /C5: pass/);
  assert.doesNotMatch(r.stdout, /C6/);
  f.checks([goodChecks[0], list[4]]);
  assert.equal(run('checks', f.t, '--delivery', '1', '--definition', f.def).status, 0);
  f.checks([goodChecks[0], { ...list[4], id: 'C7', surface: ['S1'], passes: false, due: 'before delivery 1' }]);
  assert.match(run('checks', f.t, '--delivery', '2', '--definition', f.def).stdout, /C7 \[S1\]: fail: passes is not true/);
  f.done();
});

// A delivery whose links all hold: judged, reviewed at HEAD, red then green, checks passed.
function deliverable(f) {
  run('proof', f.t, '--in', 'catalog', '--test', 'T1', '--base', '--', process.execPath, 'test/renew.mjs');
  writeFileSync(join(f.cat.path, 'src/loans/renew.ts'), RENEW.replace('>=', '>= 0 +'));
  git(f.cat.path, 'commit', '-qam', 'fix');
  const head = git(f.cat.path, 'rev-parse', 'HEAD');
  f.plan(goodPlan(f.cat));
  f.checks(goodChecks);
  write(join(f.t, 'evidence', 'judge-1.md'), 'Verdict: build\n');
  write(join(f.t, 'evidence', 'review-1-1.md'), `Commit: catalog@${head.slice(0, 12)}\nVerdict: clean\n`);
  run('proof', f.t, '--in', 'catalog', '--test', 'T1', '--', process.execPath, 'test/renew.mjs');
  assert.equal(run('checks', f.t, '--delivery', '1', '--definition', f.def).status, 0);
  return head;
}

test('links passes a delivery whose proof chain holds, and names the worker for each broken link', () => {
  const f = ticket();
  deliverable(f);
  const ok = run('links', f.t, '--delivery', '1', '--definition', f.def);
  assert.equal(ok.status, 0, ok.stdout);
  assert.ok(existsSync(join(f.t, 'evidence', 'links-1.md')));
  writeFileSync(join(f.cat.path, 'src/loans/renew.ts'), RENEW);
  git(f.cat.path, 'commit', '-qam', 'after review');
  const r = run('links', f.t, '--delivery', '1', '--definition', f.def);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /catalog reviewed \| no .* \| review \|/);
  assert.match(r.stdout, /T1 red then green \| no \| no passing proof on HEAD's tree; .* \| implement \|/);
  assert.match(r.stdout, /checks \| no \| checks\.json is for another delivery or HEAD \| verify \|/);
  f.done();
});

test('links rejects a proof line from another worktree, and asks for approval again when the Surface changed', () => {
  const f = ticket({ web: true });
  deliverable(f);
  const lines = readFileSync(join(f.t, 'evidence', 'proof.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  writeFileSync(join(f.t, 'evidence', 'proof.jsonl'), lines.map((l) => JSON.stringify(l.base ? l : { ...l, worktree: realpathSync(f.w.path) })).join('\n') + '\n');
  f.plan(goodPlan(f.cat).replace('Risk: low', 'Risk: high'));
  f.state('Approval: "go ahead", 2026-01-05T10:00Z, revision 2, surface 000000000000');
  assert.equal(run('checks', f.t, '--delivery', '1', '--definition', f.def).status, 0);
  const r = run('links', f.t, '--delivery', '1', '--definition', f.def);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /T1 red then green \| no/);
  assert.match(r.stdout, /approval \| no .* \| the person \|/);
  f.done();
});

test('links: a screenshot stands while the diff since its commit touches no screen path; a third review is reported, not a stop', () => {
  const f = ticket({ web: true });
  const head = deliverable(f);
  const seen = `\n## What people see\nPurpose: a member sees how many renewals are left.\nStates: limit-reached, empty\n`;
  f.plan(goodPlan(f.cat, seen));
  const old = f.w.sha;
  write(join(f.t, 'evidence', 'read-1.md'), `read web@${old}`);
  write(join(f.t, 'evidence', 'screens', `limit-reached@${old.slice(0, 10)}.png`), 'png');
  write(join(f.t, 'evidence', 'screens', `empty@${head.slice(0, 10)}-narrow.png`), 'png');
  write(join(f.w.path, 'src/api.ts'), 'x\n');
  git(f.w.path, 'add', '-A');
  git(f.w.path, 'commit', '-qm', 'api only');
  write(join(f.t, 'evidence', 'review-1-1.md'), `catalog@${head} web@${git(f.w.path, 'rev-parse', 'HEAD')}\nVerdict: fix: 1\n`);
  write(join(f.t, 'evidence', 'review-1-2.md'), `catalog@${head} web@${git(f.w.path, 'rev-parse', 'HEAD')}\nVerdict: fix: 1\n`);
  write(join(f.t, 'evidence', 'review-1-3.md'), `catalog@${head} web@${git(f.w.path, 'rev-parse', 'HEAD')}\nVerdict: clean\n`);
  assert.equal(run('checks', f.t, '--delivery', '1', '--definition', f.def).status, 0);
  const ok = run('links', f.t, '--delivery', '1', '--definition', f.def);
  assert.equal(ok.status, 0, ok.stdout);
  assert.match(ok.stdout, /review 3\/2 \(over the cap: reported/);
  write(join(f.w.path, 'messages/en.json'), '{"left": "left"}\n');
  git(f.w.path, 'commit', '-qam', 'words');
  write(join(f.t, 'evidence', 'review-1-3.md'), `catalog@${head} web@${git(f.w.path, 'rev-parse', 'HEAD')}\nVerdict: clean\n`);
  run('checks', f.t, '--delivery', '1', '--definition', f.def);
  const r = run('links', f.t, '--delivery', '1', '--definition', f.def);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /screenshot limit-reached \| no \| retake: .*touches web\/messages\/en\.json \| verify \|/);
  f.done();
});

test('record writes the counts from the files and counts earlier records as reopenings', () => {
  const f = ticket();
  f.plan(goodPlan(f.cat).replace('Risk: low', 'Risk: high'));
  for (const n of ['judge-1.md', 'review-1-1.md', 'review-1-2.md', 'read-1.md']) write(join(f.t, 'evidence', n), 'x');
  write(join(f.t, 'evidence', 'audit.md'), 'Findings: 1\n');
  write(join(f.t, 'evidence', 'missed.md'), '- the count was off by one on a renewed loan (review)\n');
  const records = join(f.root, 'records.jsonl');
  writeFileSync(records, JSON.stringify({ project: 'library-app', ticket: 'EX-1' }) + '\n');
  assert.equal(run('record', f.t, '--records', records).status, 0);
  const line = JSON.parse(readFileSync(records, 'utf8').trim().split('\n').at(-1));
  assert.deepEqual(
    [line.type, line.risk, line.plan_revisions, line.judge_rounds, line.read_rounds, line.review_rounds, line.rounds_over, line.reopened, line.surface_lines, line.surface_extras, line.cold_audit, line.first_delivered, line.profile],
    ['bug', 'high', 2, 1, 1, 2, false, 1, 1, 1, 1, '2026-01-05T15:00Z', null],
  );
  assert.deepEqual(line.missed, ['the count was off by one on a renewed loan (review)']);
  f.done();
});

test('links stops on a round-1 fix verdict, a red and a green that ran different commands, a high risk in the table, an open memo, and an after-step check not yet run', () => {
  const f = ticket();
  deliverable(f);
  const L = () => run('links', f.t, '--delivery', '1', '--final', '--definition', f.def);
  writeFileSync(join(f.t, 'evidence', 'review-1-1.md'), readFileSync(join(f.t, 'evidence', 'review-1-1.md'), 'utf8').replace('Verdict: clean', 'Verdict: fix: 1 finding'));
  assert.match(L().stdout, /review verdict \| no \| review-1-1\.md: fix: 1 finding \| implement, then review \|/);
  writeFileSync(join(f.t, 'evidence', 'review-1-2.md'), readFileSync(join(f.t, 'evidence', 'review-1-1.md'), 'utf8'));
  assert.match(L().stdout, /review verdict \| yes .*open findings go to the handoff/);
  writeFileSync(join(f.t, 'evidence', 'proof.jsonl'), '');
  run('proof', f.t, '--in', 'catalog', '--test', 'T1', '--base', '--', 'no-such-runner');
  run('proof', f.t, '--in', 'catalog', '--test', 'T1', '--base', '--', process.execPath, 'test/fail.mjs');
  run('proof', f.t, '--in', 'catalog', '--test', 'T1', '--', 'true');
  assert.match(L().stdout, /T1 red then green \| no \| green on HEAD's tree; no failing base run of the same command/);
  f.plan(goodPlan(f.cat).replace('| plan | |', '| plan | |') + '\n## Risk\n| By | Level | Why |\n|---|---|---|\n| judge | high | reach |\n\n## Memos\n### M1: Show the fee?\n- Recommendation: yes\n- Decided: open\n');
  const r = L();
  assert.match(r.stdout, /approval \| no/);
  assert.match(r.stdout, /memos decided \| no \| open: M1/);
  f.plan(goodPlan(f.cat));
  f.checks([...goodChecks, { ...goodChecks[0], id: 'C2', surface: ['S1'], verify: 'walk: the count after deploy', due: 'after deploy to staging in delivery 1', passes: false }]);
  run('checks', f.t, '--delivery', '1', '--definition', f.def);
  assert.match(L().stdout, /checks \| no \| checks due after this delivery's steps have not run/);
  assert.match(run('checks', f.t, '--delivery', '1', '--after', '--definition', f.def).stdout, /C2 \[S1\]: fail: passes is not true/);
  f.done();
});

test('links keeps a review across a base update that leaves the change the same', () => {
  const f = ticket();
  git(f.cat.path, 'branch', 'upstream');
  writeFileSync(join(f.t, 'STATE.md'), readFileSync(join(f.t, 'STATE.md'), 'utf8').replace('from main at', 'from upstream at'));
  const head = deliverable(f);
  git(f.cat.path, 'checkout', '-q', 'upstream');
  write(join(f.cat.path, 'docs/notes.md'), 'unrelated\n');
  git(f.cat.path, 'add', '-A');
  git(f.cat.path, 'commit', '-qm', 'base moves');
  git(f.cat.path, 'checkout', '-q', 'main');
  git(f.cat.path, 'rebase', '-q', 'upstream');
  assert.notEqual(git(f.cat.path, 'rev-parse', 'HEAD'), head);
  const r = run('links', f.t, '--delivery', '1', '--definition', f.def);
  assert.match(r.stdout, /catalog reviewed \| yes \| review-1-1\.md names the same change on the earlier base/);
  assert.match(r.stdout, /T1 red then green \| no/);
  f.done();
});
