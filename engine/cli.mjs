import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { abandon, adopt, entry, hold, openState, release } from './attempt.mjs';
import { findRoot, loadConfig, requireRoot } from './config.mjs';
import { liveGate, runGate, stopGate } from './gate.mjs';
import { listAttempts, loadState } from './ledger.mjs';
import { acceptReview, amendCriteria, batchCreate, batchEject, closeAfterHandoff, deliver, freezeCriteria, handoff, nextAction, recordReview, reopen } from './lifecycle.mjs';
import { detect, doctor, register, registry, setEnabled, sync, writeDraft } from './onboard.mjs';
import * as secrets from './secrets.mjs';
import { report, toCsv, toHtml } from './telemetry.mjs';
import { impact } from './topology.mjs';
import { recordTracker } from './tracker.mjs';
import { ENGINE_VERSION, WfError, parseArgs } from './util.mjs';

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// The released plugin version. ENGINE_VERSION is the ledger's engine version and moves only with the ledger.
function pluginVersion() {
  for (const f of ['.claude-plugin/plugin.json', 'package.json']) {
    try {
      const v = JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, f), 'utf8')).version;
      if (v) return v;
    } catch {}
  }
  return ENGINE_VERSION;
}

const HELP = `wf ${pluginVersion()} — agentic-workflow (ledger engine ${ENGINE_VERSION})

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
  wf plan --file criteria.yaml      freeze acceptance criteria (and the plan)
  wf criteria amend --file f --reason "why"
  wf handoff planner|implementer|reviewer|tester --agent ID [--session SID] [--runtime claude|codex]
  wf gate [--prepare-only] [--full] [--focused]
  wf stop --reason "why"            pause a running gate; finished steps are kept
  wf review --closure file.json     record the reviewer's closure
  wf accept                         accept the review
  wf deliver                        integrate every repo, then start the tracker handoff
  wf tracker record --event E --capture file.json
  wf hold --reason "why" | wf release
  wf reopen --item ID --reason "feedback"
  wf adopt [--attempt ID]           take over a live attempt from a new session
  wf abandon --reason "why"
  wf batch create --members A,B | wf batch eject --batch B --member A

Status
  wf resume                         what to do next
  wf status [--all] [--json]
  wf report [--all] [--csv FILE] [--html FILE]

Common options: --attempt ID, --json, --owner ID`;

const print = (options, human, data) => {
  if (options.json) process.stdout.write(`${JSON.stringify(data ?? human, null, 2)}\n`);
  else process.stdout.write(`${typeof human === 'string' ? human : JSON.stringify(human, null, 2)}\n`);
};

function summary(root, s) {
  const lines = [`${s.id}  ${s.item}  lane=${s.lane}  intent=${s.intent}  phase=${s.phase}`, `  owner: ${s.owner}`];
  for (const [name, r] of Object.entries(s.repos)) lines.push(`  ${name}: ${r.worktree} (base ${r.base.slice(0, 10)})`);
  if (s.activeHold) lines.push(`  HOLD: ${s.activeHold.reason}`);
  const live = ['done', 'abandoned'].includes(s.phase) ? null : liveGate(root, s);
  if (live) {
    lines.push(`  gate running: ${live.runId} (pid ${live.pid})`);
    lines.push(`    running: ${live.running.map((r) => `${r.id} (${r.seconds}s)`).join(', ') || 'none (waiting for a lease)'}`);
    lines.push(`    finished: ${live.finished.map((r) => `${r.id} ${r.status}${r.seconds !== null ? ` ${r.seconds}s` : ''}`).join(', ') || 'none yet'}`);
  }
  if (s.lastGate) lines.push(`  last gate: ${s.lastGate.status} (${s.lastGate.runId})`);
  lines.push(`  next: ${live ? 'a gate is running: wait for it to finish (or `wf stop --reason "why"`); do not edit the worktrees meanwhile' : nextAction(root, s)}`);
  return lines.join('\n');
}

function gateText(result) {
  const rows = (result.plan?.steps ?? result.record?.steps ?? []).map((s) => {
    const d = s.decision ?? s.status;
    const extra = s.reason ? `  ${s.reason}` : s.durationMs !== undefined ? `  ${(s.durationMs / 1000).toFixed(1)}s${s.workers ? ` workers=${s.workers.n}(${s.workers.source})` : ''}${s.log && s.status === 'failed' ? `  log: ${s.log}` : ''}` : '';
    return `  ${d.padEnd(11)} ${s.id}${extra}`;
  });
  const focused = (result.record ?? result.plan)?.focused ? ' (focused: proof while repairing; review and delivery need a gate without --focused)' : '';
  const head = result.record ? `gate ${result.record.status} (${result.record.runId})${focused}` : `gate plan${result.plan.full ? ' (full: the adapter changed)' : ''}${focused}`;
  const imp = result.plan?.impact ?? result.record?.impact;
  const impLine = imp && (imp.contractsChanged.length || imp.dependents.length) ? `\n  contracts changed: ${imp.contractsChanged.map((c) => c.contract).join(', ') || 'none'}; dependents pulled in: ${imp.dependents.join(', ') || 'none'}` : '';
  return `${head}${result.recovered ? `\n  recovered ${result.recovered.carried} finished step(s) from run ${result.recovered.runId} (runner died)` : ''}${impLine}\n${rows.join('\n')}`;
}

export async function main(argv) {
  const [cmd, sub, ...rest] = argv;
  const { positional, options } = parseArgs(sub && !sub.startsWith('--') ? rest : argv.slice(1));
  if (!cmd || cmd === 'help' || options.help) {
    process.stdout.write(`${HELP}\n`);
    return 0;
  }
  if (cmd === 'version' || cmd === '--version') {
    process.stdout.write(`${pluginVersion()}\n`);
    return 0;
  }
  try {
    return await dispatch(cmd, sub && !sub.startsWith('--') ? sub : null, positional, options);
  } catch (error) {
    if (error instanceof WfError) {
      process.stderr.write(`wf ${cmd}: ${error.message}\n${error.hint ? `  → ${error.hint}\n` : ''}`);
      return error.code;
    }
    throw error;
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
    print(options, `drafted ${file} (disabled)${detected.compose.length ? `\n  docker compose: ${detected.compose.join(', ')} (steps using it should hold the \`docker\` lease)` : ''}\n  repos: ${detected.repos.map((r) => `${r.name}@${r.base} [${r.packages.map((p) => p.path).join(', ')}]`).join('; ')}\n  steps: ${detected.steps.map((s) => s.id).join(', ') || 'none detected'}\n  components: ${detected.components.map((c) => `${c.id} (${c.kind})`).join(', ')}\n  secrets: ${detected.secrets.map((s) => `${s.key} (${s.kind})`).join(', ') || 'none detected'}\nnext: review the draft with the user, commit .workflow/ on the base branch and push it, then \`wf doctor\` and \`wf enable\``, { file, detected });
    return 0;
  }
  if (cmd === 'report') {
    const roots = options.all ? registry().projects.map((p) => p.root).filter((r) => fs.existsSync(r)) : [requireRoot()];
    const rows = report(roots);
    if (options.csv) fs.writeFileSync(String(options.csv), toCsv(rows));
    if (options.html) fs.writeFileSync(String(options.html), toHtml(rows));
    print(options, options.csv || options.html ? `wrote ${[options.csv, options.html].filter(Boolean).join(' and ')} (${rows.length} attempt(s))` : toCsv(rows), rows);
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
      for (const section of ['config', 'tools', 'secrets', 'skills', 'connectors', 'steps']) {
        for (const item of r[section]) lines.push(`${item.ok ? '✓' : '✗'} ${section}: ${item.check ?? item.tool ?? item.key ?? item.skill ?? item.step ?? item.connector}${item.runtime ? ` (${item.runtime})` : ''}${item.problem ? ` — ${item.problem}` : ''}${item.kind ? ` [${item.kind}]` : ''}${item.fix ? `\n    fix: ${item.fix}` : ''}${item.log ? `\n    log: ${item.log}` : ''}${item.note ? `\n    ${item.note}` : ''}`);
      }
      print(options, `${lines.join('\n')}\n${r.ok ? 'doctor: all checks passed' : 'doctor: problems found'}`, r);
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
        print(options, rows.length ? rows.map((r) => `${r.state === 'filled' ? '✓' : '✗'} ${r.key.padEnd(28)} ${r.kind.padEnd(9)} ${r.state}${r.purpose ? `  ${r.purpose}` : ''}`).join('\n') : 'no secrets catalogued (.workflow/secrets.yaml)', rows);
        return rows.every((r) => r.state === 'filled') ? 0 : 1;
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
      const s = entry(root, { ...options, deferHeavy: options['defer-heavy'] === true });
      print(options, summary(root, s), s);
      return 0;
    }
    case 'plan': {
      const s = freezeCriteria(root, options);
      print(options, `criteria frozen (${s.criteria.length}): ${s.criteria.map((c) => c.id).join(', ')}\nnext: ${nextAction(root, s)}`, s);
      return 0;
    }
    case 'criteria': {
      if (sub !== 'amend') throw new WfError('usage: wf criteria amend --file f --reason "why"');
      const s = amendCriteria(root, options);
      print(options, `criteria amended (${s.criteriaAmendments.length} amendment(s)); the reviewer will see the reason`, s);
      return 0;
    }
    case 'handoff': {
      const r = handoff(root, sub, options);
      print(options, `${sub} bundle: ${r.bundle}\nStart the ${sub} agent (${options.agent}) with: "Read ${r.bundle} and follow its instructions."`, r);
      return 0;
    }
    case 'gate': {
      const s = openState(root, options);
      // Live progress goes to stdout, or to stderr with --json so stdout stays one JSON document.
      const r = await runGate(root, s, { prepareOnly: options['prepare-only'] === true, full: options.full === true, focused: options.focused === true, live: options.json ? process.stderr : process.stdout });
      print(options, gateText(r), r.record ?? r.plan);
      return r.record && r.record.status !== 'passed' ? 1 : 0;
    }
    case 'stop': {
      const s = openState(root, options);
      if (!options.reason) throw new WfError('--reason is required');
      const lock = stopGate(root, s, String(options.reason));
      print(options, `stopping gate ${lock.runId}; finished steps are kept. Resume with \`wf gate\`.`);
      return 0;
    }
    case 'review': {
      const s = recordReview(root, options);
      print(options, `review recorded: ${s.review.closure.findings.length} finding(s). next: ${nextAction(root, s)}`, s);
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
      print(options, `delivered ${r.state.id}: ${Object.values(r.state.delivery.repos).map((d) => `${d.repo}${d.commit ? `@${d.commit.slice(0, 10)}` : ' (no changes)'}`).join(', ')}\nnext: ${nextAction(root, r.state)}`, r.state);
      return 0;
    }
    case 'tracker': {
      if (sub !== 'record') throw new WfError('usage: wf tracker record --event E --capture file.json');
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
      const s = reopen(root, options);
      print(options, summary(root, s), s);
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
      print(options, summary(root, s), { ...s, next: nextAction(root, s), liveGate: liveGate(root, s) });
      return 0;
    }
    case 'status': {
      const ids = listAttempts(root);
      const states = ids.map((id) => loadState(root, id));
      const open = states.filter((s) => !['done', 'abandoned'].includes(s.phase));
      print(options, open.length ? open.map((s) => summary(root, s)).join('\n\n') : 'no open attempts', options.json ? open : undefined);
      return 0;
    }
    default:
      throw new WfError(`unknown command \`${cmd}\`; run \`wf help\``);
  }
}
