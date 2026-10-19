// The hosts: everything the engine knows about the agent harnesses (Claude Code, Codex) lives behind this folder. Each
// host module reads its own transcript layout into the same items (engine/hosts/claude.mjs, `timeline`), and every
// reader here works on those items, so a reader is written once for every host.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { pathToFileURL } from 'node:url';
import { hostHome, userDir } from '../contract.mjs';
import claude from './claude.mjs';
import codex from './codex.mjs';
import { shellReads } from './shell-reads.mjs';
import { toolMatches } from './tool-calls.mjs';

const registry = new Map([claude, codex].map((h) => [h.id, h]));
// Variables agent runtimes set without a host module here: a process under one is an agent, never the person.
const AGENT_MARKERS = ['AI_AGENT', 'GROK_SESSION_ID'];

export const hostIds = () => [...registry.keys()];
export const findHost = (id) => registry.get(String(id ?? '')) ?? null;
export const optional = (host, name) => (typeof host?.[name] === 'function' ? host[name].bind(host) : null);
export function registerHost(host) {
  if (!host || !/^[a-z][a-z0-9-]*$/.test(String(host.id))) throw new Error('a host needs an id of lowercase letters, digits and dashes');
  registry.set(host.id, host);
  return host;
}
export const unregisterHost = (id) => registry.delete(id);

// Hosts from outside the plugin: every `.mjs` file in `<userDir>/hosts/`, or the files and folders `WF_HOSTS` lists
// (separated as PATH is), each with its host as the default export. Loaded when this module is imported, so every
// process that reads hosts (`wf`, the reviewer launch supervisor) knows them. A module that does not load is named in
// `hostProblems` and on stderr; the built-in hosts still load.
export const hostProblems = [];
function hostFiles(env = process.env) {
  const sources = env.WF_HOSTS ? env.WF_HOSTS.split(path.delimiter).filter(Boolean) : [path.join(userDir(env), 'hosts')];
  const out = [];
  for (const src of sources) {
    let st;
    try {
      st = fs.statSync(src);
    } catch {
      if (env.WF_HOSTS) hostProblems.push(`host module ${src}: not found`);
      continue;
    }
    if (st.isDirectory()) for (const f of fs.readdirSync(src).filter((n) => n.endsWith('.mjs')).sort()) out.push(path.join(src, f));
    else out.push(src);
  }
  return out;
}
for (const file of hostFiles()) {
  try {
    const mod = await import(pathToFileURL(path.resolve(file)).href);
    registerHost(mod.default);
  } catch (error) {
    hostProblems.push(`host module ${file}: ${error.message}`);
  }
}
for (const p of hostProblems) process.stderr.write(`wf: ${p}\n`);

// Prefixes of agent-runtime credentials and session ids: project commands never receive them (engine/env.mjs).
export const credentialPrefixes = () => [...registry.values()].flatMap((h) => h.envPrefixes ?? []);
// Variables removed from a launched role's environment, so it is never mistaken for its launcher.
export const sessionVariables = () => [...new Set([...[...registry.values()].flatMap((h) => [...(h.sessionEnv ?? []), ...(h.markerEnv ?? [])]), ...AGENT_MARKERS])];

// The session running this process; null at a plain terminal.
export function callerSession(env = process.env) {
  for (const h of registry.values()) {
    const id = h.detect?.(env);
    if (id) return { runtime: h.id, id: String(id) };
  }
  return null;
}
// Whether an agent runtime runs this process, with or without a session id the engine can read.
export const underAgent = (env = process.env) => sessionVariables().some((k) => env[k]);

const homeOf = (opts) => opts?.home ?? hostHome();
function itemsOf(session, opts) {
  const host = findHost(session?.runtime);
  if (!host || typeof session?.id !== 'string') return null;
  try {
    const file = host.transcript(session.id, homeOf(opts));
    return file ? host.timeline(file) : null;
  } catch {
    return null;
  }
}

const FILE_TOOLS = new Set(['Read', 'NotebookRead', 'read_file', 'view_image']);

// The files a session read: its file reader's targets (a failed read is left out) and the files its shell commands
// printed (a file the shell reported missing is left out). Absolute paths, in order, each once. null: no readable
// transcript.
export function filesRead(session, opts = {}) {
  const t = itemsOf(session, opts);
  if (!t) return null;
  const calls = new Map();
  const results = new Map();
  for (const it of t.items) {
    if (it.type === 'call') calls.set(it.id, it);
    else if (it.type === 'result' && calls.has(it.id)) results.set(it.id, it);
  }
  const out = new Set();
  for (const c of calls.values()) {
    const r = results.get(c.id);
    if (!r) continue; // never answered: interrupted before it read anything
    const base = c.cwd ?? t.cwd ?? '/';
    if (c.shell !== undefined && c.shell !== null) {
      for (const p of shellReads(c.shell, base)) if (!r.text.includes(`${path.basename(p)}: No such file`)) out.add(p);
      continue;
    }
    const target = FILE_TOOLS.has(c.name) ? c.input.file_path ?? c.input.notebook_path ?? c.input.path : null;
    if (!r.error && typeof target === 'string' && target) out.add(path.resolve(base, target));
  }
  return [...out];
}

const HUMAN = new Set(['person', 'act', 'panel']);
const real = (m) => (m && !String(m).startsWith('<') ? m : null);

// Turn times (human or not), token use, cost and model of a session.
export function sessionActivity(session, opts = {}) {
  const t = itemsOf(session, opts);
  if (!t) return null;
  const turns = [];
  const requests = new Map();
  let total = null;
  let model = null;
  for (const it of t.items) {
    if (it.at) {
      if (turns.at(-1)?.at === it.at) turns.at(-1).human ||= HUMAN.has(it.type);
      else turns.push({ at: it.at, human: HUMAN.has(it.type) });
    }
    if (it.type === 'usage') {
      const prev = requests.get(it.key);
      if (!prev || it.output >= prev.output) requests.set(it.key, it); // one request over several lines counts once
    }
    if (it.type === 'total') total = it; // a running total per session
    model = real(it.model) ?? model;
  }
  const tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  for (const r of total ? [total] : requests.values()) for (const k of Object.keys(tokens)) tokens[k] += r[k] ?? 0;
  return { turns, tokens, cost: null, model };
}

// Connector calls, matched by tool-name suffix, with the result as the host stored it. `name`: the full tool name.
export function connectorCalls(session, tools, opts = {}) {
  const t = itemsOf(session, opts);
  if (!t) return [];
  const since = opts.since ? Date.parse(opts.since) : null;
  const calls = new Map();
  for (const it of t.items) {
    if (it.type === 'call') {
      // An empty list, or an empty suffix, matches every call; `tool` is then the full name the call went to.
      const all = !tools?.length || tools.includes('');
      const tool = all ? it.name : tools.find((w) => toolMatches(it.name, w));
      if (tool && (since === null || Date.parse(it.at) >= since)) calls.set(it.id, { tool, name: it.name, input: it.input, result: null, error: false, at: it.at });
    } else if (it.type === 'result' && calls.has(it.id)) Object.assign(calls.get(it.id), { result: it.text, error: it.error === true });
  }
  return [...calls.values()];
}

// A file's modification time is a coarse clock: Linux stamps it from the kernel's tick, a few milliseconds behind the
// time a process reads, and some file systems keep whole or even seconds. A transcript written right after a question
// was asked can carry an mtime before it, so the mtime only skips files untouched since well before `since`; the items'
// own times decide what is late.
const MTIME_SLACK_MS = 2000;

// Every session of the project, of any host, written to at or after `since`, with its items: those whose recorded
// working folder is the project root or a folder under it. A host's `cwdOf` reads only a transcript's first entries,
// so sessions of other projects are never read whole.
export function projectSessions(root, { home, since } = {}) {
  const sinceMs = since ? Date.parse(since) - MTIME_SLACK_MS : 0;
  let realRoot = root;
  try {
    realRoot = fs.realpathSync(root);
  } catch {}
  const within = (cwd) => typeof cwd === 'string' && [root, realRoot].some((r) => path.resolve(cwd) === r || path.resolve(cwd).startsWith(r + path.sep));
  const out = [];
  for (const host of registry.values()) {
    for (const { session, file } of host.projectTranscripts?.(root, home ?? hostHome(), sinceMs) ?? []) {
      try {
        if (typeof host.cwdOf === 'function' && !within(host.cwdOf(file))) continue;
        const t = host.timeline(file);
        if (within(t.cwd)) out.push({ session, file, ...t });
      } catch {}
    }
  }
  return out;
}

// The JSON in a reviewer's final text: from its first `{` to its last `}` (a fence or a sentence around it is not
// part of it). null when that span is not JSON.
export function jsonSpan(text) {
  const s = String(text ?? '');
  const a = s.indexOf('{');
  const b = s.lastIndexOf('}');
  if (a < 0 || b < a) return null;
  try {
    return JSON.parse(s.slice(a, b + 1));
  } catch {
    return null;
  }
}

const sha256 = (data) => crypto.createHash('sha256').update(data).digest('hex');
const samePath = (a, b) => {
  if (path.resolve(a) === path.resolve(b)) return true;
  try {
    return fs.realpathSync(a) === fs.realpathSync(b);
  } catch {
    return false;
  }
};

// Whether `file` came from `session`, as a fact of that session's transcript: its last successful write to that path
// (Claude Code's Write tool) has the file's exact content, or its final message's JSON (jsonSpan) equals the file's
// JSON. The second is how a reviewer whose host writes its last message (Codex `--output-last-message`, or the launch
// supervisor) produces the file. False when the file is missing or the transcript shows neither; null when the session
// has no readable transcript (nothing to check against).
export function writtenBy(session, file, opts = {}) {
  const t = itemsOf(session, opts);
  if (!t) return null;
  let content;
  try {
    content = fs.readFileSync(file);
  } catch {
    return false;
  }
  const calls = new Map();
  let lastWrite = null;
  let lastSay = null;
  for (const it of t.items) {
    if (it.type === 'say') lastSay = it.text;
    else if (it.type === 'call') calls.set(it.id, it);
    else if (it.type === 'result' && !it.error && calls.get(it.id)?.name === 'Write') {
      const c = calls.get(it.id);
      const target = c.input.file_path;
      if (typeof target === 'string' && typeof c.input.content === 'string' && samePath(path.resolve(c.cwd ?? t.cwd ?? '/', target), file)) lastWrite = c.input.content;
    }
  }
  if (lastWrite !== null && sha256(Buffer.from(lastWrite, 'utf8')) === sha256(content)) return true;
  if (lastSay === null) return false;
  const said = jsonSpan(lastSay);
  if (said === null) return false;
  try {
    return isDeepStrictEqual(said, JSON.parse(content.toString('utf8')));
  } catch {
    return false;
  }
}

export const implements08 = {
  filesRead: async (session, opts) => filesRead(session, opts),
  callerSession: async (env) => callerSession(env),
  sessionActivity: async (session, opts) => sessionActivity(session, opts),
  connectorCalls: async (session, tools, opts) => connectorCalls(session, tools, opts),
};
