// Stream 4 scenario helpers: a file ledger standing in for stream 5, and a Codex rollout builder beside the shared Claude
// Code transcript fixture (scenarios/helpers/transcripts.mjs).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { canonicalJson, ledgerFile } from '../engine/contract.mjs';

// append / readEvents / listAttempts over `<root>/.wf-evidence/attempts/<id>/ledger.jsonl`, schema 2 entries, hash-chained
// as stream 5's ledger is: a read refuses a line whose `prev` or `hash` does not follow.
const hashOf = (e) => {
  const { hash, ...rest } = e;
  return crypto.createHash('sha256').update(canonicalJson(rest)).digest('hex');
};
export function fileLedger() {
  const read = (root, attempt) => {
    const f = ledgerFile(root, attempt);
    if (!fs.existsSync(f)) throw new Error(`unknown attempt ${attempt}`);
    let prev = null;
    return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l, i) => {
      const e = JSON.parse(l);
      if (e.prev !== prev || e.hash !== hashOf(e)) throw new Error(`${f}: hash chain broken at entry ${i + 1}`);
      prev = e.hash;
      return e;
    });
  };
  return {
    append: async (root, attempt, type, data, actor) => {
      const f = ledgerFile(root, attempt);
      fs.mkdirSync(path.dirname(f), { recursive: true });
      const before = fs.existsSync(f) ? read(root, attempt) : [];
      if (!before.length && type !== 'attempt.started') throw new Error(`${attempt}: the first event must be attempt.started`);
      const e = { seq: before.length + 1, at: new Date().toISOString(), type, actor: actor ?? null, data: JSON.parse(JSON.stringify(data)), prev: before.at(-1)?.hash ?? null, schema: 2 };
      e.hash = hashOf(e);
      fs.appendFileSync(f, `${JSON.stringify(e)}\n`);
      return e;
    },
    readEvents: async (root, attempt) => read(root, attempt),
    listAttempts: async (root) => {
      const dir = path.join(root, '.wf-evidence', 'attempts');
      return fs.existsSync(dir) ? fs.readdirSync(dir).sort() : [];
    },
  };
}

export async function startAttempt(ledger, root, attempt, item = attempt.split('.')[0]) {
  await ledger.append(root, attempt, 'attempt.started', { item, n: 1, repos: {}, stages: [], adapter: 'fixture', engine: '0.8.0' }, null);
}

// A Codex rollout at `<home>/.codex/sessions/YYYY/MM/DD/rollout-<time>-<id>.jsonl`.
export function codexRollout({ home, cwd, id = crypto.randomUUID(), start = new Date().toISOString(), source = 'cli', originator = 'codex_cli_rs', model = 'fixture-codex' }) {
  let clock = Date.parse(start);
  let calls = 0;
  const lines = [];
  const at = () => new Date(clock).toISOString();
  const item = (payload) => lines.push({ timestamp: at(), type: 'response_item', payload });
  lines.push({ timestamp: at(), type: 'session_meta', payload: { id, cwd, source, originator } });
  lines.push({ timestamp: at(), type: 'turn_context', payload: { cwd, model } });
  item({ type: 'message', role: 'user', internal_chat_message_metadata_passthrough: { content_item_kinds: ['agents_md.instructions', 'environments.environment_context'] }, content: [{ type: 'input_text', text: '# AGENTS.md instructions fixture' }, { type: 'input_text', text: '<environment_context>fixture</environment_context>' }] });
  const b = {
    session: { runtime: 'codex', id },
    advance(min) { clock += min * 60000; return b; },
    human(text) { item({ type: 'message', role: 'user', content: [{ type: 'input_text', text }] }); return b; },
    say(text) { item({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }); return b; },
    shell(cmd, output = 'ok', workdir) { const c = `call_${++calls}`; item({ type: 'function_call', name: 'exec_command', arguments: JSON.stringify({ cmd, ...(workdir ? { workdir } : {}) }), call_id: c }); item({ type: 'function_call_output', call_id: c, output }); return b; },
    script(cmd, output = 'ok') { const c = `call_${++calls}`; item({ type: 'custom_tool_call', name: 'exec', call_id: c, input: `const r = await tools.exec_command({ cmd: ${JSON.stringify(cmd)} });\ntext(r);` }); item({ type: 'custom_tool_call_output', call_id: c, output }); return b; },
    connector(full, args, result) { const c = `call_${++calls}`; const [ns, name] = [full.slice(0, full.lastIndexOf('__') + 2), full.slice(full.lastIndexOf('__') + 2)]; item({ type: 'function_call', namespace: ns, name, arguments: JSON.stringify(args), call_id: c }); item({ type: 'function_call_output', call_id: c, output: result }); return b; },
    wrapped(full, args, result) { const c = `call_${++calls}`; item({ type: 'custom_tool_call', name: 'exec', call_id: c, input: `text(await tools.${full}(${JSON.stringify(args)}))` }); item({ type: 'custom_tool_call_output', call_id: c, output: [{ type: 'input_text', text: 'Script completed\nWall time 0.1 seconds\nOutput:\n' }, { type: 'input_text', text: JSON.stringify({ content: [{ type: 'text', text: result }] }) }] }); return b; },
    ask(question, options) { b.lastAsk = `call_${++calls}`; item({ type: 'function_call', name: 'request_user_input', arguments: JSON.stringify({ questions: [{ question, options }] }), call_id: b.lastAsk }); return b; },
    panelAnswer(question, answer) { item({ type: 'message', role: 'user', content: [{ type: 'input_text', text: `<send_user_message_question_reply>${JSON.stringify([{ questionItemId: JSON.stringify(['request_user_input', b.lastAsk, 0]), question, answer }])}</send_user_message_question_reply>` }] }); return b; },
    tokens(input, cached, output) { lines.push({ timestamp: at(), type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: input, cached_input_tokens: cached, output_tokens: output } } } }); return b; },
    write() {
      const d = new Date(start);
      const dir = path.join(home, '.codex', 'sessions', String(d.getUTCFullYear()), String(d.getUTCMonth() + 1).padStart(2, '0'), String(d.getUTCDate()).padStart(2, '0'));
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `rollout-${start.replace(/[:.]/g, '-')}-${id}.jsonl`);
      fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
      return file;
    },
  };
  return b;
}
