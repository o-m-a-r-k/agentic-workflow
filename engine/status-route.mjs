// A ticket's status by its labels (0.7.27, I-190).
//
// Named failure (field): a project's tickets of one kind (those labelled "Self-serve") are finished when they are delivered,
// so the person wants them in Done, not Ready for UAT, while every other ticket still ends in Ready for UAT. Each lifecycle
// step mapped to one status (`tracker.statuses: { started, delivered, done }`), the engine never set Done, and the texts said an
// agent never does, so the project hardcoded the status in its own adapter and the engine's record disagreed with the tracker.
//
// `tracker.statusByLabel: { <step>: { "<label>": "<status>" } }` is the person's routing, in the adapter: when the ticket
// carries the label, that step's status is the one named instead of the step's default in `tracker.statuses`. The default stays
// everywhere else: no step sets Done unless the adapter routes it there (or names it as a default). The labels are the ticket's
// own, as its latest recorded readback showed them (`labels` of the normalised issue), never anything an agent says here.

const fold = (s) => String(s ?? '').normalize('NFKC').trim().toLowerCase();

// What an adapter's `statusByLabel` must be, and the messages for what it is not (config validation, `wf doctor`).
export function routeProblems(tracker) {
  const rules = tracker?.statusByLabel;
  if (rules === undefined || rules === null) return [];
  const at = (sub = '') => `\`tracker.statusByLabel${sub}\``;
  if (typeof rules !== 'object' || Array.isArray(rules)) return [`${at()} maps a step to the labels that route it: { delivered: { "Self-serve": "Done" } }`];
  const problems = [];
  const statuses = tracker.statuses ?? {};
  for (const [step, byLabel] of Object.entries(rules)) {
    if (!statuses[step]) {
      problems.push(`${at(`.${step}`)}: ${step} is not a step with a status in \`tracker.statuses\` (${Object.keys(statuses).join(', ') || 'none'}); a label only routes a step away from its default status, which has to exist`);
      continue;
    }
    if (!byLabel || typeof byLabel !== 'object' || Array.isArray(byLabel) || !Object.keys(byLabel).length) {
      problems.push(`${at(`.${step}`)} lists the labels that route it, each to a status: { "Self-serve": "Done" }`);
      continue;
    }
    const seen = new Map();
    for (const [label, status] of Object.entries(byLabel)) {
      if (!fold(label)) problems.push(`${at(`.${step}`)}: a label is empty`);
      else if (typeof status !== 'string' || !status.trim()) problems.push(`${at(`.${step}["${label}"]`)} names the status the label routes to, as text`);
      else if (seen.has(fold(label))) problems.push(`${at(`.${step}`)}: "${label}" and "${seen.get(fold(label))}" are the same label (labels are matched without regard to case)`);
      else seen.set(fold(label), label);
    }
  }
  return problems;
}

// The status a step goes to for a ticket with these labels, with the label that routed it, or null (the step's default).
// The first label of the rule the ticket has wins: the order the adapter lists them in is the priority.
export function routedStatus(tracker, step, labels) {
  const byLabel = tracker?.statusByLabel?.[step];
  if (!byLabel || !Array.isArray(labels) || !labels.length) return null;
  const have = new Set(labels.map(fold));
  for (const [label, status] of Object.entries(byLabel)) if (have.has(fold(label)) && typeof status === 'string' && status.trim()) return { label, status: status.trim() };
  return null;
}

// The ticket's labels as its latest recorded readback showed them, or null when no readback carried any.
export function ticketLabels(state) {
  const read = [...(state?.tracker?.done ?? [])].reverse().find((d) => Array.isArray(d.labels));
  return read ? read.labels : null;
}

// Every status name the adapter can set (a tracker that keeps status as a label removes the others when it sets one).
export const statusNames = (tracker) => [...new Set([...Object.values(tracker?.statuses ?? {}), ...Object.values(tracker?.statusByLabel ?? {}).flatMap((byLabel) => Object.values(byLabel ?? {}))].filter((s) => typeof s === 'string' && s))];

// What `wf doctor` says about the routing: one line per rule.
export const routeLines = (tracker) => Object.entries(tracker?.statusByLabel ?? {}).flatMap(([step, byLabel]) => Object.entries(byLabel ?? {}).map(([label, status]) => `${step} goes to "${status}" for a ticket labelled "${label}" (otherwise "${tracker.statuses?.[step]}")`));
