import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import { abandon, adopt, changedFiles, entry, hold, openState, release } from './attempt.mjs';
import { baseLines, baseMerge, baseStatus } from './base.mjs';
import { findRoot, loadConfig, requireRoot } from './config.mjs';
import { exportAttempt, exportFile } from './export.mjs';
import { liveGate, runGate, runWithLease, stopGate } from './gate.mjs';
import { append, listAttempts, loadState } from './ledger.mjs';
import { outsidePlan } from './scope.mjs';
import { acceptReview, amendCriteria, batchCreate, batchEject, closeAfterHandoff, deliver, freezeCriteria, handoff, nextAction, recordReview, reopen, uncovered, withAttempt } from './lifecycle.mjs';
import { detect, doctor, register, registry, setEnabled, sync, writeDraft } from './onboard.mjs';
import * as secrets from './secrets.mjs';
import { report, toCsv, toHandoffCsv, toHtml } from './telemetry.mjs';
import { impact } from './topology.mjs';
import { performTracker, recordTracker } from './tracker.mjs';
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
  wf deliver                        integrate every repo, then start the tracker handoff
  wf tracker record --event E --capture file.json | wf tracker sync (tracker.via: api)
  wf hold --reason "why" | wf release
  wf reopen --item ID --reason "feedback"
  wf adopt [--attempt ID]           take over a live attempt from a new session
  wf abandon --reason "why"
  wf batch create --members A,B | wf batch eject --batch B --member A

Status
  wf resume                         what to do next
  wf status [--all] [--json]
  wf report [--all] [--csv FILE] [--handoffs-csv FILE] [--html FILE]
  wf export [--out FILE] [--json]   one self-contained page for the attempt (a view of the evidence)

Common options: --attempt ID, --json, --owner ID`;

const print = (options, human, data) => {
  if (options.json) process.stdout.write(`${JSON.stringify(data ?? human, null, 2)}\n`);
  else process.stdout.write(`${typeof human === 'string' ? human : JSON.stringify(human, null, 2)}\n`);
};

function changedFilesOf(s, r) {
  try {
    return changedFiles(s, r);
  } catch {
    return [];
  }
}

function summary(root, s, { base = null, resume = false } = {}) {
  const lines = [`${s.id}  ${s.item}  lane=${s.lane}  intent=${s.intent}  phase=${s.phase}`, `  owner: ${s.owner}`];
  for (const [name, r] of Object.entries(s.repos)) lines.push(`  ${name}: ${r.worktree} (base ${r.base.slice(0, 10)})`);
  if (base) lines.push(...baseLines(base));
  if (s.activeHold) lines.push(`  HOLD: ${s.activeHold.reason}`);
  const live = ['done', 'abandoned'].includes(s.phase) ? null : liveGate(root, s);
  if (live) {
    lines.push(`  gate running: ${live.runId} (pid ${live.pid})`);
    lines.push(`    running: ${live.running.map((r) => `${r.id} (${r.seconds}s)`).join(', ') || 'none (waiting for a lease)'}`);
    lines.push(`    finished: ${live.finished.map((r) => `${r.id} ${r.status}${r.seconds !== null ? ` ${r.seconds}s` : ''}`).join(', ') || 'none yet'}`);
  }
  if (s.lastGate) lines.push(`  last gate: ${s.lastGate.status} (${s.lastGate.runId})`);
  if (s.checks?.length) lines.push(`  last check: ${s.checks.at(-1).status} (${s.checks.at(-1).runId}; light steps only, never counts as the gate)`);
  if (s.flaky?.length) lines.push(`  flaky: ${[...new Set(s.flaky.map((f) => `${f.step}${f.suites?.length ? ` (${f.suites.join(', ')})` : ''}`))].join(', ')} failed and then passed with the same inputs`);
  if (s.criteria && isOpen(s)) {
    try {
      const outside = outsidePlan(s.plan, Object.fromEntries(Object.keys(s.repos).map((r) => [r, changedFilesOf(s, r)])));
      if (outside?.length) lines.push(`  outside the plan: ${outside.length} changed file(s) no plan anchor or test path names (listed in the reviewer bundle)`);
    } catch {}
  }
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
  const { positional, options } = parseArgs(sub && !sub.startsWith('--') ? rest : argv.slice(1));
  if (!cmd || cmd === 'help' || options.help) {
    process.stdout.write(`${HELP}\n`);
    return 0;
  }
  if (cmd === 'version' || cmd === '--version') {
    process.stdout.write(`${ENGINE_VERSION}\n`);
    return 0;
  }
  try {
    return await dispatch(cmd, sub && !sub.startsWith('--') ? sub : null, positional, { ...options, _: passthrough });
  } catch (error) {
    if (error instanceof WfError) {
      process.stderr.write(`wf ${cmd}: ${error.message}\n${error.hint ? `  → ${error.hint}\n` : ''}`);
      return error.code;
    }
    throw error;
  }
}

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
      for (const section of ['config', 'tools', 'secrets', 'skills', 'connectors', 'steps', 'warnings']) {
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
      if (sub === 'reviewer') print(options, startPrompt, { ...r, startPrompt });
      else print(options, `${sub} bundle: ${r.bundle}${r.work ? `\nwork item ${r.work}, class ${r.class}` : `\nclass ${r.class}`}${r.effort ? `, effort ${r.effort}` : ''}${r.model ? `, model ${r.model}` : ''}\nStart agent type ${r.agentType} (name it ${options.agent}; do not pass a model) with: "${startPrompt}"`, { ...r, startPrompt });
      return 0;
    }
    case 'gate':
    case 'check': {
      const s = openState(root, options);
      const check = cmd === 'check';
      const repos = check && options.repo ? String(options.repo).split(',') : null;
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
    case 'export': {
      const s = openState(root, options);
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
      print(options, `review accepted. next: ${nextAction(root, s)}`, s);
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
      print(options, `delivered ${after.id}: ${Object.values(after.delivery.repos).map((d) => `${d.repo}${d.commit ? `@${d.commit.slice(0, 10)}` : ' (no changes)'}`).join(', ')}${api}\nnext: ${nextAction(root, after)}`, after);
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
      let s = await recordTracker(root, cfg, openState(root, options), options);
      s = closeAfterHandoff(root, s);
      print(options, `tracker ${options.event} verified. ${s.phase === 'done' ? 'Attempt closed and worktrees removed.' : `next: ${nextAction(root, s)}`}`, s);
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
      print(options, `${summary(root, s)}${api}`, s);
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
    case 'resume': {
      const s = openState(root, options);
      const base = isOpen(s) ? safeBase(root, s) : null;
      print(options, summary(root, s, { base, resume: true }), { ...s, next: nextAction(root, s), liveGate: liveGate(root, s), base });
      return 0;
    }
    case 'status': {
      // --attempt narrows the listing to that attempt; without it every open attempt is shown.
      const states = options.attempt ? [openState(root, options)] : listAttempts(root).map((id) => loadState(root, id)).filter(isOpen);
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
