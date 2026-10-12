// Named failure I-83: flow overlap was treated as an integration boundary before assigning reviewer groups.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { divideReview, reviewDivisionSummary, validateDivision } from '../engine/review-groups.mjs';

function overlappingFeatures({ hub = 0, unmapped = false } = {}) {
  const files = [], flows = [], results = {};
  const hubs = Array.from({ length: hub }, (_, i) => `app:hub/${i}.ts`);
  for (const feature of ['a', 'b', 'c']) {
    const common = Array.from({ length: 20 }, (_, i) => `app:${feature}/common/${i}.ts`);
    files.push(...common);
    for (const action of ['left', 'right']) {
      const id = `${feature}-${action}`, own = [0, 1].map(i => `app:${feature}/${action}/${i}.ts`);
      files.push(...own);
      flows.push({ id, query: id, flow: `perform ${id}`, failure: 'retain state and retry' });
      results[id] = { files: [...common, ...own, ...hubs] };
    }
  }
  files.push(...hubs);
  if (unmapped) files.push('app:unmapped.ts');
  return { bundle: { changed: { app: files.map(f => f.slice(4)) }, impactMap: { survey: { flows }, derived: { outside: [] } } }, results };
}

const grouped = () => ({ slices: ['a', 'b', 'c'].map(f => ({ flowIds: [`survey:${f}-left`, `survey:${f}-right`] })) });
const sizes = p => p.slices.map(s => s.files.length);

function denseAreas(count, sharedCount) {
  const shared = Array.from({ length: sharedCount }, (_, i) => `app:shared/${i}.ts`);
  const own = Array.from({ length: count }, (_, i) => `app:own/${i}.ts`);
  const flows = own.map((file, i) => ({ id: `flow-${i}`, query: `query-${i}`, flow: `action ${i}`, failure: 'retry' }));
  const results = Object.fromEntries(flows.map((flow, i) => [flow.query, { files: [...shared, own[i]] }]));
  return { bundle: { changed: { app: [...shared, ...own].map(f => f.slice(4)) }, impactMap: { survey: { flows } } }, results };
}

test('I-83 dense optimization exhaustion preserves the eligible balanced candidate and deterministic ownership', () => {
  const { bundle, results } = denseAreas(300, 23);
  const p = divideReview(bundle, results, { reviewers: 3 });
  assert.equal(p.mode, 'parallel');
  assert.equal(p.diagnostics.strategy, 'balanced');
  assert.equal(p.diagnostics.overlapOptimization.code, 'optimization-budget-exceeded');
  assert.equal(p.diagnostics.overlapOptimization.metric, 'pairContributions');
  assert.deepEqual(sizes(p), [100, 100, 100]);
  assert.equal(p.integration.files.length, 23);
  assert.equal(p.integration.interfaces.length, 300);
  validateDivision(p, bundle);
  assert.match(reviewDivisionSummary(p), /optimization-budget-exceeded.*balanced candidate retained/);
  bundle.changed.app.reverse(); bundle.impactMap.survey.flows.reverse();
  for (const result of Object.values(results)) result.files.reverse();
  assert.deepEqual(divideReview(bundle, results, { reviewers: 3 }), p);
});

test('I-83 exhausted optimization cannot relax the single-review efficiency fallback', () => {
  const { bundle, results } = denseAreas(300, 400);
  const p = divideReview(bundle, results, { reviewers: 3 });
  assert.equal(p.mode, 'single');
  assert.equal(p.diagnostics.strategy, 'balanced');
  assert.equal(p.diagnostics.reasonCode, 'integration-file-majority');
  assert.equal(p.diagnostics.overlapOptimization.code, 'optimization-budget-exceeded');
  assert.deepEqual(p.integration.files, p.files);
});

test('I-83 distinct-pair allocation is capped before searching a dense hub', () => {
  const { bundle, results } = denseAreas(708, 1);
  const p = divideReview(bundle, results, { reviewers: 3 });
  assert.equal(p.mode, 'parallel');
  assert.equal(p.diagnostics.strategy, 'balanced');
  assert.equal(p.diagnostics.overlapOptimization.metric, 'distinctPairs');
  assert.equal(p.diagnostics.overlapOptimization.value, 250001);
  assert.equal(p.integration.files.length, 1);
});

test('I-83 manual division does not invoke optional overlap optimization', () => {
  const { bundle, results } = denseAreas(300, 23);
  const division = { slices: [0, 1, 2].map(group => ({ flowIds: bundle.impactMap.survey.flows.filter((_, i) => i % 3 === group).map(flow => `survey:${flow.id}`) })) };
  const p = divideReview(bundle, results, { division });
  assert.equal(p.mode, 'parallel');
  assert.deepEqual(p.diagnostics.overlapOptimization, { status: 'manual' });
  assert.deepEqual(sizes(p), [100, 100, 100]);
});

test('I-83 automatic grouping retains overlapping actions within three complete feature scopes', () => {
  const { bundle, results } = overlappingFeatures();
  const p = divideReview(bundle, results, { reviewers: 3 });
  assert.equal(p.mode, 'parallel');
  assert.deepEqual(sizes(p), [24, 24, 24]);
  assert.deepEqual(p.integration.files, []);
  assert.deepEqual(p.integration.interfaces, []);
  for (const scope of p.slices) assert.equal(new Set(scope.flowIds.map(id => id.split(':')[1].split('-')[0])).size, 1);
  assert.equal(p.diagnostics.retainedOverlap.files, 60);
  assert.equal(p.diagnostics.overlapOptimization.status, 'complete');
});

test('I-83 manual feature grouping reclaims only dependencies internal to each assigned group', () => {
  const { bundle, results } = overlappingFeatures();
  const p = divideReview(bundle, results, { division: grouped() });
  assert.deepEqual(sizes(p), [24, 24, 24]);
  assert.deepEqual(p.integration.files, []);
  assert.equal(p.integration.interfaces.length, 0);
});

test('I-83 a real cross-scope hub and unmapped file stay integration-owned', () => {
  const { bundle, results } = overlappingFeatures({ hub: 1, unmapped: true });
  const p = divideReview(bundle, results, { reviewers: 3 });
  assert.equal(p.mode, 'parallel');
  assert.deepEqual(sizes(p), [24, 24, 24]);
  assert.deepEqual(p.integration.files, ['app:hub/0.ts', 'app:unmapped.ts']);
  assert.equal(p.integration.interfaces.length, 6);
  assert.ok(p.integration.interfaces.every(i => i.owners.includes('integration')));
  assert.equal(p.diagnostics.integration.crossScope.files, 1);
  assert.equal(p.diagnostics.integration.unmapped.files, 1);
});

test('I-83 unassigned overlapping actions keep their dependencies and interface checks with integration', () => {
  const { bundle, results } = overlappingFeatures(), division = grouped();
  division.slices[0].flowIds = ['survey:a-left'];
  const p = divideReview(bundle, results, { division });
  assert.deepEqual(sizes(p), [2, 24, 24]);
  assert.equal(p.integration.files.length, 22);
  assert.deepEqual(p.integration.interfaces.map(i => i.id), ['survey:a-left', 'survey:a-right']);
  assert.equal(p.diagnostics.integration.unassigned.files, 22);
  const missing = structuredClone(p);
  missing.integration.interfaces = missing.integration.interfaces.filter(i => i.id !== 'survey:a-right');
  assert.throws(() => validateDivision(missing, bundle), /integration check/);
});

test('I-83 inefficient explicit cross-feature grouping is preserved with an efficiency warning', () => {
  const { bundle, results } = overlappingFeatures();
  const division = { slices: [
    { flowIds: ['survey:a-left', 'survey:b-left'] },
    { flowIds: ['survey:a-right', 'survey:c-left'] },
    { flowIds: ['survey:b-right', 'survey:c-right'] },
  ] };
  const p = divideReview(bundle, results, { division });
  assert.deepEqual(sizes(p), [4, 4, 4]);
  assert.equal(p.integration.files.length, 60);
  assert.equal(p.integration.interfaces.length, 6);
  assert.ok(p.diagnostics.blockers.some(b => b.code === 'integration-file-majority'));
  assert.equal(p.diagnostics.manualEfficiencyWarning, true);
});

test('I-83 grouping can recover a feature whose individual areas have no exclusive files', () => {
  const all = Array.from({ length: 30 }, (_, i) => `app:a/${i}.ts`), other = all.map(f => f.replace('app:a/', 'app:b/'));
  const sets = { ab: all.slice(0, 20), bc: all.slice(10), ac: [...all.slice(0, 10), ...all.slice(20)], other };
  const bundle = { changed: { app: [...all, ...other].map(f => f.slice(4)) }, impactMap: { survey: { flows: Object.keys(sets).map(id => ({ id, query: id, flow: id, failure: 'retry' })) } } };
  const results = Object.fromEntries(Object.entries(sets).map(([id, files]) => [id, { files }]));
  const p = divideReview(bundle, results, { reviewers: 2 });
  assert.equal(p.mode, 'parallel');
  assert.deepEqual(sizes(p), [30, 30]);
  assert.equal(p.integration.files.length, 0);
});

test('I-83 genuinely dominant shared code still triggers the unchanged efficiency thresholds', () => {
  const { bundle, results } = overlappingFeatures({ hub: 80 });
  const p = divideReview(bundle, results, { reviewers: 3 });
  assert.equal(p.mode, 'single');
  assert.equal(p.diagnostics.integration.crossScope.files, 80);
  assert.ok(p.diagnostics.blockers.some(b => b.code === 'integration-file-majority'));
  assert.deepEqual(p.diagnostics.scopes.map(s => s.files), [24, 24, 24]);
});

test('I-83 identical broad flow sets remain indivisible without evaluating weights', () => {
  const { bundle, results } = overlappingFeatures();
  for (const value of Object.values(results)) value.files = bundle.changed.app.map(f => `app:${f}`);
  let calls = 0;
  const p = divideReview(bundle, results, { reviewers: 3, weights: () => { calls++; return {}; } });
  assert.equal(p.mode, 'single');
  assert.equal(calls, 0);
  assert.equal(p.diagnostics.reasonCode, 'insufficient-flow-areas');
});

test('I-83 changed consumers, contracts and suites retain ownership and unchanged context retains interfaces', () => {
  const { bundle, results } = overlappingFeatures();
  bundle.changed.api = ['producer.ts']; bundle.changed.portal = ['consumer.ts']; bundle.changed.tests = ['flow.spec.ts'];
  results.consumer = { files: ['portal:consumer.ts'] };
  results.contract = { files: ['api:producer.ts'] };
  results.suite = { files: ['tests:flow.spec.ts'] };
  results['a-left'].files.push('app:unchanged.ts');
  bundle.impactMap.impact = { changes: [{ id: 'a', consumers: { query: 'consumer' }, contracts: [{ query: 'contract' }], suites: [{ query: 'suite' }], flows: [{ query: 'a-left', flow: 'submit a', failure: 'retry' }] }] };
  const p = divideReview(bundle, results, { reviewers: 3 });
  const owner = p.slices.find(s => s.flowIds.includes('change:a:0'));
  for (const file of ['api:producer.ts', 'portal:consumer.ts', 'tests:flow.spec.ts']) assert.ok(owner.files.includes(file));
  assert.ok(p.integration.interfaces.some(i => i.id === 'change:a:0' && i.files.includes('app:unchanged.ts')));
  assert.ok(p.flows.find(f => f.id === 'change:a:0').queryOrigins.some(q => q.kind === 'suite' && q.id === 'suite'));
});

test('I-83 manual assignments reject unknown flows, duplicates, cross-scope aliases and empty ownership', () => {
  const { bundle, results } = overlappingFeatures();
  const unknown = grouped(); unknown.slices[0].flowIds.push('survey:unknown');
  assert.throws(() => divideReview(bundle, results, { division: unknown }), /unknown.*flow/);
  const duplicate = grouped(); duplicate.slices[0].flowIds.push('survey:a-left');
  assert.throws(() => divideReview(bundle, results, { division: duplicate }), /more than once|duplicate/);
  bundle.impactMap.survey.flows.push({ id: 'a-alias', query: 'a-left', flow: 'repeat a', failure: 'retry' });
  const alias = grouped(); alias.slices[1].flowIds.push('survey:a-alias');
  assert.throws(() => divideReview(bundle, results, { division: alias }), /multiply assigned/);
  bundle.impactMap.survey.flows.push({ id: 'a-subset', query: 'subset', flow: 'read subset', failure: 'retry' });
  results.subset = { files: ['app:a/common/0.ts'] };
  const empty = { slices: [{ flowIds: ['survey:a-subset'] }, { flowIds: bundle.impactMap.survey.flows.filter(f => f.id !== 'a-subset').map(f => `survey:${f.id}`) }] };
  assert.throws(() => divideReview(bundle, results, { division: empty }), /empty.*scope|scope.*no.*primary/);
});

test('I-83 ownership validation rejects missing files, duplicate ownership, misplaced hubs and missing interfaces', () => {
  const { bundle, results } = overlappingFeatures({ hub: 1, unmapped: true }), p = divideReview(bundle, results, { reviewers: 3 });
  const missing = structuredClone(p); missing.slices[0].files.pop();
  assert.throws(() => validateDivision(missing, bundle), /every changed file exactly once/);
  const duplicate = structuredClone(p); duplicate.slices[0].files.push(duplicate.slices[1].files[0]);
  assert.throws(() => validateDivision(duplicate, bundle), /every changed file exactly once/);
  const hub = structuredClone(p); hub.integration.files = hub.integration.files.filter(f => f !== 'app:hub/0.ts'); hub.slices[0].files.push('app:hub/0.ts');
  assert.throws(() => validateDivision(hub, bundle), /ownership|integration-owned/);
  const interfaceMissing = structuredClone(p); interfaceMissing.integration.interfaces.pop();
  assert.throws(() => validateDivision(interfaceMissing, bundle), /integration check/);
  const assignment = structuredClone(p); assignment.slices[1].flowIds.push(assignment.slices[0].flowIds[0]);
  assert.throws(() => validateDivision(assignment, bundle), /assigned|duplicate/);
});

test('I-83 automatic selection is deterministic under input order changes and loads weights once', () => {
  const { bundle, results } = overlappingFeatures({ hub: 1, unmapped: true });
  let reads = 0;
  const p = divideReview(bundle, results, { reviewers: 3, weights: () => { reads++; return {}; } });
  assert.equal(reads, 1);
  const reversed = structuredClone(bundle); reversed.changed.app.reverse(); reversed.impactMap.survey.flows.reverse();
  const reverseResults = Object.fromEntries(Object.entries(results).reverse().map(([id, r]) => [id, { files: [...r.files].reverse() }]));
  assert.deepEqual(divideReview(reversed, reverseResults, { reviewers: 3 }), p);
});

test('I-83 new ownership validation preserves recorded version-one review assignments', () => {
  const { bundle, results } = overlappingFeatures(), p = divideReview(bundle, results, { division: grouped() });
  const legacy = structuredClone(p); legacy.version = 1;
  legacy.integration.files = legacy.files.filter(f => f.includes('/common/'));
  for (const scope of legacy.slices) scope.files = scope.files.filter(f => !legacy.integration.files.includes(f));
  legacy.integration.interfaces = legacy.flows.map(f => ({ id: f.id, files: f.context }));
  assert.equal(validateDivision(legacy, bundle), legacy);
});

test('I-83 integration shares equal to fifty percent pass while greater shares retain single review', () => {
  const { bundle, results } = overlappingFeatures({ hub: 72 });
  const equal = divideReview(bundle, results, { reviewers: 3 });
  assert.equal(equal.mode, 'parallel');
  assert.equal(equal.diagnostics.integration.files, 72);
  assert.equal(equal.diagnostics.changedFiles, 144);
  bundle.changed.app.push('unmapped.ts');
  const above = divideReview(bundle, results, { reviewers: 3 });
  assert.equal(above.mode, 'single');
  assert.ok(above.diagnostics.blockers.some(b => b.code === 'integration-file-majority'));
});

test('I-83 weighted integration shares retain the same strict fifty-percent boundary', () => {
  const { bundle, results } = overlappingFeatures({ hub: 1 });
  assert.equal(divideReview(bundle, results, { reviewers: 3, weights: { 'app:hub/0.ts': 72 } }).mode, 'parallel');
  const above = divideReview(bundle, results, { reviewers: 3, weights: { 'app:hub/0.ts': 73 } });
  assert.equal(above.mode, 'single');
  assert.equal(above.diagnostics.reasonCode, 'integration-cost-majority');
});

test('I-83 a scope at exactly eighty percent is refused and one just below is eligible', () => {
  const { bundle, results } = overlappingFeatures();
  assert.equal(divideReview(bundle, results, { reviewers: 3, weights: { 'app:a/common/0.ts': 168 } }).mode, 'parallel');
  const exact = divideReview(bundle, results, { reviewers: 3, weights: { 'app:a/common/0.ts': 169 } });
  assert.equal(exact.mode, 'single');
  assert.ok(exact.diagnostics.blockers.some(b => b.code === 'dominant-scope' && b.value === 192 && b.limit === 192));
});

test('I-83 the forty-file cutoff and small-change lazy cost behavior are unchanged', () => {
  const files = Array.from({ length: 40 }, (_, i) => `app:${i}.ts`);
  const bundle = { changed: { app: files.map(f => f.slice(4)) }, impactMap: { survey: { flows: ['a', 'b'].map(id => ({ id, query: id, flow: id, failure: 'retry' })) } } };
  const results = { a: { files: files.slice(0, 20) }, b: { files: files.slice(20) } };
  assert.equal(divideReview(bundle, results).mode, 'parallel');
  bundle.changed.app.pop(); let reads = 0;
  const p = divideReview(bundle, results, { weights: () => { reads++; return {}; } });
  assert.equal(p.mode, 'single'); assert.equal(reads, 0);
  assert.equal(p.diagnostics.reasonCode, 'below-minimum-files');
});
