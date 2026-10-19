import { addValidation, correctValidation, correctionQuestionSteps } from './validation.mjs';
import { captureWarning } from './captures.mjs';
import { defaultHostId, detectOwner, findHost, fragment, hostChoice, hostIds, hostLabels, hostNames } from './hosts/index.mjs';
import { mkdirStateDirectory } from './state-folders.mjs';
import { closeFindingNotDefect, completeScopeTicket, deferFindings, moveOut, recordFixed, scopeRows, waiveFinding } from './scope-decisions.mjs';
import { observations, unreachedOf } from './review-policy.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import { refreshModels } from './models.mjs';
import { RULE_SHORT } from './leaving.mjs';
import { abandon, actor as actorOf, adopt, attemptForName, changedFiles, closeShipped, entry, hold, openState, release, resolveAttempt, setIntent } from './attempt.mjs';
import { baseLines, baseMerge, baseMovedForDelivery, baseStatus } from './base.mjs';
import { findRoot, loadConfig, repoDir, requireRoot } from './config.mjs';
import { exportAttempt, exportFile } from './export.mjs';
import { STOP_CLASSES, liveGate, runGate, runPrepared, runWithLease, stopGate } from './gate.mjs';
import { append, listAttempts, loadState, openEvidence } from './ledger.mjs';
import { canonical, touchesEvidence } from './paths.mjs';
import { openCount } from './improve.mjs';
import { reviewDivisionSummary } from './review-groups.mjs';
import { addLesson, applySnippet, exportPluginLessons, findLesson, isProjectWide, LESSON_FILE, lessonPrompts, lessonWarnings, loadLessons, mergeLessons, mergeSuggestions, moveLesson, recur, relevantLessons, reviewLessons, setLesson, lessonKey, totalRecurrence, mergeableIn, distinctLessons } from './lessons.mjs';
import { lessonStats } from './learning.mjs';
import { LinkRefused, changesOf, ledgerEmpty, lostLedgers, rebaseline, releaseAttempt, seal, setVerifyLevel, unlockEvidence, verifyAttempt } from './evidence.mjs';
import { acceptReview, amendCriteria, beyondAskedLine, closeImplementer, settleCapacity, designWarning, leftNotes, gateOrderCheck, batchCreate, batchEject, closeAfterHandoff, deliver, deliveredFiles, deliveryCaptures, RANK_WORDS, verifiedCaptures, exportScreenshots, freezeCriteria, handoff, narrowDelivery, needsShown, nextAction, nextDecision, orphanNext, orphansOf, outsideWarning, recordReview, recordShown, reopen, screenshotsExportDir, shownDraftFile, uncovered, withAttempt } from './lifecycle.mjs';
import { addDiscovered, channelOf, closeDiscovered, discoveredLine, openDiscovered, rateDiscovered } from './discovered.mjs';
import { detect, doctor, generatedStatus, refreshGenerated, register, registry, setEnabled, sync, writeDraft } from './onboard.mjs';
import * as secrets from './secrets.mjs';
import { report, toCsv, toHandoffCsv, toHtml, toJson, toText } from './telemetry.mjs';
import { impact } from './topology.mjs';
import { commentFile, hasTicket, limitItemsText, performTracker, publicAssetsProblem, recordSummary, recordTracker } from './tracker.mjs';
import { ENGINE_VERSION, WfError, compareVersions, parseArgs, parseVersion, refuse } from './util.mjs';
import { afterAnswer, approveFromQuestion, approveHint, approveInTerminal, correctionHint, decisionLine, optionLines, pendingDecisions, plainLabel, questionFor, withdrawDecision } from './approve.mjs';
import { logRefusal, readRefusals, refusalCounts } from './refusals.mjs';
import { recordStrategy, settleRoundQuestions, signalsReport, signalsText } from './strategy.mjs';
import { followAdapter, followLines } from './adapter-follow.mjs';
import { addTargets, admitPorts, portLines, targetLines } from './targets.mjs';
import { courseLines, pastEstimates } from './signals.mjs';
import { splitCommand } from './split.mjs';
import { deploymentLine } from './deployment-step.mjs';
import { productDecisionLines } from './product-decisions.mjs';
import { analysisLine, analysisText, closeAnalysis, latestAnalysis, recordAnalysis } from './analysis.mjs';

const help = () => `wf ${ENGINE_VERSION} — agentic-workflow

Onboarding
  wf install [--dir DIR]            link wf into ~/.local/bin
  wf init [--force]                 detect the project and draft .workflow/ (disabled)
  wf doctor [--no-steps] [--runtime ${hostChoice()}]
                                    check config, tools, secrets, skills; run light steps on a clean base
  wf enable | wf disable            turn the workflow on/off for this project
  wf sync                           regenerate role agents and vendored skills; remove an AGENTS.md block an older release wrote
  wf topology [--check]             show components and what the change touches; --check compares with the code
  wf skills update NAME --from DIR  replace a vendored skill (review and commit it, then wf sync)
  wf secrets status|init|set KEY|guide [KEY]

Work
  wf entry [--item ID] [--lane quick|standard] [--intent implementation|analysis] [--repos a,b] [--defer-heavy] [--issue-file F]
           [--target R=BRANCH] [--also-target R=BRANCH] [--port ATTEMPT --target R=BRANCH]
                                    --defer-heavy: its heavy steps run once in a batch's gate; only attempts admitted with it
                                    join \`wf batch create\` (decide before implementing: it is set at admission)
                                    --target: the repo is based on and delivered to BRANCH, not its configured base
                                    --also-target: also delivered to BRANCH, by a port \`wf deliver\` admits once this delivery is done
                                    --port: carry ATTEMPT's accepted change (its own commits, its criteria) to the --target branch
  wf target add R=BRANCH --reason "why" [--attempt ID]
                                    deliver this attempt to BRANCH too (a port, admitted once its own delivery is complete)
  wf plan --file plan.yaml | --from-agent PLANNER_ID
                                    freeze acceptance criteria and the plan (--from-agent: the planner's last YAML block)
  wf plan --check --file plan.yaml   the planner's dry run: every check wf plan runs, nothing recorded
  wf criteria amend --file f --reason "why" [--add-repo R]   (\`pass: [{ items, why, repos }]\` plans one pass of what does not block)
                                    --add-repo: a fix needs another repo; its worktree joins the attempt with the work items
                                    added scope without \`impact\` is shown to the next implementer as consumers to find
  wf discovered add --summary "..." [--severity high|medium|low] [--invariant "<which>"] [--kind defect|bookkeeping] [--where file:line] [--found-by ID] [--blocked-by W] | list
  wf discovered rate D1 --severity high|medium|low [--reason "why"]
                                    correct a rating (lowering records its reason; an invariant issue stays high)
  wf discovered close D1[,D2] --fixed SHA | --deferred [--reason "why"] [--person-directed "<their words>" | --person-said "<their words>"]
                                    by default only a low issue may wait, with the person's answer (one question per item)
  wf discovered close D1[,D2] --not-a-defect --reason "why it is not a defect" [--person-directed "<their words>"]
                                    it was never a defect: the person decides (one question per item), unless the project's \`leaving:\`
                                    lets the owner decide that level; a reviewer's \`verified-nonissue\` verdict closes it too;
                                    the claim and the reason stay in the record, the delivered comment does not list it
  wf handoff planner|implementer|reviewer|tester --agent ID [--work W1] [--sweep F] [--session SID] [--runtime ${hostChoice()}]
                                    --sweep (optional): a fix handoff names a pattern sweep per family of open findings
                                    --context "<text>" | --context-file F (planner, implementer): what the person asked or what the
                                    owner carries (a decision, what research found), recorded with the handoff and in its bundle;
                                    a reviewer is started blind and takes none
  wf handoff wait --agent ID [--minutes N]
                                    follow a launched role again to its end; N: return after that many more minutes from now
  wf handoff stop --agent ID [--reason "why"]
                                    end a launched role's whole process tree (reported only once it is gone); a fresh handoff takes over
  wf handoff close --agent ID [--outcome done|stopped|failed]
                                    an implementer finished: no review round starts while one is open
  wf handoff strategist --agent ID [--reason "what diverged"]
                                    the course diverged from what was predicted: the strategist reads the expectations beside
                                    what happened, the signals, findings by family and earlier decisions
  wf strategy record --closure F    the strategist's decision (action, rationale, a prediction); the engine applies split,
                                    delta-review and escalate; two missed predictions in a row make the next one an escalate
  wf split --items IDS --reason "why"
                                    move unstarted work items, criteria, observations (reviewer:F1) or discovered issues to a
                                    sibling attempt in the same batch (delivered together; \`wf batch create\` assembles it)
  wf signals [--json]               what the plan, the implementers and the reviewers expected beside what happened (files,
                                    rounds, minutes, each running role's elapsed time and last activity), rounds, findings,
                                    amendments, bundle size and the round count, where the strategist decides first (adapter \`strategy:\` block)
  wf models refresh --attempt ID    pin execution model/effort settings from the committed adapter base
  wf advance --once|--until-owner [--runtime ${hostChoice()}] [--max-steps N] [--single] [--reviewers 2|3]
                                    optional foreground review/gate runner; stops for owner decisions
  wf handoff run --agent ID [--detach]
                                    launch the existing ${hostNames()} handoff fresh, with engine-recorded prompt provenance;
                                    --detach returns once it has started its session (two roles at once); wf handoff wait follows it
                                    returns when the role ends, or once it passes its own estimate (it keeps running);
                                    --minutes N: your own expectation, for a role that states none
  wf handoff reviewer --agent ID --reason "why"
                                    hand the tree while an implementer is open; records the override
  wf impact run [--file plan.yaml | --query JSON]
                                    run the attempt's recorded impact queries (or a plan file's, or one) on the current tree
  wf validation add --steps IDs --criteria IDs --reason "why"
                                    add required committed checks without replacing admission checks
  wf validation correct --steps IDs --reason "why" [--criteria IDs]
                                    re-pin registered checks at the adapter repo's committed HEAD after a defect found in one
  wf captures import --from DIR | --file IMAGE [--criteria IDS] [--note "how they were made"]
                                    bring in screenshots made by hand on the committed tree (no gate step collects any); they
                                    join the gate's screenshots for that tree, recorded and protected by wf like a gate's
  wf check [--repo R]               light steps only, for the implementer; reused by the gate, never counts as one
  wf gate [--prepare-only] [--full] [--focused] [--rerun-failed] [--reason "why"]
                                    after a clean code review only (or after an evidence review's fixes by the implementers
                                    handed after it, or after a planned pass); --reason out of that order asks the person's \`wf approve\`
  wf gate quarantine --step ID --suite FILE --reason "why"
                                    a suite that failed in the last gate and that the delivery does not change: the person
                                    decides whether it is set aside for this delivery (one question)
  wf gate light-only --reason "why"   the person decides whether this delivery goes without its full test run: the gate
                                    then runs the light steps, and the delivered comment names the heavy ones left out
  wf run --lease NAME -- CMD...     run a command holding a machine-wide lease (docker, browser...)
  wf run --step ID                  run that gate step's declared \`prepare\` command (or its plugin's \`prepare\`) with the secrets the step uses
  wf base [merge] [--repo R]        how far each base moved; merge merges it into the worktrees
  wf stop --class major-finding|tree-change|owner-decision --reason "why"
                                    stop a running gate; records the class and the minutes discarded
  wf scope list                     every open review finding: blocks or observation, its family, where it went
  wf scope ticket --finding REVIEWER:F1[,D3] [--capture RAW.json] [--reason "why it waits"] [--ask FILE.json] [--person-directed "<their words>"]
                                    low items only: asks the person first; with their yes, create the ticket and record
                                    its raw tracker readback with --capture
  wf scope fixed --finding REVIEWER:F1 --commit SHA
                                    an observation this attempt fixed; the next reviewer verifies it
  wf scope defer --finding REVIEWER:F1[,D3] [--reason "why it waits"] [--ask FILE.json] [--person-directed "<their words>"]
                                    low observations and discovered issues left for later; one short question per item
  wf scope waive --finding REVIEWER:F1[,REVIEWER:F2] [--reason "why"] [--ask FILE.json] [--same-as A<n>] [--person-said "<their words>"]
                                    blocking findings set aside: the person's decision (\`wf approve\`), one question per
                                    finding; --same-as: a finding raised again about a gap the person already accepted in A<n>
  wf scope move --finding REVIEWER:F1 --sibling ATTEMPT
                                    hand a finding on code this attempt did not change to a sibling attempt of the batch
  wf scope not-a-defect --finding REVIEWER:F1[,REVIEWER:F2] --reason "why it is not a defect" [--person-directed "<their words>"]
                                    a finding that was never a defect closes as not one: the person's answer, one question per
                                    finding (their "no" sends it back to the fix round); the delivered comment lists nothing
  wf scope fix-all --person-said "<their words>"
                                    the person's "fix all", recorded once: no item is asked about leaving again
  wf decide --question "<as asked>" --options "<option 1> | <option 2>" --recommend "<what and why>"
            --basis "<what was traced, with the evidence>" --not-checked "<what was not>" --choice "<the option they chose>"
            --quote "<their words>" [--item REVIEWER:F1|D1 --premise holds] [--file F.json]
                                    record a product or design decision the person made outside the engine (the panel or the
                                    chat): a record, never a gate; their words proven theirs; shown in resume and every later bundle;
                                    --item/--premise holds: their answer that a reported item's premise holds sends it back to be fixed
  wf decide withdraw PD1 --reason "<what changed>"
                                    the analysis changed the picture: the decision stands withdrawn, and the person is asked again
  wf review --closure file.json     record the reviewer's closure
  wf handoff reviewer --agent ID [--single] [--reviewers 2|3] [--division FILE]
                                    automatically divide large separable flows; --single keeps one reviewer
  wf review parts                   inspect immutable current-group scoped reports before integration
  wf accept                         accept the review
  wf summary --file summary.md [--explain lines.json]
                                    the owner's plain-language summary for the delivered comment; --explain words
                                    known-limit items for the tester by ref ({ "<ref>": "<one plain line>" }, "" drops one)
  wf deliver [--summary-file F] [--explain lines.json]
                                    integrate every repo, then start the tracker handoff (every deferral listed first)
  wf deliver --acknowledge-adapter-state REPO:STATE
                                    the change is on the target branch but the delivery adapter reports another state (a failed check needs \`wf approve\`)
  wf deliver --repin-adapter [COMMIT] --reason "why"
                                    after a delivery adapter fault: read the delivery adapter from the base branch tip (shows, then the owner confirms with \`wf approve\`)
  wf shown --file shown.json        record that every delivered screenshot was shown in the chat, with its caption and anomalies
  wf deployment check | record --state deployed|deploying|failed|unknown --observed "..."
                                    when the project's delivery waits for the deployment (\`delivery.deployment\`): the delivery
                                    adapter's own check, or what you saw of the merged change where it deploys (read-only)
  wf deployment tested --observed "..." | --not-possible "<why>" | --failed "..."
                                    the fix tested where it runs, in product words (it goes on the ticket); then the \`deployed\` step
  wf deployment close --reason "why"   the deployment cannot be confirmed: the person decides whether the delivery closes without it
  wf delivery list                  every verified capture the handoff can draw from, the ticket's own first, and whether the set holds it
  wf delivery narrow --keep SHA,... | --file keep.json --reason "why" [--dry-run]
                                    once, before \`wf shown\`: choose the delivered set, from the set or from any verified capture (\`wf delivery list\`)
  wf tracker record --event E --capture file.json [--comments file.json] | wf tracker sync (tracker.via: api|cli|files)
  wf tracker record --event E --from-transcript   (tracker.via: connector: the readback from the owner's host transcript)
  wf tracker record --event E --agent-reported --file reported.json [--comment-file posted.md]   (connector, no host record)
  wf tracker mode api|cli|files|connector [--write]
                                    how wf reaches the tracker (all but connector: the engine records its own readback)
  wf improve add|list|show|next|close|review  plugin improvements: workflow findings, kept in your inbox outside every repo
                                    close --retire --reason "..." retires a check that caught nothing; review lists refusal ids and who cites them
  wf intent implementation --attempt ID --reason "why"
                                    upgrade an analysis attempt in place once the owner asks for the implementation
  wf analysis record --file analysis.yaml
                                    an analysis attempt: what the investigation found, an answer with its evidence per frozen
                                    criterion ({ summary, criteria: [{ id, answer, evidence: [{ kind, ref, result }] } | { id,
                                    unanswered }], findings, traced, notTraced, recommendation })
  wf analysis show [--all] [--json]   what the analysis found, for the person or a ticket (also once it is closed)
  wf analysis close --reason "what follows"
                                    finish an analysis with a recorded record; the planner of the item's next attempt is given it
  wf unlock --attempt ID            remove the evidence lock of an attempt whose owner process is gone (a live owner is refused)
  wf hold --reason "why" | wf release   (release asks the owner to confirm with \`wf approve\`)
  wf decisions [--all]              the owner's reserved decisions on the attempt, pending first
  --ask FILE.json                   on any command that needs the person's answer: the question's words, written before it
                                    is asked: { "context", "recommend": { "choice", "why" }, "technical", "items": { "<ref>":
                                    { "what", "fix" } } }; without it the command says what to write
  wf decisions withdraw ID --reason "what changed"
                                    take back a question whose subject changed (pending, or answered and not yet used)
  wf approve ID [--choice C]        the owner confirms a reserved decision in their own terminal
  wf approve ID --from-question     or the agent records the owner's answer that is exactly one option, as the harness
                                    recorded it: in its question panel; their chat reply to a message that asked exactly the
                                    decision's question and nothing else (a bare yes or no binds only there); or their reply
                                    that is exactly an option's label to a message that named the decision by its id
  wf approve ID --from-question --choice C --quote "their words"
                                    or the agent records its reading of the owner's answer in more words: the option their
                                    words choose (or other: their own words, recorded as theirs, to follow) and the words it
                                    relies on, verbatim from one of their messages in this session after the question existed
  wf lesson add|waive|recur|merge|distinct|move|set|apply|show|list|preview|review|export
                                    the project's lessons (.workflow/lessons/): capture, enforce, recurrence, merge lessons that describe one mistake
  wf reopen --item ID --reason "feedback" [--no-lesson "why"]
  wf adopt [--attempt ID | --item ID] take over an open attempt as the current chat (an owner session active in the last
                                    30 minutes needs the owner's \`wf approve\`)
  wf abandon --reason "why" [--acknowledge-integration REPO:STATE]
  wf close --shipped --reason "why"  close an attempt whose change is already on its target branches, without its acceptance (the owner's decision)
  wf batch create --members A,B | wf batch eject --batch B --member A [--drop-own-commits]
                                    members are accepted attempts admitted with --defer-heavy; the batch carries the checks
                                    each registered (\`wf validation add\`), required on the combined tree

Status
  wf resume [ITEM|ATTEMPT]          what to do next (the attempt of that item, else the one open here)
  wf status [--all] [--json]
  wf report [--all] [--json] [--idle-minutes N] [--csv FILE] [--handoffs-csv FILE] [--html FILE]
                                    phases, gates, review rounds, findings, tokens and cost per attempt
  wf refusals [--since ISO] [--json] refusals counted by the check that made them (measurement only)
  wf verify [--attempt ID | --all]  re-hash every recorded evidence file, check the chain and its anchor
  wf verify --accept-changes --reason "why"   show changed evidence files and accept them (recorded, shown everywhere)
  wf evidence list [--kind K] | wf evidence show PATH
                                    read an attempt's evidence (read-only; no shell command needs the folder name)
  wf evidence release [--attempt ID | --closed | --older-than DAYS] [--dry-run]
                                    delete closed attempts' evidence through the engine (protection lifted, tombstone kept)
  wf export [--out FILE] [--json]   one self-contained page for the attempt (a view of the evidence)
  wf export screenshots [--gate | --run RUN] [--to DIR]
                                    copy the delivered (or, --gate, the last gate's; --run, one run's or import-<n>'s) screenshots out of the evidence

Common options: --attempt ID, --json, --owner ID`;

const print = (options, human, data) => {
  if (options.json) process.stdout.write(`${JSON.stringify(data ?? human, null, 2)}\n`);
  else process.stdout.write(`${typeof human === 'string' ? human : JSON.stringify(human, null, 2)}\n`);
};

// 0.7.27 (I-192): a question the person has not answered is named where the owner reads what is next, with the form that asks
// it (an escalation is asked by the next step itself). Named failure (field): the agent reported a pending closure as
// "Remaining: workflow closure and cleanup", in its own words, and never asked it; the person's answer to that status was refused.
const unansweredLines = (s) => (['done', 'abandoned'].includes(s.phase) ? [] : pendingDecisions(s).filter((x) => x.kind !== 'escalation').map((d) => correctionQuestionSteps(d) ? `  ${d.id} (correcting the admission check ${correctionQuestionSteps(d).join(', ')}) is no longer asked: since 0.7.32 the reviewer judges corrections; run \`wf validation correct --steps ${correctionQuestionSteps(d).join(',')} --reason "<why>" --attempt ${s.id}\` again, which withdraws it, and the review that follows gives its verdict on the correction` : `  waiting on the person: ${d.id} is not answered. Ask it in your reply (a mention in your own words, such as what remains, does not ask it): quote "${questionFor(s, d)}" exactly with its options (${optionLines(d)}) and ask nothing else in that message; after they answer, ${afterAnswer(s, d)}`));

// An open attempt whose worktree folder is gone is shown as orphaned with its missing paths (orphansOf, orphanNext in
// lifecycle.mjs, where every next line is decided).
function orphanedSummary(root, s, gone) {
  const lines = [`${s.id}  ${s.item}  lane=${s.lane}  intent=${s.intent}  phase=${s.phase}  ORPHANED`, `  owner: ${s.owner}`];
  for (const [name, r] of Object.entries(s.repos)) lines.push(`  ${name}: ${r.worktree}${gone.some((m) => m.repo === name) ? '  (MISSING)' : ''} (base ${r.base.slice(0, 10)})`);
  if (s.activeHold) lines.push(`  HOLD: ${s.activeHold.reason}`);
  lines.push(...unansweredLines(s));
  lines.push(`  ORPHANED: worktree missing: ${gone.map((m) => m.worktree).join(', ')}; the evidence and the branch are intact`);
  lines.push(`  next: ${orphanNext(root, s, gone)}`);
  return lines.join('\n');
}

function summary(root, s, { base = null, resume = false } = {}) {
  const gone = orphansOf(s);
  if (gone.length) return orphanedSummary(root, s, gone);
  const lines = [`${s.id}  ${s.item}  lane=${s.lane}  intent=${s.intent}  phase=${s.phase}`, `  owner: ${s.owner}`];
  for (const [name, r] of Object.entries(s.repos)) lines.push(`  ${name}: ${r.worktree} (base ${r.base.slice(0, 10)})`);
  if (base) lines.push(...baseLines(base));
  // 0.7.30 (I-151, D60): the adapter the attempt follows on its base branch, and a tip it could not take.
  if (isOpen(s)) lines.push(...followLines(s, root));
  // 0.7.30 (I-201, D62): its own target, the port it is, and the branches it is also delivered to.
  try {
    lines.push(...targetLines(root, s));
  } catch {}
  if (s.activeHold) lines.push(`  HOLD: ${s.activeHold.reason}`);
  lines.push(...unansweredLines(s));
  // 0.7.31 (I-217, D65): the product decisions the person made outside the engine, with what each rests on.
  lines.push(...productDecisionLines(s));
  try {
    const all = loadLessons(root, { state: s });
    const lessonFiles = Object.keys(s.repos).flatMap((r) => {
      try {
        return changedFiles(s, r).filter((f) => LESSON_FILE.test(f)).map((f) => `${r}:${f}`);
      } catch {
        return [];
      }
    });
    if (lessonFiles.length) lines.push(`  lesson (covered): ${lessonFiles.join(', ')} (delivered with this attempt)`);
    if (all.length || s.lessons) {
      const by = (st) => all.filter((l) => l.status === st).length;
      lines.push(`  lessons: ${all.length} in the project (${by('enforced')} enforced, ${by('proposed')} proposed); this attempt: ${s.lessons?.recorded?.length ?? 0} recorded${s.lessons?.waived ? `, none needed ("${s.lessons.waived.reason}")` : ''}`);
    }
    for (const r of s.lessons?.recurred ?? []) lines.push(`  LESSON ${r.id} RECURRED (recurrence ${r.recurrence}): its mechanism failed${r.recurrence >= 2 ? '; `wf lesson review` proposes promoting it to a gate check' : ''}`);
    // 0.7.9 (D19): what learning did for this attempt, and lessons that describe one mistake (a merge to make here).
    const labelled = s.learning?.at(-1);
    if (labelled?.error) lines.push(`  learning: the classifier (${labelled.model ?? labelled.runtime}) gave no labels at acceptance (${labelled.error.slice(0, 160)}); lesson ranking is unchanged`);
    if (isOpen(s)) {
      // Proposed where the merge can be made (this attempt holds the repos and its acceptance does not stand), else for later.
      const merges = mergeSuggestions(root, { state: s });
      const here = merges.filter((g) => mergeableIn(root, s, g));
      const later = merges.filter((g) => !here.includes(g));
      const named = (gs) => gs.map((g) => g.join(' + ')).join('; ');
      if (here.length) lines.push(`  lessons describing one mistake (classifier): ${named(here)}: merge each into one lesson in this attempt (\`wf lesson merge <ids> --title "<the one mistake>" --attempt ${s.id}\`; reviewed and delivered with it), or \`wf lesson distinct <ids> --attempt ${s.id}\` if they are different mistakes`);
      if (later.length && !here.length) lines.push(`  lessons describing one mistake (classifier): ${named(later)}: merge them in an open attempt that holds their repos, before its review is accepted (\`wf lesson distinct <ids>\` if they are different mistakes)`);
    }
    if (!['done', 'abandoned'].includes(s.phase)) for (const p of lessonPrompts(s)) lines.push(`  lesson: ${p}${/reopens/.test(p) ? '; a finding about the workflow itself is a plugin improvement instead: `wf improve add ...`' : ''}`);
    // 0.7.11: generated files the project tracks and that are older than the installed plugin are named, with the fix.
    if (!['done', 'abandoned'].includes(s.phase)) {
      try {
        // Read only here (independent review of 0.7.11): `wf status` and `wf resume` write nothing; the handoff refreshes.
        const g = { trackedStale: generatedStatus(root).filter((x) => x.tracked).map((x) => x.file) };
        const blocks = generatedStatus(root).filter((x) => x.tracked && x.kind === 'block').map((x) => x.file);
        const roles = g.trackedStale.filter((f) => !blocks.includes(f));
        if (blocks.length) lines.push(`  ${blocks.map((f) => path.relative(root, f)).join(', ')} still hold${blocks.length === 1 ? 's' : ''} the agentic-workflow block an older release wrote (the rules now come from the plugin, ${ENGINE_VERSION}): run \`wf sync\` and commit the removal`);
        if (roles.length) lines.push(`  agentic-workflow files older than the installed plugin (${ENGINE_VERSION}): ${roles.map((f) => path.relative(root, f)).join(', ')}; run \`wf sync\` and commit them`);
      } catch {}
    }
    const inbox = openCount();
    if (inbox) lines.push(`  ${inbox} open plugin improvement(s) in the inbox (\`wf improve list\`)`);
  } catch {}
  for (const r of s.rebaselines ?? []) lines.push(`  EVIDENCE RE-BASELINED ${r.at} by ${r.by}: ${r.changes.length} file(s) changed outside wf were accepted ("${r.reason}"): ${r.changes.slice(0, 5).map((c) => `${c.kind} ${c.path}`).join(', ')}${r.changes.length > 5 ? ' …' : ''}`);
  const live = ['done', 'abandoned'].includes(s.phase) ? null : liveGate(root, s);
  if (live) {
    lines.push(`  gate running: ${live.runId} (pid ${live.pid})`);
    const clock = (sec) => (sec < 60 ? `${sec}s` : `${Math.floor(sec / 60)}m${String(sec % 60).padStart(2, '0')}s`);
    if (!live.running.length) lines.push(`    running: none${live.waiting.length ? '' : ' (waiting for a lease)'}`);
    for (const r of live.running) lines.push(`    running: ${r.id} (${clock(r.seconds)}${r.lastSeconds !== undefined ? ` of ~${r.lastSeconds < 1 ? 'under 1s' : clock(r.lastSeconds)} last time` : ''})${r.latest ? `\n      latest: ${r.latest}` : ''}`);
    // Named failure (I-113): the line said only "waiting for a lease". It names the lease, its holders and how capacity is raised.
    for (const w of live.waiting) lines.push(`    waiting: ${w.id} for lease ${w.lease} (${w.capacity} slot(s), all held) for ${w.seconds}s: ${w.text}`);
    lines.push(`    finished: ${live.finished.map((r) => `${r.id} ${r.status}${r.seconds !== null ? ` ${r.seconds}s` : ''}`).join(', ') || 'none yet'}`);
  }
  if (s.discovered?.length) {
    const open = openDiscovered(s);
    lines.push(`  discovered: ${open.length} open${open.length ? ` (${open.map((d) => d.id).join(', ')})` : ''} of ${s.discovered.length} (\`wf discovered list\`)`);
  }
  const watching = ['done', 'abandoned'].includes(s.phase) ? [] : observations(s);
  if (watching.length) lines.push(`  observations: ${watching.length} unresolved, delivery waits for them (${watching.slice(0, 6).map((f) => f.ref).join(', ')}${watching.length > 6 ? ', …' : ''}; \`wf scope list\`)`);
  for (const a of s.addedRepos ?? []) lines.push(`  repo added: ${a.repo} (${a.reason})`);
  // Named failure (I-113): a stopped run showed only "stopped"; the class and reason `wf stop` recorded were in the ledger and
  // the result, and nobody reading `wf status` or `wf resume` could tell a tree change from an owner decision.
  const ended = (r) => {
    if (r.status === 'stopped') {
      const stop = r.stop ?? s.stops?.filter((x) => x.runId === r.runId).at(-1);
      return stop ? `stopped (${stop.class ?? 'no class'}: ${stop.reason ?? 'no reason'})` : 'stopped (no reason recorded: not stopped with `wf stop`)';
    }
    return r.error ? `${r.status} (${r.error})` : r.status;
  };
  if (s.lastGate) lines.push(`  last gate: ${ended(s.lastGate)} (${s.lastGate.runId})`);
  for (const t of s.tracker.done) if (t.provenance === 'host-recorded') lines.push(`  tracker ${t.event}: readback host-recorded (the tracker's answer as the ${findHost(t.host?.runtime)?.label ?? 'harness'} host wrote it in the owner's transcript, not the agent; a process running as the same user could edit that file)`);
  // 0.7.30 (D63): how a readback is proven, never a nudge to another tracker route the project did not choose.
  for (const t of s.tracker.done) if (t.provenance === 'agent-reported, unverified') lines.push(`  tracker ${t.event}: readback agent-reported, unverified (recorded from the owner's session transcript instead, it is host-recorded: \`wf tracker record --event ${t.event} --from-transcript\`)`);
  if (s.checks?.length) lines.push(`  last check: ${ended(s.checks.at(-1))} (${s.checks.at(-1).runId}; light steps only, never counts as the gate)`);
  if (s.flaky?.length) lines.push(`  flaky: ${[...new Set(s.flaky.map((f) => `${f.step}${f.suites?.length ? ` (${f.suites.join(', ')})` : ''}`))].join(', ')} failed and then passed with the same inputs`);
  if (s.criteria && isOpen(s) && !s.accepted) {
    try {
      const w = outsideWarning(root, s);
      if (w) lines.push(`  warning: ${w}`);
    } catch {}
    const route = captureWarning(root, s); // I-94: criteria that need screenshots and no way to get them
    if (route) lines.push(`  warning: ${route}`);
  }
  if (s.delivery.narrowed && !s.delivery.screenshots) lines.push(`  delivered files narrowed from ${s.delivery.narrowed.from} to ${s.delivery.narrowed.to}: ${s.delivery.narrowed.reason} (${s.delivery.narrowed.by}, ${s.delivery.narrowed.at})`);
  if (s.phase === 'handoff-pending' && s.delivery.screenshots) lines.push(showBlock(root, s).trim().replace(/^/gm, '  ').replace(/^ {2}SHOW TO OWNER/, '  delivered screenshots — SHOW TO OWNER'));
  const delivered = s.delivery.completedAt ? deliveredFiles(s) : [];
  if (delivered.length) lines.push(`  delivered screenshots (${delivered.length}): ${s.delivery.exported ? `viewable copies in ${s.delivery.exported.dir}` : `copy them out to view: ${exportCommand(root, s)}`}`);
  if (s.phase === 'handoff-pending' && s.tracker.pending.some((a) => a.rendered === 'delivered')) lines.push(`  delivered comment: ${s.delivery.summary ? commentFile(root, s.id) : 'needs the owner\'s summary: `wf summary --file <summary.md>`'}`);
  // 0.7.27 (D42): the deployment confirmation the delivery waits for, as it stands.
  if (s.deployment?.owed) lines.push(`  ${deploymentLine(s)}`);
  // 0.7.31 (I-216, D67): what an analysis attempt recorded, and its close.
  if (latestAnalysis(s)) lines.push(`  ${analysisLine(s)}`);
  if (resume) {
    const last = s.exports?.filter((x) => !x.json).at(-1)?.file ?? (fs.existsSync(exportFile(root, s.id)) ? exportFile(root, s.id) : null);
    lines.push(`  export: ${last ?? 'none yet'}${last ? '' : ' (`wf export` writes one page for this attempt)'}`);
    const p = s.plan && typeof s.plan === 'object' ? s.plan : s.plan ? { summary: s.plan } : null;
    // An analysis hands no implementer (0.7.31, I-216): its plan owes neither section.
    const missing = p && s.intent !== 'analysis' ? ['contract', 'anchors'].filter((k) => p[k] === undefined) : [];
    if (missing.length) lines.push(`  warning: the frozen plan has no ${missing.join(' or ')} section, so implementers have none to follow`);
  }
  let past = [];
  if (s.criteria && s.intent === 'implementation' && s.lane !== 'batch' && !['done', 'abandoned'].includes(s.phase)) {
    try {
      const sig = signalsReport(root, s);
      lines.push('  course (expected against actual; no limit applies, the owner agent judges it at each round boundary):', ...courseLines(sig, { predictions: sig.strategy.decisions }).map((l) => `    ${l}`));
      past = pastEstimates(sig);
    } catch {}
  }
  // D9: the comparison reaches the line the owner agent acts on (final review of 0.7.0: it sat above it as a passive block).
  // 0.7.28 (I-210): when the course signals make the strategist the next step, that step is the line, with no "continue" offered
  // beside it (the owner judged "converging" six times in a ticket that handed no strategist in 47 rounds).
  const coursing = !live && !['done', 'abandoned'].includes(s.phase) && (() => { try { return Boolean(nextDecision(root, s).courseSignals?.length); } catch { return false; } })();
  const judge = past.length && !live && !coursing ? `past its own estimate: ${past.join('; ')}. Judge the course before the next step: continue, re-plan with a new expectation (\`wf criteria amend\` with \`expect\`), or hand the strategist what diverged (\`wf handoff strategist --agent <id> --reason "..."\`). Then: ` : '';
  lines.push(`  next: ${judge}${live ? withAttempt(root, s, 'a gate is running: wait for it to finish (or `wf stop --class major-finding|tree-change|owner-decision --reason "why"`); do not edit the worktrees or hand a reviewer the tree meanwhile; once it passes, the evidence review') : nextAction(root, s)}`);
  return lines.join('\n');
}

// What the owner must show in the chat and attach to the ticket, per delivered file; or why there is nothing.
const exportCommand = (root, s) => `\`wf export screenshots --attempt ${s.id} --to ${screenshotsExportDir(root, s.id)}\``;

function showBlock(root, s) {
  const set = s.delivery.screenshots;
  if (!set) return '';
  if (!set.screenshots.length) return `\nSHOW TO OWNER: no screenshots for ${s.item}: ${set.none}\n  (recorded; tell the owner this in the delivery report)`;
  const shown = s.delivery.shown?.screenshots ?? [];
  const n = s.delivery.narrowed;
  const narrowed = n ? `\n  narrowed from ${n.from} to ${n.to}${n.added?.length ? ` (${n.added.length} chosen from the verified captures)` : ''}: ${n.reason} (${n.by}, ${n.at})` : '';
  const rows = set.screenshots.map((f, i) => {
    const cap = shown.find((x) => x.sha256 === f.sha256)?.caption;
    const copy = s.delivery.exported?.files?.find((x) => x.sha256 === f.sha256)?.file;
    return `  ${i + 1}. ${copy ?? f.path}${copy ? '' : '  (evidence path: export a copy to view or upload it)'}\n     attach as: ${f.title}   sha256 ${f.sha256.slice(0, 12)}\n     ${cap ? `caption: ${cap}` : `proposed caption: ${f.proposed}  (refine it after viewing: which screen, which state)`}`;
  });
  const head = needsShown(s)
    ? `SHOW TO OWNER (${set.screenshots.length} delivered screenshot(s) for ${s.item}): display each image in the chat with its caption, then record it with \`wf shown --file <f>\` (edit ${shownDraftFile(root, s.id)}; view and upload the copies listed below, never the evidence files). Each is also uploaded to the ticket as a file: title = "attach as", subtitle = its caption.`
    : `delivered screenshots for ${s.item} (shown to the owner ${s.delivery.shown.at}):`;
  const an = s.delivery.shown && !s.delivery.shown.auto ? s.delivery.shown.anomalies : null;
  const anomalies = an ? `\n  anomalies: ${an.length ? an.map((a) => `${a.observation} [${a.screenshots.join(', ')}] → ${a.cause ? `cause: ${a.cause}` : `follow-up: ${a.followUp}`}`).join('; ') : 'none seen'}` : '';
  const view = `\n  to view them again (also after close): ${exportCommand(root, s)}`;
  // 0.7.26 (I-182): verified captures of the gates this handoff draws from that are not in its set, said while the set can still change.
  let others = '';
  if (needsShown(s) && !n) {
    try {
      const out = verifiedCaptures(root, s).filter((f) => f.rank > 2);
      if (out.length) others = `\n  ${out.length} more verified capture(s) are tagged for other tickets only and are not in this set; \`wf delivery list\` shows them, and \`wf delivery narrow --keep <sha256,...> --reason "why"\` may name any of them`;
    } catch {}
  }
  return `\n${head}${narrowed}\n${rows.join('\n')}${others}${anomalies}${view}`;
}

function gateText(result) {
  const rows = (result.plan?.steps ?? result.record?.steps ?? []).map((s) => {
    const d = s.decision ?? s.status;
    const extra = s.reason ? `  ${s.reason}` : s.durationMs !== undefined ? `  ${(s.durationMs / 1000).toFixed(1)}s${s.workers ? ` workers=${s.workers.n}(${s.workers.source})` : ''}${s.log && s.status === 'failed' ? `  log: ${s.log}` : ''}` : '';
    return `  ${d.padEnd(11)} ${s.id}${extra}`;
  });
  const focused = (result.record ?? result.plan)?.focused ? ' (focused: proof while repairing; acceptance and delivery need a gate without --focused)' : '';
  const stopped = result.record?.stop ? ` — stopped by the owner (${result.record.stop.class}: ${result.record.stop.reason})` : '';
  const waited = result.record?.leaseWaitSeconds >= 60 ? `; steps waited up to ${Math.round(result.record.leaseWaitSeconds / 60)} min for a lease other gates held (\`gate.leases\` sets the slots)` : '';
  const head = result.record ? `gate ${result.record.status}${stopped} (${result.record.runId})${focused}${waited}` : `gate plan${result.plan.full ? ' (full: the adapter changed)' : ''}${focused}`;
  const imp = result.plan?.impact ?? result.record?.impact;
  const impLine = imp && (imp.contractsChanged.length || imp.dependents.length) ? `\n  contracts changed: ${imp.contractsChanged.map((c) => c.contract).join(', ') || 'none'}; dependents pulled in: ${imp.dependents.join(', ') || 'none'}` : '';
  return `${head}${result.recovered ? `\n  recovered ${result.recovered.carried} finished step(s) from run ${result.recovered.runId} (runner died)` : ''}${impLine}\n${rows.join('\n')}`;
}

export async function main(argv) {
  // `wf run --lease docker -- <command...>`: everything after `--` is the command, untouched.
  const dd = argv.indexOf('--');
  const passthrough = dd >= 0 ? argv.slice(dd + 1) : [];
  if (dd >= 0) argv = argv.slice(0, dd);
  const [cmd, sub, ...rest] = argv;
  const { positional, options, repeated } = parseArgs(sub && !sub.startsWith('--') ? rest : argv.slice(1));
  const repeatedPaths = repeated.filter((k) => PATH_OPTIONS.includes(k));
  if (repeatedPaths.length) {
    process.stderr.write(`wf ${cmd}: ${repeatedPaths.map((k) => `--${k}`).join(', ')} given more than once; give each path once\n`);
    return 2;
  }
  if (!cmd || cmd === 'help' || options.help) {
    process.stdout.write(`${help()}\n`);
    return 0;
  }
  if (cmd === 'version' || cmd === '--version') {
    process.stdout.write(`${ENGINE_VERSION}\n`);
    return 0;
  }
  // The commands that decide something final re-hash every recorded file and every ledger entry first (accept, deliver,
  // verify, doctor, export); the others check presence, type, size and mode, re-hash a file whose stat signature changed,
  // and check the ledger's links and its last entry, and a file a command reads is checked against its recorded sha256 as it
  // is read (0.7.0, named failure: a read took 9 seconds on a 96 MB ledger). Every file a command writes into an attempt's
  // evidence is written and recorded in one transaction with its ledger entry (`recordedTogether`, 0.7.4, D15); sealing what
  // this process wrote when it ends is only the safety net.
  setVerifyLevel(FULL_VERIFY.has(cmd) ? 'full' : 'quick');
  try {
    return await dispatch(cmd, sub && !sub.startsWith('--') ? sub : null, positional, { ...options, _: passthrough });
  } catch (error) {
    if (error instanceof LinkRefused) {
      process.stderr.write(`wf ${cmd}: refused: ${error.message}\n  → a symlink or odd entry sits in the evidence or its anchor; \`wf verify --attempt <id>\` lists them, and nothing was changed through it\n`);
      return 75;
    }
    if (error instanceof WfError) {
      process.stderr.write(`wf ${cmd}: ${error.message}\n${error.hint ? `  → ${error.hint}\n` : ''}`);
      if (error.code === 75) logRefusal({ id: error.refusalId, cmd, sub: sub && !sub.startsWith('--') ? sub : null, attempt: options.attempt ?? null, message: error.message });
      return error.code;
    }
    throw error;
  } finally {
    try {
      seal(append);
    } catch (error) {
      process.stderr.write(`wf: evidence not recorded: ${error.message}\n`);
    }
  }
}

const FULL_VERIFY = new Set(['accept', 'deliver', 'verify', 'doctor', 'export']);

const WRITE_OPTIONS = ['out', 'csv', 'handoffs-csv', 'html', 'dir', 'to', 'root'];
const READ_OPTIONS = ['file', 'sweep', 'division', 'capture', 'explain', 'ask', 'comments', 'summary-file', 'closure', 'issue-file', 'from', 'comment-file', 'context-file'];
const PATH_OPTIONS = [...WRITE_OPTIONS, ...READ_OPTIONS];
const FOLDER_OPTIONS = new Set(['dir', 'to', 'root', 'from']);

// One path option, resolved as the OS will resolve it and refused when it is ambiguous: empty, a flag with no value, a
// NUL, a URL (`file://`, `https://`: never a path to node), a `~` the shell did not expand, a trailing slash on a file
// input, or anything in the evidence (written or read: another attempt's evidence is not an input either).
function resolvePathOption(k, v) {
  const bad = (why) => {
    throw new WfError(`--${k} ${JSON.stringify(v)}: ${why}`, { code: 2 });
  };
  if (v === true) bad('needs a path');
  const raw = String(v);
  if (!raw.trim()) bad('is empty');
  if (raw.includes('\0')) bad('contains a NUL character');
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) bad('looks like a URL; give a file path');
  if (/^~/.test(raw)) bad('starts with `~`, which only a shell expands; give the full path');
  if (touchesEvidence(raw)) bad(`is inside .wf-evidence/ (checked where it really points); ${WRITE_OPTIONS.includes(k) ? 'write outside it (the evidence is written only by wf itself)' : 'pass a file outside it'}`);
  // An input file may be posted to the tracker (a summary, a comment): a link at its name could point at any local
  // file (a key, an .env), so the file itself is required (0.4.0 review finding).
  const lst = (() => {
    try {
      return fs.lstatSync(raw.replace(/[\\/]+$/, ''));
    } catch {
      return null;
    }
  })();
  if (READ_OPTIONS.includes(k) && !FOLDER_OPTIONS.has(k) && lst?.isSymbolicLink() && !touchesEvidence(canonical(raw))) bad('is a symlink; give the file itself (an input is never read through a link)');
  const resolved = canonical(raw);
  if (touchesEvidence(resolved)) bad('resolves into .wf-evidence/');
  const st = fs.statSync(resolved, { throwIfNoEntry: false });
  if (READ_OPTIONS.includes(k)) {
    if (!FOLDER_OPTIONS.has(k) && /[\\/]$/.test(raw)) bad('ends with a slash but names a file');
    // 0.7.28 (I-213). Named failure (field): `wf criteria amend --file` with a path where no file was (an amendment moved
    // while its survey was being restated) threw the reader's stack trace (lifecycle.mjs:428 under 0.7.18), and the owner read
    // the engine's source to find out why. An input that is not there is refused here, for every command that reads one.
    if (!st && !FOLDER_OPTIONS.has(k)) bad(`is not there (no such file: ${resolved}); write the file first, or pass the path it was written to`);
    if (st && !(FOLDER_OPTIONS.has(k) ? st.isDirectory() : st.isFile())) bad(`is not a regular ${FOLDER_OPTIONS.has(k) ? 'folder' : 'file'}`);
  } else if (st && FOLDER_OPTIONS.has(k) !== st.isDirectory()) bad(FOLDER_OPTIONS.has(k) ? 'is not a folder' : 'is a folder; give a file path');
  return resolved;
}

// Lexically or where the OS resolves it, case and Unicode forms folded (engine/paths.mjs, shared with every caller).
const pathInEvidence = (p) => touchesEvidence(p);

const isOpen = (s) => !['done', 'abandoned'].includes(s.phase);

// With `tracker.via: api` the engine performs what a command queued and records its readback; otherwise a no-op.
async function trackerApi(root, id) {
  const cfg = loadConfig(root);
  if (!['api', 'cli', 'files'].includes(cfg.tracker.via)) return '';
  const r = await performTracker(root, cfg, loadState(root, id));
  let s = loadState(root, id);
  if (r.performed.length) s = await closeAfterHandoff(root, s);
  return `${r.performed.length ? `\ntracker: ${r.performed.join(', ')} performed ${{ api: 'through the API', cli: 'through `gh`', files: 'on the ticket files' }[cfg.tracker.via]} and read back${s.phase === 'done' ? '; attempt closed' : ''}` : ''}${r.note ? `\ntracker: ${r.note}` : ''}`;
}
// Base status is information: a failure to read it never fails the command.
function safeBase(root, s) {
  try {
    return baseStatus(root, s);
  } catch {
    return null;
  }
}

// `wf improve`: the user-level inbox of plugin improvements (engine/improve.mjs). Works anywhere; inside a project, its
// names are stripped from what is stored.
async function improveCommand(sub, positional, options) {
  const { addImprovement, closeImprovement, loadImprovements, nextImprovements, reviewRefusals } = await import('./improve.mjs');
  // 0.7.27 (I-193), named failure: items closed for a release still being prepared read "closed, fixed in 0.7.27" while the
  // published and running wf was 0.7.26, so a session concluded the fix was available, updated, and still met the old behaviour.
  // A fix in a release newer than this wf says that it is not in it.
  const unshipped = (v) => (parseVersion(v) && compareVersions(v, ENGINE_VERSION) > 0 ? `, not released or installed yet: this wf is ${ENGINE_VERSION}` : '');
  const show = (x) => `${x.id}  [${x.status}, ${x.class}${x.recurrence ? `, recurrence ${x.recurrence}` : ''}${x.version ? `, ${x.status === 'retired' ? 'retired' : 'fixed'} in ${x.version}${unshipped(x.version)}` : ''}]  ${x.title}${x.regressionOf ? `  (regression of ${x.regressionOf.id}${x.regressionOf.fixedIn ? ` fixed in ${x.regressionOf.fixedIn}${unshipped(x.regressionOf.fixedIn)}` : ''})` : ''}`;
  if (sub === 'add') {
    let names = [];
    const root = findRoot();
    if (root) {
      try {
        const cfg = loadConfig(root);
        names = [cfg.name, ...cfg.repos.map((r) => r.name), ...cfg.repos.map((r) => path.basename(path.resolve(root, r.path))), path.basename(root)];
      } catch {}
    }
    const { item, file } = addImprovement(options, names);
    print(options, `improvement ${item.id} recorded in your inbox (outside every repo): ${file}${item.regressionOf ? `\nregression of ${item.regressionOf.id}${item.regressionOf.fixedIn ? ` fixed in ${item.regressionOf.fixedIn}` : ''}: it goes to the top of \`wf improve next\`` : ''}\n  fix it in the plugin repo with a scenario test that reproduces it, then \`wf improve close ${item.id} --version X --test scenarios/<file>.test.mjs --fix "..."\``, item);
    return 0;
  }
  if (sub === 'list' || !sub) {
    const all = loadImprovements();
    print(options, all.length ? all.map(show).join('\n') : 'no plugin improvements in your inbox', all);
    return 0;
  }
  if (sub === 'next') {
    const [x] = nextImprovements();
    print(options, x ? `${show(x)}\n  what happened: ${x.what}${x.observedIn ? `\n  observed in: ${x.observedIn}` : ''}${x.quote ? `\n  in their words: "${x.quote}"` : ''}\n  fix it with a scenario test that fails without the fix, then \`wf improve close ${x.id} --version X --test scenarios/<file>.test.mjs --fix "..."\`` : 'nothing open', x ?? null);
    return 0;
  }
  if (sub === 'show') {
    const x = loadImprovements().find((i) => i.id === positional[0]);
    if (!x) throw new WfError(`no improvement ${positional[0] ?? ''}`);
    print(options, `${show(x)}\n  what happened: ${x.what}${x.observedIn ? `\n  observed in: ${x.observedIn}` : ''}${x.quote ? `\n  in their words: "${x.quote}"` : ''}${x.test ? `\n  test: ${x.test}` : ''}${x.retiredReason ? `\n  retired because: ${x.retiredReason}` : ''}${x.refusals?.length ? `\n  refusals: ${x.refusals.map((r) => (typeof r === 'string' ? r : `${r.id} ${r.count}`)).join(', ')}` : ''}`, x);
    return 0;
  }
  if (sub === 'close') {
    // `--retire I-3` parses as the flag's value; `--retire` before another option leaves the id positional.
    const id = positional[0] ?? (typeof options.retire === 'string' ? options.retire : undefined);
    const r = closeImprovement(id, options, { refusals: options.retire ? readRefusals() : [] });
    print(options, r.retired ? `${r.id} retired; history written to ${r.history} (commit it with the removal)\n  refusals recorded: ${r.refusals.length ? r.refusals.map((c) => `${c.id} ${c.count}`).join(', ') : 'none named (--refusal id,id would record their counts)'}` : `${r.id} closed; history written to ${r.history} (commit it with the fix)`, r);
    return 0;
  }
  if (sub === 'review') {
    const rows = reviewRefusals(refusalCounts(readRefusals({ since: options.since ?? null }))).filter((c) => options.uncited !== true || !c.citedBy.length);
    const cited = (c) => (c.citedBy.length ? `cited by ${c.citedBy.map((x) => `${x.id} (${x.status})`).join(', ')}` : 'NOT cited by any improvement or closure');
    print(options, rows.length ? `${rows.length} refusal id(s), most refusals first; ${rows.filter((c) => !c.citedBy.length).length} not cited by any improvement or closure (judge it: fix the check, or retire it with \`wf improve close <id> --retire --reason ...\`)\n${rows.map((c) => `${String(c.count).padStart(5)}  ${c.id}  (${c.attempts.length} attempt(s); last ${c.last})  ${cited(c)}\n       e.g. ${c.example}`).join('\n')}` : 'no refusals recorded', rows);
    return 0;
  }
  throw new WfError('usage: wf improve add|list|show|next|close|review');
}

async function dispatch(cmd, sub, positional, options) {
  // `wf` is the one command the evidence guard lets name .wf-evidence/. No option of it may write there, and an input
  // file is read only when it is a regular file outside the evidence (another attempt's evidence is not an input).
  // Every path option is resolved once here, through engine/paths.mjs, validated, and replaced by that resolved path:
  // what is checked is what every later open or write uses (never re-derived from the raw argument).
  for (const k of PATH_OPTIONS) {
    if (!(k in options)) continue;
    // Named failure I-82: inspect pagination shares --from with the guarded skills source path.
    if (k === 'from' && cmd === 'evidence' && sub === 'inspect') continue;
    options[k] = resolvePathOption(k, options[k]);
  }
  if (cmd === 'skills' && positional[0] !== undefined && (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(positional[0]) || positional[0].includes('..'))) throw new WfError(`invalid skill name \`${positional[0]}\`: letters, digits, dot, dash, underscore and colon only`);
  if (cmd === 'status' && options.quiet) {
    const root = findRoot();
    if (!root) return 3;
    try {
      return loadConfig(root).enabled ? 0 : 3;
    } catch {
      return 3;
    }
  }
  if (cmd === 'install') {
    const bin = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'wf');
    const dir = path.resolve(String(options.dir ?? path.join(process.env.HOME, '.local', 'bin')));
    mkdirStateDirectory(dir, { recursive: true });
    const link = path.join(dir, 'wf');
    if (fs.existsSync(link) || fs.lstatSync(link, { throwIfNoEntry: false })) fs.rmSync(link);
    fs.symlinkSync(bin, link);
    const onPath = (process.env.PATH ?? '').split(':').includes(dir);
    print(options, `linked ${link} -> ${bin}${onPath ? '' : `\n${dir} is not on PATH; add it to your shell profile`}`);
    return 0;
  }
  if (cmd === 'init') {
    const root = path.resolve(options.root ?? process.cwd());
    const detected = detect(root);
    const file = writeDraft(root, detected, { force: options.force === true });
    register(root, false);
    print(options, `drafted ${file} (disabled)${detected.compose.length ? `\n  docker compose: ${detected.compose.join(', ')} (steps using it should hold the \`docker\` lease)` : ''}\n  repos: ${detected.repos.map((r) => `${r.name}@${r.base} [${r.packages.map((p) => p.path).join(', ')}]`).join('; ')}\n  steps: ${detected.steps.map((s) => s.id).join(', ') || 'none detected'}\n  components: ${detected.components.map((c) => `${c.id} (${c.kind})`).join(', ')}\n  secrets: ${detected.secrets.filter((s) => s.usedBy.length).map((s) => `${s.key} (${s.kind}, used by ${s.usedBy.join(', ')})`).join(', ') || 'none a detected step uses'}${detected.secrets.some((s) => !s.usedBy.length) ? ` (not catalogued: ${detected.secrets.filter((s) => !s.usedBy.length).map((s) => s.key).join(', ')})` : ''}${detected.notes.map((n) => `\n  note: ${n}`).join('')}\nnext: review the draft with the user (where the tasks live and how wf reaches them: see the onboard skill; \`wf doctor\` says what is verifiable for that choice), commit .workflow/ on the base branch and push it, then \`wf doctor\` and \`wf enable\``, { file, detected });
    return 0;
  }
  if (cmd === 'report') {
    const roots = options.all ? registry().projects.map((p) => p.root).filter((r) => fs.existsSync(r)) : [requireRoot()];
    const idle = options['idle-minutes'] === undefined ? undefined : Number(options['idle-minutes']);
    if (idle !== undefined && !(idle > 0)) throw new WfError('--idle-minutes must be a positive number');
    let rows = report(roots, { home: process.env.WF_HOME ?? os.homedir(), ...(idle ? { idleMinutes: idle } : {}) });
    // --attempt narrows the report to that attempt, or to the attempts of an item, named in any case as `wf resume` takes it
    // (0.7.6: it was ignored, so every attempt was printed and the first read as the one asked for).
    if (options.attempt) {
      const want = String(options.attempt).toLowerCase();
      rows = rows.filter((r) => r.id.toLowerCase() === want || String(r.item ?? '').toLowerCase() === want);
      if (!rows.length) throw new WfError(`no attempt ${options.attempt} to report`, { hint: 'see `wf status --all`' });
    }
    if (options.csv) fs.writeFileSync(String(options.csv), toCsv(rows));
    if (options['handoffs-csv']) fs.writeFileSync(String(options['handoffs-csv']), toHandoffCsv(rows));
    if (options.html) fs.writeFileSync(String(options.html), toHtml(rows));
    const files = [options.csv, options['handoffs-csv'], options.html].filter(Boolean);
    if (options.json) {
      process.stdout.write(`${JSON.stringify(toJson(rows), null, 2)}\n`);
      return 0;
    }
    print(options, files.length ? `wrote ${files.join(' and ')} (${rows.length} attempt(s))` : toText(rows));
    return 0;
  }
  if (cmd === 'status' && options.all) {
    const out = [];
    for (const p of registry().projects) {
      if (!fs.existsSync(p.root)) continue;
      for (const id of listAttempts(p.root)) {
        // Named failure (I-78): an attempt whose ledger holds no entry has no state to list; it is shown as damaged, with the command that names why.
        if (ledgerEmpty(p.root, id)) {
          out.push({ project: path.basename(p.root), root: p.root, id, item: null, phase: 'ledger empty', hold: null, damaged: true, next: `\`wf verify --attempt ${id}\` names what happened to its ledger` });
          continue;
        }
        const s = loadState(p.root, id);
        if (['done', 'abandoned'].includes(s.phase)) continue;
        const gone = orphansOf(s);
        out.push({ project: path.basename(p.root), root: p.root, id, item: s.item, phase: s.phase, hold: s.activeHold?.reason ?? null, ...(gone.length ? { orphaned: gone } : {}), next: nextAction(p.root, s) });
      }
    }
    print(options, out.length ? out.map((o) => `${o.project}  ${o.id}  ${o.damaged ? 'DAMAGED: ledger empty' : o.phase}${o.orphaned ? '  ORPHANED' : ''}${o.hold ? `  HOLD: ${o.hold}` : ''}\n  next: ${o.next}`).join('\n') : 'no open attempts in any enabled project', out);
    return 0;
  }

  if (cmd === 'improve') return improveCommand(sub, positional, options);
  if (cmd === 'refusals') {
    const counts = refusalCounts(readRefusals({ since: options.since ?? null }));
    if (options.json) return print(options, counts, counts), 0;
    print(options, counts.length ? counts.map((c) => `${String(c.count).padStart(5)}  ${c.id}  (${c.attempts.length} attempt(s); last ${c.last})\n       e.g. ${c.example}`).join('\n') : 'no refusals recorded');
    return 0;
  }
  const root = requireRoot(options.root);
  switch (cmd) {
    case 'skills': {
      if (sub !== 'update' || !positional[0] || !options.from) throw new WfError('usage: wf skills update NAME --from <folder with SKILL.md>');
      const src = path.resolve(String(options.from));
      if (!fs.existsSync(path.join(src, 'SKILL.md'))) throw new WfError(`${src} has no SKILL.md`);
      const dest = path.join(root, '.workflow', 'skills', positional[0]);
      fs.rmSync(dest, { recursive: true, force: true });
      fs.cpSync(src, dest, { recursive: true });
      print(options, `copied ${src} to ${path.relative(root, dest)}; review the diff, commit it, then \`wf sync\``);
      return 0;
    }
    case 'models': {
      if (sub !== 'refresh') throw new WfError('usage: wf models refresh --attempt ID');
      const r = refreshModels(root, options);
      print(options, 'execution settings ' + (r.changed ? 'refreshed' : 'unchanged') + ': ' + r.from.slice(0, 12) + ' -> ' + r.to.slice(0, 12) + '; admission rules unchanged; create fresh handoffs', { from: r.from, to: r.to, changed: r.changed });
      return 0;
    }
    case 'doctor': {
      const r = await doctor(root, { runSteps: options['no-steps'] !== true, ...(options.runtime ? { runtime: options.runtime } : {}), ...(options.attempt ? { attempt: options.attempt } : {}) });
      const lines = [];
      for (const section of ['config', 'tools', 'secrets', 'skills', 'connectors', 'steps', 'protection', 'warnings']) {
        for (const item of r[section]) lines.push(`${item.warn ? '!' : item.ok ? '✓' : '✗'} ${section === 'warnings' ? 'warning' : section}: ${item.check ?? item.tool ?? item.key ?? item.skill ?? item.step ?? item.connector}${item.runtime ? ` (${item.runtime})` : ''}${item.problem ? ` — ${item.problem}` : ''}${item.kind ? ` [${item.kind}]` : ''}${item.fix ? `\n    fix: ${item.fix}` : ''}${item.log ? `\n    log: ${item.log}` : ''}${item.note ? `\n    ${item.note}` : ''}`);
      }
      print(options, `${lines.join('\n')}\n${r.ok ? `doctor: all checks passed${r.warnings.length ? ` (${r.warnings.length} warning(s))` : ''}` : 'doctor: problems found'}`, r);
      return r.ok ? 0 : 1;
    }
    case 'enable':
    case 'disable': {
      setEnabled(root, cmd === 'enable');
      // Name only the changed files that live inside a repo; a multi-repo root is not one.
      const cfgNow = loadConfig(root);
      const repoDirs = cfgNow.repos.map((r) => fs.realpathSync(path.resolve(root, r.path)));
      const changed = [path.join(root, '.workflow', 'project.yaml'), ...(cmd === 'enable' ? sync(root) : [])].map((f) => (fs.existsSync(f) ? fs.realpathSync(f) : f));
      const committable = [...new Set(changed.filter((f) => repoDirs.some((d) => f === d || f.startsWith(d + path.sep))))];
      print(options, `agentic-workflow ${cmd}d for ${root}\ncommit so every checkout sees it:\n${committable.map((f) => `  ${path.relative(root, f)}`).join('\n')}`);
      return 0;
    }
    case 'sync': {
      const files = sync(root);
      const roles = files.changedRoles ?? [];
      const note = roles.length ? `\nrole file(s) changed: ${roles.map((c) => `${path.relative(root, c.file)}${c.removed ? ' (removed)' : c.created ? ' (new)' : ''}`).join(', ')}\n  ${hostLabels(' and ')} read agent files when a session starts: a session that was already running keeps the old roles, so the bundle of a changed role points it at the current file, which it reads first; no restart is needed.` : '\nno role file changed';
      // 0.7.25: the block removals and the files regenerated are told apart (0.7.24 said every file it wrote had held a block).
      const removed = files.blocksRemoved ?? [];
      const generated = files.filter((f) => !removed.includes(f));
      print(options, `${removed.length ? `removed the agentic-workflow block an older release wrote from ${removed.length} file(s); commit the removal (the rules now come from the plugin):\n${removed.map((f) => `  ${path.relative(root, f)}`).join('\n')}` : 'no instruction file holds an agentic-workflow block'}${generated.length ? `\nwrote ${generated.length} generated file(s):\n${generated.map((f) => `  ${path.relative(root, f)}`).join('\n')}` : ''}${note}`, files);
      return 0;
    }
    case 'topology': {
      const cfg = loadConfig(root);
      if (options.check) {
        const found = detect(root).components;
        const key = (c) => `${c.repo}/${c.package ?? '.'}`;
        const have = new Map(cfg.components.map((c) => [key(c), c]));
        const seen = new Map(found.map((c) => [key(c), c]));
        const drift = [
          ...found.filter((c) => !have.has(key(c))).map((c) => `new in the code: ${key(c)} (${c.kind})`),
          ...cfg.components.filter((c) => !seen.has(key(c))).map((c) => `in the adapter but not found: ${c.id} (${key(c)})`),
          ...found.filter((c) => have.has(key(c)) && have.get(key(c)).kind !== c.kind).map((c) => `${key(c)} looks like ${c.kind}, adapter says ${have.get(key(c)).kind}`),
          ...found.flatMap((c) => (c.provides ?? []).filter((p) => !(have.get(key(c))?.provides ?? []).some((q) => q.spec === p.spec)).map((p) => `${key(c)} has an unlisted contract ${p.spec}`)),
        ];
        print(options, drift.length ? drift.join('\n') : 'components match the code', drift);
        return drift.length ? 1 : 0;
      }
      let current = null;
      try {
        const s = openState(root, options);
        const { changedFiles } = await import('./attempt.mjs');
        current = impact(cfg, Object.fromEntries(Object.keys(s.repos).map((r) => [r, changedFiles(s, r)])));
      } catch {}
      const lines = cfg.components.map((c) => `${c.id} (${c.kind}) in ${c.repo}${c.package ? `/${c.package}` : ''}${c.provides?.length ? `  provides ${c.provides.map((p) => p.spec).join(', ')}` : ''}${c.dependsOn?.length ? `  depends on ${c.dependsOn.map((d) => `${d.component} via ${d.via ?? '?'}`).join(', ')}` : ''}`);
      if (current) lines.push(`current change touches: ${current.touched.join(', ') || 'nothing mapped'}; dependents: ${current.dependents.join(', ') || 'none'}`);
      print(options, lines.join('\n'), { components: cfg.components, current });
      return 0;
    }
    case 'secrets': {
      const cfg = loadConfig(root);
      if (sub === 'status' || !sub) {
        const rows = secrets.status(root, cfg);
        const needed = rows.filter((r) => r.needed || r.state === 'filled');
        const unused = rows.filter((r) => !r.needed && r.state !== 'filled').map((r) => r.key);
        const text = [...needed.map((r) => `${r.state === 'filled' ? '✓' : '✗'} ${r.key.padEnd(28)} ${r.kind.padEnd(9)} ${r.state}${r.purpose ? `  ${r.purpose}` : ''}`), ...(unused.length ? [`not needed by any step: ${unused.join(', ')}`] : [])];
        const missing = needed.filter((r) => r.state !== 'filled');
        print(options, rows.length ? `${text.join('\n')}${missing.length ? '' : '\nnothing to enter'}` : 'no secrets catalogued (.workflow/secrets.yaml)', rows);
        return missing.length ? 1 : 0;
      }
      if (sub === 'init') {
        const done = secrets.init(root, cfg);
        print(options, done.length ? done.map((d) => `✓ ${d.key}: ${d.action}`).join('\n') : 'nothing to generate or copy', done);
        return 0;
      }
      if (sub === 'set') {
        const key = positional[0];
        if (!key) throw new WfError('usage: wf secrets set KEY  (value from a hidden prompt or stdin)');
        const r = await secrets.set(root, cfg, key);
        print(options, `✓ ${key} stored${r.verified === true ? ' and verified' : r.verified === false ? ', but its verify check failed' : ''}`, r);
        return r.verified === false ? 1 : 0;
      }
      if (sub === 'guide') {
        await secrets.guide(root, cfg, positional[0]);
        return 0;
      }
      throw new WfError(`unknown: wf secrets ${sub}`);
    }
    case 'entry': {
      const created = entry(root, { ...options, deferHeavy: options['defer-heavy'] === true });
      const api = await trackerApi(root, created.id);
      const s = loadState(root, created.id);
      print(options, `${summary(root, s)}${api}`, s);
      return 0;
    }
    case 'plan': {
      if (options.check) {
        const r = freezeCriteria(root, options);
        if (r.verdict) {
          print(options, `the ${r.verdict === 'agreed' ? 'agreement' : 'objections'} would be recorded; nothing was recorded`, r);
          return 0;
        }
        print(options, `the plan would be accepted: ${r.criteria} criteria, ${r.work} work item(s)${r.impact ? ', the impact analysis checks out (queries re-run)' : ''}; nothing was recorded`, r);
        return 0;
      }
      const s = freezeCriteria(root, options);
      if (s.panelRecorded) {
        const r = s.panelRecorded;
        const what = { draft: `seat ${r.seat}'s draft`, merged: `the merged plan (round ${r.round}, ${r.disagreements?.length ?? 0} disagreement(s) settled)`, objected: `seat ${r.seat}'s objections to round ${r.round} (${r.objections?.length ?? 0})`, agreed: `seat ${r.seat}'s agreement with round ${r.round}` }[r.type];
        print(options, `planning panel: ${what} recorded for ${s.state.id}.\nnext: ${nextAction(root, s.state)}`, r);
        return 0;
      }
      const loose = uncovered(s);
      const sections = s.plan && typeof s.plan === 'object' ? Object.keys(s.plan) : [];
      const beyond = beyondAskedLine(s.plan);
      print(options, `criteria frozen (${s.criteria.length}): ${s.criteria.map((c) => c.id).join(', ')}\nplan sections: ${sections.join(', ') || 'none'}${s.planSource?.transcript ? ` (from ${s.planSource.agent}'s transcript)` : ''}${beyond ? `\n${beyond}` : ''}${s.work ? `\nwork items (${s.work.length}): ${s.work.map((w) => `${w.id} [${w.class}] ${w.criteria.join(',')}`).join('; ')}` : ''}${loose.length ? `\nnote: no work item covers ${loose.join(', ')}` : ''}\nnext: ${nextAction(root, s)}`, s);
      return 0;
    }
    case 'impact': {
      if (sub !== 'run') throw new WfError('usage: wf impact run [--attempt ID] [--file plan.yaml | --query JSON]');
      const { allRecordedQueries, runQuery } = await import('./impact.mjs');
      const s = openState(root, options);
      const cfg = loadConfig(root);
      let queries = allRecordedQueries(s);
      let recordedHits = {};
      if (typeof options.query === 'string') {
        // One query as JSON, for a planner (read-only, so it writes no draft file) checking a count before recording it.
        let q;
        try {
          q = JSON.parse(options.query);
        } catch (error) {
          throw new WfError(`--query must be one query as JSON ({ "pattern", "kind", "repo", "paths", "exclude" }): ${error.message}`);
        }
        const { validateQueryShape } = await import('./impact.mjs');
        const problems = validateQueryShape({ id: 'query', ...q }, cfg);
        if (problems.length) throw new WfError(problems.join('; '));
        queries = { [q.id ?? 'query']: { id: 'query', ...q } };
        recordedHits = {};
      } else if (options.file) {
        const text = fs.readFileSync(String(options.file), 'utf8');
        const { YAML } = await import('./util.mjs');
        const fenced = text.match(/```(?:ya?ml|json)?\s*\n([\s\S]*?)\n```/);
        const doc = String(options.file).endsWith('.json') ? JSON.parse(fenced ? fenced[1] : text) : YAML.parse(fenced ? fenced[1] : text);
        queries = Object.fromEntries([...(doc?.survey?.queries ?? []), ...(doc?.impact?.queries ?? [])].filter((q) => q?.id).map((q) => [q.id, q]));
        recordedHits = Object.fromEntries(Object.values(queries).map((q) => [q.id, q.hits]));
      } else {
        for (const [id, r] of Object.entries(s.impact?.results ?? {})) recordedHits[id] = r.hits;
        for (const a of s.impact?.addenda ?? []) for (const [id, r] of Object.entries(a.results ?? {})) recordedHits[id] = r.hits;
      }
      if (!Object.keys(queries).length) throw refuse(`${s.id} has no recorded impact queries${options.file ? ' in that file' : ''}`);
      const out = [];
      for (const [id, q] of Object.entries(queries)) {
        const r = runQuery(root, cfg, s, q);
        out.push({ id, recorded: recordedHits[id] ?? null, hits: r.hits, unit: r.unit, files: r.files, skipped: r.skipped, refs: r.refs });
      }
      print(options, out.map((x) => `${x.id}: ${x.hits} ${x.unit}${x.recorded === null || x.recorded === undefined ? '' : x.recorded === x.hits ? ' (as recorded)' : ` (recorded ${x.recorded})`} at ${Object.entries(x.refs).map(([n, ref]) => `${n}@${ref.slice(0, 10)}`).join(', ')}${x.files.length ? `\n    ${x.files.join('\n    ')}` : ''}${x.skipped.length ? `\n    skipped (binary): ${x.skipped.join(', ')}` : ''}`).join('\n'), out);
      return 0;
    }
    case 'validation': {
      if (sub !== 'add' && sub !== 'correct') throw new WfError('usage: wf validation add --steps IDs --criteria IDs --reason why | wf validation correct --steps IDs --reason why [--criteria IDs]');
      const s = await (sub === 'correct' ? correctValidation : addValidation)(root, options);
      // 0.7.32 (D78): an admission check corrected is judged by the review that follows, never asked of the person.
      const last = sub === 'correct' ? s.validationCorrections?.at(-1) : null;
      const admitted = (last?.from ?? []).filter((x) => x.admission).map((x) => x.id);
      // 0.7.33 (I-223): a file an earlier pin covered and the corrected `reads` does not is said here, as the reviewer is handed it.
      const dropped = [...new Set((last?.readsDropped ?? []).map((x) => x.step))].map((step) => `the corrected \`reads\` of ${step} no longer covers ${(last.readsDropped ?? []).filter((x) => x.step === step).map((x) => `${x.files.map((f) => f.path).join(', ')}, which ${x.against === 'original' ? 'the admission original' : 'the previous correction'} covered`).join(', and ')}`);
      print(options, admitted.length
        ? `admission check ${admitted.join(', ')} corrected at ${String(last.commit).slice(0, 10)} (the original stays in the record, pinned at ${[...new Set(last.from.filter((x) => x.admission).map((x) => String(x.commit).slice(0, 10)))].join(', ')}); no question to the person: the review that follows judges the correction (its bundle has the admission original, the previous correction and the corrected definition, decoded), then the full gate${last.decision ? `; recorded under the person's answer ${last.decision}` : ''}. ${dropped.length ? `${dropped.join('; ')}: the review that follows judges it as a coverage loss unless the test code it held is now in the plugin or in a declared file. ` : ''}${((others) => (others.length ? `${others.map((o) => o.attempt).join(', ')} ${others.length > 1 ? 'have' : 'has'} corrected ${[...new Set(others.flatMap((o) => o.steps))].join(', ')} too: ` : ''))(last.sharedWith ?? [])}when the defect is in the check itself, not this ticket's intended behaviour, fix it once on the base branch of the adapter's repo instead: every live attempt follows the adapter there (D60), and no ticket needs its own correction`
        : `required supplemental validation ${sub === 'correct' ? 'corrected' : 'registered'}; admission checks unchanged; fresh code review and full gate required`, s.validations.at(-1));
      return 0;
    }
    case 'captures': {
      // I-94: screenshots the owner made by hand on the committed tree, for a project whose gate collects none.
      if (sub !== 'import') throw new WfError('usage: wf captures import --from <folder of images> | --file <image> [--criteria C5,C6] [--note "how they were made"]');
      const { importCaptures } = await import('./captures.mjs');
      const r = importCaptures(root, options);
      print(options, r.text, r.record);
      return 0;
    }
    case 'criteria': {
      if (sub !== 'amend') throw new WfError('usage: wf criteria amend --file f --reason "why"');
      const { state: s, changes, added, impactOwed, restrictions, pass = [] } = amendCriteria(root, options);
      const list = (ids) => ids.join(', ') || 'none';
      // A withdrawn acceptance is the outcome of the command (I-107), so it is printed with it, not as a warning.
      const withdrawn = (restrictions ?? []).filter((w) => w.startsWith('acceptance withdrawn'));
      for (const w of (restrictions ?? []).filter((x) => !withdrawn.includes(x))) process.stderr.write(`warning: ${w}\n`);
      const owedLine = impactOwed ? `\n  impact owed: this amendment adds scope without an impact map; the next implementer is told to find and report its consumers (or record it: \`wf criteria amend --file <f> --reason "..."\` with an \`impact\` addendum)` : s.impact?.addenda?.length && s.criteriaAmendments.at(-1)?.impact === true ? '\n  impact addendum recorded' : '';
      const addedLines = added.map((a) => `\n  repo added: ${a.repo} (worktree ${a.worktree}, base ${a.base.slice(0, 10)}); hand its work item to an implementer, and the reviewer judges the seam on both sides`).join('');
      print(options, `criteria amended (${s.criteriaAmendments.length} amendment(s)); the reviewer will see the reason${withdrawn.map((w) => `\n  ${w}`).join('')}${addedLines}\n  criteria now (${s.criteria.length}): ${list(s.criteria.map((c) => c.id))}\n  changed: ${list(changes.changed)}; added: ${list(changes.added)}; dropped: ${list(changes.dropped.map((d) => `${d.id} (${d.reason})`))}${owedLine}${pass.map((w) => `\n  planned pass ${w.id}: ${w.items.join(', ')}`).join('')}\n  next: ${nextAction(root, s)}`, { ...s, changes, pass });
      return 0;
    }
    case 'scope': {
      // 0.7.0: where an open review finding goes when it is not fixed here: `list` shows every open finding with whether it
      // blocks, `ticket` records a follow-up ticket's raw readback, `move` hands it to a sibling attempt. A finding that
      // blocks leaves only with the owner's `wf approve` (kind move-out-of-batch).
      const s = openState(root, options);
      if (!sub || sub === 'list') {
        const rows = scopeRows(s);
        print(options, rows.length ? rows.map((r) => `${r.ref}  ${r.blocks ? 'blocks' : 'observation'}  ${r.placement}${r.family ? `  [${r.family}]` : ''}${r.disposition ? `  ${r.disposition.choice}${r.disposition.ticket ? ` ${r.disposition.ticket}` : ''}${r.disposition.sibling ? ` -> ${r.disposition.sibling}` : ''}` : ''}  ${r.summary}`).join('\n') : `no open review findings on ${s.id}`, rows);
        return 0;
      }
      if (sub === 'ticket') { const r = completeScopeTicket(root, options); print(options, 'follow-up ticket readback recorded; run wf resume', r); return 0; }
      if (sub === 'fixed') { const r = recordFixed(root, options); const note = r.scopeDecisions.at(-1)?.notInCitedFile; print(options, `${options.finding} recorded fixed${note ? ` (the commit does not change the file ${note.join(', ')} cites${note.length > 1 ? '' : 's'}; the next reviewer verifies it)` : ''}; the next reviewer is handed it to verify; run wf resume`, r); return 0; }
      if (sub === 'waive') { const r = await waiveFinding(root, options); print(options, `${options.finding} waived by the person's decision${options['person-said'] !== undefined ? ' (their own words, recorded with each finding; nothing was asked)' : ''}; run wf resume`, r); return 0; }
      if (sub === 'not-a-defect') { const r = closeFindingNotDefect(root, options); print(options, `${options.finding} closed as not a defect by the person's answer ("${options.reason}"); the finding stays in the record beside it, and the delivered comment lists nothing for it\nnext: ${nextAction(root, r)}`, r.scopeDecisions.filter((d) => d.choice === 'not-a-defect')); return 0; }
      if (sub === 'defer') { const r = deferFindings(root, options); print(options, `${options.finding} deferred; the delivered comment lists it as a known issue; run wf resume`, r); return 0; }
      if (sub === 'move') {
        const refs = String(options.finding ?? '').split(',').map((x) => x.trim()).filter(Boolean);
        if (!refs.length) throw new WfError('usage: wf scope move --finding <round:id>[,<round:id>] --sibling <sibling attempt> [--reason "..."]');
        const r = moveOut(root, options, refs, { to: options.sibling, reason: options.reason });
        print(options, `${refs.join(', ')} moved to ${options.sibling}; run wf resume`, r);
        return 0;
      }
      // 0.7.28 (I-207): the person's "fix all", recorded once as their answer for every item that does not block, so it is never
      // asked again and never a reason for a round of its own: every item joins the planned pass. Named failure (field): the
      // person's standing "fix all" was used to open an implementer round and a review round for each low item and each item an
      // implementer left (10 of one ticket's 16 rounds).
      if (sub === 'fix-all') {
        const { recordFixAll } = await import('./leaving.mjs');
        const r = await recordFixAll(root, options);
        if (r.already) { print(options, `the person's "fix all" is already recorded on ${s.id} (${r.state.fixAll.at}): "${r.state.fixAll.words}"; nothing is asked again`, r.state.fixAll); return 0; }
        // Fifth review of 0.7.28: the read-back the agent shows the person says where the words came from, what the message followed
        // and which other tickets it names (the record's `via`), not only in --json.
        print(options, `recorded on ${s.id}: the person said to fix every item ("${r.words}"; ${r.state.fixAll.via ?? 'recorded'}). No item is asked about leaving again unless they say so (then \`--person-directed "<their words>"\` asks that item); every item that does not block joins the next planned pass, never a round of its own. next: ${nextAction(root, r.state)}`, r.state.fixAll);
        return 0;
      }
      throw new WfError('usage: wf scope list|ticket|move|fixed|defer|waive|not-a-defect|fix-all');
    }
    // 0.7.31 (I-217, D65): a product or design decision asked outside the engine, recorded with its basis and the person's words.
    case 'decide': {
      const { recordProductDecision, withdrawProductDecision } = await import('./product-decisions.mjs');
      if (sub === 'withdraw') {
        const id = positional[0];
        const st = withdrawProductDecision(root, id, options);
        print(options, `product decision ${id} withdrawn on ${st.id} ("${options.reason}"): ask the person again, with what changed, before anything is built on it\nnext: ${nextAction(root, st)}`, st.productDecisions.find((x) => x.id === id));
        return 0;
      }
      if (sub) throw new WfError(`usage: wf decide --question ... --choice ... --quote ... | wf decide withdraw <PD id> --reason "<what changed>"`);
      const r = await recordProductDecision(root, options);
      const d = r.state.productDecisions.find((x) => x.id === r.id);
      print(options, `product decision ${d.id} recorded on ${r.state.id}: "${d.question}" (options: ${(d.options ?? []).map((o) => `"${o}"`).join(' | ')}) -> "${d.choice}" (their words: "${d.quote}"; ${d.via}). It rests on: ${d.basis}; not checked: ${d.notChecked}.${d.item ? ` The premise of ${d.item} holds by their answer: it goes back to the fix round, and its implementer is handed their words.` : ''} Tell the person what you recorded, from which words; later roles are handed it as \`decisions\`, and when what you find changes the picture, withdraw it (\`wf decide withdraw ${d.id} --reason "<what changed>"\`) and ask them again\nnext: ${nextAction(root, r.state)}`, d);
      return 0;
    }
    case 'discovered': {
      // I-18: the discovered-issue ledger. Any role records what it finds; only the owner defers (a confirmed decision).
      if (sub === 'add') {
        const r = addDiscovered(root, options);
        print(options, `discovered ${r.id} recorded on ${r.state.id}; fix it here and close it with the fix commit (\`wf discovered close ${r.id} --fixed <commit>\`); ${RULE_SHORT}`, r.state.discovered.at(-1));
        return 0;
      }
      if (sub === 'close') {
        const r = await closeDiscovered(root, positional[0], options);
        const ds = r.ids.map((id) => r.state.discovered.find((x) => x.id === id));
        const fixedLine = (d) => `${d.id} fixed in ${r.repo}@${r.commit.slice(0, 10)}${d.fixed?.verifiedBy ? ` (made before it was recorded; verified by reviewer ${d.fixed.verifiedBy.reviewer})` : ''}`;
        const claimLines = (r.claimed ?? []).map((id) => `${id}: ${r.repo}@${r.commit.slice(0, 10)} was made before ${id} was recorded, so a reviewer verifies it: hand a reviewer (\`wf handoff reviewer --agent <id>\`); its bundle asks it to verify ${id}, and its \`fixed\` verdict closes ${id}. No question for the person.`);
        const all = [...ds.map((d) => (r.outcome === 'fixed' ? fixedLine(d) : r.outcome === 'not-a-defect' ? `${d.id} closed as not a defect (${channelOf(d)}): "${d.notADefect.reason}"; the claim stays in the record and the delivered comment does not list it` : `${d.id} deferred (${channelOf(d)}): "${d.deferred.decision}"`)), ...claimLines];
        print(options, all.join('\n'), ds.length === 1 && !claimLines.length ? ds[0] : { closed: ds, claimed: r.claimed ?? [] });
        return 0;
      }
      if (sub === 'rate') {
        const s2 = rateDiscovered(root, positional[0], options);
        print(options, `${positional[0]} rated ${options.severity}`, s2.discovered.find((x) => x.id === positional[0]));
        return 0;
      }
      if (sub === 'list' || !sub) {
        const s = openState(root, options);
        print(options, s.discovered.length ? s.discovered.map((d) => discoveredLine(d, s.id)).join('\n') : `no discovered issues on ${s.id}`, s.discovered);
        return 0;
      }
      throw new WfError('usage: wf discovered add --summary "..." [--severity high|medium|low] [--invariant "<which>"] [--kind defect|bookkeeping] [--where file:line] [--found-by ID] | list | rate D1 --severity S [--reason "..."] | close D1[,D2] --fixed SHA | --deferred [--reason "..."] (a low issue only, with the person\'s yes; medium and high are fixed here) | --not-a-defect --reason "why it is not a defect" (the person decides, or a reviewer\'s verified-nonissue verdict closes it)');
    }
    case 'handoff': {
      if (sub === 'wait') {
        const { waitRole } = await import('./launch.mjs');
        const result = await waitRole(root, options);
        print(options, `${result.agent}: ${result.status}${result.session ? ` (${result.session})` : ''}`, result);
        return result.exitCode;
      }
      if (sub === 'stop') {
        const { stopRole } = await import('./launch.mjs');
        const result = await stopRole(root, options);
        print(options, `${result.agent} stopped; hand a fresh one to continue (\`wf resume\`)`, result);
        return 0;
      }
      if (sub === 'run') {
        const state = openState(root, options);
        const member = state.handoffs.filter(h => h.agent === options.agent).at(-1);
        if (member?.reviewGroup?.slot === 'integration') {
          const { advance } = await import('./advance.mjs');
          const result = await advance(root, { _: ['advance'], attempt: state.id, once: true, json: options.json, runtime: member.runtime }, { groupAgent: member.agent });
          print(options, `${result.status}: ${result.decision?.blockers?.join('; ') || result.decision?.guidance || result.error}`, result);
          return result.exitCode;
        }
        const { runRole } = await import('./launch.mjs');
        const result = await runRole(root, options);
        print(options, `Native ${result.agent}: ${result.status}${result.session ? ` (${result.session})` : ''}`, result);
        return result.exitCode;
      }
      if (sub === 'close') {
        // Second review of 0.7.30 (I-153): a launch stopped at capacity whose work was finished another way is settled here.
        const settled = settleCapacity(root, options);
        if (settled) {
          print(options, `${settled.role} ${settled.agent} settled on ${settled.state.id}: its launch stopped at capacity and will not be resumed${settled.closed ? ` (implementer closed, ${settled.closed.outcome})` : ''}. next: ${nextAction(root, settled.state)}`, settled.state);
          return 0;
        }
        const c = closeImplementer(root, options);
        print(options, `implementer ${options.agent} closed (${c.outcome}) on ${c.state.id}; commits since its handoff: ${Object.entries(c.commits).map(([k, v]) => `${k} ${v ?? '?'}`).join(', ')}${c.children.length ? `; ${c.children.length} sub-agent(s) attributed to ${c.handoff}` : ''}${leftNotes(c, c.state.id).map((l) => `\n  ${l}`).join('')}${c.state.implementers.some((x) => !x.closedAt) ? `\n  still open: ${c.state.implementers.filter((x) => !x.closedAt).map((x) => x.agent).join(', ')}` : '\n  every implementer is closed: the tree is settled for a review'}`, { handoff: c.handoff, outcome: c.outcome, commits: c.commits, children: c.children, linked: c.linked, unknownIds: c.unknownIds });
        return 0;
      }
      // 0.7.11: the role files a native start reads follow the installed plugin by themselves (untracked ones are rewritten).
      {
        const g = refreshGenerated(root);
        const roles = g.refreshed.filter((f) => hostIds().some((id) => findHost(id)?.agentsDir && f.includes(path.join(root, findHost(id).agentsDir))));
        if (roles.length) process.stderr.write(`note: role files refreshed to the installed plugin (${roles.length}); a role started from a session that was already running is pointed at the current file by its bundle\n`);
      }
      // 0.7.28 (I-210): a round handed past unanswered course signals is said to the owner (the strategist was the next step).
      const coursePending = ['implementer', 'reviewer'].includes(sub) ? (() => { try { return nextDecision(root, openState(root, options)).courseSignals ?? []; } catch { return []; } })() : [];
      const r = handoff(root, sub, options);
      if (coursePending.length) process.stderr.write(`note: handed while course signals stand that no strategist has answered (${coursePending.map((x) => x.id).join(', ')}): the next step was the strategist; hand it before the next round (\`wf resume\` names it)\n`);
      const startPrompt = r.startPrompt;
      const launchHost = findHost(options.runtime);
      if (launchHost?.spawnMode === 'engine-only' && ['planner', 'reviewer'].includes(sub) && !r.model) process.stderr.write(`warning: this handoff pins no ${launchHost.name} model and cannot launch; run \`wf models refresh --attempt ${r.state.id}\`, then create a fresh handoff\n`);
      // I-25: plan restrictions the diff has outgrown, to the owner (stderr: never into a reviewer's prompt).
      for (const w of r.restrictions ?? []) process.stderr.write(`warning: ${w}\n`);
      const sweepLines = r.sweeps?.length ? `pattern sweep (answer each family in a commit trailer with one proof: \`Sweep <id>: proof - <command> => <expected result>\`):\n${r.sweeps.map((x) => `  ${x.id} for ${x.family ? `family ${x.family} (${x.findings.join(', ')})` : x.finding}: ${x.hits} hit(s)${x.files.length ? `\n    ${x.files.slice(0, 20).join('\n    ')}${x.files.length > 20 ? `\n    … ${x.files.length - 20} more (in the bundle)` : ''}` : ''}`).join('\n')}\n` : '';
      // Never printed for a reviewer: its console carries only the start line.
      const api = await trackerApi(root, r.state.id);
      if (api && sub !== 'reviewer') process.stderr.write(`${api.trim()}\n`);
      const lessonsLine = r.lessons ? `lessons injected: ${r.lessons.apply.map((l) => l.id).join(', ') || 'none'}${r.lessons.omitted?.length ? ` (omitted by the cap: ${r.lessons.omitted.join(', ')})` : ''}${r.lessons.filtered?.length ? `\nlessons filtered out (outside this change's scope): ${r.lessons.filtered.map((l) => l.id).join(', ')}; \`wf lesson preview --attempt ${r.state.id} --role ${sub}\` says why` : ''}\n` : '';
      // Named failure (I-15): a role file `wf sync` changed after this session started is not what the agent loads.
      const staleHost = findHost(r.state.handoffs.find((x) => x.bundle === r.bundle)?.runtime);
      const stale = r.roleStale ? `note: ${path.relative(root, r.roleStale.file)} changed at ${r.roleStale.changedAt}, after this ${staleHost.label} session started (${r.roleStale.sessionStartedAt}). ${fragment(staleHost, 'staleRole', r.agentType)}\n` : '';
      // Named failure (I-14): the reviewer handoff printed no agent name, the reviewer was started unnamed, and its
      // closure was refused after the whole review. The owner is told the agent type and name on stderr.
      // 0.7.28 (I-211): a divided review prints no reviewer prompt at all, only the one command that starts it (its scoped
      // reviewers, then the integration); started from a bundle's prompt, a reviewer of it records nothing.
      const groupStart = r.members ? `wf handoff run --agent ${r.agent} --attempt ${r.state.id}` : null;
      const how = r.members ? `This review is divided (${r.members.length - 1} scoped reviewers and an integration): start it only by running the command below, in the foreground, and keep that handle; it launches the scoped reviewers and then the integration. Never start a reviewer of it from a bundle's prompt: such a reviewer records nothing. Run` : `Start agent type ${r.agentType} (name it ${r.agent}; do not pass a model)`;
      // The reviewer is started blind: this one line is its whole prompt, so nothing else is printed to pass along.
      if (sub === 'reviewer') {
        // To the owner on stderr, never into the reviewer's one-line prompt on stdout.
        const w = outsideWarning(root, r.state);
        if (w) process.stderr.write(`warning: ${w}\n`);
        if (r.division) process.stderr.write(`review division: ${r.division.mode}; ${r.division.reason}\n${reviewDivisionSummary(r.division)}`);
        for (const member of r.members ?? []) process.stderr.write(`group ${member.slot}: ${member.agent}; frozen prompt: ${member.startPrompt}\n`);
        process.stderr.write(groupStart ? `${lessonsLine}${stale}${how}:\n` : `${lessonsLine}${stale}${how} with only the line on stdout as its prompt:\n`);
        print(options, groupStart ?? startPrompt, { ...r, startPrompt, ...(groupStart ? { start: groupStart } : {}) });
      } else {
        if (stale) process.stderr.write(stale);
        // I-23: the implementer handoff stays open until it is closed, and no review round starts while it is open.
        const closeLine = sub === 'implementer' ? `\nWhen it reports done (and its work is committed), close it: \`wf handoff close --agent ${r.agent} --attempt ${r.state.id}\` (\`--outcome stopped\` if you stop it); \`wf handoff reviewer\` refuses while it is open.`
          : sub === 'strategist' ? `\nIt records its own decision (\`wf strategy record --closure ${r.closureFile}\`). Wait for its completion notification, or run it in the foreground: \`wf handoff run --agent ${r.agent} --attempt ${r.state.id}\`; never poll. Apply its decision before the next handoff.` : '';
        const panelLine = r.panel ? `\nplanning panel: seat ${r.panel.seat} of ${r.panel.of}, ${r.panel.stage}${r.panel.round ? ` (round ${r.panel.round})` : ''}` : '';
        print(options, `${lessonsLine}${sweepLines}${sub} bundle: ${r.bundle}${panelLine}${r.work ? `\nwork item ${r.work}, class ${r.class}` : `\nclass ${r.class}`}${r.effort ? `, effort ${r.effort}` : ''}${r.model ? `, model ${r.model}` : ''}\n${how} with: "${startPrompt}"${closeLine}`, { ...r, startPrompt });
      }
      return 0;
    }
    case 'advance': {
      const { advance } = await import('./advance.mjs');
      const result = await advance(root, options);
      print(options, `${result.status}: ${result.decision?.blockers?.join('; ') || result.decision?.guidance || result.error}`, result);
      return result.exitCode;
    }
    case 'gate':
    case 'check': {
      const s = openState(root, options);
      // 0.7.28 (I-212): the person's decision to set aside a pre-existing failing suite the delivery does not touch.
      if (cmd === 'gate' && sub === 'quarantine') {
        const { quarantineSuite } = await import('./gate.mjs');
        const r = quarantineSuite(root, s, options);
        print(options, `${r.suite} of ${r.step} is set aside for ${s.id} (${r.decision}): the next \`wf gate\` counts ${r.step} passed while it is that step's only failure, and the delivered comment says the suite was not proven. next: ${nextAction(root, loadState(root, s.id))}`, r);
        return 0;
      }
      // 0.7.30 (I-158, D58): the person's decision to deliver without the full test run.
      if (cmd === 'gate' && sub === 'light-only') {
        const { lightOnly } = await import('./gate.mjs');
        const r = await lightOnly(root, s, options);
        print(options, `${s.id} leaves out ${r.leftOut.join(', ')} by the person's decision (${r.decision}): the next \`wf gate\` runs the light steps only${r.stillRun.length ? ` (and ${r.stillRun.join(', ')})` : ''} and counts for delivery; the evidence reviewer is told what did not run and the delivered comment says so. next: ${nextAction(root, loadState(root, s.id))}`, r);
        return 0;
      }
      const check = cmd === 'check';
      const repos = check && options.repo ? String(options.repo).split(',') : null;
      // Before the run: an unplanned change is amended into the criteria (or fixed) before the review, not after.
      try {
        const w = s.accepted ? null : outsideWarning(root, s);
        if (w) (options.json ? process.stderr : process.stdout).write(`wf ${cmd}: warning: ${w}\n`);
        const dw = s.accepted ? null : designWarning(root, s);
        if (dw) (options.json ? process.stderr : process.stdout).write(`wf ${cmd}: warning: ${dw}\n`);
        // 0.7.11, a warning and never a refusal: an implementer's own `wf check` runs while its handoff is open. Named
        // failure (audit of 51 attempts): gates started while work was still being committed were stopped or thrown away.
        const open = cmd === 'gate' ? (s.implementers ?? []).filter((x) => !x.closedAt).map((x) => x.agent) : [];
        if (open.length) (options.json ? process.stderr : process.stdout).write(`wf gate: warning: implementer ${open.join(', ')} ${open.length > 1 ? 'are' : 'is'} still open; if ${open.length > 1 ? 'they' : 'it'} may still commit, this gate runs on a tree that will change: close ${open.length > 1 ? 'them' : 'it'} first (\`wf handoff close --agent <id>\`)\n`);
        // 0.7.15 (lessons of one attempt): gates were run and stopped while 23 discovered issues were still open; fixing them
        // changes the tree the gate proves. Said once, never a refusal.
        const owed = cmd === 'gate' ? (s.discovered ?? []).filter((d) => d.status === 'open' && d.kind !== 'bookkeeping') : [];
        if (owed.length) (options.json ? process.stderr : process.stdout).write(`wf gate: warning: ${owed.length} discovered issue(s) still open (${owed.slice(0, 5).map((d) => d.id).join(', ')}${owed.length > 5 ? ', …' : ''}); the ones fixed in this delivery change the tree this gate proves, so fixing them first saves a gate\n`);
      } catch {}
      // Live progress goes to stdout, or to stderr with --json so stdout stays one JSON document.
      // The order of work (I-27): a gate runs only after a clean code-review round on this tree, never beside a round.
      const afterLock = check || options['prepare-only'] === true ? undefined : gateOrderCheck(root, options);
      const r = await runGate(root, s, { afterLock, prepareOnly: options['prepare-only'] === true, full: !check && options.full === true, focused: !check && options.focused === true, rerunFailed: !check && options['rerun-failed'] === true ? true : undefined, check, repos, live: options.json ? process.stderr : process.stdout });
      const note = check ? '\n  (a check runs light steps only; it is reused by the gate but never counts as one)' : r.record?.rerunFailed ? '\n  (--rerun-failed: proof while repairing; acceptance and delivery need a full `wf gate`)' : '';
      const flaky = r.record?.flaky?.length ? `\n  flaky: ${r.record.flaky.map((f) => f.step).join(', ')} failed earlier and passed now with the same inputs` : '';
      print(options, `${gateText(r).replace(/^gate /, check ? 'check ' : 'gate ')}${note}${flaky}`, r.record ?? r.plan);
      return r.record && r.record.status !== 'passed' ? 1 : 0;
    }
    case 'run': {
      const step = typeof options.step === 'string' ? options.step : null;
      if ((options.step !== undefined && !step) || (!step && (!options.lease || options.lease === true)) || (options.lease === true) || (!step && !options._.length)) throw new WfError('usage: wf run --lease <name> -- <command...>   or   wf run --step <gate step id> [--lease <name>] (runs the step\'s declared `prepare`, or its plugin\'s)');
      if (step) return await runPrepared(root, openState(root, options), step, options._, { lease: options.lease ? String(options.lease) : null });
      const cfg = loadConfig(root);
      return await runWithLease(cfg, String(options.lease), options._, { root });
    }
    case 'summary': {
      const cfg = loadConfig(root);
      const { actor } = await import('./attempt.mjs');
      const s = recordSummary(root, cfg, openState(root, options), { ...options, actorId: actor(options) });
      print(options, `summary recorded for ${s.id} (${s.delivery.summary.text.split('\n').length} line(s)${s.delivery.summary.lines ? `, ${Object.keys(s.delivery.summary.lines).length} item(s) worded for the tester` : ''}).${s.delivery.completedAt ? ` Delivered comment: ${commentFile(root, s.id)}` : ''}${limitItemsText(s, { cfg, load: (id) => loadState(root, id) })}\nnext: ${nextAction(root, s)}`, s);
      return 0;
    }
    case 'export': {
      const s = openState(root, options);
      if (sub === 'screenshots') {
        const r = exportScreenshots(root, s, options.to && options.to !== true ? options.to : null, { gate: options.gate === true, ...(options.run !== undefined ? { run: options.run } : {}) });
        const listed = r.files.map((f) => `  ${f.file}${path.basename(f.file) !== f.title ? `  (${f.title})` : ''}`).join('\n');
        // 0.7.30 (I-198, I-160): a run's or an import's copies say where they came from, and that they are not the gate's acceptance.
        if (r.run) print(options, `copied ${r.files.length} screenshot(s) of ${r.label} of ${s.id} to ${r.dir} (each sha256-checked against the evidence record; view them with the Read tool):\n${listed}\n${r.imported ? 'imported captures: not a gate\'s evidence until a gate passes on the tree they were made on' : 'copies for diagnosis: the run\'s outcome stands as recorded, and only the delivered set is shown to the person'}`, r);
        else print(options, `copied ${r.files.length} ${options.gate ? 'gate' : 'delivered'} screenshot(s) of ${s.id} to ${r.dir} (each sha256-checked; view them with the Read tool):\n${listed}`, r);
        return 0;
      }
      if (sub) throw new WfError('usage: wf export [--out FILE] [--json] | wf export screenshots [--gate | --run <run id | import-<n>>] [--to DIR]');
      const r = exportAttempt(root, s, { out: options.out ?? null, json: options.json === true });
      append(root, s.id, 'exported', { file: r.file, json: options.json === true }, null);
      if (options.json) {
        process.stdout.write(r.text);
        return 0;
      }
      print(options, `exported ${s.id} to ${r.file}\n  a view of the ledger and evidence, which stay the source of truth`);
      return 0;
    }
    case 'stop': {
      const s = openState(root, options);
      if (!options.reason || options.reason === true || !String(options.reason).trim()) throw new WfError(`--reason "why" is required, with --class ${STOP_CLASSES.join('|')}`);
      const lock = stopGate(root, s, String(options.reason), options.class);
      const after = options.class === 'owner-decision' ? 'Resume with `wf gate`.' : 'Fix and commit through the implementer; the new tree gets a code-review round before the next `wf gate`.';
      print(options, `stopping gate ${lock.runId} (${options.class}; ${lock.discardedMinutes ?? '?'} minute(s) of gate work recorded as discarded); finished steps are kept. ${after}`);
      return 0;
    }
    case 'review': {
      if (sub === 'parts') {
        const { currentReviewGroup, stalledMembers, stalledText, waitingText } = await import('./review-groups.mjs');
        const s = openState(root, options), group = currentReviewGroup(s);
        if (!group) throw refuse('no current parallel review group');
        const required = group.members.filter(h => h.reviewGroup.slot !== 'integration');
        const parts = required.map(h => (s.reviewParts ?? []).find(p => p.handoff === h.bundle));
        // 0.7.28 (I-211). Named failure (field): a divided review was started as a plain reviewer with the integration bundle's
        // prompt; its scoped reviewers were never created, nothing could be recorded, and the owner polled for 80 minutes. A
        // reviewer that reads its parts and finds no scoped reviewer was ever launched was not started by `wf handoff run`: it stops.
        const integration = group.members.find(h => h.reviewGroup.slot === 'integration');
        if (parts.every(p => !p) && required.every(h => !h.launch)) throw refuse(`the scoped reviewers of ${group.id} (${required.map(h => h.agent).join(', ')}) were never launched: this divided review was started outside \`wf handoff run\`, and nothing it reviews can be recorded`, `stop now and tell the owner: a divided review starts only with \`wf handoff run --agent ${integration?.agent ?? '<integration>'} --attempt ${s.id}\`, which launches the scoped reviewers and then the integration`, { id: 'review:group-plain-start' });
        // 0.7.32 (D76). Named failure (field): a scoped member's launch ended without a part and the integration reviewer was told
        // only "incomplete", 169 times over 89 minutes, then six hours of silence. A member whose part will never come stops it.
        const stalled = stalledMembers(s, group);
        if (stalled.length) throw refuse(`no part will come from ${stalledText(stalled)}: the integration review of ${group.id} can never be recorded`, `stop now and tell the owner, who stops this integration reviewer (\`wf handoff stop --agent ${integration?.agent ?? '<integration>'} --attempt ${s.id}\`, or where it runs when it was started outside \`wf handoff run\`), then a fresh divided review: \`wf handoff reviewer --agent <new id> --attempt ${s.id}\` and the \`wf handoff run\` line it prints`, { id: 'review:group-member-ended' });
        if (parts.some(p => !p)) throw refuse(`scoped reports are incomplete (${required.filter((h, i) => !parts[i]).map(waitingText).join('; ')}); integration can inspect its own code while waiting`, undefined, { id: 'review:group-incomplete' });
        print({ ...options, json: true }, null, parts.map(p => ({ agent: p.closure.reviewer, sha256: p.raw.sha256, file: p.raw.path ?? p.raw.file, closure: p.closure, provenance: p.provenance })));
        return 0;
      }
      // The reviewer runs this. Its console shows nothing but the receipt: no owner next steps, tracker actions or
      // state, which carried earlier rounds' findings and the owner's notes into a blind review.
      // `salvaged` and `partial` are the engine's own marks for a closure it kept from a launched reviewer (launch.mjs),
      // never a flag: a closure the reviewer records itself is its own.
      const { state: s, reveal, toVerify, premises = [], part, droppedLinks = [] } = recordReview(root, { ...options, salvaged: false, partial: false });
      if (part) {
        const recorded = s.reviewParts.at(-1);
        print(options, `scoped review recorded (${recorded.closure.findings.length} finding(s)); integration is still required`, { recorded: true, part: true, attempt: s.id, findings: recorded.closure.findings.length, sha256: recorded.raw.sha256 });
        return 0;
      }
      // Revealed only now, after this round's own closure is recorded blind.
      const verify = reveal ? `\n${[toVerify.length ? `${toVerify.length} finding(s) from earlier rounds to verify` : '', premises.length ? `${premises.length} premise(s) reported failed to judge (${premises.map((x) => x.ref).join(', ')}), with the implementer's evidence under \`premiseFailed\`` : ''].filter(Boolean).join(' and ')} against the code: ${reveal}\nAdd \`priorFindings: [{ round, id, status, evidence${premises.length ? ', rationale, premise' : ''} }]\` to your closure (change nothing else) and run \`wf review --closure <file>\` again.` : '';
      const dropped = droppedLinks.length ? `\nsameCauseAs links dropped (${droppedLinks.length}), the closure is recorded without them:\n  - ${droppedLinks.join('\n  - ')}\nname a finding as "<round>:<id>" (the reviewer id that raised it, a colon, its id; \`openFindings\` in your bundle and \`wf scope list\` show them) and record the closure again to add a link.` : '';
      print(options, `review recorded (${s.review.closure.findings.length} finding(s)).${dropped}${verify}`, { recorded: true, attempt: s.id, ...(droppedLinks.length ? { droppedLinks } : {}), findings: s.review.closure.findings.length, file: s.review.file, provenance: s.review.provenance, verify: reveal ? { file: reveal, count: toVerify.length } : null });
      return 0;
    }
    case 'accept': {
      const s = acceptReview(root, options);
      const lp = lessonPrompts(s).filter((p) => p.startsWith('finding'));
      // I-69: scope the accepted round said it did not reach is said here too, not only in resume, export and the comment.
      const unreached = unreachedOf(s.review?.closure);
      // 0.7.9 (D19): what the classifier learned from this attempt's findings.
      const labelled = s.learning?.at(-1);
      // Only what was counted: a label naming a lesson this attempt recorded is that finding's own lesson, not a repeat.
      const counted = new Set((s.lessons?.recurred ?? []).map((r) => r.id));
      const learnedLine = labelled && !labelled.error ? Object.entries(labelled.findings ?? {}).filter(([, l]) => l && l !== 'none' && counted.has(l)).map(([ref, l]) => `${ref} repeats ${l}`) : [];
      print(options, `review accepted.${unreached.length ? `\nnot reached by this review: ${unreached.join('; ')}` : ''}${lp.map((p) => `\nlesson: ${p}`).join('')}${learnedLine.length ? `\nlearned: ${learnedLine.join('; ')} (counted as recurrences; lessons rank by them)` : ''} next: ${nextAction(root, s)}`, s);
      return 0;
    }
    case 'deliver': {
      {
        // Before anything is pushed: screenshots bound for a public GitHub repository need the owner's acknowledgement.
        const { gateFiles } = await import('./lifecycle.mjs');
        const s0 = openState(root, options);
        const cfg0 = loadConfig(root);
        const problem = await publicAssetsProblem(root, cfg0, { screenshots: gateFiles(s0).length > 0 && hasTicket(s0) });
        if (problem) throw refuse(`not delivered: ${problem}`);
      }
      const r = await deliver(root, options);
      if (r.waiting) {
        // 0.7.26 (I-183): the base branch may have moved while the integration waits; the way in is named where the owner reads it.
        let moved = [];
        try {
          moved = r.waiting.onTarget ? [] : baseMovedForDelivery(root, r.state);
        } catch {}
        const note = moved.length ? `\nthe base moved meanwhile (${moved.map((e) => `${e.repo}: ${e.ref} +${e.commits} commit(s)`).join('; ')}): \`wf base merge\` brings it into the branch, the merged tree is gated, reviewed and accepted again, and \`wf deliver\` then asks the delivery adapter to integrate the reconciled branch` : '';
        print(options, `${r.waiting.repo}: ${r.waiting.state}${r.waiting.url ? ` (${r.waiting.url})` : ''}${r.waiting.onTarget ? `; the change is already on ${r.waiting.onTarget}` : ''}. Run \`wf deliver\` again once it is merged.${note}`, moved.length ? { ...r, baseMoved: moved } : r);
        return 0;
      }
      const api = await trackerApi(root, r.state.id);
      const after = loadState(root, r.state.id);
      const members = (after.batch?.members ?? []).map((m) => showBlock(root, loadState(root, m))).join('');
      const comment = after.tracker.pending.some((a) => a.rendered === 'delivered') ? `\ndelivered comment to post (rendered from your summary, the user-visible UAT scope, the screenshots and known limits): ${commentFile(root, after.id)}\n  replace each {assetUrl:<title>} with the assetUrl its upload returned, so every screenshot shows inline; post it unchanged otherwise${limitItemsText(after, { cfg: loadConfig(root), load: (id) => loadState(root, id) })}` : '';
      const deferrals = [after, ...(after.batch?.members ?? []).map((m) => loadState(root, m))].flatMap((st) => (st.discovered ?? []).filter((x) => x.status === 'deferred').map((x) => ({ ...x, id: st.id === after.id ? x.id : `${st.id}:${x.id}` }))).map((x) => `\n  ${x.id} deferred (${x.deferred.source?.provenance ?? 'recorded'}${x.deferred.source?.file ? `, ${x.deferred.source.file}:${x.deferred.source.line}` : ''}): ${x.summary}\n    taken as the owner's decision: "${x.deferred.decision}"\n    channel: ${channelOf(x)}`).join('');
      // I-20: a repo delivered while its adapter reported another state after the merge, as the owner acknowledged it.
      const postMerge = Object.values(after.delivery.repos).filter((d) => d.acknowledged).map((d) => `\n  ${d.repo}: on ${d.target} while the delivery adapter reported ${d.adapterState}${d.observed?.evidence ? ` (${d.observed.evidence})` : ''}; acknowledged by the owner as ${d.acknowledged}`).join('');
      // 0.7.30 (I-151, D60): each adapter the attempt took from its base branch, said with the delivery as a re-pin is.
      const repins = [...(after.adapterFollows ?? []).map((x) => `\n  adapter followed ${x.ref} from ${x.from.slice(0, 10)} to ${x.to.slice(0, 10)} (${x.changed.join(', ')})${x.delivery?.mode === 'kept' ? `; the delivery kept \`${x.delivery.from}\` (the base branch names \`${x.delivery.to}\`)` : ''}`), ...(after.adapterRepins ?? []).map((x) => `\n  delivery adapter re-pinned from ${x.from.slice(0, 10)} to ${x.to.slice(0, 10)}: ${x.reason}`)].join('');
      // 0.7.30 (I-201, D62): each branch the attempt is also delivered to gets its port once this delivery is complete.
      const ports = portLines(after, await admitPorts(root, after, options, entry));
      print(options, `delivered ${after.id}: ${Object.values(after.delivery.repos).map((d) => `${d.repo}${d.commit ? `@${d.commit.slice(0, 10)}` : ' (no changes)'}${d.target && after.repos[d.repo]?.target ? ` -> ${d.target}` : ''}${d.adapterState && d.adapterState !== 'integrated' ? ` [adapter: ${d.adapterState}]` : ''}`).join(', ')}${postMerge ? `\nnot a clean adapter delivery (show this to the owner):${postMerge}` : ''}${repins}${ports}${api}${deferrals ? `\ndeferred issues (show these to the owner: this is what was taken as their decision):${deferrals}` : ''}${showBlock(root, after)}${members}${comment}\nnext: ${nextAction(root, after)}`, after);
      return 0;
    }
    case 'tracker': {
      if (sub === 'sync') {
        // 0.7.27 (D42): first what the ledger owes and nothing queued yet (the `deployed` step held back by a hold), or the close.
        const s = await closeAfterHandoff(root, openState(root, options));
        const api = await trackerApi(root, s.id);
        const after = loadState(root, s.id);
        print(options, `${api.trim() || (after.phase === 'done' ? `${after.id} closed and worktrees removed.` : (after.tracker?.pending?.length ? `tracker: ${after.tracker.pending.length} pending action(s), performed through the connector (below)` : 'tracker: nothing to perform'))}\nnext: ${nextAction(root, after)}`);
        return 0;
      }
      if (sub === 'mode') {
        // The adapter edit that switches how wf talks to the tracker; with --write it is made (comments kept).
        const mode = positional[0] === 'agent' ? 'connector' : positional[0];
        if (!['api', 'cli', 'files', 'connector'].includes(mode)) throw new WfError('usage: wf tracker mode api|cli|files|connector [--write]');
        const cfg = loadConfig(root);
        const key = cfg.tracker.apiKey ?? 'LINEAR_API_KEY';
        const file = path.join(root, '.workflow', 'project.yaml');
        const { YAML } = await import('./util.mjs');
        const doc = YAML.parseDocument(fs.readFileSync(file, 'utf8'));
        doc.setIn(['tracker', 'via'], mode);
        if (mode === 'api' && !cfg.tracker.apiKey) doc.setIn(['tracker', 'apiKey'], key);
        const next = mode === 'api' ? `\nthen catalogue ${key} in .workflow/secrets.yaml ({ key: ${key}, kind: provided, required: true }) if it is not, and the owner runs \`wf secrets guide ${key}\` in their own terminal; \`wf doctor\` checks it` : '';
        if (options.write) {
          fs.writeFileSync(file, doc.toString());
          print(options, `tracker.via set to ${mode} in ${file}; commit it on the base branch${next}`);
        } else print(options, `set in .workflow/project.yaml:\n  tracker:\n    via: ${mode}${mode === 'api' ? `\n    apiKey: ${key}` : ''}\n(or run \`wf tracker mode ${mode} --write\`)${next}`);
        return 0;
      }
      if (sub !== 'record') throw new WfError('usage: wf tracker record --event E --capture file.json [--comments file.json] | wf tracker sync | wf tracker mode api|cli|files|connector');
      const cfg = loadConfig(root);
      let s = await recordTracker(root, cfg, openState(root, options), { ...options, engineCapture: undefined });
      s = await closeAfterHandoff(root, s);
      const rec = s.tracker.done.filter((d) => d.event === options.event).at(-1);
      const how = rec?.verified === 'host-recorded' ? `verified from the host's record (host-recorded: the ${findHost(rec.host?.runtime)?.label ?? 'harness'} transcript holds the tracker's answer; a same-user process could edit that file)${rec.extraLines?.length ? `; ${rec.extraLines.length} line(s) added to the comment beyond the rendered one` : ''}` : rec?.mode === 'agent-reported' ? `recorded as agent-reported, unverified (the engine checked what the agent reported, not the tracker's answer${rec.extraLines?.length ? `; ${rec.extraLines.length} line(s) added to the comment beyond the rendered one` : ''})` : 'verified';
      print(options, `tracker ${options.event} ${how}. ${s.phase === 'done' ? 'Attempt closed and worktrees removed.' : `next: ${nextAction(root, s)}`}`, s);
      return 0;
    }
    case 'delivery': {
      // 0.7.26 (I-182): every verified capture the handoff can draw from, the ticket's own first, with where each stands.
      if (sub === 'list') {
        const s = openState(root, options);
        const { files, inSet, legacy } = deliveryCaptures(root, s);
        const rows = files.map((f, i) => `  ${i + 1}. ${inSet(f) ? 'in the set' : 'not in the set'}  ${RANK_WORDS[f.rank]}\n     ${f.title ?? path.basename(f.path)}   sha256 ${f.sha256}\n     step ${f.step ?? 'none'}  source ${f.source ?? f.path}${Array.isArray(f.units) && f.units.length ? `  tagged ${f.units.join(', ')}` : ''}`);
        print(options, files.length ? `${s.id}: ${files.length} verified capture(s) the handoff can draw from${legacy ? ' (delivered before 0.1.11: only the pending attach action is known)' : ''}, the ticket's own first; \`wf delivery narrow --keep <sha256,...> --reason "why"\` chooses the set from any of them, while the handoff is pending\n${rows.join('\n')}` : `${s.id}: no verified captures`, files);
        return 0;
      }
      if (sub !== 'narrow') throw new WfError('usage: wf delivery list [--attempt ID] | wf delivery narrow --keep <sha256,...> | --file keep.json --reason "why" [--attempt ID]');
      const { state: s, dryRun } = narrowDelivery(root, options);
      if (dryRun) {
        print(options, `dry run, nothing recorded: ${s.id} would be narrowed from ${dryRun.from} to ${dryRun.to} (${dryRun.dropped} dropped${dryRun.added ? `, ${dryRun.added} chosen from the verified captures` : ''}${dryRun.legacy ? '; delivered before 0.1.11: the pending attach action is narrowed, uploads checked by title' : ''}): ${dryRun.reason}\n${dryRun.kept.map((f, i) => `  ${i + 1}. ${f.title}  sha256 ${f.sha256.slice(0, 12)}  ${f.path}`).join('\n')}`, dryRun);
        return 0;
      }
      const n = s.delivery.narrowed;
      print(options, `delivered set of ${s.id} narrowed from ${n.from} to ${n.to}${n.added?.length ? ` (${n.added.length} chosen from the verified captures)` : ''}: ${n.reason}${showBlock(root, s)}${n.legacy ? `\n  delivered before 0.1.11: the pending attach action now lists ${n.to} file(s); uploads are checked by title` : ''}\nnext: ${nextAction(root, s)}`, s);
      return 0;
    }
    case 'shown': {
      let s = recordShown(root, options);
      const api = await trackerApi(root, s.id);
      s = await closeAfterHandoff(root, loadState(root, s.id));
      const lp = lessonPrompts(s).filter((p) => p.startsWith('anomaly'));
      print(options, `shown recorded for ${s.id}: ${s.delivery.shown.screenshots.length} screenshot(s) with the owner's captions.${lp.map((p) => `\nlesson: ${p}`).join('')}${api}${s.phase === 'done' ? ' Attempt closed and worktrees removed.' : `\nnext: ${nextAction(root, s)}`}`, s);
      return 0;
    }
    case 'deployment': {
      // 0.7.27 (I-196, D42): the deployment confirmation a project's delivery waits for after the merge.
      const step = await import('./deployment-step.mjs');
      if (!['check', 'record', 'tested', 'close'].includes(sub)) throw new WfError('usage: wf deployment check [--observed "<note>"] | wf deployment record --state deployed|deploying|failed|unknown --observed "<what you saw>" | wf deployment tested --observed "<what you tested and saw>" | --not-possible "<why>" | --failed "<what you saw>" | wf deployment close --reason "<why it cannot be confirmed>" [--ask FILE.json]');
      let s = sub === 'check' ? await step.checkDeployment(root, options) : sub === 'record' ? await step.recordDeployment(root, options) : sub === 'tested' ? await step.recordTested(root, options) : await step.closeUnconfirmed(root, options);
      // Settled, the `deployed` tracker step is queued (and performed by an engine route), or the attempt closes.
      s = await closeAfterHandoff(root, s);
      const api = await trackerApi(root, s.id);
      s = loadState(root, s.id);
      const d = s.deployment;
      const last = d.observations.at(-1);
      const head = sub === 'close' ? `${s.id}: delivery closed without a confirmed deployment (${d.closed.decision}, "${d.closed.reason}"); the ticket is not moved: it stays where the delivery put it, yours to move, or to reopen for a fix (\`wf reopen --item ${s.item} --reason "..."\`)` : sub === 'tested' ? `${s.id}: ${d.tested.result === 'passed' ? 'the fix is recorded as tested' : d.tested.result === 'not-possible' ? 'recorded why the fix cannot be tested' : 'recorded that the fix failed'} in ${d.owed.where}` : `${s.id}: deployment in ${d.owed.where} ${last.state === 'deployed' ? 'confirmed' : `NOT confirmed: ${last.state}`} (${last.source === 'adapter' ? `the delivery adapter's check: ${last.evidence}` : `your observation: ${last.observed}`})`;
      const pending = s.tracker.pending.filter((a) => a.event === 'deployed');
      const post = pending.length && loadConfig(root).tracker.via === 'connector' ? `\ntracker (deployed): ${pending.filter((a) => a.op !== 'readback').map((a) => (a.op === 'comment' ? `post this comment unchanged:\n${a.body.trimEnd().replace(/^(?=.)/gm, '    ')}` : a.op === 'setStatus' ? `  then set status to "${a.status}"` : `  ${a.op}`)).join('\n')}` : '';
      print(options, `${head}${api}${post}${s.phase === 'done' ? `\n${s.id} closed and worktrees removed.` : `\nnext: ${nextAction(root, s)}`}`, s);
      return 0;
    }
    case 'decisions': {
      if (sub === 'withdraw') {
        const r = withdrawDecision(root, positional[0], options);
        print(options, `${positional[0]} withdrawn on ${r.id}; next: ${nextAction(root, r)}`, r.decisions.find((d) => d.id === positional[0]));
        return 0;
      }
      const s = openState(root, options);
      const list = options.all ? s.decisions : [...pendingDecisions(s), ...s.decisions.filter((d) => d.approved)];
      print(options, list.length ? list.map(decisionLine).join('\n') : `no reserved decisions on ${s.id}`, list);
      return 0;
    }
    case 'approve': {
      const id = sub ?? positional[0];
      if (!id) throw new WfError('usage: wf approve ID [--choice C] --attempt ATTEMPT (in the owner\'s own terminal) | wf approve ID --from-question [--choice C --quote "their words"] --attempt ATTEMPT (the owner\'s answer in the question panel or the chat)');
      const r = options['from-question'] ? await approveFromQuestion(root, id, options) : await approveInTerminal(root, id, options);
      const decided = (r.state.decisions ?? []).find((x) => x.id === r.decision);
      const settled = decided?.settles?.[r.choice] ?? [];
      // 0.7.27 (D41): the agent read the person's words; it tells them what it recorded, from which words, in the same reply, so a
      // misreading is seen at once and corrected (named failure: a reading the person never sees cannot be corrected).
      // 0.7.27 (review of the rework): an exact recording is read back too, so a reply the engine cannot see as a retraction is seen.
      const readBack = r.read ? `, as you read the person's words "${r.read.quote}"${r.read.message !== r.read.quote ? ` in their message "${r.read.message}"` : ''}. In this same reply, tell them what you recorded and from which words (${r.words ? 'their own words, recorded as theirs' : `"${plainLabel(decided, r.choice)}"`} to "${questionFor(r.state, decided)}"), and follow anything else their message asks; ${correctionHint(r.state, decided)}` : r.exact ? `. In this same reply, tell them what you recorded ("${plainLabel(decided, r.choice)}" to "${questionFor(r.state, decided)}"); ${correctionHint(r.state, decided)}` : '';
      print(options, `${r.decision} decided: ${r.words ? `in the person's own words: "${r.words}" (follow them; it grants nothing a choice would)` : r.choice}${readBack}.${settled.length ? ` This answer also decides ${settled.join(', ')}: record each with the command it needs (\`wf scope waive --finding <ids>\` for findings that block, \`wf scope defer\` or \`wf scope ticket\` for the rest, \`wf discovered close\` for a discovered issue); none asks the person again.` : ''} next: ${nextAction(root, r.state)}`, { decision: r.decision, choice: r.choice, ...(r.words ? { words: r.words } : {}), ...(r.read ? { read: r.read } : {}) });
      return 0;
    }
    case 'intent': {
      const r = setIntent(root, options, sub);
      print(options, r.changed ? `${r.state.id} is now an implementation attempt (was analysis; recorded with the reason).\n${summary(root, r.state)}` : `${r.state.id} is already an implementation attempt`, r.state);
      return 0;
    }
    // 0.7.31 (I-216, D67): an analysis attempt's findings, shown and closed (engine/analysis.mjs).
    case 'analysis': {
      if (!['record', 'show', 'close'].includes(sub)) throw new WfError('usage: wf analysis record --file <analysis.yaml> | wf analysis show [--all] [--json] | wf analysis close --reason "<what follows>" [--attempt ID]');
      if (sub === 'record') {
        const s = recordAnalysis(root, options);
        const a = latestAnalysis(s);
        print(options, `${s.id}: analysis ${a.id} recorded (${a.criteria.length} question(s) answered or marked unanswered${a.findings.length ? `, ${a.findings.length} other finding(s)` : ''}).\nnext: ${nextAction(root, s)}`, a);
        return 0;
      }
      if (sub === 'close') {
        const s = closeAnalysis(root, options);
        print(options, `${s.id}: analysis closed (${s.analysisClosed.reason}); its worktrees are removed and its branch kept. What it found: \`wf analysis show --attempt ${s.id}\`; the planner of ${s.item}'s next attempt, and the next implementers of one already open, are given it.`, s);
        return 0;
      }
      const s = openState(root, options);
      const list = options.all ? s.analyses ?? [] : [latestAnalysis(s)].filter(Boolean);
      if (!list.length) throw refuse(`${s.id} has no recorded analysis${s.intent === 'analysis' ? '' : ` (it is an ${s.intent} attempt)`}`, s.intent === 'analysis' ? '`wf resume` says what records it' : null, { id: 'analysis:none' });
      print(options, list.map((a) => analysisText(s, a)).join('\n\n'), options.all ? list : list[0]);
      return 0;
    }
    case 'unlock': {
      if (!options.attempt || options.attempt === true) throw new WfError('usage: wf unlock --attempt ID (removes the evidence lock of an attempt whose owner process is gone)');
      const r = unlockEvidence(root, String(options.attempt));
      print(options, r.note, r);
      return 0;
    }
    case 'signals': {
      const report = signalsReport(root, openState(root, options));
      print(options, signalsText(report), report);
      return 0;
    }
    case 'strategy': {
      if (sub !== 'record') throw new WfError('usage: wf strategy record --closure <file> [--attempt ID]');
      const r = recordStrategy(root, options);
      const d = r.decision;
      const parts = [`strategy decision ${d.id} recorded on ${r.state.id}: ${d.action}`, `prediction: ${d.prediction.signal} by ${typeof d.prediction.by === 'number' ? `round ${d.prediction.by}` : d.prediction.by}`];
      if (r.split) parts.push(`split ${r.split.id}: ${r.split.siblings.map((x) => x.id).join(', ')} joined ${r.split.batch} with ${r.state.id}`);
      if (r.escalation) parts.push(`the person decides ${r.escalation.id}: ${approveHint(r.state, r.escalation)}`);
      if (d.action === 'delta-review') parts.push('the next reviewer round is a delta round');
      if (d.action === 'ticket') parts.push(`follow-up tickets owed for ${d.items.join(', ')}: file them in the tracker (the engine records no ticket); they are not part of this delivery`);
      print(options, `${parts.join('\n  ')}\nnext: ${nextAction(root, r.state)}`, { decision: d, split: r.split ? { id: r.split.id, batch: r.split.batch, siblings: r.split.siblings.map((x) => x.id), moved: r.split.moved } : null, escalation: r.escalation?.id ?? null });
      return 0;
    }
    case 'split': {
      const s = openState(root, options);
      if (!options.items || options.items === true) throw new WfError('usage: wf split --items <ids> --reason "why" [--attempt ID] (ids: work items, criteria, observations as reviewer:F1, discovered issues)');
      const r = splitCommand(root, s, options);
      print(options, `${r.id}: ${r.siblings.map((x) => x.id).join(', ')} created beside ${s.id} in ${r.batch} (delivered together)\n  moved: ${Object.entries(r.moved).filter(([, v]) => v.length).map(([k, v]) => `${k} ${v.join(', ')}`).join('; ') || 'nothing'}\n  each sibling carries its criteria from the plan; start its implementer: \`wf handoff implementer --attempt ${r.siblings[0].id} --agent <id>\`\n  once every member is accepted: \`wf batch create --members ${[s.id, ...r.siblings.map((x) => x.id)].join(',')}\`\nnext: ${nextAction(root, r.state)}`, { split: r.id, batch: r.batch, siblings: r.siblings.map((x) => x.id), moved: r.moved });
      return 0;
    }
    // 0.7.30 (I-201, D62): another branch this attempt is delivered to, by a port admitted once its own delivery is complete.
    case 'target': {
      if (sub !== 'add') throw new WfError('usage: wf target add <repo>=<branch>[,...] --reason "why" [--attempt <id>]');
      const s = addTargets(root, openState(root, options), positional[0], { reason: options.reason, by: actorOf(options) });
      print(options, `${s.id} is also delivered to ${s.alsoTargets.map((t) => `${t.repo} -> ${t.branch}`).join(', ')}: ${s.delivery.completedAt ? `\`wf entry --item ${s.item} --port ${s.id} --target <repo>=<branch>\` admits each port` : 'each port is admitted by `wf deliver` once this delivery is complete'}`, s);
      return 0;
    }
    case 'hold': {
      const s = hold(root, options);
      print(options, `hold recorded on ${s.id}: "${options.reason}". Delivery is refused until \`wf release\`.`);
      return 0;
    }
    case 'release': {
      const s = release(root, options);
      print(options, `hold released on ${s.id}. next: ${nextAction(root, s)}`);
      return 0;
    }
    case 'reopen': {
      const opened = reopen(root, options);
      const api = await trackerApi(root, opened.id);
      const s = loadState(root, opened.id);
      const prompt = s.lessons?.waived ? '' : `\nrecord a lesson: \`wf lesson add --attempt ${s.id} --title "..." --what "..." --cause <class> --mechanism <kind> --quote ${JSON.stringify(String(options.reason))}\` (or \`--no-lesson "<why>"\` on \`wf deliver\`); the delivery does not close without one`;
      print(options, `${summary(root, s)}${api}${prompt}`, s);
      return 0;
    }
    case 'adopt': {
      const s = adopt(root, options);
      print(options, `you now own ${s.id}.\n${summary(root, s)}`, s);
      return 0;
    }
    case 'close': {
      if (!options.shipped) throw new WfError('usage: wf close --shipped --reason "why" --attempt ID (an attempt whose change is already on its target branches)');
      const s = closeShipped(root, options);
      const lines = Object.entries(s.shipped.repos).map(([n, h]) => `  ${n}: ${h.unchanged ? 'unchanged' : `${h.commit.slice(0, 10)} on ${h.target}`}`);
      const open = [...(s.shipped.open?.discovered ?? []).map((d) => `${d.id} (discovered${d.severity ? `, ${d.severity}` : ''}): ${d.summary}`), ...(s.shipped.open?.lastReview ?? []).map((f) => `${f.id} (last review${f.severity ? `, ${f.severity}` : ''}): ${f.summary}`)];
      print(options, `${s.id} closed as shipped (decision ${s.shipped.decision}), without the workflow's acceptance:\n${lines.join('\n')}${open.length ? `\nstill open when it was closed (recorded):\n  ${open.join('\n  ')}` : ''}\nworktrees removed; the tracker is not touched: move the ticket yourself`, s);
      return 0;
    }
    case 'abandon': {
      const s = abandon(root, options);
      print(options, `${s.id} abandoned: ${s.abandoned.reason}\nits branch ${Object.values(s.repos)[0]?.branch ?? ''} is kept so no work is lost; delete it with \`git branch -D\` when you no longer need it`);
      return 0;
    }
    case 'batch': {
      if (sub === 'create') {
        const s = batchCreate(root, options);
        // 0.7.29 (I-204): the members' checks the batch's gate now owes, and any it does not carry with why.
        const carried = (s.validations ?? []).filter((v) => v.carriedFrom).flatMap((v) => v.steps.map((x) => `${x.id} (from ${v.carriedFrom.map((c) => c.attempt).join(', ')})`));
        const left = (s.validationsNotCarried ?? []).map((x) => `${x.id} of ${x.member}: ${x.why}`);
        print(options, `${summary(root, s)}${carried.length ? `\nrequired on the combined tree, carried from the members: ${carried.join(', ')}; the batch's gate runs each at its pinned definition` : ''}${left.length ? `\nnot carried: ${left.join('; ')}` : ''}`, s);
        return 0;
      }
      if (sub === 'eject') {
        const s = batchEject(root, options);
        print(options, `ejected ${options.member} from ${options.batch}`, s);
        return 0;
      }
      throw new WfError('usage: wf batch create --members A,B | wf batch eject --batch B --member A');
    }
    case 'verify': {
      if (options['accept-changes']) {
        // Repair: the owner accepts what changed, with a reason, recorded in the ledger and shown to everyone after.
        const id = resolveAttempt(root, options);
        const reason = String(options.reason ?? '').trim();
        const { blocking, changes } = changesOf(root, id);
        const list = changes.map((c) => `  ${c.kind.padEnd(8)} ${c.path}  ${c.old ? c.old.slice(0, 12) : '(none)'} -> ${c.new ? c.new.slice(0, 12) : '(removed)'}`).join('\n');
        if (blocking.length) throw new WfError(`cannot re-baseline ${id}:\n  - ${blocking.join('\n  - ')}\n  the ledger itself is never re-baselined; links and non-regular files must be replaced or removed first`);
        if (!changes.length) {
          print(options, `${id}: nothing to re-baseline; the evidence matches what wf recorded`, { changes: [] });
          return 0;
        }
        if (!reason || options.reason === true) throw new WfError(`${changes.length} change(s) in the evidence of ${id}:\n${list}\nto accept them, give the reason: \`wf verify --accept-changes --reason "<why>" --attempt ${id}\` (recorded in the ledger and shown in status, export and the reviewer's bundle)`);
        const { actor } = await import('./attempt.mjs');
        const r = rebaseline(root, id, reason, append, actor(options));
        if (r.blocking.length) throw new WfError(`cannot re-baseline ${id}:\n  - ${r.blocking.join('\n  - ')}`);
        print(options, `re-baselined ${id}: ${r.changes.length} change(s) accepted ("${reason}"), recorded as evidence.rebaselined:\n${list}`, r);
        return 0;
      }
      // Reports, never refuses on open: the point is to list every problem.
      const ids = options.all ? listAttempts(root) : [resolveAttempt(root, options)];
      const bad = [];
      // Named failure (I-78): with the evidence folder renamed, `--all` verified the attempts left and printed success, never
      // mentioning the ones whose ledger is gone but whose anchor still records them.
      const lost = options.all ? lostLedgers(root).filter((l) => !ids.includes(l.id)) : [];
      for (const l of lost) bad.push({ id: l.id, problems: [`ledger.jsonl is missing, but its anchor records entry ${l.seq}: the attempt's evidence folder was renamed, moved or deleted`] });
      for (const id of ids) {
        const p = verifyAttempt(root, id, { full: true });
        // Named failure (I-78): with the evidence folder renamed, `wf verify --attempt X` printed "verified 1 attempt(s)" for an
        // attempt that has no ledger at all (an empty ledger reads as a pre-manifest attempt). The attempt asked for must exist;
        // a folder that is a link, or any other problem verification names, is still reported as such.
        if (!p.length && !options.all && !listAttempts(root).includes(id)) throw refuse(`${id} has no ledger here, so nothing was verified; ${lostLedgers(root).some((l) => l.id === id) ? 'its anchor records it, so its evidence folder was renamed, moved or deleted' : 'it is not an attempt of this project (or its evidence folder was renamed or moved)'}`, '`wf status --all` lists the attempts; restore the folder if it was moved', { id: 'verify:no-attempt' });
        if (p.length) bad.push({ id, problems: p });
      }
      print(options, bad.length ? bad.map((b) => `${b.id}: ${b.problems.length} problem(s): the evidence does not match what wf recorded\n  - ${b.problems.slice(0, 20).join('\n  - ')}`).join('\n') : `verified ${ids.length} attempt(s): ledger chain, anchor and every recorded evidence file (sha256, size, mode) match; no extra file`, bad);
      return bad.length ? 1 : 0;
    }
    case 'lesson':
    case 'lessons': {
      const { actor } = await import('./attempt.mjs');
      const cfg = loadConfig(root);
      const stats = lessonStats(root);
      const show = (l) => `${l.id}  ${l.scope === 'project' ? `project, in ${l.home}` : l.repo} (${l.where})  [${l.status}, ${l.cause}, ${l.mechanism?.kind}${l.mechanism?.ref ? ` ${l.mechanism.ref}` : ''}${l.mergedInto ? `, merged into ${l.mergedInto}` : ''}] recurrence ${totalRecurrence(l, stats)}${stats.get(lessonKey(l))?.lastRepeatAt ? ` (last ${stats.get(lessonKey(l)).lastRepeatAt.slice(0, 10)})` : ''}  ${l.title}`;
      if (sub === 'add') {
        if (options.attempt) openState(root, options);
        const r = addLesson(root, options, actor(options));
        if (r.plugin) throw new WfError('a finding about the workflow itself is not a lesson: it is an improvement to the plugin. Record it in your inbox (outside every repo) with `wf improve add --title "..." --what "..." --observed-in <attempt or step> --quote "<their words>" --class <engine|template|skill|guard|tracker|onboarding|docs|other>`; the plugin\'s maintainer fixes it there with a scenario test.');
        const flags = r.recurred.map((x) => `\nlesson ${x.id} recurred (recurrence ${x.recurrence}): its mechanism failed${x.promote ? `; promote it to a gate check (\`wf lesson apply ${x.id}\` after setting \`mechanism.kind: gate-check\`)` : ''}`).join('');
        let closed = '';
        if (options.attempt) {
          const s = await closeAfterHandoff(root, loadState(root, String(options.attempt)));
          if (s.phase === 'done') closed = `\n${s.id} closed.`;
        }
        print(options, `${r.scope === 'project' ? 'project ' : ''}lesson ${r.lesson.id} recorded in ${r.repo}${r.scope === 'project' ? ' (the adapter repo: it spans the project)' : ''}: ${r.file}\n  ${r.inAttempt ? `committed in ${options.attempt}'s worktree: it is reviewed and delivered with this attempt` : `in ${r.repo}'s main checkout: commit it there`}; to enforce it: \`wf lesson apply ${r.lesson.id}\`${flags}${closed}`, r);
        return 0;
      }
      if (sub === 'waive') {
        const s = openState(root, options);
        const reason = String(options.reason ?? '').trim();
        if (!reason || options.reason === true) throw new WfError('--reason "<why this needs no lesson>" is required');
        append(root, s.id, 'lesson.waived', { reason, on: 'waive' }, actor(options));
        const after = await closeAfterHandoff(root, loadState(root, s.id));
        print(options, `no lesson for ${s.id}: "${reason}" (recorded)${after.phase === 'done' ? `\n${s.id} closed.` : `\nnext: ${nextAction(root, after)}`}`);
        return 0;
      }
      if (sub === 'merge') {
        if (positional.length < 2) throw new WfError('usage: wf lesson merge <id> <id>... --title "<the one mistake>" --attempt <id> [--what "..."] [--cause <class>] [--mechanism <kind>]');
        const s = openState(root, options);
        const r = mergeLessons(root, positional, { ...options, attempt: s.id }, actor(options));
        print(options, `lessons ${r.merged.join(', ')} merged into ${r.lesson.id} (recurrence ${r.lesson.recurrence}): ${r.lesson.title}\n  ${r.file} (committed in ${s.id}; the members are retired there, and stop applying once it is delivered)`, r);
        return 0;
      }
      if (sub === 'distinct') {
        const r = distinctLessons(root, positional, { state: options.attempt ? openState(root, options) : null });
        print(options, `lessons ${r.lessons.join(', ')} are different mistakes: no merge of them is proposed again`, r);
        return 0;
      }
      if (sub === 'recur') {
        const id = positional[0];
        if (!id) throw new WfError('usage: wf lesson recur <id> --attempt <attempt>');
        const s = options.attempt ? openState(root, options) : null;
        const r = recur(root, id, s?.id ?? null, actor(options), options.reason ?? null);
        print(options, `lesson ${id} recurred (recurrence ${r.recurrence}): its mechanism failed${r.promote ? '; promote it to a gate check' : ''}`, r);
        return 0;
      }
      if (sub === 'move') {
        if (options.improvement) {
          const { lessonToImprovement } = await import('./lessons.mjs');
          const r = await lessonToImprovement(root, positional[0], options);
          print(options, `lesson ${r.id} is a plugin improvement: ${r.improvement} in your inbox (${r.file}); ${r.removed} removed from the project (commit that)`, r);
          return 0;
        }
        const r = moveLesson(root, positional[0], options);
        print(options, `lesson ${r.id} moved: ${r.from} -> ${r.to}${r.inAttempt ? ' (committed in the attempt)' : '; commit both repos'}`, r);
        return 0;
      }
      if (sub === 'preview') {
        const s = openState(root, options);
        const role = String(options.role ?? '');
        if (!['planner', 'implementer', 'reviewer'].includes(role)) throw new WfError('--role planner|implementer|reviewer');
        const changed = Object.fromEntries(Object.keys(s.repos).map((r) => [r, changedFiles(s, r)]));
        const sel = relevantLessons(root, role, s, role === 'planner' ? {} : changed);
        const rows = sel.apply.map((l) => `  ${l.id} [${l.label}] ${l.repo ? `${l.repo}: ` : ''}${l.title}\n     matched: ${l.matched.join('; ')}`);
        const out = sel.filtered.map((l) => `  ${l.id} ${l.repo ? `${l.repo}: ` : ''}${l.title}\n     filtered: ${l.reason}`);
        print(options, `the ${role} of ${s.id} would receive ${sel.apply.length} lesson(s)${sel.omitted.length ? `; ${sel.omitted.length} advisory omitted by the cap: ${sel.omitted.join(', ')}` : ''}\n${rows.join('\n') || '  none'}${out.length ? `\nfiltered out, outside this change's scope (${out.length}):\n${out.join('\n')}` : ''}`, sel);
        return 0;
      }
      if (sub === 'set') {
        const r = setLesson(root, positional[0], options);
        print(options, `lesson ${r.lesson.id}: ${show(r.lesson)}\n  ${r.file} (commit it)`, r);
        return 0;
      }
      if (sub === 'apply') {
        const l = findLesson(loadLessons(root), positional[0]);
        if (!l) throw new WfError(`no lesson ${positional[0] ?? ''}`);
        const a = applySnippet(l);
        print(options, `to enforce ${l.id} (${l.mechanism?.kind}), add to ${a.where}:\n\n${a.snippet}\nwf changes nothing itself: add it, commit it with the owner's approval, then \`wf lesson set ${l.id} --status enforced${a.ref ? ` --ref ${a.ref}` : ' --ref <what enforces it>'}\``, a);
        return 0;
      }
      if (sub === 'show') {
        const l = findLesson(loadLessons(root), positional[0]);
        if (!l) throw new WfError(`no lesson ${positional[0] ?? ''}`);
        // Named failure (I-110): a project lesson that declares no repo, components, paths, kinds or tags was shown as "matched only by its
        // tags in the ticket", but since I-64 it applies to every change in the project (`projectWide` in relevantLessons, engine/lessons.mjs).
        const declared = [l.repo ? `repo ${l.repo}` : null, l.components?.length ? `components ${l.components.join(', ')}` : null, l.paths.length ? `paths ${l.paths.join(', ')}` : null, l.kinds?.length ? `kinds ${l.kinds.join(', ')}` : null].filter(Boolean);
        const reach = declared.length ? declared.join('; ')
          : isProjectWide(l) ? 'none declared, so it applies to every change in the project (a project lesson that narrows itself by nothing is project-wide)'
            : l.tags.length ? 'none declared (matched only by its tags in the ticket)'
              : 'none declared, and no tags: it matches no change (add `paths: ["**"]` to apply it to every change)';
        print(options, `${show(l)}\n  what happened: ${l.trigger?.what ?? ''}${l.trigger?.quote ? `\n  in their words: "${l.trigger.quote}"` : ''}${l.trigger?.attempt ? `\n  seen in: ${l.trigger.attempt}${l.trigger.finding ? ` (finding ${l.trigger.finding})` : ''}` : ''}\n  tags: ${l.tags.join(', ') || 'none'}; scope: ${reach}\n  ${l.file}`, l);
        return 0;
      }
      if (sub === 'review') {
        const r = reviewLessons(root, { after: options.after ? Number(options.after) : 10 });
        const part = (title, list, hint) => `${title} (${list.length})${list.length ? `:\n${list.map((l) => `  ${show(l)}`).join('\n')}\n  → ${hint}` : ''}`;
        print(options, [part('recurring: promote the mechanism to a gate check, or (a standing rule for every ticket) the sentence to the quality bar', r.promote, '`wf lesson apply <id>` with mechanism gate-check; a rule every change is held to also goes under `quality:` in the adapter, with the user\'s go'), part('proposed: apply the mechanism', r.apply, '`wf lesson apply <id>`, then `wf lesson set <id> --status enforced --ref ...`'), part(`not injected into any of the last ${r.attempts} attempts: retire?`, r.retire, '`wf lesson set <id> --status retired`')].join('\n'), r);
        return 0;
      }
      if (sub === 'export') {
        if (!options.plugin) throw new WfError('usage: wf lesson export --plugin [--out FILE]');
        const items = exportPluginLessons(root, cfg);
        const text = items.length ? `# Lessons for agentic-workflow\n\nGeneric issue text, names stripped. Review it before filing; wf never posts it.\n\n${items.map((x) => x.text).join('\n')}` : 'no plugin lessons';
        if (typeof options.out === 'string') fs.writeFileSync(options.out, text);
        print(options, typeof options.out === 'string' ? `wrote ${items.length} plugin lesson(s) to ${options.out}; review it and file it yourself` : text, items);
        return 0;
      }
      if (sub === 'list' || !sub) {
        const all = loadLessons(root);
        // A lesson declaring no scope is injected only when the ticket mentions one of its tags.
        const unscoped = all.filter((l) => l.status !== 'retired' && l.scope !== 'plugin' && !l.repo && !l.paths.length && !l.components?.length && !l.kinds?.length && l.tags.length).map((l) => `lesson ${l.id} declares no scope (repo, components, paths or kinds): it is injected only when the ticket mentions one of its tags (${l.tags.join(', ') || 'it has none'}); add \`components\`, \`paths\` or \`kinds\` to its file, or \`paths: ["**"]\` for every change`);
        const warn = [...lessonWarnings(root), ...unscoped].map((w) => `\nwarning: ${w}`).join('');
        print(options, `${all.length ? all.map(show).join('\n') : `no lessons yet (${path.join('.workflow', 'lessons')})`}${warn}`, all);
        return 0;
      }
      throw new WfError('usage: wf lesson add|waive|recur|merge|distinct|move|set|apply|show|list|preview|review|export');
    }
    case 'evidence': {
      // I-16: read-only access to an attempt's evidence, so no shell command needs the folder's name.
      if (sub === 'list') {
        const { listEvidence } = await import('./evidence-read.mjs');
        const s = openState(root, options);
        const r = listEvidence(root, s, { kind: typeof options.kind === 'string' ? options.kind : null });
        const groups = new Map();
        for (const f of r.files) groups.set(f.kind, [...(groups.get(f.kind) ?? []), f]);
        const text = [...groups].map(([k, fs]) => `${k} (${fs.length}):\n${fs.map((f) => `  ${f.path}${f.size !== null ? `  ${f.size} B` : ''}\n    ${f.file}`).join('\n')}`).join('\n');
        const shots = groups.has('screenshot') ? `\nscreenshots: copy them out with \`wf export screenshots --gate --attempt ${s.id} --to <folder>\` and view the copies (the last gate's collected set; \`--run <run id>\` copies every image of one run, failed, stopped or interrupted ones too, the run id being the folder under gate/; \`--run import-<n>\` an import's)` : '';
        print(options, `${r.files.length ? text : `no evidence files${options.kind ? ` of kind ${options.kind}` : ''} in ${s.id}`}${shots}\nread a text file: \`wf evidence show <path> --attempt ${s.id}\`, or the Read tool on the full path`, r);
        return 0;
      }
      if (sub === 'inspect') {
        const { inspectEvidence } = await import('./evidence-read.mjs');
        const s = openState(root, options);
        const r = inspectEvidence(root,s,positional[0],{pointer:options.pointer,from:options.from,count:options.count});
        print({...options,json:true},'',r);
        return 0;
      }
      if (sub === 'show') {
        const { showEvidence } = await import('./evidence-read.mjs');
        const s = openState(root, options);
        const r = showEvidence(root, s, positional[0], { offset: options.offset, length: options.length });
        if (options.json || r.offset !== undefined) print({ ...options, json: true }, '', r);
        else process.stdout.write(`${r.text}${r.text.endsWith('\n') ? '' : '\n'}${r.truncated ? `… (${r.size} B; the first part only: read the rest with the Read tool on ${r.file})\n` : ''}`);
        return 0;
      }
      if (sub !== 'release') throw new WfError('usage: wf evidence list [--kind K] | show <path> | inspect <path> [--pointer P --from N --count N] | release [--attempt ID | --closed | --older-than DAYS] [--reason "why"] [--dry-run]');
      // The sanctioned way to delete evidence: closed attempts only, protection lifted by the engine, a tombstone left.
      const pick = options.attempt ? [resolveAttempt(root, options)] : listAttempts(root);
      const cutoff = options['older-than'] !== undefined ? Date.now() - Number(options['older-than']) * 86400000 : null;
      if (cutoff !== null && !Number.isFinite(cutoff)) throw new WfError('--older-than takes a number of days');
      if (!options.attempt && !options.closed && cutoff === null) throw new WfError('name what to release: --attempt ID, --closed, or --older-than DAYS');
      const chosen = [];
      const refused = [];
      for (const id of pick) {
        const folder = path.join(root, '.wf-evidence', 'attempts', id);
        const fst = fs.lstatSync(folder, { throwIfNoEntry: false });
        if (fst && !fst.isDirectory()) {
          refused.push(`${folder} is a symlink or not a folder; nothing released through it`);
          continue;
        }
        const s = loadState(root, id);
        if (!['done', 'abandoned'].includes(s.phase)) {
          if (options.attempt) refused.push(`${id} is ${s.phase}; only closed or abandoned attempts are released`);
          continue;
        }
        const at = Date.parse(s.closedAt ?? s.abandoned?.at ?? '');
        if (cutoff !== null && !(at < cutoff)) continue;
        chosen.push(id);
      }
      if (refused.length) throw new WfError(refused.join('\n'));
      if (options['dry-run'] || !chosen.length) {
        print(options, chosen.length ? `would release ${chosen.length} attempt(s): ${chosen.join(', ')} (nothing changed)` : 'nothing to release', { chosen });
        return 0;
      }
      const out = chosen.map((id) => releaseAttempt(root, id, String(options.reason ?? 'released by the owner')));
      const left = out.filter((r) => r.leftover);
      print(options, `released ${out.length} attempt(s): ${out.map((r) => r.id).join(', ')}; their ids are tombstoned (a ledger reappearing under one is refused)${left.length ? `\n  not fully removed (moved out of attempts/, so not listed): ${left.map((r) => r.leftover).join('; ')}` : ''}`, out);
      return left.length ? 1 : 0;
    }
    case 'resume': {
      // `wf resume <item or attempt id>`: the name picks the attempt (0.7.6: it was ignored, and another item's attempt shown).
      const named = options.attempt ? null : sub ?? positional[0] ?? null;
      const s = openState(root, named ? { ...options, attempt: attemptForName(root, named) } : options);
      const gone = orphansOf(s);
      const base = isOpen(s) && !gone.length ? safeBase(root, s) : null;
      print(options, summary(root, s, { base, resume: true }), { ...s, next: nextAction(root, s), decision: gone.length ? null : nextDecision(root, s), liveGate: liveGate(root, s), base, ...(gone.length ? { orphaned: gone } : {}) });
      return 0;
    }
    case 'status': {
      // --attempt narrows the listing to that attempt; without it every open attempt is shown.
      // Named failure (I-78): the evidence was opened by the id the ledger's admission entry names, which an emptied ledger does not
      // have, so `wf status` crashed on it. The attempt's folder name is the id; opening it reports what is wrong with the ledger.
      // Independent review of 0.7.4: one attempt with a damaged ledger made `wf status` refuse for every attempt, so the healthy
      // ones disappeared from it. A damaged one is listed as such, with the check to run, and the others as always.
      const damaged = [];
      const states = options.attempt ? [openState(root, options)] : listAttempts(root).flatMap((id) => {
        try {
          const s = loadState(root, id);
          if (!isOpen(s)) return [];
          openEvidence(root, id);
          // 0.7.30 (I-151, D60): as `openState` does, each listed attempt takes its base branch's adapter where it safely can.
          return [followAdapter(root, settleRoundQuestions(root, s))];
        } catch (error) {
          damaged.push({ id, damaged: String(error.message ?? error).split('\n').filter(Boolean).slice(0, 2).join(' ') });
          return [];
        }
      });
      const rows = states.map((s) => ({ s, base: isOpen(s) && !orphansOf(s).length ? safeBase(root, s) : null }));
      const damagedText = damaged.map((d) => `${d.id}  DAMAGED: ${d.damaged}\n  next: \`wf verify --attempt ${d.id}\` says what changed; the evidence is never repaired by hand`);
      const text = [...rows.map(({ s, base }) => summary(root, s, { base })), ...damagedText].join('\n\n');
      if (options.json && damaged.length) {
        print(options, '', [...rows.map(({ s, base }) => ({ ...s, next: nextAction(root, s), base, ...(orphansOf(s).length ? { orphaned: orphansOf(s) } : {}) })), ...damaged]);
        return 0;
      }
      print(options, text || 'no open attempts', options.json ? rows.map(({ s, base }) => ({ ...s, next: nextAction(root, s), base, ...(orphansOf(s).length ? { orphaned: orphansOf(s) } : {}) })) : undefined);
      return 0;
    }
    case 'base': {
      if (sub === 'merge') {
        const r = baseMerge(root, options);
        const lines = r.results.map((x) => (x.settled ? `${x.repo}: left as it is (already settled in this delivery: ${x.settled})` : x.idle ? `${x.repo}: left as it is (this ticket changes nothing there, so the delivery skips it)` : x.landed ? `${x.repo}: left as it is (its change is already on ${x.ref}; \`wf deliver\` records it)` : x.upToDate ? `${x.repo}: already on its base${x.note ? ` (${x.note})` : ''}` : `${x.repo}: merged ${x.ref} (${x.commits} commit(s), ${x.files} file(s)); HEAD ${x.headBefore.slice(0, 10)} -> ${x.headAfter.slice(0, 10)}${x.overlap.length ? `\n  note: the merge brought in changes to files this ticket also changes: ${x.overlap.join(', ')}; check the merged result` : ''}${x.infra.length ? `\n  note: shared infrastructure changed: ${x.infra.join(', ')}` : ''}`));
        const moved = r.results.some((x) => x.headAfter && x.headBefore !== x.headAfter);
        // 0.7.26 (I-183): with a delivery adapter the acceptance is withdrawn; the line says what runs again and what stays.
        if (r.withdrewAcceptance) lines.push(r.started ? 'HEAD changed: the acceptance is withdrawn, because it names the commit the pending integration (the merge or pull request) was opened for, and the merged tree has neither a gate nor a review. Gate it, have it reviewed and accept it again; then `wf deliver` asks the delivery adapter to integrate the reconciled branch. A repo already delivered or skipped is not touched.' : 'HEAD changed: the acceptance is withdrawn, because it names the commit the delivery adapter will integrate and the merge will be recognised by, and the merged tree has neither a gate nor a review. Gate it, have it reviewed and accept it again; then `wf deliver` asks the delivery adapter to integrate the merged branch.');
        else if (moved) lines.push('HEAD changed: the gate and the review are bound to the tree, so neither counts for the merged tree. Run `wf gate`, then hand the tree to a fresh reviewer.');
        print(options, `${lines.join('\n')}\nnext: ${nextAction(root, r.state)}`, r);
        return 0;
      }
      if (sub && sub !== 'status') throw new WfError('usage: wf base [status] | wf base merge [--repo R]');
      const s = openState(root, options);
      const base = baseStatus(root, s);
      const lines = baseLines(base);
      print(options, lines.length ? lines.join('\n').replace(/^ {2}/gm, '') : 'every base is current', base);
      return 0;
    }
    default:
      throw new WfError(`unknown command \`${cmd}\`; run \`wf help\``);
  }
}
