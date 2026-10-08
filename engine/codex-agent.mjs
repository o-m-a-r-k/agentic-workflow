// Named failure I-41: desktop subagent prompts are encrypted and cannot prove an exact, blind start prompt.
// Engine-launched roles record fixed parameters; the actual Codex host transcript must agree with them.
import { ownerTranscript } from './host-record.mjs';
import { readCapped } from './discovered.mjs';
import { readRegular } from './evidence.mjs';
import { sha256 } from './util.mjs';
import path from 'node:path';
import { completedNodeReads } from './codex-reads.mjs';

export function codexEntries(file, { bundle } = {}) {
  const raw = readCapped(file).toString('utf8').split('\n').flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } });
  const entries = [];
  for (const e of raw) {
    const p = e.payload;
    if (e.type === 'response_item' && p?.type === 'message' && p.role === 'assistant') entries.push({ type: 'assistant', timestamp: e.timestamp, message: { content: (p.content ?? []).filter((b) => b.type === 'output_text').map((b) => ({ type: 'text', text: b.text })) } });
    // Successful shell reads in Codex's own execution event, not a tool's claimed prose/result.
    const item = e.type === 'event_msg' && p?.type === 'item_completed' ? p.item : null;
    if (item?.type === 'CommandExecution' && item.exit_code === 0 && item.status === 'completed' && Array.isArray(item.command) && item.command.length === 3 && ['-c', '-lc'].includes(item.command[1])) {
      const command = item.command[2];
      entries.push({ type: 'assistant', message: { content: [{ type: 'tool_use', id: item.id, name: 'Bash', input: { command } }] } });
      // wf's own show command is the permitted way for Codex shell tools to read a frozen rule document.
      const parts = typeof command === 'string' ? command.split(' ') : [];
      if (parts.length === 6 && parts.slice(0, 3).join(' ') === 'wf evidence show' && path.isAbsolute(parts[3]) && /^[A-Za-z0-9_./-]+$/.test(parts[3]) && parts[4] === '--attempt' && /^[A-Za-z0-9_.-]+$/.test(parts[5])) entries.push({ type: 'assistant', message: { content: [{ type: 'tool_use', id: item.id + ':document', name: 'Read', input: { file_path: parts[3] } }] } });
    }
  }
  entries.push(...completedNodeReads(raw, bundle));
  return { raw, entries };
}

export function verifyCodexAgent(handoff, hostHome) {
  if (!handoff.launch) return { status: 'unverified', reason: 'Codex desktop subagent prompts are encrypted; use `wf handoff run --agent <id>` for an engine-recorded fresh launch' };
  const mismatch = (reason) => ({ status: 'mismatch', reason });
  const launch = handoff.launch;
  if (!handoff.session || launch.session !== handoff.session || !['running', 'completed'].includes(launch.status)) return mismatch('the engine-launched Codex role has not completed successfully or supplied its session id');
  const record = readRegular(launch.file);
  if (!record || sha256(record.bytes) !== launch.sha256) return mismatch('the engine launch receipt is missing or changed');
  let receipt;
  try { receipt = JSON.parse(record.bytes); } catch { return mismatch('the engine launch receipt is invalid'); }
  if (receipt.handoff !== handoff.bundle || receipt.prompt !== handoff.startPrompt || receipt.agentType !== handoff.agentType || receipt.model !== handoff.model || receipt.effort !== handoff.effort) return mismatch('the engine launch receipt does not match the handed role, model, effort or start prompt');
  const transcript = ownerTranscript(`codex:${handoff.session}`, hostHome);
  if (transcript.problem) return mismatch(transcript.problem);
  const bundleRecord = readRegular(handoff.bundle);
  let bundle; try { bundle = bundleRecord && JSON.parse(bundleRecord.bytes); } catch {}
  const { raw, entries } = codexEntries(transcript.file, { bundle });
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
