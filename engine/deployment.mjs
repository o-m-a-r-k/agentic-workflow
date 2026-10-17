// The deployment confirmation after the merge: what a project declares, and which tickets it applies to (0.7.27, I-196, D42).
// Pure: no ledger, no git, no adapter code (the configuration validation imports it). The step itself is engine/deployment-step.mjs.
//
// Named failure (field): a project's hotfix tickets end their delivery with the final status (Done), but only once the merged
// change is confirmed running where it deploys (a merge deploys it automatically, minutes later) and the fix was tested there
// where possible. The last tracker event was `delivered`, which fires when the accepted commit is on the target branch, so a
// label route to Done (`tracker.statusByLabel`, D39) could only set it at the merge, before anything was deployed or tested.
// The agent verified the deployment by hand (the running version against the merge commit, the replicas ready), checked the
// data, and had no step to record any of it or to set the status.
//
// `delivery.deployment: { labels?, where? }`, in the adapter: a ticket's delivery (every ticket's, or only a ticket carrying one
// of `labels`, as its readbacks showed them) continues after its tracker handoff with a deployment confirmation. The merged
// change is confirmed running `where` it deploys (by the delivery adapter's own `deployment` check when it has one, else by the
// agent's recorded observation, with what it saw), the fix is tested there where possible (or why not is recorded), and only
// then the `deployed` tracker event runs: a comment in product language, then the status `tracker.statuses.deployed` (routed by
// `tracker.statusByLabel.deployed` like any step). A project that declares nothing delivers as before.

const fold = (s) => String(s ?? '').normalize('NFKC').trim().toLowerCase();
export const DEFAULT_WHERE = 'the environment it deploys to';
const KEYS = ['labels', 'where'];
// The states a deployment is observed in, by the agent or the delivery adapter's check.
export const DEPLOY_STATES = ['deployed', 'deploying', 'failed', 'unknown'];
export const STATE_WORDS = { deployed: 'the merged change runs there', deploying: 'it is still rolling out', failed: 'the deployment failed', unknown: 'it cannot be seen from here whether the merged change runs there' };

// What an adapter's `delivery.deployment` must be (configuration validation, so `wf doctor` names it too).
export function deploymentProblems(cfg) {
  const d = cfg?.delivery?.deployment;
  if (d === undefined || d === null) return [];
  if (typeof d !== 'object' || Array.isArray(d)) return ['`delivery.deployment` says the delivery waits after the merge for the deployment to be confirmed: { labels: ["<ticket label>"], where: "<where it deploys>" } (both optional; without `labels` every ticket waits)'];
  const problems = [];
  // Named failure guarded: a misspelt `label:` would make every ticket wait.
  for (const k of Object.keys(d)) if (!KEYS.includes(k)) problems.push(`\`delivery.deployment.${k}\` is unknown (known: ${KEYS.join(', ')})`);
  if (d.labels !== undefined) {
    if (!Array.isArray(d.labels) || !d.labels.length || d.labels.some((l) => typeof l !== 'string' || !l.trim())) problems.push('`delivery.deployment.labels` lists the ticket labels whose delivery waits for the deployment, each as text (leave it out and every ticket waits)');
    else {
      const seen = new Map();
      for (const l of d.labels) {
        if (seen.has(fold(l))) problems.push(`\`delivery.deployment.labels\`: "${l}" and "${seen.get(fold(l))}" are the same label (labels are matched without regard to case)`);
        else seen.set(fold(l), l);
      }
    }
    if ((cfg.tracker?.kind ?? 'none') === 'none') problems.push('`delivery.deployment.labels` needs a tracker: with `tracker.kind: none` no label is ever read, so no ticket would wait; leave `labels` out and every ticket waits');
  }
  if (d.where !== undefined && (typeof d.where !== 'string' || !d.where.trim() || /[\u0000-\u001f\u007f]/.test(d.where))) problems.push('`delivery.deployment.where` names where the merged change runs, as one line of text (for example: production)');
  return problems;
}

// Whether a ticket with these labels waits for the deployment, and where: { where, label } (label null: every ticket), or null.
// The labels are the ticket's own, as its latest recorded readback showed them, the same ones its routed statuses are judged by.
export function deploymentRule(cfg, labels) {
  const d = cfg?.delivery?.deployment;
  if (!d || typeof d !== 'object' || Array.isArray(d)) return null;
  const where = typeof d.where === 'string' && d.where.trim() ? d.where.trim() : DEFAULT_WHERE;
  if (!Array.isArray(d.labels) || !d.labels.length) return { where, label: null };
  const have = new Set((Array.isArray(labels) ? labels : []).map(fold));
  const label = d.labels.find((l) => have.has(fold(l)));
  return label ? { where, label } : null;
}

// What `wf doctor` says about the step, from the adapter as it stands: one line of what happens, and each mismatch between the
// step and the status set at its end. `check`: whether the delivery adapter provides its own `deployment` check.
// Named failure guarded: a status (or a label route) set at `deployed` with no step that waits for the deployment is never set,
// so the person's "Done once deployed" silently never happens (a failure). A step with no status at its end is a comment-only
// setup: the ticket stays at its delivered status, which doctor says (a warning).
export function deploymentChecks(cfg, { check = false } = {}) {
  const d = cfg?.delivery?.deployment;
  const statuses = cfg?.tracker?.statuses ?? {};
  const routes = cfg?.tracker?.statusByLabel?.deployed ?? null;
  const out = [];
  const tracked = (cfg?.tracker?.kind ?? 'none') !== 'none';
  if (!d) {
    if (tracked && (statuses.deployed || routes)) out.push({ fail: true, check: 'deployment step', problem: `a status is set when the deployment is confirmed (${[statuses.deployed ? `\`tracker.statuses.deployed\`: "${statuses.deployed}"` : '', routes ? `\`tracker.statusByLabel.deployed\`: ${Object.entries(routes).map(([l, s]) => `"${s}" for "${l}"`).join(', ')}` : ''].filter(Boolean).join('; ')}), but no delivery waits for the deployment (\`delivery.deployment\`), so it is never set`, fix: 'add `delivery: { deployment: { labels: ["<ticket label>"], where: production } }` (labels optional: without them every ticket waits), or remove the `deployed` status' });
    return out;
  }
  const rule = deploymentRule(cfg, Array.isArray(d.labels) ? d.labels : []);
  const where = rule?.where ?? DEFAULT_WHERE;
  const who = Array.isArray(d.labels) && d.labels.length ? `a ticket labelled ${d.labels.map((l) => `"${l}"`).join(' or ')}` : 'every ticket';
  const status = !tracked ? 'no tracker step (no tracker)' : statuses.deployed ? `then the tracker step \`deployed\`: a comment, and the status "${statuses.deployed}"${routes ? ` (${Object.entries(routes).map(([l, s]) => `"${s}" for a ticket labelled "${l}"`).join(', ')})` : ''}` : 'then a comment on the ticket';
  out.push({ info: true, check: 'deployment after the merge', problem: `the delivery of ${who} waits after the merge until the merged change is confirmed running in ${where} (${check ? 'the delivery adapter\'s own `deployment` check decides' : 'the agent\'s recorded observation stands: the delivery adapter has no `deployment` check'}) and the fix is tested there where possible (or why not is recorded); ${status}` });
  // A comment-only step is a valid setup (review of 0.7.27): a warning that says what will happen, not a failure.
  if (tracked && !statuses.deployed) out.push({ warn: true, check: 'deployment step', problem: `the delivery waits for the deployment (\`delivery.deployment\`), and no status is set when it is confirmed (\`tracker.statuses.deployed\`): once it is confirmed and the fix tested, the ticket gets the comment and stays at the status its delivery set`, fix: 'to set a status then, set `tracker.statuses.deployed` (for example Done); `tracker.statusByLabel.deployed` routes it by label like any step' });
  return out;
}
