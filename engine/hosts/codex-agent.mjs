// Named failure I-41: desktop subagent prompts are encrypted and cannot prove an exact, blind start prompt.
// Engine-launched roles record fixed parameters; the actual Codex host transcript must agree with them.
import { readRegular } from '../evidence.mjs';
import { sha256 } from '../util.mjs';
import { codexTranscript } from './codex-transcript.mjs';
import { readCapped } from './safe-file.mjs';

export function codexEntries(file) {
  const raw = readCapped(file).toString('utf8').split('\n').flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } });
  const entries = [];
  for (const e of raw) {
    const p = e.payload;
    if (e.type === 'response_item' && p?.type === 'message' && p.role === 'assistant') entries.push({ role: 'assistant', at: e.timestamp ?? null, texts: (p.content ?? []).filter((b) => b.type === 'output_text').map((b) => b.text ?? ''), model: null });
  }
  return { raw, entries };
}

export function verifyRole(handoff, { home }) {
  if (!handoff.launch) return { status: 'unverified', reason: 'Codex desktop subagent prompts are encrypted; use `wf handoff run --agent <id>` for an engine-recorded fresh launch' };
  const mismatch = (reason) => ({ status: 'mismatch', reason });
  const launch = handoff.launch;
  if (!handoff.session || launch.session !== handoff.session || !['running', 'completed'].includes(launch.status)) return mismatch('the engine-launched Codex role has not completed successfully or supplied its session id');
  const record = readRegular(launch.file);
  if (!record || sha256(record.bytes) !== launch.sha256) return mismatch('the engine launch receipt is missing or changed');
  let receipt;
  try { receipt = JSON.parse(record.bytes); } catch { return mismatch('the engine launch receipt is invalid'); }
  if (receipt.handoff !== handoff.bundle || receipt.prompt !== handoff.startPrompt || receipt.agentType !== handoff.agentType || receipt.model !== handoff.model || receipt.effort !== handoff.effort) return mismatch('the engine launch receipt does not match the handed role, model, effort or start prompt');
  const transcript = codexTranscript(handoff.session, { home });
  if (transcript.problem) return mismatch(transcript.problem);
  const { raw, entries } = codexEntries(transcript.file);
  const meta = raw.find((e) => e.type === 'session_meta')?.payload;
  if (meta?.id !== handoff.session || meta.originator !== 'codex_exec' || !['exec', 'cli'].includes(meta.source) || meta.forked_from_id || meta.parent_thread_id) return mismatch('the Codex role transcript is not the recorded fresh engine-launched session');
  const prompts = raw.flatMap((e) => {
    const p = e.payload;
    if (e.type === 'event_msg' && p?.type === 'user_message') return [{ timestamp: e.timestamp, text: p.message }];
    if (e.type !== 'response_item' || p?.type !== 'message' || p.role !== 'user') return [];
    const kinds = p.internal_chat_message_metadata_passthrough?.content_item_kinds;
    const wrappers = ['plugins.recommendations', 'agents_md.instructions', 'environments.environment_context'];
    if (Array.isArray(kinds) && kinds.length && kinds.every((k) => wrappers.includes(k))) return [];
    if (!Array.isArray(p.content) || p.content.some((b) => b?.type !== 'input_text' || typeof b.text !== 'string')) return [{ timestamp: e.timestamp, text: null }];
    return [{ timestamp: e.timestamp, text: p.content.map((b) => b.text).join('') }];
  });
  // Hosts that write both layouts duplicate the same prompt; a later turn still refuses a resumed/steered round.
  const prompt = prompts[0];
  if (!prompt || prompt.text !== handoff.startPrompt || prompts.some((p) => p.text !== prompt.text || p.timestamp !== prompt.timestamp)) return mismatch('the Codex start prompt was not exactly the printed line or its session was resumed');
  const at = Date.parse(prompt.timestamp), admitted = Date.parse(handoff.at);
  if (!Number.isFinite(at) || !Number.isFinite(admitted) || at < admitted || at > Date.now() + 1000) return mismatch('the Codex role start prompt predates its handoff, is in the future or has no timestamp');
  return { status: 'verified', transcript: transcript.file, identity: 'engine-launched', entries };
}
