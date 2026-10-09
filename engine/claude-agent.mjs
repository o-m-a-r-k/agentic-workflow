// Named failure: a native Claude process result alone did not prove a fresh frozen role prompt.
import { ownerTranscript } from './host-record.mjs';
import { readCapped } from './discovered.mjs';
import { readRegular } from './evidence.mjs';
import { sha256 } from './util.mjs';

export function verifyClaudeLaunch(h, hostHome) {
  const mismatch = (reason) => ({ status: 'mismatch', reason });
  const l = h.launch;
  if (!h.session || l?.session !== h.session || !['running', 'completed'].includes(l.status)) return mismatch('the native Claude role has no successful launch/session');
  const record = readRegular(l.file);
  if (!record || sha256(record.bytes) !== l.sha256) return mismatch('the native Claude launch receipt is missing or changed');
  let receipt;
  try { receipt = JSON.parse(record.bytes); } catch { return mismatch('the native Claude launch receipt is invalid'); }
  if (receipt.runtime !== 'claude' || receipt.requestedSession !== h.session || receipt.handoff !== h.bundle || receipt.prompt !== h.startPrompt || receipt.agentType !== h.agentType || receipt.model !== h.model || receipt.effort !== h.effort) return mismatch('the native Claude receipt differs from its frozen handoff');
  const transcript = ownerTranscript(`claude:${h.session}`, hostHome);
  if (transcript.problem) return mismatch(transcript.problem);
  const entries = readCapped(transcript.file).toString('utf8').split('\n').flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } });
  const prompts = entries.filter((e) => e.type === 'user' && !e.isMeta && (typeof e.message?.content === 'string' || (Array.isArray(e.message?.content) && e.message.content.some((b) => b.type === 'text') && !e.message.content.some((b) => b.type === 'tool_result'))));
  if (prompts.length !== 1) return mismatch('the native Claude role has no unique fresh start prompt or was resumed');
  const first = prompts[0], content = first.message.content;
  const text = typeof content === 'string' ? content : content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
  if (first.sessionId !== h.session || first.isSidechain !== false || first.entrypoint !== 'sdk-cli' || text !== h.startPrompt) return mismatch('the native Claude transcript is not the recorded fresh role start');
  const at = Date.parse(first.timestamp);
  if (!Number.isFinite(at) || at < Date.parse(h.at) || at > Date.now() + 1000) return mismatch('the native Claude start predates its handoff or has no valid timestamp');
  return { status: 'verified', transcript: transcript.file, identity: 'engine-launched', entries };
}
