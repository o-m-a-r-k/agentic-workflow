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
export function patchTargets(text) {
  if (typeof text !== 'string' || text.includes('\0')) throw new Error('invalid patch text');
  const lines = text.trim().split(/\r?\n/);
  if (lines[0] !== '*** Begin Patch' || lines.at(-1) !== '*** End Patch') throw new Error('invalid patch boundary');
  const targets = [];
  let operation = null, body = false, moveAllowed = false;
  for (const line of lines.slice(1, -1)) {
    const header = /^\*\*\* (Add|Update|Delete) File: (.+)$/.exec(line);
    if (header) {
      if (operation === 'Add' && !body) throw new Error('empty add');
      operation = header[1]; body = false; moveAllowed = operation === 'Update';
      targets.push(header[2]); continue;
    }
    if (operation === 'Update' && moveAllowed && line.startsWith('*** Move to: ')) {
      if (!line.slice(13).trim()) throw new Error('empty move');
      targets.push(line.slice(13)); moveAllowed = false; continue;
    }
    moveAllowed = false;
    if (operation === 'Add' && line.startsWith('+')) { body = true; continue; }
    if (operation === 'Update' && (/^[ +\-]/.test(line) || line === '@@' || line.startsWith('@@ ') || line === '*** End of File')) { body = true; continue; }
    throw new Error('unknown patch line');
  }
  if (!targets.length || (operation === 'Add' && !body)) throw new Error('empty patch');
  return targets;
}
