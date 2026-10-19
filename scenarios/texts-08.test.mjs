// Stream 6: the role texts, skills and session rules. Within the word budget, only the roles 0.8 keeps, only commands
// that exist, and the facts other streams rely on (finding classes, the review's JSON, the session-rules placeholders).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { COMMANDS, COMMAND_ALIASES } from '../engine/contract.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BUDGET = JSON.parse(fs.readFileSync(path.join(ROOT, 'budget.json'), 'utf8'));
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const words = (text) => text.split(/\s+/).filter(Boolean).length;
const AGENTS = fs.readdirSync(path.join(ROOT, 'templates', 'agents')).map((f) => `templates/agents/${f}`);
const SKILLS = fs.readdirSync(path.join(ROOT, 'skills')).map((d) => `skills/${d}/SKILL.md`);
const TEXTS = [...AGENTS, ...SKILLS, 'templates/session-rules.md', 'templates/risk-checklist.md'];

test('only the roles 0.8 keeps have texts', () => {
  assert.deepEqual(AGENTS.sort(), ['templates/agents/implementer.md', 'templates/agents/planner.md', 'templates/agents/reviewer.md']);
  assert.deepEqual(SKILLS.sort(), ['onboard', 'quick-fix', 'resume', 'secrets', 'work'].map((d) => `skills/${d}/SKILL.md`));
});

test('every text is within the per-role word limit, and all of them within the total', () => {
  let total = 0;
  for (const f of TEXTS) {
    const n = words(read(f));
    total += n;
    assert.ok(n <= BUDGET.words.roleMax, `${f}: ${n} words, limit ${BUDGET.words.roleMax}`);
  }
  assert.ok(total <= BUDGET.words.total, `${total} words, limit ${BUDGET.words.total}`);
});

test('texts name only commands that exist, and none of the removed workflow', () => {
  const known = new Set([...Object.keys(COMMANDS), ...Object.keys(COMMAND_ALIASES)]);
  for (const f of TEXTS) {
    const text = read(f);
    for (const [, cmd] of text.matchAll(/`wf ([a-z-]+)/g)) assert.ok(known.has(cmd), `${f} names \`wf ${cmd}\`, which is not a command`);
    assert.doesNotMatch(text, /strategist|panel|lanes?\b|batch|--intent|--defer-heavy|evidence round|workflowRules|roleFileChanged|frozen/i, f);
  }
});

test('skills carry their name and a description', () => {
  for (const f of SKILLS) {
    const fm = /^---\nname: ([^\n]+)\ndescription: ([^\n]+)\n---\n/.exec(read(f));
    assert.ok(fm, `${f} frontmatter`);
    assert.equal(fm[1], path.basename(path.dirname(f)));
  }
  for (const f of AGENTS) assert.match(read(f), /^---\ndescription: [^\n]+\n---\n/, f);
});

test('the reviewer: whole diff, blockers then the whole change, state not call counts, consumers, three classes, the JSON', () => {
  const r = read('templates/agents/reviewer.md');
  for (const s of ['every product file in the diff', 'verify each listed open finding, then re-read the whole change', 'state or output, not call counts', 'consumer of a changed contract', '`goal`', '`regression`', '`other`', 'never a line this change wrote', '`findings`', '`verified`', 'fixed|open', 'risk checklist', 'screenshot']) assert.ok(r.includes(s), s);
  const impl = read('templates/agents/implementer.md');
  for (const s of ['state or output', 'fails without your change', '`wf test fast`', '`wf screens`', 'outside the goal']) assert.ok(impl.includes(s), s);
  const risk = read('templates/risk-checklist.md');
  for (const s of ['Transactions', 'rolls back', 'once', 'External calls', 'realistic values']) assert.ok(risk.includes(s), s);
});

test('the work skill: background attempts, no status stops, wf status names the next command, reserved decisions only', () => {
  const w = read('skills/work/SKILL.md');
  for (const s of ['its own background attempt', 'Never stop for status reports', '`wf status` names', 'only the decisions `wf` names', '`goal` or `regression`']) assert.ok(w.includes(s), s);
});

test('session rules use exactly the placeholders the session hook fills', () => {
  const placeholders = [...read('templates/session-rules.md').matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
  assert.deepEqual(placeholders, ['delivery', 'invariants', 'project', 'tracker']);
});
