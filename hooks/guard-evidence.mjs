#!/usr/bin/env node
// Keeps agents' file-editing tools (and a shell started inside the evidence folder) out of agentic-workflow evidence
// (.wf-evidence/). Threat model: agents are fallible, not adversarial (docs/trust-model.md). It judges file targets, never
// shell text. Named failure (0.7.0): the Bash text-scanning branch made 334 refusals in the field, none of them a write
// attempt and 229 naming no evidence folder at all (any `$` or backtick next to "wf-"), and it blocked the engine's own
// recovery advice. Writing evidence through a shell is not a mistake an agent makes by accident; the ledger's hash chain,
// its anchor, the manifest and the OS immutability flags detect and refuse it afterwards (`wf verify`).
//
// - An Edit/Write/MultiEdit/NotebookEdit target, or a native patch target (a rename included), that has a
//   `.wf-evidence` path component, as written or as the OS resolves it (symlinks followed, case and Unicode forms folded),
//   is blocked. The content written is not inspected (a closure may cite evidence paths).
// - A command run with its working directory inside the evidence is blocked.
// - Everything else, a Bash command included, passes. Input the hook cannot read passes too.
// Reading evidence is the Read tool's job (this hook does not see it); copies out are made by `wf export screenshots`.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { findHost, hostIds, optional } from '../engine/hosts/index.mjs';
import { touchesEvidence } from '../engine/paths.mjs';

// I-16, named failure: the refusal said neither what matched nor how to avoid it, so agents split commands or switched
// tools by trial. It names the matched target and the supported routes.
const REFUSAL = 'agentic-workflow: refused: this targets the workflow evidence folder, which only `wf` writes. Read evidence with the Read tool or `wf evidence list` / `wf evidence show <path>`; copy screenshots out with `wf export screenshots`; change recorded state through a `wf` command.';

// Run as a hook only when executed directly; importing (tests) has no side effects.
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const chunks = [];
  process.stdin.on('data', (c) => chunks.push(c));
  process.stdin.on('end', () => {
    let verdict = null;
    try {
      // Decoded once: a multi-byte character split across chunks must not turn into replacement characters.
      verdict = decide(Buffer.concat(chunks).toString('utf8'));
    } catch {
      verdict = null;
    }
    if (verdict) {
      process.stderr.write(`${REFUSAL} (${verdict})\n`);
      process.exit(2);
    }
    process.exit(0);
  });
}

const segmentsOf = (p) => String(p).split(/[\\/]+/);
const inEvidence = (p) => segmentsOf(p).some((s) => s.normalize('NFKC').replace(/[\p{Cf}­]/gu, '').toLowerCase() === '.wf-evidence');

// The real location of a path whose ancestors may be symlinks (the nearest existing ancestor is resolved).
function real(p) {
  const rest = [];
  let cur = p;
  for (;;) {
    try {
      return path.join(fs.realpathSync(cur), ...rest);
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return p;
      rest.unshift(path.basename(cur));
      cur = parent;
    }
  }
}

const expandHome = (file) => file.replace(/^~(?=\/|$)/, process.env.HOME ?? '~');

export function check(data) {
  if (!data || typeof data !== 'object') return null;
  const t = data.tool_input;
  const cwd = typeof data.cwd === 'string' && data.cwd ? data.cwd : process.cwd();
  const cwdInEvidence = inEvidence(cwd) || touchesEvidence(cwd);
  if (!t || typeof t !== 'object') return cwdInEvidence ? 'unknown tool input' : null;
  // Every file target is checked whatever else the input carries; each harness adapter reads the payload shape its own
  // file tools send (engine/hosts/).
  const files = [];
  let fileEdit = false;
  for (const id of hostIds()) {
    const found = optional(findHost(id), 'fileTargets')?.(data);
    if (!found) continue;
    if (found.malformed) return 'malformed native file-edit payload';
    files.push(...found.targets);
    fileEdit ||= found.fileEdit === true;
  }
  for (const file of files) {
    if (file === undefined || file === null) continue;
    if (typeof file !== 'string') return 'unknown file target';
    const abs = path.resolve(cwd, expandHome(file));
    if (inEvidence(file) || inEvidence(abs) || inEvidence(real(abs)) || touchesEvidence(expandHome(file), cwd)) return `${file} is workflow evidence`;
  }
  if (fileEdit) return null;
  if (cwdInEvidence && (t.command !== undefined || !files.some((f) => typeof f === 'string'))) return `the command runs inside the evidence folder (working directory ${cwd})`;
  return null;
}

export function decide(input) {
  let data;
  try {
    data = JSON.parse(input);
  } catch {
    return null;
  }
  return check(data);
}
