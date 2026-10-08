// Owner-only decisions, and how the engine tells the owner from an agent.
//
// Named failure (0.5.0 second security review, authorization bypass): the 0.5.0 decisions that skip or settle a check
// (`wf gate --reason`, `wf handoff reviewer --reason`, `wf deliver --acknowledge-adapter-state`, `wf deliver
// --repin-adapter`, `wf abandon --acknowledge-integration`, `wf release`, `wf handoff close`) took the caller's word:
// any agent that could run `wf` made them on the owner's behalf, since every caller is the same user with the same
// environment. They now take the owner's authority the way a deferral does (0.4.5):
//
// - When the attempt's owner is a Claude Code or Codex session, from the host's record of that session: a real owner
//   message (engine/discovered.mjs `ownerTurns`: no tool results, notifications, relayed or injected lines, subagent
//   transcripts) that starts with the decision's phrase, written after the attempt was admitted, and not already spent
//   on an earlier decision (each message counts once). This is the only authority for every decision that skips or
//   settles a check.
// - `wf handoff close` alone, which only records bookkeeping (the reviewer stays bound to the tree it is handed), also
//   counts when the owner session itself ran exactly that command: Claude Code records a tool call in the session's
//   transcript before it runs, and a sub-agent's calls go to its own transcript, never the owner's. Plainly: in an
//   agent-driven session the owner session's assistant is itself an agent, so this is the orchestrating agent's own
//   command, not the person's. Third review: the match is exact (one plain `wf` invocation, no shell operators, the
//   subcommand and every flag and value equal), within 10 minutes, after admission, and each call counts once.
// - When the owner is a session whose transcript cannot be read: refused (fail closed).
// - When the owner is not a session (a person's name): only at an interactive terminal, where the person types the
//   decision's phrase back (as `wf discovered defer` asks for the id), recorded `interactive-terminal (unverified)`.
//   Without a terminal it is refused. Named failure (0.5.0 third review): this was granted when no agent-runtime
//   variable was set, and an agent can unset them, so their absence proved nothing. Their presence still refuses; their
//   absence never grants. Fourth review: a terminal is also fakeable (a pseudo-terminal), so the process's controlling
//   terminal must be a real tty device and no ancestor process may be an agent runtime (best effort, `AGENT_PROCESSES`);
//   an ancestry that cannot be read refuses. None of this is a boundary against a deliberate forger running as the same
//   user: it stops accidental and naive agent action. An owner who needs more uses a session-owned attempt.
//
// Limits, plainly, as for deferrals: an agent with the user's tools can append to the owner's transcript or scrub its
// environment. These controls make a decision on the owner's behalf a deliberate forgery, not a default, and every
// decision records where its authority came from.
import { fold, ownerTurns, readCapped } from './discovered.mjs';
import { ownerTranscript } from './host-record.mjs';
import { lastCodexOwnerCommand } from './codex-command.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { readRegular, writeNoFollow } from './evidence.mjs';
import { listAttempts, readLedger } from './ledger.mjs';
import { refuse } from './util.mjs';

// Environment variables an agent runtime sets for the commands its agents run.
export const AGENT_ENV = ['CLAUDE_CODE_SESSION_ID', 'CLAUDECODE', 'CODEX_THREAD_ID', 'CODEX_SANDBOX', 'AI_AGENT', 'GROK_SESSION_ID'];
const esc = (x) => String(x).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const isSession = (owner) => /^(claude|codex):/.test(String(owner ?? ''));

function afterAdmission(state, m) {
  if (!state.admittedAt || !m.at) return true;
  return Date.parse(m.at) >= Date.parse(state.admittedAt);
}

// The owner's authority for `phrase` (`<verb> <attempt id>:<what>`), or a refusal saying how the owner gives it.
// `command` (bookkeeping decisions only: `wf handoff close`): { sub: ['handoff', 'close'], flags: { '--agent': id, ... } },
// the exact invocation the owner session may have run instead of saying the phrase.
// Named failure (0.5.0 fifth review): the spend was recorded on the attempt the decision was appended to, but checked on
// the attempt the authority was read for, so a `wf reopen --no-lesson` waiver (read on the delivered attempt, recorded
// on the new one) could be spent again on every reopen. Spends are now project-wide and made before the action: one
// marker file per owner message (or owner-session command) under the evidence folder, created exclusively, so two
// commands racing for one message spend it once. A decision that is retried as the same decision (the same `decision`
// key: one deferral, one adapter state, one re-pin) is accepted again from its own marker; repeatable decisions (gate
// and review overrides) and a reopen's waiver pass none, so a spent message never counts twice.
const markerFile = (root, key) => path.join(root, '.wf-evidence', 'authorities', `${crypto.createHash('sha256').update(key).digest('hex')}.json`);
function claim(root, key, record) {
  const dir = path.join(root, '.wf-evidence', 'authorities');
  fs.mkdirSync(dir, { recursive: true });
  if (fs.realpathSync(dir) !== path.join(fs.realpathSync(root), '.wf-evidence', 'authorities')) throw refuse(`${dir} is not a real folder inside the project (a link on its path); no owner decision is recorded through it`);
  const file = markerFile(root, key);
  try {
    writeNoFollow(file, `${JSON.stringify({ key, ...record, at: new Date().toISOString() })}\n`, { exclusive: true, mode: 0o444 });
    return true;
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
  if (!record.decision) return false;
  const r = readRegular(file);
  let prior = null;
  try {
    prior = r ? JSON.parse(r.bytes.toString('utf8')) : null;
  } catch {}
  return prior?.key === key && prior?.decision === record.decision;
}

// Every owner message (or owner-session command) spent anywhere in the project, read from the attempts' hash-chained
// ledgers: { key: attempt }. Named failure (0.5.0 adversarial review): a spend was keyed on the transcript's path and
// byte offset (`<file>:<offset>`), so a copy of the owner's transcript in another project folder made every spent message
// fresh again, and the only project-wide record was the marker folder, which nothing checked: deleting a marker freed
// its message. A spend is now keyed on the runtime, the session id and the line's own id (Claude Code `uuid`, else the
// line's sha256), never on where the file is; the ledgers are the record (every authority carries `spent`), and every
// spend they record must still have its marker, so a deleted marker refuses instead of freeing the message.
function projectSpends(root) {
  const out = new Map();
  for (const id of listAttempts(root)) {
    for (const entry of readLedger(root, id)) {
      const d = entry.data;
      for (const a of [d?.authority, ...(Array.isArray(d?.authorities) ? d.authorities : [])]) {
        if (typeof a?.spent === 'string') {
          if (!out.has(a.spent)) out.set(a.spent, id);
        }
        // Recorded before spends carried `spent`: keyed on the file and offset, as its marker is.
        else if (a?.file && Number.isInteger(a.offset) && !out.has(`${a.file}:${a.offset}`)) out.set(`${a.file}:${a.offset}`, id);
      }
    }
  }
  return out;
}
function assertMarkers(root, spends) {
  const missing = [...spends].filter(([key]) => !fs.existsSync(markerFile(root, key)));
  if (missing.length) throw refuse(`the spend marker of ${missing.length} owner message(s) is missing from the evidence folder's authorities/ (${missing.slice(0, 3).map(([k, id]) => `${k.slice(0, 80)} spent on ${id}`).join('; ')}); it was deleted outside wf, so no owner decision is taken until it is restored`, 'restore the evidence folder\'s authorities/ (from a backup or version control of the evidence); `wf verify` lists what else changed');
}
const spendKey = (t, m) => `${t.runtime}:${t.session}:${m.id}`;

// A person's interactive session (`interactive`, for `wf adopt`'s new owner). Named failure (0.5.0 adversarial review): the
// new owner's confirmation was any user line of the session it named, so an agent made itself the owner from its own
// `codex exec "adopt <id>"` run (a Codex rollout records the exec prompt as a user message) or a headless Claude Code SDK
// run. A Codex rollout counts only when its `session_meta` records an interactive session (originator not `codex_exec`,
// source `cli` or `vscode`, never a sub-agent); a Claude Code turn only when it records a person as its origin and an
// interactive entry point (`cli` or `claude-desktop`, never `sdk-*`) with a typed prompt (the desktop app submits a typed
// prompt as `sdk`, observed). A turn without origin fields (older or headless transcripts) is not the owner here: fail
// closed.
const INTERACTIVE_ENTRYPOINTS = ['cli', 'claude-desktop'];
const INTERACTIVE_CODEX_SOURCES = ['cli', 'vscode'];
function codexMeta(bytes) {
  for (const raw of bytes.toString('utf8').split('\n')) {
    if (!raw.includes('session_meta')) continue;
    try {
      const e = JSON.parse(raw);
      if (e?.type === 'session_meta') return e.payload ?? {};
    } catch {}
  }
  return null;
}
function interactiveProblem(t, bytes, m) {
  if (t.runtime === 'codex') {
    const meta = codexMeta(bytes);
    if (!meta) return 'its rollout records no session_meta, so it is not shown to be a person\'s interactive session';
    if (meta.originator === 'codex_exec') return 'it is a `codex exec` run (originator codex_exec), not a plain interactive session';
    if (typeof meta.source !== 'string' || !INTERACTIVE_CODEX_SOURCES.includes(meta.source)) return `its source is ${JSON.stringify(meta.source ?? null).slice(0, 120)}, not a plain interactive session`;
    return '';
  }
  const o = m.origin ?? {};
  if (!o.recorded) return 'the turn carries no origin fields (an older or headless transcript), so it is not shown to come from a person';
  if (o.kind !== 'human' || (o.turnOrigin !== null && o.turnOrigin !== 'human')) return 'the turn does not come from a person';
  if (!INTERACTIVE_ENTRYPOINTS.includes(o.entrypoint)) return `the session runs from \`${o.entrypoint ?? 'an unrecorded entry point'}\` (an SDK or headless run), not a plain interactive session`;
  if (!['typed', 'queued'].includes(o.promptSource) && !(o.promptSource === 'sdk' && o.entrypoint === 'claude-desktop')) return `the prompt came from \`${o.promptSource ?? 'an unrecorded source'}\`, not typed`;
  return '';
}

function adoptionRequest(text, phrases) {
  // Named failure I-33: an explicit "read the handover and then adopt" command was refused by a message-start anchor.
  // Match affirmative command clauses, not arbitrary mentions in examples, reports, negations or conditional plans.
  const plain = String(text).normalize('NFKC')
    .replace(/```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)/g, ' ')
    .replace(/^\s*>.*$/gm, ' ')
    .replace(/`[^`]*`|"[^"\n]*"|“[^”]*”|‘[^’]*’|(?<![\p{L}\p{N}])'[^'\n]*'/gu, ' ');
  const words = fold(plain);
  if (/\b(?:if|unless|until|whether|when)\b/.test(words) || /\b(?:do not|don't|don’t|never|not to|avoid|cancel|stop)\b[^.!?;]*\badopt\b/.test(words)) return false;
  const prefix = '(?:please\\s+)?(?:(?:can|could|would) you\\s+(?:please\\s+)?|i (?:want|need) you to\\s+)?';
  const request = new RegExp(`^${prefix}(?:${phrases.map((p) => esc(fold(p))).join('|')})(?![a-z0-9_:-]|\\.[a-z0-9])`);
  const preceding = new RegExp(`^${prefix}(?:read|review|check|open|inspect)\\b`);
  const clauses = words.replace(/,\s*(?=(?:and|then)\s)/g, ' ').split(/\s+(?:and(?:\s+then)?|then)\s+|[.!?;]\s+/);
  for (const clause of clauses) {
    if (request.test(clause)) return true;
    if (!preceding.test(clause)) return false;
  }
  return false;
}

export function ownerAuthority(root, state, phrase, { what, command = null, owner = state.owner, terminal = defaultTerminal, decision = null, interactive = false, requestPhrases = null } = {}) {
  const shown = command ? `wf ${[...command.sub, ...Object.entries(command.flags).flat()].join(' ')}` : null;
  const how = requestPhrases
    ? `only the owner decides ${what}: ask this interactive chat to \`${phrase}\`, directly or after reading the handover; wf reads the host-recorded human request`
    : `only the owner decides ${what}: the owner starts a message in the owner session with \`${phrase}\`${shown ? `, or the owner session runs exactly \`${shown}\`` : ''}`;
  const t = ownerTranscript(owner);
  if (t.problem) {
    if (isSession(owner)) throw refuse(`not done: ${what} needs the owner's authority, and the owner session's transcript cannot be read: ${t.problem}`, how);
    return terminalAuthority(owner, phrase, what, terminal);
  }
  const bytes = readCapped(t.file);
  const spends = projectSpends(root);
  assertMarkers(root, spends);
  const used = new Set([...(state.authoritiesUsed ?? []), ...spends.keys()]);
  // Every session, the owner's or the one adopting, speaks after admission (0.5.0 adversarial review: the bound was
  // dropped for the adopting session).
  const stateFor = state;
  // Other owner decisions keep their exact phrases. A destination suffix or a longer ticket never matches adoption.
  const start = new RegExp(`^${esc(fold(phrase))}(?![a-z0-9_-]|\\.[a-z0-9])`);
  let turns = ownerTurns(t, bytes).filter((m) => afterAdmission(stateFor, m) && !used.has(spendKey(t, m)) && !used.has(`${t.file}:${m.offset}`) && (requestPhrases ? adoptionRequest(m.text, requestPhrases) : start.test(fold(m.text))));
  let notInteractive = '';
  if (interactive) {
    turns = turns.filter((m) => {
      const p = interactiveProblem(t, bytes, m) || (requestPhrases && (!m.at || !Number.isFinite(Date.parse(m.at))) ? 'its adoption request records no valid timestamp' : '');
      if (p) notInteractive = p;
      return !p;
    });
  }
  for (const m of turns) {
    if (!claim(root, spendKey(t, m), { phrase, attempt: state.id, decision })) continue;
    return { provenance: 'host-recorded', runtime: t.runtime, file: t.file, line: m.line, offset: m.offset, at: m.at, phrase, text: m.text.slice(0, 2000), spent: spendKey(t, m) };
  }
  let why = '';
  if (command) {
    const ran = t.runtime === 'codex' ? lastCodexOwnerCommand(bytes, t.session) : lastOwnerCommand(bytes);
    const spent = ran ? `${t.runtime}:${t.session}:cmd:${ran.id}` : null;
    why = !ran ? 'the owner session ran no command' : used.has(spent) ? 'its last command was already counted for a decision' : commandProblem(ran, command, stateFor);
    if (!why && t.runtime === 'codex') {
      const cwd = realOr(ran.cwd), project = realOr(root);
      if (!cwd || !project || !(cwd === project || cwd.startsWith(project + path.sep))) why = 'its last command was run outside this project';
    }
    if (!why && !claim(root, spent, { phrase, attempt: state.id, decision })) why = 'its last command was already counted for a decision';
    if (!why) return { provenance: 'owner-session command', runtime: t.runtime, file: t.file, line: ran.line, at: ran.at, spent, command: ran.command.slice(0, 500) };
  }
  if (notInteractive) throw refuse(`not done: ${what} needs a message from ${owner}, a plain interactive session, and ${t.file} is not one: ${notInteractive}`, how);
  const missing = requestPhrases ? `contains an affirmative, unconditional request to adopt this ticket or attempt` : `starts with \`${phrase}\``;
  throw refuse(`not done: ${what} needs the owner's authority, and no unspent owner message in the owner session (${t.file}) ${missing}${shown ? `, nor did the owner session itself run exactly \`${shown}\` (${why})` : ''}; an agent's word, a tool result or a sub-agent's call never counts`, how);
}

// The person at the owner's own terminal types the phrase back. Refused without an interactive terminal, and under an
// agent runtime (an agent's Bash has no terminal; one that fakes a terminal and scrubs its environment is the limit
// stated in docs/trust-model.md).
const defaultTerminal = { input: 0, output: 2, isTTY: () => Boolean(process.stdin.isTTY && process.stderr.isTTY), processProblem: () => terminalProcessProblem() };

// Agent runtimes, by the executable an ancestor process runs or its command line. Best effort and in one place: a
// runtime missing here, or one renamed, is not caught (docs/trust-model.md).
export const AGENT_PROCESSES = [
  { name: 'Claude Code', exe: /^claude$/i, command: /@anthropic-ai\/claude-code|claude-agent-sdk|\/Claude\.app\//i },
  { name: 'Codex', exe: /^codex$/i, command: /@openai\/codex|\/codex(?:-[a-z0-9_-]+)?(?:\s|$)/i },
  { name: 'Grok', exe: /^grok$/i, command: /grok-cli/i },
  { name: 'Gemini CLI', exe: /^gemini$/i, command: /@google\/gemini-cli/i },
  { name: 'Cursor agent', exe: /^cursor-agent$/i, command: null },
  { name: 'aider', exe: /^aider$/i, command: /(^|\/)aider(\s|$)/i },
];

const PS = ['/bin/ps', '/usr/bin/ps'].find((p) => fs.existsSync(p)) ?? null;
const psField = (pid, field) => {
  if (!PS) return null;
  const r = spawnSync(PS, ['-o', `${field}=`, '-p', String(pid)], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : null;
};

// Why this process may not take a typed confirmation, or ''. `ps` is injected only by the scenarios.
export function terminalProcessProblem(ps = psField, pid = process.pid) {
  const tty = ps(pid, 'tty');
  if (tty === null) return 'its controlling terminal cannot be read (fail closed)';
  if (!tty || /^\?+$/.test(tty)) return 'it has no controlling terminal device';
  const seen = new Set();
  for (let p = pid, n = 0; p > 1 && n < 64; n++) {
    if (seen.has(p)) break;
    seen.add(p);
    const parent = ps(p, 'ppid');
    const comm = ps(p, 'comm');
    const command = ps(p, 'command');
    if (parent === null || comm === null || command === null || !/^\d+$/.test(parent)) return `its process ancestry cannot be read at pid ${p} (fail closed)`;
    const hit = AGENT_PROCESSES.find((a) => a.exe.test(path.basename(comm)) || (a.command && a.command.test(command)));
    if (hit) return `an ancestor process (pid ${p}, ${path.basename(comm)}) is an agent runtime (${hit.name})`;
    p = Number(parent);
  }
  return '';
}
function terminalAuthority(owner, phrase, what, terminal) {
  const how = `the owner \`${owner}\` runs the command in their own terminal, where it asks them to type \`${phrase}\``;
  const agentEnv = AGENT_ENV.filter((k) => process.env[k]);
  if (agentEnv.length) throw refuse(`not done: ${what} needs the owner's authority; the attempt's owner \`${owner}\` has no host transcript, and this runs under an agent runtime (${agentEnv.join(', ')})`, how);
  if (!terminal.isTTY()) throw refuse(`not done: ${what} needs the owner's authority; the attempt's owner \`${owner}\` has no host transcript, and this is not an interactive terminal`, how);
  const proc = terminal.processProblem();
  if (proc) throw refuse(`not done: ${what} needs the owner's authority; the attempt's owner \`${owner}\` has no host transcript, and ${proc}`, how);
  fs.writeSync(terminal.output, `${what} is the owner's decision. Type exactly \`${phrase}\` to confirm: `);
  const line = readLine(terminal.input);
  if (line === null) throw refuse(`not confirmed (the input ended before \`${phrase}\` was typed); nothing recorded`);
  if (fold(line) !== fold(phrase)) throw refuse(`not confirmed (typed ${JSON.stringify(line.trim().slice(0, 80))}, not \`${phrase}\`); nothing recorded`);
  fs.writeSync(terminal.output, `recorded as interactive-terminal (unverified): ${phrase}\n`);
  return { provenance: 'interactive-terminal (unverified)', phrase };
}

function readLine(fd) {
  const chunks = [];
  const one = Buffer.alloc(1);
  for (;;) {
    let n;
    try {
      n = fs.readSync(fd, one, 0, 1, null);
    } catch (error) {
      if (error.code === 'EAGAIN') continue;
      if (error.code === 'EOF') return null;
      throw error;
    }
    if (!n) return chunks.length ? Buffer.concat(chunks).toString('utf8') : null;
    if (one[0] === 10) return Buffer.concat(chunks).toString('utf8').replace(/\r$/, '');
    chunks.push(Buffer.from(one));
    if (chunks.length > 4096) return Buffer.concat(chunks).toString('utf8');
  }
}

// Whether `ran` is exactly the expected invocation: one plain `wf` command (no shell operator, quote, expansion or
// redirect: anything a shell would reinterpret refuses), the subcommand, every expected flag with its value and nothing
// else, run after admission and within the last 10 minutes. Not a shell parser: plain words or a refusal.
const RUN_WINDOW_MS = 10 * 60 * 1000;
const ENGINE_BIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'wf');
const realOr = (p) => {
  try {
    return fs.realpathSync(p);
  } catch {
    return null;
  }
};
function commandProblem(ran, spec, state) {
  if (/[;&|`$<>()\n\r'"\\*?~{}[\]#!]/.test(ran.command)) return 'its last command is not one plain wf invocation';
  const at = Date.parse(ran.at ?? '');
  if (!Number.isFinite(at)) return 'its last command carries no time';
  if (at > Date.now() + 1000) return 'its last command records a future time';
  if (Date.now() - at > RUN_WINDOW_MS) return 'its last command ran more than 10 minutes ago';
  if (state.admittedAt && at < Date.parse(state.admittedAt)) return 'its last command ran before the attempt was admitted';
  const words = ran.command.trim().split(/[ \t]+/);
  let i = 0;
  // `wf` (by name or a path to it), or `node` running this engine's own `bin/wf` (0.5.0 adversarial review: `node` with
  // any script named `wf` was accepted, so a look-alike script's run counted as the owner's command).
  if (path.basename(words[0]) === 'node') {
    if (!words[1] || !path.isAbsolute(words[1]) || realOr(words[1]) !== realOr(ENGINE_BIN)) return `its last command runs \`${(words[1] ?? '').slice(0, 200)}\` with node, not this engine's own ${ENGINE_BIN}`;
    i = 2;
  } else if (path.basename(words[0]) !== 'wf') return 'its last command is not a wf invocation';
  else i = 1;
  for (const w of spec.sub) if (words[i++] !== w) return `its last command is not \`wf ${spec.sub.join(' ')}\``;
  const want = new Map(Object.entries(spec.flags));
  const seen = new Set();
  while (i < words.length) {
    const k = words[i];
    if (!want.has(k) || seen.has(k)) return `its last command has \`${k}\`, which this decision does not name`;
    if (words[i + 1] !== want.get(k)) return `its last command has \`${k} ${words[i + 1] ?? ''}\`, not \`${k} ${want.get(k)}\``;
    seen.add(k);
    i += 2;
  }
  const missing = [...want.keys()].filter((k) => !seen.has(k));
  return missing.length ? `its last command lacks ${missing.join(', ')}` : '';
}

// The command of the last Bash tool call the owner session's own assistant made (Claude Code writes it before running it).
function lastOwnerCommand(bytes) {
  const lines = bytes.toString('utf8').split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i]) continue;
    let e;
    try {
      e = JSON.parse(lines[i]);
    } catch {
      continue;
    }
    if (e?.type !== 'assistant' || e.isSidechain || !Array.isArray(e.message?.content)) continue;
    const call = e.message.content.filter((b) => b?.type === 'tool_use').at(-1);
    if (!call) continue;
    const id = typeof e.uuid === 'string' && e.uuid ? `uuid:${e.uuid}` : `sha256:${crypto.createHash('sha256').update(lines[i]).digest('hex')}`;
    return call.name === 'Bash' && typeof call.input?.command === 'string' ? { command: call.input.command, line: i + 1, at: e.timestamp ?? null, id } : null;
  }
  return null;
}
