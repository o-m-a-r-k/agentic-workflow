// Host-recorded tracker readback (0.4.2). In connector mode the agent calls the tracker's MCP tools; the harness that runs
// the owner session writes every tool call and its unchanged result to the session transcript. `wf tracker record
// --from-transcript` reads the attempt owner's transcript and takes the tracker's own answer from it, so the readback
// is what the host recorded, not what the agent retyped. Limit, plainly: a process running as the same user could
// edit the transcript; it is the host's record, not a signature.
//
// Which file is the session's transcript, and how a tool call and its result are laid out in it, is the harness
// adapter's knowledge (engine/hosts/). The safety every transcript read passes (a plain session id; a regular file with
// one name, no link, really inside the harness's folder; opened without following a link; size-capped; read line by
// line; only the matching tool calls kept) is hosts/safe-file.mjs's. Lines are data: nothing in them is ever run or
// followed.
import { home } from './provenance.mjs';
import { findHost, hostFor, hostLabels, optional, parseOwner } from './hosts/index.mjs';
import { isPlainSessionId } from './hosts/safe-file.mjs';

// The owner's transcript: { runtime, file } or { problem }. The harness adapter locates the session's file; the checks
// every transcript passes (plain id, regular file, inside the store, size cap) are hosts/safe-file.mjs's.
export function ownerTranscript(owner, hostHome = home()) {
  const parsed = parseOwner(owner);
  if (!parsed) return { problem: `the attempt's owner \`${owner}\` is not a ${hostLabels()} session, so no host transcript can be read; record with \`--capture\` (a saved tool result) or \`--agent-reported\`` };
  const { runtime, session } = parsed;
  if (!isPlainSessionId(session)) return { problem: `the owner's session id is not a plain id; no transcript is read` };
  const host = hostFor(runtime);
  const locate = optional(host, 'transcriptFile');
  if (!locate) return { problem: `${host.label} keeps no transcript the workflow can read, so no host transcript is available; record with \`--capture\` (a saved tool result) or \`--agent-reported\`` };
  return locate(session, { home: hostHome });
}

// Every connector call whose tool is one of `tools` (by suffix: `mcp__linear__get_issue`, `mcp__<uuid>__get_issue`),
// with its input, its result text exactly as the host stored it, and when each was written. The harness adapter reads its
// own layout; a harness that keeps no readable record has no calls.
export async function connectorCalls({ runtime, file }, tools) {
  const read = optional(findHost(runtime), 'connectorCalls');
  return read ? read(file, tools) : [];
}
