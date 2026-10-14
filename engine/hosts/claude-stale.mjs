// Role files loaded at session start (I-15).
// Named failure: `wf sync` added a tool to a generated role file, and the next agent of that type started from the same,
// already running Claude Code session still ran with the old role (Claude Code reads agent files when the session
// starts): the reviewer lacked Write and fell back to a shell heredoc. The handoff warns when the role file changed after
// the owning session started. "Started" is the later of the session transcript's first entry and the start time of the
// Claude Code process this command runs under (a resumed session reloads its agent files); with neither known, nothing
// is claimed.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { transcriptFile } from './claude-store.mjs';

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

// The first timestamp in the owning session's transcript.
function transcriptStart(session, home) {
  const found = transcriptFile(session, { home, cap: Infinity });
  if (!found.file) return null;
  let fd;
  try {
    fd = fs.openSync(found.file, 'r');
  } catch {
    return null;
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
  return null;
}

// → { file, changedAt, sessionStartedAt } when the project's generated role file for this agent type changed after the
// owning Claude Code session started, else null.
export function roleChangedSinceSessionStart(root, agentType, owner, { home }) {
  if (owner?.runtime !== 'claude' || !agentType) return null;
  const file = path.join(root, '.claude', 'agents', `${agentType}.md`);
  const st = fs.statSync(file, { throwIfNoEntry: false });
  if (!st) return null;
  const starts = [transcriptStart(owner.session, home), claudeProcessStart()].filter((x) => x !== null);
  if (!starts.length) return null;
  const started = Math.max(...starts);
  if (st.mtimeMs <= started) return null;
  return { file, changedAt: new Date(st.mtimeMs).toISOString(), sessionStartedAt: new Date(started).toISOString() };
}
