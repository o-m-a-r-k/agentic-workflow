// Pieces of a tool call every host's transcript shares.

// `mcp__<server>__get_issue`, `mcp__<uuid>__get_issue` -> `get_issue`; any other name as it is.
export const toolOf = (full) => /^mcp__.+?__([A-Za-z0-9_]+)$/.exec(String(full ?? ''))?.[1] ?? String(full ?? '');

// A tool name matches a wanted one by suffix: `get_issue` matches `mcp__x__get_issue` and a host's own prefix on it
// (`mcp__x__tracker_get_issue`).
export const toolMatches = (full, wanted) => {
  const t = toolOf(full);
  return t === wanted || t.endsWith(`_${wanted}`);
};

// Text of a stored tool result: a string, or the text parts of a list of content blocks.
export const textOf = (content) => (typeof content === 'string' ? content : Array.isArray(content) ? content.filter((p) => p && typeof p.text === 'string').map((p) => p.text).join('') : content == null ? '' : JSON.stringify(content));

// Arguments stored as an object or as JSON text; {} when they are neither.
export const parseArgs = (a) => {
  if (a && typeof a === 'object') return a;
  try {
    const v = JSON.parse(String(a ?? ''));
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {};
  }
};
