// Codex as a host: where its transcripts are, what their lines mean, and how a reviewer is launched.
// Transcripts ("rollouts"): <home>/.codex/sessions/YYYY/MM/DD/rollout-<time>-<thread id>.jsonl (archived ones under
// archived_sessions/), lines `{ timestamp, type, payload }`: `session_meta` first, then `turn_context`, `response_item`
// (messages, tool calls and their outputs) and `event_msg` (token counts, notices).
import fs from 'node:fs';
import path from 'node:path';
import { findSkill } from './codex-skills.mjs';
import { codexTranscript } from './codex-transcript.mjs';
import { tomlRole } from './role-files.mjs';
import { readEntries } from './safe-file.mjs';
import { parseArgs, textOf } from './tool-calls.mjs';

const record = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const labels = (options) => (Array.isArray(options) ? options.map((o) => (typeof o === 'string' ? o : o?.label)).filter((l) => typeof l === 'string') : []);

// What the harness adds in the person's place: instruction files, environment context, plugin notes, page context.
const WRAPPERS = ['plugins.recommendations', 'agents_md.instructions', 'environments.environment_context'];
const HARNESS = /^<(environment_context|user_instructions|permissions|turn_aborted|user_shell_command|subagent_notification|external_codex_apps_[a-z_]+|codex_apps_[a-z_]+)\b|^# AGENTS\.md instructions/;
function personOf(p) {
  const kinds = p.internal_chat_message_metadata_passthrough?.content_item_kinds;
  if (Array.isArray(kinds) && kinds.length && kinds.every((k) => WRAPPERS.includes(k) || String(k).startsWith('additional_content.'))) return null;
  const blocks = p.content.filter((b) => b?.type === 'input_text' && typeof b.text === 'string').map((b) => b.text.trim()).filter(Boolean);
  if (!blocks.length) return p.content.some((b) => b?.type === 'input_image') ? { act: true } : null;
  const kept = blocks.filter((b) => !HARNESS.test(b));
  if (!kept.length) return null;
  const text = kept.join('\n').trim();
  return text.startsWith('<') ? { act: true } : { text };
}

// The question panel's reply: a user message that is exactly `<send_user_message_question_reply>[rows]</...>`, each row
// naming its call by `questionItemId` `[tool, callId, index]`.
function panelOf(text) {
  const m = /^\s*<send_user_message_question_reply>\s*([\s\S]*?)\s*<\/send_user_message_question_reply>\s*$/.exec(text);
  if (!m) return null;
  let rows;
  try {
    rows = JSON.parse(m[1]);
  } catch {
    return [];
  }
  const out = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    try {
      const [, callId] = JSON.parse(row.questionItemId);
      if (typeof callId === 'string' && typeof row.question === 'string' && typeof row.answer === 'string') out.push({ id: callId, question: row.question, answer: row.answer });
    } catch {}
  }
  return out;
}

const QUESTION_TOOLS = new Set(['request_user_input', 'request_user_input_async']);
const SHELL_TOOLS = new Set(['shell', 'exec_command', 'local_shell', 'container.exec']);
const plain = (name) => String(name ?? '').replace(/^functions\./, '');
const jsonString = (s) => {
  try {
    return JSON.parse(`"${s}"`);
  } catch {
    return s;
  }
};

// Reads a literal object argument as data (never evaluates it): `{ key: "v", n: 1 }`. Null for anything else.
function literal(source) {
  const lex = /\s+|"(?:[^"\\\r\n]|\\.)*"|'(?:[^'\\\r\n]|\\.)*'|[A-Za-z_$][A-Za-z0-9_$]*|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|[{}[\],:]/y;
  const tokens = [];
  let at = 0;
  while (at < source.length) {
    lex.lastIndex = at;
    const m = lex.exec(source);
    if (!m) return null;
    at = lex.lastIndex;
    let t = m[0];
    if (/^\s+$/.test(t)) continue;
    if (t.startsWith("'")) t = JSON.stringify(t.slice(1, -1).replace(/\\'/g, "'"));
    else if (/^[A-Za-z_$]/.test(t) && !['true', 'false', 'null'].includes(t)) {
      if (!/^\s*:/.test(source.slice(at))) return null;
      t = JSON.stringify(t);
    }
    tokens.push(t);
  }
  try {
    const v = JSON.parse(tokens.join(''));
    return record(v) ? v : null;
  } catch {
    return null;
  }
}

// A script run through the `exec` tool: one literal connector call printed whole (`text(await tools.mcp__x__y({...}))`)
// is a connector call; `tools.exec_command({ cmd: "...", workdir: "..." })` calls are shell commands.
function scriptCalls(input) {
  const source = String(input).replace(/^\s*\/\/ @exec:[^\n]*\n/, '').trim();
  const connector = /^text\(\s*await\s+tools\.(mcp__[A-Za-z0-9_-]+__[A-Za-z0-9_]+)\(\s*(\{[\s\S]*\})\s*\)\s*\)\s*;?$/.exec(source);
  if (connector) {
    const args = literal(connector[2]);
    return args ? [{ name: connector[1], input: args, wrapped: true }] : [];
  }
  const out = [];
  for (const m of source.matchAll(/exec_command\(\s*\{([^}]*)\}/g)) {
    const cmd = /"?cmd"?\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(m[1]);
    const workdir = /"?workdir"?\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(m[1]);
    if (cmd) out.push({ name: 'exec_command', input: { cmd: jsonString(cmd[1]), ...(workdir ? { workdir: jsonString(workdir[1]) } : {}) }, shell: jsonString(cmd[1]), workdir: workdir ? jsonString(workdir[1]) : null });
  }
  return out;
}
// The output of a wrapped connector call: the script's banner, then the connector's JSON result.
function wrappedResult(output) {
  if (!Array.isArray(output) || output.length !== 2 || !/^Script completed\n/.test(output[0]?.text ?? '')) return null;
  try {
    const r = JSON.parse(output[1].text);
    return Array.isArray(r?.content) ? { text: r.content.map((b) => b?.text ?? '').join(''), error: r.isError === true } : null;
  } catch {
    return null;
  }
}

// The session as host-neutral items (the same shapes as engine/hosts/claude.mjs). Person turns only in an interactive
// session: a `codex exec` run's user message is its launcher's prompt, and a sub-agent's "user" is its parent agent.
export function timeline(file) {
  const items = [];
  let cwd = null;
  let meta = false;
  let interactive = false;
  let model = null;
  const wrapped = new Set();
  for (const e of readEntries(file)) {
    if (!record(e)) continue;
    const at = typeof e.timestamp === 'string' ? e.timestamp : null;
    const p = e.payload;
    if (e.type === 'session_meta' && record(p)) {
      if (!meta) {
        interactive = ['cli', 'vscode'].includes(p.source) && p.originator !== 'codex_exec' && !p.parent_thread_id;
        cwd = typeof p.cwd === 'string' ? p.cwd : null;
      }
      meta = true;
      continue;
    }
    if (e.type === 'turn_context' && record(p)) {
      if (typeof p.model === 'string') model = p.model;
      if (typeof p.cwd === 'string') cwd ??= p.cwd;
      continue;
    }
    if (e.type === 'event_msg' && p?.type === 'token_count' && record(p.info?.total_token_usage)) {
      const t = p.info.total_token_usage;
      items.push({ type: 'total', at, model, input: Math.max(0, (t.input_tokens ?? 0) - (t.cached_input_tokens ?? 0)), output: t.output_tokens ?? 0, cacheRead: t.cached_input_tokens ?? 0, cacheWrite: t.cache_write_input_tokens ?? 0 });
      continue;
    }
    if (e.type !== 'response_item' || !record(p)) continue;
    if (p.type === 'message' && Array.isArray(p.content)) {
      if (p.role === 'assistant') {
        for (const b of p.content) if (b?.type === 'output_text' && typeof b.text === 'string' && b.text.trim()) items.push({ type: 'say', at, text: b.text, model });
        continue;
      }
      if (p.role !== 'user' || !interactive) continue;
      const text = p.content.filter((b) => b?.type === 'input_text').map((b) => b.text ?? '').join('\n');
      const panel = panelOf(text);
      if (panel) {
        const byCall = new Map();
        for (const r of panel) (byCall.get(r.id) ?? byCall.set(r.id, {}).get(r.id))[r.question] = r.answer;
        for (const [id, answers] of byCall) items.push({ type: 'panel', at, id, answers });
        continue;
      }
      const person = personOf(p);
      if (person?.text) items.push({ type: 'person', at, text: person.text });
      else if (person?.act) items.push({ type: 'act', at });
      continue;
    }
    if (p.type === 'function_call' || p.type === 'local_shell_call') {
      const ns = String(p.namespace ?? '');
      const name = ns ? (ns.endsWith('__') ? `${ns}${p.name}` : `${ns}__${p.name}`) : plain(p.name ?? p.type);
      const args = p.type === 'local_shell_call' ? { command: p.action?.command, workdir: p.action?.working_directory } : parseArgs(p.arguments);
      if (QUESTION_TOOLS.has(plain(p.name))) {
        const field = plain(p.name) === 'request_user_input_async' ? 'title' : 'question';
        items.push({ type: 'ask', at, id: p.call_id, questions: (Array.isArray(args.questions) ? args.questions : []).filter((q) => typeof q?.[field] === 'string').map((q) => ({ text: q[field], options: labels(q.options) })) });
        continue;
      }
      const shell = SHELL_TOOLS.has(plain(p.name)) || p.type === 'local_shell_call' ? args.cmd ?? args.command : undefined;
      items.push({ type: 'call', at, id: p.call_id, name, input: args, cwd: args.workdir ?? cwd, shell });
      continue;
    }
    if (p.type === 'custom_tool_call') {
      if (['exec', 'functions.exec'].includes(p.name) && typeof p.input === 'string') {
        const calls = scriptCalls(p.input);
        if (calls.length === 1 && calls[0].wrapped) wrapped.add(p.call_id);
        for (const c of calls) items.push({ type: 'call', at, id: p.call_id, name: c.name, input: c.input, cwd: c.workdir ?? cwd, shell: c.shell });
        if (!calls.length) items.push({ type: 'call', at, id: p.call_id, name: p.name, input: { script: p.input }, cwd });
      } else items.push({ type: 'call', at, id: p.call_id, name: plain(p.name), input: { input: p.input }, cwd });
      continue;
    }
    if (p.type === 'function_call_output' || p.type === 'custom_tool_call_output') {
      const w = wrapped.has(p.call_id) ? wrappedResult(p.output) : null;
      const text = w ? w.text : textOf(record(p.output) ? p.output.content ?? p.output : p.output);
      const exit = /"exit_code"\s*:\s*(\d+)|Process exited with code (\d+)|Exit code: (\d+)/.exec(text);
      items.push({ type: 'result', at, id: p.call_id, text, error: w ? w.error : Boolean(exit && Number(exit[1] ?? exit[2] ?? exit[3]) !== 0) });
    }
  }
  return { cwd, items };
}

export function transcript(id, home) {
  const found = codexTranscript(id, { home });
  return found.file ?? null;
}

// Rollouts whose session started in the project root or a folder under it, written to at or after `sinceMs`.
export function projectTranscripts(root, home, sinceMs = 0) {
  const out = [];
  const walk = (dir, depth) => {
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {}
    for (const e of entries) {
      const file = path.join(dir, e.name);
      if (e.isDirectory() && depth < 3) walk(file, depth + 1);
      else if (e.isFile() && /^rollout-.*\.jsonl$/.test(e.name) && fs.statSync(file).mtimeMs >= sinceMs) {
        const id = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i.exec(e.name)?.[1];
        if (id) out.push({ session: { runtime: 'codex', id }, file });
      }
    }
  };
  for (const top of ['sessions', 'archived_sessions']) walk(path.join(home, '.codex', top), 0);
  void root; // the caller keeps the rollouts whose recorded cwd is in the project
  return out;
}

// A fresh reviewer: `codex exec --json` with the prompt on stdin, read-only; its thread id arrives as `thread.started`.
const launch = ({ model, cwd }) => ({ bin: 'codex', args: ['exec', '--json', '--cd', cwd, '--sandbox', 'read-only', '--skip-git-repo-check', ...(model ? ['--model', model] : []), '-'], session: null, cwd });
const resume = ({ model, cwd, session }) => ({ bin: 'codex', args: ['exec', '--json', '--cd', cwd, '--sandbox', 'read-only', '--skip-git-repo-check', ...(model ? ['--model', model] : []), 'resume', session, '-'], session, cwd });

const CAPACITY = /server_overloaded|server_is_overloaded|\boverloaded\b|\bat capacity\b/i;
function event(e) {
  if (e.type === 'thread.started') return { started: e.thread_id };
  if (e.type === 'turn.completed') return { ended: { ok: true } };
  if (e.type === 'turn.failed') return { ended: { ok: false }, capacity: CAPACITY.test(`${e.error?.message ?? ''} ${e.error?.code ?? ''} ${e.message ?? ''}`) };
  return {};
}

export default {
  id: 'codex',
  name: 'Codex',
  label: 'Codex',
  sessionEnv: ['CODEX_THREAD_ID'],
  markerEnv: ['CODEX_SANDBOX'],
  envPrefixes: ['CODEX_', 'OPENAI_'],
  detect: (env) => (env.CODEX_THREAD_ID ? env.CODEX_THREAD_ID : null),
  agentsDir: '.codex/agents',
  skillsDir: '.agents/skills',
  findSkill,
  roleFile: ({ root, name, description, model, effort, body }) => ({ file: path.join(root, '.codex', 'agents', `${name}.toml`), content: tomlRole({ name, description, model, effort, body }) }),
  transcript,
  projectTranscripts,
  timeline,
  launch,
  resume,
  event,
};
