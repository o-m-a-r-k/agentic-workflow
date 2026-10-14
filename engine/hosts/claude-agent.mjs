// Is this role the one the engine launched, and the one it handed the work to? Claude Code's side of the question.
import fs from 'node:fs';
import path from 'node:path';
import { readRegular } from '../evidence.mjs';
import { sha256 } from '../util.mjs';
import { LABEL, assistantTurns, readTranscript, subagentIndex, transcriptFile } from './claude-store.mjs';
import { isPlainSessionId, readCapped } from './safe-file.mjs';

// How the owner starts the agent a handoff names, in words: the agent type, the name, and only the printed line.
export const howToStart = (h) => `start it as agent type \`${h.agentType ?? 'the one `wf handoff` printed'}\`, named \`${h.agent}\` (the Agent tool's name), with only the printed line as its prompt`;

// Named failure: a native Claude process result alone did not prove a fresh frozen role prompt.
function verifyLaunch(h, home) {
  const mismatch = (reason) => ({ status: 'mismatch', reason });
  const l = h.launch;
  if (!h.session || l?.session !== h.session || !['running', 'completed'].includes(l.status)) return mismatch('the native Claude role has no successful launch/session');
  const record = readRegular(l.file);
  if (!record || sha256(record.bytes) !== l.sha256) return mismatch('the native Claude launch receipt is missing or changed');
  let receipt;
  try { receipt = JSON.parse(record.bytes); } catch { return mismatch('the native Claude launch receipt is invalid'); }
  if (receipt.runtime !== 'claude' || receipt.requestedSession !== h.session || receipt.handoff !== h.bundle || receipt.prompt !== h.startPrompt || receipt.agentType !== h.agentType || receipt.model !== h.model || receipt.effort !== h.effort) return mismatch('the native Claude receipt differs from its frozen handoff');
  const transcript = isPlainSessionId(h.session) ? transcriptFile(h.session, { home }) : { problem: `the owner's session id is not a plain id; no transcript is read` };
  if (transcript.problem) return mismatch(transcript.problem);
  const entries = readCapped(transcript.file).toString('utf8').split('\n').flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } });
  const prompts = entries.filter((e) => e.type === 'user' && !e.isMeta && (typeof e.message?.content === 'string' || (Array.isArray(e.message?.content) && e.message.content.some((b) => b.type === 'text') && !e.message.content.some((b) => b.type === 'tool_result'))));
  if (prompts.length !== 1) return mismatch('the native Claude role has no unique fresh start prompt or was resumed');
  const first = prompts[0], content = first.message.content;
  const text = typeof content === 'string' ? content : content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
  if (first.sessionId !== h.session || first.isSidechain !== false || first.entrypoint !== 'sdk-cli' || text !== h.startPrompt) return mismatch('the native Claude transcript is not the recorded fresh role start');
  const at = Date.parse(first.timestamp);
  if (!Number.isFinite(at) || at < Date.parse(h.at) || at > Date.now() + 1000) return mismatch('the native Claude start predates its handoff or has no valid timestamp');
  return { status: 'verified', transcript: transcript.file, identity: 'engine-launched', entries: assistantTurns(entries) };
}

function firstPrompt(entries) {
  const e = entries.find((x) => x.type === 'user' && !x.isMeta);
  if (!e) return { text: null, at: null };
  const c = e.message?.content;
  const text = typeof c === 'string' ? c : Array.isArray(c) ? c.filter((b) => b.type === 'text').map((b) => b.text ?? '').join('\n') : null;
  return { text, at: e.timestamp ?? null };
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
  if (typed.length > 1) return { status: 'mismatch', reason: `no ${LABEL} subagent transcript named \`${handoff.agent}\`, and ${typed.length} unnamed ones began with this handoff's line, so which one wrote the closure is ambiguous: ${howToStart(handoff)}` };
  const wrongType = started.map((x) => x.agentType);
  return { status: 'mismatch', reason: `no ${LABEL} subagent transcript named \`${handoff.agent}\`${wrongType.length ? ` (an unnamed agent began with this handoff's line, but as agent type \`${wrongType[0]}\`, not \`${handoff.agentType}\`)` : ''}: ${howToStart(handoff)}` };
}

// → { status: 'verified', transcript, identity } | { status: 'unverified', reason } | { status: 'mismatch', reason }
// A role the engine launched is checked against its launch receipt; a role the owner started with the Agent tool is
// found by the name and agent type it was started under, and by exactly the printed start line.
export function verifyRole(handoff, { home, startPrompt }) {
  if (handoff.launch) return verifyLaunch(handoff, home);
  if (!fs.existsSync(path.join(home, '.claude', 'projects'))) return { status: 'unverified', reason: `no ${LABEL} transcript store on this machine` };
  const index = subagentIndex(home);
  const candidates = index.filter((x) => x.name === handoff.agent);
  if (!candidates.length) return unnamedAgent(handoff, index, startPrompt);
  const problems = [];
  for (const c of candidates.sort((a, b) => fs.statSync(b.file).mtimeMs - fs.statSync(a.file).mtimeMs)) {
    const mine = [];
    if (handoff.agentType && c.agentType !== handoff.agentType) mine.push(`it ran as agent type \`${c.agentType}\`, not \`${handoff.agentType}\``);
    const first = firstPrompt(readTranscript(c.file));
    if (first.text === null) mine.push('its transcript has no start prompt');
    else if (first.text.trim() !== startPrompt) mine.push(`its start prompt was not exactly the printed line (${first.text.length} characters; expected ${JSON.stringify(startPrompt)})`);
    if (first.at && handoff.at && Date.parse(first.at) < Date.parse(handoff.at)) mine.push(`it started at ${first.at}, before its handoff at ${handoff.at}`);
    if (!mine.length) return { status: 'verified', transcript: c.file, identity: 'named' };
    problems.push(...mine);
  }
  return { status: 'mismatch', reason: `${handoff.agent}: ${[...new Set(problems)].join('; ')}` };
}
