import fs from 'node:fs';

// Pieces of a connector tool call every harness's transcript shares: the tool's own name inside the connector's long
// one, and the text of a stored result.

// `mcp__linear__get_issue`, `mcp__<uuid>__get_issue` -> `get_issue`.
export const toolOf = (full) => /^mcp__.+?__([A-Za-z0-9_]+)$/.exec(String(full ?? ''))?.[1] ?? null;

// Text of a stored tool result: a string, or the text parts of a list of content blocks.
export const textOf = (content) => (typeof content === 'string' ? content : Array.isArray(content) ? content.filter((p) => p?.type === 'text' || p?.type === 'output_text' || p?.type === 'input_text').map((p) => p.text ?? '').join('') : null);

// Arguments stored as an object or as JSON text; {} when they are neither.
export const parseArgs = (a) => {
  if (a && typeof a === 'object') return a;
  try {
    return JSON.parse(String(a ?? ''));
  } catch {
    return {};
  }
};

// The file targets most harnesses' file tools share: `file_path`, `notebook_path`, `path`, and one `file_path` per edit.
export const genericFileTargets = (t) => [t.file_path, t.notebook_path, t.path, ...(Array.isArray(t.edits) ? t.edits.map((e) => e?.file_path) : [])];

// The last `max` bytes of a transcript as whole lines (a large session file is read from its end).
export function tailLines(file, max = 16 * 1024 * 1024) {
  const size = fs.statSync(file).size;
  const fd = fs.openSync(file, 'r');
  try {
    const length = Math.min(size, max);
    const buf = Buffer.alloc(length);
    fs.readSync(fd, buf, 0, length, size - length);
    const lines = buf.toString('utf8').split('\n');
    return size > max ? lines.slice(1) : lines;
  } finally {
    fs.closeSync(fd);
  }
}

// The shell commands a session ran, each paired with its result by id: the one still running (the last without a result)
// and every finished one with its minutes. `call(entry)` gives [{ id, command, waitsOn }], `result(entry)` gives ids or
// [{ id, session }]. A harness that yields a long command to a session (Codex: `exec_command` returns a `session_id` while it
// still runs) names that session in the result, and a later call that waits on it (`write_stdin` with that `session_id`)
// gives `waitsOn`: its minutes are that command's. Independent review of 0.7.14: polls added to the last finished command
// named a 6-second export as a 23-minute run. A wait on a session no result in the window announced is its own entry.
// Named failure (0.7.14): an implementer spent 201 of 266 minutes in sleep loops waiting for its own background end-to-end
// runs, and the owner saw only "active within the last minute".
export function shellRunsOf(lines, { call, result }) {
  const open = new Map();
  const runs = [];
  const bySession = new Map();
  for (const line of lines) {
    if (!line) continue;
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    const at = Date.parse(e.timestamp);
    if (!Number.isFinite(at)) continue;
    for (const c of call(e)) if (c?.id) open.set(c.id, { command: String(c.command ?? ''), at, waitsOn: [c.waitsOn ?? []].flat().filter((x) => x !== null && x !== undefined) });
    for (const r of result(e)) {
      const id = typeof r === 'string' ? r : r?.id;
      const o = open.get(id);
      if (!o) continue;
      open.delete(id);
      const minutes = (at - o.at) / 60000;
      // A call that waits on earlier commands gives its minutes to them (shared when it waits on several); a command it
      // starts itself and leaves running is kept under the session its result announces.
      if (o.waitsOn.length) {
        for (const s of o.waitsOn) {
          let target = bySession.get(s);
          if (!target) {
            target = { command: s === 'earlier' ? 'waiting on earlier commands' : `a command started earlier (session ${s})`, minutes: 0 };
            runs.push(target);
            bySession.set(s, target);
          }
          target.minutes += minutes / o.waitsOn.length;
        }
        if (r?.session !== undefined && r.session !== null && !bySession.has(r.session)) {
          const started = { command: o.command, minutes: 0 };
          runs.push(started);
          bySession.set(r.session, started);
        }
        continue;
      }
      const run = { command: o.command, minutes };
      runs.push(run);
      if (r?.session !== undefined && r.session !== null) bySession.set(r.session, run);
    }
  }
  const last = [...open.values()].at(-1) ?? null;
  const waitingOn = last?.waitsOn?.length ? bySession.get(last.waitsOn[0]) ?? null : null;
  return { running: last ? { command: waitingOn ? waitingOn.command : last.command, startedAt: new Date(last.at - (waitingOn ? waitingOn.minutes * 60000 : 0)).toISOString() } : null, runs };
}
