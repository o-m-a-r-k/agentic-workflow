// Named failures: serialized independent flows; file splits hid shared contracts; partial reviews authorized gates.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { changedInventory, divideReview, impactCatalog, isCurrentReviewer, validateDivision } from '../engine/review-groups.mjs';
import { transactionSeams, withEvidenceTransaction } from '../engine/evidence.mjs';
import { closureFile, commitIn, goodClosure, impactCheckedFrom, ok, singleRepoProject, state, wf, WF, write } from './helpers.mjs';

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

function ready() {
  const { files } = flowInput();
  const p = singleRepoProject('parallel-review', { classes: { review: { codex: { model: 'future-model', effort: 'high' } } }, gate: { steps: [] } }, files);
  const e = ok(wf(p.root, ['entry', '--lane', 'quick', '--json'])).json();
  const queries = ['alpha', 'beta'].map(id => ({ id, pattern: id, kind: 'literal', paths: ['alpha/**', 'beta/**', 'shared.ts'], hits: 25 }));
  const doc = { survey: { queries, patterns: [{ id: 'P', query: 'alpha', hits: 25 }] },
    criteria: [{ id: 'C1', text: 'flows remain coherent' }], plan: { anchors: ['src/a.txt'], tests: { run: ['flow-test'] } }, impact: { changes: queries.map(q => ({ id: q.id, element: q.id, kind: 'symbol', cites: ['C1'], covers: ['P'],
      consumers: { query: q.id, hits: 25 }, flows: [{ flow: `use ${q.id}`, failure: 'retry', query: q.id, hits: 25 }], contracts: [], suites: [{ suite: 'flow-test', query: q.id, hits: 25 }] })) } };
  const planFile = closureFile(p.base, doc);
  ok(wf(p.root, ['plan', '--file', planFile, '--attempt', e.id]));
  ok(wf(p.root, ['handoff', 'implementer', '--agent', 'impl', '--attempt', e.id]));
  commitIn(e.repos.app.worktree, Object.fromEntries(Object.entries(files).map(([file, text]) => [file, text + 'changed\n'])));
  const h = ok(wf(p.root, ['handoff', 'reviewer', '--agent', 'integration', '--parallel', '--attempt', e.id, '--json'])).json();
  assert.equal(h.members?.length, 3, 'separable large change must create two scopes and integration');
  return { ...p, id: e.id, wt: e.repos.app.worktree, h };
}

const evidenceRows = files => files.map(file => ({ file, evidence: `${file}:1 behavior and failure path inspected` }));
function partClosure(p, member, findings = []) {
  const b = JSON.parse(fs.readFileSync(member.bundle));
  return { reviewer: member.agent, findings, criteria: [], filesReviewed: evidenceRows(b.primaryFiles),
    outsidePlan: (b.outsidePlan ?? []).map(file => ({ file, verdict: 'covered', by: 'C1', evidence: `${file}:1 flow requirement` })), designHits: [], rules: [] };
}
function integrationClosure(p) {
  const b = JSON.parse(fs.readFileSync(p.h.bundle)), reports = ok(wf(p.root, ['review', 'parts', '--attempt', p.id, '--json'])).json();
  return goodClosure(p.h.agent, { filesReviewed: evidenceRows(b.primaryFiles),
    interfacesReviewed: b.division.integration.interfaces.map(i => ({ id: i.id, evidence: i.files.join('; ') + ':1 checked producer/consumer behavior' })),
    partReviews: reports.map(r => ({ agent: r.agent, sha256: r.sha256, evidence: 'source/test boundaries independently verified' })),
    outsidePlan: (b.outsidePlan ?? []).filter(f => b.primaryFiles.includes(f)).map(file => ({ file, verdict: 'covered', by: 'C1', evidence: `${file}:1` })),
    impactChecked: impactCheckedFrom(b), designHits: [], rules: [] });
}

test('parallel parts never complete review; missing evidence/reports/interfaces refuse and the combined round unlocks one gate', () => {
  const p = ready();
  const [first, second] = p.h.members;
  const closure = partClosure(p, first), incomplete = { ...closure, filesReviewed: closure.filesReviewed.slice(1) };
  assert.match(wf(p.root, ['review', '--closure', closureFile(p.base, incomplete), '--attempt', p.id]).err, /missing direct/);
  ok(wf(p.root, ['review', '--closure', closureFile(p.base, closure), '--attempt', p.id]));
  assert.equal(state(p.root, p.id).review, null);
  assert.equal(wf(p.root, ['gate', '--attempt', p.id]).code, 75);
  assert.equal(wf(p.root, ['review', 'parts', '--attempt', p.id]).code, 75);
  assert.equal(wf(p.root, ['review', '--closure', closureFile(p.base, closure), '--attempt', p.id]).code, 75, 'parts cannot be rewritten');
  ok(wf(p.root, ['review', '--closure', closureFile(p.base, partClosure(p, second)), '--attempt', p.id]));
  const integrated = integrationClosure(p);
  assert.match(wf(p.root, ['review', '--closure', closureFile(p.base, { ...integrated, interfacesReviewed: [] }), '--attempt', p.id]).err, /every crossing interface/);
  const badHash = structuredClone(integrated); badHash.partReviews[0].sha256 = 'bad';
  assert.match(wf(p.root, ['review', '--closure', closureFile(p.base, badHash), '--attempt', p.id]).err, /exact recorded closure hash/);
  ok(wf(p.root, ['review', '--closure', closureFile(p.base, integrated), '--attempt', p.id]));
  assert.equal(state(p.root, p.id).review.closure.filesReviewed.length, 50);
  ok(wf(p.root, ['gate', '--attempt', p.id]));
  assert.equal(wf(p.root, ['accept', '--attempt', p.id]).code, 75, 'a fresh evidence review is still required');
  p.h = ok(wf(p.root, ['handoff', 'reviewer', '--agent', 'evidence', '--parallel', '--attempt', p.id, '--json'])).json();
  assert.equal(JSON.parse(fs.readFileSync(p.h.bundle)).round, 'evidence-review');
  for (const member of p.h.members.slice(0, 2)) ok(wf(p.root, ['review', '--closure', closureFile(p.base, partClosure(p, member)), '--attempt', p.id]));
  ok(wf(p.root, ['review', '--closure', closureFile(p.base, integrationClosure(p)), '--attempt', p.id]));
  ok(wf(p.root, ['accept', '--attempt', p.id]));
  ok(wf(p.root, ['verify', '--attempt', p.id]));
});

test('integration cannot omit a scoped finding; stale trees invalidate all scoped reports', () => {
  const p = ready();
  for (const [index, member] of p.h.members.slice(0, 2).entries()) {
    const findings = index ? [] : [{ id: 'F1', severity: 'major', summary: 'failure path loses data', status: 'open', evidence: 'alpha/0.ts:1' }];
    ok(wf(p.root, ['review', '--closure', closureFile(p.base, partClosure(p, member, findings)), '--attempt', p.id]));
  }
  const integrated = integrationClosure(p);
  ok(wf(p.root, ['review', '--closure', closureFile(p.base, integrated), '--attempt', p.id]));
  assert.ok(state(p.root, p.id).review.closure.findings.some(f => f.id === 'S1-F1'));
  assert.equal(wf(p.root, ['gate', '--attempt', p.id]).code, 75);
  commitIn(p.wt, { 'shared.ts': 'alpha beta changed again\n' });
  assert.match(wf(p.root, ['review', '--closure', closureFile(p.base, integrated), '--attempt', p.id]).err, /worktree changed/);
});

test('scoped reviewers cannot submit another assignment verdict or duplicate finding IDs', () => {
  const p = ready(), member = p.h.members[0], closure = partClosure(p, member);
  const other = partClosure(p, p.h.members[1]).outsidePlan[0];
  assert.match(wf(p.root, ['review', '--closure', closureFile(p.base, { ...closure, outsidePlan: [...closure.outsidePlan, other] }), '--attempt', p.id]).err, /another assignment/);
  const finding = { id: 'F1', evidence: 'alpha/0.ts:1', status: 'open' };
  assert.match(wf(p.root, ['review', '--closure', closureFile(p.base, { ...closure, findings: [finding, finding] }), '--attempt', p.id]).err, /unique non-empty IDs/);
});

test('evidence transaction rejects unsafe identities and control-path aliases before creating anything', () => {
  const p = singleRepoProject('transaction-path', { gate: { steps: [] } });
  assert.throws(() => withEvidenceTransaction(p.root, '../outside', () => {}), /invalid attempt|unsafe|must/);
  const alias = path.join(p.root, '.wf-worktrees'); fs.symlinkSync(p.base, alias);
  assert.throws(() => withEvidenceTransaction(p.root, 'ENG-1.1', () => {}), /control path/);
  assert.equal(fs.existsSync(path.join(p.base, 'ENG-1.1')), false);
});

test('evidence transactions tolerate release after collision and remain independent of runner links', () => {
  const p = singleRepoProject('transaction-release', { gate: { steps: [] } });
  const control = path.join(p.root, '.wf-worktrees', '_transactions');
  fs.mkdirSync(control, { recursive: true });
  const lock = path.join(control, 'ENG-1.1.lock');
  fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, token: 'owner' }));
  transactionSeams.afterCollision = file => fs.unlinkSync(file);
  try { assert.equal(withEvidenceTransaction(p.root, 'ENG-1.1', () => 'acquired'), 'acquired'); }
  finally { transactionSeams.afterCollision = null; }
  fs.mkdirSync(path.join(p.root, '.wf-worktrees', 'ENG-1.1'), { recursive: true });
  fs.symlinkSync(p.base, path.join(p.root, '.wf-worktrees', 'ENG-1.1', '_runner'));
  assert.equal(withEvidenceTransaction(p.root, 'ENG-1.1', () => 'readable'), 'readable');
  fs.symlinkSync(path.join(p.base, 'outside'), lock);
  assert.throws(() => withEvidenceTransaction(p.root, 'ENG-1.1', () => {}), /control path|unreadable/);
  assert.equal(fs.existsSync(path.join(p.base, 'outside')), false);
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

test('native foreground group runs scopes concurrently, verifies every transcript and then runs integration', () => {
  const p = ready(), bin = path.join(p.base, 'bin'), host = path.join(p.base, '.home');
  const script = `#!/usr/bin/env node
import fs from 'node:fs'; import path from 'node:path'; import {randomUUID} from 'node:crypto'; import {spawnSync} from 'node:child_process';
const prompt=fs.readFileSync(0,'utf8'),bundle=JSON.parse(fs.readFileSync(prompt.slice(5,-29),'utf8')),sid=randomUUID(),at=new Date().toISOString();
const transcript=path.join(${JSON.stringify(host)},'.codex','sessions','2026','10','11','rollout-'+sid+'.jsonl');
fs.mkdirSync(path.dirname(transcript),{recursive:true});
fs.writeFileSync(transcript,[{timestamp:at,type:'session_meta',payload:{id:sid,originator:'codex_exec',source:'exec'}},{timestamp:at,type:'response_item',payload:{type:'message',role:'user',content:[{type:'input_text',text:prompt}]}}].map(JSON.stringify).join('\\n')+'\\n');
console.log(JSON.stringify({type:'thread.started',thread_id:sid}));
const trace=path.join(${JSON.stringify(p.base)},'trace-'+bundle.agent+'.json'),start=Date.now();
await new Promise(r=>setTimeout(r,350));
const owned=new Set(bundle.primaryFiles),closure={reviewer:bundle.agent,findings:[],criteria:[],filesReviewed:bundle.primaryFiles.map(file=>({file,evidence:file+':1 checked'})),outsidePlan:(bundle.outsidePlan??[]).filter(file=>owned.has(file)).map(file=>({file,verdict:'covered',by:'C1',evidence:file+':1 checked'})),designHits:[],rules:[]};
const command=args=>spawnSync(process.execPath,[${JSON.stringify(WF)},...args,'--attempt',${JSON.stringify(p.id)},'--json'],{cwd:${JSON.stringify(p.root)},env:process.env,encoding:'utf8'});
if(bundle.reviewGroup.mode==='integration'){
 const reports=command(['review','parts']);if(reports.status!==0){console.error(reports.stderr);process.exit(1);}
 closure.partReviews=JSON.parse(reports.stdout).map(r=>({agent:r.agent,sha256:r.sha256,evidence:'producer and consumer independently checked'}));
 closure.interfacesReviewed=bundle.division.integration.interfaces.map(i=>({id:i.id,evidence:i.files.join('; ')+':1 checked'}));
 closure.criteria=[{id:'C1',evidence:{kind:'output',ref:'fixture output'}}];
 closure.impactChecked={queries:Object.entries(bundle.impactMap.queries).map(([query,q])=>({query,hits:q.hits})),sampled:bundle.impactMap.inventory.map(entry=>({entry,verdict:'matches',evidence:'source checked'})),derived:[]};
}
fs.writeFileSync(bundle.reviewClosureFile,JSON.stringify(closure));
const result=command(['review','--closure',bundle.reviewClosureFile]);if(result.status!==0){console.error(result.stderr);process.exit(1);}
fs.writeFileSync(trace,JSON.stringify({start,end:Date.now(),mode:bundle.reviewGroup.mode}));
console.log(JSON.stringify({type:'turn.completed'}));
`;
  write(bin, 'codex', script); fs.chmodSync(path.join(bin, 'codex'), 0o755);
  // The scenario handoff selected Claude; the native fixture replaces the group with fresh Codex reviewers.
  const h = ok(wf(p.root, ['handoff', 'reviewer', '--agent', 'native', '--parallel', '--runtime', 'codex', '--attempt', p.id, '--json'])).json();
  const env = { CODEX_THREAD_ID: state(p.root, p.id).owner.split(':').slice(1).join(':'), WF_HOME: host, PATH: bin + path.delimiter + process.env.PATH };
  const result = ok(wf(p.root, ['handoff', 'run', '--agent', 'native', '--attempt', p.id, '--json'], { env })).json();
  assert.deepEqual(result.operations.map(o => o.kind), ['scoped-review', 'scoped-review', 'code-review']);
  const traces = h.members.map(m => JSON.parse(fs.readFileSync(path.join(p.base, `trace-${m.agent}.json`))));
  assert.ok(Math.max(traces[0].start, traces[1].start) < Math.min(traces[0].end, traces[1].end), 'scoped runtime lifetimes must overlap');
  assert.ok(traces[2].start >= Math.max(traces[0].end, traces[1].end), 'integration follows completed scoped reports');
  const s = state(p.root, p.id);
  assert.equal(s.review.provenance, 'verified');
  assert.equal(s.reviewParts.length, 2); assert.ok(s.reviewParts.every(part => part.provenance === 'verified'));
  assert.equal(s.gates.length, 0); assert.equal(s.next.includes('gate'), true);
  ok(wf(p.root, ['verify', '--attempt', p.id]));
});
