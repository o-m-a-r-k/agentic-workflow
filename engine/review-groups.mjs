// Named failure: large blind reviews serialized unrelated flows, while naive file splits lost shared contracts.
// This module proposes divisions from recorded end-to-end flows, never from filenames or implementer work items.
import { canonical, git, hashValue, refuse } from './util.mjs';

const list = v => Array.isArray(v) ? v : [];
export const changedInventory = bundle => Object.entries(bundle.changed ?? {}).flatMap(([repo, files]) => files.map(file => `${repo}:${file}`)).sort();

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
    impact: state.impact, discovered: state.discovered, addedRepos: state.addedRepos, scope: state.scopeDecisions,
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

export function divideReview(bundle, results, { reviewers = 2, minimumFiles = 40, division = null, weights = {} } = {}) {
  if (!Number.isInteger(reviewers) || reviewers < 2 || reviewers > 3) throw refuse('parallel review uses two or three scoped reviewers plus one integration reviewer');
  const changed = changedInventory(bundle), changedSet = new Set(changed), catalog = impactCatalog(bundle.impactMap);
  const flows = [];
  const addFlow = (id, row, extraQueries = []) => {
    if (!row?.flow || !row?.failure) return;
    const queries = [...new Set([row.query, ...extraQueries].filter(Boolean))];
    const context = [...new Set(queries.flatMap(q => results[q]?.files ?? []))].sort();
    const files = context.filter(f => changedSet.has(f));
    if (files.length) flows.push({ id, flow: row.flow, failure: row.failure, query: row.query, queries, files, context });
  };
  for (const row of catalog.flows) addFlow(`survey:${row.id}`, row);
  for (const row of catalog.changes) for (const [i, flow] of list(row.flows).entries()) addFlow(`change:${row.id}:${i}`, flow,
    [row.consumers?.query, ...list(row.contracts).map(c => c.query), ...list(row.suites).map(s => s.query)]);
  // Several actions of one feature commonly reuse its flow query. Merge their full contract/test context first,
  // then coalesce identical changed-file sets. Duplicate annotations must not turn an entire feature into a hub.
  const byQuery = new Map();
  for (const flow of flows) {
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
  const incidence = new Map();
  for (const flow of byFiles.values()) for (const file of flow.files) {
    if (!incidence.has(file)) incidence.set(file, []);
    incidence.get(file).push(flow.id);
  }
  // A file shared by several independently named flows is a hub. Integration owns it and every crossing flow.
  // Equal/overlapping flow descriptions can overestimate hubs; that causes a conservative single-review fallback.
  const shared = new Set([...incidence].filter(([, ids]) => ids.length > 1).map(([file]) => file));
  const atomic = [...byFiles.values()].map(flow => ({ ...flow, primary: flow.files.filter(f => !shared.has(f)) })).filter(f => f.primary.length);
  const cost = files => files.reduce((total, file) => total + Math.max(1, Number(weights[file]) || 1), 0);
  const single = reason => ({ version: 1, mode: 'single', reason, files: changed, flows, slices: [], integration: { files: changed, interfaces: [] } });
  if (!division && changed.length < minimumFiles) return single(`only ${changed.length} changed files; retain one reviewer below ${minimumFiles}`);
  if (atomic.length < 2) {
    if (division) throw refuse('recorded flows do not provide two separable review areas; retain a single reviewer');
    return single('recorded flows are missing, overlap too broadly, or form fewer than two separable areas');
  }
  let bins;
  if (division) {
    if (!Array.isArray(division.slices) || division.slices.length < 2 || division.slices.length > 3) throw refuse('division needs two or three slices, each naming recorded flowIds');
    const assigned = new Map();
    bins = division.slices.map((slice, index) => {
      if (!Array.isArray(slice.flowIds) || !slice.flowIds.length) throw refuse('each slice needs non-empty flowIds; arbitrary file lists cannot divide a review');
      if (new Set(slice.flowIds).size !== slice.flowIds.length) throw refuse('a slice lists a flow more than once');
      const selected = [...new Set(slice.flowIds.map(id => {
        const flow = atomic.find(f => f.flowIds.includes(id));
        if (!flow || (assigned.has(flow.id) && assigned.get(flow.id) !== index)) throw refuse(`unknown, inseparable or multiply assigned flow ${id}`);
        assigned.set(flow.id, index); return flow;
      }))];
      return { id: `S${index + 1}`, flows: selected, files: selected.flatMap(f => f.primary) };
    });
    // Unassigned flows are explicitly retained by integration; a manual proposal cannot exclude any source file.
  } else {
    bins = Array.from({ length: Math.min(reviewers, atomic.length) }, (_, i) => ({ id: `S${i + 1}`, files: [], flows: [] }));
    for (const flow of atomic.sort((a, b) => cost(b.primary) - cost(a.primary) || a.id.localeCompare(b.id))) {
      bins.sort((a, b) => cost(a.files) - cost(b.files) || a.id.localeCompare(b.id));
      bins[0].flows.push(flow); bins[0].files.push(...flow.primary);
    }
    bins.sort((a, b) => a.id.localeCompare(b.id));
  }
  const assignedFiles = new Set(bins.flatMap(b => b.files));
  const integrationFiles = changed.filter(f => !assignedFiles.has(f));
  if (!division && (integrationFiles.length > changed.length / 2 || cost(integrationFiles) > cost(changed) / 2 || Math.max(...bins.map(b => cost(b.files))) >= cost(changed) * 0.8)) return single('shared, unmapped or one indivisible flow dominates the change; parallel review would leave most work serialized');
  const interfaces = flows.filter(f => f.files.some(file => shared.has(file)) || f.context.some(file => !changedSet.has(file))).map(f => ({ id: f.id, flow: f.flow, failure: f.failure, files: f.context, owners: [...new Set(f.files.map(file => bins.find(b => b.files.includes(file))?.id ?? 'integration'))] }));
  for (const outside of bundle.impactMap?.derived?.outside ?? []) interfaces.push({ id: `derived:${outside.symbol}@${outside.file}`, files: [...new Set([outside.file, ...(outside.declarationOrigins ?? [outside.declaredIn]).filter(Boolean)])], textual: true, originAmbiguous: outside.originAmbiguous ?? false });
  const plan = { version: 1, mode: 'parallel', reason: 'recorded end-to-end flows have disjoint primary code; shared and unmapped code belongs to integration', files: changed,
    costBasis: 'changed lines (binary: 100); estimate, not measured review time',
    slices: bins.map(b => ({ id: b.id, files: [...new Set(b.files)].sort(), estimatedCost: cost(b.files), flowIds: b.flows.flatMap(f => f.flowIds), context: [...new Set(b.flows.flatMap(f => f.context))].sort() })), flows, integration: { files: integrationFiles, estimatedCost: cost(integrationFiles), interfaces } };
  validateDivision(plan, bundle);
  return plan;
}

export function validateDivision(plan, bundle) {
  const expected = changedInventory(bundle), owned = [...plan.slices.flatMap(s => s.files), ...plan.integration.files].sort();
  if (canonical(expected) !== canonical(owned)) throw refuse('review division must own every changed file exactly once');
  for (const flow of plan.flows) {
    const owners = new Set(flow.files.map(file => plan.slices.find(s => s.files.includes(file))?.id ?? 'integration'));
    if (owners.size > 1 && !plan.integration.interfaces.some(i => i.id === flow.id)) throw refuse(`crossing flow ${flow.id} has no integration check`);
  }
  return plan;
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

export function fileCoverage(files, rows, label) {
  const expected = new Set(files), seen = new Set();
  for (const row of list(rows)) {
    if (!expected.has(row?.file) || seen.has(row.file) || !String(row.evidence ?? '').trim()) throw refuse(`${label}: unknown, duplicate or unsupported file coverage ${row?.file}`);
    seen.add(row.file);
  }
  const missing = files.filter(f => !seen.has(f));
  if (missing.length) throw refuse(`${label}: missing direct code/test evidence for ${missing.length} owned file(s): ${missing.slice(0, 8).join(', ')}`);
}

export function assignedVerdicts(expected, rows, key, label) {
  const ids = new Set(expected), seen = new Set();
  for (const row of list(rows)) {
    if (!ids.has(row?.[key]) || seen.has(row[key])) throw refuse(`${label}: verdict is duplicate or belongs to another assignment: ${row?.[key]}`);
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
  const refs = list(input.partReviews), result = structuredClone(input);
  const merged = [], outside = [], hits = [], files = [];
  for (const h of required) {
    const part = parts.filter(p => p.handoff === h.bundle).at(-1);
    if (!part) throw refuse(`review group is incomplete: ${h.agent} has no recorded scoped closure`);
    const ref = refs.find(r => r.agent === h.agent);
    if (!ref || ref.sha256 !== part.raw.sha256 || !String(ref.evidence ?? '').trim()) throw refuse(`integration must inspect and cite ${h.agent}'s exact recorded closure hash with direct verification evidence`);
    const names = new Map(part.closure.findings.map(f => [f.id, `${h.reviewGroup.slot}-${f.id}`]));
    const rename = value => {
      if (Array.isArray(value)) return value.map(rename);
      if (!value || typeof value !== 'object') return value;
      return Object.fromEntries(Object.entries(value).map(([key, v]) => [key, (key === 'finding' || (key === 'by' && value.verdict === 'finding')) && names.has(v) ? names.get(v) : rename(v)]));
    };
    merged.push(...part.closure.findings.map(f => ({ ...rename(f), id: names.get(f.id), sourceReviewer: h.agent })));
    outside.push(...rename(part.closure.outsidePlan ?? []));
    hits.push(...rename(part.closure.designHits ?? []));
    files.push(...part.closure.filesReviewed);
  }
  if (refs.length !== required.length || new Set(refs.map(r => r.agent)).size !== required.length) throw refuse('integration partReviews must cite each scoped reviewer exactly once');
  const ownIds = new Set(result.findings.map(f => f.id));
  if (merged.some(f => ownIds.has(f.id))) throw refuse('integration finding ID collides with a scoped finding');
  result.findings.push(...merged);
  result.outsidePlan = [...(result.outsidePlan ?? []), ...outside];
  result.designHits = [...(result.designHits ?? []), ...hits];
  result.filesReviewed = [...(result.filesReviewed ?? []), ...files];
  return result;
}

export const GROUP_INSTRUCTIONS = `This is a coverage-enforced review group. Its explicit ownership replaces the single-reviewer instruction to inspect every file yourself. reviewGroup.mode controls the assignment. All reviewers use the frozen reviewer class, read the shared rules and skills, and may inspect any source and report any defect. Global criteriaContext and division are context, not author verdicts. Never split a producer from its consumer without the recorded integration interface. List filesReviewed: [{file, evidence: 'source/test file:line and behavior checked'}] for every primaryFiles entry exactly once. Scoped mode: independently inspect the complete assigned flows and their unchanged consumers/failure paths; criteria are context, not a second full-change review. Supply findings, criteria: [], filesReviewed, rules for the assigned flows, outsidePlan and designHits for your assigned files. Do not supply global criteria/discovery/impact verdicts or priorFindings. Run wf review --closure <reviewClosureFile>; this records a part and cannot authorize a gate or acceptance. Integration mode: directly inspect primaryFiles, every division.integration.interfaces entry on both sides, shared invariants, interactions and uncovered areas. Supply interfacesReviewed: [{id, evidence}] for every interface. Obtain current-group reports with wf review parts --attempt <attempt>. Cite each exact report with partReviews: [{agent, sha256, evidence: 'independent source/test verification'}]. Do not re-review every scoped file, rubber-stamp reports, omit findings, or resolve disagreements by voting. Supply all global criteria, discovered, historical report, lesson, rule, skill, impact, seam and gate-evidence verdicts; outsidePlan/designHits need only your primary files. The engine unions scoped findings and file verdicts and validates the complete review against the full frozen obligations. Unresolved scoped findings remain blockers. Earlier-round findings remain hidden until the combined blind closure is recorded. Impact history is retained by hash in impactMap.history; catalog holds the latest value of every recorded entry ID. Read catalog as current context, investigate historical versions when needed, and never discard an obligation because its history is externalized.`;
