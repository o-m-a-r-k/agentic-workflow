// The deployment confirmation after the merge, as a step of the delivery (0.7.27, I-196, D42). What a project declares and
// which tickets it applies to: engine/deployment.mjs.
//
// Named failure (field): a project's hotfix tickets end their delivery with the final status, but only once the merged change
// is confirmed running where it deploys and the fix was tested there where possible. The workflow's last tracker event fired at
// the merge, so the agent verified the deployment by hand (the running version against the merge commit, the replicas ready),
// checked the data, and had no step to record any of it, nor to set the status.
//
// The step, after the delivered tracker handoff of a ticket whose delivery waits for it (`deployment.owed`, recorded once):
//   1. the deployment is observed: the delivery adapter's own read-only `deployment` check when it has one (`wf deployment
//      check`), else the agent's observation, with what it saw (`wf deployment record`); the latest observation decides;
//   2. the fix is tested there where possible, or why not is recorded (`wf deployment tested`), in product words: it goes on
//      the ticket;
//   3. only then the `deployed` tracker event runs (the comment, then the routed status, read back by the same seam rule as
//      every step), and the attempt closes.
// Not confirmed (still rolling out, failed, cannot be seen), the attempt stays open and nothing is set; when it cannot be
// confirmed at all the person decides whether to close the delivery without it (`wf deployment close`), the ticket left as
// it is. Verification is read-only: a write where it deploys needs the person's authority under the project's rules.
// Attempts admitted before 0.7.27 keep the delivery they started with (D7), and the person's hold stops the step.
import { DEPLOY_STATES, STATE_WORDS, deploymentChecks, deploymentRule } from './deployment.mjs';
import { append, loadState } from './ledger.mjs';
import { actor, branchName, openState } from './attempt.mjs';
import { loadConfig, trustedAdapter } from './config.mjs';
import { obligationSince, admittedVersion } from './versions.mjs';
import { emitTrackerEvent, hasTicket, internalsIn } from './tracker.mjs';
import { ticketLabels } from './status-route.mjs';
import { requireYes } from './approve.mjs';
import { FRAMES } from './asking.mjs';
import { WfError, refuse, sha256 } from './util.mjs';
import { scrub } from './scrub.mjs';
import { adapterResult, deliveryPin, loadDeliveryAdapter, needsShown, nextAction } from './lifecycle.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const SINCE = '0.7.27';
const line = (t, max = 2000) => scrub(String(t ?? '').replace(/\s+/g, ' ').trim()).slice(0, max);
const latest = (d) => d?.observations?.at(-1) ?? null;
export const deploymentConfirmed = (d) => latest(d)?.state === 'deployed';
const testedOk = (d) => Boolean(d?.tested) && d.tested.result !== 'failed';
// Settled: the person closed the delivery without it, or the deployment is confirmed and the fix tested (or why not recorded).
export const deploymentSettled = (d) => Boolean(d?.closed) || (deploymentConfirmed(d) && testedOk(d));
const handoffDone = (state) => state.phase === 'handoff-pending' && !state.tracker.pending.length && !needsShown(state);

// Whether this attempt's delivery waits for the deployment: { where, label, check } or null. Read from the adapter as committed
// at the delivery pin (the delivery adapter, and the configuration that names it, as delivery reads them), with the ticket's
// labels as its latest recorded readback showed them (the delivered one, once it is recorded), the labels its routed statuses
// are judged by. `check`: the delivery adapter's own `deployment` check decides, or the agent's observation does.
export async function deploymentOwed(root, state) {
  if (!state.delivery?.completedAt || state.shipped || !obligationSince(state, SINCE) || !hasTicket(state)) return null;
  const cfg = trustedAdapter(root, state, deliveryPin(state));
  const rule = deploymentRule(cfg, ticketLabels(state));
  if (!rule) return null;
  const adapter = await loadDeliveryAdapter(root, cfg, state);
  return { ...rule, check: typeof adapter?.deployment === 'function' ? 'adapter' : 'agent' };
}

// Why a delivery does not wait for a deployment, for a refusal.
async function whyNotOwed(root, state) {
  if (!obligationSince(state, SINCE)) return `${state.id} was admitted under ${admittedVersion(state) ?? 'an older release'}, before the deployment confirmation existed (${SINCE}); it keeps the delivery it started with`;
  if (!hasTicket(state)) return `${state.id} works no ticket of the tracker`;
  let cfg;
  try {
    cfg = trustedAdapter(root, state, deliveryPin(state));
  } catch (error) {
    return `its adapter at the delivery pin cannot be read (${error.message.split('\n')[0]})`;
  }
  const d = cfg.delivery?.deployment;
  if (!d) return `the project's delivery, as committed for this attempt (${String(deliveryPin(state)).slice(0, 10)}), does not wait for a deployment (no \`delivery.deployment\`)`;
  const labels = ticketLabels(state);
  return `the delivery waits only for a ticket labelled ${(d.labels ?? []).map((l) => `"${l}"`).join(' or ')}, and ${state.item}'s labels, as read back, ${labels ? `are ${labels.length ? labels.map((l) => `"${l}"`).join(', ') : 'none'}` : 'were never reported'}`;
}

// The ticket's words for the test, for the `deployed` comment.
const testedLine = (d) => (d.tested.result === 'passed' ? `Tested in ${d.owed.where}: ${d.tested.text}` : `Not tested in ${d.owed.where}: ${d.tested.text}`);

// Called when the delivered handoff is complete (engine/lifecycle.mjs closeAfterHandoff): records that the delivery waits for the
// deployment (once), queues the `deployed` tracker event once the deployment is confirmed and the fix tested, and says whether
// the attempt may close. Every step is derived from the ledger, so a command that stopped in between is completed by the next.
export async function deploymentAfterHandoff(root, state) {
  let s = state;
  if (!s.deployment) {
    const owed = await deploymentOwed(root, s);
    if (!owed) return { state: s };
    append(root, s.id, 'deployment.owed', owed, null);
    s = loadState(root, s.id);
  }
  const d = s.deployment;
  if (d.closed) return { state: s, reason: 'closed without a confirmed deployment (the person\'s decision); the ticket is left where the delivery put it' };
  if (!deploymentSettled(d) || s.activeHold) return { state: s, waiting: true };
  const handed = s.tracker.done.some((x) => x.event === 'deployed');
  if (!handed && hasTicket(s)) {
    const actions = emitTrackerEvent(root, loadConfig(root), s.id, 'deployed', { where: d.owed.where, tested: testedLine(d) });
    if (actions.length) return { state: loadState(root, s.id), waiting: true };
  }
  return { state: s, reason: `deployment confirmed in ${d.owed.where} and the fix ${d.tested.result === 'passed' ? 'tested there' : 'not testable there (reason recorded)'}${handed ? '; tracker handoff verified' : ''}` };
}

// The state a `wf deployment` command works on: the delivery waits for its deployment, nothing is held, nothing settled.
// Named failures these refusals name (field, I-196): the step is the person's rule for some tickets only, so a command on a
// delivery that does not wait for it says why (`deployment:not-owed`) instead of recording a confirmation nothing reads; the
// person's pause stops it (`deployment:on-hold`), as it stops `wf deliver`; a settled step is not recorded twice
// (`deployment:settled`), so a retried command cannot queue the final status again.
async function stepState(root, options) {
  let state = openState(root, options);
  if (state.activeHold) throw refuse(`delivery is on hold: "${state.activeHold.reason}"; the deployment step waits`, 'only the person lifts it (`wf release`)', { id: 'deployment:on-hold' });
  if (!state.deployment && handoffDone(state)) {
    const owed = await deploymentOwed(root, state);
    if (owed) {
      append(root, state.id, 'deployment.owed', owed, null);
      state = loadState(root, state.id);
    }
  }
  if (!state.deployment) {
    if (['done', 'abandoned'].includes(state.phase)) throw refuse(`${state.id} is ${state.phase === 'done' ? 'closed' : 'abandoned'}`, null, { id: 'deployment:not-owed' });
    if (!state.delivery.completedAt) throw refuse(`${state.id} is not delivered yet: the deployment is confirmed after \`wf deliver\` and the delivered tracker handoff`, `next: ${nextAction(root, state)}`, { id: 'deployment:not-owed' });
    if (!handoffDone(state)) throw refuse(`${state.id}'s delivered handoff comes first`, `next: ${nextAction(root, state)}`, { id: 'deployment:not-owed' });
    throw refuse(`${state.id}'s delivery does not wait for a deployment: ${await whyNotOwed(root, state)}`, null, { id: 'deployment:not-owed' });
  }
  if (state.phase !== 'handoff-pending') throw refuse(`${state.id} is ${state.phase === 'done' ? 'closed' : state.phase}`, null, { id: 'deployment:not-owed' });
  if (deploymentSettled(state.deployment)) throw refuse(`${state.id}'s deployment step is already settled (${state.deployment.closed ? 'closed without it by the person\'s decision' : `confirmed, and the fix ${state.deployment.tested.result === 'passed' ? 'tested' : 'not testable'} there`})`, `next: ${nextAction(root, state)}`, { id: 'deployment:settled' });
  return state;
}

// `wf deployment check`: the delivery adapter's own read-only check, for each delivered repo; every repo deployed confirms it.
export async function checkDeployment(root, options) {
  const state = await stepState(root, options);
  const d = state.deployment;
  // A delivery adapter without a check: the agent's observation is the record (`deployment:no-adapter-check` says how).
  if (d.owed.check !== 'adapter') throw refuse(`${state.id}'s delivery adapter has no \`deployment\` check: you confirm the deployment yourself`, `look, read-only, whether the merged change runs in ${d.owed.where}, then \`wf deployment record --state deployed|deploying|failed|unknown --observed "<what you saw>"\``, { id: 'deployment:no-adapter-check' });
  const cfg = trustedAdapter(root, state, deliveryPin(state));
  const adapter = await loadDeliveryAdapter(root, cfg, state);
  const repos = {};
  for (const [name, rec] of Object.entries(state.delivery.repos)) {
    if (!rec.commit || rec.skipped) continue;
    const repo = cfg.repos.find((r) => r.name === name);
    const ctx = { ...adapterResult(rec), root, repo, worktree: state.repos[name]?.worktree ?? null, attempt: state.id, item: state.item, branch: branchName(state.id), commit: rec.commit, target: rec.target ?? null, where: d.owed.where };
    let r;
    try {
      r = await adapter.deployment(ctx);
    } catch (error) {
      r = { state: 'unknown', evidence: `the check failed: ${String(error?.message ?? error).split('\n')[0]}` };
    }
    const known = DEPLOY_STATES.includes(r?.state);
    repos[name] = { state: known ? r.state : 'unknown', evidence: line(r?.evidence) || (known ? null : `the adapter reported ${r?.state === undefined || r?.state === null ? 'no state' : JSON.stringify(String(r.state))}, not one of ${DEPLOY_STATES.join(', ')}`) };
  }
  const states = Object.values(repos).map((x) => x.state);
  const overall = states.every((x) => x === 'deployed') ? 'deployed' : ['failed', 'unknown', 'deploying'].find((x) => states.includes(x));
  const evidence = Object.entries(repos).map(([n, x]) => `${n}: ${x.state}${x.evidence ? ` (${x.evidence})` : ''}`).join('; ') || 'no repo of this delivery changed anything';
  append(root, state.id, 'deployment.observed', { state: overall, source: 'adapter', repos, evidence, ...(typeof options.observed === 'string' && options.observed.trim() ? { observed: line(options.observed) } : {}) }, actor(options));
  return loadState(root, state.id);
}

// `wf deployment record --state S --observed "..."`: the agent's own observation, when the delivery adapter has no check.
export async function recordDeployment(root, options) {
  const state = await stepState(root, options);
  const d = state.deployment;
  // The project's own check decides when the delivery adapter has one: an agent's "looks deployed" does not replace it.
  if (d.owed.check === 'adapter') throw refuse(`${state.id}'s delivery adapter checks the deployment itself: its answer decides, not an observation`, '`wf deployment check` asks it (read-only); when it cannot confirm the deployment at all, the person decides: `wf deployment close --reason "<why>"`', { id: 'deployment:adapter-checks' });
  const st = typeof options.state === 'string' ? options.state.trim() : '';
  if (!DEPLOY_STATES.includes(st)) throw new WfError(`--state is one of ${DEPLOY_STATES.join(', ')}: what you saw of the merged change in ${d.owed.where}`);
  if (typeof options.observed !== 'string' || !options.observed.trim()) throw new WfError(`--observed "<what you saw>" is required: how you know (the running version against the merged commit, the rollout, the health), kept with the delivery`);
  append(root, state.id, 'deployment.observed', { state: st, source: 'agent', observed: line(options.observed) }, actor(options));
  return loadState(root, state.id);
}

// `wf deployment tested --observed "..." | --not-possible "<why>" | --failed "..."`: the test of the fix where it runs.
export async function recordTested(root, options) {
  const state = await stepState(root, options);
  const d = state.deployment;
  const given = ['observed', 'not-possible', 'failed'].filter((k) => options[k] !== undefined);
  if (given.length !== 1 || typeof options[given[0]] !== 'string' || !options[given[0]].trim()) throw new WfError('usage: wf deployment tested --observed "<what you tested and saw>" | --not-possible "<why it cannot be tested there>" | --failed "<what you saw>"');
  // The person's rule: the fix is tested where the merged change runs, so not before that is confirmed.
  if (!deploymentConfirmed(d)) {
    const last = latest(d);
    throw refuse(`the deployment in ${d.owed.where} is not confirmed yet${last ? ` (the last check, ${last.at}: ${STATE_WORDS[last.state]})` : ''}: the fix is tested where the merged change runs`, `next: ${nextAction(root, state)}`, { id: 'deployment:not-confirmed' });
  }
  const result = { observed: 'passed', 'not-possible': 'not-possible', failed: 'failed' }[given[0]];
  const text = line(options[given[0]], 1000);
  // The test's line goes on the ticket (the `deployed` comment), so it is product language; a failed test is told to the person.
  // Refused here, not at the readback, where a comment with internals would be refused after it was posted.
  if (result !== 'failed') {
    const hits = internalsIn(loadConfig(root), text);
    if (hits.length) throw refuse(`the line goes on the ticket and carries internals (${hits.join(', ')})`, 'say what was tested and what it showed, or why it cannot be tested there, in product words: what a person can check (no file paths, commits or hashes)', { id: 'deployment:internals' });
  }
  append(root, state.id, 'deployment.tested', { result, text }, actor(options));
  return loadState(root, state.id);
}

// `wf deployment close --reason "<why>"`: the deployment cannot be confirmed (or the fix failed there), and the person decides
// whether the delivery closes without it. The ticket is left where the delivery put it, never set to the deployed status.
export async function closeUnconfirmed(root, options) {
  const state = await stepState(root, options);
  const reason = typeof options.reason === 'string' ? options.reason.trim() : '';
  if (!reason) throw new WfError('--reason "<why the deployment cannot be confirmed>" is required');
  const d = state.deployment;
  const last = latest(d);
  const where = d.owed.where;
  const why = d.tested?.result === 'failed' ? `the fix did not work when it was tested in ${where}` : !last ? `its deployment to ${where} has not been confirmed` : last.state === 'deployed' ? `it runs in ${where}, but the fix has not been tested there` : last.state === 'deploying' ? `it is still rolling out to ${where}` : last.state === 'failed' ? `its deployment to ${where} failed` : `whether it runs in ${where} cannot be seen from here`;
  const key = `deployment-close:${state.id}:${sha256(JSON.stringify({ last: last?.at ?? null, tested: d.tested?.at ?? null })).slice(0, 16)}`;
  const decision = requireYes(root, state, { kind: 'override-gate', key, summary: `close the delivery of ${state.id} without a confirmed deployment in ${where} (${reason}); the ticket is not moved`, what: `closing ${state.id}'s delivery without a confirmed deployment`, frame: FRAMES.closeUndeployed({ item: state.item, why, where }), options }).decision;
  append(root, state.id, 'deployment.closed', { reason: line(reason, 1000), decision, last: last ? { state: last.state, at: last.at } : null, tested: d.tested?.result ?? null }, actor(options));
  return loadState(root, state.id);
}

// The next step while the delivery waits for its deployment (`wf resume`, `wf status`), or null.
export function deploymentNext(root, state) {
  let d = state.deployment;
  // Owed but not recorded yet (a command stopped before it): read-only here; the next `wf deployment` command records it.
  if (!d && handoffDone(state) && state.delivery?.completedAt && !state.shipped && obligationSince(state, SINCE) && hasTicket(state)) {
    let rule = null;
    try {
      rule = deploymentRule(trustedAdapter(root, state, deliveryPin(state)), ticketLabels(state));
    } catch {
      rule = null;
    }
    if (rule) d = { owed: { ...rule, check: 'either' }, observations: [], tested: null, closed: null };
  }
  if (!d?.owed || deploymentSettled(d)) return null;
  const { where, label } = d.owed;
  const item = state.item;
  const why = label ? `${item} carries "${label}": its delivery ends once the merged change runs in ${where} and the fix is tested there` : `this project's delivery ends once the merged change runs in ${where} and the fix is tested there`;
  const readOnly = `read-only: nothing in ${where} is changed (no redeploy, restart, data change or setting) without the person's authority under the project's rules`;
  const closeRoute = `when it cannot be confirmed at all, the person decides: \`wf deployment close --reason "<why>"\` asks them whether the delivery closes without it (the ticket is not moved)`;
  const last = latest(d);
  if (d.tested?.result === 'failed' && deploymentConfirmed(d)) return `${why}. The fix failed when tested in ${where}: "${d.tested.text}". Tell the person what you saw; nothing is set. After a change there that may fix it (theirs to authorize), test again (\`wf deployment tested\`); a fix in the code is a new attempt of the ticket: \`wf deployment close --reason "<why>"\` asks the person to close this delivery without the confirmation, then \`wf reopen --item ${item} --reason "<what failed>"\``;
  if (deploymentConfirmed(d)) return `${why}. The deployment is confirmed (${last.source === 'adapter' ? `the delivery adapter's check: ${last.evidence}` : `your observation: ${last.observed}`}). Test the fix in ${where} where possible (${readOnly}) and record what you did and saw, in product words (it goes on the ticket): \`wf deployment tested --observed "<what you tested and saw>"\`; when it cannot be tested there, \`wf deployment tested --not-possible "<why>"\`; when it fails there, \`wf deployment tested --failed "<what you saw>"\` and tell the person`;
  const look = `that the merged change runs in ${where} (the running version against the merged commit, the rollout finished), ${readOnly}`;
  const how = d.owed.check === 'either' ? `\`wf deployment check\` asks the delivery adapter (read-only) when it has its own check; without one, confirm ${look}, and record what you saw: \`wf deployment record --state deployed|deploying|failed|unknown --observed "<what you saw>"\`` : d.owed.check === 'adapter' ? `\`wf deployment check\` asks the delivery adapter (read-only) whether the merged change runs in ${where}` : `confirm ${look}, and record what you saw: \`wf deployment record --state deployed --observed "<what you saw>"\`; while it is still rolling out, failed, or cannot be seen from here, record that (\`--state deploying|failed|unknown\`)`;
  if (!last) return `${why}. ${how[0].toUpperCase()}${how.slice(1)}; ${closeRoute}`;
  const seen = `Not confirmed: ${STATE_WORDS[last.state]} (${last.source === 'adapter' ? `the delivery adapter's check, ${last.at}: ${last.evidence}` : `your observation, ${last.at}: ${last.observed}`})`;
  const then = last.state === 'deploying' ? 'check again once the rollout is through' : last.state === 'failed' ? `tell the person the merged change did not deploy to ${where}: a redeploy, or a fix (a new attempt of the ticket, once this delivery is closed), is theirs to authorize` : `tell the person it cannot be seen from here whether it runs in ${where}: they may confirm it, give the access, or decide`;
  return `${why}. ${seen}: ${then}; nothing is set until it is confirmed. ${how[0].toUpperCase()}${how.slice(1)}; ${closeRoute}`;
}

// One `wf status` line.
export function deploymentLine(state) {
  const d = state.deployment;
  if (!d?.owed) return null;
  const last = latest(d);
  const head = `deployment in ${d.owed.where} (${d.owed.label ? `the ticket's label "${d.owed.label}"` : 'every ticket'}; ${d.owed.check === 'adapter' ? 'the delivery adapter checks it' : 'the agent\'s observation'})`;
  const seen = !last ? 'not checked yet' : last.state === 'deployed' ? `confirmed ${last.at}` : `not confirmed: ${last.state} (${last.at})`;
  const tested = d.tested ? `; tested: ${d.tested.result} (${d.tested.at})` : '';
  const closed = d.closed ? `; closed without it by the person's decision ${d.closed.decision ?? ''} (${d.closed.reason})` : '';
  return `${head}: ${seen}${tested}${closed}`;
}

// `wf doctor`: what the step does in this project, and any mismatch with the status set at its end. Whether the delivery
// adapter provides a check is read from the working copy's adapter, as doctor reads every adapter.
export async function deploymentDoctor(root, cfg) {
  let check = false;
  const kind = cfg.delivery?.kind;
  if (cfg.delivery?.deployment && typeof kind === 'string' && kind.startsWith('.')) {
    try {
      const file = path.resolve(root, '.workflow', kind);
      if (fs.existsSync(file)) check = typeof (await import(pathToFileURL(file).href)).default?.deployment === 'function';
    } catch {
      check = false;
    }
  }
  return deploymentChecks(cfg, { check });
}
