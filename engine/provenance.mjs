import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readTranscript, subagentIndex } from './telemetry.mjs';

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

// → { status: 'verified', transcript } | { status: 'unverified', reason } | { status: 'mismatch', reason }
export function verifyAgent(handoff) {
  if (handoff.runtime !== 'claude') return { status: 'unverified', reason: `no transcripts are read for runtime ${handoff.runtime}` };
  if (!fs.existsSync(path.join(home(), '.claude', 'projects'))) return { status: 'unverified', reason: 'no Claude Code transcript store on this machine' };
  const expected = handoff.startPrompt ?? startPromptFor(handoff.bundle);
  const candidates = subagentIndex(home()).filter((x) => x.name === handoff.agent);
  if (!candidates.length) return { status: 'mismatch', reason: `no Claude Code subagent transcript named \`${handoff.agent}\`: start the agent type \`wf handoff\` named, under that name, with only the printed line` };
  const problems = [];
  for (const c of candidates.sort((a, b) => fs.statSync(b.file).mtimeMs - fs.statSync(a.file).mtimeMs)) {
    const mine = [];
    if (handoff.agentType && c.agentType !== handoff.agentType) mine.push(`it ran as agent type \`${c.agentType}\`, not \`${handoff.agentType}\``);
    const first = firstPrompt(readTranscript(c.file));
    if (first.text === null) mine.push('its transcript has no start prompt');
    else if (first.text.trim() !== expected) mine.push(`its start prompt was not exactly the printed line (${first.text.length} characters; expected ${JSON.stringify(expected)})`);
    if (first.at && handoff.at && Date.parse(first.at) < Date.parse(handoff.at)) mine.push(`it started at ${first.at}, before its handoff at ${handoff.at}`);
    if (!mine.length) return { status: 'verified', transcript: c.file };
    problems.push(...mine);
  }
  return { status: 'mismatch', reason: `${handoff.agent}: ${[...new Set(problems)].join('; ')}` };
}
