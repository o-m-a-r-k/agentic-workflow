// Named failure I-48: a completed native Node reader reached the reviewer but was invisible to the read guard.
// Recognize literal tool transport and straight-line full-file reads, bind handed references, and require the
// actual full UTF-8 bytes in successful host output. Never evaluate transcript JavaScript or trust claimed reads.
import fs from 'node:fs';
import path from 'node:path';
import { literalArguments } from './codex-command.mjs';

function literalCalls(source) {
  const calls = [];
  while (source.trim()) {
    source = source.trim();
    const start = /^text\(\s*await\s+tools\.([A-Za-z0-9_]+)\(\s*/.exec(source);
    if (!start || source[start[0].length] !== '{') return null;
    let i = start[0].length, depth = 0, quote = null;
    const offset = i;
    for (; i < source.length; i++) {
      const c = source[i];
      if (quote) { if (c === '\\') i++; else if (c === quote) quote = null; continue; }
      if (c === '"' || c === "'") quote = c;
      else if (c === '{') depth++;
      else if (c === '}' && --depth === 0) { i++; break; }
    }
    const input = literalArguments(source.slice(offset, i));
    const end = /^\s*\)\s*\)\s*;?/.exec(source.slice(i));
    if (!input || !end || depth || quote) return null;
    calls.push({ name: start[1], input });
    source = source.slice(i + end[0].length);
  }
  return calls.length ? calls : null;
}

function toolResult(value) {
  if (Array.isArray(value)) {
    if (value.length !== 1 || value[0]?.type !== 'input_text') return null;
    value = value[0].text;
  }
  if (typeof value === 'string') { try { value = JSON.parse(value); } catch { return null; } }
  if (!value || value.isError === true || !Array.isArray(value.content) || !value.content.length || value.content.some(b => b?.type !== 'text' || typeof b.text !== 'string')) return null;
  return value.content.map(b => b.text).join('');
}

function readPaths(code, bundle) {
  if (typeof code !== 'string' || code.length > 65536) return [];
  let rest = code.replace(/^\s*(?:var|let|const)\s+fs\s*=\s*await\s+import\(\s*(['"])node:fs\/promises\1\s*\)\s*;\s*/, '').trim();
  const paths = [];
  // Only leading, unconditional writes of awaited full-file reads. Later arbitrary code earns no read credit.
  const read = /^nodeRepl\.write\(\s*await\s+fs\.readFile\(\s*((?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')|bundle\.skills\[\d+\]\.file|bundle\.invariants)\s*,\s*(['"])utf8\2\s*\)\s*\)\s*;\s*/;
  for (let match; (match = read.exec(rest)); rest = rest.slice(match[0].length)) {
    const expr = match[1];
    let file;
    if (expr === 'bundle.invariants') file = bundle?.invariants;
    else if (expr.startsWith('bundle.skills[')) file = bundle?.skills?.[Number(expr.match(/\[(\d+)\]/)[1])]?.file;
    else file = literalArguments('{file:' + expr + '}')?.file;
    if (typeof file === 'string' && path.isAbsolute(file)) paths.push(file);
  }
  return paths;
}

function fullContentReached(file, text) {
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | (fs.constants.O_NONBLOCK ?? 0));
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.nlink > 1 || st.size === 0 || st.size > 4 * 1024 * 1024) return false;
    const bytes = Buffer.alloc(st.size + 1);
    let length = 0, count;
    while (length < bytes.length && (count = fs.readSync(fd, bytes, length, bytes.length - length, null))) length += count;
    if (length !== st.size || fs.fstatSync(fd).size !== st.size) return false;
    const content = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0,length));
    return text.includes(content);
  } catch { return false; } finally { if (fd !== undefined) fs.closeSync(fd); }
}

export function completedNodeReads(raw, bundle) {
  const calls = new Map(), duplicate = new Set(), reads = [];
  const counts = new Map();
  for (const e of raw) {
    const p = e.type === 'response_item' ? e.payload : null;
    if (p && ['function_call','custom_tool_call','function_call_output','custom_tool_call_output'].includes(p.type)) {
      const key = p.call_id + ':' + (p.type.endsWith('_output') ? 'output' : 'call');
      counts.set(key,(counts.get(key) ?? 0) + 1);
    }
  }
  for (const e of raw) {
    const p = e.type === 'response_item' ? e.payload : null;
    if (!p || typeof p.call_id !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(p.call_id) || counts.get(p.call_id+':call') !== 1 || counts.get(p.call_id+':output') !== 1) continue;
    if (['function_call', 'custom_tool_call'].includes(p.type)) {
      if (calls.has(p.call_id)) { duplicate.add(p.call_id); continue; }
      let literal = null;
      if (p.type === 'function_call' && ((p.namespace === 'mcp__node_repl' && p.name === 'js') || (!p.namespace && p.name === 'mcp__node_repl__js'))) {
        try { literal = [{name:'mcp__node_repl__js',input:JSON.parse(p.arguments)}]; } catch {}
      } else if (p.type === 'custom_tool_call' && ['exec','functions.exec'].includes(p.name) && (!p.namespace || p.namespace === 'functions') && typeof p.input === 'string' && p.input.length <= 65536) literal = literalCalls(p.input.replace(/^\s*\/\/ @exec:[^\n]*\n/, ''));
      calls.set(p.call_id, {literal,wrapped:p.type === 'custom_tool_call'});
    } else if (['function_call_output','custom_tool_call_output'].includes(p.type)) {
      const call = calls.get(p.call_id);
      if (!call?.literal || duplicate.has(p.call_id) || call.finished) continue;
      call.finished = true;
      let outputs;
      if (call.wrapped) {
        if (p.type !== 'custom_tool_call_output' || !Array.isArray(p.output) || p.output.length !== call.literal.length + 1 || p.output.some(b => b?.type !== 'input_text' || typeof b.text !== 'string') || !/^Script completed\nWall time [\d.]+ seconds\nOutput:\n$/.test(p.output[0].text)) continue;
        outputs = p.output.slice(1).map(b => b.text);
      } else if (p.type === 'function_call_output') outputs = [p.output];
      else continue;
      for (let i = 0; i < call.literal.length; i++) {
        const invocation = call.literal[i];
        if (invocation.name !== 'mcp__node_repl__js') continue;
        const text = toolResult(outputs[i]);
        if (text === null) continue;
        for (const file of readPaths(invocation.input?.code, bundle)) if (fullContentReached(file,text)) reads.push({type:'assistant',message:{content:[{type:'tool_use',id:p.call_id+':'+i+':'+file,name:'Read',input:{file_path:file}}]}});
      }
    }
  }
  return reads;
}
