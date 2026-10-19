// Scenario helpers for 0.8 tests. They import only engine/contract.mjs and node.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { clearDoubles, ledgerFile, setDoubles } from '../../engine/contract.mjs';
import { gitEnv } from './project.mjs';

export const WF = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'bin', 'wf');

// No agent runtime in a spawned wf: the scenario is a person at a terminal unless it sets a session variable itself.
const RUNTIME_VARS = ['CLAUDE_CODE_SESSION_ID', 'CLAUDECODE', 'CODEX_THREAD_ID', 'CODEX_SANDBOX', 'AI_AGENT', 'GROK_SESSION_ID'];

// Run this checkout's `wf` in `cwd` (default: the project root) with the project's isolated folders.
// Returns { code, out, err, json() }.
export function runWf(project, args, { cwd = project.root, env = {}, input, doubles } = {}) {
  const e = { ...gitEnv(), ...project.env, ...(doubles ? { WF_DOUBLES: doubles } : {}), ...env };
  for (const k of RUNTIME_VARS) if (!(k in env)) delete e[k];
  const r = spawnSync(process.execPath, [WF, ...args], { cwd, env: e, input, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return { code: r.status, out: r.stdout, err: r.stderr, json: () => JSON.parse(r.stdout) };
}

// The raw ledger lines of an attempt (for asserting what was written; reading state goes through attemptState).
export function ledgerLines(root, attempt) {
  const file = ledgerFile(root, attempt);
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
}

// In-process doubles for the length of `fn` (contract facades only).
export async function withDoubles(map, fn) {
  setDoubles(map);
  try {
    return await fn();
  } finally {
    clearDoubles();
  }
}

// A doubles module for a spawned `wf` (pass its path as `runWf(..., { doubles })`): `source` is the body of the default
// export's object, e.g. `launchReviewer: async () => ({ session: { runtime: 'claude', id: 's1' }, launchedAt: '...' })`.
export function writeDoubles(project, name, source) {
  const file = path.join(project.tmp, 'doubles', `${name}.mjs`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `export default {\n${source}\n};\n`);
  return file;
}

// A finding as a reviewer writes it (ReviewInput.findings[]).
export const finding = (location, cls = 'goal', severity = 'medium', what = 'what is wrong', why = 'why it matters') => ({ location, class: cls, severity, what, why });
