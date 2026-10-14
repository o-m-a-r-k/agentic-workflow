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
