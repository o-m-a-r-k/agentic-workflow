#!/usr/bin/env node
// Stops careless writes to agentic-workflow evidence. The ledger's hash chain detects edits after the fact;
// this blocks the common ones before they happen. It is a guard against mistakes, not against a determined
// agent: shell text can always be obfuscated. Inert outside projects that have `.wf-evidence/`.
let input = '';
process.stdin.on('data', (c) => (input += c));
process.stdin.on('end', () => {
  let data;
  try {
    data = JSON.parse(input);
  } catch {
    process.exit(0);
  }
  const t = data.tool_input ?? {};
  const EVIDENCE = /(^|[\\/\s'"=])\.wf-evidence([\\/]|$|\s)/;
  const block = (why) => {
    process.stderr.write(`agentic-workflow: ${why}. Evidence under .wf-evidence/ is written only by \`wf\` commands; use the matching wf command.\n`);
    process.exit(2);
  };
  const file = t.file_path ?? t.notebook_path ?? '';
  if (file && EVIDENCE.test(file)) block(`${file} is workflow evidence`);
  const cmd = typeof t.command === 'string' ? t.command : '';
  if (cmd && cmd.includes('.wf-evidence')) {
    // Writes whose target is evidence. Reads (cat, grep, ls), and redirections elsewhere (2>/dev/null), are fine.
    const ev = String.raw`\S*\.wf-evidence\S*`;
    const patterns = [
      new RegExp(String.raw`(^|[^0-9&])>>?\s*${ev}`), // > file, >> file
      new RegExp(String.raw`\b(tee|rm|mv|truncate|dd|install)\b[^|;&]*${ev}`),
      new RegExp(String.raw`\bsed\s+(-[a-zA-Z]*i|--in-place)[^|;&]*${ev}`),
      new RegExp(String.raw`\bcp\b[^|;&]*\s${ev}\s*($|[|;&])`), // cp … <dest in evidence>
      new RegExp(String.raw`\b(node|python3?|ruby|perl)\s+-[ecp]\b[^|;&]*(writeFile|appendFile|open\(|unlink|rename)[^|;&]*\.wf-evidence`),
    ];
    if (patterns.some((re) => re.test(cmd))) block('this command writes to workflow evidence');
  }
  process.exit(0);
});
