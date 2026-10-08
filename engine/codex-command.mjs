// Named failure I-35: owner bookkeeping accepted Claude Bash calls but ignored Codex command and functions-exec calls.
// Read only host call records. A functions-exec wrapper must contain exactly one literal exec_command invocation;
// never evaluate JavaScript, infer a command from prose/results, or search arbitrary code for a matching substring.
import path from 'node:path';

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

function wrappedArguments(input) {
  if (typeof input !== 'string' || input.length > 65536) return null;
  const source = input.replace(/^\s*\/\/ @exec:[^\n]*\n/, '').trim();
  const match = /^(?:text\(\s*await\s+tools\.exec_command\(\s*(\{[\s\S]*\})\s*\)\s*\)|await\s+tools\.exec_command\(\s*(\{[\s\S]*\})\s*\))\s*;?$/.exec(source);
  return match ? literalArguments(match[1] ?? match[2]) : null;
}

export function lastCodexOwnerCommand(bytes, session) {
  const entries = bytes.toString('utf8').split('\n').map((line, index) => {
    try { return { ...JSON.parse(line), line: index + 1 }; } catch { return null; }
  }).filter(Boolean);
  const meta = entries.find((e) => e.type === 'session_meta')?.payload;
  // Only the owner chat, never a subagent/headless rollout, supplies the bookkeeping call.
  if (meta?.id !== session || !['cli', 'vscode'].includes(meta.source) || meta.originator === 'codex_exec') return null;
  const last = entries.filter((e) => e.type === 'response_item' && ['function_call', 'custom_tool_call'].includes(e.payload?.type)).at(-1);
  if (!last) return null;
  const call = last.payload;
  if (last.isSidechain || (call.role !== undefined && call.role !== 'assistant')) return null;
  if (call.namespace && call.namespace !== 'functions') return null;
  if (typeof call.call_id !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(call.call_id)) return null;
  let args;
  if (call.type === 'function_call' && ['exec_command', 'functions.exec_command'].includes(call.name)) {
    try { args = JSON.parse(call.arguments); } catch { return null; }
  } else if (call.type === 'custom_tool_call' && ['exec', 'functions.exec'].includes(call.name)) args = wrappedArguments(call.input);
  else return null;
  if (!args || typeof args.cmd !== 'string' || (args.workdir !== undefined && typeof args.workdir !== 'string')) return null;
  if (args.shell !== undefined && (typeof args.shell !== 'string' || !['sh', 'bash', 'zsh'].includes(path.basename(args.shell)))) return null;
  const cwd = args.workdir ?? meta.cwd;
  if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) return null;
  return { command: args.cmd, cwd, line: last.line, at: last.timestamp ?? null, id: `call:${call.call_id}` };
}
