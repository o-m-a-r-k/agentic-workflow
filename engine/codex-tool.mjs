// Named failure I-40: Codex connector calls inside functions-exec were ignored, even with an unchanged tool result.
// Only a single literal call passed directly to text is supported. Arbitrary JavaScript cannot prove which result
// it printed: never execute it, reconstruct a result, or accept a matching substring in a larger program.
import { literalArguments } from './codex-command.mjs';

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
