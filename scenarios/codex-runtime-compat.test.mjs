// Named failure I-75: shared roles required one harness's tools and left native reviews of another without a closure.
// The texts every harness's agents read (role texts, skills, the session rules, the risk checklist) name no tool that only
// one harness has and no harness at all: what differs per harness lives in its host module (engine/hosts/), such as how the
// reviewer is allowed to write its one review file.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { matchesAny } from '../engine/util.mjs';
import claude from '../engine/hosts/claude.mjs';
import codex from '../engine/hosts/codex.mjs';

const ROOT = path.join(import.meta.dirname, '..');
const BUDGET = JSON.parse(fs.readFileSync(path.join(ROOT, 'budget.json'), 'utf8'));
const walk = (dir) => fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(`${dir}/${e.name}`) : [`${dir}/${e.name}`]));
const TEXTS = [...walk('templates'), ...walk('skills')].filter((f) => matchesAny(f, BUDGET.words.texts));

// Phrases that name a tool one harness has and the other does not, and the harnesses themselves.
const CLAUDE_ONLY = /\bwith (Read|Skill|Write)\b|the (Write|Edit|Bash) tool|AskUserQuestion/;
const CODEX_ONLY = /view_image|apply_patch|exec_command|fs\.writeFile/;
const HARNESS = /claude|codex/i;

test('I-75: the texts agents read name no harness and no tool only one harness has', () => {
  assert.ok(TEXTS.length >= 8, `the texts were found: ${TEXTS.join(', ')}`);
  for (const f of TEXTS) {
    const text = fs.readFileSync(path.join(ROOT, f), 'utf8');
    for (const re of [CLAUDE_ONLY, CODEX_ONLY, HARNESS]) assert.doesNotMatch(text, re, f);
  }
});

test('I-75: each host lets its launched reviewer write only its review file, in that host\'s own terms', () => {
  const o = { model: 'm', cwd: '/w', closure: '/w/review.json' };
  const c = claude.launch(o);
  const allowed = c.args.slice(c.args.indexOf('--allowedTools') + 1, c.args.indexOf('--disallowedTools'));
  assert.deepEqual(allowed.filter((a) => /^(Write|Edit|MultiEdit|NotebookEdit)\b/.test(a)), ['Write(//w/review.json)']);
  const x = codex.launch(o);
  assert.equal(x.args[x.args.indexOf('--sandbox') + 1], 'read-only');
  assert.equal(x.args[x.args.indexOf('--output-last-message') + 1], '/w/review.json');
});
