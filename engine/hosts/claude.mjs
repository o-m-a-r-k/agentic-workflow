// Claude Code as a host: where its transcripts are, what their lines mean, and how a reviewer is launched.
// Transcripts: <home>/.claude/projects/<cwd with every non-alphanumeric as '-'>/<session>.jsonl, one JSON object per line.
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { findSkill } from './claude-skills.mjs';
import { markdownRole } from './role-files.mjs';
import { firstEntry, isSafeName, readEntries, settleTranscript } from './safe-file.mjs';
import { textOf } from './tool-calls.mjs';

const encode = (cwd) => cwd.replace(/[^A-Za-z0-9]/g, '-');
const store = (home) => path.join(home, '.claude', 'projects');
const folders = (dir) => {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => path.join(dir, e.name));
  } catch {
    return [];
  }
};

// Lines the harness writes into the person's place: task notices, reminders, command echoes, interrupt markers.
const HARNESS = /^<(task-notification|system-reminder|local-command-stdout|local-command-stderr|local-command-caveat|command-message|command-name|user-prompt-submit-hook)\b|^\[Request interrupted by user/;
const strip = (t) => t.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').replace(/<pasted_content\b[^>]*>[\s\S]*?<\/pasted_content>/g, '').trim();

// A user line: { text } when the person typed words, { act: true } when they acted without words, null when the
// harness wrote it (meta lines, compaction summaries, tool results, notices).
function personOf(e) {
  if (e.isMeta || e.isCompactSummary || e.isVisibleInTranscriptOnly) return null;
  const c = e.message?.content;
  if (Array.isArray(c) && c.some((b) => b?.type === 'tool_result')) return null;
  const blocks = typeof c === 'string' ? [c] : Array.isArray(c) ? c.filter((b) => b?.type === 'text' && typeof b.text === 'string').map((b) => b.text) : [];
  const kept = blocks.map((b) => b.trim()).filter((b) => b && !HARNESS.test(b));
  if (!kept.length) return Array.isArray(c) && c.some((b) => b?.type === 'image') ? { act: true } : null;
  let text = strip(kept.join('\n'));
  const quote = /^<!--\s*reply\s+\d+\s*-->[ \t]*\n(?:>.*(?:\n|$))*/.exec(text); // a reply to a quoted message
  if (quote) text = text.slice(quote[0].length).trim();
  return !text || text.startsWith('<') ? { act: true } : { text };
}

const record = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const labels = (options) => (Array.isArray(options) ? options.map((o) => (typeof o === 'string' ? o : o?.label)).filter((l) => typeof l === 'string') : []);

// The session as host-neutral items, in order (engine/hosts/index.mjs reads them):
//   say {text} · ask {id, questions:[{text, options}]} · call {id, name, input, cwd} · result {id, text, error}
//   person {text} · act · panel {id, answers:{question: answer}} · usage {key, model, input, output, cacheRead, cacheWrite}
// Sub-agent (sidechain) lines are left out: what a session did is what its own turns did.
export function timeline(file) {
  const items = [];
  let cwd = null;
  for (const e of readEntries(file)) {
    if (!record(e) || e.isSidechain) continue;
    cwd ??= typeof e.cwd === 'string' ? e.cwd : null;
    const at = typeof e.timestamp === 'string' ? e.timestamp : null;
    const content = e.message?.content;
    if (e.type === 'assistant') {
      if (Array.isArray(content)) {
        for (const b of content) {
          if (b?.type === 'text' && typeof b.text === 'string' && b.text.trim()) items.push({ type: 'say', at, text: b.text });
          else if (b?.type === 'tool_use' && b.name === 'AskUserQuestion' && Array.isArray(b.input?.questions)) items.push({ type: 'ask', at, id: b.id, questions: b.input.questions.filter((q) => typeof q?.question === 'string').map((q) => ({ text: q.question, options: labels(q.options) })) });
          else if (b?.type === 'tool_use') items.push({ type: 'call', at, id: b.id, name: String(b.name), input: record(b.input) ? b.input : {}, cwd: e.cwd ?? cwd, shell: b.name === 'Bash' ? b.input?.command : undefined });
        }
      } else if (typeof content === 'string' && content.trim()) items.push({ type: 'say', at, text: content });
      const u = e.message?.usage;
      if (u) items.push({ type: 'usage', at, key: e.requestId ?? e.message?.id ?? e.uuid, model: e.message?.model ?? null, input: u.input_tokens ?? 0, output: u.output_tokens ?? 0, cacheRead: u.cache_read_input_tokens ?? 0, cacheWrite: u.cache_creation_input_tokens ?? 0 });
      continue;
    }
    if (e.type === 'attachment') {
      const a = e.attachment;
      if (a?.type === 'queued_command' && a.origin?.kind === 'human' && (a.commandMode ?? 'prompt') === 'prompt' && typeof a.prompt === 'string') {
        const text = strip(a.prompt);
        if (text && !text.startsWith('<')) items.push({ type: 'person', at, text });
      }
      continue;
    }
    if (e.type !== 'user') continue;
    if (Array.isArray(content) && content.some((b) => b?.type === 'tool_result')) {
      for (const b of content.filter((x) => x?.type === 'tool_result')) {
        if (record(e.toolUseResult?.answers)) items.push({ type: 'panel', at, id: b.tool_use_id, answers: e.toolUseResult.answers });
        else items.push({ type: 'result', at, id: b.tool_use_id, text: textOf(b.content), error: b.is_error === true });
      }
      continue;
    }
    // A `claude --print` session (an entrypoint of the SDK): its user line is the launcher's prompt, never the person.
    const p = /sdk/.test(String(e.entrypoint ?? '')) ? null : personOf(e);
    if (p?.text) items.push({ type: 'person', at, text: p.text });
    else if (p?.act) items.push({ type: 'act', at });
  }
  return { cwd, items };
}

// The session's working folder, from its first entries only (the same line `timeline` takes it from).
export const cwdOf = (file) => firstEntry(file, (e) => (record(e) && !e.isSidechain && typeof e.cwd === 'string' ? e.cwd : null));

// The one transcript of a session, or null.
export function transcript(id, home) {
  if (!isSafeName(id)) return null;
  const base = store(home);
  let baseReal;
  try {
    baseReal = fs.realpathSync.native(base);
  } catch {
    return null;
  }
  const found = settleTranscript({ runtime: 'claude', session: id, candidates: folders(base).map((d) => path.join(d, `${id}.jsonl`)), base, baseReal });
  return found.file ?? null;
}

// Transcripts whose folder is the project root or a folder under it, written to at or after `sinceMs`.
export function projectTranscripts(root, home, sinceMs = 0) {
  const prefix = encode(root);
  const out = [];
  for (const dir of folders(store(home))) {
    const name = path.basename(dir);
    if (name !== prefix && !name.startsWith(`${prefix}-`)) continue;
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.jsonl')) continue;
      const file = path.join(dir, f);
      const st = fs.lstatSync(file);
      if (st.isFile() && st.mtimeMs >= sinceMs) out.push({ session: { runtime: 'claude', id: f.slice(0, -6) }, file });
    }
  }
  return out;
}

// A fresh reviewer: `claude --print` with the prompt on stdin, its session id chosen here. It reads, and writes only its
// closure file: `Write(//<absolute path>)` is Claude Code's rule for that one absolute path; every other write, edit and
// command is denied (`dontAsk` refuses what is not allowed), `wf` included.
const tools = (closure) => ['Read', 'Grep', 'Glob', `Write(/${closure})`, 'Bash(git diff:*)', 'Bash(git show:*)', 'Bash(git log:*)'];
const disallowed = ['Edit', 'MultiEdit', 'NotebookEdit', 'Agent', 'Task'];
function launch({ model, cwd, closure }) {
  const session = randomUUID();
  const args = ['--print', '--verbose', '--output-format', 'stream-json', '--session-id', session, '--permission-mode', 'dontAsk', '--allowedTools', ...tools(closure), '--disallowedTools', ...disallowed];
  if (model) args.push('--model', model);
  return { bin: 'claude', args, session, cwd };
}
function resume({ model, cwd, session, closure }) {
  const args = ['--print', '--verbose', '--output-format', 'stream-json', '--resume', session, '--permission-mode', 'dontAsk', '--allowedTools', ...tools(closure), '--disallowedTools', ...disallowed];
  if (model) args.push('--model', model);
  return { bin: 'claude', args, session, cwd };
}

// The model at capacity, as Claude Code reports it: the API's overloaded error (HTTP 529).
const CAPACITY = /overloaded_error|\b529\b|\boverloaded\b/i;
function event(e) {
  if (e.type === 'system' && e.subtype === 'init') return { started: e.session_id };
  if (e.type === 'result') {
    const ok = e.subtype === 'success' && e.is_error === false;
    return { ended: { ok, session: e.session_id ?? null }, text: typeof e.result === 'string' ? e.result : null, capacity: !ok && CAPACITY.test(`${e.result ?? ''} ${e.error?.message ?? ''} ${e.error?.type ?? ''}`) };
  }
  return {};
}

export default {
  id: 'claude',
  name: 'Claude',
  label: 'Claude Code',
  sessionEnv: ['CLAUDE_CODE_SESSION_ID'],
  markerEnv: ['CLAUDECODE'],
  envPrefixes: ['CLAUDE_CODE_', 'CLAUDECODE', 'ANTHROPIC_'],
  detect: (env) => (env.CLAUDE_CODE_SESSION_ID ? env.CLAUDE_CODE_SESSION_ID : null),
  agentsDir: '.claude/agents',
  skillsDir: '.claude/skills',
  findSkill,
  roleFile: ({ root, name, description, model, effort, tools, body }) => ({ file: path.join(root, '.claude', 'agents', `${name}.md`), content: markdownRole({ name, description, model, effort, tools, body }) }),
  transcript,
  projectTranscripts,
  timeline,
  cwdOf,
  launch,
  resume,
  event,
};
