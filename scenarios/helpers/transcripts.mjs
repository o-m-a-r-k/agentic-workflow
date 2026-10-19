// A fixture host transcript, in the layout of the Claude Code host: `<home>/.claude/projects/<encoded cwd>/<session>.jsonl`,
// one JSON object per line. Stream 4's readers (filesRead, answered, sessionActivity, connectorCalls) are tested against
// it; streams 1 and 5 use it for coverage and activity facts.
//
// What each builder writes, and what the answer rule must make of it (design section 2, "Answers"):
//   human(text)          a person-typed turn                                  → counts as an answer
//   queued(text)         a message typed while the agent worked (attachment)  → counts as an answer
//   notification(text)   a harness <task-notification> user line              → never an answer
//   meta(text)           an isMeta user line (injected content)               → never an answer
//   toolResult(id, text) a tool result user line                              → never an answer
//   ask(q, options) + panelAnswer(q, label)  the question panel               → counts as an answer
//   read(file) / edit(file) / toolCall(name, input, result)  assistant tool use (Read feeds coverage)
//   say(text)            assistant text
// Every line carries `timestamp`; `advance(min)` moves the clock, so gaps and late answers are exact.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const encodeCwd = (cwd) => cwd.replace(/[^A-Za-z0-9]/g, '-');

export function transcript({ home, cwd, session = crypto.randomUUID(), start = '2026-01-05T09:00:00.000Z', model = 'fixture-model', sidechain = false }) {
  let clock = Date.parse(start);
  let parent = null;
  let n = 0;
  const lines = [];
  const stamp = () => new Date(clock).toISOString();
  const base = (type) => {
    const uuid = `u-${session.slice(0, 8)}-${++n}`;
    const e = { type, uuid, parentUuid: parent, sessionId: session, cwd, timestamp: stamp(), isSidechain: sidechain, userType: 'external' };
    parent = uuid;
    return e;
  };
  const usage = { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
  const assistant = (content) => lines.push({ ...base('assistant'), message: { role: 'assistant', model, content, usage } });
  const userLine = (content, extra = {}) => lines.push({ ...base('user'), message: { role: 'user', content }, ...extra });
  let tools = 0;
  const b = {
    session: { runtime: 'claude', id: session },
    advance(min) { clock += min * 60000; return b; },
    at(iso) { clock = Date.parse(iso); return b; },
    human(text) { userLine(text); return b; },
    meta(text) { userLine(text, { isMeta: true }); return b; },
    notification(text) { userLine(`<task-notification>${text}</task-notification>`); return b; },
    queued(text) { lines.push({ ...base('attachment'), attachment: { type: 'queued_command', prompt: text, commandMode: 'prompt', origin: { kind: 'human' } } }); return b; },
    say(text) { assistant([{ type: 'text', text }]); return b; },
    toolCall(name, input, result = 'ok') {
      const id = `toolu_${session.slice(0, 6)}_${++tools}`;
      assistant([{ type: 'tool_use', id, name, input }]);
      userLine([{ type: 'tool_result', tool_use_id: id, content: typeof result === 'string' ? result : JSON.stringify(result) }]);
      return b;
    },
    toolResult(id, text) { userLine([{ type: 'tool_result', tool_use_id: id, content: text }]); return b; },
    read(file) { return b.toolCall('Read', { file_path: file }, `contents of ${path.basename(file)}`); },
    edit(file) { return b.toolCall('Edit', { file_path: file, old_string: 'a', new_string: 'b' }); },
    ask(question, options) {
      const id = `toolu_${session.slice(0, 6)}_${++tools}`;
      assistant([{ type: 'tool_use', id, name: 'AskUserQuestion', input: { questions: [{ question, options: options.map((label) => ({ label })) }] } }]);
      b.lastAsk = id;
      return b;
    },
    panelAnswer(question, label) {
      userLine([{ type: 'tool_result', tool_use_id: b.lastAsk, content: `User answered: ${label}` }], { toolUseResult: { answers: { [question]: label } } });
      return b;
    },
    lines: () => lines,
    // Write the file; returns its path.
    write() {
      const dir = path.join(home, '.claude', 'projects', encodeCwd(cwd));
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `${session}.jsonl`);
      fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
      return file;
    },
  };
  return b;
}

// A reviewer that read `files` (absolute paths) and wrote its findings: the coverage fixture.
export function reviewerTranscript({ home, cwd, files, skip = [], session }) {
  const t = transcript({ home, cwd, session });
  t.human('Review this change. The bundle is your whole prompt.');
  for (const f of files) if (!skip.includes(f)) t.advance(1).read(f);
  t.advance(1).say('Findings written.');
  return { session: t.session, file: t.write() };
}
