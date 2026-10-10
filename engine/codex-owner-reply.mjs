// Named failure: a person's answer from the desktop question UI was rejected as
// injected markup. Bind that host envelope to its actual earlier question call;
// only the submitted answer is owner text, never the question or its defaults.
const TOOLS = new Set(['request_user_input_async', 'request_user_input']);
const record = x => x !== null && typeof x === 'object' && !Array.isArray(x);
const toolName = x => typeof x === 'string' ? x.replace(/^functions\./, '') : '';

export function codexOwnerReplies() {
  let metaSeen = false;
  let interactive = false;
  const calls = new Map();
  const answered = new Set();
  return {
    observe(e) {
      if (e?.type === 'session_meta') {
        interactive = !metaSeen && ['cli', 'vscode'].includes(e.payload?.source)
          && e.payload?.originator !== 'codex_exec';
        metaSeen = true;
        return;
      }
      const p = e?.payload;
      if (e?.type !== 'response_item' || p?.type !== 'function_call' || !TOOLS.has(toolName(p.name)) || typeof p.call_id !== 'string' || !p.call_id) return;
      // Reused call IDs are ambiguous, even when both calls look identical.
      if (calls.has(p.call_id)) { calls.set(p.call_id, null); return; }
      let args;
      try { args = JSON.parse(p.arguments); } catch { calls.set(p.call_id, null); return; }
      const tool = toolName(p.name);
      const field = tool === 'request_user_input_async' ? 'title' : 'question';
      const questions = args?.questions;
      if (!Array.isArray(questions) || !questions.length || questions.some(q => !record(q) || typeof q[field] !== 'string' || !q[field].trim())) {
        calls.set(p.call_id, null);
        return;
      }
      calls.set(p.call_id, { tool, questions: questions.map(q => q[field]), at: e.timestamp });
    },
    answers(text, at) {
      if (!interactive || typeof text !== 'string') return null;
      const match = /^\s*<send_user_message_question_reply>\s*([\s\S]*?)\s*<\/send_user_message_question_reply>\s*$/.exec(text);
      if (!match) return null;
      let rows;
      try { rows = JSON.parse(match[1]); } catch { return null; }
      if (!Array.isArray(rows) || !rows.length) return null;
      const result = [], seen = new Set();
      for (const row of rows) {
        if (!record(row) || typeof row.questionItemId !== 'string' || typeof row.question !== 'string' || typeof row.answer !== 'string' || !row.answer.trim()) return null;
        let item;
        try { item = JSON.parse(row.questionItemId); } catch { return null; }
        if (!Array.isArray(item) || item.length !== 3) return null;
        const [tool, callId, index] = item;
        const call = calls.get(callId);
        if (!TOOLS.has(tool) || !call || call.tool !== tool || !Number.isSafeInteger(index) || index < 0 || index >= call.questions.length || row.question !== call.questions[index]) return null;
        // A malformed or out-of-order host timestamp does not establish a reply.
        if (!Number.isFinite(Date.parse(at)) || !Number.isFinite(Date.parse(call.at)) || Date.parse(call.at) > Date.parse(at)) return null;
        const key = JSON.stringify(item);
        if (seen.has(key) || answered.has(key)) return null;
        seen.add(key);
        result.push({ text: row.answer.trim(), questionReply: { tool, callId, index } });
      }
      for (const key of seen) answered.add(key);
      return result;
    },
  };
}
