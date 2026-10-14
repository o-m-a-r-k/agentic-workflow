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
      interactive = !metaSeen && ['cli', 'vscode'].includes(e.payload?.source) && e.payload?.originator !== 'codex_exec';
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
