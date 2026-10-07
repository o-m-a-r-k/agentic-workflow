// Host-recorded tracker readback (0.4.2). In connector mode the agent calls the tracker's MCP tools; the host (Claude
// Code, Codex) writes every tool call and its unchanged result to the session transcript. `wf tracker record
// --from-transcript` reads the attempt owner's transcript and takes the tracker's own answer from it, so the readback
// is what the host recorded, not what the agent retyped. Limit, plainly: a process running as the same user could
// edit the transcript; it is the host's record, not a signature.
//
// Layouts read (checked on a real machine): Claude Code `~/.claude/projects/<encoded cwd>/<session id>.jsonl`, an
// assistant line with `message.content[]` `{ type: 'tool_use', id, name, input }` and a user line with
// `{ type: 'tool_result', tool_use_id, content: [{ type: 'text', text }] }`; Codex
// `~/.codex/sessions/YYYY/MM/DD/rollout-<time>-<thread id>.jsonl` (and `archived_sessions/`), `response_item` lines
// with `payload.type: 'function_call'` (`namespace`, `name`, `arguments` JSON text, `call_id`) and
// `'function_call_output'` (`call_id`, `output`: text or `[{ type, text }]`).
//
// Safety: the session id must be a plain id; the file must be a regular file (no link, one name) whose real path is
// under the host's own folder; it is opened without following a link, size-capped, read line by line, and only the
// matching tool calls are kept. Lines are data: nothing in them is ever run or followed.
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { home } from './provenance.mjs';

const SESSION = /^[A-Za-z0-9][A-Za-z0-9-]{7,63}$/;
export const maxTranscriptBytes = () => Number(process.env.WF_TRANSCRIPT_MAX_BYTES ?? 512 * 1024 * 1024);

function realDirs(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => path.join(dir, e.name));
  } catch {
    return [];
  }
}

// The owner's transcript: { runtime, file } or { problem }.
export function ownerTranscript(owner) {
  const m = /^(claude|codex):(.+)$/.exec(String(owner ?? ''));
  if (!m) return { problem: `the attempt's owner \`${owner}\` is not a Claude Code or Codex session, so no host transcript can be read; record with \`--capture\` (a saved tool result) or \`--agent-reported\`` };
  const [, runtime, id] = m;
  if (!SESSION.test(id)) return { problem: `the owner's session id is not a plain id; no transcript is read` };
  const base = runtime === 'claude' ? path.join(home(), '.claude', 'projects') : path.join(home(), '.codex');
  let baseReal;
  try {
    baseReal = fs.realpathSync.native(base);
  } catch {
    return { problem: `no ${runtime === 'claude' ? 'Claude Code' : 'Codex'} transcript store on this machine (${base})` };
  }
  const candidates = [];
  if (runtime === 'claude') for (const d of realDirs(base)) candidates.push(path.join(d, `${id}.jsonl`));
  else {
    for (const top of ['sessions', 'archived_sessions']) {
      const walk = (dir, depth) => {
        let entries = [];
        try {
          entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch {}
        for (const e of entries) {
          const p = path.join(dir, e.name);
          if (e.isDirectory() && depth < 3) walk(p, depth + 1);
          else if (e.name.startsWith('rollout-') && e.name.endsWith(`-${id}.jsonl`)) candidates.push(p);
        }
      };
      walk(path.join(base, top), 0);
    }
  }
  const found = candidates.filter((p) => fs.lstatSync(p, { throwIfNoEntry: false }));
  if (!found.length) return { problem: `no transcript for the owner session \`${id}\` under ${base}` };
  // Named failure (0.5.0 adversarial review): the newest of several files for one session id was read, so a copy of the
  // owner's transcript in another project folder was read instead of the original. A session has one transcript; two
  // are refused, never chosen between.
  if (found.length > 1) return { problem: `${found.length} transcripts for the owner session \`${id}\` (${found.join(', ')}); a session has one, so none is read` };
  const file = found[0];
  const st = fs.lstatSync(file);
  if (st.isSymbolicLink()) return { problem: `${file} is a symlink; a transcript is never read through a link` };
  if (!st.isFile() || st.nlink > 1) return { problem: `${file} is not a regular file with one name` };
  const real = fs.realpathSync.native(file);
  if (!real.startsWith(baseReal + path.sep)) return { problem: `${file} resolves outside ${base}` };
  if (st.size > maxTranscriptBytes()) return { problem: `${file} is ${st.size} bytes, over the ${maxTranscriptBytes()}-byte cap (WF_TRANSCRIPT_MAX_BYTES)` };
  return { runtime, session: id, file: real, size: st.size };
}

const toolOf = (full) => /^mcp__.+?__([A-Za-z0-9_]+)$/.exec(full)?.[1] ?? null;
const textOf = (content) => (typeof content === 'string' ? content : Array.isArray(content) ? content.filter((p) => p?.type === 'text' || p?.type === 'output_text' || p?.type === 'input_text').map((p) => p.text ?? '').join('') : null);
const parseArgs = (a) => {
  if (a && typeof a === 'object') return a;
  try {
    return JSON.parse(String(a ?? ''));
  } catch {
    return {};
  }
};

// Every connector call whose tool is one of `tools` (by suffix: `mcp__linear__get_issue`, `mcp__<uuid>__get_issue`),
// with its input, its result text exactly as the host stored it, and when each was written.
export async function connectorCalls({ runtime, file }, tools) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  const st = fs.fstatSync(fd);
  if (!st.isFile() || st.nlink > 1) {
    fs.closeSync(fd);
    throw new Error(`${file} is not a regular file with one name`);
  }
  const calls = new Map();
  if (st.size === 0) {
    fs.closeSync(fd);
    return [];
  }
  const rl = readline.createInterface({ input: fs.createReadStream(null, { fd, end: Math.min(st.size, maxTranscriptBytes()) - 1 }), crlfDelay: Infinity });
  let n = 0;
  for await (const line of rl) {
    n++;
    if (!line.includes('mcp__') && !line.includes('tool_result') && !line.includes('function_call_output')) continue;
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if (runtime === 'claude') {
      const content = e?.message?.content;
      if (!Array.isArray(content)) continue;
      for (const b of content) {
        if (b?.type === 'tool_use' && typeof b.name === 'string' && tools.includes(toolOf(b.name))) calls.set(b.id, { tool: toolOf(b.name), name: b.name, input: b.input ?? {}, calledAt: e.timestamp ?? null, line: n });
        else if (b?.type === 'tool_result' && calls.has(b.tool_use_id)) Object.assign(calls.get(b.tool_use_id), { result: textOf(b.content), error: b.is_error === true, at: e.timestamp ?? null, resultLine: n });
      }
    } else {
      const p = e?.payload;
      if (e?.type !== 'response_item' || !p) continue;
      if (p.type === 'function_call') {
        const ns = String(p.namespace ?? '');
        const full = ns ? (ns.endsWith('__') ? `${ns}${p.name}` : `${ns}__${p.name}`) : String(p.name ?? '');
        if (tools.includes(toolOf(full))) calls.set(p.call_id, { tool: toolOf(full), name: full, input: parseArgs(p.arguments), calledAt: e.timestamp ?? null, line: n });
      } else if (p.type === 'function_call_output' && calls.has(p.call_id)) Object.assign(calls.get(p.call_id), { result: textOf(p.output), error: false, at: e.timestamp ?? null, resultLine: n });
    }
  }
  return [...calls.values()];
}
