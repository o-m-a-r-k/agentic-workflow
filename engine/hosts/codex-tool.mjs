// Named failure I-40: Codex connector calls inside functions-exec were ignored, even with an unchanged tool result.
// Only a single literal call passed directly to text is supported. Arbitrary JavaScript cannot prove which result
// it printed: never execute it, reconstruct a result, or accept a matching substring in a larger program.

// Reads a literal JavaScript-object-shaped argument text as data. Never evaluates JavaScript: identifiers are object
// keys only, duplicate keys refuse.

export function literalArguments(source) {
  const tokens = [];
  const keys = new Set();
  const lex = /\s+|"(?:[^"\\\r\n]|\\.)*"|'(?:[^'\\\r\n]|\\.)*'|[A-Za-z_$][A-Za-z0-9_$]*|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|[{}\[\],:]/y;
  let offset = 0;
  try {
    while (offset < source.length) {
      lex.lastIndex = offset;
      const match = lex.exec(source);
      if (!match) return null;
      offset = lex.lastIndex;
      let token = match[0];
      if (/^\s+$/.test(token)) continue;
      if (token.startsWith("'")) {
        const value = token.slice(1, -1).replace(/\\(u[\da-fA-F]{4}|[\s\S])/g, (_, escape) => {
          if (escape === "'") return "'";
          return JSON.parse('"\\' + escape + '"');
        });
        token = JSON.stringify(value);
      } else if (/^[A-Za-z_$]/.test(token) && !['true', 'false', 'null'].includes(token)) {
        if (!/^\s*:/.test(source.slice(offset))) return null; // identifiers are object keys, never evaluated values
        token = JSON.stringify(token);
      }
      tokens.push(token);
    }
    for (let i = 0; i < tokens.length; i++) if (tokens[i + 1] === ':') {
      const key = JSON.parse(tokens[i]);
      if (keys.has(key)) return null;
      keys.add(key);
    }
    const result = JSON.parse(tokens.join(''));
    return result && !Array.isArray(result) && typeof result === 'object' ? result : null;
  } catch { return null; }
}

export function wrappedConnectorCall(p) {
  if (p.type !== 'custom_tool_call' || !['exec', 'functions.exec'].includes(p.name) || (p.namespace && p.namespace !== 'functions')) return null;
  if (typeof p.call_id !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(p.call_id)) return null;
  if (typeof p.input !== 'string' || p.input.length > 65536) return null;
  const source = p.input.replace(/^\s*\/\/ @exec:[^\n]*\n/, '').trim();
  const m = /^text\(\s*await\s+tools\.(mcp__[A-Za-z0-9_-]+__[A-Za-z0-9_]+)\(\s*(\{[\s\S]*\})\s*\)\s*\)\s*;?$/.exec(source);
  if (!m) return null;
  const input = literalArguments(m[2]);
  return input ? { name: m[1], input } : null;
}

export function wrappedConnectorResult(output) {
  if (!Array.isArray(output) || output.length !== 2 || output.some((b) => b?.type !== 'input_text' || typeof b.text !== 'string')) return null;
  if (!/^Script completed\nWall time [\d.]+ seconds\nOutput:\n$/.test(output[0].text)) return null;
  let result;
  try { result = JSON.parse(output[1].text); } catch { return null; }
  if (!result || !Array.isArray(result.content) || !result.content.length || result.content.some((b) => b?.type !== 'text' || typeof b.text !== 'string')) return null;
  return { result: result.content.map((b) => b.text).join(''), error: result.isError === true };
}

// Named failure I-43: Codex sends native file patches in tool_input.command, with tool_name apply_patch.
// Parse only that file-edit protocol; a Bash command is never read as a patch.
//
// Named failure (I-108): the parser here accepted an update-hunk line only when it began with a space, `+` or `-`, so a patch
// with a bare empty context line threw, and the guard refused a patch that touches no evidence (as "targets the workflow
// evidence folder") although Codex applies it. This is a port of the grammar Codex's own `apply_patch` reads, taken from its
// behaviour (codex-cli 0.162.1 run on each rule with `--codex-run-as-apply-patch`; scenarios/fix-074-lessons.test.mjs pins
// them and, with WF_TEST_CODEX set, runs the same patches through the installed binary and compares), not from the
// published summary of it, which is narrower than what Codex accepts:
//   - The patch is trimmed; its first and last lines, trimmed, are `*** Begin Patch` and `*** End Patch`, or it is a heredoc
//     (`<<EOF`, `<<'EOF'`, `<<"EOF"` ... a last line ending in `EOF`) around such a patch.
//   - A hunk starts at a line that, trimmed, begins `*** Add File: `, `*** Delete File: ` or `*** Update File: `; the path is
//     the rest of the trimmed line.
//   - Add: following lines that begin `+`. A bare empty line ends it (and is not a hunk header). No line at all is fine.
//   - Delete: that line only.
//   - Update: an optional `*** Move to: <path>` line (right-trimmed, the very next line), then chunks. A chunk is an
//     optional `@@` or `@@ <text>` line (required from the second chunk on), then lines that begin with a space, `+`, `-`, or
//     are EMPTY (an empty context line), up to an optional `*** End of File` (blank lines after it are skipped; one before the
//     first chunk is skipped by itself). A chunk needs one such line. A line that begins
//     any other way ends the chunk; what follows must be another chunk's `@@` or the next hunk's header (a raw line starting
//     with one of the three prefixes), or the patch is refused.
//   - A `*** End Patch` line (trimmed) where a hunk or chunk could start closes the list; only blank lines may follow it
//     before the final one. A hunk that applies no change (context lines only) is still a hunk.
// A patch Codex refuses to parse is refused here too (the caller reports it as malformed); the target list is every path
// Codex would write, delete or move to.
const BEGIN = '*** Begin Patch';
const END = '*** End Patch';
const ADD = '*** Add File: ';
const DELETE = '*** Delete File: ';
const UPDATE = '*** Update File: ';
const MOVE = '*** Move to: ';
const END_OF_FILE = '*** End of File';
const HEREDOC = ['<<EOF', "<<'EOF'", '<<"EOF"'];
const isHeader = (line) => line.startsWith(ADD) || line.startsWith(DELETE) || line.startsWith(UPDATE);
const bounded = (lines) => lines.length >= 2 && lines[0].trim() === BEGIN && lines.at(-1).trim() === END;

export function patchTargets(text) {
  if (typeof text !== 'string' || text.includes('\0')) throw new Error('invalid patch text');
  let lines = text.trim().split(/\r?\n/);
  if (!bounded(lines)) {
    if (lines.length >= 4 && HEREDOC.includes(lines[0]) && lines.at(-1).endsWith('EOF')) lines = lines.slice(1, -1);
    if (!bounded(lines)) throw new Error('invalid patch boundary');
  }
  const body = lines.slice(1, -1);
  const targets = [];
  let i = 0;
  while (i < body.length) {
    const top = body[i].trim();
    if (top === END) {
      if (body.slice(i + 1).some((line) => line.trim() !== '')) throw new Error('text after the end of the patch');
      break;
    }
    if (top.startsWith(ADD)) {
      targets.push(top.slice(ADD.length));
      i += 1;
      while (i < body.length && body[i].startsWith('+')) i += 1;
    } else if (top.startsWith(DELETE)) {
      targets.push(top.slice(DELETE.length));
      i += 1;
    } else if (top.startsWith(UPDATE)) {
      targets.push(top.slice(UPDATE.length));
      i += 1;
      const move = i < body.length ? body[i].trimEnd() : '';
      if (move.startsWith(MOVE)) {
        targets.push(move.slice(MOVE.length));
        i += 1;
      }
      let chunks = 0;
      const skipBlank = () => { while (i < body.length && body[i].trim() === '') i += 1; };
      while (i < body.length) {
        const line = body[i];
        if (isHeader(line) || (!/^[ +-]/.test(line) && line.trim() === END)) break;
        if (!chunks && line.trimEnd() === END_OF_FILE) { // a marker before the first chunk is skipped
          i += 1;
          continue;
        }
        if (line === '@@' || line.startsWith('@@ ')) i += 1;
        else if (chunks) throw new Error('expected a chunk marker');
        let lined = 0;
        for (; i < body.length; i += 1) {
          if (body[i].trimEnd() === END_OF_FILE) {
            if (!lined) throw new Error('empty update chunk');
            i += 1;
            lined += 1;
            skipBlank();
            break;
          }
          const first = body[i][0];
          if (first === undefined || first === ' ' || first === '+' || first === '-') lined += 1;
          else if (!lined) throw new Error('unknown patch line');
          else break;
        }
        if (!lined) throw new Error('empty update chunk');
        chunks += 1;
      }
      if (!chunks) throw new Error('empty update');
    } else throw new Error('unknown patch hunk');
  }
  if (!targets.length) throw new Error('empty patch');
  return targets;
}
