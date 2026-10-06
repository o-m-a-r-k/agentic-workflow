import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import { abandon, adopt, changedFiles, entry, hold, openState, release, resolveAttempt } from './attempt.mjs';
import { baseLines, baseMerge, baseStatus } from './base.mjs';
import { findRoot, loadConfig, requireRoot } from './config.mjs';
import { exportAttempt, exportFile } from './export.mjs';
import { liveGate, runGate, runWithLease, stopGate } from './gate.mjs';
import { append, listAttempts, loadState, openEvidence } from './ledger.mjs';
import { canonical, touchesEvidence } from './paths.mjs';
import { addLesson, applySnippet, exportPluginLessons, lessonPrompts, loadLessons, recur, reviewLessons, setLesson } from './lessons.mjs';
import { LinkRefused, changesOf, rebaseline, releaseAttempt, seal, setVerifyLevel, verifyAttempt } from './evidence.mjs';
import { acceptReview, amendCriteria, designWarning, batchCreate, batchEject, closeAfterHandoff, deliver, deliveredFiles, exportScreenshots, freezeCriteria, handoff, narrowDelivery, needsShown, nextAction, outsideWarning, recordReview, recordShown, reopen, screenshotsExportDir, shownDraftFile, uncovered, withAttempt } from './lifecycle.mjs';
import { detect, doctor, register, registry, setEnabled, sync, writeDraft } from './onboard.mjs';
import * as secrets from './secrets.mjs';
import { report, toCsv, toHandoffCsv, toHtml } from './telemetry.mjs';
import { impact } from './topology.mjs';
import { commentFile, performTracker, recordSummary, recordTracker } from './tracker.mjs';
import { ENGINE_VERSION, WfError, parseArgs } from './util.mjs';

const HELP = `wf ${ENGINE_VERSION} — agentic-workflow

Onboarding
  wf install [--dir DIR]            link wf into ~/.local/bin
  wf init [--force]                 detect the project and draft .workflow/ (disabled)
  wf doctor [--no-steps]            check config, tools, secrets, skills; run light steps on a clean base
  wf enable | wf disable            turn the workflow on/off for this project
  wf sync                           regenerate the AGENTS.md block, role agents, vendored skills
  wf topology [--check]             show components and what the change touches; --check compares with the code
  wf skills update NAME --from DIR  replace a vendored skill (review and commit it, then wf sync)
  wf secrets status|init|set KEY|guide [KEY]

Work
  wf entry [--item ID] [--lane quick|standard] [--intent implementation|analysis] [--repos a,b] [--defer-heavy] [--issue-file F]
  wf plan --file plan.yaml | --from-agent PLANNER_ID
                                    freeze acceptance criteria and the plan (--from-agent: the planner's last YAML block)
  wf criteria amend --file f --reason "why"
  wf handoff planner|implementer|reviewer|tester --agent ID [--work W1] [--session SID] [--runtime claude|codex]
  wf check [--repo R]               light steps only, for the implementer; reused by the gate, never counts as one
  wf gate [--prepare-only] [--full] [--focused] [--rerun-failed]
  wf run --lease NAME -- CMD...     run a command holding a machine-wide lease (docker, browser...)
  wf base [merge] [--repo R]        how far each base moved; merge merges it into the worktrees
  wf stop --reason "why"            pause a running gate; finished steps are kept
  wf review --closure file.json     record the reviewer's closure
  wf accept                         accept the review
  wf summary --file summary.md      the owner's plain-language summary for the delivered comment
  wf deliver [--summary-file F]     integrate every repo, then start the tracker handoff
  wf shown --file shown.json        record that every delivered screenshot was shown in the chat, with its caption and anomalies
  wf delivery narrow --keep SHA,... | --file keep.json --reason "why" [--dry-run]
                                    once, before \`wf shown\`: keep only this ticket's files of a delivered set an over-broad glob filled
  wf tracker record --event E --capture file.json | wf tracker sync (tracker.via: api)
  wf hold --reason "why" | wf release
  wf lesson add|waive|recur|set|apply|show|list|review|export
                                    the project's lessons (.workflow/lessons/): capture, enforce, recurrence
  wf reopen --item ID --reason "feedback" [--no-lesson "why"]
  wf adopt [--attempt ID]           take over a live attempt from a new session
  wf abandon --reason "why"
  wf batch create --members A,B | wf batch eject --batch B --member A

Status
  wf resume                         what to do next
  wf status [--all] [--json]
  wf report [--all] [--csv FILE] [--handoffs-csv FILE] [--html FILE]
  wf verify [--attempt ID | --all]  re-hash every recorded evidence file, check the chain and its anchor
  wf verify --accept-changes --reason "why"   show changed evidence files and accept them (recorded, shown everywhere)
  wf evidence release [--attempt ID | --closed | --older-than DAYS] [--dry-run]
                                    delete closed attempts' evidence through the engine (protection lifted, tombstone kept)
  wf export [--out FILE] [--json]   one self-contained page for the attempt (a view of the evidence)
  wf export screenshots [--gate] [--to DIR]
                                    copy the delivered (or, --gate, the last gate's) screenshots out of the evidence

Common options: --attempt ID, --json, --owner ID`;

const print = (options, human, data) => {
  if (options.json) process.stdout.write(`${JSON.stringify(data ?? human, null, 2)}\n`);
  else process.stdout.write(`${typeof human === 'string' ? human : JSON.stringify(human, null, 2)}\n`);
};

function summary(root, s, { base = null, resume = false } = {}) {
  const lines = [`${s.id}  ${s.item}  lane=${s.lane}  intent=${s.intent}  phase=${s.phase}`, `  owner: ${s.owner}`];
  for (const [name, r] of Object.entries(s.repos)) lines.push(`  ${name}: ${r.worktree} (base ${r.base.slice(0, 10)})`);
  if (base) lines.push(...baseLines(base));
  if (s.activeHold) lines.push(`  HOLD: ${s.activeHold.reason}`);
  try {
    const all = loadLessons(root);
    if (all.length || s.lessons) {
      const by = (st) => all.filter((l) => l.status === st).length;
      lines.push(`  lessons: ${all.length} in the project (${by('enforced')} enforced, ${by('proposed')} proposed); this attempt: ${s.lessons?.recorded?.length ?? 0} recorded${s.lessons?.waived ? `, none needed ("${s.lessons.waived.reason}")` : ''}`);
    }
    for (const r of s.lessons?.recurred ?? []) lines.push(`  LESSON ${r.id} RECURRED (recurrence ${r.recurrence}): its mechanism failed${r.recurrence >= 2 ? '; `wf lesson review` proposes promoting it to a gate check' : ''}`);
    if (!['done', 'abandoned'].includes(s.phase)) for (const p of lessonPrompts(s)) lines.push(`  lesson: ${p}`);
  } catch {}
  for (const r of s.rebaselines ?? []) lines.push(`  EVIDENCE RE-BASELINED ${r.at} by ${r.by}: ${r.changes.length} file(s) changed outside wf were accepted ("${r.reason}"): ${r.changes.slice(0, 5).map((c) => `${c.kind} ${c.path}`).join(', ')}${r.changes.length > 5 ? ' …' : ''}`);
  const live = ['done', 'abandoned'].includes(s.phase) ? null : liveGate(root, s);
  if (live) {
    lines.push(`  gate running: ${live.runId} (pid ${live.pid})`);
    lines.push(`    running: ${live.running.map((r) => `${r.id} (${r.seconds}s)`).join(', ') || 'none (waiting for a lease)'}`);
    lines.push(`    finished: ${live.finished.map((r) => `${r.id} ${r.status}${r.seconds !== null ? ` ${r.seconds}s` : ''}`).join(', ') || 'none yet'}`);
  }
  if (s.lastGate) lines.push(`  last gate: ${s.lastGate.status} (${s.lastGate.runId})`);
  if (s.checks?.length) lines.push(`  last check: ${s.checks.at(-1).status} (${s.checks.at(-1).runId}; light steps only, never counts as the gate)`);
  if (s.flaky?.length) lines.push(`  flaky: ${[...new Set(s.flaky.map((f) => `${f.step}${f.suites?.length ? ` (${f.suites.join(', ')})` : ''}`))].join(', ')} failed and then passed with the same inputs`);
  if (s.criteria && isOpen(s) && !s.accepted) {
    try {
      const w = outsideWarning(root, s);
      if (w) lines.push(`  warning: ${w}`);
    } catch {}
  }
  if (s.delivery.narrowed && !s.delivery.screenshots) lines.push(`  delivered files narrowed from ${s.delivery.narrowed.from} to ${s.delivery.narrowed.to}: ${s.delivery.narrowed.reason} (${s.delivery.narrowed.by}, ${s.delivery.narrowed.at})`);
  if (s.phase === 'handoff-pending' && s.delivery.screenshots) lines.push(showBlock(root, s).trim().replace(/^/gm, '  ').replace(/^ {2}SHOW TO OWNER/, '  delivered screenshots — SHOW TO OWNER'));
  const delivered = s.delivery.completedAt ? deliveredFiles(s) : [];
  if (delivered.length) lines.push(`  delivered screenshots (${delivered.length}): ${s.delivery.exported ? `viewable copies in ${s.delivery.exported.dir}` : `copy them out to view: ${exportCommand(root, s)}`}`);
  if (s.phase === 'handoff-pending' && s.tracker.pending.some((a) => a.rendered === 'delivered')) lines.push(`  delivered comment: ${s.delivery.summary ? commentFile(root, s.id) : 'needs the owner\'s summary: `wf summary --file <summary.md>`'}`);
  if (resume) {
    const last = s.exports?.filter((x) => !x.json).at(-1)?.file ?? (fs.existsSync(exportFile(root, s.id)) ? exportFile(root, s.id) : null);
    lines.push(`  export: ${last ?? 'none yet'}${last ? '' : ' (`wf export` writes one page for this attempt)'}`);
    const p = s.plan && typeof s.plan === 'object' ? s.plan : s.plan ? { summary: s.plan } : null;
    const missing = p ? ['contract', 'anchors'].filter((k) => p[k] === undefined) : [];
    if (missing.length) lines.push(`  warning: the frozen plan has no ${missing.join(' or ')} section, so implementers have none to follow`);
  }
  lines.push(`  next: ${live ? withAttempt(root, s, 'a gate is running: wait for it to finish (or `wf stop --reason "why"`); do not edit the worktrees meanwhile') : nextAction(root, s)}`);
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
  const narrowed = n ? `\n  narrowed from ${n.from} to ${n.to}: ${n.reason} (${n.by}, ${n.at})` : '';
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
  return `\n${head}${narrowed}\n${rows.join('\n')}${anomalies}${view}`;
}

function gateText(result) {
  const rows = (result.plan?.steps ?? result.record?.steps ?? []).map((s) => {
    const d = s.decision ?? s.status;
    const extra = s.reason ? `  ${s.reason}` : s.durationMs !== undefined ? `  ${(s.durationMs / 1000).toFixed(1)}s${s.workers ? ` workers=${s.workers.n}(${s.workers.source})` : ''}${s.log && s.status === 'failed' ? `  log: ${s.log}` : ''}` : '';
    return `  ${d.padEnd(11)} ${s.id}${extra}`;
  });
  const focused = (result.record ?? result.plan)?.focused ? ' (focused: proof while repairing; acceptance and delivery need a gate without --focused)' : '';
  const head = result.record ? `gate ${result.record.status} (${result.record.runId})${focused}` : `gate plan${result.plan.full ? ' (full: the adapter changed)' : ''}${focused}`;
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
    process.stdout.write(`${HELP}\n`);
    return 0;
  }
  if (cmd === 'version' || cmd === '--version') {
    process.stdout.write(`${ENGINE_VERSION}\n`);
    return 0;
  }
  // Commands that rely on evidence content re-hash every recorded file first; the others check presence, type, size
  // and mode. Whatever this process wrote into an attempt's evidence is recorded and protected when it ends.
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

const FULL_VERIFY = new Set(['accept', 'deliver', 'verify', 'review', 'tracker', 'export', 'shown', 'delivery', 'summary', 'handoff', 'gate', 'check', 'evidence']);

const WRITE_OPTIONS = ['out', 'csv', 'handoffs-csv', 'html', 'dir', 'to', 'root'];
const READ_OPTIONS = ['file', 'capture', 'summary-file', 'closure', 'issue-file', 'from'];
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
  const resolved = canonical(raw);
  if (touchesEvidence(resolved)) bad('resolves into .wf-evidence/');
  const st = fs.statSync(resolved, { throwIfNoEntry: false });
  if (READ_OPTIONS.includes(k)) {
    if (!FOLDER_OPTIONS.has(k) && /[\\/]$/.test(raw)) bad('ends with a slash but names a file');
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
  if (cfg.tracker.via !== 'api') return '';
  const r = await performTracker(root, cfg, loadState(root, id));
  let s = loadState(root, id);
  if (r.performed.length) s = closeAfterHandoff(root, s);
  return `${r.performed.length ? `\ntracker: ${r.performed.join(', ')} performed through the API and read back${s.phase === 'done' ? '; attempt closed' : ''}` : ''}${r.note ? `\ntracker: ${r.note}` : ''}`;
}
// Base status is information: a failure to read it never fails the command.
function safeBase(root, s) {
  try {
    return baseStatus(root, s);
  } catch {
    return null;
  }
}

async function dispatch(cmd, sub, positional, options) {
  // `wf` is the one command the evidence guard lets name .wf-evidence/. No option of it may write there, and an input
  // file is read only when it is a regular file outside the evidence (another attempt's evidence is not an input).
  // Every path option is resolved once here, through engine/paths.mjs, validated, and replaced by that resolved path:
  // what is checked is what every later open or write uses (never re-derived from the raw argument).
  for (const k of PATH_OPTIONS) {
    if (!(k in options)) continue;
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
    fs.mkdirSync(dir, { recursive: true });
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
    print(options, `drafted ${file} (disabled)${detected.compose.length ? `\n  docker compose: ${detected.compose.join(', ')} (steps using it should hold the \`docker\` lease)` : ''}\n  repos: ${detected.repos.map((r) => `${r.name}@${r.base} [${r.packages.map((p) => p.path).join(', ')}]`).join('; ')}\n  steps: ${detected.steps.map((s) => s.id).join(', ') || 'none detected'}\n  components: ${detected.components.map((c) => `${c.id} (${c.kind})`).join(', ')}\n  secrets: ${detected.secrets.filter((s) => s.usedBy.length).map((s) => `${s.key} (${s.kind}, used by ${s.usedBy.join(', ')})`).join(', ') || 'none a detected step uses'}${detected.secrets.some((s) => !s.usedBy.length) ? ` (not catalogued: ${detected.secrets.filter((s) => !s.usedBy.length).map((s) => s.key).join(', ')})` : ''}${detected.notes.map((n) => `\n  note: ${n}`).join('')}\nnext: review the draft with the user, commit .workflow/ on the base branch and push it, then \`wf doctor\` and \`wf enable\``, { file, detected });
    return 0;
  }
  if (cmd === 'report') {
    const roots = options.all ? registry().projects.map((p) => p.root).filter((r) => fs.existsSync(r)) : [requireRoot()];
    const rows = report(roots, { home: process.env.WF_HOME ?? os.homedir() });
    if (options.csv) fs.writeFileSync(String(options.csv), toCsv(rows));
    if (options['handoffs-csv']) fs.writeFileSync(String(options['handoffs-csv']), toHandoffCsv(rows));
    if (options.html) fs.writeFileSync(String(options.html), toHtml(rows));
    const files = [options.csv, options['handoffs-csv'], options.html].filter(Boolean);
    print(options, files.length ? `wrote ${files.join(' and ')} (${rows.length} attempt(s))` : `${toCsv(rows)}\n${toHandoffCsv(rows)}`, rows);
    return 0;
  }
  if (cmd === 'status' && options.all) {
    const out = [];
    for (const p of registry().projects) {
      if (!fs.existsSync(p.root)) continue;
      for (const id of listAttempts(p.root)) {
        const s = loadState(p.root, id);
        if (['done', 'abandoned'].includes(s.phase)) continue;
        out.push({ project: path.basename(p.root), root: p.root, id, item: s.item, phase: s.phase, hold: s.activeHold?.reason ?? null, next: nextAction(p.root, s) });
      }
    }
    print(options, out.length ? out.map((o) => `${o.project}  ${o.id}  ${o.phase}${o.hold ? `  HOLD: ${o.hold}` : ''}\n  next: ${o.next}`).join('\n') : 'no open attempts in any enabled project', out);
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
    case 'doctor': {
      const r = await doctor(root, { runSteps: options['no-steps'] !== true });
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
      print(options, `wrote ${files.length} file(s):\n${files.map((f) => `  ${path.relative(root, f)}`).join('\n')}`, files);
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
      const s = freezeCriteria(root, options);
      const loose = uncovered(s);
      const sections = s.plan && typeof s.plan === 'object' ? Object.keys(s.plan) : [];
      print(options, `criteria frozen (${s.criteria.length}): ${s.criteria.map((c) => c.id).join(', ')}\nplan sections: ${sections.join(', ') || 'none'}${s.planSource?.transcript ? ` (from ${s.planSource.agent}'s transcript)` : ''}${s.work ? `\nwork items (${s.work.length}): ${s.work.map((w) => `${w.id} [${w.class}] ${w.criteria.join(',')}`).join('; ')}` : ''}${loose.length ? `\nnote: no work item covers ${loose.join(', ')}` : ''}\nnext: ${nextAction(root, s)}`, s);
      return 0;
    }
    case 'criteria': {
      if (sub !== 'amend') throw new WfError('usage: wf criteria amend --file f --reason "why"');
      const { state: s, changes } = amendCriteria(root, options);
      const list = (ids) => ids.join(', ') || 'none';
      print(options, `criteria amended (${s.criteriaAmendments.length} amendment(s)); the reviewer will see the reason\n  criteria now (${s.criteria.length}): ${list(s.criteria.map((c) => c.id))}\n  changed: ${list(changes.changed)}; added: ${list(changes.added)}; dropped: ${list(changes.dropped.map((d) => `${d.id} (${d.reason})`))}`, { ...s, changes });
      return 0;
    }
    case 'handoff': {
      const r = handoff(root, sub, options);
      const startPrompt = r.startPrompt;
      // Never printed for a reviewer: its console carries only the start line.
      const api = await trackerApi(root, r.state.id);
      if (api && sub !== 'reviewer') process.stderr.write(`${api.trim()}\n`);
      // The reviewer is started blind: this one line is its whole prompt, so nothing else is printed to pass along.
      if (sub === 'reviewer') {
        // To the owner on stderr, never into the reviewer's one-line prompt on stdout.
        const w = outsideWarning(root, r.state);
        if (w) process.stderr.write(`warning: ${w}\n`);
        print(options, startPrompt, { ...r, startPrompt });
      }
      else print(options, `${sub} bundle: ${r.bundle}${r.work ? `\nwork item ${r.work}, class ${r.class}` : `\nclass ${r.class}`}${r.effort ? `, effort ${r.effort}` : ''}${r.model ? `, model ${r.model}` : ''}\nStart agent type ${r.agentType} (name it ${options.agent}; do not pass a model) with: "${startPrompt}"`, { ...r, startPrompt });
      return 0;
    }
    case 'gate':
    case 'check': {
      const s = openState(root, options);
      const check = cmd === 'check';
      const repos = check && options.repo ? String(options.repo).split(',') : null;
      // Before the run: an unplanned change is amended into the criteria (or fixed) before the review, not after.
      try {
        const w = s.accepted ? null : outsideWarning(root, s);
        if (w) (options.json ? process.stderr : process.stdout).write(`wf ${cmd}: warning: ${w}\n`);
        const dw = s.accepted ? null : designWarning(root, s);
        if (dw) (options.json ? process.stderr : process.stdout).write(`wf ${cmd}: warning: ${dw}\n`);
      } catch {}
      // Live progress goes to stdout, or to stderr with --json so stdout stays one JSON document.
      const r = await runGate(root, s, { prepareOnly: options['prepare-only'] === true, full: !check && options.full === true, focused: !check && options.focused === true, rerunFailed: !check && options['rerun-failed'] === true ? true : undefined, check, repos, live: options.json ? process.stderr : process.stdout });
      const note = check ? '\n  (a check runs light steps only; it is reused by the gate but never counts as one)' : r.record?.rerunFailed ? '\n  (--rerun-failed: proof while repairing; acceptance and delivery need a full `wf gate`)' : '';
      const flaky = r.record?.flaky?.length ? `\n  flaky: ${r.record.flaky.map((f) => f.step).join(', ')} failed earlier and passed now with the same inputs` : '';
      print(options, `${gateText(r).replace(/^gate /, check ? 'check ' : 'gate ')}${note}${flaky}`, r.record ?? r.plan);
      return r.record && r.record.status !== 'passed' ? 1 : 0;
    }
    case 'run': {
      if (!options.lease || options.lease === true || !options._.length) throw new WfError('usage: wf run --lease <name> -- <command...>');
      const cfg = loadConfig(root);
      return await runWithLease(cfg, String(options.lease), options._);
    }
    case 'summary': {
      const cfg = loadConfig(root);
      const { actor } = await import('./attempt.mjs');
      const s = recordSummary(root, cfg, openState(root, options), { ...options, actorId: actor(options) });
      print(options, `summary recorded for ${s.id} (${s.delivery.summary.text.split('\n').length} line(s)).${s.delivery.completedAt ? ` Delivered comment: ${commentFile(root, s.id)}` : ''}\nnext: ${nextAction(root, s)}`, s);
      return 0;
    }
    case 'export': {
      const s = openState(root, options);
      if (sub === 'screenshots') {
        const r = exportScreenshots(root, s, options.to && options.to !== true ? options.to : null, { gate: options.gate === true });
        print(options, `copied ${r.files.length} ${options.gate ? 'gate' : 'delivered'} screenshot(s) of ${s.id} to ${r.dir} (each sha256-checked; view them with the Read tool):\n${r.files.map((f) => `  ${f.file}`).join('\n')}`, r);
        return 0;
      }
      if (sub) throw new WfError('usage: wf export [--out FILE] [--json] | wf export screenshots [--gate] [--to DIR]');
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
      if (!options.reason) throw new WfError('--reason is required');
      const lock = stopGate(root, s, String(options.reason));
      print(options, `stopping gate ${lock.runId}; finished steps are kept. Resume with \`wf gate\`.`);
      return 0;
    }
    case 'review': {
      // The reviewer runs this. Its console shows nothing but the receipt: no owner next steps, tracker actions or
      // state, which carried earlier rounds' findings and the owner's notes into a blind review.
      const { state: s, reveal, toVerify } = recordReview(root, options);
      // Revealed only now, after this round's own closure is recorded blind.
      const verify = reveal ? `\n${toVerify.length} finding(s) from earlier rounds to verify against the code: ${reveal}\nAdd \`priorFindings: [{ round, id, status, evidence }]\` to your closure (change nothing else) and run \`wf review --closure <file>\` again.` : '';
      print(options, `review recorded (${s.review.closure.findings.length} finding(s)).${verify}`, { recorded: true, attempt: s.id, findings: s.review.closure.findings.length, file: s.review.file, provenance: s.review.provenance, verify: reveal ? { file: reveal, count: toVerify.length } : null });
      return 0;
    }
    case 'accept': {
      const s = acceptReview(root, options);
      const lp = lessonPrompts(s).filter((p) => p.startsWith('finding'));
      print(options, `review accepted.${lp.map((p) => `\nlesson: ${p}`).join('')} next: ${nextAction(root, s)}`, s);
      return 0;
    }
    case 'deliver': {
      const r = await deliver(root, options);
      if (r.waiting) {
        print(options, `${r.waiting.repo}: ${r.waiting.state}${r.waiting.url ? ` (${r.waiting.url})` : ''}. Run \`wf deliver\` again once it is merged.`, r);
        return 0;
      }
      const api = await trackerApi(root, r.state.id);
      const after = loadState(root, r.state.id);
      const members = (after.batch?.members ?? []).map((m) => showBlock(root, loadState(root, m))).join('');
      const comment = after.tracker.pending.some((a) => a.rendered === 'delivered') ? `\ndelivered comment to post (rendered from your summary, the user-visible UAT scope, the screenshots and known limits): ${commentFile(root, after.id)}\n  replace each {assetUrl:<title>} with the assetUrl its upload returned, so every screenshot shows inline; post it unchanged otherwise` : '';
      print(options, `delivered ${after.id}: ${Object.values(after.delivery.repos).map((d) => `${d.repo}${d.commit ? `@${d.commit.slice(0, 10)}` : ' (no changes)'}`).join(', ')}${api}${showBlock(root, after)}${members}${comment}\nnext: ${nextAction(root, after)}`, after);
      return 0;
    }
    case 'tracker': {
      if (sub === 'sync') {
        const s = openState(root, options);
        const api = await trackerApi(root, s.id);
        print(options, `${api.trim() || 'tracker: nothing to perform (no pending actions, or `tracker.via` is not `api`)'}\nnext: ${nextAction(root, loadState(root, s.id))}`);
        return 0;
      }
      if (sub !== 'record') throw new WfError('usage: wf tracker record --event E --capture file.json | wf tracker sync');
      const cfg = loadConfig(root);
      let s = await recordTracker(root, cfg, openState(root, options), { ...options, engineCapture: undefined });
      s = closeAfterHandoff(root, s);
      print(options, `tracker ${options.event} verified. ${s.phase === 'done' ? 'Attempt closed and worktrees removed.' : `next: ${nextAction(root, s)}`}`, s);
      return 0;
    }
    case 'delivery': {
      if (sub !== 'narrow') throw new WfError('usage: wf delivery narrow --keep <sha256,...> | --file keep.json --reason "why" [--attempt ID]');
      const { state: s, dryRun } = narrowDelivery(root, options);
      if (dryRun) {
        print(options, `dry run, nothing recorded: ${s.id} would be narrowed from ${dryRun.from} to ${dryRun.to} (${dryRun.dropped} dropped${dryRun.legacy ? '; delivered before 0.1.11: the pending attach action is narrowed, uploads checked by title' : ''}): ${dryRun.reason}\n${dryRun.kept.map((f, i) => `  ${i + 1}. ${f.title}  sha256 ${f.sha256.slice(0, 12)}  ${f.path}`).join('\n')}`, dryRun);
        return 0;
      }
      const n = s.delivery.narrowed;
      print(options, `delivered set of ${s.id} narrowed from ${n.from} to ${n.to}: ${n.reason}${showBlock(root, s)}${n.legacy ? `\n  delivered before 0.1.11: the pending attach action now lists ${n.to} file(s); uploads are checked by title` : ''}\nnext: ${nextAction(root, s)}`, s);
      return 0;
    }
    case 'shown': {
      let s = recordShown(root, options);
      const api = await trackerApi(root, s.id);
      s = closeAfterHandoff(root, loadState(root, s.id));
      const lp = lessonPrompts(s).filter((p) => p.startsWith('anomaly'));
      print(options, `shown recorded for ${s.id}: ${s.delivery.shown.screenshots.length} screenshot(s) with the owner's captions.${lp.map((p) => `\nlesson: ${p}`).join('')}${api}${s.phase === 'done' ? ' Attempt closed and worktrees removed.' : `\nnext: ${nextAction(root, s)}`}`, s);
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
    case 'abandon': {
      const s = abandon(root, options);
      print(options, `${s.id} abandoned: ${s.abandoned.reason}\nits branch ${Object.values(s.repos)[0]?.branch ?? ''} is kept so no work is lost; delete it with \`git branch -D\` when you no longer need it`);
      return 0;
    }
    case 'batch': {
      if (sub === 'create') {
        const s = batchCreate(root, options);
        print(options, summary(root, s), s);
        return 0;
      }
      if (sub === 'eject') {
        const s = batchEject(root, options);
        print(options, `ejected ${options.member} from ${s.id}`, s);
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
      for (const id of ids) {
        const p = verifyAttempt(root, id, { full: true });
        if (p.length) bad.push({ id, problems: p });
      }
      print(options, bad.length ? bad.map((b) => `${b.id}: ${b.problems.length} problem(s): the evidence does not match what wf recorded\n  - ${b.problems.slice(0, 20).join('\n  - ')}`).join('\n') : `verified ${ids.length} attempt(s): ledger chain, anchor and every recorded evidence file (sha256, size, mode) match; no extra file`, bad);
      return bad.length ? 1 : 0;
    }
    case 'lesson': {
      const { actor } = await import('./attempt.mjs');
      const cfg = loadConfig(root);
      const show = (l) => `${l.id}  [${l.status}, ${l.scope}, ${l.cause}, ${l.mechanism?.kind}${l.mechanism?.ref ? ` ${l.mechanism.ref}` : ''}] recurrence ${l.recurrence}  ${l.title}`;
      if (sub === 'add') {
        if (options.attempt) openState(root, options);
        const r = addLesson(root, options, actor(options));
        const flags = r.recurred.map((x) => `\nlesson ${x.id} recurred (recurrence ${x.recurrence}): its mechanism failed${x.promote ? `; promote it to a gate check (\`wf lesson apply ${x.id}\` after setting \`mechanism.kind: gate-check\`)` : ''}`).join('');
        let closed = '';
        if (options.attempt) {
          const s = closeAfterHandoff(root, loadState(root, String(options.attempt)));
          if (s.phase === 'done') closed = `\n${s.id} closed.`;
        }
        print(options, `lesson ${r.lesson.id} recorded: ${r.file}\n  commit it with the adapter; to enforce it: \`wf lesson apply ${r.lesson.id}\`${flags}${closed}`, r);
        return 0;
      }
      if (sub === 'waive') {
        const s = openState(root, options);
        const reason = String(options.reason ?? '').trim();
        if (!reason || options.reason === true) throw new WfError('--reason "<why this needs no lesson>" is required');
        append(root, s.id, 'lesson.waived', { reason, on: 'waive' }, actor(options));
        const after = closeAfterHandoff(root, loadState(root, s.id));
        print(options, `no lesson for ${s.id}: "${reason}" (recorded)${after.phase === 'done' ? `\n${s.id} closed.` : `\nnext: ${nextAction(root, after)}`}`);
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
      if (sub === 'set') {
        const r = setLesson(root, positional[0], options);
        print(options, `lesson ${r.lesson.id}: ${show(r.lesson)}\n  ${r.file} (commit it)`, r);
        return 0;
      }
      if (sub === 'apply') {
        const l = loadLessons(root).find((x) => x.id === positional[0]);
        if (!l) throw new WfError(`no lesson ${positional[0] ?? ''}`);
        const a = applySnippet(l);
        print(options, `to enforce ${l.id} (${l.mechanism?.kind}), add to ${a.where}:\n\n${a.snippet}\nwf changes nothing itself: add it, commit it with the owner's approval, then \`wf lesson set ${l.id} --status enforced${a.ref ? ` --ref ${a.ref}` : ' --ref <what enforces it>'}\``, a);
        return 0;
      }
      if (sub === 'show') {
        const l = loadLessons(root).find((x) => x.id === positional[0]);
        if (!l) throw new WfError(`no lesson ${positional[0] ?? ''}`);
        print(options, `${show(l)}\n  what happened: ${l.trigger?.what ?? ''}${l.trigger?.quote ? `\n  in their words: "${l.trigger.quote}"` : ''}${l.trigger?.attempt ? `\n  seen in: ${l.trigger.attempt}${l.trigger.finding ? ` (finding ${l.trigger.finding})` : ''}` : ''}\n  tags: ${l.tags.join(', ') || 'none'}; paths: ${l.paths.join(', ') || 'every change'}\n  ${l.file}`, l);
        return 0;
      }
      if (sub === 'review') {
        const r = reviewLessons(root, { after: options.after ? Number(options.after) : 10 });
        const part = (title, list, hint) => `${title} (${list.length})${list.length ? `:\n${list.map((l) => `  ${show(l)}`).join('\n')}\n  → ${hint}` : ''}`;
        print(options, [part('recurring: promote the mechanism to a gate check', r.promote, '`wf lesson apply <id>` with mechanism gate-check'), part('proposed: apply the mechanism', r.apply, '`wf lesson apply <id>`, then `wf lesson set <id> --status enforced --ref ...`'), part(`not injected into any of the last ${r.attempts} attempts: retire?`, r.retire, '`wf lesson set <id> --status retired`')].join('\n'), r);
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
        print(options, all.length ? all.map(show).join('\n') : `no lessons yet (${path.join('.workflow', 'lessons')})`, all);
        return 0;
      }
      throw new WfError('usage: wf lesson add|waive|recur|set|apply|show|list|review|export');
    }
    case 'evidence': {
      if (sub !== 'release') throw new WfError('usage: wf evidence release [--attempt ID | --closed | --older-than DAYS] [--reason "why"] [--dry-run]');
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
      const s = openState(root, options);
      const base = isOpen(s) ? safeBase(root, s) : null;
      print(options, summary(root, s, { base, resume: true }), { ...s, next: nextAction(root, s), liveGate: liveGate(root, s), base });
      return 0;
    }
    case 'status': {
      // --attempt narrows the listing to that attempt; without it every open attempt is shown.
      const states = options.attempt ? [openState(root, options)] : listAttempts(root).map((id) => loadState(root, id)).filter(isOpen).map((s) => (openEvidence(root, s.id), s));
      const rows = states.map((s) => ({ s, base: isOpen(s) ? safeBase(root, s) : null }));
      print(options, rows.length ? rows.map(({ s, base }) => summary(root, s, { base })).join('\n\n') : 'no open attempts', options.json ? rows.map(({ s, base }) => ({ ...s, next: nextAction(root, s), base })) : undefined);
      return 0;
    }
    case 'base': {
      if (sub === 'merge') {
        const r = baseMerge(root, options);
        const lines = r.results.map((x) => (x.upToDate ? `${x.repo}: already on its base${x.note ? ` (${x.note})` : ''}` : `${x.repo}: merged ${x.ref} (${x.commits} commit(s), ${x.files} file(s)); HEAD ${x.headBefore.slice(0, 10)} -> ${x.headAfter.slice(0, 10)}${x.overlap.length ? `\n  note: the merge brought in changes to files this ticket also changes: ${x.overlap.join(', ')}; check the merged result` : ''}${x.infra.length ? `\n  note: shared infrastructure changed: ${x.infra.join(', ')}` : ''}`));
        const moved = r.results.some((x) => !x.upToDate && x.headBefore !== x.headAfter);
        if (moved) lines.push('HEAD changed: the gate and the review are bound to the tree, so neither counts for the merged tree. Run `wf gate`, then hand the tree to a fresh reviewer.');
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
