// The shape adapters return for what a role said: the assistant's turns, oldest first.
//   { role: 'assistant', at: ISO time | null, texts: [string, ...], model: string | null }
// `texts` are the turn's text parts as the harness stored them (never joined: a fenced block is found inside one part);
// `model` is the model that wrote the turn when the transcript says so, never a placeholder.

// The last fenced YAML block (```yaml, ```yml or an untagged fence) the agent wrote, or null.
export function lastFencedYaml(entries) {
  let found = null;
  for (const e of entries) {
    if (e.role !== 'assistant') continue;
    for (const t of e.texts ?? []) for (const m of String(t).matchAll(/```(?:ya?ml)?[ \t]*\n([\s\S]*?)\n[ \t]*```/g)) found = m[1];
  }
  return found;
}

// The model of the last turn that names one, or null.
export function lastModel(entries) {
  for (let i = entries.length - 1; i >= 0; i--) if (entries[i].role === 'assistant' && entries[i].model) return entries[i].model;
  return null;
}

// Sub-agents a role started, at any depth: the index entries whose `parentAgentId` chain leads to one of `roots`.
export function descendants(index, roots) {
  const out = [];
  const seen = new Set(roots);
  let frontier = [...roots];
  while (frontier.length) {
    const next = index.filter((x) => x.parentAgentId && frontier.includes(x.parentAgentId) && !seen.has(x.agentId));
    for (const x of next) {
      seen.add(x.agentId);
      out.push(x);
    }
    frontier = next.map((x) => x.agentId);
  }
  return out;
}
