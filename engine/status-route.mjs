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
// own, as a readback showed them (`labels` of the normalised issue), never anything an agent says here. The status asked for is
// worked out from the labels of the latest readback recorded so far; the readback that proves it is judged by its own labels
// (engine/tracker.mjs expectedStatus), so a label taken off in between is not held against the ticket.

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

// The status a `setStatus` action sets and expects, given the ticket's labels as they were just read (0.7.27, review of the
// release). The action was queued with the status the labels of an earlier readback routed to (`status`, with `route.default`
// when it was routed), which can be days old: the labels in hand decide, so the status the engine sets when it performs and the
// status the readback is judged by are one rule. Labels not read (a tracker that reports none), or no rules to apply, keep the
// status the action carries. Used at the seam (engine/tracker.mjs: performTracker resolves a routed step from the labels the
// adapter's own readback reports, so no adapter carries the rule) and by the readback check. `route` is what was used, for the record; `note` says why in a refusal.
export function statusFor(tracker, a, labels) {
  if (!Array.isArray(labels) || !tracker) return { status: a.status, route: null, note: '' };
  const fallback = a.route?.default ?? a.status;
  const route = routedStatus(tracker, a.key, labels);
  return {
    status: route?.status ?? fallback,
    route: route ? { step: a.key, label: route.label, status: route.status, default: fallback } : null,
    note: route ? ` (the ticket's label "${route.label}" routes it)` : a.route ? ` (the ticket's labels, as read back, do not carry "${a.route.label}")` : '',
  };
}

// The ticket's labels as its latest recorded readback showed them, or null when no readback carried any.
export function ticketLabels(state) {
  const read = [...(state?.tracker?.done ?? [])].reverse().find((d) => Array.isArray(d.labels));
  return read ? read.labels : null;
}

// Every status name the adapter can set (a tracker that keeps status as a label removes the others when it sets one).
export const statusNames = (tracker) => [...new Set([...Object.values(tracker?.statuses ?? {}), ...Object.values(tracker?.statusByLabel ?? {}).flatMap((byLabel) => Object.values(byLabel ?? {}))].filter((s) => typeof s === 'string' && s))];

// What `wf doctor` says about the routing: one line per rule, with what happens at admission, which comes before any readback
// was recorded. 0.7.27 (verification of the release): doctor said a rule for the first step could not route at admission, while
// an engine-performed tracker did route it (it reads the ticket's labels through the adapter before it sets the status, engine/
// tracker.mjs performTracker); through a connector the pending action names the default, and the admission readback is judged by
// the labels it shows, so the agent sets the routed status when the ticket it read carries the label.
const ENGINE_VIAS = ['api', 'cli', 'files'];
const atAdmission = (tracker, step, label, status) => (step !== 'started' ? '' : ENGINE_VIAS.includes(tracker?.via) ? '; also at admission: the engine reads the ticket\'s labels before it sets the status' : `; at admission no readback has shown the labels yet, so the pending action names "${tracker.statuses?.[step]}": set "${status}" when the ticket you read carries "${label}" (the admission readback is judged by the labels it shows)`);
export const routeLines = (tracker) => Object.entries(tracker?.statusByLabel ?? {}).flatMap(([step, byLabel]) => Object.entries(byLabel ?? {}).map(([label, status]) => `${step} goes to "${status}" for a ticket labelled "${label}" (otherwise "${tracker.statuses?.[step]}")${atAdmission(tracker, step, label, status)}`));
