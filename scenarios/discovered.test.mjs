import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { knownLimits } from '../engine/tracker.mjs';
import { closureFile, commitIn, criteriaFile, goodClosure, makeRepo, ok, sh, singleRepoProject, state, tmp, wf, yaml } from './helpers.mjs';

// I-18, named failure: implementers, reviewers and the owner agent noted real defects found during a ticket and parked
// them as follow-ups or "harmless today" without the owner deciding. Every issue found during a ticket is now in the
// attempt's discovered-issue ledger and ends fixed (with a commit of this ticket) or deferred with the owner's words;
// delivery refuses an open one and the reviewer gives each a verdict.
// I-19, named failure: a frozen "no change in repo X" criterion blocked a fix that needed an additive change there, and
// the only way through was an amendment framed as an exception. A discovered fix now adds the repo and its work items to
// the running attempt in one owner step, and the reviewer judges the contract seam on both sides.

const TEMPLATES = path.resolve(import.meta.dirname, '..', 'templates', 'agents');
const SKILLS = path.resolve(import.meta.dirname, '..', 'skills');
const bundleOf = (r) => JSON.parse(fs.readFileSync(r.out.match(/^Read (\S+)/m)?.[1] ?? r.out.match(/bundle: (\S+)/)[1], 'utf8'));
const disc = (root, args) => wf(root, ['discovered', ...args]);

test('I-18: discovered issues are recorded, end fixed by a ticket commit or deferred in the owner\'s words, and block delivery while open', () => {
  const { base, root } = singleRepoProject('discovered', { gate: { steps: [{ id: 'unit', repo: 'app', run: 'true' }] } });
  const e = ok(wf(root, ['entry', '--item', 'ENG-700', '--owner', 'o', '--json'])).json();
  const id = e.id;
  const wt = e.repos.app.worktree;
  ok(wf(root, ['handoff', 'planner', '--agent', 'plan-1', '--attempt', id, '--owner', 'o']));
  ok(wf(root, ['plan', '--file', criteriaFile(base), '--attempt', id, '--owner', 'o']));
  ok(wf(root, ['handoff', 'implementer', '--agent', 'impl-1', '--attempt', id, '--owner', 'o']));

  // Any role records what it finds; the list shows it open, and so do status and the next step.
  assert.match(disc(root, ['add', '--attempt', id]).err, /--summary/);
  const a = ok(disc(root, ['add', '--attempt', id, '--summary', 'the pager total sums only the current page', '--where', 'src/a.txt:1', '--found-by', 'impl-1']));
  assert.match(a.out, /discovered D1 recorded on ENG-700\.1/);
  assert.match(ok(disc(root, ['list', '--attempt', id])).out, /D1 {2}open {2}the pager total sums only the current page {2}\(src\/a\.txt:1; found by impl-1\)/);
  assert.match(ok(wf(root, ['resume', '--attempt', id])).out, /discovered: 1 open \(D1\)[\s\S]*next: fix the discovered issue\(s\) D1 in this ticket/);

  // Fixed means a commit of this ticket: not the base, not an unknown sha.
  const baseSha = sh(wt, 'git rev-parse HEAD');
  assert.match(disc(root, ['close', 'D1', '--fixed', baseSha, '--attempt', id]).err, /is not a commit of this ticket/);
  assert.match(disc(root, ['close', 'D1', '--fixed', 'deadbeef', '--attempt', id]).err, /is not a commit of this ticket/);
  commitIn(wt, { 'src/a.txt': 'b\n' }, 'pager total sums every page');
  const fix = sh(wt, 'git rev-parse HEAD');
  assert.match(ok(disc(root, ['close', 'D1', '--fixed', fix.slice(0, 10), '--attempt', id])).out, /D1 fixed in app@/);
  assert.match(disc(root, ['close', 'D1', '--fixed', fix, '--attempt', id]).err, /D1 is already fixed/);

  // Deferral is the owner's decision, in their words; a role agent cannot defer, and "follow-up" without words is refused.
  ok(disc(root, ['add', '--attempt', id, '--summary', 'tables have no phone card view', '--found-by', 'impl-1']));
  assert.match(disc(root, ['close', 'D2', '--deferred', '--attempt', id]).err, /--decision "<the owner's own words>"/);
  assert.match(disc(root, ['close', 'D2', '--deferred', '--decision', 'harmless today', '--by', 'impl-1', '--attempt', id]).err, /impl-1 is an implementer of this attempt: only the owner defers/);
  assert.match(disc(root, ['close', 'D2', '--fixed', fix, '--deferred', '--decision', 'x', '--attempt', id]).err, /either --fixed <commit> or --deferred/);
  ok(disc(root, ['close', 'D2', '--deferred', '--decision', 'park it for the mobile pass next sprint', '--attempt', id, '--owner', 'o']));

  // The reviewer's bundle lists every entry; a closure without a verdict per entry is refused.
  ok(wf(root, ['gate', '--attempt', id]));
  const h = ok(wf(root, ['handoff', 'reviewer', '--agent', 'rev-1', '--attempt', id, '--owner', 'o']));
  const bundle = bundleOf(h);
  assert.deepEqual(bundle.discovered.map((d) => [d.id, d.status]), [['D1', 'fixed'], ['D2', 'deferred']]);
  assert.equal(bundle.discovered[1].deferred.decision, 'park it for the mobile pass next sprint');
  assert.match(bundle.instructions, /discovered: \[\{ id, verdict: fixed\|deferred\|open, evidence \}\]/);
  const refused = wf(root, ['review', '--closure', closureFile(base, goodClosure('rev-1')), '--attempt', id]);
  assert.match(refused.err, /2 discovered issue\(s\) in your bundle have no valid verdict[\s\S]*D1: no verdict[\s\S]*D2: no verdict/);
  const wrong = wf(root, ['review', '--closure', closureFile(base, goodClosure('rev-1', { discovered: [{ id: 'D1', verdict: 'deferred', evidence: 'x' }, { id: 'D2', verdict: 'deferred', evidence: 'owner decision recorded' }] })), '--attempt', id]);
  assert.match(wrong.err, /D1: `deferred` only acknowledges a deferral the owner recorded; D1 is fixed/);
  ok(wf(root, ['review', '--closure', closureFile(base, goodClosure('rev-1', { discovered: [{ id: 'D1', verdict: 'fixed', evidence: 'src/a.txt:1 sums every page' }, { id: 'D2', verdict: 'deferred', evidence: 'owner decision recorded' }] })), '--attempt', id]));

  // An entry recorded after the round was handed is not judged: acceptance needs a fresh round.
  ok(disc(root, ['add', '--attempt', id, '--summary', 'an implicit page-size default', '--found-by', 'o']));
  assert.match(wf(root, ['accept', '--attempt', id, '--owner', 'o']).err, /discovered D3 was recorded after this review round was handed[\s\S]*fresh reviewer/);
  ok(wf(root, ['handoff', 'reviewer', '--agent', 'rev-2', '--attempt', id, '--owner', 'o']));
  ok(wf(root, ['review', '--closure', closureFile(base, goodClosure('rev-2', { discovered: [{ id: 'D1', verdict: 'fixed', evidence: 'src/a.txt:1' }, { id: 'D2', verdict: 'deferred', evidence: 'recorded' }, { id: 'D3', verdict: 'open', evidence: 'still implicit at src/a.txt:1' }] })), '--attempt', id]));
  assert.match(wf(root, ['accept', '--attempt', id, '--owner', 'o']).err, /discovered D3: the reviewer found it open/);
  ok(disc(root, ['close', 'D3', '--deferred', '--decision', 'the default is the documented one; leave it', '--attempt', id, '--owner', 'o']));
  ok(wf(root, ['handoff', 'reviewer', '--agent', 'rev-3', '--attempt', id, '--owner', 'o']));
  ok(wf(root, ['review', '--closure', closureFile(base, goodClosure('rev-3', { discovered: [{ id: 'D1', verdict: 'fixed', evidence: 'src/a.txt:1' }, { id: 'D2', verdict: 'deferred', evidence: 'recorded' }, { id: 'D3', verdict: 'deferred', evidence: 'recorded' }] })), '--attempt', id]));
  ok(wf(root, ['accept', '--attempt', id, '--owner', 'o']));

  // Delivery refuses any open entry, whenever it was recorded.
  ok(disc(root, ['add', '--attempt', id, '--summary', 'a failed Next strands the user', '--found-by', 'o']));
  const d = wf(root, ['deliver', '--attempt', id, '--owner', 'o']);
  assert.match(d.err, /not delivered: 1 discovered issue\(s\) are open: D4 a failed Next strands the user[\s\S]*fix it in this ticket[\s\S]*--deferred --decision/);
  ok(disc(root, ['close', 'D4', '--deferred', '--decision', 'separate ticket ENG-701, agreed', '--attempt', id, '--owner', 'o']));
  ok(wf(root, ['deliver', '--attempt', id, '--owner', 'o']));
  const s = state(root, id);
  assert.deepEqual(s.discovered.map((x) => [x.id, x.status]), [['D1', 'fixed'], ['D2', 'deferred'], ['D3', 'deferred'], ['D4', 'deferred']]);
  assert.match(ok(wf(root, ['export', '--attempt', id, '--json'])).out, /park it for the mobile pass next sprint/);
  // The tester sees each deferral, in the owner's words, among the delivered comment's known limits.
  assert.match(knownLimits(s), /- Deferred by the owner: tables have no phone card view \("park it for the mobile pass next sprint"\)/);
});

function twoRepos(name) {
  const base = tmp(name);
  const root = path.join(base, 'ws');
  fs.mkdirSync(root);
  const cfg = { version: 1, enabled: true, name, adapterRepo: 'api', repos: [{ name: 'api', path: 'api', base: 'main' }, { name: 'web', path: 'web', base: 'main' }], components: [{ id: 'api', kind: 'service', repo: 'api' }, { id: 'web', kind: 'web', repo: 'web' }], lanes: ['quick', 'standard'], gate: { steps: [{ id: 'api-unit', repo: 'api', run: 'true' }, { id: 'web-unit', repo: 'web', run: 'true' }] } };
  makeRepo(path.join(root, 'api'), { '.gitignore': '.wf-evidence/\n.wf-worktrees/\n', '.workflow/project.yaml': yaml(cfg), 'src/totals.txt': 'page\n' });
  makeRepo(path.join(root, 'web'), { 'src/pager.txt': 'page\n' });
  fs.symlinkSync(path.join('api', '.workflow'), path.join(root, '.workflow'));
  return { base, root };
}

test('I-19: a discovered fix adds a repo and its work items to the running attempt in one owner step; the seam is judged on both sides', () => {
  const { base, root } = twoRepos('add-repo');
  const e = ok(wf(root, ['entry', '--item', 'ENG-710', '--repos', 'web', '--owner', 'o', '--json'])).json();
  const id = e.id;
  assert.deepEqual(Object.keys(e.repos), ['web']);
  ok(wf(root, ['handoff', 'planner', '--agent', 'plan-1', '--attempt', id, '--owner', 'o']));
  const plan = path.join(base, 'plan.json');
  fs.writeFileSync(plan, JSON.stringify({ plan: 'pager', criteria: [{ id: 'C1', text: 'the pager pages', uat: 'pages move' }], work: [{ id: 'W1', criteria: ['C1'], repos: ['web'], class: 'light', why: 'ui' }] }));
  ok(wf(root, ['plan', '--file', plan, '--attempt', id, '--owner', 'o']));
  ok(wf(root, ['handoff', 'implementer', '--work', 'W1', '--agent', 'impl-1', '--attempt', id, '--owner', 'o']));
  commitIn(e.repos.web.worktree, { 'src/pager.txt': 'pages\n' });
  ok(disc(root, ['add', '--attempt', id, '--summary', 'the total shown under the pager sums only the current page; the api must return the full total', '--found-by', 'impl-1']));

  const amend = path.join(base, 'amend.json');
  fs.writeFileSync(amend, JSON.stringify({ criteria: [{ id: 'C2', text: 'the list response carries the total over every page; existing fields, permissions and tenant isolation unchanged', uat: 'the total matches the sum of all pages' }], work: [{ id: 'W1', criteria: ['C1'], repos: ['web'], class: 'light', why: 'ui' }, { id: 'W2', criteria: ['C2'], repos: ['api'], class: 'full', why: 'the api contract' }] }));
  assert.match(wf(root, ['criteria', 'amend', '--file', amend, '--reason', 'D1 needs the api total', '--add-repo', 'nope', '--attempt', id]).err, /unknown repo `nope`/);
  assert.match(wf(root, ['criteria', 'amend', '--file', amend, '--reason', 'x', '--add-repo', 'web', '--attempt', id]).err, /web is already in ENG-710\.1/);
  const noWork = path.join(base, 'amend-nowork.json');
  fs.writeFileSync(noWork, JSON.stringify({ criteria: [{ id: 'C2', text: 't', uat: 'u' }] }));
  assert.match(wf(root, ['criteria', 'amend', '--file', noWork, '--reason', 'x', '--add-repo', 'api', '--attempt', id]).err, /no work item covers the added repo api/);
  const r = ok(wf(root, ['criteria', 'amend', '--file', amend, '--reason', 'D1 needs the api total', '--add-repo', 'api', '--attempt', id, '--owner', 'o']));
  assert.match(r.out, /repo added: api \(worktree .*ENG-710\.1\/api, base [0-9a-f]{10}\)/);
  const s = state(root, id);
  assert.deepEqual(Object.keys(s.repos).sort(), ['api', 'web']);
  assert.ok(fs.existsSync(path.join(s.repos.api.worktree, 'src', 'totals.txt')));
  assert.deepEqual(s.addedRepos.map((x) => [x.repo, x.reason]), [['api', 'D1 needs the api total']]);
  assert.match(ok(wf(root, ['resume', '--attempt', id])).out, /W2 class full .*`wf handoff implementer --work W2/);

  ok(wf(root, ['handoff', 'implementer', '--work', 'W2', '--agent', 'impl-2', '--attempt', id, '--owner', 'o']));
  commitIn(s.repos.api.worktree, { 'src/totals.txt': 'page\ntotal\n' }, 'list response carries the full total');
  const fix = sh(s.repos.api.worktree, 'git rev-parse HEAD');
  ok(disc(root, ['close', 'D1', '--fixed', fix, '--attempt', id, '--owner', 'o']));
  ok(wf(root, ['gate', '--attempt', id]));
  const h = ok(wf(root, ['handoff', 'reviewer', '--agent', 'rev-1', '--attempt', id, '--owner', 'o']));
  const bundle = bundleOf(h);
  assert.deepEqual(bundle.addedRepos.map((x) => x.repo), ['api']);
  assert.match(bundle.instructions, /seams: \[\{ repo, verdict: matched\|finding, evidence, finding \}\]/);
  const closure = (extra) => closureFile(base, goodClosure('rev-1', { criteria: [{ id: 'C1', evidence: { kind: 'output', ref: 'l' } }, { id: 'C2', evidence: { kind: 'output', ref: 'l' } }], discovered: [{ id: 'D1', verdict: 'fixed', evidence: 'api/src/totals.txt:2' }], ...extra }));
  assert.match(wf(root, ['review', '--closure', closure({}), '--attempt', id]).err, /1 repo\(s\) added during the attempt have no valid seam verdict[\s\S]*api: no verdict/);
  assert.match(wf(root, ['review', '--closure', closure({ seams: [{ repo: 'api', verdict: 'matched', evidence: 'api/src/totals.txt:2' }] }), '--attempt', id]).err, /api: `matched` needs evidence from both sides/);
  ok(wf(root, ['review', '--closure', closure({ seams: [{ repo: 'api', verdict: 'matched', evidence: 'producer api/src/totals.txt:2; consumer web/src/pager.txt:1' }] }), '--attempt', id]));
  ok(wf(root, ['accept', '--attempt', id, '--owner', 'o']));
  const d = ok(wf(root, ['deliver', '--attempt', id, '--owner', 'o']));
  assert.match(d.out, /delivered ENG-710\.1: .*api@[0-9a-f]{10}.*web@[0-9a-f]{10}|delivered ENG-710\.1: .*web@[0-9a-f]{10}.*api@[0-9a-f]{10}/);
  assert.equal(sh(path.join(root, 'api'), 'git fetch -q origin && git show origin/main:src/totals.txt'), 'page\ntotal');
});

test('I-18/I-19: role texts, the work and quick-fix skills say every issue is fixed in the ticket and fences are amended, not used to defer', () => {
  const planner = fs.readFileSync(path.join(TEMPLATES, 'planner.md'), 'utf8');
  const implementer = fs.readFileSync(path.join(TEMPLATES, 'implementer.md'), 'utf8');
  const reviewer = fs.readFileSync(path.join(TEMPLATES, 'reviewer.md'), 'utf8');
  const work = fs.readFileSync(path.join(SKILLS, 'work', 'SKILL.md'), 'utf8');
  const quick = fs.readFileSync(path.join(SKILLS, 'quick-fix', 'SKILL.md'), 'utf8');
  assert.doesNotMatch(planner, /Note follow-ups separately/);
  assert.match(planner, /Never write a blanket "no change in X" criterion/);
  assert.match(planner, /the contract seam stays matched; existing fields, permissions and tenant isolation are unchanged/);
  assert.match(implementer, /`wf discovered add/);
  assert.match(implementer, /Never defer one yourself/);
  assert.match(reviewer, /never a reason to defer or to ship a cosmetic workaround/);
  assert.match(reviewer, /"discovered": \[/);
  assert.match(reviewer, /"seams": \[/);
  for (const skill of [work, quick]) {
    assert.match(skill, /wf discovered close/);
    assert.match(skill, /amend the criteria/);
    assert.match(skill, /never .*defer/i);
  }
  assert.match(work, /--add-repo/);
});

// I-18 (extended), named failure: an implementer reported "Not fixed, outside the brief: the status field shows the
// raw enum value" and handed the issue back to the owner agent to relay. An issue found while working is fixed by the
// role that found it, in this attempt, in whatever file it lives in; the only exception is a file another work item is
// editing at that moment, recorded with that work item; and a report that leaves one unfixed without a ledger entry is
// refused at the next handoff.
const homeOf = (root) => path.join(root, '..', '.home');
function implementerReport(root, name, agentType, text) {
  const dir = path.join(homeOf(root), '.claude', 'projects', '-ws', 'owner-session', 'subagents');
  const file = `agent-${Math.random().toString(36).slice(2)}`;
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${file}.meta.json`), JSON.stringify({ name, agentType }));
  const at = new Date().toISOString();
  fs.writeFileSync(path.join(dir, `${file}.jsonl`), [{ type: 'user', timestamp: at, message: { role: 'user', content: 'Read the bundle and follow its instructions.' } }, { type: 'assistant', timestamp: at, message: { role: 'assistant', model: 'm', content: [{ type: 'text', text }] } }].map((x) => JSON.stringify(x)).join('\n'));
}

test('I-18: an implementer report that leaves an issue unfixed without a ledger entry is refused; a blocked fix names the work item editing that file', () => {
  const { base, root } = singleRepoProject('report-check', { gate: { steps: [{ id: 'unit', repo: 'app', run: 'true' }] } });
  const e = ok(wf(root, ['entry', '--item', 'ENG-720', '--owner', 'o', '--json'])).json();
  const id = e.id;
  ok(wf(root, ['handoff', 'planner', '--agent', 'plan-1', '--attempt', id, '--owner', 'o']));
  const plan = path.join(base, 'plan.json');
  fs.writeFileSync(plan, JSON.stringify({ plan: 'p', criteria: [{ id: 'C1', text: 'a', uat: 'a' }, { id: 'C2', text: 'b', uat: 'b' }], work: [{ id: 'W1', criteria: ['C1'], repos: ['app'], class: 'light', why: 'ui' }, { id: 'W2', criteria: ['C2'], repos: ['app'], class: 'full', why: 'api' }] }));
  ok(wf(root, ['plan', '--file', plan, '--attempt', id, '--owner', 'o']));
  const h1 = ok(wf(root, ['handoff', 'implementer', '--work', 'W1', '--agent', 'impl-1', '--attempt', id, '--owner', 'o']));
  ok(wf(root, ['handoff', 'implementer', '--work', 'W2', '--agent', 'impl-2', '--attempt', id, '--owner', 'o']));
  commitIn(e.repos.app.worktree, { 'src/a.txt': 'b\n' });
  const type = h1.out.match(/Start agent type (\S+)/)[1];
  implementerReport(root, 'impl-1', type, 'Done: C1 passes.\n\nNot fixed, outside the brief: the status field shows the raw enum value (src/status.tsx:12).\nNo follow-ups needed elsewhere.');
  const r = wf(root, ['handoff', 'reviewer', '--agent', 'rev-1', '--attempt', id, '--owner', 'o']);
  assert.match(r.err, /impl-1's report leaves 1 issue\(s\) unfixed without a discovered entry:\n {2}- Not fixed, outside the brief: the status field shows the raw enum value/);
  assert.doesNotMatch(r.err, /No follow-ups needed/);
  assert.match(r.err, /the implementer that found it fixes it[\s\S]*wf discovered add/);

  // The one exception: the file is another work item's at that moment. The entry names it; an unknown work item is refused.
  assert.match(disc(root, ['add', '--attempt', id, '--summary', 's', '--blocked-by', 'W9']).err, /no work item W9/);
  ok(disc(root, ['add', '--attempt', id, '--summary', 'the status field shows the raw enum value', '--where', 'src/status.tsx:12', '--found-by', 'impl-1', '--blocked-by', 'W2']));
  assert.match(ok(disc(root, ['list', '--attempt', id])).out, /D1 {2}open .* blocked by W2: route it to that work item's implementer/);
  assert.match(ok(wf(root, ['resume', '--attempt', id])).out, /D1 to the implementer of W2/);
  // A report naming the entry passes.
  implementerReport(root, 'impl-1', type, 'Done: C1 passes.\n\nD1 not fixed here: src/status.tsx is the file W2 is editing right now (recorded, blocked by W2).');
  ok(wf(root, ['handoff', 'reviewer', '--agent', 'rev-1', '--attempt', id, '--owner', 'o']));
});

test('I-18 (extended): role texts and skills say the role that found an issue fixes it, whatever the brief; the owner routes, never fixes', () => {
  const implementer = fs.readFileSync(path.join(TEMPLATES, 'implementer.md'), 'utf8');
  const reviewer = fs.readFileSync(path.join(TEMPLATES, 'reviewer.md'), 'utf8');
  const work = fs.readFileSync(path.join(SKILLS, 'work', 'SKILL.md'), 'utf8');
  const quick = fs.readFileSync(path.join(SKILLS, 'quick-fix', 'SKILL.md'), 'utf8');
  assert.match(implementer, /fixed by you, in this attempt, in whatever file it lives in/);
  assert.match(implementer, /The work-item brief is never a reason to leave it/);
  assert.match(implementer, /--blocked-by <work item>/);
  assert.doesNotMatch(implementer, /build that item only/);
  assert.match(reviewer, /the owner routes it to the implementer, never fixes it/);
  for (const skill of [work, quick]) {
    assert.match(skill, /by the role that found it/);
    assert.match(skill, /never fix it yourself/);
    assert.match(skill, /outside the brief/);
  }
});
