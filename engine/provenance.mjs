import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readTranscript, subagentIndex } from './telemetry.mjs';
import { verifyCodexAgent } from './codex-agent.mjs';

// Where a runtime's transcripts are available, a review round (or a plan taken with --from-agent) must come from the
// agent the engine handed the work to, started with exactly the line `wf handoff` printed. Named failures: a steered
// reviewer (extra prompt text), and a review round run outside the engine under a reused name.

export const home = () => process.env.WF_HOME ?? os.homedir();
export const startPromptFor = (bundle) => `Read ${bundle} and follow its instructions.`;

function firstPrompt(entries) {
  const e = entries.find((x) => x.type === 'user' && !x.isMeta);
  if (!e) return { text: null, at: null };
  const c = e.message?.content;
  const text = typeof c === 'string' ? c : Array.isArray(c) ? c.filter((b) => b.type === 'text').map((b) => b.text ?? '').join('\n') : null;
  return { text, at: e.timestamp ?? null };
}

// How the owner starts the agent a handoff names, in words: the agent type, the name, and only the printed line.
export const howToStart = (h) => `start it as agent type \`${h.agentType ?? 'the one `wf handoff` printed'}\`, named \`${h.agent}\` (the Agent tool's name), with only the printed line as its prompt`;

// → { status: 'verified', transcript, identity } | { status: 'unverified', reason } | { status: 'mismatch', reason }
export function verifyAgent(handoff) {
  if (handoff.runtime === 'codex') return verifyCodexAgent(handoff, home());
  if (handoff.runtime !== 'claude') return { status: 'unverified', reason: `no transcripts are read for runtime ${handoff.runtime}` };
  if (!fs.existsSync(path.join(home(), '.claude', 'projects'))) return { status: 'unverified', reason: 'no Claude Code transcript store on this machine' };
  const expected = handoff.startPrompt ?? startPromptFor(handoff.bundle);
  const index = subagentIndex(home());
  const candidates = index.filter((x) => x.name === handoff.agent);
  if (!candidates.length) return unnamedAgent(handoff, index, expected);
  const problems = [];
  for (const c of candidates.sort((a, b) => fs.statSync(b.file).mtimeMs - fs.statSync(a.file).mtimeMs)) {
    const mine = [];
    if (handoff.agentType && c.agentType !== handoff.agentType) mine.push(`it ran as agent type \`${c.agentType}\`, not \`${handoff.agentType}\``);
    const first = firstPrompt(readTranscript(c.file));
    if (first.text === null) mine.push('its transcript has no start prompt');
    else if (first.text.trim() !== expected) mine.push(`its start prompt was not exactly the printed line (${first.text.length} characters; expected ${JSON.stringify(expected)})`);
    if (first.at && handoff.at && Date.parse(first.at) < Date.parse(handoff.at)) mine.push(`it started at ${first.at}, before its handoff at ${handoff.at}`);
    if (!mine.length) return { status: 'verified', transcript: c.file, identity: 'named' };
    problems.push(...mine);
  }
  return { status: 'mismatch', reason: `${handoff.agent}: ${[...new Set(problems)].join('; ')}` };
}

// Named failure (I-14): the reviewer handoff printed no agent name, the owner started the reviewer unnamed, it did the
// whole review, and the closure was refused because no transcript carried the handed name. The start line names this
// handoff's own bundle file, so a transcript that began with exactly that line, after the handoff, as the handed agent
// type, is this round's agent. When exactly one unnamed transcript does, it is accepted as the handed agent (recorded
// `identity: unnamed`); several are ambiguous and refused, as is none.
function unnamedAgent(handoff, index, expected) {
  const since = handoff.at ? Date.parse(handoff.at) : null;
  const fresh = index.filter((x) => x.name === null).filter((x) => {
    try {
      return !since || fs.statSync(x.file).mtimeMs >= since;
    } catch {
      return false;
    }
  });
  const started = fresh.filter((x) => {
    const first = firstPrompt(readTranscript(x.file));
    return first.text !== null && first.text.trim() === expected && !(first.at && since && Date.parse(first.at) < since);
  });
  const typed = started.filter((x) => !handoff.agentType || x.agentType === handoff.agentType);
  if (typed.length === 1) return { status: 'verified', transcript: typed[0].file, identity: 'unnamed', reason: `the agent was started without a name; its transcript is the only one that began with this handoff's line as agent type ${handoff.agentType ?? typed[0].agentType}` };
  if (typed.length > 1) return { status: 'mismatch', reason: `no Claude Code subagent transcript named \`${handoff.agent}\`, and ${typed.length} unnamed ones began with this handoff's line, so which one wrote the closure is ambiguous: ${howToStart(handoff)}` };
  const wrongType = started.map((x) => x.agentType);
  return { status: 'mismatch', reason: `no Claude Code subagent transcript named \`${handoff.agent}\`${wrongType.length ? ` (an unnamed agent began with this handoff's line, but as agent type \`${wrongType[0]}\`, not \`${handoff.agentType}\`)` : ''}: ${howToStart(handoff)}` };
}

// ---- Role files loaded at session start (I-15) ----
// Named failure: `wf sync` added a tool to a generated role file, and the next agent of that type started from the same,
// already running Claude Code session still ran with the old role (Claude Code reads agent files when the session
// starts): the reviewer lacked Write and fell back to a shell heredoc. The handoff warns when the role file changed after
// the owning session started. "Started" is the later of the session transcript's first entry and the start time of the
// Claude Code process this command runs under (a resumed session reloads its agent files); with neither known, nothing
// is claimed.

const CLAUDE_PROCESS = /(^|\/)claude(\s|$)|@anthropic-ai\/claude-code\//;
function claudeProcessStart() {
  const env = { ...process.env, LC_ALL: 'C', LANG: 'C' };
  let pid = process.ppid;
  for (let i = 0; i < 40 && pid > 1; i++) {
    const r = spawnSync('ps', ['-o', 'ppid=,args=', '-p', String(pid)], { encoding: 'utf8', env });
    const m = /^\s*(\d+)\s+([\s\S]*)$/.exec(r.status === 0 ? r.stdout ?? '' : '');
    if (!m) return null;
    if (CLAUDE_PROCESS.test(m[2].trim())) {
      const t = spawnSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', env });
      const ms = Date.parse(String(t.stdout ?? '').trim());
      return Number.isFinite(ms) ? ms : null;
    }
    pid = Number(m[1]);
  }
  return null;
}

// The first timestamp in the owning session's transcript (~/.claude/projects/<project>/<session>.jsonl).
function transcriptStart(session) {
  if (!session || !/^[A-Za-z0-9._-]+$/.test(session)) return null;
  const dir = path.join(home(), '.claude', 'projects');
  let projects = [];
  try {
    projects = fs.readdirSync(dir);
  } catch {
    return null;
  }
  for (const p of projects) {
    const f = path.join(dir, p, `${session}.jsonl`);
    let fd;
    try {
      fd = fs.openSync(f, 'r');
    } catch {
      continue;
    }
    try {
      const buf = Buffer.alloc(256 * 1024);
      const n = fs.readSync(fd, buf, 0, buf.length, 0);
      for (const line of buf.subarray(0, n).toString('utf8').split('\n')) {
        try {
          const ms = Date.parse(JSON.parse(line).timestamp);
          if (Number.isFinite(ms)) return ms;
        } catch {}
      }
    } finally {
      fs.closeSync(fd);
    }
  }
  return null;
}

// → { file, changedAt, sessionStartedAt } when the project's generated role file for this agent type changed after the
// owning Claude Code session started, else null.
export function roleChangedSinceSessionStart(root, agentType, identity) {
  if (identity?.runtime !== 'claude' || !agentType) return null;
  const file = path.join(root, '.claude', 'agents', `${agentType}.md`);
  const st = fs.statSync(file, { throwIfNoEntry: false });
  if (!st) return null;
  const starts = [transcriptStart(identity.session), claudeProcessStart()].filter((x) => x !== null);
  if (!starts.length) return null;
  const started = Math.max(...starts);
  if (st.mtimeMs <= started) return null;
  return { file, changedAt: new Date(st.mtimeMs).toISOString(), sessionStartedAt: new Date(started).toISOString() };
}
