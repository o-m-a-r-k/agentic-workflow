// The person's answers to questions a session asked through its harness's question panel, as the harness recorded them
// (0.7.3). Data only: each answered question with its text, the options it offered and the answer the person chose or
// typed. What an answer may confirm is the engine's decision (engine/approve.mjs), never an adapter's.
//
// Named failure (0.7.3): `wf approve` needed the person's own terminal, so a person working from the phone (the harness's
// remote control) could confirm nothing: an attempt whose owner session had locked itself in the evidence folder could
// not be adopted, and the ticket stopped. The question panel is where the person already answers the agent; the harness,
// not the agent, writes the answer down.
import { readLines } from './safe-file.mjs';
import { parseArgs } from './tool-calls.mjs';

const record = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const labels = (options) => (Array.isArray(options) ? options.map((o) => (typeof o === 'string' ? o : record(o) && typeof o.label === 'string' ? o.label : null)).filter((l) => typeof l === 'string') : null);

// Claude Code: the assistant line holds `{ type: 'tool_use', name: 'AskUserQuestion', id, input: { questions: [{ question,
// options: [{ label }] }] } }`; the main session's next user line holds the `tool_result` for that id and, beside it,
// `toolUseResult.answers`, an object from each question's text to the chosen label (or the person's typed text). The
// prose of the tool result is never read. Sub-agent (sidechain) lines are skipped: only the session's own panel counts.
export async function claudeQuestionAnswers(file) {
  const asked = new Map();
  const out = [];
  await readLines(file, (line) => {
    if (!line.includes('AskUserQuestion') && !line.includes('toolUseResult')) return;
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      return;
    }
    if (e?.isSidechain) return;
    const content = e?.message?.content;
    if (!Array.isArray(content)) return;
    for (const b of content) {
      if (b?.type === 'tool_use' && b.name === 'AskUserQuestion' && typeof b.id === 'string' && Array.isArray(b.input?.questions)) {
        asked.set(b.id, { at: e.timestamp ?? null, questions: b.input.questions.filter((q) => record(q) && typeof q.question === 'string').map((q) => ({ text: q.question, options: labels(q.options) })) });
      } else if (b?.type === 'tool_result' && asked.has(b.tool_use_id) && e.type === 'user' && record(e.toolUseResult?.answers)) {
        const call = asked.get(b.tool_use_id);
        asked.delete(b.tool_use_id);
        for (const q of call.questions) {
          const answer = e.toolUseResult.answers[q.text];
          if (typeof answer === 'string' && answer.trim()) out.push({ askedAt: call.at, at: e.timestamp ?? null, question: q.text, options: q.options, answer: answer.trim() });
        }
      }
    }
  });
  return out;
}

// Codex: a `response_item` `function_call` to `request_user_input` (or `_async`, whose questions carry `title`) with a
// `call_id`, answered by a later user message that is exactly `<send_user_message_question_reply>[...]</...>`, each row
// naming its question by `questionItemId` `[tool, callId, index]` and repeating its text. A reply is bound to the call
// it names, after it, once; reused call ids, malformed rows and replies in a non-interactive session (`codex exec`) count
// for nothing. This binding was field-proven in 0.6.x (I-67, I-93) for the scope question.
const CODEX_TOOLS = new Set(['request_user_input_async', 'request_user_input']);
const codexTool = (x) => (typeof x === 'string' ? x.replace(/^functions\./, '') : '');
export async function codexQuestionAnswers(file) {
  let metaSeen = false;
  let interactive = false;
  const calls = new Map();
  const answered = new Set();
  const out = [];
  await readLines(file, (line) => {
    if (!line.includes('session_meta') && !line.includes('request_user_input') && !line.includes('send_user_message_question_reply')) return;
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      return;
    }
    if (e?.type === 'session_meta') {
      interactive = !metaSeen && ['cli', 'vscode'].includes(e.payload?.source) && e.payload?.originator !== 'codex_exec' && !e.payload?.parent_thread_id;
      metaSeen = true;
      return;
    }
    const p = e?.payload;
    if (e?.type !== 'response_item' || !p) return;
    if (p.type === 'function_call' && CODEX_TOOLS.has(codexTool(p.name)) && typeof p.call_id === 'string' && p.call_id) {
      if (calls.has(p.call_id)) return void calls.set(p.call_id, null);
      const tool = codexTool(p.name);
      const field = tool === 'request_user_input_async' ? 'title' : 'question';
      const questions = parseArgs(p.arguments)?.questions;
      if (!Array.isArray(questions) || !questions.length || questions.some((q) => !record(q) || typeof q[field] !== 'string' || !q[field].trim())) return void calls.set(p.call_id, null);
      calls.set(p.call_id, { tool, at: e.timestamp ?? null, questions: questions.map((q) => ({ text: q[field], options: labels(q.options) })) });
      return;
    }
    if (!interactive || p.type !== 'message' || p.role !== 'user' || !Array.isArray(p.content) || !p.content.every((b) => b?.type === 'input_text')) return;
    const text = p.content.map((b) => b.text ?? '').join('\n');
    const m = /^\s*<send_user_message_question_reply>\s*([\s\S]*?)\s*<\/send_user_message_question_reply>\s*$/.exec(text);
    if (!m) return;
    let rows;
    try {
      rows = JSON.parse(m[1]);
    } catch {
      return;
    }
    if (!Array.isArray(rows) || !rows.length) return;
    const found = [];
    const seen = new Set();
    for (const row of rows) {
      if (!record(row) || typeof row.questionItemId !== 'string' || typeof row.question !== 'string' || typeof row.answer !== 'string' || !row.answer.trim()) return;
      let item;
      try {
        item = JSON.parse(row.questionItemId);
      } catch {
        return;
      }
      if (!Array.isArray(item) || item.length !== 3) return;
      const [tool, callId, index] = item;
      const call = calls.get(callId);
      if (!CODEX_TOOLS.has(tool) || !call || call.tool !== tool || !Number.isSafeInteger(index) || index < 0 || index >= call.questions.length || row.question !== call.questions[index].text) return;
      if (!Number.isFinite(Date.parse(e.timestamp)) || !Number.isFinite(Date.parse(call.at)) || Date.parse(call.at) > Date.parse(e.timestamp)) return;
      const key = JSON.stringify(item);
      if (seen.has(key) || answered.has(key)) return;
      seen.add(key);
      found.push({ askedAt: call.at, at: e.timestamp, question: call.questions[index].text, options: call.questions[index].options, answer: row.answer.trim() });
    }
    for (const key of seen) answered.add(key);
    out.push(...found);
  });
  return out;
}

// The person's reply in the chat, bound to the message it answers (0.7.18). Each entry pairs a reply the person typed with the
// agent's message just before it, as the harness recorded both: the text the agent wrote after its last tool call (its final
// reply; commentary between tool calls is not the message the person answers), plus any question it put in the harness's
// question panel since then. Every turn of the person's, a reply or not (a panel answer, a slash command), ends the message;
// what the harness writes (task notices, reminders, interrupt markers, compaction summaries, context) is not the person and
// is skipped. What a reply may confirm is the engine's decision (engine/approve.mjs): only a message that carries one
// decision's exact question binds a reply to it.
//
// Named failure (0.7.18): a person working from the phone did not get the harness's question panel (and one host's default
// mode tells its agent never to use the panel for approvals). They answered "Yes" in the chat twice; the engine read only the
// panel and their own terminal, so the decision stayed open, the agent merged around the workflow on their "override it", and
// closing the ticket then needed one more answer they had no way to give.
const CLAUDE_HARNESS = /^<(task-notification|system-reminder|local-command-stdout|local-command-stderr|local-command-caveat|command-message|user-prompt-submit-hook)\b|^\[Request interrupted by user/;
// What the person typed in one Claude Code user line: { reply } when they typed text, { turn: true } when they acted without
// replying (a slash command, a shell line, a paste alone), null when the harness wrote it.
function claudePerson(e) {
  if (e?.type !== 'user' || e.isMeta || e.isCompactSummary || e.isSidechain) return null;
  const c = e.message?.content;
  if (Array.isArray(c) && c.some((b) => b?.type === 'tool_result')) return null;
  const blocks = typeof c === 'string' ? [c] : Array.isArray(c) ? c.filter((b) => b?.type === 'text' && typeof b.text === 'string').map((b) => b.text) : [];
  const kept = blocks.map((b) => b.trim()).filter((b) => b && !CLAUDE_HARNESS.test(b));
  if (!kept.length) return Array.isArray(c) && c.some((b) => b?.type === 'image') ? { turn: true } : null;
  let text = kept.join('\n').replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').replace(/<pasted_content\b[^>]*>[\s\S]*?<\/pasted_content>/g, '').trim();
  // A reply to a quoted message: the quote (lines starting with ">"), then what they typed.
  const quote = /^<!--\s*reply\s+\d+\s*-->[ \t]*\n(?:>.*(?:\n|$))*/.exec(text);
  if (quote) text = text.slice(quote[0].length).trim();
  if (!text || /^</.test(text)) return { turn: true };
  return { reply: text };
}
// A message the person typed while the agent was working: Claude Code queues it and records it as an `attachment` line
// (`queued_command`, origin human), not as a user line (0.7.27, I-192). Their words, in the middle of a turn.
function claudeQueued(e) {
  const a = e?.attachment;
  if (a?.type !== 'queued_command' || a.origin?.kind !== 'human' || (a.commandMode ?? 'prompt') !== 'prompt' || typeof a.prompt !== 'string') return null;
  const text = a.prompt.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim();
  return text && !/^</.test(text) ? { reply: text } : null;
}
const QUESTION_TOOLS = new Set(['AskUserQuestion', 'request_user_input', 'request_user_input_async']);
export async function claudeChatAnswers(file) {
  const out = [];
  let said = [];
  let saidAt = null;
  let panels = [];
  const asked = new Set();
  await readLines(file, (line) => {
    if (!line.includes('"assistant"') && !line.includes('"user"') && !line.includes('queued_command')) return;
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      return;
    }
    if (e?.isSidechain) return;
    const content = e?.message?.content;
    if (e?.type === 'assistant' && Array.isArray(content)) {
      for (const b of content) {
        if (b?.type === 'text' && typeof b.text === 'string' && b.text.trim()) said.push(b.text);
        else if (b?.type === 'tool_use' && b.name === 'AskUserQuestion' && Array.isArray(b.input?.questions)) {
          const qs = b.input.questions.filter((q) => record(q) && typeof q.question === 'string');
          said.push(...qs.map((q) => q.question));
          panels.push(...qs.map((q) => ({ text: q.question, options: labels(q.options) })));
          if (typeof b.id === 'string') asked.add(b.id);
        } else if (b?.type === 'tool_use') {
          said = [];
          panels = [];
        }
      }
      saidAt = e.timestamp ?? saidAt;
      return;
    }
    // The person's answer in the panel is their turn too (independent review of 0.7.18): it ends the message. A panel they
    // dismissed (a result with no answers) leaves the question standing, so what they type next answers it.
    const panelAnswer = e?.type === 'user' && !e.isSidechain && Array.isArray(content) && record(e.toolUseResult?.answers) && content.some((b) => b?.type === 'tool_result' && asked.has(b.tool_use_id));
    const person = panelAnswer ? { turn: true } : e?.type === 'attachment' ? claudeQueued(e) : claudePerson(e);
    if (!person) return;
    // 0.7.27 (I-192): every reply is the person's words, also one after no message of the agent's (`question` is then empty and
    // binds nothing by itself; engine/approve.mjs reads such a reply only for the decision's own terms).
    if (person.reply) out.push({ askedAt: said.length ? saidAt : null, at: e.timestamp ?? null, question: said.join('\n'), panels, options: null, answer: person.reply, channel: 'chat' });
    said = [];
    saidAt = null;
    panels = [];
  });
  return out;
}

// Codex: the agent's `message` items (role assistant, `output_text`) after its last tool call, plus its question-panel calls;
// the person's `message` (role user) ends it. Harness context (AGENTS.md, environment, plugin notes, by the item kinds the
// harness records or a context tag) is not the person; a panel reply or another tagged line is their turn but not a reply.
// 0.7.27 (I-192), named failure (field): Codex Desktop adds, before the person's first message of a day, a user item recording
// the page open beside the chat (`<external_codex_apps_open_page>`, kind `additional_content.codex_apps_open_page`); it was
// read as a turn of the person's, so it ended the message that had asked the question the day before, and their reply to it
// bound to nothing. What the harness adds (`additional_content.*`) is not the person.
const CODEX_WRAPPERS = ['plugins.recommendations', 'agents_md.instructions', 'environments.environment_context'];
const CODEX_HARNESS = /^<(environment_context|user_instructions|permissions|turn_aborted|user_shell_command|external_codex_apps_[a-z_]+|codex_apps_[a-z_]+)\b|^# AGENTS\.md instructions/;
const codexWrapper = (k) => CODEX_WRAPPERS.includes(k) || String(k).startsWith('additional_content.');
function codexPerson(p) {
  const kinds = p.internal_chat_message_metadata_passthrough?.content_item_kinds;
  if (Array.isArray(kinds) && kinds.length && kinds.every(codexWrapper)) return null;
  const blocks = p.content.filter((b) => b?.type === 'input_text' && typeof b.text === 'string').map((b) => b.text.trim()).filter(Boolean);
  if (!blocks.length) return p.content.some((b) => b?.type === 'input_image') ? { turn: true } : null;
  if (blocks.every((b) => CODEX_HARNESS.test(b))) return null;
  const text = blocks.filter((b) => !CODEX_HARNESS.test(b)).join('\n').trim();
  return !text || /^</.test(text) ? { turn: true } : { reply: text };
}
const CODEX_CALLS = new Set(['function_call', 'custom_tool_call', 'local_shell_call', 'web_search_call', 'tool_search_call']);
export async function codexChatAnswers(file) {
  const out = [];
  let said = [];
  let saidAt = null;
  let panels = [];
  let metaSeen = false;
  let interactive = false;
  await readLines(file, (line) => {
    if (!line.includes('session_meta') && !line.includes('response_item')) return;
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      return;
    }
    if (e?.type === 'session_meta') {
      // The person's own session only: not `codex exec`, not a sub-agent's thread (whose "user" is its parent agent).
      interactive = !metaSeen && ['cli', 'vscode'].includes(e.payload?.source) && e.payload?.originator !== 'codex_exec' && !e.payload?.parent_thread_id;
      metaSeen = true;
      return;
    }
    const p = e?.payload;
    if (!interactive || e?.type !== 'response_item' || !p) return;
    if (CODEX_CALLS.has(p.type)) {
      const tool = codexTool(p.name);
      if (QUESTION_TOOLS.has(tool)) {
        const field = tool === 'request_user_input_async' ? 'title' : 'question';
        const questions = parseArgs(p.arguments)?.questions;
        if (Array.isArray(questions)) {
          const qs = questions.filter((q) => record(q) && typeof q[field] === 'string');
          said.push(...qs.map((q) => q[field]));
          panels.push(...qs.map((q) => ({ text: q[field], options: labels(q.options) })));
        }
      } else {
        said = [];
        panels = [];
      }
      return;
    }
    if (p.type !== 'message' || !Array.isArray(p.content)) return;
    if (p.role === 'assistant') {
      for (const b of p.content) if (b?.type === 'output_text' && typeof b.text === 'string' && b.text.trim()) said.push(b.text);
      saidAt = e.timestamp ?? saidAt;
      return;
    }
    if (p.role !== 'user') return;
    const person = codexPerson(p);
    if (!person) return;
    if (person.reply) out.push({ askedAt: said.length ? saidAt : null, at: e.timestamp ?? null, question: said.join('\n'), panels, options: null, answer: person.reply, channel: 'chat' });
    said = [];
    saidAt = null;
    panels = [];
  });
  return out;
}
