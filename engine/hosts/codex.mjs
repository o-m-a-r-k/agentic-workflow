// Codex as a host adapter: the one place the workflow learns what Codex is.
import path from 'node:path';
import { verifyRole } from './codex-agent.mjs';
import { patchTargets, wrappedConnectorCall, wrappedConnectorResult } from './codex-tool.mjs';
import { findSkill } from './codex-skills.mjs';
import { codexTranscript } from './codex-transcript.mjs';
import { codexUsage } from './codex-usage.mjs';
import { tomlRole } from './role-files.mjs';
import { readLines } from './safe-file.mjs';
import { codexQuestionAnswers } from './questions.mjs';
import { parseArgs, textOf, toolOf } from './tool-calls.mjs';

const LABEL = 'Codex';

// Named failure I-40: the native Codex connector adds linear_ to tools the adapter registers without that prefix.
const registeredTool = (full, tools) => {
  const tool = toolOf(full);
  return tools.includes(tool) ? tool : tool?.startsWith('linear_') && tools.includes(tool.slice(7)) ? tool.slice(7) : null;
};

// The tracker's own answer as Codex recorded it: `response_item` lines with `payload.type` `function_call`
// (`namespace`, `name`, `arguments` JSON text, `call_id`) answered by `function_call_output` (`call_id`, `output`), or a
// single literal connector call wrapped in `exec` (`custom_tool_call` and its output).
async function connectorCalls(file, tools) {
  const calls = new Map();
  await readLines(file, (line, n) => {
    if (!line.includes('mcp__') && !line.includes('function_call_output') && !line.includes('custom_tool_call_output')) return;
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      return;
    }
    const p = e?.payload;
    if (e?.type !== 'response_item' || !p) return;
    if (p.type === 'function_call') {
      const ns = String(p.namespace ?? '');
      const full = ns ? (ns.endsWith('__') ? `${ns}${p.name}` : `${ns}__${p.name}`) : String(p.name ?? '');
      const tool = registeredTool(full, tools);
      if (tool) calls.set(p.call_id, { tool, name: full, input: parseArgs(p.arguments), calledAt: e.timestamp ?? null, line: n });
    } else if (p.type === 'function_call_output' && calls.has(p.call_id)) Object.assign(calls.get(p.call_id), { result: textOf(p.output), error: false, at: e.timestamp ?? null, resultLine: n });
    else if (p.type === 'custom_tool_call') {
      const call = wrappedConnectorCall(p);
      const tool = call && registeredTool(call.name, tools);
      if (tool) calls.set(p.call_id, { ...call, tool, wrapped: true, calledAt: e.timestamp ?? null, line: n });
    } else if (p.type === 'custom_tool_call_output' && calls.get(p.call_id)?.wrapped) {
      const result = wrappedConnectorResult(p.output);
      if (result) Object.assign(calls.get(p.call_id), { ...result, at: e.timestamp ?? null, resultLine: n });
    }
  });
  return [...calls.values()];
}

// A fresh role through `codex exec --json`: `thread.started` carries the session id, `turn.completed` the end of the turn,
// and completed `agent_message` items the assistant's text.
function buildLaunch(h, { root, body, nonGitRoot }) {
  const args = ['exec', '--json', '--cd', root, '--sandbox', 'workspace-write', '-c', `developer_instructions=${JSON.stringify(body)}`];
  if (nonGitRoot) args.push('--skip-git-repo-check');
  if (h.model) args.push('--model', h.model);
  if (h.effort) args.push('-c', `model_reasoning_effort=${JSON.stringify(h.effort)}`);
  args.push('-');
  return { bin: 'codex', args };
}

function interpretEvent(e) {
  if (e.type === 'thread.started') return { started: e.thread_id };
  if (e.type === 'turn.completed') return { terminal: { success: true } };
  if (e.type === 'turn.failed' || e.type === 'error') return { failed: true };
  return {};
}

const roleReport = (event) => (event.type === 'item.completed' && event.item?.type === 'agent_message' ? event.item.text : null);

// Named failure I-47: a parent sandbox can block host initialization before any native session starts.
// Diagnose only the observed permission signature; never change or retry the child's sandbox here.
function diagnoseLaunch({ stderr }) {
  const m = /failed to initialize in-process app-server client:\s*(Operation not permitted|Permission denied)(?: \(os error \d+\))?/.exec(stderr);
  return m ? { kind: 'host-initialization-permission', detail: m[0], advice: 'Native Codex host initialization was denied before a session started. Create a fresh handoff, then use approved host execution with access to the native runtime and session store. Retain the child sandbox (workspace-write); do not bypass a rejected approval or reuse this failed handoff.' } : null;
}

export default {
  id: 'codex',
  name: 'Codex',
  label: LABEL,
  spawnMode: 'engine-only',
  sessionEnv: ['CODEX_THREAD_ID'],
  markerEnv: ['CODEX_SANDBOX'],
  envPrefixes: ['CODEX_', 'OPENAI_'],
  // Codex takes the model and effort its own configuration names unless a project's `classes` pin them.
  classDefaults: {},
  agentsDir: '.codex/agents',
  skillsDir: '.agents/skills',
  fragments: {
    toolCompatibility: 'Codex inspects structured handoff JSON with `wf evidence inspect` (never one full-output dump), reads text inside the selected attempt with `wf evidence show <path> --attempt <id>` (or its supported full-file Node reader when available) and views exported image copies with `view_image`. Read a required skill through its exact handed file.',
    closureWriter: 'Node `fs.writeFile` or `apply_patch`',
  },
  // Codex loads custom agents from TOML files in .codex/agents/.
  roleFile({ root, name, description, model, effort, body }) {
    return { file: path.join(root, '.codex', 'agents', `${name}.toml`), content: tomlRole({ name, description, model, effort, body }) };
  },
  // Codex sends native file patches in tool_input.command, with tool_name apply_patch (named failure I-43): only that
  // file-edit protocol is parsed; a shell command is never read as a patch.
  fileTargets(data) {
    if (data?.tool_name !== 'apply_patch' || !data.tool_input || typeof data.tool_input !== 'object') return null;
    try { return { targets: patchTargets(data.tool_input.command), fileEdit: true }; } catch { return { malformed: true }; }
  },
  findSkill,
  sandbox: 'workspace-write',
  // Codex refuses to start outside a Git repository unless told to; a registered multi-repo project has no parent repo
  // (named failure I-46), so the launcher checks every recorded worktree itself first.
  needsGitRoot: true,
  buildLaunch,
  interpretEvent,
  roleReport,
  diagnoseLaunch,
  detect: (env) => (env.CODEX_THREAD_ID ? { session: env.CODEX_THREAD_ID } : null),

  // ---- Transcripts ----
  storeDir: (home) => path.join(home, '.codex'),
  transcriptFile: (session, options) => codexTranscript(session, { ...options, label: LABEL }),
  connectorCalls,
  // The person's answers to the session's question panel (request_user_input), bound to the call each names.
  questionAnswers: codexQuestionAnswers,

  // ---- Roles ----
  verifyRole,
  usage: (session, home) => codexUsage(session, home),
};
