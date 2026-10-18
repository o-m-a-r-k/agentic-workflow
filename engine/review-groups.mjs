// Named failure: large blind reviews serialized unrelated flows, while naive file splits lost shared contracts.
// This module proposes divisions from recorded end-to-end flows, never from filenames or implementer work items.
import { isDocumentationFile } from './impact.mjs';
import { reviewerDiscovered } from './review-policy.mjs';
import { canonical, git, hashValue, refuse } from './util.mjs';

const list = v => Array.isArray(v) ? v : [];
export const changedInventory = bundle => Object.entries(bundle.changed ?? {}).flatMap(([repo, files]) => files.map(file => `${repo}:${file}`)).sort();

// Named failure: ordinary handoffs serialized large separable reviews unless the owner remembered an opt-in flag.
export function reviewDivisionOptions(options) {
  for (const flag of ['parallel', 'single']) if (options[flag] !== undefined && options[flag] !== true) throw refuse(`--${flag} is a flag`);
  if (options.single && ['parallel', 'reviewers', 'division'].some(key => options[key] !== undefined)) throw refuse('--single cannot be combined with --parallel, --reviewers or --division');
  const reviewers = Number(options.reviewers ?? 2);
  if (!Number.isInteger(reviewers) || reviewers < 2 || reviewers > 3) throw refuse('parallel review uses two or three scoped reviewers plus one integration reviewer');
  return { enabled: options.single !== true, reviewers };
}

export function changedWeights(state, bundle) {
  const weights = {};
  for (const [repo, record] of Object.entries(state.repos)) {
    const raw = git(record.worktree, ['diff', '--numstat', '-z', '--no-renames', '--no-ext-diff', bundle.bases[repo], 'HEAD']);
    for (const row of raw.split('\0')) {
      const match = /^(\d+|-)\t(\d+|-)\t([\s\S]+)$/.exec(row);
      if (match) weights[`${repo}:${match[3]}`] = match[1] === '-' ? 100 : Math.max(1, Number(match[1]) + Number(match[2]));
    }
  }
  return weights;
}

export function reviewSnapshot(state) {
  return hashValue({ criteria: state.criteria, amendments: state.criteriaAmendments, plan: state.plan, work: state.work,
    impact: state.impact, discovered: reviewerDiscovered(state.discovered, state), addedRepos: state.addedRepos,
    adapterBase: state.adapterBase, runtimeAdapterBase: state.runtimeAdapterBase, gate: state.lastGate?.runId ?? null });
}

// Keep all versions in immutable history; the current catalog retains the latest recorded value of every entry ID.
export function impactCatalog(map) {
  const catalog = Object.fromEntries(['components', 'consumers', 'flows', 'patterns', 'changes'].map(k => [k, new Map()]));
  const add = (survey, changes) => {
    for (const k of ['components', 'consumers', 'flows', 'patterns']) for (const row of list(survey?.[k])) catalog[k].set(row.id, row);
    for (const row of list(changes)) catalog.changes.set(row.id, row);
  };
  add(map?.survey, map?.impact?.changes);
  for (const a of list(map?.addenda)) add(a.survey, a.changes);
  return Object.fromEntries(Object.entries(catalog).map(([k, values]) => [k, [...values.values()]]));
}

function normalizedAreas(flows) {
  const byQuery = new Map();
  for (const flow of [...flows].sort((a, b) => a.id.localeCompare(b.id))) {
    const key = flow.query ?? canonical(flow.files);
    if (!byQuery.has(key)) byQuery.set(key, { id: flow.id, flowIds: [], files: [], context: [] });
    const area = byQuery.get(key);
    area.flowIds.push(flow.id); area.files.push(...flow.files); area.context.push(...flow.context);
  }
  const byFiles = new Map();
  for (const area of byQuery.values()) {
    area.files = [...new Set(area.files)].sort();
    const key = canonical(area.files);
    if (!byFiles.has(key)) byFiles.set(key, { id: area.id, flowIds: [], files: area.files, context: [] });
    const combined = byFiles.get(key); combined.flowIds.push(...area.flowIds); combined.context.push(...area.context);
    combined.context = [...new Set(combined.context)].sort();
  }
  return [...byFiles.values()].map(area => ({ ...area, flowIds: area.flowIds.sort() })).sort((a, b) => a.id.localeCompare(b.id));
}

// Named failure I-83: overlap inside a reviewer group was incorrectly assigned to integration before grouping.
// Unassigned areas are integration owners too: grouping must never reclaim their dependencies.
function divisionOwnership(areas, bins, changed) {
  const assigned = new Map(bins.flatMap(bin => bin.areas.map(area => [area.id, bin.id])));
  const incidence = new Map();
  for (const area of areas) for (const file of area.files) {
    if (!incidence.has(file)) incidence.set(file, []);
    incidence.get(file).push(area);
  }
  const owners = new Map(), causes = new Map(), retained = [];
  for (const file of changed) {
    const mentions = incidence.get(file) ?? [], groups = new Set(mentions.map(area => assigned.get(area.id) ?? 'integration'));
    const owner = groups.size === 1 && !groups.has('integration') ? [...groups][0] : 'integration';
    owners.set(file, owner);
    if (!mentions.length) causes.set(file, 'unmapped');
    else if (owner === 'integration') causes.set(file, groups.has('integration') ? 'unassigned' : 'crossScope');
    else if (mentions.length > 1) retained.push(file);
  }
  return { owners, causes, retained, incidence,
    bins: bins.map(bin => ({ ...bin, files: changed.filter(file => owners.get(file) === bin.id) })),
    integration: changed.filter(file => owners.get(file) === 'integration') };
}

function balancedBins(clusters, reviewers, cost) {
  const bins = Array.from({ length: Math.min(reviewers, clusters.length) }, (_, i) => ({ id: `S${i + 1}`, areas: [], files: [] }));
  for (const cluster of [...clusters].sort((a, b) => cost(b.files) - cost(a.files) || a.id.localeCompare(b.id))) {
      bins.sort((a, b) => cost(a.files) - cost(b.files) || a.id.localeCompare(b.id));
      bins[0].areas.push(...cluster.areas);
      bins[0].files = [...new Set([...bins[0].files, ...cluster.files])].sort();
  }
  return bins.sort((a, b) => a.id.localeCompare(b.id));
}

// Cache weighted intersections and queue only overlapping pairs. Merges update affected neighbors instead of
// repeatedly scanning all area pairs. A ubiquitous helper does not force one connected component.
function overlapClusters(areas, reviewers, cost, weight) {
  const active = new Map(), incidence = new Map(), heap = [];
  // Named failure I-83: dense valid maps made an optional optimization allocate unbounded pairs and queues.
  // Exhaustion discards the entire search; the fully evaluated balanced division remains authoritative.
  const limits = { pairContributions: 1_000_000, distinctPairs: 250_000, queuedPairs: 500_000, neighborVisits: 1_000_000 };
  const counts = { pairContributions: 0, distinctPairs: 0, queuedPairs: 0, neighborVisits: 0 };
  const exhausted = metric => ({ clusters: null, diagnostics: { status: 'budget-exceeded', code: 'optimization-budget-exceeded', metric, value: counts[metric], limit: limits[metric] } });
  let sequence = 0;
  const better = (a, b) => a.score > b.score || (a.score === b.score && a.key.localeCompare(b.key) < 0);
  const push = value => {
    heap.push(value); let i = heap.length - 1;
    while (i) { const parent = (i - 1) >> 1; if (!better(heap[i], heap[parent])) break; [heap[i], heap[parent]] = [heap[parent], heap[i]]; i = parent; }
  };
  const pop = () => {
    const first = heap[0], last = heap.pop();
    if (heap.length) {
      heap[0] = last; let i = 0;
      for (;;) { const left = i * 2 + 1, right = left + 1; let next = i;
        if (left < heap.length && better(heap[left], heap[next])) next = left;
        if (right < heap.length && better(heap[right], heap[next])) next = right;
        if (next === i) break; [heap[i], heap[next]] = [heap[next], heap[i]]; i = next;
      }
    }
    return first;
  };
  const cluster = rows => {
    const files = [...new Set(rows.flatMap(area => area.files))].sort(), id = sequence++;
    const entry = { number: id, id: rows.map(area => area.id).sort().join('\0'), areas: rows, files, cost: cost(files) };
    active.set(id, entry);
    for (const file of files) { if (!incidence.has(file)) incidence.set(file, new Set()); incidence.get(file).add(id); }
    return entry;
  };
  for (const area of areas) cluster([area]);
  const pair = (a, b, intersection) => {
    if (++counts.queuedPairs > limits.queuedPairs) return false;
    push({ a: a.number, b: b.number, score: intersection / (a.cost + b.cost - intersection), key: canonical([a.id, b.id].sort()) });
    return true;
  };
  // Estimate the quadratic contribution count before constructing any pair map.
  for (const ids of incidence.values()) {
    counts.pairContributions += ids.size * (ids.size - 1) / 2;
    if (counts.pairContributions > limits.pairContributions) return exhausted('pairContributions');
  }
  const intersections = new Map();
  for (const [file, ids] of incidence) {
    const rows = [...ids];
    for (let i = 0; i < rows.length; i++) for (let j = i + 1; j < rows.length; j++) {
      const key = `${rows[i]},${rows[j]}`;
      if (!intersections.has(key) && ++counts.distinctPairs > limits.distinctPairs) return exhausted('distinctPairs');
      const entry = intersections.get(key) ?? { a: rows[i], b: rows[j], cost: 0 };
      entry.cost += weight(file); intersections.set(key, entry);
    }
  }
  for (const entry of intersections.values()) if (!pair(active.get(entry.a), active.get(entry.b), entry.cost)) return exhausted('queuedPairs');
  while (active.size > reviewers && heap.length) {
    const next = pop(), a = active.get(next.a), b = active.get(next.b);
    if (!a || !b) continue;
    active.delete(a.number); active.delete(b.number);
    for (const file of new Set([...a.files, ...b.files])) { incidence.get(file).delete(a.number); incidence.get(file).delete(b.number); }
    const merged = cluster([...a.areas, ...b.areas].sort((x, y) => x.id.localeCompare(y.id))), neighbors = new Map();
    for (const file of merged.files) for (const id of incidence.get(file)) {
      if (++counts.neighborVisits > limits.neighborVisits) return exhausted('neighborVisits');
      if (id !== merged.number) neighbors.set(id, (neighbors.get(id) ?? 0) + weight(file));
    }
    for (const [id, intersection] of neighbors) if (!pair(merged, active.get(id), intersection)) return exhausted('queuedPairs');
  }
  return { clusters: [...active.values()], diagnostics: { status: 'complete', ...counts } };
}

function integrationInterfaces(flows, changed, owners, bundle) {
  const changedSet = new Set(changed);
  const interfaces = flows.flatMap(flow => {
    const groups = [...new Set(flow.files.map(file => owners.get(file) ?? 'integration'))].sort();
    return groups.length > 1 || groups.includes('integration') || flow.context.some(file => !changedSet.has(file))
      ? [{ id: flow.id, flow: flow.flow, failure: flow.failure, files: flow.context, owners: groups }] : [];
  });
  for (const outside of bundle.impactMap?.derived?.outside ?? []) interfaces.push({ id: `derived:${outside.symbol}@${outside.file}`, files: [...new Set([outside.file, ...(outside.declarationOrigins ?? [outside.declaredIn]).filter(Boolean)])], textual: true, originAmbiguous: outside.originAmbiguous ?? false });
  return interfaces;
}

// Named failure (I-96): 12 documentation files of 500 lines in a 48-file change of two separable flows were read as product
// code: they were unmapped by every flow, so they became integration work (cost 6000 of 12000, over the 3048 threshold) and
// the division fell back to one reviewer; ten such files already did, and 49 also tripped the file-count threshold.
// Documentation and provenance files (`isDocumentationFile`, and the adapter's package `docsOnly` files when the caller
// passes `documentation: (repo, file) => boolean`) stay with the integration reviewer, who is handed every changed file, but
// they are not product code: the 40-file threshold, the cost, the unmapped count and the flows leave them out, and the
// plan lists them under `documentation`.
const splitDocumentation = (inventory, documentation) => {
  const isDoc = qualified => {
    const at = qualified.indexOf(':');
    return isDocumentationFile(qualified.slice(at + 1)) || Boolean(documentation?.(qualified.slice(0, at), qualified.slice(at + 1)));
  };
  return { documentation: inventory.filter(isDoc), product: inventory.filter(file => !isDoc(file)) };
};

export function divideReview(bundle, results, { reviewers = 2, minimumFiles = 40, division = null, weights = {}, documentation: isDocumentation = null } = {}) {
  if (!Number.isInteger(reviewers) || reviewers < 2 || reviewers > 3) throw refuse('parallel review uses two or three scoped reviewers plus one integration reviewer');
  const everyFile = changedInventory(bundle), changedSet = new Set(everyFile), catalog = impactCatalog(bundle.impactMap), flows = [];
  const { documentation, product: changed } = splitDocumentation(everyFile, isDocumentation), documentationSet = new Set(documentation);
  const addFlow = (id, row, extras = []) => {
    if (!row?.flow || !row?.failure) return;
    const queryOrigins = [{ id: row.query, kind: 'flow' }, ...extras].filter(q => q.id).sort((a, b) => a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id));
    const queries = [...new Set(queryOrigins.map(q => q.id))].sort(), context = [...new Set(queries.flatMap(q => results[q]?.files ?? []))].sort();
    const files = context.filter(file => changedSet.has(file) && !documentationSet.has(file));
    if (files.length) flows.push({ id, flow: row.flow, failure: row.failure, query: row.query, queries, queryOrigins, files, context });
  };
  for (const row of catalog.flows) addFlow(`survey:${row.id}`, row);
  for (const row of catalog.changes) for (const [i, flow] of list(row.flows).entries()) addFlow(`change:${row.id}:${i}`, flow,
    [{ id: row.consumers?.query, kind: 'consumer' }, ...list(row.contracts).map(c => ({ id: c.query, kind: 'contract' })), ...list(row.suites).map(s => ({ id: s.query, kind: 'suite' }))]);
  flows.sort((a, b) => a.id.localeCompare(b.id));
  const areas = normalizedAreas(flows);
  let measuredWeights;
  const cachedWeights = new Map();
  const weight = file => {
    measuredWeights ??= typeof weights === 'function' ? weights() : weights;
    if (!cachedWeights.has(file)) { const value = Number(measuredWeights[file]); cachedWeights.set(file, Number.isFinite(value) ? Math.max(1, value || 1) : 1); }
    return cachedWeights.get(file);
  };
  const cost = files => { let total = 0; for (const file of files) total += weight(file); return total; };
  const thresholds = { minimumFiles, integrationShare: 0.5, dominantScopeShare: 0.8 };
  const single = (reason, diagnostics) => ({ version: 2, mode: 'single', reason, files: everyFile, documentation, flows, slices: [], integration: { files: everyFile, interfaces: [] }, diagnostics });
  const early = (reasonCode, reason) => single(reason, { reasonCode, changedFiles: changed.length, documentationFiles: documentation.length, areas: areas.length, thresholds, scopes: [], integration: null, blockers: [] });
  // Preserve the lazy scan: small or indivisible changes never pay for Git weight discovery.
  if (!division && changed.length < minimumFiles) return early('below-minimum-files', `only ${changed.length} changed ${documentation.length ? 'product ' : ''}files; retain one reviewer below ${minimumFiles}`);
  if (areas.length < 2) {
    if (division) throw refuse('recorded flows do not provide two separable review areas; retain a single reviewer');
    return early('insufficient-flow-areas', 'recorded flows are missing or form fewer than two distinct areas');
  }
  const evaluate = (bins, strategy) => {
    let ownership = divisionOwnership(areas, bins, changed);
    if (!division && ownership.bins.some(bin => !bin.files.length)) {
      bins = ownership.bins.filter(bin => bin.files.length).map((bin, i) => ({ ...bin, id: `S${i + 1}` }));
      ownership = divisionOwnership(areas, bins, changed);
    }
    if (division && ownership.bins.some(bin => !bin.files.length)) throw refuse(`manual review scope ${ownership.bins.find(bin => !bin.files.length).id} has no primary files (empty scope); regroup complete flows`);
    const scopes = ownership.bins.map(bin => ({ id: bin.id, files: bin.files.length, cost: cost(bin.files) }));
    const total = cost(changed), integrationCost = cost(ownership.integration), largest = Math.max(0, ...scopes.map(scope => scope.cost));
    const blockers = [];
    if (scopes.length < 2) blockers.push({ code: 'insufficient-nonempty-scopes', value: scopes.length, limit: 2 });
    if (ownership.integration.length > changed.length / 2) blockers.push({ code: 'integration-file-majority', value: ownership.integration.length, limit: changed.length / 2 });
    if (integrationCost > total / 2) blockers.push({ code: 'integration-cost-majority', value: integrationCost, limit: total / 2 });
    if (largest >= total * 0.8) blockers.push({ code: 'dominant-scope', value: largest, limit: total * 0.8 });
    const integration = { files: ownership.integration.length, cost: integrationCost };
    for (const cause of ['unmapped', 'unassigned', 'crossScope']) {
      const files = ownership.integration.filter(file => ownership.causes.get(file) === cause);
      integration[cause] = { files: files.length, cost: cost(files) };
    }
    const overlapExamples = [...ownership.incidence].filter(([, rows]) => rows.length > 1).slice(0, 5).map(([file, rows]) => ({ file,
      owner: ownership.owners.get(file), areas: rows.slice(0, 8).map(area => ({ id: area.id, queries: flows.filter(flow => area.flowIds.includes(flow.id)).flatMap(flow => flow.queryOrigins).slice(0, 6) })) }));
    return { ownership, score: integrationCost + largest, diagnostics: { reasonCode: blockers[0]?.code ?? 'parallel', strategy,
      changedFiles: changed.length, documentationFiles: documentation.length, totalCost: total, areas: areas.length, thresholds, scopes, integration, blockers,
      retainedOverlap: { files: ownership.retained.length, cost: cost(ownership.retained) }, overlapExamples,
      manualEfficiencyWarning: Boolean(division && blockers.length) } };
  };
  let candidate, overlapOptimization = { status: division ? 'manual' : 'not-needed' };
  if (division) {
    if (!Array.isArray(division.slices) || division.slices.length < 2 || division.slices.length > 3) throw refuse('division needs two or three slices, each naming recorded flowIds');
    const assigned = new Map(), byId = new Map(areas.flatMap(area => area.flowIds.map(id => [id, area])));
    const bins = division.slices.map((slice, index) => {
      if (!Array.isArray(slice.flowIds) || !slice.flowIds.length) throw refuse('each slice needs non-empty flowIds; arbitrary file lists cannot divide a review');
      if (new Set(slice.flowIds).size !== slice.flowIds.length) throw refuse('a slice lists a flow more than once');
      const selected = [...new Set(slice.flowIds.map(id => {
        const area = byId.get(id);
        if (!area) throw refuse(`unknown recorded flow ${id}`);
        if (assigned.has(area.id) && assigned.get(area.id) !== index) throw refuse(`multiply assigned normalized flow ${id}`);
        assigned.set(area.id, index); return area;
      }))];
      return { id: `S${index + 1}`, areas: selected };
    });
    candidate = evaluate(bins, 'manual');
  } else {
    candidate = evaluate(balancedBins(areas.map(area => ({ ...area, areas: [area] })), reviewers, cost), 'balanced');
    if (candidate.diagnostics.blockers.length || (areas.length > reviewers && candidate.diagnostics.integration.crossScope.files)) {
      const search = overlapClusters(areas, reviewers, cost, weight);
      overlapOptimization = search.diagnostics;
      if (search.clusters) {
        const overlap = evaluate(balancedBins(search.clusters, reviewers, cost), 'overlap-aware');
        const eligible = !candidate.diagnostics.blockers.length, overlapEligible = !overlap.diagnostics.blockers.length;
        if ((overlapEligible && !eligible) || (overlapEligible === eligible && overlap.score < candidate.score)) candidate = overlap;
      }
    }
    candidate.diagnostics.overlapOptimization = overlapOptimization;
    if (candidate.diagnostics.blockers.length) return single(`parallel efficiency checks refused: ${candidate.diagnostics.blockers.map(b => `${b.code} (${b.value}, threshold ${b.limit})`).join('; ')}`, candidate.diagnostics);
  }
  const { ownership, diagnostics } = candidate;
  diagnostics.overlapOptimization = overlapOptimization;
  const plan = { version: 2, mode: 'parallel', reason: 'complete flows are grouped before ownership; cross-scope, unassigned and unmapped code belongs to integration', files: everyFile, documentation,
    costBasis: 'changed lines (binary: 100); estimate, not measured review time; documentation files are handed to integration and not counted', diagnostics,
    slices: ownership.bins.map(bin => ({ id: bin.id, files: bin.files, estimatedCost: cost(bin.files), flowIds: bin.areas.flatMap(area => area.flowIds).sort(), context: [...new Set(bin.areas.flatMap(area => area.context))].sort() })),
    flows, integration: { files: [...ownership.integration, ...documentation].sort(), estimatedCost: cost(ownership.integration), interfaces: integrationInterfaces(flows, everyFile, ownership.owners, bundle) } };
  validateDivision(plan, bundle);
  return plan;
}

export function validateDivision(plan, bundle) {
  const expected = changedInventory(bundle), owned = [...plan.slices.flatMap(s => s.files), ...plan.integration.files].sort();
  if (canonical(expected) !== canonical(owned)) throw refuse('review division must own every changed file exactly once');
  // Frozen version-one assignments retain their original checks. New handoffs cannot opt out of version two.
  if (plan.version === 2) {
    if (plan.slices.length < 2 || plan.slices.length > 3 || new Set(plan.slices.map(s => s.id)).size !== plan.slices.length || plan.slices.some(s => !/^S[1-3]$/.test(s.id) || !s.files.length)) throw refuse('review division needs two or three unique nonempty scopes');
    if (new Set(plan.flows.map(f => f.id)).size !== plan.flows.length || plan.flows.some(f => f.files.some(file => !expected.includes(file)))) throw refuse('review flow inventory contains duplicate IDs or unknown changed files');
    // Documentation files (I-96) belong to the integration reviewer, outside the ownership the flows decide; a plan from before
    // 0.7.4 lists none.
    const documentation = new Set(plan.documentation ?? []);
    if ([...documentation].some(file => !expected.includes(file) || !plan.integration.files.includes(file))) throw refuse('review division lists a documentation file that is not a changed file owned by integration');
    const product = expected.filter(file => !documentation.has(file));
    const areas = normalizedAreas(plan.flows), byId = new Map(areas.flatMap(area => area.flowIds.map(id => [id, area]))), assignments = new Map(), seen = new Set();
    const bins = plan.slices.map(scope => ({ id: scope.id, areas: [...new Set(scope.flowIds.map(id => {
      if (!byId.has(id) || seen.has(id)) throw refuse(`unknown or duplicate assigned flow ${id}`);
      seen.add(id); const area = byId.get(id);
      if (assignments.has(area.id) && assignments.get(area.id) !== scope.id) throw refuse(`normalized flow aliases are multiply assigned: ${id}`);
      assignments.set(area.id, scope.id); return area;
    }))] }));
    for (const area of areas) if (assignments.has(area.id) && area.flowIds.some(id => !seen.has(id))) throw refuse(`normalized flow aliases must be assigned together: ${area.id}`);
    const ownership = divisionOwnership(areas, bins, product);
    for (const scope of plan.slices) if (canonical([...scope.files].sort()) !== canonical(ownership.bins.find(bin => bin.id === scope.id).files)) throw refuse(`scope ${scope.id} violates group-based file ownership; cross-scope and unassigned dependencies are integration-owned`);
    if (canonical([...plan.integration.files].sort()) !== canonical([...ownership.integration, ...documentation].sort())) throw refuse('integration file ownership does not match recorded flow assignments');
    const required = integrationInterfaces(plan.flows, expected, ownership.owners, bundle), actual = new Map();
    for (const entry of plan.integration.interfaces) { if (actual.has(entry.id)) throw refuse(`duplicate integration check ${entry.id}`); actual.set(entry.id, entry); }
    for (const entry of required) {
      const check = actual.get(entry.id);
      if (!check) throw refuse(`flow ${entry.id} has no integration check`);
      if (canonical([...check.files].sort()) !== canonical([...entry.files].sort()) || (entry.owners && canonical(check.owners) !== canonical(entry.owners))) throw refuse(`integration check ${entry.id} must retain every side of the interface`);
    }
    if (actual.size !== required.length) throw refuse('review division has an unknown or unnecessary integration check');
    return plan;
  }
  if (plan.version !== 1) throw refuse('unknown review division version');
  for (const flow of plan.flows) {
    const owners = new Set(flow.files.map(file => plan.slices.find(s => s.files.includes(file))?.id ?? 'integration'));
    if (owners.size > 1 && !plan.integration.interfaces.some(i => i.id === flow.id)) throw refuse(`crossing flow ${flow.id} has no integration check`);
  }
  return plan;
}

export function reviewDivisionSummary(plan) {
  const d = plan.diagnostics;
  if (!d) return '';
  const lines = [`  division reason: ${d.reasonCode}; ${d.changedFiles} changed files${d.documentationFiles ? ` (${d.documentationFiles} documentation files more, handed to integration and outside the estimate)` : ''}, ${d.areas} normalized areas`];
  if (d.overlapOptimization?.status === 'budget-exceeded') lines.push(`  optimization-budget-exceeded: ${d.overlapOptimization.metric}, observed ${d.overlapOptimization.value}, limit ${d.overlapOptimization.limit}; balanced candidate retained`);
  if (d.integration) {
    lines.push(`  workload estimate: ${d.scopes.map(s => `${s.id} ${s.files} files/${s.cost} changed-line cost`).join('; ')}; integration ${d.integration.files} files/${d.integration.cost} cost`);
    lines.push(`  integration causes: unmapped ${d.integration.unmapped.files}, unassigned ${d.integration.unassigned.files}, cross-scope shared ${d.integration.crossScope.files}; retained within scopes ${d.retainedOverlap.files}`);
    for (const blocker of d.blockers) lines.push(`  efficiency threshold: ${blocker.code}, observed ${blocker.value}, limit ${blocker.limit}`);
    if (d.manualEfficiencyWarning) lines.push('  warning: manual division retains an inefficient split; coverage and interface checks remain mandatory');
  }
  return lines.join('\n') + '\n';
}

export function isCurrentReviewer(state, h) {
  const latest = state.handoffs.filter(x => x.role === 'reviewer').at(-1);
  if (!latest?.reviewGroup) return latest?.bundle === h.bundle;
  const expected = latest.reviewGroup.members ?? [];
  const members = state.handoffs.filter(x => x.reviewGroup?.id === latest.reviewGroup.id);
  return Boolean(h.reviewGroup && latest.reviewGroup.slot === 'integration' && latest.reviewGroup.id === h.reviewGroup.id &&
    expected.includes(h.agent) && members.length === expected.length && new Set(members.map(x => x.agent)).size === expected.length &&
    members.every(x => expected.includes(x.agent) && x.reviewGroup.snapshot === latest.reviewGroup.snapshot));
}

export function currentReviewGroup(state) {
  const latest = state.handoffs.filter(h => h.role === 'reviewer').at(-1);
  if (!latest?.reviewGroup) return null;
  return { id: latest.reviewGroup.id, integration: latest, members: state.handoffs.filter(h => h.reviewGroup?.id === latest.reviewGroup.id) };
}

// 0.7.32 (D76). Named failure (field): the integration reviewer of a divided review waited for parts that would never come, a
// scoped member's launch having ended without recording one: `wf review parts` said only that the reports were incomplete, 169
// times over 89 minutes, then nothing happened for six hours. 0.7.28 (I-211) covered a group none of whose members was launched.
// The scoped members whose part will never come: a launch recorded failed (a crash, an interrupt, the owner's stop; not one the
// model's capacity stopped, which `wf handoff run` resumes in its own session) or a process that ended without recording a part.
// Their group can never be integrated: a fresh group is the way on.
export function stalledMembers(state, group) {
  const parts = state.reviewParts ?? [];
  return group.members
    .filter(h => h.reviewGroup.slot !== 'integration' && h.launch && !parts.some(p => p.handoff === h.bundle))
    .filter(h => h.launch.status === 'completed' || (h.launch.status === 'failed' && !(h.launch.failure?.kind === 'capacity' && !h.launch.settled)))
    .map(h => ({ agent: h.agent, slot: h.reviewGroup.slot, why: h.launch.status === 'completed' ? 'its process ended without recording a part' : h.launch.failure?.kind === 'stopped' ? 'it was stopped' : 'its launch failed' }));
}

const andList = xs => (xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}`);
export const stalledText = stalled => andList(stalled.map(m => `${m.agent} (${m.slot}: ${m.why})`));

// What a scoped member that has no part yet is doing, for the integration reviewer that waits for it.
export const waitingText = (h) => `${h.agent} (${h.reviewGroup.slot}): ${!h.launch ? 'not launched' : h.launch.status === 'failed' && h.launch.failure?.kind === 'capacity' ? 'stopped at the model\'s capacity, to be resumed by the owner' : h.launch.status}`;

// The owner's way on from a group that cannot finish: stop what of it still runs (its integration reviewer first), then a fresh group.
export function stalledGroupStep(state, group, stalled) {
  const running = group.members.filter(h => h.reviewGroup.slot !== 'integration' && ['starting', 'running'].includes(h.launch?.status));
  const integration = group.integration.agent;
  return `review group ${group.id} cannot finish: no part will come from ${stalledText(stalled)}; stop its integration reviewer ${integration} (\`wf handoff stop --agent ${integration} --attempt ${state.id}\`; one started outside \`wf handoff run\` is stopped where it runs)${running.length ? ` and its scoped reviewers still running (${running.map(h => `\`wf handoff stop --agent ${h.agent} --attempt ${state.id}\``).join(', ')})` : ''}, then hand a fresh divided review: \`wf handoff reviewer --agent <new id> --attempt ${state.id}\`, started only with the \`wf handoff run\` line it prints; no gate until an integration records the complete review`;
}

// `repeats`: a row may name an id more than once (0.7.29, I-154: a criterion several artifacts prove has one evidence entry each).
export function assignedVerdicts(expected, rows, key, label, { repeats = false } = {}) {
  const ids = new Set(expected), seen = new Set();
  for (const row of list(rows)) {
    if (!ids.has(row?.[key]) || (seen.has(row[key]) && !repeats)) throw refuse(`${label}: verdict is duplicate or belongs to another assignment: ${row?.[key]}`);
    seen.add(row[key]);
  }
  if (seen.size !== ids.size) throw refuse(`${label}: every assigned verdict is required`);
}

export function findingIds(closure) {
  const ids = list(closure.findings).map(f => f?.id);
  if (ids.some(id => typeof id !== 'string' || !id.trim() || id.includes(':')) || new Set(ids).size !== ids.length) throw refuse('group findings need unique non-empty IDs without colons');
}

export function mergeParts(group, parts, input) {
  const required = group.members.filter(h => h.reviewGroup.slot !== 'integration');
  const result = structuredClone(input);
  const merged = [], outside = [], hits = [], files = [];
  for (const h of required) {
    const part = parts.filter(p => p.handoff === h.bundle).at(-1);
    if (!part) throw refuse(`review group is incomplete: ${h.agent} has no recorded scoped closure`);
    const names = new Map(part.closure.findings.map(f => [f.id, `${h.reviewGroup.slot}-${f.id}`]));
    const rename = value => {
      if (Array.isArray(value)) return value.map(rename);
      if (!value || typeof value !== 'object') return value;
      return Object.fromEntries(Object.entries(value).map(([key, v]) => [key, (key === 'finding' || (key === 'by' && value.verdict === 'finding')) && names.has(v) ? names.get(v) : rename(v)]));
    };
    merged.push(...part.closure.findings.map(f => ({ ...rename(f), id: names.get(f.id), sourceReviewer: h.agent })));
    outside.push(...rename(part.closure.outsidePlan ?? []));
    hits.push(...rename(part.closure.designHits ?? []));
    files.push(...list(part.closure.filesReviewed));
  }
  const ownIds = new Set(result.findings.map(f => f.id));
  if (merged.some(f => ownIds.has(f.id))) throw refuse('integration finding ID collides with a scoped finding');
  result.findings.push(...merged);
  result.outsidePlan = [...(result.outsidePlan ?? []), ...outside];
  result.designHits = [...(result.designHits ?? []), ...hits];
  if (files.length || result.filesReviewed) result.filesReviewed = [...list(result.filesReviewed), ...files];
  return result;
}

export const GROUP_INSTRUCTIONS = `This review is divided by the change's recorded flows so it finishes sooner; reviewGroup.mode says your part. Every reviewer uses the frozen reviewer class, reads the shared rules and skills, and may inspect any source and report any defect it finds.
Scoped reviewer. Your goal: the truth about your assigned flows, the files in primaryFiles with their unchanged consumers and failure paths. Never judge a producer without its consumer: follow a seam into division.integration.interfaces when it crosses. Record your findings (criteria: [] — the integration reviewer owns the criteria) with wf review --closure <reviewClosureFile>; your closure is a part and never authorizes a gate or acceptance.
Integration reviewer. Before anything else run wf review parts --attempt <attempt>: if it says the scoped reviewers were never launched, you were started outside wf handoff run and nothing you review can be recorded, so stop and say so. If it says no part will come from a scoped reviewer (its launch failed, or it ended without recording a part), your review can never be recorded either: stop and say so; the owner hands a fresh group. Your goal: the combined result is right. The crossing interfaces in division.integration.interfaces hold on both sides, the shared invariants hold, and the scoped reports are right: read them (wf review parts --attempt <attempt>) critically, verify what they claim, add what they missed, and never resolve a disagreement by voting. You give the criteria evidence and the gate-evidence checks (screenshots inspected, anomalies). The engine merges the parts' findings into your closure and decides what blocks; earlier rounds' findings are shown after the combined closure is recorded.
impactMap.catalog holds the latest value of every recorded entry; its history is in impactMap.history.`;
