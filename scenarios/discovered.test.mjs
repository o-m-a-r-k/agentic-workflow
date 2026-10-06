import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { knownLimits } from '../engine/tracker.mjs';
import { WF, closureFile, commitIn, toAccepted, criteriaFile, goodClosure, makeRepo, ok, sh, singleRepoProject, state, tmp, wf, yaml } from './helpers.mjs';

// I-18, named failure: implementers, reviewers and the owner agent noted real defects found during a ticket and parked
// them as follow-ups or "harmless today" without the owner deciding. Every issue found during a ticket is now in the
// attempt's discovered-issue ledger and ends fixed (with a commit of this ticket) or deferred with the owner's words;
// delivery refuses an open one and the reviewer gives each a verdict.
// I-19, named failure: a frozen "no change in repo X" criterion blocked a fix that needed an additive change there, and
// the only way through was an amendment framed as an exception. A discovered fix now adds the repo and its work items to
// the running attempt in one owner step, and the reviewer judges the contract seam on both sides.

const TEMPLATES = path.resolve(import.meta.dirname, '..', 'templates', 'agents');
const SKILLS = path.resolve(import.meta.dirname, '..', 'skills');
const bundleOf = (r) => JSON.parse(fs.readFileSync(r.out.match(/^Read (\S+)/m)?.[1] ?? r.out.match(/bundle: (\S+)/)[1], 'utf8'));
const disc = (root, args) => wf(root, ['discovered', ...args]);

// 0.4.5, named failure (security review of 0.4.4): a deferral was refused only when the caller-typed `--by` named a
// role agent, so an agent that omitted `--by` deferred with invented words. A deferral now takes the owner's words from
// a real user turn in the transcript of the session that owns the attempt (host-recorded, as tracker readbacks are).
const SID = '0wner-5e55-10n1';
const OWNER = `claude:${SID}`;
const homeDir = (root) => path.join(root, '..', '.home');
const ownerFile = (root) => path.join(homeDir(root), '.claude', 'projects', '-proj', `${SID}.jsonl`);
function ownerLine(root, entry) {
  fs.mkdirSync(path.dirname(ownerFile(root)), { recursive: true });
  fs.appendFileSync(ownerFile(root), `${JSON.stringify({ timestamp: new Date().toISOString(), sessionId: SID, ...entry })}\n`);
}
const ownerSays = (root, text) => ownerLine(root, { type: 'user', userType: 'external', message: { role: 'user', content: text } });

test('I-18: discovered issues are recorded, end fixed by a ticket commit or deferred in the owner\'s words, and block delivery while open', () => {
  const { base, root } = singleRepoProject('discovered', { gate: { steps: [{ id: 'unit', repo: 'app', run: 'true' }] } });
  const e = ok(wf(root, ['entry', '--item', 'ENG-700', '--owner', OWNER, '--json'])).json();
  // The owner session's transcript exists, so reviewer rounds run as Codex here (their provenance is not under test).
  ownerSays(root, 'Implement ENG-700, please.');
  const id = e.id;
  const wt = e.repos.app.worktree;
  ok(wf(root, ['handoff', 'planner', '--agent', 'plan-1', '--attempt', id, '--owner', OWNER]));
  ok(wf(root, ['plan', '--file', criteriaFile(base), '--attempt', id, '--owner', OWNER]));
  ok(wf(root, ['handoff', 'implementer', '--agent', 'impl-1', '--attempt', id, '--owner', OWNER]));

  // Any role records what it finds; the list shows it open, and so do status and the next step.
  assert.match(disc(root, ['add', '--attempt', id]).err, /--summary/);
  const a = ok(disc(root, ['add', '--attempt', id, '--summary', 'the pager total sums only the current page', '--where', 'src/a.txt:1', '--found-by', 'impl-1']));
  assert.match(a.out, /discovered D1 recorded on ENG-700\.1/);
  assert.match(ok(disc(root, ['list', '--attempt', id])).out, /D1 {2}open {2}the pager total sums only the current page {2}\(src\/a\.txt:1; found by impl-1\)/);
  assert.match(ok(wf(root, ['resume', '--attempt', id])).out, /discovered: 1 open \(D1\)[\s\S]*next: fix the discovered issue\(s\) D1 in this ticket/);

  // Fixed means a commit of this ticket: not the base, not an unknown sha.
  const baseSha = sh(wt, 'git rev-parse HEAD');
  assert.match(disc(root, ['close', 'D1', '--fixed', baseSha, '--attempt', id]).err, /is not a commit of this ticket/);
  assert.match(disc(root, ['close', 'D1', '--fixed', 'deadbeef', '--attempt', id]).err, /is not a commit of this ticket/);
  commitIn(wt, { 'src/a.txt': 'b\n' }, 'pager total sums every page');
  const fix = sh(wt, 'git rev-parse HEAD');
  assert.match(ok(disc(root, ['close', 'D1', '--fixed', fix.slice(0, 10), '--attempt', id])).out, /D1 fixed in app@/);
  assert.match(disc(root, ['close', 'D1', '--fixed', fix, '--attempt', id]).err, /D1 is already fixed/);

  // Deferral is the owner's decision, taken from an owner message in the owner session's transcript that starts with
  // the fixed phrase `defer <attempt>:<id>`.
  ok(disc(root, ['add', '--attempt', id, '--summary', 'tables have no phone card view', '--found-by', 'impl-1']));
  assert.match(ok(disc(root, ['list', '--attempt', id])).out, /D2 {2}open .*\n {4}to defer it, the owner starts a message with: defer ENG-700\.1:D2: <reason>/);
  // An agent-style call with invented words, with or without --by, is refused: no text from the command line counts.
  assert.match(disc(root, ['close', 'D2', '--deferred', '--decision', 'harmless today', '--attempt', id]).err, /--decision is not accepted: a deferral is taken from the owner's own message, which starts with `defer ENG-700\.1:D2`/);
  assert.match(disc(root, ['close', 'D2', '--deferred', '--decision', 'harmless today', '--by', 'o', '--attempt', id]).err, /--decision is not accepted/);
  assert.match(disc(root, ['close', 'D2', '--deferred', '--quote', 'harmless today', '--attempt', id]).err, /--quote is not accepted/);
  assert.match(disc(root, ['close', 'D2', '--deferred', '--attempt', id]).err, /no owner message after D2 was recorded starts with `defer ENG-700\.1:D2`/);
  // The phrase only in a tool result, a task notification, a scheduled task, a meta line, or a subagent's transcript.
  const phrase = 'defer ENG-700.1:D2: harmless today';
  ownerLine(root, { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: phrase }] }] } });
  ownerLine(root, { type: 'user', message: { role: 'user', content: `<task-notification>${phrase}</task-notification>` } });
  ownerLine(root, { type: 'user', origin: { kind: 'human' }, turnOrigin: 'human', message: { role: 'user', content: `<scheduled-task name="nightly">${phrase}</scheduled-task>` } });
  ownerLine(root, { type: 'user', origin: { kind: 'human' }, turnOrigin: 'human', message: { role: 'user', content: `<system-reminder>${phrase}</system-reminder>` } });
  ownerLine(root, { type: 'user', isMeta: true, message: { role: 'user', content: phrase } });
  const sub = path.join(homeDir(root), '.claude', 'projects', '-proj', SID, 'subagents');
  fs.mkdirSync(sub, { recursive: true });
  fs.writeFileSync(path.join(sub, 'agent-x.jsonl'), `${JSON.stringify({ type: 'user', timestamp: new Date().toISOString(), message: { role: 'user', content: phrase } })}\n`);
  assert.match(disc(root, ['close', 'D2', '--deferred', '--attempt', id]).err, /no owner message after D2 was recorded starts with/);
  assert.match(disc(root, ['close', 'D2', '--fixed', fix, '--deferred', '--attempt', id]).err, /either --fixed <commit> or --deferred/);
  // A real owner turn that starts with the phrase: recorded verbatim with the transcript reference.
  ownerSays(root, 'defer ENG-700.1:D2: park it for the mobile pass next sprint.');
  const closed = ok(disc(root, ['close', 'D2', '--deferred', '--attempt', id, '--json'])).json();
  assert.equal(closed.deferred.decision, 'defer ENG-700.1:D2: park it for the mobile pass next sprint.');
  assert.equal(closed.deferred.source.provenance, 'host-recorded');
  assert.equal(closed.deferred.source.phrase, 'defer ENG-700.1:D2');
  assert.equal(closed.deferred.source.file, fs.realpathSync(ownerFile(root)));
  assert.ok(closed.deferred.source.line > 0);

  // The reviewer's bundle lists every entry; a closure without a verdict per entry is refused.
  ok(wf(root, ['gate', '--attempt', id]));
  const h = ok(wf(root, ['handoff', 'reviewer', '--agent', 'rev-1', '--attempt', id, '--owner', OWNER, '--runtime', 'codex']));
  const bundle = bundleOf(h);
  assert.deepEqual(bundle.discovered.map((d) => [d.id, d.status]), [['D1', 'fixed'], ['D2', 'deferred']]);
  assert.equal(bundle.discovered[1].deferred.decision, 'defer ENG-700.1:D2: park it for the mobile pass next sprint.');
  assert.match(bundle.instructions, /discovered: \[\{ id, verdict: fixed\|deferred\|open, evidence \}\]/);
  const refused = wf(root, ['review', '--closure', closureFile(base, goodClosure('rev-1')), '--attempt', id]);
  assert.match(refused.err, /2 discovered issue\(s\) in your bundle have no valid verdict[\s\S]*D1: no verdict[\s\S]*D2: no verdict/);
  const wrong = wf(root, ['review', '--closure', closureFile(base, goodClosure('rev-1', { discovered: [{ id: 'D1', verdict: 'deferred', evidence: 'x' }, { id: 'D2', verdict: 'deferred', evidence: 'owner decision recorded' }] })), '--attempt', id]);
  assert.match(wrong.err, /D1: `deferred` only acknowledges a deferral the owner recorded; D1 is fixed/);
  ok(wf(root, ['review', '--closure', closureFile(base, goodClosure('rev-1', { discovered: [{ id: 'D1', verdict: 'fixed', evidence: 'src/a.txt:1 sums every page' }, { id: 'D2', verdict: 'deferred', evidence: 'owner decision recorded' }] })), '--attempt', id]));

  // An entry recorded after the round was handed is not judged: acceptance needs a fresh round.
  ok(disc(root, ['add', '--attempt', id, '--summary', 'an implicit page-size default', '--found-by', 'o']));
  assert.match(wf(root, ['accept', '--attempt', id, '--owner', OWNER]).err, /discovered D3 was recorded after this review round was handed[\s\S]*fresh reviewer/);
  ok(wf(root, ['handoff', 'reviewer', '--agent', 'rev-2', '--attempt', id, '--owner', OWNER, '--runtime', 'codex']));
  ok(wf(root, ['review', '--closure', closureFile(base, goodClosure('rev-2', { discovered: [{ id: 'D1', verdict: 'fixed', evidence: 'src/a.txt:1' }, { id: 'D2', verdict: 'deferred', evidence: 'recorded' }, { id: 'D3', verdict: 'open', evidence: 'still implicit at src/a.txt:1' }] })), '--attempt', id]));
  assert.match(wf(root, ['accept', '--attempt', id, '--owner', OWNER]).err, /discovered D3: the reviewer found it open/);
  ownerSays(root, 'Defer ENG-700.1:D3 - the default is the documented one.');
  ok(disc(root, ['close', 'D3', '--deferred', '--attempt', id]));
  ok(wf(root, ['handoff', 'reviewer', '--agent', 'rev-3', '--attempt', id, '--owner', OWNER, '--runtime', 'codex']));
  ok(wf(root, ['review', '--closure', closureFile(base, goodClosure('rev-3', { discovered: [{ id: 'D1', verdict: 'fixed', evidence: 'src/a.txt:1' }, { id: 'D2', verdict: 'deferred', evidence: 'recorded' }, { id: 'D3', verdict: 'deferred', evidence: 'recorded' }] })), '--attempt', id]));
  ok(wf(root, ['accept', '--attempt', id, '--owner', OWNER]));

  // Delivery refuses any open entry, whenever it was recorded.
  ok(disc(root, ['add', '--attempt', id, '--summary', 'a failed Next strands the user', '--found-by', 'o']));
  const d = wf(root, ['deliver', '--attempt', id, '--owner', OWNER]);
  assert.match(d.err, /not delivered: 1 discovered issue\(s\) are open: D4 a failed Next strands the user[\s\S]*fix it in this ticket[\s\S]*--deferred` once the owner's message starts with `defer ENG-700\.1:<id>`/);
  // An owner message written before the entry existed is not a decision on it.
  assert.match(disc(root, ['close', 'D4', '--deferred', '--attempt', id]).err, /no owner message after D4 was recorded starts with `defer ENG-700\.1:D4`/);
  ownerSays(root, 'defer ENG-700.1:D4: separate ticket ENG-701, agreed.');
  ok(disc(root, ['close', 'D4', '--deferred', '--attempt', id]));
  // A refused delivery records no acknowledgement: the same command works once the cause is gone (independent review).
  commitIn(wt, { 'src/late.txt': 'x\n' }, 'late change');
  assert.match(wf(root, ['deliver', '--attempt', id, '--owner', OWNER, '--acknowledge-deferrals', 'D2,D3,D4']).err, /modified after acceptance/);
  assert.ok(state(root, id).discovered.every((x) => !x.deferred?.acknowledged), 'nothing acknowledged by a refused delivery');
  sh(wt, 'git reset -q --hard HEAD~1');
  // Second security review of 0.4.5: no channel proves a person, so every deferral is shown at delivery and counts only
  // once the owner acknowledges having seen it. Delivery refuses until then, listing each verbatim with its channel.
  const unack = wf(root, ['deliver', '--attempt', id, '--owner', OWNER]);
  assert.match(unack.err, /not delivered: 3 deferral\(s\) not acknowledged by the owner at delivery:\n {2}- D2: tables have no phone card view\n {6}owner's words: "defer ENG-700\.1:D2: park it for the mobile pass next sprint\."\n {6}channel: host-recorded \(the owner session's transcript; a process running as you could have written it\)/);
  assert.match(unack.err, /wf deliver --acknowledge-deferrals D2,D3,D4/);
  assert.match(wf(root, ['deliver', '--attempt', id, '--owner', OWNER, '--acknowledge-deferrals', 'D2,D3']).err, /not acknowledged: D4/);
  assert.match(wf(root, ['deliver', '--attempt', id, '--owner', OWNER, '--acknowledge-deferrals', 'D2,D3,D4,D9']).err, /D9 is not a deferred issue of ENG-700\.1/);
  // Delivery prints every deferral verbatim, with where it was taken from, for the owner to see.
  const delivered = ok(wf(root, ['deliver', '--attempt', id, '--owner', OWNER, '--acknowledge-deferrals', 'D2,D3,D4']));
  assert.match(delivered.out, /deferred issues \(show these to the owner: this is what was taken as their decision\):\n {2}D2 deferred \(host-recorded, .*\.jsonl:\d+\): tables have no phone card view\n {4}taken as the owner's decision: "defer ENG-700\.1:D2: park it for the mobile pass next sprint\."\n {4}channel: host-recorded/);
  const s = state(root, id);
  assert.deepEqual(s.discovered.map((x) => [x.id, x.status]), [['D1', 'fixed'], ['D2', 'deferred'], ['D3', 'deferred'], ['D4', 'deferred']]);
  assert.match(ok(wf(root, ['export', '--attempt', id, '--json'])).out, /defer ENG-700\.1:D2: park it for the mobile pass next sprint\./);
  // The tester sees each deferral, in the owner's words, among the delivered comment's known limits.
  assert.match(knownLimits(s), /- Deferred ENG-700\.1:D2: tables have no phone card view\. The owner's words: "defer ENG-700\.1:D2: park it for the mobile pass next sprint\."\. Channel: host-recorded \(the owner session's transcript; a process running as you could have written it\)\. Acknowledged by the owner at delivery\./);
  assert.ok(s.discovered.filter((x) => x.status === 'deferred').every((x) => x.deferred.acknowledged), 'each deferral is acknowledged');
});

// Reviews of 0.4.5: a quote from any owner turn let an agent lift an unrelated phrase as consent, and no word list judges
// intent ("D3 can't wait" and "won't defer D3" passed one). The owner types a fixed phrase at the start of a message:
// `defer <attempt>:<id>`; exactly one such turn after the anchor recorded with the entry, whose bytes must be unchanged.
test('0.4.5: a transcript deferral needs the exact phrase at the start of exactly one owner turn after an unchanged anchor', () => {
  const { base, root } = singleRepoProject('discovered-bind', {});
  ownerSays(root, 'Implement ENG-730.');
  const e = ok(wf(root, ['entry', '--item', 'ENG-730', '--owner', OWNER, '--json'])).json();
  const id = e.id;
  ok(wf(root, ['handoff', 'planner', '--agent', 'p', '--attempt', id, '--owner', OWNER, '--runtime', 'codex']));
  ok(wf(root, ['plan', '--file', criteriaFile(base), '--attempt', id, '--owner', OWNER]));
  ok(disc(root, ['add', '--attempt', id, '--summary', 'the export button is mislabelled']));
  assert.ok(state(root, id).discovered[0].anchor.sha256, 'the anchor is recorded with the entry');
  const close = () => disc(root, ['close', 'D1', '--deferred', '--attempt', id]);
  // Every message the review showed passing the word list, and more: none starts with the phrase.
  for (const t of ["D1 can't wait, fix it before delivery.", "Won't defer D1.", 'We shouldn’t wait on D1, fix it.', 'Do not defer ENG-730.1:D1. Fix it now.', 'Thanks. defer ENG-730.1:D1 later maybe?', 'D1: defer it to the next sprint.', '"defer ENG-730.1:D1"', 'defer ENG-730.1:D10: other entry', 'defer ENG-730.2:D1: another attempt']) ownerSays(root, t);
  ownerLine(root, { type: 'user', isCompactSummary: true, message: { role: 'user', content: 'defer ENG-730.1:D1: summary' } });
  ownerLine(root, { type: 'user', origin: { kind: 'peer' }, turnOrigin: 'peer', message: { role: 'user', content: 'defer ENG-730.1:D1: relayed' } });
  ownerLine(root, { type: 'user', turnOrigin: 'scheduled', message: { role: 'user', content: 'defer ENG-730.1:D1: scheduled' } });
  assert.match(close().err, /no owner message after D1 was recorded starts with `defer ENG-730\.1:D1`/);
  // The transcript changed before the anchor: refused.
  ownerSays(root, 'DEFER  eng-730.1:d1 : the label waits for the copy review');
  const file = ownerFile(root);
  const keep = fs.readFileSync(file);
  fs.writeFileSync(file, keep.toString('utf8').replace('Implement ENG-730.', 'Implement ENG-731.'));
  assert.match(close().err, /the owner session's transcript changed before the point where D1 was recorded/);
  fs.writeFileSync(file, keep);
  // Exactly one: a second owner turn with the phrase makes it ambiguous.
  ownerSays(root, 'defer ENG-730.1:D1');
  assert.match(close().err, /2 owner messages after D1 was recorded start with `defer ENG-730\.1:D1`/);
  fs.writeFileSync(file, keep);
  // The phrase at the start, case and spacing folded: accepted, the whole turn recorded with its reference.
  const r = ok(disc(root, ['close', 'D1', '--deferred', '--attempt', id, '--json'])).json();
  assert.equal(r.deferred.decision, 'DEFER  eng-730.1:d1 : the label waits for the copy review');
  assert.equal(r.deferred.source.provenance, 'host-recorded');
  assert.ok(r.deferred.source.offset >= r.deferred.source.anchor.size);
});

// Independent review of 0.4.5: two attempts (batch members) with the same issue id must not share a deferral.
test('0.4.5: the phrase carries the attempt id, so the same issue id in two attempts is deferred separately', () => {
  const { base, root } = singleRepoProject('discovered-two', {});
  ownerSays(root, 'Implement both.');
  const ids = ['ENG-750', 'ENG-751'].map((item) => {
    const e = ok(wf(root, ['entry', '--item', item, '--owner', OWNER, '--json'])).json();
    ok(wf(root, ['handoff', 'planner', '--agent', `p-${item}`, '--attempt', e.id, '--owner', OWNER, '--runtime', 'codex']));
    ok(wf(root, ['plan', '--file', criteriaFile(base), '--attempt', e.id, '--owner', OWNER]));
    ok(disc(root, ['add', '--attempt', e.id, '--summary', `issue in ${item}`]));
    return e.id;
  });
  ownerSays(root, `defer ${ids[0]}:D1: only this one`);
  ok(disc(root, ['close', 'D1', '--deferred', '--attempt', ids[0]]));
  assert.match(disc(root, ['close', 'D1', '--deferred', '--attempt', ids[1]]).err, new RegExp(`no owner message after D1 was recorded starts with \`defer ${ids[1].replace('.', '\\.')}:D1\``));
  assert.equal(state(root, ids[1]).discovered[0].status, 'open');
});

test('0.4.5: `wf discovered defer` runs only at an interactive terminal and needs the id typed', async () => {
  const { base, root } = singleRepoProject('discovered-tty', {});
  const e = ok(wf(root, ['entry', '--item', 'ENG-740', '--owner', 'o', '--json'])).json();
  ok(wf(root, ['handoff', 'planner', '--agent', 'p', '--attempt', e.id, '--owner', 'o']));
  ok(wf(root, ['plan', '--file', criteriaFile(base), '--attempt', e.id, '--owner', 'o']));
  ok(disc(root, ['add', '--attempt', e.id, '--summary', 's']));
  assert.match(disc(root, ['defer', 'D1', '--attempt', e.id]).err, /--reason/);
  // An agent's shell has no terminal: refused, even with the answer piped in.
  const piped = wf(root, ['discovered', 'defer', 'D1', '--reason', 'next sprint', '--attempt', e.id], { input: 'D1\n' });
  assert.notEqual(piped.code, 0);
  assert.match(piped.err, /not an interactive terminal: `wf discovered defer` is run by the owner in their own terminal/);
  assert.match(piped.err, /start a message in this session with `defer ENG-740\.1:D1: <reason>` \(then `wf discovered close D1 --deferred --attempt ENG-740\.1`\)/);
  assert.equal(state(root, e.id).discovered[0].status, 'open');
  // End of input at the prompt (Ctrl-D) is no answer: refused, nothing recorded (review of 6ca2338).
  {
    const { PassThrough } = await import('node:stream');
    const { deferInTerminal } = await import('../engine/discovered.mjs');
    const input = Object.assign(new PassThrough(), { isTTY: true, setRawMode: () => {} });
    const output = Object.assign(new PassThrough(), { isTTY: true, columns: 80 });
    const cwd = process.cwd();
    const keep = { ...process.env };
    Object.assign(process.env, { WF_EVIDENCE_FLAGS: '0', WF_CONFIG_HOME: path.join(root, '..', '.wfhome'), WF_HOME: path.join(root, '..', '.home') });
    process.chdir(root);
    try {
      const pending = deferInTerminal(root, 'D1', { attempt: e.id, reason: 'next sprint', owner: 'o' }, { input, output });
      setImmediate(() => input.end());
      await assert.rejects(pending, /not confirmed \(the input ended before D1 was typed\); nothing recorded/);
    } finally {
      process.chdir(cwd);
      for (const k of Object.keys(process.env)) if (!(k in keep)) delete process.env[k];
      Object.assign(process.env, keep);
    }
  }
  assert.equal(state(root, e.id).discovered[0].status, 'open');
  // At a terminal, the typed id confirms it. Run through util-linux `script` (Linux only: BSD `script` needs a terminal
  // of its own). This is also the documented limit: a pseudo-terminal counts as a terminal, so it proves an
  // interactive terminal, not a person.
  const hasScript = process.platform === 'linux' && spawnSync('script', ['--version'], { encoding: 'utf8' }).status === 0;
  if (!hasScript) return;
  const env = { ...process.env, WF_EVIDENCE_FLAGS: '0', WF_CONFIG_HOME: path.join(root, '..', '.wfhome'), WF_HOME: path.join(root, '..', '.home'), WF_IMPROVEMENTS_DIR: path.join(root, '..', '.improvements') };
  const q = (a) => `'${String(a).replace(/'/g, "'\\''")}'`;
  const viaTty = (typed) => spawnSync('script', ['-q', '-e', '-c', [process.execPath, WF, 'discovered', 'defer', 'D1', '--reason', 'next sprint', '--attempt', e.id].map(q).join(' '), '/dev/null'], { cwd: root, env, input: `${typed}\n`, encoding: 'utf8', timeout: 30000 });
  const wrong = viaTty('D2');
  assert.notEqual(wrong.status, 0);
  assert.match(wrong.stdout, /not confirmed/);
  const right = viaTty('D1');
  assert.equal(right.status, 0, right.stdout);
  const d = state(root, e.id).discovered[0];
  assert.deepEqual([d.status, d.deferred.decision, d.deferred.source.provenance], ['deferred', 'next sprint', 'interactive-terminal (unverified)']);
});

test('0.4.5: owner turns from a Codex rollout: user messages count; injected environment blocks and tool output do not', async () => {
  const { ownerTurns } = await import('../engine/discovered.mjs');
  const f = path.join(tmp('codex-turns'), 'rollout.jsonl');
  const at = new Date().toISOString();
  const lines = [
    { type: 'response_item', timestamp: at, payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>cwd</environment_context>' }] } },
    { type: 'response_item', timestamp: at, payload: { type: 'function_call_output', call_id: 'c', output: 'defer it, harmless' } },
    { type: 'response_item', timestamp: at, payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'I will defer it' }] } },
    { type: 'response_item', timestamp: at, payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Leave the export for next week.' }] } },
  ];
  for (const t of ['<subagent_notification>D1: defer it</subagent_notification>', '# AGENTS.md instructions for /x\nD1: defer it', '<heartbeat>D1: defer it</heartbeat>', '<user_shell_command>defer D1</user_shell_command>']) lines.splice(3, 0, { type: 'response_item', timestamp: at, payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: t }] } });
  fs.writeFileSync(f, lines.map((l) => JSON.stringify(l)).join('\n'));
  assert.deepEqual(ownerTurns({ runtime: 'codex', file: f }).map((t) => [t.text, t.line]), [['Leave the export for next week.', 8]]);
});

test('0.4.5: a deferral needs an owner session: an attempt owned by a plain id cannot defer', () => {
  const { base, root } = singleRepoProject('discovered-noowner', {});
  const e = ok(wf(root, ['entry', '--item', 'ENG-702', '--owner', 'o', '--json'])).json();
  ok(wf(root, ['handoff', 'planner', '--agent', 'p', '--attempt', e.id, '--owner', 'o']));
  ok(wf(root, ['plan', '--file', criteriaFile(base), '--attempt', e.id, '--owner', 'o']));
  // The add says at once that there is no anchor, so only the terminal channel can defer it.
  assert.match(ok(disc(root, ['add', '--attempt', e.id, '--summary', 's'])).out, /no transcript anchor: .*not a Claude Code or Codex session.*only `wf discovered defer D1` at the owner's terminal can defer it/);
  assert.match(disc(root, ['close', 'D1', '--deferred', '--attempt', e.id]).err, /not a Claude Code or Codex session[\s\S]*fix it in this ticket/);
});

function twoRepos(name) {
  const base = tmp(name);
  const root = path.join(base, 'ws');
  fs.mkdirSync(root);
  const cfg = { version: 1, enabled: true, name, adapterRepo: 'api', repos: [{ name: 'api', path: 'api', base: 'main' }, { name: 'web', path: 'web', base: 'main' }], components: [{ id: 'api', kind: 'service', repo: 'api' }, { id: 'web', kind: 'web', repo: 'web' }], lanes: ['quick', 'standard'], gate: { steps: [{ id: 'api-unit', repo: 'api', run: 'true' }, { id: 'web-unit', repo: 'web', run: 'true' }] } };
  makeRepo(path.join(root, 'api'), { '.gitignore': '.wf-evidence/\n.wf-worktrees/\n', '.workflow/project.yaml': yaml(cfg), 'src/totals.txt': 'page\n' });
  makeRepo(path.join(root, 'web'), { 'src/pager.txt': 'page\n' });
  fs.symlinkSync(path.join('api', '.workflow'), path.join(root, '.workflow'));
  return { base, root };
}

test('I-19: a discovered fix adds a repo and its work items to the running attempt in one owner step; the seam is judged on both sides', () => {
  const { base, root } = twoRepos('add-repo');
  const e = ok(wf(root, ['entry', '--item', 'ENG-710', '--repos', 'web', '--owner', 'o', '--json'])).json();
  const id = e.id;
  assert.deepEqual(Object.keys(e.repos), ['web']);
  ok(wf(root, ['handoff', 'planner', '--agent', 'plan-1', '--attempt', id, '--owner', 'o']));
  const plan = path.join(base, 'plan.json');
  fs.writeFileSync(plan, JSON.stringify({ plan: 'pager', criteria: [{ id: 'C1', text: 'the pager pages', uat: 'pages move' }], work: [{ id: 'W1', criteria: ['C1'], repos: ['web'], class: 'light', why: 'ui' }] }));
  ok(wf(root, ['plan', '--file', plan, '--attempt', id, '--owner', 'o']));
  ok(wf(root, ['handoff', 'implementer', '--work', 'W1', '--agent', 'impl-1', '--attempt', id, '--owner', 'o']));
  commitIn(e.repos.web.worktree, { 'src/pager.txt': 'pages\n' });
  ok(disc(root, ['add', '--attempt', id, '--summary', 'the total shown under the pager sums only the current page; the api must return the full total', '--found-by', 'impl-1']));

  const amend = path.join(base, 'amend.json');
  fs.writeFileSync(amend, JSON.stringify({ criteria: [{ id: 'C2', text: 'the list response carries the total over every page; existing fields, permissions and tenant isolation unchanged', uat: 'the total matches the sum of all pages' }], work: [{ id: 'W1', criteria: ['C1'], repos: ['web'], class: 'light', why: 'ui' }, { id: 'W2', criteria: ['C2'], repos: ['api'], class: 'full', why: 'the api contract' }] }));
  assert.match(wf(root, ['criteria', 'amend', '--file', amend, '--reason', 'D1 needs the api total', '--add-repo', 'nope', '--attempt', id]).err, /unknown repo `nope`/);
  assert.match(wf(root, ['criteria', 'amend', '--file', amend, '--reason', 'x', '--add-repo', 'web', '--attempt', id]).err, /web is already in ENG-710\.1/);
  const noWork = path.join(base, 'amend-nowork.json');
  fs.writeFileSync(noWork, JSON.stringify({ criteria: [{ id: 'C2', text: 't', uat: 'u' }] }));
  assert.match(wf(root, ['criteria', 'amend', '--file', noWork, '--reason', 'x', '--add-repo', 'api', '--attempt', id]).err, /no work item covers the added repo api/);
  const r = ok(wf(root, ['criteria', 'amend', '--file', amend, '--reason', 'D1 needs the api total', '--add-repo', 'api', '--attempt', id, '--owner', 'o']));
  assert.match(r.out, /repo added: api \(worktree .*ENG-710\.1\/api, base [0-9a-f]{10}\)/);
  const s = state(root, id);
  assert.deepEqual(Object.keys(s.repos).sort(), ['api', 'web']);
  assert.ok(fs.existsSync(path.join(s.repos.api.worktree, 'src', 'totals.txt')));
  assert.deepEqual(s.addedRepos.map((x) => [x.repo, x.reason]), [['api', 'D1 needs the api total']]);
  assert.match(ok(wf(root, ['resume', '--attempt', id])).out, /W2 class full .*`wf handoff implementer --work W2/);

  ok(wf(root, ['handoff', 'implementer', '--work', 'W2', '--agent', 'impl-2', '--attempt', id, '--owner', 'o']));
  commitIn(s.repos.api.worktree, { 'src/totals.txt': 'page\ntotal\n' }, 'list response carries the full total');
  const fix = sh(s.repos.api.worktree, 'git rev-parse HEAD');
  ok(disc(root, ['close', 'D1', '--fixed', fix, '--attempt', id, '--owner', 'o']));
  ok(wf(root, ['gate', '--attempt', id]));
  const h = ok(wf(root, ['handoff', 'reviewer', '--agent', 'rev-1', '--attempt', id, '--owner', 'o']));
  const bundle = bundleOf(h);
  assert.deepEqual(bundle.addedRepos.map((x) => x.repo), ['api']);
  assert.match(bundle.instructions, /seams: \[\{ repo, verdict: matched\|finding, evidence, finding \}\]/);
  const closure = (extra) => closureFile(base, goodClosure('rev-1', { criteria: [{ id: 'C1', evidence: { kind: 'output', ref: 'l' } }, { id: 'C2', evidence: { kind: 'output', ref: 'l' } }], discovered: [{ id: 'D1', verdict: 'fixed', evidence: 'api/src/totals.txt:2' }], ...extra }));
  assert.match(wf(root, ['review', '--closure', closure({}), '--attempt', id]).err, /1 repo\(s\) added during the attempt have no valid seam verdict[\s\S]*api: no verdict/);
  assert.match(wf(root, ['review', '--closure', closure({ seams: [{ repo: 'api', verdict: 'matched', evidence: 'api/src/totals.txt:2' }] }), '--attempt', id]).err, /api: `matched` needs evidence from both sides/);
  ok(wf(root, ['review', '--closure', closure({ seams: [{ repo: 'api', verdict: 'matched', evidence: 'producer api/src/totals.txt:2; consumer web/src/pager.txt:1' }] }), '--attempt', id]));
  ok(wf(root, ['accept', '--attempt', id, '--owner', 'o']));
  const d = ok(wf(root, ['deliver', '--attempt', id, '--owner', 'o']));
  assert.match(d.out, /delivered ENG-710\.1: .*api@[0-9a-f]{10}.*web@[0-9a-f]{10}|delivered ENG-710\.1: .*web@[0-9a-f]{10}.*api@[0-9a-f]{10}/);
  assert.equal(sh(path.join(root, 'api'), 'git fetch -q origin && git show origin/main:src/totals.txt'), 'page\ntotal');
});

test('I-18/I-19: role texts, the work and quick-fix skills say every issue is fixed in the ticket and fences are amended, not used to defer', () => {
  const planner = fs.readFileSync(path.join(TEMPLATES, 'planner.md'), 'utf8');
  const implementer = fs.readFileSync(path.join(TEMPLATES, 'implementer.md'), 'utf8');
  const reviewer = fs.readFileSync(path.join(TEMPLATES, 'reviewer.md'), 'utf8');
  const work = fs.readFileSync(path.join(SKILLS, 'work', 'SKILL.md'), 'utf8');
  const quick = fs.readFileSync(path.join(SKILLS, 'quick-fix', 'SKILL.md'), 'utf8');
  assert.doesNotMatch(planner, /Note follow-ups separately/);
  assert.match(planner, /Never write a blanket "no change in X" criterion/);
  assert.match(planner, /the contract seam stays matched; existing fields, permissions and tenant isolation are unchanged/);
  assert.match(implementer, /`wf discovered add/);
  assert.match(implementer, /Never defer one yourself/);
  assert.match(reviewer, /never a reason to defer or to ship a cosmetic workaround/);
  assert.match(reviewer, /"discovered": \[/);
  assert.match(reviewer, /"seams": \[/);
  for (const skill of [work, quick]) {
    assert.match(skill, /wf discovered close/);
    assert.match(skill, /amend the criteria/);
    assert.match(skill, /never .*defer/i);
  }
  assert.match(work, /--add-repo/);
});

// I-18 (extended), named failure: an implementer reported "Not fixed, outside the brief: the status field shows the
// raw enum value" and handed the issue back to the owner agent to relay. An issue found while working is fixed by the
// role that found it, in this attempt, in whatever file it lives in; the only exception is a file another work item is
// editing at that moment, recorded with that work item; and a report that leaves one unfixed without a ledger entry is
// refused at the next handoff.
const homeOf = (root) => path.join(root, '..', '.home');
function implementerReport(root, name, agentType, text) {
  const dir = path.join(homeOf(root), '.claude', 'projects', '-ws', 'owner-session', 'subagents');
  const file = `agent-${Math.random().toString(36).slice(2)}`;
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${file}.meta.json`), JSON.stringify({ name, agentType }));
  const at = new Date().toISOString();
  fs.writeFileSync(path.join(dir, `${file}.jsonl`), [{ type: 'user', timestamp: at, message: { role: 'user', content: 'Read the bundle and follow its instructions.' } }, { type: 'assistant', timestamp: at, message: { role: 'assistant', model: 'm', content: [{ type: 'text', text }] } }].map((x) => JSON.stringify(x)).join('\n'));
}

test('I-18: an implementer report that leaves an issue unfixed without a ledger entry is refused; a blocked fix names the work item editing that file', () => {
  const { base, root } = singleRepoProject('report-check', { gate: { steps: [{ id: 'unit', repo: 'app', run: 'true' }] } });
  const e = ok(wf(root, ['entry', '--item', 'ENG-720', '--owner', 'o', '--json'])).json();
  const id = e.id;
  ok(wf(root, ['handoff', 'planner', '--agent', 'plan-1', '--attempt', id, '--owner', 'o']));
  const plan = path.join(base, 'plan.json');
  fs.writeFileSync(plan, JSON.stringify({ plan: 'p', criteria: [{ id: 'C1', text: 'a', uat: 'a' }, { id: 'C2', text: 'b', uat: 'b' }], work: [{ id: 'W1', criteria: ['C1'], repos: ['app'], class: 'light', why: 'ui' }, { id: 'W2', criteria: ['C2'], repos: ['app'], class: 'full', why: 'api' }] }));
  ok(wf(root, ['plan', '--file', plan, '--attempt', id, '--owner', 'o']));
  const h1 = ok(wf(root, ['handoff', 'implementer', '--work', 'W1', '--agent', 'impl-1', '--attempt', id, '--owner', 'o']));
  ok(wf(root, ['handoff', 'implementer', '--work', 'W2', '--agent', 'impl-2', '--attempt', id, '--owner', 'o']));
  commitIn(e.repos.app.worktree, { 'src/a.txt': 'b\n' });
  const type = h1.out.match(/Start agent type (\S+)/)[1];
  implementerReport(root, 'impl-1', type, 'Done: C1 passes.\n\nNot fixed, outside the brief: the status field shows the raw enum value (src/status.tsx:12).\nNo follow-ups needed elsewhere.');
  const r = wf(root, ['handoff', 'reviewer', '--agent', 'rev-1', '--attempt', id, '--owner', 'o']);
  assert.match(r.err, /impl-1's report leaves 1 issue\(s\) unfixed without a discovered entry:\n {2}- Not fixed, outside the brief: the status field shows the raw enum value/);
  assert.doesNotMatch(r.err, /No follow-ups needed/);
  assert.match(r.err, /the implementer that found it fixes it[\s\S]*wf discovered add/);

  // The one exception: the file is another work item's at that moment. The entry names it; an unknown work item is refused.
  assert.match(disc(root, ['add', '--attempt', id, '--summary', 's', '--blocked-by', 'W9']).err, /no work item W9/);
  ok(disc(root, ['add', '--attempt', id, '--summary', 'the status field shows the raw enum value', '--where', 'src/status.tsx:12', '--found-by', 'impl-1', '--blocked-by', 'W2']));
  assert.match(ok(disc(root, ['list', '--attempt', id])).out, /D1 {2}open .* blocked by W2: route it to that work item's implementer/);
  assert.match(ok(wf(root, ['resume', '--attempt', id])).out, /D1 to the implementer of W2/);
  // A report naming the entry passes.
  implementerReport(root, 'impl-1', type, 'Done: C1 passes.\n\nD1 not fixed here: src/status.tsx is the file W2 is editing right now (recorded, blocked by W2).');
  ok(wf(root, ['handoff', 'reviewer', '--agent', 'rev-1', '--attempt', id, '--owner', 'o']));
});

test('I-18 (extended): role texts and skills say the role that found an issue fixes it, whatever the brief; the owner routes, never fixes', () => {
  const implementer = fs.readFileSync(path.join(TEMPLATES, 'implementer.md'), 'utf8');
  const reviewer = fs.readFileSync(path.join(TEMPLATES, 'reviewer.md'), 'utf8');
  const work = fs.readFileSync(path.join(SKILLS, 'work', 'SKILL.md'), 'utf8');
  const quick = fs.readFileSync(path.join(SKILLS, 'quick-fix', 'SKILL.md'), 'utf8');
  assert.match(implementer, /fixed by you, in this attempt, in whatever file it lives in/);
  assert.match(implementer, /The work-item brief is never a reason to leave it/);
  assert.match(implementer, /--blocked-by <work item>/);
  assert.doesNotMatch(implementer, /build that item only/);
  assert.match(reviewer, /the owner routes it to the implementer, never fixes it/);
  for (const skill of [work, quick]) {
    assert.match(skill, /by the role that found it/);
    assert.match(skill, /never fix it yourself/);
    assert.match(skill, /outside the brief/);
  }
});

// Independent review of 0.4.5: a batch delivery lists every member's deferrals, and each is acknowledged by its
// attempt-qualified id.
test('0.4.5: a batch delivery needs each member deferral acknowledged as <member>:<id> and lists them all', () => {
  const heavy = [{ id: 'unit', repo: 'app', run: 'true', inputs: ['src/**'] }, { id: 'e2e', repo: 'app', run: 'true', tier: 'heavy' }];
  const { base, root } = singleRepoProject('discovered-batch', { gate: { steps: heavy } }, { 'src/b.txt': 'b\n' });
  const m1 = toAccepted(root, base, { item: 'ENG-760', owner: OWNER, change: { 'src/a.txt': 'one\n' }, extraEntry: ['--defer-heavy'] });
  const m2 = toAccepted(root, base, { item: 'ENG-761', owner: OWNER, change: { 'src/b.txt': 'two\n' }, extraEntry: ['--defer-heavy'] });
  ownerSays(root, 'Deliver both together.');
  for (const m of [m1.id, m2.id]) {
    ok(disc(root, ['add', '--attempt', m, '--summary', `limit in ${m}`]));
    ownerSays(root, `defer ${m}:D1: next sprint`);
    ok(disc(root, ['close', 'D1', '--deferred', '--attempt', m]));
  }
  const b = ok(wf(root, ['batch', 'create', '--members', `${m1.id},${m2.id}`, '--owner', OWNER, '--json'])).json();
  ok(wf(root, ['gate', '--attempt', b.id]));
  ok(wf(root, ['handoff', 'reviewer', '--agent', 'rb', '--attempt', b.id, '--owner', OWNER, '--runtime', 'codex']));
  ok(wf(root, ['review', '--closure', closureFile(base, { reviewer: 'rb', findings: [], criteria: [{ id: 'B1', evidence: { kind: 'output', ref: 'batch gate' } }], screenshotsInspected: [] }), '--attempt', b.id]));
  ok(wf(root, ['accept', '--attempt', b.id, '--owner', OWNER]));
  const keys = `${m1.id}:D1,${m2.id}:D1`;
  assert.match(wf(root, ['deliver', '--attempt', b.id, '--owner', OWNER]).err, new RegExp(`--acknowledge-deferrals ${keys.replace(/\./g, '\\.')}`));
  assert.match(wf(root, ['deliver', '--attempt', b.id, '--owner', OWNER, '--acknowledge-deferrals', 'D1']).err, /D1 is not a deferred issue/);
  const d = ok(wf(root, ['deliver', '--attempt', b.id, '--owner', OWNER, '--acknowledge-deferrals', keys]));
  for (const m of [m1.id, m2.id]) {
    assert.match(d.out, new RegExp(`${m.replace('.', '\\.')}:D1 deferred \\(host-recorded, [^)]*\\): limit in ${m.replace('.', '\\.')}\\n {4}taken as the owner's decision: "defer ${m.replace('.', '\\.')}:D1: next sprint"`));
    assert.ok(state(root, m).discovered[0].deferred.acknowledged, `${m} acknowledged`);
  }
});
