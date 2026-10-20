// End-to-end support: the real `wf` binary on invented neutral projects, with no doubles. The only stand-in is the
// reviewer host itself: a `claude` executable on PATH that behaves as Claude Code's `--print` mode does for the
// launcher (it announces its session, reads its prompt on stdin, keeps a transcript under the host home, writes the
// review file its prompt names, and reports a result). What it finds is scripted per review round by the scenario.
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { runWf } from './helpers/index.mjs';

// The fake host. Its transcript reads every product file the prompt lists (so coverage is complete), unless the plan
// for that round lists files to `skip`.
const FAKE_CLAUDE = String.raw`#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const at = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
const session = at('--session-id') || at('--resume');
const out = (e) => process.stdout.write(JSON.stringify(e) + '\n');
let prompt = '';
process.stdin.on('data', (c) => { prompt += c; });
process.stdin.on('end', () => {
  out({ type: 'system', subtype: 'init', session_id: session });
  const round = Number((/review round (\d+)/.exec(prompt) || [])[1] || 1);
  const seat = (/seat (\S+?),/.exec(prompt) || [])[1] || 'whole';
  const list = (title) => {
    const i = prompt.indexOf(title);
    if (i < 0) return [];
    const rest = prompt.slice(i).split('\n').slice(1);
    const items = [];
    for (const l of rest) { if (!l.startsWith('- ')) break; items.push(l.slice(2)); }
    return items;
  };
  const files = list('Product files you must read in full');
  const output = (/Write your review as JSON to (\S+?):/.exec(prompt) || [])[1];
  let plan = {};
  try { plan = JSON.parse(fs.readFileSync(process.env.WF_FAKE_REVIEWS, 'utf8')); } catch {}
  const mine = plan[seat + ':' + round] || plan[String(round)] || {};
  const skip = mine.skip || [];
  const home = process.env.WF_HOST_HOME;
  const dir = path.join(home, '.claude', 'projects', process.cwd().replace(/[^A-Za-z0-9]/g, '-'));
  fs.mkdirSync(dir, { recursive: true });
  let t = Date.now();
  let n = 0;
  const stamp = () => new Date(t += 1000).toISOString();
  const lines = [{ type: 'user', entrypoint: 'sdk-cli', sessionId: session, cwd: process.cwd(), timestamp: stamp(), uuid: 'r' + (++n), message: { role: 'user', content: prompt } }];
  for (const f of files) {
    if (skip.some((s) => f.endsWith(s))) continue;
    const id = 'toolu_r' + (++n);
    lines.push({ type: 'assistant', sessionId: session, cwd: process.cwd(), timestamp: stamp(), uuid: 'r' + (++n), message: { role: 'assistant', model: 'fake-model', content: [{ type: 'tool_use', id, name: 'Read', input: { file_path: f } }], usage: { input_tokens: 10, output_tokens: 2 } } });
    lines.push({ type: 'user', sessionId: session, cwd: process.cwd(), timestamp: stamp(), uuid: 'r' + (++n), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'file contents' }] } });
  }
  // The review is written with the file tool, as Claude Code does: the transcript carries the write.
  const judged = seat.startsWith('second') ? { met: mine.met || list('Needs to verify').map((need) => ({ need, met: true, how: 'read the change for it' })) } : { risk: mine.risk || { level: 'low', why: 'a small change with tests', needs: [] } };
  const content = JSON.stringify({ findings: mine.findings || [], verified: mine.verified || [], ...judged }, null, 2);
  if (output) {
    const id = 'toolu_r' + (++n);
    lines.push({ type: 'assistant', sessionId: session, cwd: process.cwd(), timestamp: stamp(), uuid: 'r' + (++n), message: { role: 'assistant', model: 'fake-model', content: [{ type: 'tool_use', id, name: 'Write', input: { file_path: output, content } }], usage: { input_tokens: 10, output_tokens: 2 } } });
    lines.push({ type: 'user', sessionId: session, cwd: process.cwd(), timestamp: stamp(), uuid: 'r' + (++n), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'File created' }] } });
  }
  fs.writeFileSync(path.join(dir, session + '.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  if (output) fs.writeFileSync(output, content);
  out({ type: 'result', subtype: 'success', is_error: false, session_id: session, result: 'review written' });
});
`;

// Install the fake reviewer host for a project: returns the env a `wf` call needs (PATH and the review plan file).
export function fakeReviewerHost(p) {
  const bin = path.join(p.tmp, 'host-bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, 'claude'), FAKE_CLAUDE, { mode: 0o755 });
  const plan = path.join(p.tmp, 'reviews.json');
  fs.writeFileSync(plan, '{}');
  p.env.PATH = `${bin}${path.delimiter}${process.env.PATH}`;
  p.env.WF_FAKE_REVIEWS = plan;
  // What the reviewers of each round find: { "<round>" | "<seat>:<round>": { findings, verified, skip } }.
  return { plan: (rounds) => fs.writeFileSync(plan, JSON.stringify(rounds, null, 2)) };
}

// `wf` that must succeed (exit 0); returns its result. `code` names another exit code the step must end with.
export function wf(p, args, { code = 0, ...opts } = {}) {
  const r = runWf(p, args, opts);
  if (r.code !== code) throw new Error(`wf ${args.join(' ')} exited ${r.code}, expected ${code}\nstdout: ${r.out}\nstderr: ${r.err}`);
  return r;
}

// Wait for a file the launched reviewer writes (it runs detached).
export async function waitFor(file, ms = 30000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fs.existsSync(file) && fs.statSync(file).size > 0) return file;
    await sleep(100);
  }
  throw new Error(`timed out waiting for ${file}`);
}

// The review files `wf review` said its reviewers write.
export const reviewFiles = (reviewOut) => [...reviewOut.matchAll(/it writes (\S+)/g)].map((m) => m[1]);

// The attempt's ledger events of one type (data), read through the real ledger file.
export function events(p, attempt, type) {
  const file = path.join(p.root, '.wf-evidence', 'attempts', attempt, 'ledger.jsonl');
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((e) => !type || e.type === type);
}
