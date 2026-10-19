// The strategist's diagnosis of what kept going wrong, and its correction to how the work runs (0.7.34, I-232).
//
// Named failure (field): one attempt ran 23 review rounds. Five evidence reviews in a row asked again for screen-recording proof the
// local simulator cannot make; then one low wording finding got its own implementer and review round, and its fix caused the next
// finding, and that fix the next, four times under four different family labels with no reviewer linking them; then base merges and
// toolchain drift stopped gates and opened review rounds of their own. Two strategist decisions were recorded: an action, a rationale
// and a prediction each. The second said "no recurring causes are recorded" (true of the engine's signals, false of the work) and
// that the base would be taken in "once"; it was merged twice more. Nothing required a diagnosis of the loop, nothing required a
// change to how the work runs, nothing asked at the next decision whether the change was made and whether it held. The person: "the
// strategist should also look at what went wrong and correct course so we don't go into infinite loop".
//
// What this makes the strategist's decision at each count accountable for; on its own it stops nothing. What breaks a loop is the
// round count's cadence (D84), the course signals that hand the strategist (engine/course.mjs) and the roles following the
// corrections. The engine checks facts only: that what a closure cites exists, that it is earlier or later than a decision, that a
// round handed since the previous decision is accounted for, and that a category equals an earlier one. Agents judge the meaning.
import { dispositionOf, openAcrossRounds, recordedRoundsOf, unreachedOf } from './review-policy.mjs';
import { sameCauseRefs } from './causes.mjs';

// Why the rounds loop: the category the engine compares (never the words), with the plain meaning every reader sees instead.
export const CAUSES = {
  capability: 'the work needs something this environment cannot give (a device, an account, a secret, a tool)',
  assumption: 'one wrong assumption lives in several places and the rounds find them one at a time',
  regression: 'fixes break what was working',
  'one-at-a-time': 'small items each get their own fix and review round',
  base: 'the base moves and its merges reopen gates and reviews',
  tooling: 'the gate, the evidence export or the validation fails for reasons outside the product',
  scope: 'the work grows, or a criterion cannot be met as written: criteria added, scope widened, a product question underneath',
  review: 'the reviews do not converge: they raise again what was settled, reach different scopes, or do not finish',
  other: 'another cause, said in its own words',
};

// What changes in how the work runs. Review of the I-232 design (M8): the action is the next step, the lever is the change to the
// flow; the same action carried different changes in the field, and the refusal of the same course compares the change.
export const LEVERS = {
  person: 'put the decision the loop waits on to the person',
  'one-pass': 'one planned pass for the remaining items instead of a round each',
  'root-cause': 'trace the assumption and fix every place that relies on it in one pass, with one proof',
  'review-scope': 'change what the next rounds review or raise again',
  'base-timing': 'change when the base is taken in',
  'repair-tooling': 'repair the gate, the export or the validation first',
  routing: 'send a kind of item to another role or step than the one it keeps going to',
  replan: 're-plan the criteria or the approach',
  split: 'move work out of this attempt',
  model: 'run a role at another work class',
  other: 'another change, said in its own words',
};

export const OUTCOMES = ['held', 'failed', 'not-applied', 'too-early', 'dropped'];
const FINAL = new Set(['held', 'failed', 'dropped']);
const OUTCOME_WORDS = { held: 'held', failed: 'did not hold: the cause came back', 'not-applied': 'was not carried out', 'too-early': 'too early to tell', dropped: 'dropped: the cause no longer applies', superseded: 'replaced by a later correction' };

const text = (v) => (typeof v === 'string' && v.trim() ? v.trim() : '');
const list = (v) => (Array.isArray(v) ? v.map((x) => (typeof x === 'string' ? x.trim() : '')).filter(Boolean) : []);
const later = (a, b) => String(a ?? '') > String(b ?? '');
const causeWords = (c) => CAUSES[c] ?? c;
const leverWords = (l) => LEVERS[l] ?? l;
const decisionAt = (state, id) => (state.strategy?.decisions ?? []).find((d) => d.id === id)?.at ?? null;

// ---- What a closure may cite ----

// Every review round handed, by reviewer id: when it was handed, whether it was recorded, died (never recorded, a later reviewer
// handed) or is still in flight, when it ended, and what its closure said it did not reach. A divided review is one round (review of
// the I-232 design, L1): `group` is the key the round count uses (`reviewGroup.id ?? bundle`), and any member's id covers it.
export function roundsOf(state) {
  const handed = (state.handoffs ?? []).filter((h) => h.role === 'reviewer').sort((x, y) => String(x.at).localeCompare(String(y.at)));
  const recorded = recordedRoundsOf(state);
  const groups = new Map();
  for (const h of handed) {
    const key = h.reviewGroup?.id ?? h.bundle;
    const g = groups.get(key) ?? { group: key, agents: [], at: h.at, bundles: [], mode: h.mode ?? null };
    g.agents.push(h.agent);
    g.bundles.push(h.bundle);
    groups.set(key, g);
  }
  const out = [];
  for (const g of groups.values()) {
    const reviews = recorded.filter((r) => (r.handoff ? g.bundles.includes(r.handoff) || r.handoff === g.group : g.agents.includes(r.reviewer)));
    const next = handed.find((h) => later(h.at, g.at) && !g.bundles.includes(h.bundle));
    const r = reviews.at(-1) ?? null;
    const status = r ? 'recorded' : next ? 'died' : 'in-flight';
    // A round's kind (full, delta, or a targeted review of a base merge's resolution, `merge`, I-233), so a merge round can be put
    // under the moving base: read from the recorded round, else its handoff; absent on ledgers that never wrote one.
    out.push({ group: g.group, agents: [...new Set(g.agents)], mode: r?.mode ?? g.mode ?? null, handedAt: g.at, status, endedAt: r ? r.at : next ? next.at : null, notReached: r ? unreachedOf(r.closure) : [], partial: r?.partial === true });
  }
  return out;
}

// Every ref a closure may cite besides rounds, with its time: findings (`<round>:<id>`), discovered issues (`D<n>`), decisions
// (`S<n>`, `A<n>`), base merges (`base:<n>`) and gate runs (`gate:<runId>`), each with a plain line for the bundle.
export function refsOf(state) {
  const out = new Map();
  const put = (ref, at, kind, line) => {
    if (!out.has(ref)) out.set(ref, { ref, at, kind, line });
  };
  for (const r of [...(state.reviews ?? [])].sort((x, y) => String(x.at).localeCompare(String(y.at)))) {
    const reviewer = r.closure?.reviewer ?? r.reviewer;
    for (const f of r.closure?.findings ?? []) if (f?.id) put(`${reviewer}:${f.id}`, r.at, 'finding', `${f.severity ?? '?'}${f.family ? `, ${f.family}` : ''}: ${String(f.summary ?? '').replace(/\s+/g, ' ').slice(0, 200)}`);
  }
  for (const d of state.discovered ?? []) put(d.id, d.at, 'discovered', String(d.summary ?? '').slice(0, 200));
  for (const d of state.strategy?.decisions ?? []) put(d.id, d.at, 'strategist decision', `${d.action}: ${String(d.rationale ?? '').split('\n')[0].slice(0, 160)}`);
  for (const d of state.decisions ?? []) put(d.id, d.approved?.at ?? d.createdAt ?? null, 'the person\'s decision', `${d.kind}${d.approved ? `, answered ${d.approved.choice ?? 'in their own words'}` : d.withdrawn ? ', withdrawn' : ', open'}: ${String(d.summary ?? '').slice(0, 160)}`);
  // Base merges recorded by `wf base merge` (and the delivery's), and those merged by hand the engine observed (`base.observed`, I-233),
  // by the one counter the ledger keeps for both (`n`): ledger order is the rule, so every reader names a merge alike. The fold
  // assigns `n` to every merge it reads, old ledgers included; the time order below is only a fallback for a state built without it.
  [...(state.baseMerges ?? []).map((b) => ({ ...b, how: b.delivery ? 'merged at delivery' : 'merged' })), ...(state.baseObserved ?? []).map((b) => ({ ...b, how: 'merged by hand' }))].sort((x, y) => (Number.isInteger(x.n) && Number.isInteger(y.n) ? x.n - y.n : String(x.at).localeCompare(String(y.at)))).forEach((b, i) => put(`base:${Number.isInteger(b.n) ? b.n : i + 1}`, b.at, 'base merge', `${b.repo ?? '?'}: ${b.commits ?? '?'} commit(s) from ${b.ref ?? 'the base'}, ${b.how}`));
  for (const g of state.gates ?? []) if (g.runId) put(`gate:${g.runId}`, g.at, 'gate run', `${g.status ?? 'finished'}`);
  for (const s of state.stops ?? []) if (s.runId) put(`gate:${s.runId}`, s.at, 'gate run', `stopped: ${String(s.reason ?? '').slice(0, 160)}`);
  return out;
}

// The known ref nearest to an unknown one (the longest shared beginning), to name in a refusal (review of the design, L3).
function nearest(ref, known) {
  let best = null;
  let len = 2;
  for (const k of known) {
    let n = 0;
    while (n < ref.length && n < k.length && ref[n] === k[n]) n++;
    if (n > len) {
      len = n;
      best = k;
    }
  }
  return best;
}

// ---- Corrections, as the ledger holds them ----

// Every correction the recorded decisions made, with what later decisions reported about it. A correction is open until a later
// decision reports it held, failed or dropped, or makes a new correction for the same cause (`superseded`, review of the design, M3).
export function corrections(state) {
  const all = [];
  for (const d of state.strategy?.decisions ?? []) {
    for (const r of Array.isArray(d.review) ? d.review : []) {
      const c = all.find((x) => x.key === r.correction);
      if (!c) continue;
      c.reviews.push({ decision: d.id, at: d.at, outcome: r.outcome, why: r.why ?? null, improvement: r.improvement ?? null });
      if (c.status === 'open' && FINAL.has(r.outcome)) Object.assign(c, { status: r.outcome, closedBy: d.id });
    }
    for (const e of Array.isArray(d.diagnosis) ? d.diagnosis : []) {
      if (!e.correction) continue;
      for (const c of all) if (c.status === 'open' && c.cause === e.cause) Object.assign(c, { status: 'superseded', closedBy: d.id });
      all.push({ key: `${d.id}:${e.cause}`, decision: d.id, at: d.at, cause: e.cause, lever: e.correction.lever, change: e.correction.change, what: e.what, rounds: e.rounds ?? [], refs: e.refs ?? [], status: 'open', reviews: [] });
    }
  }
  return all;
}

export const openCorrections = (state) => corrections(state).filter((c) => c.status === 'open');

// How many times in a row the corrections for a cause were reported not carried out, counting back from the latest report.
function notAppliedRun(all, cause) {
  const reports = all.filter((c) => c.cause === cause).flatMap((c) => c.reviews).sort((x, y) => String(x.at).localeCompare(String(y.at)));
  let n = 0;
  for (const r of [...reports].reverse()) {
    if (r.outcome !== 'not-applied') break;
    n++;
  }
  return n;
}

// The lines the owner, the roles and the next strategist read (`wf resume`, `wf status`, `wf signals`, bundles): one per open
// correction, in plain words, and each outcome reported once. No ids of causes or levers (review of the design, L2).
export function correctionLines(state) {
  const all = corrections(state);
  const out = [];
  for (const c of all.filter((x) => x.status === 'open')) {
    const early = c.reviews.filter((r) => r.outcome === 'too-early').length;
    const run = notAppliedRun(all, c.cause);
    out.push(`the strategist's correction in force since ${c.decision}, for "${causeWords(c.cause)}": ${c.change}${early ? `; ${early} later decision${early > 1 ? 's' : ''} found it too early to tell` : ''}${run >= 2 ? `; corrections for this were reported not carried out ${run} times in a row` : run === 1 ? '; the last decision reported it was not carried out' : ''}`);
  }
  for (const c of all.filter((x) => x.status !== 'open')) out.push(`${c.decision}'s correction for "${causeWords(c.cause)}" (${c.change.slice(0, 160)}): ${OUTCOME_WORDS[c.status]}${c.closedBy ? ` (${c.closedBy})` : ''}`);
  return out;
}

// What the implementers and reviewers are handed: the corrections in force, in plain words.
export const correctionsInForce = (state) => openCorrections(state).map((c) => ({ since: c.decision, about: causeWords(c.cause), change: c.change }));

// Review of the design (H2): a round or ref one decision put under one cause and another decision under a different one. A fact of
// the two ref sets, shown as information (never a refusal): the strategist reading it judges which reading is right.
export function causeOverlaps(state) {
  const ds = (state.strategy?.decisions ?? []).filter((d) => Array.isArray(d.diagnosis) && d.diagnosis.length);
  const out = [];
  for (let i = 1; i < ds.length; i++) {
    for (let j = 0; j < i; j++) {
      for (const x of ds[i].diagnosis) {
        for (const y of ds[j].diagnosis) {
          if (x.cause === y.cause) continue;
          const theirs = new Set([...(y.rounds ?? []), ...(y.refs ?? [])]);
          const shared = [...new Set([...(x.rounds ?? []), ...(x.refs ?? [])])].filter((r) => theirs.has(r));
          if (shared.length) out.push(`${ds[i].id} puts ${shared.join(', ')} under "${causeWords(x.cause)}", where ${ds[j].id} put ${shared.length > 1 ? 'them' : 'it'} under "${causeWords(y.cause)}"`);
        }
      }
    }
  }
  return out;
}

// ---- The closure's check ----

// The review rounds a closure accounts for: those recorded or died since the previous strategist decision (or since admission),
// by round group. Rounds in flight are outside it (review of the design, M2).
export function roundsToAccount(state) {
  const since = (state.strategy?.decisions ?? []).at(-1)?.at ?? '';
  return roundsOf(state).filter((r) => r.status !== 'in-flight' && later(r.endedAt, since));
}

// The problems of a closure's `diagnosis`, `progressed` and `review` (empty when there are none). Shape and refs are checked whenever
// they are given; coverage and the review of open corrections only when the handoff owes them (review of the design, M7).
export function diagnosisProblems(state, closure, { owed = false, inbox = () => false } = {}) {
  const p = [];
  const given = closure.diagnosis !== undefined || closure.review !== undefined || closure.progressed !== undefined;
  if (!owed && !given) return p;
  const rounds = roundsOf(state);
  const byAgent = new Map();
  for (const r of rounds) for (const a of r.agents) byAgent.set(a, [...(byAgent.get(a) ?? []), r]);
  const refs = refsOf(state);
  const known = [...byAgent.keys(), ...refs.keys()];
  const timeOf = (ref) => (byAgent.has(ref) ? byAgent.get(ref).map((r) => r.endedAt ?? r.handedAt).sort().at(-1) : refs.get(ref)?.at ?? null);
  const unknown = (xs, what) => {
    for (const x of xs) {
      if (byAgent.has(x) || refs.has(x)) continue;
      const near = nearest(x, known);
      p.push(`${what}: ${x} is not a review round, finding, discovered issue, decision, base merge or gate run of this attempt${near ? ` (nearest: ${near})` : ''}; the bundle's \`history\` lists every one`);
    }
  };
  const notRound = (xs, what) => {
    for (const x of xs) {
      if (byAgent.has(x)) continue;
      const near = nearest(x, [...byAgent.keys()]);
      p.push(`${what}: ${x} is not a reviewer handed this attempt${near ? ` (nearest: ${near})` : ''}`);
    }
  };
  // `diagnosis`
  const diagnosis = closure.diagnosis;
  if (owed && !Array.isArray(diagnosis)) p.push('`diagnosis` is required: a list (empty when nothing kept going wrong), one entry per cause of what kept going wrong, each { cause, what, rounds, refs, correction: { lever, change } } or with `settledBy`');
  const entries = Array.isArray(diagnosis) ? diagnosis : [];
  if (diagnosis !== undefined && !Array.isArray(diagnosis)) p.push('`diagnosis` must be a list');
  const seen = new Set();
  entries.forEach((e, i) => {
    const at = `diagnosis[${i}]`;
    if (!e || typeof e !== 'object' || Array.isArray(e)) return p.push(`${at} must be an object`);
    if (!CAUSES[e.cause]) p.push(`${at}.cause must be one of ${Object.keys(CAUSES).join(', ')}`);
    else if (seen.has(e.cause)) p.push(`${at}: the cause ${e.cause} is listed twice; one entry per cause (several loops of one cause are one entry)`);
    seen.add(e.cause);
    if (!text(e.what)) p.push(`${at}.what: in plain words, what kept going wrong (no ids: they go in \`rounds\` and \`refs\`)`);
    if (e.rounds !== undefined && !Array.isArray(e.rounds)) p.push(`${at}.rounds must be a list of reviewer ids`);
    if (e.refs !== undefined && !Array.isArray(e.refs)) p.push(`${at}.refs must be a list of refs`);
    if (!list(e.rounds).length && !list(e.refs).length) p.push(`${at} cites nothing: give the review rounds it cost (\`rounds\`) or what shows it (\`refs\`)`);
    notRound(list(e.rounds), `${at}.rounds`);
    unknown(list(e.refs), `${at}.refs`);
    const hasC = e.correction !== undefined;
    const hasS = e.settledBy !== undefined;
    if (hasC === hasS) p.push(`${at} needs exactly one of \`correction: { lever, change }\` (what changes in how the work runs) or \`settledBy\` (the decision that already deals with it)`);
    if (hasC) {
      const c = e.correction;
      if (!c || typeof c !== 'object' || !LEVERS[c.lever]) p.push(`${at}.correction.lever must be one of ${Object.keys(LEVERS).join(', ')}`);
      if (!text(c?.change)) p.push(`${at}.correction.change: in plain words, what the owner and the roles do differently from now on`);
    }
    if (hasS) {
      const s = text(e.settledBy);
      const when = s && (refs.get(s)?.kind === 'strategist decision' || refs.get(s)?.kind === 'the person\'s decision') ? refs.get(s).at : null;
      if (!when) p.push(`${at}.settledBy must name an earlier strategist decision (S<n>) or a decision of the person (A<n>) of this attempt`);
      else {
        // Review of the design (M5): what it settled came before it; something cited after it is the cause back, not settled.
        const cited = [...list(e.rounds), ...list(e.refs)].filter((x) => x !== s);
        const times = cited.map((x) => ({ x, t: timeOf(x) })).filter((y) => y.t);
        if (times.length && !times.some((y) => !later(y.t, when))) p.push(`${at}: nothing it cites comes before ${s}, which it says settled it`);
        const after = times.filter((y) => later(y.t, when)).map((y) => y.x);
        if (after.length) p.push(`${at}: it says ${s} settled it, and cites ${after.join(', ')} from after ${s}: that is the cause back, not settled (give a correction, or cite only what came before)`);
      }
    }
  });
  // `progressed`
  if (closure.progressed !== undefined && !Array.isArray(closure.progressed)) p.push('`progressed` must be a list of reviewer ids');
  const progressed = list(closure.progressed);
  notRound(progressed, 'progressed');
  for (const x of progressed) {
    for (const r of byAgent.get(x) ?? []) {
      // Review of the design (H3): `progressed` is for a round that did what it was handed; one that died or did not reach its scope
      // did not, and belongs to a diagnosis entry (for example cause review or tooling).
      if (r.status === 'died') p.push(`progressed: ${x} died before it recorded a closure; a round that ended unfinished belongs in a diagnosis entry`);
      else if (r.notReached.length || r.partial) p.push(`progressed: ${x} did not reach part of its scope (${r.notReached.slice(0, 2).join('; ').slice(0, 200) || 'kept from a reviewer that did not finish'}); it belongs in a diagnosis entry`);
    }
  }
  if (owed) {
    // Coverage: every round recorded or died since the previous decision is accounted for, by any member of its group.
    const cited = new Set([...entries.flatMap((e) => list(e?.rounds)), ...progressed]);
    for (const r of roundsToAccount(state)) if (!r.agents.some((a) => cited.has(a))) p.push(`review round ${r.agents.join(' / ')} (${r.status === 'died' ? 'died' : 'recorded'} since the previous decision) is in no diagnosis entry's \`rounds\` and not in \`progressed\`: every round since the previous decision is accounted for`);
  }
  // `review`
  const all = corrections(state);
  const open = all.filter((c) => c.status === 'open');
  if (closure.review !== undefined && !Array.isArray(closure.review)) p.push('`review` must be a list');
  const review = Array.isArray(closure.review) ? closure.review : [];
  const reviewed = new Map();
  review.forEach((r, i) => {
    const at = `review[${i}]`;
    if (!r || typeof r !== 'object') return p.push(`${at} must be an object`);
    const c = all.find((x) => x.key === text(r.correction));
    if (!c) return p.push(`${at}.correction: ${r.correction ?? '(none)'} is not a correction of this attempt${open.length ? ` (open: ${open.map((x) => x.key).join(', ')})` : ''}`);
    if (c.status !== 'open') return p.push(`${at}: ${c.key} is no longer open (${OUTCOME_WORDS[c.status]})`);
    if (reviewed.has(c.key)) return p.push(`${at}: ${c.key} is reviewed twice`);
    reviewed.set(c.key, r);
    if (!OUTCOMES.includes(r.outcome)) return p.push(`${at}.outcome must be one of ${OUTCOMES.join(', ')}`);
    if (r.refs !== undefined && !Array.isArray(r.refs)) p.push(`${at}.refs must be a list`);
    const rr = list(r.refs);
    unknown(rr, `${at}.refs`);
    if (['held', 'failed'].includes(r.outcome) && !rr.some((x) => later(timeOf(x), c.at))) p.push(`${at}: "${r.outcome}" needs at least one ref from after ${c.decision} (a round or an event since the correction that shows it)`);
    if (['not-applied', 'dropped'].includes(r.outcome) && !text(r.why)) p.push(`${at}.why: in plain words, why it ${r.outcome === 'dropped' ? 'no longer applies' : 'was not carried out'}`);
    if (r.improvement !== undefined) {
      if (r.outcome !== 'not-applied') p.push(`${at}.improvement is for a correction a workflow rule kept from being carried out (outcome not-applied)`);
      else if (!/^I-\d+$/.test(String(r.improvement)) || !inbox(String(r.improvement))) p.push(`${at}.improvement: ${r.improvement} is not an item of the improvement inbox (\`wf improve list\`; \`wf improve add\` records one)`);
    }
    // Review of the design (M4): a correction that did not hold is answered in the same closure: another lever, `settledBy`, or
    // the person.
    if (r.outcome === 'failed' && closure.action !== 'escalate' && !entries.some((e) => e?.cause === c.cause)) p.push(`${at}: ${c.decision}'s correction for "${causeWords(c.cause)}" did not hold; the diagnosis answers it with an entry for that cause (another correction, or \`settledBy\`), or the action is escalate`);
  });
  if (owed) for (const c of open) if (!reviewed.has(c.key)) p.push(`review: ${c.key} (${c.decision}'s correction for "${causeWords(c.cause)}": ${c.change.slice(0, 120)}) is open and has no review entry: held, failed, not-applied, too-early or dropped`);
  // Consistency: a correction reported held (or too early to tell) while this closure cites the same cause after it.
  for (const [key, r] of reviewed) {
    if (!['held', 'too-early'].includes(r.outcome)) continue;
    const c = all.find((x) => x.key === key);
    const e = entries.find((x) => x?.cause === c.cause);
    if (!e) continue;
    const after = [...list(e.rounds), ...list(e.refs)].filter((x) => later(timeOf(x), c.at));
    if (after.length) p.push(`review of ${key} says ${r.outcome}, and the diagnosis cites "${causeWords(c.cause)}" again in ${after.join(', ')} after it: say failed, or cite only what came before`);
  }
  return p;
}

// Review of the design (H1): the same cause met with the same change after that change came back. A design guard with no field
// case yet. Returns the refusal's words, or null. Never for an escalation (the person is every loop rule's backstop), never for the
// lever `other` (it names nothing to compare, M1), and never for a correction reported not carried out (it was never tried).
export function sameCourse(state, closure) {
  if (closure.action === 'escalate') return null;
  const all = corrections(state);
  const refs = refsOf(state);
  const rounds = roundsOf(state);
  const timeOf = (ref) => rounds.filter((r) => r.agents.includes(ref)).map((r) => r.endedAt ?? r.handedAt).sort().at(-1) ?? refs.get(ref)?.at ?? null;
  const reviewNow = new Map((Array.isArray(closure.review) ? closure.review : []).map((r) => [text(r?.correction), r?.outcome]));
  for (const e of Array.isArray(closure.diagnosis) ? closure.diagnosis : []) {
    const lever = e?.correction?.lever;
    if (!lever || lever === 'other') continue;
    for (const c of all.filter((x) => x.cause === e.cause && x.lever === lever)) {
      const outcome = reviewNow.get(c.key) ?? c.reviews.at(-1)?.outcome ?? (c.status === 'open' ? null : c.status);
      if (outcome === 'not-applied') continue;
      const cameBack = outcome === 'failed' || c.status === 'failed' || [...list(e.rounds), ...list(e.refs)].some((x) => later(timeOf(x), c.at));
      if (cameBack) return `${c.decision} met "${causeWords(e.cause)}" with "${leverWords(lever)}" (${c.change.slice(0, 160)}), and the cause came back after it; the same change again repeats the loop: choose another change to the flow for it, or escalate to the person`;
    }
  }
  return null;
}

// ---- The re-raised finding (I-234) ----

// A finding raised by a round handed after a strategist decision, with the family and the criterion (or invariant) of a finding
// that decision cited in its diagnosis, and no `sameCauseAs`: by the strategist's own grouping, the cause it accounted for came back,
// and no reviewer said so. A fact of labels and times; the strategist it hands judges whether it is the same cause.
export function reraised(state) {
  const ds = (state.strategy?.decisions ?? []).filter((d) => Array.isArray(d.diagnosis) && d.diagnosis.length);
  if (!ds.length) return [];
  const handedAt = new Map((state.handoffs ?? []).filter((h) => h.role === 'reviewer').map((h) => [h.bundle, h.at]));
  const findings = new Map();
  for (const r of recordedRoundsOf(state)) {
    const reviewer = r.closure?.reviewer ?? r.reviewer;
    for (const f of r.closure?.findings ?? []) if (f?.id) findings.set(`${reviewer}:${f.id}`, { ...f, ref: `${reviewer}:${f.id}`, handed: handedAt.get(r.handoff) ?? r.at });
  }
  // Review of 0.7.34 (M1, L8): the family and a criterion or invariant, both stated (a family alone is a label match nobody confirmed,
  // which never binds), and only a finding still open, as for `recurringCauses`.
  const anchor = (f) => text(f.criterion) || text(f.invariant);
  const key = (f) => `${text(f.family)}|${anchor(f)}`;
  const open = new Set(openAcrossRounds(state).filter((f) => {
    const x = dispositionOf(state, f.ref);
    return !x || x.choice === 'fixed';
  }).map((f) => f.ref));
  const out = [];
  const seen = new Set();
  for (const d of ds) {
    for (const e of d.diagnosis) {
      const cited = [...(e.refs ?? [])].map((r) => findings.get(r)).filter((f) => f && text(f.family) && anchor(f));
      if (!cited.length) continue;
      const keys = new Map();
      for (const f of cited) if (!keys.has(key(f))) keys.set(key(f), f);
      for (const f of findings.values()) {
        if (seen.has(f.ref) || !open.has(f.ref) || !anchor(f) || !text(f.family) || !later(f.handed, d.at) || sameCauseRefs(f).length || !keys.has(key(f))) continue;
        seen.add(f.ref);
        out.push({ again: f.ref, decision: d.id, cause: e.cause, like: keys.get(key(f)).ref });
      }
    }
  }
  return out;
}

export const reraisedLine = (r) => `${r.again} was raised after ${r.decision}, with the family and criterion of ${r.like}, which ${r.decision} accounted for as "${causeWords(r.cause)}", and no reviewer linked them: check whether that cause came back`;
