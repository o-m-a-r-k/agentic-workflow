// Claude Code as a host adapter: the one place the workflow learns what Claude Code is.
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { howToStart, verifyRole } from './claude-agent.mjs';
import { LABEL, assistantTurns, childAgents, claudeUsage, claudeUsageOf, handoffFiles, readTranscript, sessionModel, subagentIndex, subagentModel, subagentTranscripts, transcriptFile } from './claude-store.mjs';
import { findSkill } from './claude-skills.mjs';
import { roleChangedSinceSessionStart } from './claude-stale.mjs';
import { markdownRole } from './role-files.mjs';
import { readLines } from './safe-file.mjs';
import { claudeChatAnswers, claudeQuestionAnswers } from './questions.mjs';
import { genericFileTargets, shellRunsOf, tailLines, textOf, toolOf } from './tool-calls.mjs';
import { lastModel } from './turns.mjs';

// The tracker's own answer as Claude Code recorded it: an assistant line holds `{ type: 'tool_use', id, name, input }`
// blocks and a user line the `{ type: 'tool_result', tool_use_id, content, is_error }` that answers one.
async function connectorCalls(file, tools) {
  const calls = new Map();
  await readLines(file, (line, n) => {
    if (!line.includes('mcp__') && !line.includes('tool_result')) return;
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      return;
    }
    const content = e?.message?.content;
    if (!Array.isArray(content)) return;
    for (const b of content) {
      if (b?.type === 'tool_use' && typeof b.name === 'string' && tools.includes(toolOf(b.name))) calls.set(b.id, { tool: toolOf(b.name), name: b.name, input: b.input ?? {}, calledAt: e.timestamp ?? null, line: n });
      else if (b?.type === 'tool_result' && calls.has(b.tool_use_id)) Object.assign(calls.get(b.tool_use_id), { result: textOf(b.content), error: b.is_error === true, at: e.timestamp ?? null, resultLine: n });
    }
  });
  return [...calls.values()];
}

// Tools each generated Claude role may use (the implementer gets every tool). Every tool a role's instructions name
// must be here. Named failure (0.3.3, a live round): the reviewer was told to write its closure with the Write tool,
// which its list lacked, so it could not record the closure and the round was lost. The reviewer's Write is for its
// closure file only: `wf review` refuses a closure when the worktree changed during the round.
// The strategist reads the attempt and writes one closure file (`wf strategy record` copies it into the evidence).
const ROLE_TOOLS = { planner: ['Read', 'Grep', 'Glob', 'Bash'], reviewer: ['Read', 'Grep', 'Glob', 'Bash', 'Write', 'Skill'], tester: ['Read', 'Grep', 'Glob', 'Bash'], strategist: ['Read', 'Grep', 'Glob', 'Bash', 'Write'] };

// A fresh role through `claude --print`: its stream-json events carry the session id (`system` `init`) and the end of the
// turn (`result`); the assistant's text reaches the owner as `assistant` events.
function buildLaunch(h, { body, requestedSession }) {
  const args = ['--print', '--verbose', '--output-format', 'stream-json', '--session-id', requestedSession, '--agent', h.agentType, '--agents', JSON.stringify({ [h.agentType]: { description: `Frozen workflow ${h.role}`, prompt: body, ...(ROLE_TOOLS[h.role] ? { tools: ROLE_TOOLS[h.role] } : {}) } }), '--permission-mode', 'dontAsk', '--allowedTools', ...(ROLE_TOOLS[h.role] ?? ['Read', 'Write', 'Edit', 'Grep', 'Glob']).filter((t) => t !== 'Bash'), 'Bash(wf *)'];
  if (h.model) args.push('--model', h.model);
  if (h.effort) args.push('--effort', h.effort);
  return { bin: 'claude', args };
}

// The classifier (engine/learning.mjs): one `claude --print` turn with no tools and no session kept, answering in text.
function classifyLaunch({ prompt, model, effort }) {
  const args = ['--print', '--output-format', 'json', '--tools', '', '--no-session-persistence', '--strict-mcp-config'];
  if (model) args.push('--model', model);
  if (effort) args.push('--effort', effort);
  return { bin: 'claude', args, input: prompt };
}
function classifyResult({ stdout }) {
  const j = JSON.parse(stdout);
  return { text: j.is_error ? '' : typeof j.result === 'string' ? j.result : '', costUsd: typeof j.total_cost_usd === 'number' ? j.total_cost_usd : null, model: Object.keys(j.modelUsage ?? {})[0] ?? null };
}

function interpretEvent(e) {
  if (e.type === 'system' && e.subtype === 'init') return { started: e.session_id };
  if (e.type === 'result') return { terminal: { session: e.session_id, success: e.subtype === 'success' && e.is_error === false } };
  if (e.type === 'turn.failed') return { failed: true };
  // An error event may be passing (a reconnect, a retried request): it fails the launch only if no turn completes after it.
  if (e.type === 'error') return { error: String(e.message ?? e.error?.message ?? e.error ?? 'error').slice(0, 300) };
  return {};
}

// Relay only completed assistant text, never reasoning, tools or terminal result payloads.
const roleReport = (event) => (event.type === 'assistant' && Array.isArray(event.message?.content) ? event.message.content.filter((block) => block.type === 'text' && typeof block.text === 'string').map((block) => block.text).join(' ') : null);

export default {
  id: 'claude',
  name: 'Claude',
  label: LABEL,
  spawnMode: 'owner-native',
  sessionEnv: ['CLAUDE_CODE_SESSION_ID', 'CLAUDECODE'],
  markerEnv: [],
  envPrefixes: ['CLAUDE_CODE_', 'CLAUDECODE', 'ANTHROPIC_'],
  // The strongest model for planning and review (a class that pins none inherits the owner session's), and an effort for
  // the implementer classes. Unmeasured starting points: a project's `classes` override them.
  classDefaults: { full: { effort: 'high' }, light: { effort: 'low' }, review: { model: 'opus', effort: 'high' }, planning: { model: 'fable', effort: 'high' } },
  // The planning panel's second seat (0.7.22): another model than the lead's, so the two plans differ in more than wording.
  panelSecond: 'review',
  // The classifier labels items with given choices and does no reasoning: the fast, cheap model. A project's
  // `learning.classifier.claude` overrides it.
  classifierDefaults: { model: 'haiku', effort: 'low' },
  agentsDir: '.claude/agents',
  skillsDir: '.claude/skills',
  fragments: {
    howToStart,
    // What the role instructions say about the tools this harness exposes.
    toolCompatibility: 'Claude Code reads text and images with Read, loads skills with Skill and writes the permitted files with Write; structured handoff JSON is inspected with `wf evidence inspect` (never one full-output dump) and text inside the selected attempt is read with `wf evidence show <path> --attempt <id>`. Read a required skill through its exact handed file when Skill is unavailable.',
    closureWriter: 'the Write tool',
    staleRole: (agentType) => `Claude Code reads agent files when a session starts, so an agent of type ${agentType} started from this session is started with the old instructions; its bundle points it at the current file, which it reads first, so no restart is needed for its instructions; a change to its tools (the \`tools:\` line) still needs this session restarted (\`claude --resume\` keeps the conversation).`,
    restartHint: '`claude --resume` keeps the conversation',
    pluginUpdate: 'claude plugin update agentic-workflow@agentic-workflow',
  },
  // The agent file `wf sync` writes for a role: markdown with a tool list (the implementer gets every tool).
  roleFile({ root, role, name, description, model, effort, body }) {
    return { file: path.join(root, '.claude', 'agents', `${name}.md`), content: markdownRole({ name, description, model, effort, tools: ROLE_TOOLS[role], body }) };
  },
  // The file targets of a file tool's payload (the guard keeps agents out of the evidence folder).
  fileTargets: (data) => (data?.tool_input && typeof data.tool_input === 'object' ? { targets: genericFileTargets(data.tool_input) } : null),
  findSkill,
  roleStale: roleChangedSinceSessionStart,
  sandbox: 'native-permissions',
  needsGitRoot: false,
  requestedSession: () => randomUUID(),
  buildLaunch,
  classifyLaunch,
  classifyResult,
  interpretEvent,
  roleReport,
  roleTools: ROLE_TOOLS,
  detect: (env) => (env.CLAUDE_CODE_SESSION_ID ? { session: env.CLAUDE_CODE_SESSION_ID } : null),

  // ---- Transcripts ----
  storeDir: (home) => path.join(home, '.claude', 'projects'),
  transcriptFile,
  connectorCalls,
  // The person's answers to the session's question panel (AskUserQuestion), as Claude Code recorded them.
  questionAnswers: claudeQuestionAnswers,
  chatAnswers: claudeChatAnswers,
  // Long tool results Claude Code keeps beside the session: ~/.claude/projects/<project>/<session>/tool-results/.
  isSavedToolResult: (file, { home }) => Boolean(home) && String(file).startsWith(path.join(home, '.claude', 'projects') + path.sep) && String(file).split(path.sep).includes('tool-results'),

  // ---- Roles ----
  verifyRole,
  // A role the owner started with the Agent tool: its last turns and model, found by the name it was started under.
  roleOutput(handoff, { home, check }) {
    let found = subagentTranscripts(home, handoff.agent, handoff.agentType ?? null, handoff.at ?? null);
    // A planner started without a name, identified by its start line (verifyRole, I-14).
    if (!found.length && check.status === 'verified' && check.identity === 'unnamed') found = [{ file: check.transcript, agentType: handoff.agentType ?? null }];
    if (!found.length) return { problem: `no ${LABEL} subagent transcript named \`${handoff.agent}\`${handoff.agentType ? ` (agent type ${handoff.agentType})` : ''} written after its handoff under ${path.join(home, '.claude', 'projects')}` };
    const raw = readTranscript(found[0].file);
    const entries = assistantTurns(raw);
    return { entries, model: lastModel(entries), agentType: found[0].agentType, file: found[0].file };
  },
  // The shell commands a role's transcript shows: Bash tool calls answered by their tool results.
  shellRuns: (file) => shellRunsOf(tailLines(file), {
    call: (e) => (Array.isArray(e.message?.content) ? e.message.content.filter((x) => x?.type === 'tool_use' && x.name === 'Bash').map((x) => ({ id: x.id, command: x.input?.command })) : []),
    result: (e) => (Array.isArray(e.message?.content) ? e.message.content.filter((x) => x?.type === 'tool_result').map((x) => x.tool_use_id) : []),
  }),
  // When the role was last active: the sub-agent file Claude Code wrote under the name the owner started it with.
  roleActivity(handoff, { home }) {
    const t = subagentTranscripts(home, handoff.agent, handoff.agentType ?? null, handoff.at)[0];
    return t ? { file: t.file, mtime: t.mtime } : null;
  },
  // The model a role ran on, and the model the owner's own session runs on (what an unpinned role inherits).
  roleModel: (handoff, { home }) => subagentModel(home, handoff.agent, handoff.agentType, handoff.at),
  ownerModel: (session, { home }) => sessionModel(home, session),
  // The sub-agents a role started, at any depth.
  children: (handoff, { home }) => childAgents(home, handoff.agent, handoff.agentType, handoff.at),
  // ---- Usage ----
  // Tokens, models and time a session spent; a role the owner started has no session id of its own, so its sub-agent
  // files (found by name and agent type, since the attempt began) stand in.
  // The agentic-workflow plugin version the harness has installed (its hooks and skills), or null when it cannot tell.
  // Named failure (final review of 0.7.0): the installed plugin was 0.6.3 while the CLI was 0.6.6, so sessions ran an older
  // guard hook and work skill against a newer engine.
  installedPluginVersion: (home) => {
    try {
      const d = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'plugins', 'installed_plugins.json'), 'utf8'));
      const rows = Object.entries(d.plugins ?? d).filter(([k]) => k.startsWith('agentic-workflow@')).flatMap(([, v]) => (Array.isArray(v) ? v : [v]));
      return rows.map((r) => r?.version).filter((v) => typeof v === 'string').sort().at(-1) ?? null;
    } catch {
      return null;
    }
  },
  usage: (session, home) => claudeUsage(session, home),
  agentIndex: (home) => subagentIndex(home),
  usageByName(handoff, { index, since }) {
    const files = handoffFiles(handoff, index, since);
    if (!files.length) return null;
    const usage = claudeUsageOf(files.map((x) => x.file));
    usage.agentType = files[0].agentType;
    return { usage, agentIds: files.map((x) => x.agentId) };
  },
  agentUsage: (agent) => claudeUsageOf([agent.file]),
  // The last thing a role said, for attempts that predate the structured implementer report.
  finalReport(handoff, { home }) {
    let found = [];
    try {
      found = subagentTranscripts(home, handoff.agent, handoff.agentType ?? null, handoff.at);
    } catch {}
    if (!found.length) return null;
    const turns = assistantTurns(readTranscript(found[0].file));
    for (let i = turns.length - 1; i >= 0; i--) {
      const text = turns[i].texts.join('\n');
      if (text.trim()) return { text, at: turns[i].at };
    }
    return { text: '', at: null };
  },
};
