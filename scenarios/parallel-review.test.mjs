// Named failures: serialized independent flows; file splits hid shared contracts; partial reviews authorized gates.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { changedInventory, divideReview, impactCatalog, isCurrentReviewer, validateDivision } from '../engine/review-groups.mjs';
import { withEvidenceTransaction } from '../engine/evidence.mjs';
import { closureFile, commitIn, criteriaFile, FIXTURE_EXPECT, goodClosure, impactCheckedFrom, ok, sh, singleRepoProject, state, wf, WF, write } from './helpers.mjs';

function flowInput() {
  const files = { 'shared.ts': 'alpha beta\n', 'unmapped.ts': 'common\n' };
  for (const feature of ['alpha', 'beta']) for (let i = 0; i < 24; i++) files[`${feature}/${i}.ts`] = `${feature}\n`;
  const changed = { app: Object.keys(files) };
  const flows = ['alpha', 'beta'].map(id => ({ id, flow: `use ${id}`, failure: 'show retry', query: id }));
  const bundle = { changed, impactMap: { survey: { flows }, derived: { outside: [] } } };
  const results = Object.fromEntries(flows.map(f => [f.id, { files: Object.entries(files).filter(([, text]) => text.includes(f.id)).map(([file]) => `app:${file}`) }]));
  return { files, bundle, results };
}

test('division keeps complete flows together, assigns shared/unmapped code to integration and balances slices', () => {
  const { bundle, results } = flowInput(), plan = divideReview(bundle, results);
  assert.equal(plan.mode, 'parallel');
  assert.deepEqual(plan.slices.map(s => s.files.length), [24, 24]);
  assert.deepEqual(plan.integration.files, ['app:shared.ts', 'app:unmapped.ts']);
  assert.equal(plan.integration.interfaces.length, 2);
  assert.ok(plan.integration.interfaces.every(i => i.owners.includes('integration')));
  assert.equal(plan.files.length, 50);
  const missing = structuredClone(plan); missing.slices[0].files.pop();
  assert.throws(() => validateDivision(missing, bundle), /every changed file exactly once/);
  const missingSeam = structuredClone(plan); missingSeam.integration.interfaces = [];
  assert.throws(() => validateDivision(missingSeam, bundle), /no integration check/);
});

test('division retains one reviewer for small, ambiguous and mostly shared changes; manual plans cannot split files', () => {
  const { bundle, results } = flowInput();
  assert.equal(divideReview({ changed: { app: ['a.ts'] } }, {}).mode, 'single');
  assert.equal(divideReview({ ...bundle, impactMap: null }, results).mode, 'single');
  const broad = { alpha: { files: changedInventory(bundle) }, beta: { files: changedInventory(bundle) } };
  assert.equal(divideReview(bundle, broad).mode, 'single');
  assert.throws(() => divideReview(bundle, results, { division: { slices: [{ files: ['app:alpha/0.ts'] }, { files: ['app:beta/0.ts'] }] } }), /flowIds/);
  assert.throws(() => divideReview(bundle, results, { division: { slices: [{ flowIds: ['survey:alpha'] }, { flowIds: ['survey:alpha'] }] } }), /multiply assigned/);
});

test('one indivisible expensive flow retains single review despite equal file counts', () => {
  const { bundle, results } = flowInput();
  const weights = Object.fromEntries(changedInventory(bundle).map(file => [file, file.includes('/0.ts') && file.includes('alpha') ? 10000 : 1]));
  assert.equal(divideReview(bundle, results, { weights }).mode, 'single');
  const explicit = divideReview(bundle, results, { weights, division: { slices: [{ flowIds: ['survey:alpha'] }, { flowIds: ['survey:beta'] }] } });
  assert.ok(explicit.slices[0].estimatedCost > explicit.slices[1].estimatedCost);
  assert.match(explicit.costBasis, /estimate/);
});

test('division preserves API/consumer/test query results in one flow rather than separating repositories', () => {
  const { bundle, results } = flowInput();
  bundle.changed.api = ['billing/service.ts']; results.alpha.files.push('api:billing/service.ts');
  const plan = divideReview(bundle, results);
  const owner = plan.slices.find(s => s.files.includes('api:billing/service.ts'));
  assert.ok(owner.files.includes('app:alpha/0.ts'));
  assert.ok(!plan.slices.some(s => s !== owner && s.flowIds.includes('survey:alpha')));
});

test('duplicate feature actions coalesce while contract and suite queries retain their producers and tests', () => {
  const { bundle, results } = flowInput();
  bundle.changed.api = ['contract.ts']; bundle.changed.tests = ['flow.spec.ts'];
  results.contract = { files: ['api:contract.ts'] }; results.suite = { files: ['tests:flow.spec.ts'] };
  bundle.impactMap.impact = { changes: [{ id: 'alpha', consumers: { query: 'alpha' }, flows: [{ query: 'alpha', flow: 'submit alpha', failure: 'show error' }], contracts: [{ query: 'contract' }], suites: [{ query: 'suite' }] }] };
  bundle.impactMap.survey.flows.push({ id: 'alpha-again', query: 'alpha', flow: 'refresh alpha', failure: 'keep old rows' });
  const plan = divideReview(bundle, results), owner = plan.slices.find(s => s.files.includes('app:alpha/0.ts'));
  assert.equal(plan.mode, 'parallel');
  assert.ok(owner.files.includes('api:contract.ts')); assert.ok(owner.files.includes('tests:flow.spec.ts'));
  assert.ok(owner.flowIds.includes('survey:alpha-again')); assert.ok(owner.flowIds.includes('change:alpha:0'));
});

test('impact compaction retains every entry ID with its current value while preserving history separately', () => {
  const map = { survey: { flows: [{ id: 'flow', flow: 'old' }] }, impact: { changes: [{ id: 'change', element: 'old' }] },
    addenda: [{ survey: { flows: [{ id: 'flow', flow: 'new' }, { id: 'another', flow: 'other' }] }, changes: [{ id: 'change', element: 'new' }] }] };
  const original = JSON.stringify(map), catalog = impactCatalog(map);
  assert.equal(catalog.flows.length, 2); assert.equal(catalog.flows[0].flow, 'new');
  assert.equal(catalog.changes[0].element, 'new'); assert.equal(JSON.stringify(map), original);
});

test('automatic single-review fallback never runs an unnecessary Git cost scan', () => {
  const p = singleRepoProject('review-cost', { gate: { steps: [] } });
  const e = ok(wf(p.root, ['entry', '--lane', 'quick', '--json'])).json();
  ok(wf(p.root, ['plan', '--file', criteriaFile(p.base), '--attempt', e.id]));
  ok(wf(p.root, ['handoff', 'implementer', '--agent', 'impl', '--attempt', e.id]));
  commitIn(e.repos.app.worktree, { 'src/a.txt': 'changed\n' });
  const realGit = sh(p.root, 'command -v git'), bin = path.join(p.base, 'bin');
  write(bin, 'git', `#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
const args=process.argv.slice(2);
if(args.includes('--numstat')) { console.error('single-review fallback performed an unnecessary cost scan'); process.exit(90); }
const result=spawnSync(${JSON.stringify(realGit)},args,{stdio:'inherit'});process.exit(result.status??1);
`);
  fs.chmodSync(path.join(bin, 'git'), 0o755);
  const h = ok(wf(p.root, ['handoff', 'reviewer', '--agent', 'single', '--attempt', e.id, '--json'], { env: { PATH: bin + path.delimiter + process.env.PATH } })).json();
  assert.equal(h.division.mode, 'single');
  assert.equal(h.members, undefined);
});

test('parallel division estimates cost lazily once and preserves expensive-flow fallback', () => {
  const { bundle, results } = flowInput();
  let reads = 0;
  const weights = Object.fromEntries(changedInventory(bundle).map(file => [file, file === 'app:alpha/0.ts' ? 10000 : 1]));
  const plan = divideReview(bundle, results, { weights: () => { reads++; return weights; } });
  assert.equal(reads, 1);
  assert.equal(plan.mode, 'single');
});

function ready({ reviewOptions = [], handoffReviewer = true, runtime = null } = {}) {
  const { files } = flowInput();
  const p = singleRepoProject('parallel-review', { strategy: { enabled: false }, classes: { review: { codex: { model: 'future-model', effort: 'high' } } }, gate: { steps: [] } }, files);
  const e = ok(wf(p.root, ['entry', '--lane', 'quick', '--json'])).json();
  const queries = ['alpha', 'beta'].map(id => ({ id, pattern: id, kind: 'literal', paths: ['alpha/**', 'beta/**', 'shared.ts'], hits: 25 }));
  const doc = { survey: { queries, patterns: [{ id: 'P', query: 'alpha', hits: 25 }] }, expect: FIXTURE_EXPECT,
    criteria: [{ id: 'C1', text: 'flows remain coherent' }], plan: { anchors: ['src/a.txt'], tests: { run: ['flow-test'] } }, impact: { changes: queries.map(q => ({ id: q.id, element: q.id, kind: 'symbol', cites: ['C1'], covers: ['P'],
      consumers: { query: q.id, hits: 25 }, flows: [{ flow: `use ${q.id}`, failure: 'retry', query: q.id, hits: 25 }], contracts: [], suites: [{ suite: 'flow-test', query: q.id, hits: 25 }] })) } };
  const planFile = closureFile(p.base, doc);
  ok(wf(p.root, ['plan', '--file', planFile, '--attempt', e.id]));
  const runtimeArgs = runtime ? ['--runtime', runtime] : [];
  ok(wf(p.root, ['handoff', 'implementer', '--agent', 'impl', '--attempt', e.id, ...runtimeArgs]));
  commitIn(e.repos.app.worktree, Object.fromEntries(Object.entries(files).map(([file, text]) => [file, text + 'changed\n'])));
  const h = handoffReviewer ? ok(wf(p.root, ['handoff', 'reviewer', '--agent', 'integration', ...reviewOptions, '--attempt', e.id, '--json', ...runtimeArgs])).json() : null;
  if (h && !reviewOptions.includes('--single')) assert.equal(h.members?.length, 3, 'separable large change must automatically create two scopes and integration');
  return { ...p, id: e.id, wt: e.repos.app.worktree, h };
}

test('ordinary reviewer handoffs automatically divide large separable changes; single is an explicit override', () => {
  const automatic = ready();
  assert.equal(automatic.h.division.mode, 'parallel');
  const single = ready({ reviewOptions: ['--single'] });
  assert.equal(single.h.members, undefined);
  assert.equal(JSON.parse(fs.readFileSync(single.h.bundle)).reviewGroup, undefined);
  const env = { CODEX_THREAD_ID: state(single.root, single.id).owner.slice('codex:'.length) };
  const existing = ok(wf(single.root, ['advance', '--once', '--attempt', single.id, '--json'], { env })).json();
  assert.equal(existing.operations.length, 0, 'advancement must not replace an existing single handoff');
  assert.equal(state(single.root, single.id).handoffs.filter(h => h.role === 'reviewer').length, 1);
  const compatible = ready({ reviewOptions: ['--parallel'] });
  assert.equal(compatible.h.division.mode, 'parallel', 'existing explicit parallel commands remain valid');
});

test('I-83 owner division diagnostics never enter the blind reviewer start prompt', () => {
  const p = ready({ handoffReviewer: false });
  const h = ok(wf(p.root, ['handoff', 'reviewer', '--agent', 'diagnostic', '--attempt', p.id]));
  assert.match(h.err, /division reason: parallel/);
  assert.match(h.err, /workload estimate: S1 24 files\/24 changed-line cost; S2 24 files\/24 changed-line cost; integration 2 files\/2 cost/);
  assert.match(h.err, /integration causes: unmapped 1, unassigned 0, cross-scope shared 1/);
  assert.equal(h.out.trim().split('\n').length, 1);
  assert.match(h.out, /^Read .* and follow its instructions\.\n$/);
});

test('review selection refuses conflicting flags and invalid values before handing or advancing roles', () => {
  const p = ready({ handoffReviewer: false });
  ok(wf(p.root, ['handoff', 'close', '--agent', 'impl', '--attempt', p.id]));
  const env = { CODEX_THREAD_ID: state(p.root, p.id).owner.slice('codex:'.length) };
  const division = closureFile(p.base, { slices: [] });
  for (const args of [['--single=false'], ['--parallel=false'], ['--single', '--parallel'], ['--single', '--reviewers', '2'], ['--single', '--division', division], ['--reviewers', '4']]) {
    assert.equal(wf(p.root, ['handoff', 'reviewer', '--agent', 'invalid', ...args, '--attempt', p.id]).code, 75, args.join(' '));
    assert.equal(wf(p.root, ['advance', '--once', ...args, '--attempt', p.id], { env }).code, 75, args.join(' '));
  }
  assert.equal(wf(p.root, ['handoff', 'implementer', '--agent', 'invalid', '--single', '--attempt', p.id]).code, 75);
  assert.equal(state(p.root, p.id).handoffs.filter(h => h.role === 'reviewer').length, 0);
  const selected = ok(wf(p.root, ['handoff', 'reviewer', '--agent', 'three', '--reviewers', '3', '--attempt', p.id, '--json'])).json();
  assert.equal(selected.division.mode, 'parallel', '--reviewers no longer requires an activation flag');
});

const evidenceRows = files => files.map(file => ({ file, evidence: `${file}:1 behavior and failure path inspected` }));
// 0.7.0 (goals, not forms): a scoped part and the integration closure carry no outsidePlan, designHits or rules verdicts; the
// bundles still list those as context (the native scenarios below still give them, and they are recorded).
function partClosure(p, member, findings = []) {
  const b = JSON.parse(fs.readFileSync(member.bundle));
  return { reviewer: member.agent, findings, criteria: [], filesReviewed: evidenceRows(b.primaryFiles) };
}
function integrationClosure(p) {
  const b = JSON.parse(fs.readFileSync(p.h.bundle)), reports = ok(wf(p.root, ['review', 'parts', '--attempt', p.id, '--json'])).json();
  return goodClosure(p.h.agent, { filesReviewed: evidenceRows(b.primaryFiles),
    interfacesReviewed: b.division.integration.interfaces.map(i => ({ id: i.id, evidence: i.files.join('; ') + ':1 checked producer/consumer behavior' })),
    partReviews: reports.map(r => ({ agent: r.agent, sha256: r.sha256, evidence: 'source/test boundaries independently verified' })),
    impactChecked: impactCheckedFrom(b) });
}

// 0.7.0 (goals, not forms; final review): a part needs no per-file coverage list and the integration closure no
// per-interface list or per-part hash citations. What holds: parts are immutable, nothing completes or gates until the
// integration closure is recorded after every part, and the integration owns the criteria evidence.
test('parallel parts never complete review; no coverage form is owed, and the combined round unlocks one gate', () => {
  const p = ready();
  const [first, second] = p.h.members;
  const bare = { reviewer: first.agent, findings: [], criteria: [] };
  ok(wf(p.root, ['review', '--closure', closureFile(p.base, bare), '--attempt', p.id]));
  assert.equal(state(p.root, p.id).review, null);
  assert.equal(wf(p.root, ['gate', '--attempt', p.id]).code, 75);
  assert.equal(wf(p.root, ['review', 'parts', '--attempt', p.id]).code, 75);
  assert.equal(wf(p.root, ['review', '--closure', closureFile(p.base, bare), '--attempt', p.id]).code, 75, 'parts cannot be rewritten');
  ok(wf(p.root, ['review', '--closure', closureFile(p.base, partClosure(p, second)), '--attempt', p.id]));
  const { interfacesReviewed: _interfaces, partReviews: _parts, ...integrated } = integrationClosure(p);
  ok(wf(p.root, ['review', '--closure', closureFile(p.base, integrated), '--attempt', p.id]));
  assert.ok(Array.isArray(state(p.root, p.id).review.closure.filesReviewed), 'coverage given as context is kept');
  ok(wf(p.root, ['gate', '--attempt', p.id]));
  assert.equal(wf(p.root, ['accept', '--attempt', p.id]).code, 75, 'a fresh evidence review is still required');
  p.h = ok(wf(p.root, ['handoff', 'reviewer', '--agent', 'evidence', '--attempt', p.id, '--json'])).json();
  assert.equal(JSON.parse(fs.readFileSync(p.h.bundle)).round, 'evidence-review');
  for (const member of p.h.members.slice(0, 2)) ok(wf(p.root, ['review', '--closure', closureFile(p.base, partClosure(p, member)), '--attempt', p.id]));
  ok(wf(p.root, ['review', '--closure', closureFile(p.base, integrationClosure(p)), '--attempt', p.id]));
  ok(wf(p.root, ['accept', '--attempt', p.id]));
  ok(wf(p.root, ['verify', '--attempt', p.id]));
});

test('integration cannot omit a scoped finding; stale trees invalidate all scoped reports', () => {
  const p = ready();
  for (const [index, member] of p.h.members.slice(0, 2).entries()) {
    const findings = index ? [] : [{ id: 'F1', severity: 'major', summary: 'failure path loses data', status: 'open', evidence: 'alpha/0.ts:1', invariant: 'no data is lost on a failure path' }];
    ok(wf(p.root, ['review', '--closure', closureFile(p.base, partClosure(p, member, findings)), '--attempt', p.id]));
  }
  const integrated = integrationClosure(p);
  ok(wf(p.root, ['review', '--closure', closureFile(p.base, integrated), '--attempt', p.id]));
  assert.ok(state(p.root, p.id).review.closure.findings.some(f => f.id === 'S1-F1'));
  assert.equal(wf(p.root, ['gate', '--attempt', p.id]).code, 75);
  commitIn(p.wt, { 'shared.ts': 'alpha beta changed again\n' });
  assert.match(wf(p.root, ['review', '--closure', closureFile(p.base, integrated), '--attempt', p.id]).err, /worktree changed/);
});

// Named failure (0.7.0): a scoped part was refused for a missing or foreign `outsidePlan`/`designHits`/`rules` verdict, and
// (final review) for criteria the integration reviewer owns: forms that measured compliance, not defects. A part is its
// findings, with IDs unique enough to merge; criteria or prior-finding verdicts in it are ignored, not refused.
test('scoped reviewers record their findings; global criteria in a part are ignored; duplicate finding IDs are refused; no verdict form is owed', () => {
  const p = ready(), member = p.h.members[0], closure = partClosure(p, member);
  const finding = { id: 'F1', evidence: 'alpha/0.ts:1', status: 'open' };
  assert.match(wf(p.root, ['review', '--closure', closureFile(p.base, { ...closure, findings: [finding, finding] }), '--attempt', p.id]).err, /unique non-empty IDs/);
  // The bundle still lists the member's files outside the plan; a part that judges none of them is recorded.
  assert.ok(JSON.parse(fs.readFileSync(member.bundle)).outsidePlan.length > 0, 'the member has files outside the plan to judge');
  const global = [{ id: 'C1', evidence: { kind: 'output', ref: 'gate log' } }];
  ok(wf(p.root, ['review', '--closure', closureFile(p.base, { ...closure, criteria: global }), '--attempt', p.id]));
  const parts = state(p.root, p.id).reviewParts;
  assert.equal(parts.length, 1, 'the part was recorded');
  assert.deepEqual(parts[0].closure.criteria, [], 'the integration reviewer owns the criteria');
});

test('evidence transaction rejects unsafe identities and control-path aliases before creating anything', () => {
  const p = singleRepoProject('transaction-path', { gate: { steps: [] } });
  assert.throws(() => withEvidenceTransaction(p.root, '../outside', () => {}), /invalid attempt|unsafe|must/);
  const alias = path.join(p.root, '.wf-worktrees'); fs.symlinkSync(p.base, alias);
  assert.throws(() => withEvidenceTransaction(p.root, 'ENG-1.1', () => {}), /control path/);
  assert.equal(fs.existsSync(path.join(p.base, 'ENG-1.1')), false);
});

test('group launch eligibility rejects partial, superseded and mismatched groups', () => {
  const members = ['s1', 's2', 'integration'], g = { id: 'g', members, snapshot: 'snapshot' };
  const handoffs = members.map(agent => ({ agent, role: 'reviewer', bundle: agent, reviewGroup: { ...g, slot: agent } }));
  assert.ok(handoffs.every(h => isCurrentReviewer({ handoffs }, h)));
  assert.equal(isCurrentReviewer({ handoffs: handoffs.slice(0, 2) }, handoffs[0]), false);
  assert.equal(isCurrentReviewer({ handoffs: [...handoffs, { role: 'reviewer', agent: 'later', bundle: 'later' }] }, handoffs[0]), false);
  const mixed = structuredClone(handoffs); mixed[0].reviewGroup.snapshot = 'other';
  assert.equal(isCurrentReviewer({ handoffs: mixed }, mixed[0]), false);
});

for (const launch of ['handoff', 'advance', 'single']) test(`native ${launch} selects automatic scopes or the single override and records every engine launch`, () => {
  const p = ready({ handoffReviewer: false, runtime: 'codex' }), bin = path.join(p.base, 'bin'), host = path.join(p.base, '.home');
  ok(wf(p.root, ['handoff', 'close', '--agent', 'impl', '--attempt', p.id]));
  const script = `#!/usr/bin/env node
import fs from 'node:fs'; import path from 'node:path'; import {randomUUID} from 'node:crypto'; import {spawnSync} from 'node:child_process';
const prompt=fs.readFileSync(0,'utf8'),bundle=JSON.parse(fs.readFileSync(prompt.slice(5,-29),'utf8')),sid=randomUUID(),at=new Date().toISOString();
const transcript=path.join(${JSON.stringify(host)},'.codex','sessions','2026','10','11','rollout-'+sid+'.jsonl');
fs.mkdirSync(path.dirname(transcript),{recursive:true});
fs.writeFileSync(transcript,[{timestamp:at,type:'session_meta',payload:{id:sid,originator:'codex_exec',source:'exec'}},{timestamp:at,type:'response_item',payload:{type:'message',role:'user',content:[{type:'input_text',text:prompt}]}}].map(JSON.stringify).join('\\n')+'\\n');
console.log(JSON.stringify({type:'thread.started',thread_id:sid}));
const trace=path.join(${JSON.stringify(p.base)},'trace-'+bundle.agent+'.json'),start=Date.now();
await new Promise(r=>setTimeout(r,350));
const files=bundle.primaryFiles??Object.entries(bundle.changed).flatMap(([repo,files])=>files.map(file=>repo+':'+file)),owned=new Set(files),closure={reviewer:bundle.agent,findings:[],criteria:[],filesReviewed:files.map(file=>({file,evidence:file+':1 checked'})),outsidePlan:(bundle.outsidePlan??[]).filter(file=>owned.has(file)).map(file=>({file,verdict:'covered',by:'C1',evidence:file+':1 checked'})),designHits:[],rules:[]};
const command=args=>spawnSync(process.execPath,[${JSON.stringify(WF)},...args,'--attempt',${JSON.stringify(p.id)},'--json'],{cwd:${JSON.stringify(p.root)},env:process.env,encoding:'utf8'});
if(bundle.reviewGroup?.mode==='integration'){
 const reports=command(['review','parts']);if(reports.status!==0){console.error(reports.stderr);process.exit(1);}
 closure.partReviews=JSON.parse(reports.stdout).map(r=>({agent:r.agent,sha256:r.sha256,evidence:'producer and consumer independently checked'}));
 closure.interfacesReviewed=bundle.division.integration.interfaces.map(i=>({id:i.id,evidence:i.files.join('; ')+':1 checked'}));
}
if(bundle.reviewGroup?.mode!=='scoped'){
 closure.criteria=[{id:'C1',evidence:{kind:'output',ref:'fixture output'}}];
 closure.impactChecked={queries:Object.entries(bundle.impactMap.queries).map(([query,q])=>({query,hits:q.hits})),sampled:bundle.impactMap.inventory.map(entry=>({entry,verdict:'matches',evidence:'source checked'})),derived:[]};
}
fs.writeFileSync(bundle.reviewClosureFile,JSON.stringify(closure));
const result=command(['review','--closure',bundle.reviewClosureFile]);if(result.status!==0){console.error(result.stderr);process.exit(1);}
fs.writeFileSync(trace,JSON.stringify({start,end:Date.now(),mode:bundle.reviewGroup?.mode??'single'}));
console.log(JSON.stringify({type:'turn.completed'}));
`;
  write(bin, 'codex', script); fs.chmodSync(path.join(bin, 'codex'), 0o755);
  if (launch === 'handoff') ok(wf(p.root, ['handoff', 'reviewer', '--agent', 'native', '--attempt', p.id, '--json'], { env: { CODEX_THREAD_ID: state(p.root, p.id).owner.slice('codex:'.length) } }));
  const env = { CODEX_THREAD_ID: state(p.root, p.id).owner.split(':').slice(1).join(':'), WF_HOME: host, PATH: bin + path.delimiter + process.env.PATH };
  const args = launch === 'handoff' ? ['handoff', 'run', '--agent', 'native'] : ['advance', '--once', ...(launch === 'single' ? ['--single'] : [])];
  const result = ok(wf(p.root, [...args, '--attempt', p.id, '--json'], { env })).json();
  assert.deepEqual(result.operations.map(o => o.kind), launch === 'single' ? ['code-review'] : ['scoped-review', 'scoped-review', 'code-review']);
  const s = state(p.root, p.id);
  const reviewers = s.handoffs.filter(h => h.role === 'reviewer');
  assert.equal(reviewers.length, launch === 'single' ? 1 : 3);
  const traces = reviewers.map(m => JSON.parse(fs.readFileSync(path.join(p.base, `trace-${m.agent}.json`))));
  if (launch === 'single') assert.equal(traces[0].mode, 'single');
  else {
    assert.ok(Math.max(traces[0].start, traces[1].start) < Math.min(traces[0].end, traces[1].end), 'scoped runtime lifetimes must overlap');
    assert.ok(traces[2].start >= Math.max(traces[0].end, traces[1].end), 'integration follows completed scoped reports');
  }
  assert.equal(s.review.provenance, 'engine-launched');
  assert.equal(s.reviewParts.length, launch === 'single' ? 0 : 2); assert.ok(s.reviewParts.every(part => part.provenance === 'engine-launched' && part.session));
  assert.equal(s.gates.length, 0); assert.equal(s.next.includes('gate'), true);
  ok(wf(p.root, ['verify', '--attempt', p.id]));
});
