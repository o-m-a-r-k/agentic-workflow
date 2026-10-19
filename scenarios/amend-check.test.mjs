// 0.7.34 (I-230, I-231), named failure (field): a planner preparing a consolidated re-plan of an attempt whose criteria were
// frozen had no read-only check. `wf plan --check` refused (the criteria are frozen) and pointed at the mutating
// `wf criteria amend`; the amendment's schema errors (an impact `contracts` entry naming no query) surfaced only when the
// owner recorded it, after the planner had handed back, and cost another planner handoff for a schema-only repair.
// `wf criteria amend --check` runs every check the amendment would meet, through the same code path, and records nothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { criteriaFile, FIXTURE_EXPECT, impactAddendum, makeRepo, ok, singleRepoProject, state, tmp, wf, yaml } from './helpers.mjs';

const bundleOf = (r) => JSON.parse(fs.readFileSync(r.out.match(/^Read (\S+)/m)?.[1] ?? r.out.match(/bundle: (\S+)/)[1], 'utf8'));
const write = (base, doc) => {
  const f = path.join(base, `amend-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(f, JSON.stringify(doc));
  return f;
};

function frozen(name) {
  const { base, root } = singleRepoProject(name, { gate: { steps: [{ id: 'unit', repo: 'app', run: 'true' }] } });
  const e = ok(wf(root, ['entry', '--item', 'AC-1', '--owner', 'o', '--json'])).json();
  ok(wf(root, ['handoff', 'planner', '--agent', 'p', '--attempt', e.id]));
  ok(wf(root, ['plan', '--file', criteriaFile(base), '--attempt', e.id]));
  return { base, root, id: e.id };
}

test('I-230: on frozen criteria `wf plan --check` names the read-only amendment check, and a re-plan planner is told to run it', () => {
  const { base, root, id } = frozen('amend-check-route');
  const r = wf(root, ['plan', '--check', '--file', criteriaFile(base), '--attempt', id]);
  assert.equal(r.code, 75);
  assert.match(r.err, /criteria are already frozen/);
  assert.match(r.err, /wf criteria amend --check --file <f>/, 'the refusal names the dry run of the amendment');
  const b = bundleOf(ok(wf(root, ['handoff', 'planner', '--agent', 'p2', '--attempt', id])));
  assert.match(b.instructions, /wf criteria amend --check --file <f> --attempt/, 'a planner of frozen criteria is told how to check its amendment');
  assert.doesNotMatch(b.instructions, /wf plan --check/);
});

test('I-231: `wf criteria amend --check` meets the amendment\'s own validators, needs no reason and records nothing; the amendment it accepts is recorded', () => {
  const { base, root, id } = frozen('amend-check-run');
  const ledger = path.join(root, '.wf-evidence', 'attempts', id, 'ledger.jsonl');
  const before = fs.readFileSync(ledger, 'utf8');
  const criteria = [{ id: 'C2', text: 'the list shows a total', uat: 'the total matches' }];
  const work = null;
  const addendum = impactAddendum(criteria, work);
  // The field's refusal: an impact `contracts` entry with no query provenance.
  const bad = write(base, { criteria, impact: { ...addendum, changes: [{ ...addendum.changes[0], contracts: [{ contract: 'GET /list', hits: 0 }] }] } });
  const refused = wf(root, ['criteria', 'amend', '--check', '--file', bad, '--attempt', id]);
  assert.equal(refused.code, 75, refused.err);
  assert.match(refused.err, /amendment refused: its impact addendum is incomplete[\s\S]*contracts\[0\]/);
  // The same file meets the same refusal when recorded: one code path.
  const real = wf(root, ['criteria', 'amend', '--file', bad, '--reason', 'r', '--attempt', id]);
  assert.equal(real.code, 75);
  assert.equal(real.err.replace(/^warning:.*\n/gm, ''), refused.err.replace(/^warning:.*\n/gm, ''));
  const good = write(base, { criteria, impact: addendum, expect: FIXTURE_EXPECT });
  const checked = ok(wf(root, ['criteria', 'amend', '--check', '--file', good, '--attempt', id]));
  assert.match(checked.out, /the amendment would be recorded: criteria would be \(2\): C1, C2; changed: none; added: C2; dropped: none[\s\S]*impact addendum checks out \(queries re-run\)[\s\S]*nothing was recorded/);
  const s = state(root, id);
  assert.equal(s.criteriaAmendments.length, 0, 'nothing recorded');
  assert.equal(s.criteria.length, 1);
  assert.equal(fs.readFileSync(ledger, 'utf8'), before, 'the ledger did not move');
  assert.equal(fs.existsSync(path.join(root, '.wf-evidence', 'attempts', id, 'plans')) && fs.readdirSync(path.join(root, '.wf-evidence', 'attempts', id, 'plans')).some((f) => f.startsWith('amend-')), false, 'no raw copy kept');
  // The owner records the same file: accepted.
  ok(wf(root, ['criteria', 'amend', '--file', good, '--reason', 'the total joins', '--attempt', id]));
  assert.deepEqual(state(root, id).criteria.map((c) => c.id), ['C1', 'C2']);
  assert.ok(fs.readdirSync(path.join(root, '.wf-evidence', 'attempts', id, 'plans')).some((f) => f.startsWith('amend-1.raw')), 'the recorded amendment keeps its raw copy where the dry run kept none');
});

test('I-231: `wf criteria amend --check --add-repo` checks the repo it would add and creates no worktree', () => {
  const base = tmp('amend-check-repo');
  const root = path.join(base, 'ws');
  fs.mkdirSync(root);
  const cfg = { version: 1, enabled: true, name: 'amend-check-repo', adapterRepo: 'api', repos: [{ name: 'api', path: 'api', base: 'main' }, { name: 'web', path: 'web', base: 'main' }], components: [{ id: 'api', kind: 'service', repo: 'api' }, { id: 'web', kind: 'web', repo: 'web' }], lanes: ['quick', 'standard'], gate: { steps: [{ id: 'api-unit', repo: 'api', run: 'true' }, { id: 'web-unit', repo: 'web', run: 'true' }] } };
  makeRepo(path.join(root, 'api'), { '.gitignore': '.wf-evidence/\n.wf-worktrees/\n', '.workflow/project.yaml': yaml(cfg), 'src/totals.txt': 'page\n' });
  makeRepo(path.join(root, 'web'), { 'src/pager.txt': 'page\n' });
  fs.symlinkSync(path.join('api', '.workflow'), path.join(root, '.workflow'));
  const e = ok(wf(root, ['entry', '--item', 'AC-2', '--repos', 'web', '--owner', 'o', '--json'])).json();
  ok(wf(root, ['handoff', 'planner', '--agent', 'p', '--attempt', e.id]));
  const plan = write(base, { plan: 'pager', expect: FIXTURE_EXPECT, criteria: [{ id: 'C1', text: 'the pager pages', uat: 'pages move' }], work: [{ id: 'W1', criteria: ['C1'], repos: ['web'], class: 'light', why: 'ui' }] });
  ok(wf(root, ['plan', '--file', plan, '--attempt', e.id]));
  const criteria = [{ id: 'C2', text: 'the list carries the total', uat: 'the total matches' }];
  const work = [{ id: 'W1', criteria: ['C1'], repos: ['web'], class: 'light', why: 'ui' }, { id: 'W2', criteria: ['C2'], repos: ['api'], class: 'full', why: 'the api contract' }];
  const amend = write(base, { criteria, work, impact: impactAddendum(criteria, work) });
  assert.match(wf(root, ['criteria', 'amend', '--check', '--file', amend, '--add-repo', 'nope', '--attempt', e.id]).err, /unknown repo `nope`/);
  const r = ok(wf(root, ['criteria', 'amend', '--check', '--file', amend, '--add-repo', 'api', '--attempt', e.id]));
  assert.match(r.out, /repo api would be added/);
  assert.match(r.out, /nothing was recorded/);
  const s = state(root, e.id);
  assert.deepEqual(Object.keys(s.repos), ['web']);
  assert.equal(fs.existsSync(path.join(root, '.wf-worktrees', e.id, 'api')), false, 'no worktree created');
});
