// The host layer: everything the workflow knows about the harness that runs its agents (Claude Code, Codex, a future
// one) lives behind this folder. A harness is an execution detail (docs/DESIGN.md, the host adapter layer): the
// lifecycle, strategy, gate, ledger and review policy never name one. They ask this registry, which hands back the
// adapter for a runtime id the ledger or the caller supplied.
//
// An adapter is one module in this folder with a default export of the same flat shape (below). Required fields identify
// the harness and say how its roles start; every function that reads the harness's own records (transcripts, usage,
// role files) is optional, and a missing one degrades to "unknown" rather than failing (`optional(adapter, name)`).
// Adapter functions return data (identity, launch arguments, measurements, plan text, tracker readback). None returns
// an authority verdict: who may decide what is the ledger's and the owner's business (engine/owner.mjs).
//
//   id, name, label                      'claude', 'Claude', 'Claude Code': the runtime id stored in ledgers and the words used for it
//   spawnMode                            'owner-native' (the owner starts a role by agent type) or 'engine-only' (`wf handoff run`)
//   sessionEnv, markerEnv, envPrefixes   environment names of its sessions, and prefixes of its credentials
//   detect(env)                          -> { session } | null          (omitted: the harness can launch roles but never own an attempt)
//   classDefaults                        per work class defaults ({ full: { effort }, ... })
//   classifierDefaults                   the learning classifier's { model, effort } (engine/learning.mjs)
//   classifyLaunch({ prompt, model, effort, dir }) -> { bin, args, input, outFile? }   optional: one tool-less labelling turn
//   classifyResult({ stdout, outFile })  -> { text, costUsd?, model? }                optional: that turn's answer
//
// A harness is added by writing one module here and listing it in `builtin()` below; `registerHost` adds one at run time
// (the plug-in scenario registers a throwaway harness this way, touching no engine file).
import { refuse, setUpgradeCommands } from '../util.mjs';
export { descendants, lastFencedYaml, lastModel } from './turns.mjs';
import claude from './claude.mjs';
import codex from './codex.mjs';

// Harnesses with their own adapter, in the order they are consulted (the first whose session variable is set owns the
// session). Evaluated on first use so an adapter module that imports engine code cannot meet this file half-loaded.
const builtin = () => [claude, codex];

let registry = null;
function hosts() {
  registry ??= new Map(builtin().map((a) => [a.id, a]));
  return registry;
}

// Agent runtimes the engine recognises by the session variable they set, without an adapter: a session of one is never
// mistaken for a person (`wf approve` refuses under it, its credentials stay out of project commands), but it can
// neither own an attempt nor run a role. A registered adapter with the same id replaces its entry.
const RECOGNISED = [{ id: 'grok', sessionEnv: ['GROK_SESSION_ID'], markerEnv: [], envPrefixes: ['GROK_', 'XAI_'], detect: (env) => (env.GROK_SESSION_ID ? { session: env.GROK_SESSION_ID } : null) }];
// Set by agent runtimes in general rather than by one: never a person's own shell.
const GENERIC_AGENT_ENV = ['AI_AGENT'];

const recognised = () => RECOGNISED.filter((r) => !hosts().has(r.id));
const known = () => [...hosts().values(), ...recognised()];

export const hostIds = () => [...hosts().keys()];
// The runtime a command assumes when it runs outside every harness session: the first registered.
export const defaultHostId = () => hostIds()[0];
// `claude|codex`, `claude or codex`: the ids for usage and refusal text.
export const hostChoice = (separator = '|') => hostIds().join(separator);
// `Claude or Codex`: the harness names for prose.
export const hostNames = (separator = ' or ') => [...hosts().values()].map((h) => h.name).join(separator);
// `Claude Code or Codex`: the harness labels for prose.
export const hostLabels = (separator = ' or ') => [...hosts().values()].map((h) => h.label).join(separator);
export const findHost = (id) => hosts().get(String(id ?? '')) ?? null;
export function hostFor(id) {
  const host = findHost(id);
  if (!host) throw refuse(`unknown runtime \`${id}\`: use ${hostChoice(' or ')}`);
  return host;
}
export const isHost = (id) => findHost(id) !== null;

export function registerHost(adapter) {
  if (!adapter || typeof adapter.id !== 'string' || !/^[a-z][a-z0-9-]*$/.test(adapter.id)) throw new Error('a host adapter needs an id of lowercase letters, digits and dashes');
  hosts().set(adapter.id, adapter);
  return adapter;
}
export function unregisterHost(id) {
  hosts().delete(id);
}

// Sentences an adapter supplies for the texts the engine prints; the neutral wording when it supplies none.
const FRAGMENTS = {
  toolCompatibility: 'Use the file reader and writer your host provides.',
  closureWriter: 'your file writer',
  staleRole: (agentType) => `A session reads agent files when it starts, so an agent of type ${agentType} started from this session is started with the old instructions; its bundle points it at the current file, which it reads first, so no restart is needed for its instructions; a change to its tools still needs the session restarted.`,
  howToStart: (h) => `start it as agent type \`${h.agentType ?? 'the one `wf handoff` printed'}\`, named \`${h.agent}\`, with only the printed line as its prompt`,
  // How a question panel takes its options (0.7.28, I-202): each is the option's label alone, so the panel offers exactly the
  // decision's options and the person's pick binds by itself (engine/approve.mjs).
  panelOptions: 'each option is its label alone (the recommended one may end with " (Recommended)"); what follows a label goes in the option\'s description, or in the question\'s text when the panel has none',
};
export function fragment(host, name, ...args) {
  const text = host?.fragments?.[name] ?? FRAGMENTS[name];
  return typeof text === 'function' ? text(...args) : text;
}

// A function an adapter may omit; null when it does (the "missing" behaviour of its capability).
export const optional = (host, name) => (typeof host?.[name] === 'function' ? host[name].bind(host) : null);

// ---- Who is calling ----

// The harness session this process runs under: { runtime, session }, or null for a person's own shell.
export function detectOwner(env = process.env) {
  for (const host of known()) {
    const found = host.detect?.(env);
    if (found?.session) return { runtime: host.id, session: found.session };
  }
  return null;
}

// Owner strings are `<runtime>:<session id>`; the grammar lives here and nowhere else.
export const ownerString = (runtime, session) => `${runtime}:${session}`;
const ownerPrefix = () => new RegExp(`^(${hostIds().map((id) => id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')}):`);
// The runtime an owner or actor string names (`claude:SID` -> `claude`), or null for a person and for any other prefix.
export const ownerRuntime = (owner) => ownerPrefix().exec(String(owner ?? ''))?.[1] ?? null;
// { runtime, session } for a session owner with a non-empty session id, else null.
export function parseOwner(owner) {
  const m = new RegExp(`${ownerPrefix().source}(.+)$`).exec(String(owner ?? ''));
  return m ? { runtime: m[1], session: m[2] } : null;
}

// Environment names that mean an agent runtime runs this command (`wf approve` refuses under any of them).
export function agentEnvNames() {
  const names = (hs) => hs.flatMap((h) => [...(h.sessionEnv ?? []), ...(h.markerEnv ?? [])]);
  return [...new Set([...names([...hosts().values()]), ...GENERIC_AGENT_ENV, ...names(recognised())])];
}
// Names removed from the environment of a role the engine launches, so the role is never mistaken for its launcher.
export const launchEnvDeletes = () => [...known().flatMap((h) => h.sessionEnv ?? []), ...GENERIC_AGENT_ENV];
// Prefixes of agent-runtime credentials and session ids: project commands never receive them unless the adapter names them.
export const credentialPrefixes = () => known().flatMap((h) => h.envPrefixes ?? []);

// The update command of each harness's plugin manager, for the hint when the engine is older than a project's pin.
setUpgradeCommands(() => known().map((h) => h.fragments?.pluginUpdate).filter(Boolean));
