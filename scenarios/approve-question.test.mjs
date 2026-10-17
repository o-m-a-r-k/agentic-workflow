import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ok, singleRepoProject, state, wf } from './helpers.mjs';
import { channelOf } from '../engine/channels.mjs';
import { append } from '../engine/ledger.mjs';

// 0.7.3, named failure (field): the person, working from the phone, could confirm no reserved decision, because `wf
// approve` needed their own terminal. An attempt whose owner session had locked itself in the evidence folder still read
// as alive, so taking it over was the person's decision, and the ticket stopped until they reached the machine. The
// person's choice (2026-10-14): their answer in the session's question panel, as the harness records it, confirms it too.

const silent = { ownerSilent: true };
const OLD = '019cdead-beef-7000-8000-00000000a001';
const CLAUDE = 'c1aude00-0000-4000-8000-00000000a002';
const CODEX = '019cdead-beef-7000-8000-00000000a003';

const at = (offsetMs = 0) => new Date(Date.now() + offsetMs).toISOString();
const homeOf = (p) => path.join(p.base, '.home');

// An owner session that wrote a moment ago: taking its attempt over is the person's decision (adopt-live).
function liveCodexOwner(p, session) {
  const file = path.join(homeOf(p), '.codex', 'sessions', `rollout-owner-${session}.jsonl`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, [{ timestamp: at(), type: 'session_meta', payload: { id: session, source: 'vscode', originator: 'Codex Desktop' } }, { timestamp: at(), type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'working' }] } }].map((r) => JSON.stringify(r)).join('\n') + '\n');
}

// Claude Code's record of a question-panel exchange: the AskUserQuestion call and, on the next user line, the answers.
function claudeAsks(p, { question, options = ['yes', 'no'], answer, when = at(1000), askedWhen = when, sidechain = false, session = CLAUDE }) {
  const file = path.join(homeOf(p), '.claude', 'projects', 'proj', `${session}.jsonl`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const id = `toolu_${Math.random().toString(36).slice(2)}`;
  const lines = [
    { type: 'assistant', isSidechain: sidechain, timestamp: askedWhen, message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'AskUserQuestion', input: { questions: [{ question, header: 'wf', multiSelect: false, options: options.map((label) => ({ label, description: label })) }] } }] } },
    { type: 'user', isSidechain: sidechain, timestamp: when, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: `Your questions have been answered: "${question}"="${answer}".` }] }, toolUseResult: { questions: [], answers: { [question]: answer } } },
  ];
  fs.appendFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
}

const adopt = (p, id, env) => wf(p.root, ['adopt', '--attempt', id, '--reason', 'the owner session cannot act', '--json'], { env, ...silent });
const approveQ = (p, id, decision, env) => wf(p.root, ['approve', decision, '--from-question', '--attempt', id], { env, ...silent });

test('the person confirms adopting a live owner\'s attempt in the question panel; the harness-recorded answer is the approval', () => {
  const p = singleRepoProject('approve-q-adopt', {});
  const e = ok(wf(p.root, ['entry', '--item', 'ENG-930', '--owner', `codex:${OLD}`, '--json'], silent)).json();
  liveCodexOwner(p, OLD);
  const env = { CLAUDE_CODE_SESSION_ID: CLAUDE };
  const refused = adopt(p, e.id, env);
  assert.equal(refused.code, 75);
  const d = state(p.root, e.id).decisions.find((x) => x.kind === 'adopt-live');
  const question = `${e.id} ${d.id}: ${d.plain ?? d.summary}`;
  assert.ok(refused.err.includes(`the question "${question}"`), 'the refusal gives the exact question to ask');
  assert.match(refused.err, new RegExp(`wf approve ${d.id} --from-question --attempt ${e.id.replace('.', '\\.')}`));

  claudeAsks(p, { question, options: ['yes (Recommended)', 'no'], answer: 'yes (Recommended)' });
  const approved = ok(approveQ(p, e.id, d.id, env));
  assert.match(approved.out, new RegExp(`${d.id} decided: yes`));
  const recorded = state(p.root, e.id).decisions.find((x) => x.id === d.id).approved;
  assert.equal(recorded.choice, 'yes');
  assert.match(recorded.via, /^question-panel \(Claude Code, host-recorded\)$/);

  ok(adopt(p, e.id, env));
  assert.equal(state(p.root, e.id).owner, `claude:${CLAUDE}`);
});

test('an answer counts only when bound to the decision, offered its choices, given after it, in the session\'s own panel', () => {
  const p = singleRepoProject('approve-q-bind', {});
  const e = ok(wf(p.root, ['entry', '--item', 'ENG-931', '--json'], silent)).json();
  ok(wf(p.root, ['hold', '--reason', 'wait for the owner', '--attempt', e.id], silent));
  const before = at(-60_000);
  assert.equal(wf(p.root, ['release', '--attempt', e.id], silent).code, 75);
  const d = state(p.root, e.id).decisions[0];
  const question = `${e.id} ${d.id}: ${d.plain ?? d.summary}`;
  const env = { CLAUDE_CODE_SESSION_ID: CLAUDE };
  const refusedWith = (re, msg) => {
    const r = approveQ(p, e.id, d.id, env);
    assert.equal(r.code, 75, msg);
    assert.match(r.err, re, msg);
    assert.equal(state(p.root, e.id).decisions[0].approved, null, msg);
  };

  const transcript = path.join(homeOf(p), '.claude', 'projects', 'proj', `${CLAUDE}.jsonl`);
  fs.mkdirSync(path.dirname(transcript), { recursive: true });
  // A "yes" typed to no message that asked the question answers nothing. (0.7.27, D41: words naming what the decision does,
  // "lift the hold", are the person's answer whatever came before them; scenarios below.)
  fs.writeFileSync(transcript, JSON.stringify({ type: 'user', timestamp: at(1000), message: { role: 'user', content: 'yes, go ahead with A1' } }) + '\n');
  refusedWith(/no answer to A1 in this session's question panel/, 'the person typed yes in the chat, to no message that asked it');
  // I-135: a panel that showed nothing is not the end of the road: the reply explains the decision, and the terminal route is given.
  refusedWith(/say in your reply, in plain words, what this decides, why, and what happens after each choice \(a question panel may not show, and its acceptance proves nothing\)/, 'the decision is explained in the reply');
  refusedWith(/ask them in your message, quoting the question ".*" exactly with its options .* so they can type the answer \(you may also show it in your question panel: a typed reply and a panel answer both count\)/, 'the chat route is given first');
  refusedWith(new RegExp(`or they run \`wf approve A1 --attempt ${e.id.replace('.', '\\.')}\` in their own terminal`), 'the terminal route is given');
  claudeAsks(p, { question: `${e.id} ${d.id}: lift it?`, answer: 'yes' });
  refusedWith(/no answer to A1/, 'the question does not say what the decision does');
  claudeAsks(p, { question: `${d.id}: ${d.plain ?? d.summary}`, answer: 'yes' });
  refusedWith(/no answer to A1/, 'the question does not name the attempt');
  claudeAsks(p, { question, options: ['yes', 'no', 'yes and delete the branch'], answer: 'yes' });
  refusedWith(/no answer to A1/, 'other options were offered');
  claudeAsks(p, { question, answer: 'yes', when: before });
  refusedWith(/no answer to A1/, 'answered before the decision existed');
  claudeAsks(p, { question, answer: 'yes', askedWhen: before });
  refusedWith(/no answer to A1/, 'asked before the decision existed, answered after');
  claudeAsks(p, { question: `${e.id} ${d.id}0: ${d.plain ?? d.summary} (another decision)`, answer: 'yes' });
  refusedWith(/no answer to A1/, 'a question for A10 is not one for A1');
  claudeAsks(p, { question: `X${question}`, answer: 'yes' });
  refusedWith(/no answer to A1/, 'another attempt whose id ends the same');
  claudeAsks(p, { question, answer: 'yes', sidechain: true });
  refusedWith(/no answer to A1/, 'a sub-agent line is not the session\'s panel');
  claudeAsks(p, { question, answer: 'yes', session: 'c1aude00-0000-4000-8000-0000000000ff' });
  refusedWith(/no answer to A1/, 'another session\'s panel');

  const outside = approveQ(p, e.id, d.id, {});
  assert.equal(outside.code, 75);
  assert.match(outside.err, /--from-question reads the question panel of the agent session that runs it/);

  // The person's "no" is recorded as theirs; the command stays refused, and the same question is not asked again until the
  // answer is withdrawn with what changed (0.7.23).
  claudeAsks(p, { question, answer: 'no' });
  assert.match(ok(approveQ(p, e.id, d.id, env)).out, /A1 decided: no/);
  assert.match(wf(p.root, ['release', '--attempt', e.id], silent).err, /the person answered A1 "Keep it paused"/);
  assert.ok(state(p.root, e.id).activeHold, 'a "no" never lifts the hold');
  assert.equal(state(p.root, e.id).decisions.length, 1);
  ok(wf(p.root, ['decisions', 'withdraw', d.id, '--reason', 'they are back', '--attempt', e.id]));
  assert.equal(wf(p.root, ['release', '--attempt', e.id], silent).code, 75);
  const again = state(p.root, e.id).decisions.at(-1);
  assert.notEqual(again.id, d.id);

  // Typed text that is not a choice (the panel's free-text option) is the person's answer too (0.7.8): recorded as `other` with
  // their words, it is answered and nothing more. It confirms nothing a choice would, so the hold stays and the next ask names it.
  claudeAsks(p, { question: `${e.id} ${again.id}: ${again.plain ?? again.summary}`, answer: 'only on Monday' });
  const worded = ok(approveQ(p, e.id, again.id, env));
  assert.match(worded.out, /A2 decided: in the person's own words: "only on Monday" \(follow them; it grants nothing a choice would\)/);
  const own = state(p.root, e.id).decisions.find((x) => x.id === again.id).approved;
  assert.deepEqual([own.choice, own.words], ['other', 'only on Monday']);
  assert.match(own.via, /^question-panel \(Claude Code, host-recorded\)$/);
  const waits = wf(p.root, ['release', '--attempt', e.id], silent);
  assert.equal(waits.code, 75);
  assert.match(waits.err, /the person answered A2 in their own words, "only on Monday"/);
  assert.ok(state(p.root, e.id).activeHold, 'their own words never lift the hold');
  ok(wf(p.root, ['decisions', 'withdraw', again.id, '--reason', 'it is Monday', '--attempt', e.id]));
  assert.equal(wf(p.root, ['release', '--attempt', e.id], silent).code, 75);
  const third = state(p.root, e.id).decisions.at(-1);
  assert.notEqual(third.id, again.id);
  claudeAsks(p, { question: `${e.id} ${third.id}: ${third.plain ?? third.summary}`, answer: 'yes' });
  ok(approveQ(p, e.id, third.id, env));
  ok(wf(p.root, ['release', '--attempt', e.id], silent));
  assert.equal(state(p.root, e.id).activeHold, null);
});

test('Codex: a question-panel reply bound to its request_user_input call confirms; a reply in a non-interactive run does not', () => {
  const p = singleRepoProject('approve-q-codex', {});
  const e = ok(wf(p.root, ['entry', '--item', 'ENG-932', '--json'], silent)).json();
  ok(wf(p.root, ['hold', '--reason', 'wait', '--attempt', e.id], silent));
  assert.equal(wf(p.root, ['release', '--attempt', e.id], silent).code, 75);
  const d = state(p.root, e.id).decisions[0];
  const question = `${e.id} ${d.id}: ${d.plain ?? d.summary}`;
  const file = path.join(homeOf(p), '.codex', 'sessions', '2026', '10', '14', `rollout-q-${CODEX}.jsonl`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const write = (source) => {
    const call = `call_${Math.random().toString(36).slice(2)}`;
    const reply = JSON.stringify([{ questionItemId: JSON.stringify(['request_user_input', call, 0]), question, answer: 'yes' }]);
    fs.writeFileSync(file, [
      { timestamp: at(), type: 'session_meta', payload: { id: CODEX, source, originator: source === 'exec' ? 'codex_exec' : 'Codex Desktop' } },
      { timestamp: at(500), type: 'response_item', payload: { type: 'function_call', name: 'request_user_input', call_id: call, arguments: JSON.stringify({ questions: [{ question, options: [{ label: 'yes' }, { label: 'no' }] }] }) } },
      { timestamp: at(1000), type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: `<send_user_message_question_reply>${reply}</send_user_message_question_reply>` }] } },
    ].map((r) => JSON.stringify(r)).join('\n') + '\n');
  };
  const env = { CODEX_THREAD_ID: CODEX };
  write('exec');
  assert.match(approveQ(p, e.id, d.id, env).err, /no answer to A1/, 'a codex exec run has no person to answer');
  write('vscode');
  assert.match(ok(approveQ(p, e.id, d.id, env)).out, /A1 decided: yes/);
  assert.match(state(p.root, e.id).decisions[0].approved.via, /^question-panel \(Codex, host-recorded\)$/);
});

test('a deferral the person confirmed in the question panel says so wherever it is listed', () => {
  const p = singleRepoProject('approve-q-defer', {});
  const e = ok(wf(p.root, ['entry', '--item', 'ENG-933', '--json'], silent)).json();
  // Only a low issue may leave the delivery (D17), and only with the person's answer to its own question (D18): the channel of
  // that answer is what is listed.
  ok(wf(p.root, ['discovered', 'add', '--attempt', e.id, '--summary', 'tables have no phone card view', '--severity', 'low'], silent));
  assert.equal(wf(p.root, ['discovered', 'close', 'D1', '--deferred', '--reason', 'the mobile pass', '--attempt', e.id], silent).code, 75);
  const d = state(p.root, e.id).decisions[0];
  assert.deepEqual([d.key, d.choices], ['leave:D1', ['let it leave', 'fix now']]);
  const env = { CLAUDE_CODE_SESSION_ID: CLAUDE };
  claudeAsks(p, { question: `${e.id} ${d.id}: ${d.plain ?? d.summary}`, options: d.choices, answer: 'let it leave' });
  ok(approveQ(p, e.id, d.id, env));
  ok(wf(p.root, ['discovered', 'close', 'D1', '--deferred', '--reason', 'the mobile pass', '--attempt', e.id], silent));
  assert.match(ok(wf(p.root, ['discovered', 'list', '--attempt', e.id], silent)).out, /deferred \(approved-decision \(answered by the person in the question panel; the harness recorded the answer, not a signature\)\)/);
});

// 0.7.18 (D26), named failure (field): a person on the phone got no question panel and answered "Yes" in the chat twice; the
// engine read neither, the agent merged around the workflow, and closing the ticket then needed one more answer they could
// not give. Their chat reply now confirms, bound to the agent's message just before it when that message asks exactly the
// decision's question and no other open one.
function claudeChat(p, { said, reply, saidWhen = at(500), when = at(1000), session = CLAUDE }) {
  const file = path.join(homeOf(p), '.claude', 'projects', 'proj', `${session}.jsonl`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, [
    { type: 'assistant', timestamp: saidWhen, message: { role: 'assistant', content: [{ type: 'text', text: said }] } },
    { type: 'user', timestamp: when, message: { role: 'user', content: reply } },
  ].map((l) => JSON.stringify(l)).join('\n') + '\n');
}

test('chat: the person\'s reply to a message asking exactly the decision\'s question confirms it; an unbound or ambiguous reply does not', () => {
  const p = singleRepoProject('approve-chat', {});
  const e = ok(wf(p.root, ['entry', '--item', 'ENG-940', '--owner', `codex:${OLD}`, '--json'], silent)).json();
  liveCodexOwner(p, OLD);
  ok(wf(p.root, ['hold', '--reason', 'wait', '--attempt', e.id], silent));
  const asked = wf(p.root, ['release', '--attempt', e.id], silent);
  assert.equal(asked.code, 75);
  assert.match(asked.err, /then ask them in your message, so they can simply type their answer: quote the question ".*" exactly with these options/);
  assert.match(asked.err, /You may also show the same question and options in your question panel: a typed reply and a panel answer both count/);
  const d = state(p.root, e.id).decisions[0];
  const question = `${e.id} ${d.id}: ${d.plain ?? d.summary}`;
  const env = { CLAUDE_CODE_SESSION_ID: CLAUDE };
  // A "yes" to a message that does not carry the question binds to nothing.
  claudeChat(p, { said: 'Shall I go ahead and finish the delivery?', reply: 'Yes' });
  assert.match(approveQ(p, e.id, d.id, env).err, /no answer to A1 in this session's question panel, or in its chat to a message asking exactly its question/);
  // A message that also carries another open decision's question binds no reply to either.
  // A second open decision: taking over the live owner's attempt.
  assert.equal(adopt(p, e.id, env).code, 75);
  const other = state(p.root, e.id).decisions.find((x) => x.id !== d.id && !x.approved);
  assert.ok(other, "a second open decision exists");
  {
    claudeChat(p, { said: `Two questions.\n${question}\n${e.id} ${other.id}: ${other.plain ?? other.summary}`, reply: 'yes', saidWhen: at(1500), when: at(2000) });
    assert.match(approveQ(p, e.id, d.id, env).err, /no answer to A1/);
  }
  // The question quoted exactly, its options listed, and the person's reply in their own words starting with a choice.
  claudeChat(p, { said: `Lifting the hold lets the work continue.\n\n${question}\n\nOptions: yes / no`, reply: 'Yes, go ahead', saidWhen: at(2500), when: at(3000) });
  assert.match(ok(approveQ(p, e.id, d.id, env)).out, /A1 decided: yes/);
  const recorded = state(p.root, e.id).decisions.find((x) => x.id === d.id).approved;
  assert.equal(recorded.choice, 'yes');
  assert.match(recorded.via, /^chat \(Claude Code, host-recorded\)$/);
});

test('chat on Codex: a reply after the agent\'s message with the exact question confirms; a word that only starts like a choice is no answer', () => {
  const p = singleRepoProject('approve-chat-codex', {});
  const e = ok(wf(p.root, ['entry', '--item', 'ENG-941', '--json'], silent)).json();
  ok(wf(p.root, ['hold', '--reason', 'wait', '--attempt', e.id], silent));
  assert.equal(wf(p.root, ['release', '--attempt', e.id], silent).code, 75);
  const d = state(p.root, e.id).decisions[0];
  const question = `${e.id} ${d.id}: ${d.plain ?? d.summary}`;
  const file = path.join(homeOf(p), '.codex', 'sessions', '2026', '10', '16', `rollout-chat-${CODEX}.jsonl`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const write = (reply) => fs.writeFileSync(file, [
    { timestamp: at(), type: 'session_meta', payload: { id: CODEX, source: 'vscode', originator: 'Codex Desktop' } },
    { timestamp: at(200), type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>cwd</environment_context>' }] } },
    { timestamp: at(500), type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: `The panel did not reach you, so here it is.\n\n${question}\n\nOptions: yes / no` }] } },
    { timestamp: at(1000), type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: reply }] } },
  ].map((r) => JSON.stringify(r)).join('\n') + '\n');
  const env = { CODEX_THREAD_ID: CODEX };
  // "yesterday" is not "yes", and since 0.7.27 (I-192) a reply that names none of the options speaks of something else: it is no
  // answer, not the person's own words for this one.
  write('yesterday was fine');
  assert.match(approveQ(p, e.id, d.id, env).err, /no answer to A1/);
  assert.equal(state(p.root, e.id).decisions[0].approved, null, '"yesterday" is not "yes"');
  write('yes');
  assert.match(ok(approveQ(p, e.id, d.id, env)).out, /A1 decided: yes/);
});

// Independent review of 0.7.18: the binding as agents and harnesses really write it.
function claudeLines(p, lines, session = CLAUDE) {
  const file = path.join(homeOf(p), '.claude', 'projects', 'proj', `${session}.jsonl`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
}
const says = (text, when) => ({ type: 'assistant', timestamp: when, message: { role: 'assistant', content: [{ type: 'text', text }] } });
const tool = (when) => ({ type: 'assistant', timestamp: when, message: { role: 'assistant', content: [{ type: 'tool_use', id: `toolu_${Math.random().toString(36).slice(2)}`, name: 'Bash', input: { command: 'wf status' } }] } });
const types = (content, when, extra = {}) => ({ type: 'user', timestamp: when, message: { role: 'user', content }, ...extra });
function heldAttempt(name, item) {
  const p = singleRepoProject(name, {});
  const e = ok(wf(p.root, ['entry', '--item', item, '--json'], silent)).json();
  ok(wf(p.root, ['hold', '--reason', 'wait', '--attempt', e.id], silent));
  assert.equal(wf(p.root, ['release', '--attempt', e.id], silent).code, 75);
  const d = state(p.root, e.id).decisions[0];
  return { p, e, d, question: `${e.id} ${d.id}: ${d.plain ?? d.summary}` };
}
const env = { CLAUDE_CODE_SESSION_ID: CLAUDE };

test('chat binding: quoted, bold or code questions bind; harness lines are never the person; a reply-to quote is the person\'s reply', () => {
  for (const [i, wrap] of [(q) => `"${q}"`, (q) => `**${q}**`, (q) => `\`${q}\``].entries()) {
    const { p, e, d, question } = heldAttempt(`chat-wrap-${i}`, `ENG-95${i}`);
    claudeLines(p, [
      says(`Lifting the hold lets work continue.\n\n${wrap(question)}\n\nyes / no`, at(500)),
      types('<task-notification>\n<task-id>x</task-id>\n<status>completed</status>\n</task-notification>', at(600)),
      types([{ type: 'text', text: '[Request interrupted by user]' }], at(650)),
      types('This session is being continued from a previous conversation.', at(660), { isCompactSummary: true }),
      types(i === 2 ? '<!-- reply 1 -->\n> Lifting the hold lets work continue.\n\nyes' : 'yes', at(1000)),
    ]);
    assert.match(ok(approveQ(p, e.id, d.id, env)).out, /A1 decided: yes/, `bound when the question is wrapped as ${wrap('Q')}`);
  }
});

test('chat binding: every turn of the person\'s ends the message; only the final reply after the last tool call is the message', () => {
  // A slash command between the question and an unrelated "yes" ends the message the question was in.
  let t = heldAttempt('chat-turn', 'ENG-960');
  claudeLines(t.p, [says(`${t.question}\n\nyes / no`, at(500)), types('<command-name>/status</command-name>', at(600)), says('Shall I also update the README?', at(700)), types('yes', at(1000))]);
  assert.match(approveQ(t.p, t.e.id, t.d.id, env).err, /no answer to A1/);
  // A question written between tool calls is not the message the person answers.
  t = heldAttempt('chat-midturn', 'ENG-961');
  claudeLines(t.p, [says(`${t.question}\n\nyes / no`, at(500)), tool(at(600)), says('Waiting for the gate.', at(700)), types('yes', at(1000))]);
  assert.match(approveQ(t.p, t.e.id, t.d.id, env).err, /no answer to A1/);
  // A message that also names another attempt's decision binds to neither.
  t = heldAttempt('chat-other-attempt', 'ENG-962');
  claudeLines(t.p, [says(`${t.question}\nENG-999.1 A1: close ENG-999.1\n\nyes / no`, at(500)), types('yes', at(1000))]);
  assert.match(approveQ(t.p, t.e.id, t.d.id, env).err, /no answer to A1/);
});

test('chat choice: a reply that takes it back is the person\'s words; a condition is kept beside the choice', () => {
  let t = heldAttempt('chat-retract', 'ENG-970');
  claudeLines(t.p, [says(`${t.question}\n\nyes / no`, at(500)), types('yes, actually no', at(1000))]);
  assert.match(ok(approveQ(t.p, t.e.id, t.d.id, env)).out, /A1 decided: in the person's own words: "yes, actually no"/);
  // 0.7.23: a condition that moves the action in time ("only after the failing test is fixed") can turn the answer around,
  // so it is the person's words; one that does not move it stays beside the choice.
  t = heldAttempt('chat-condition', 'ENG-971');
  claudeLines(t.p, [says(`${t.question}\n\nyes / no`, at(500)), types('Yes, but keep the old export button visible', at(1000))]);
  assert.match(ok(approveQ(t.p, t.e.id, t.d.id, env)).out, /A1 decided: yes \(their reply: "Yes, but keep the old export button visible"; follow any condition in it\)/);
  assert.equal(state(t.p.root, t.e.id).decisions[0].approved.reply, 'Yes, but keep the old export button visible');
  t = heldAttempt('chat-condition-time', 'ENG-972');
  claudeLines(t.p, [says(`${t.question}\n\nyes / no`, at(500)), types('Yes, but only after the failing test is fixed', at(1000))]);
  assert.match(ok(approveQ(t.p, t.e.id, t.d.id, env)).out, /A1 decided: in the person's own words: "Yes, but only after the failing test is fixed"/);
  assert.match(channelOf({ deferred: { source: { provenance: 'approved-decision', via: 'chat (Claude Code, host-recorded)' } } }), /answered by the person in the chat/);
});

test('chat on Codex: a reply after a panel the person never saw binds to its question; a panel answer ends the message; a sub-agent thread is not the person', () => {
  const t = heldAttempt('chat-codex-panel', 'ENG-980');
  const meta = (extra = {}) => ({ timestamp: at(), type: 'session_meta', payload: { id: CODEX, source: 'vscode', originator: 'Codex Desktop', ...extra } });
  const panel = (call) => ({ timestamp: at(400), type: 'response_item', payload: { type: 'function_call', name: 'request_user_input_async', call_id: call, arguments: JSON.stringify({ questions: [{ title: t.question, options: [{ label: 'yes' }, { label: 'no' }] }] }) } });
  const user = (text, when) => ({ timestamp: when, type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } });
  const agent = (text, when) => ({ timestamp: when, type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] } });
  const write = (pp, rows) => {
    const file = path.join(homeOf(pp), '.codex', 'sessions', '2026', '10', '16', `rollout-panel-${CODEX}.jsonl`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  };
  const codexEnv = { CODEX_THREAD_ID: CODEX };
  // A sub-agent's thread: its "user" is the parent agent.
  write(t.p, [meta({ parent_thread_id: 'parent' }), panel('c0'), user('yes', at(1000))]);
  assert.match(approveQ(t.p, t.e.id, t.d.id, codexEnv).err, /no answer to A1/);
  // The panel answered "no", then an unrelated "yes" in the chat: the "no" stands.
  const reply = JSON.stringify([{ questionItemId: JSON.stringify(['request_user_input_async', 'c1', 0]), question: t.question, answer: 'no' }]);
  write(t.p, [meta(), panel('c1'), user(`<send_user_message_question_reply>${reply}</send_user_message_question_reply>`, at(800)), agent('You said no. Shall I write up the blocker?', at(900)), user('yes', at(1000))]);
  assert.match(ok(approveQ(t.p, t.e.id, t.d.id, codexEnv)).out, /A1 decided: no/);
  // The field case: the panel never showed; the person typed "Yes" in the chat.
  const u = heldAttempt('chat-codex-field', 'ENG-981');
  write(u.p, [meta(), { ...panel('c2'), payload: { ...panel('c2').payload, arguments: JSON.stringify({ questions: [{ title: u.question, options: [{ label: 'yes' }, { label: 'no' }] }] }) } }, user('Yes', at(1000))]);
  assert.match(ok(approveQ(u.p, u.e.id, u.d.id, codexEnv)).out, /A1 decided: yes/);
  assert.match(state(u.p.root, u.e.id).decisions[0].approved.via, /^chat \(Codex, host-recorded\)$/);
});

test('chat on Claude Code: a panel answer ends the message, so a later "yes" never outranks it; "decision A1:" in the agent\'s words still binds', () => {
  const t = heldAttempt('chat-claude-panel', 'ENG-990');
  const id = 'toolu_panel_ans';
  claudeLines(t.p, [
    says('Lifting the hold lets work continue.', at(300)),
    { type: 'assistant', timestamp: at(400), message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'AskUserQuestion', input: { questions: [{ question: t.question, header: 'wf', multiSelect: false, options: [{ label: 'yes', description: '' }, { label: 'no', description: '' }] }] } }] } },
    types([{ type: 'tool_result', tool_use_id: id, content: `Your questions have been answered: "${t.question}"="no".` }], at(800), { toolUseResult: { answers: { [t.question]: 'no' } } }),
    says('You said no, so the hold stays. Shall I write up the blocker?', at(900)),
    types('yes', at(1000)),
  ]);
  assert.match(ok(approveQ(t.p, t.e.id, t.d.id, env)).out, /A1 decided: no/);
  assert.match(state(t.p.root, t.e.id).decisions[0].approved.via, /^question-panel/);
  // A panel the person dismissed (no answers recorded) leaves the question standing: their typed reply answers it.
  const w = heldAttempt('chat-claude-dismissed', 'ENG-992');
  const dismissed = 'toolu_panel_dismissed';
  claudeLines(w.p, [
    { type: 'assistant', timestamp: at(400), message: { role: 'assistant', content: [{ type: 'tool_use', id: dismissed, name: 'AskUserQuestion', input: { questions: [{ question: w.question, header: 'wf', multiSelect: false, options: [{ label: 'yes', description: '' }, { label: 'no', description: '' }] }] } }] } },
    types([{ type: 'tool_result', tool_use_id: dismissed, is_error: true, content: 'The user did not answer.' }], at(800)),
    types('yes', at(1000)),
  ]);
  assert.match(ok(approveQ(w.p, w.e.id, w.d.id, env)).out, /A1 decided: yes/);
  assert.match(state(w.p.root, w.e.id).decisions[0].approved.via, /^chat \(Claude Code, host-recorded\)$/);
  // The agent's own label for the decision is not another decision's key; a bare "Yes." keeps no reply beside the choice.
  const u = heldAttempt('chat-claude-label', 'ENG-991');
  claudeLines(u.p, [says(`Reserved decision A1: lifting the hold lets the planner start.\n\n"${u.question}"\n\nOption A1: yes, lift it / no`, at(500)), types('Yes.', at(1000))]);
  assert.match(ok(approveQ(u.p, u.e.id, u.d.id, env)).out, /^A1 decided: yes\. next:/m);
  assert.equal(state(u.p.root, u.e.id).decisions[0].approved.reply, undefined);
});

// 0.7.23, the person's rule: "why are you stopping me from just typing no, why do i have to answer the questionnaire? both
// should be accepted". Named failure (field): the person typed "ok fix all and continue" to the round-limit question; the
// session had explained the question in its own words, and the reply did not start with a choice, so it was refused twice and
// the session put the question panel in front of them.
test('typed replies: one that names an option anywhere confirms it, with the rest kept; without the question quoted, only an option named plainly binds', () => {
  const p = singleRepoProject('approve-typed', {});
  const e = ok(wf(p.root, ['entry', '--item', 'ENG-950', '--json'], silent)).json();
  ok(wf(p.root, ['hold', '--reason', 'wait for the store review', '--attempt', e.id], silent));
  assert.equal(wf(p.root, ['release', '--attempt', e.id], silent).code, 75);
  const d = state(p.root, e.id).decisions[0];
  const env = { CLAUDE_CODE_SESSION_ID: CLAUDE };
  // The session explained the question in its own words: a bare "yes" says nothing about which question it answers.
  claudeChat(p, { said: 'The store review came back. Want me to carry on?', reply: 'yes' });
  assert.match(approveQ(p, e.id, d.id, env).err, /no answer to A1/);
  // A message that never names the decision binds no option's short name or bare choice ("carry on" is no name of this one).
  // (0.7.27, D41: a reply naming the decision's own action, "lift the pause", binds whatever the message said: below.)
  claudeChat(p, { said: 'The store review came back. Should the pause end?', reply: 'ok carry on then', saidWhen: at(1200), when: at(1400) });
  assert.match(approveQ(p, e.id, d.id, env).err, /no answer to A1/);
  // A reply that negates the option it names is the person's words, not that option.
  claudeChat(p, { said: `About ${e.id} ${d.id}: the store review came back. Should the pause end?`, reply: "don't lift the pause yet", saidWhen: at(1500), when: at(2000) });
  assert.match(approveQ(p, e.id, d.id, env).err, /no answer to A1/);
  // Naming the option plainly binds when the message named the decision in the session's own words, and the rest of the
  // reply is kept beside it.
  claudeChat(p, { said: `About ${e.id} ${d.id}: the store review came back. Should the pause end?`, reply: 'ok lift the pause and ship it', saidWhen: at(2500), when: at(3000) });
  const typed = ok(approveQ(p, e.id, d.id, env));
  assert.match(typed.out, /A1 decided: yes \(their reply: "ok lift the pause and ship it"; follow any condition in it\)/);
  const recorded = state(p.root, e.id).decisions[0].approved;
  assert.deepEqual([recorded.choice, recorded.reply], ['yes', 'ok lift the pause and ship it']);
  assert.match(recorded.via, /^chat, the question not quoted \(Claude Code, host-recorded\)$/);

  // With the question quoted, "ok" and "nope" are answers, and a question back is not.
  const q = singleRepoProject('approve-typed-quoted', {});
  const f = ok(wf(q.root, ['entry', '--item', 'ENG-951', '--json'], silent)).json();
  ok(wf(q.root, ['hold', '--reason', 'wait', '--attempt', f.id], silent));
  assert.equal(wf(q.root, ['release', '--attempt', f.id], silent).code, 75);
  const g = state(q.root, f.id).decisions[0];
  const question = `${f.id} ${g.id}: ${g.plain}`;
  claudeChat(q, { said: question, reply: 'ok but why now?' });
  assert.match(approveQ(q, f.id, g.id, env).out, /A1 decided: in the person's own words: "ok but why now\?"/);
  ok(wf(q.root, ['decisions', 'withdraw', g.id, '--reason', 'answered their question', '--attempt', f.id]));
  assert.equal(wf(q.root, ['release', '--attempt', f.id], silent).code, 75);
  const h = state(q.root, f.id).decisions.at(-1);
  claudeChat(q, { said: `${f.id} ${h.id}: ${h.plain}`, reply: 'nope', saidWhen: at(1500), when: at(2000) });
  assert.match(ok(approveQ(q, f.id, h.id, env)).out, /A2 decided: no/);
});

// 0.7.27 (I-192, D41), named failure (field): the person's clear answer in their own words was refused. A decision `wf close
// --shipped` had created under 0.7.17 (no aliases, labels or plain words) was asked exactly, with yes and no, on day 1, and the
// person did not answer that day. On day 2 the harness put its context and the page open beside the chat before their first
// message, the agent described the closure as what remained in its own words, and the person replied "ok we can close this
// then. ticket is on done? and clean up completed?". `wf approve --from-question` refused it (no-answer): the message before it
// did not quote or name the decision, the two questions about other things made the whole reply a question back, and "close
// this" was no name the engine gave the option. The agent then ended its turn without asking anything.
const DAY = 24 * 3600 * 1000;
const shippedSummary = (id) => `close ${id} as shipped without its acceptance (app 1a2b3c4d5e (worktree) on origin/main)`;
// A close-shipped decision as 0.7.17 recorded it: kind and key, summary, choices, nothing else.
function legacyClose(p, attempt, n = 1, hash = 'feedface00000001') {
  append(p.root, attempt, 'decision.created', { id: `A${n}`, kind: 'override-gate', key: `close-shipped:${attempt}:${hash}`, summary: shippedSummary(attempt), choices: ['yes', 'no'] }, 'human:scenario');
  return state(p.root, attempt).decisions.find((x) => x.id === `A${n}`);
}
const FIELD_REPLY = 'ok we can close this then. ticket is on done? and clean up completed?';
// The day-1/day-2 shape of the field transcript, anonymized: Codex Desktop items as the harness writes them.
function codexDays(p, attempt, d, { reply = FIELD_REPLY, day2Agent = true } = {}) {
  const item = (payload, ms, extra = {}) => ({ timestamp: at(ms), type: 'response_item', payload: { ...payload, ...extra } });
  const kinds = (k) => ({ internal_chat_message_metadata_passthrough: { turn_id: 't', content_item_kinds: [k] } });
  const user = (text, ms, k = 'user.text') => item({ type: 'message', role: 'user', content: [{ type: 'input_text', text }] }, ms, kinds(k));
  const dev = (text, ms, k) => item({ type: 'message', role: 'developer', content: [{ type: 'input_text', text }] }, ms, kinds(k));
  const agent = (text, ms, phase = 'final_answer') => item({ type: 'message', role: 'assistant', phase, content: [{ type: 'output_text', text }] }, ms, kinds('unknown'));
  const tool = (ms) => [item({ type: 'custom_tool_call', name: 'exec', call_id: `c${ms}`, input: 'wf status' }, ms), item({ type: 'custom_tool_call_output', call_id: `c${ms}`, output: [{ type: 'input_text', text: 'ok' }] }, ms + 50)];
  const done = (ms) => ({ timestamp: at(ms), type: 'event_msg', payload: { type: 'task_complete' } });
  const rows = [
    { timestamp: at(), type: 'session_meta', payload: { id: CODEX, source: 'vscode', originator: 'Codex Desktop' } },
    ...tool(400),
    agent(`Chat approval is supported. **Yes** closes the merged ticket's bookkeeping and removes its working folders; **no** leaves it open.\n\n> ${attempt} ${d.id}: ${d.summary}\n\n- **yes**\n- **no**`, 700),
    done(800),
    user('# AGENTS.md instructions for the project\n\n<INSTRUCTIONS>project rules</INSTRUCTIONS>', DAY, 'agents_md.instructions'),
    dev('<skills_instructions>skills</skills_instructions>', DAY + 1, 'host_skills.instructions'),
    user('<environment_context>\n  <current_date>day 2</current_date>\n</environment_context>', DAY + 2, 'environments.environment_context'),
    dev('<codex_apps_client_time_context>time</codex_apps_client_time_context>', DAY + 3, 'additional_content.codex_apps_client_time_context'),
    user('<external_codex_apps_open_page>{"page_id":null}</external_codex_apps_open_page>', DAY + 4, 'additional_content.codex_apps_open_page'),
    dev('<codex_apps_open_page_instructions>the page beside the chat</codex_apps_open_page_instructions>', DAY + 5, 'additional_content.codex_apps_open_page_instructions'),
    ...(day2Agent ? [
      user('where are we? update the wf plugin', DAY + 10),
      agent('The fix is merged; no deployment was performed here. I will check the current state.', DAY + 20, 'commentary'),
      ...tool(DAY + 30),
      agent('- **wf updated** to the latest release available.\n- **Fix merged** on the main branch.\n- **Remaining:** workflow closure and cleanup. No deployment performed here; ticket unchanged.', DAY + 100),
      done(DAY + 110),
    ] : []),
    user(reply, DAY + 200),
    agent('The merge is complete; I will close the attempt and check the ticket.', DAY + 210, 'commentary'),
    ...tool(DAY + 220),
  ];
  const file = path.join(homeOf(p), '.codex', 'sessions', '2026', '10', '14', `rollout-days-${CODEX}.jsonl`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
}
const codexEnv = { CODEX_THREAD_ID: CODEX };

test('0.7.27 (I-192): Codex, the field shape: "ok we can close this then" closes a shipped attempt whose decision an older release created, after the agent described it in its own words', () => {
  const p = singleRepoProject('approve-own-words-codex', {});
  const e = ok(wf(p.root, ['entry', '--item', 'ENG-1200', '--json'], silent)).json();
  const d = legacyClose(p, e.id);
  assert.equal(d.aliases, undefined, 'created as an older release did: no words of the frame');
  // Until it is answered, `wf status` and `wf resume` name it where the owner reads what is next, with the form that asks it.
  const waiting = ok(wf(p.root, ['resume', '--attempt', e.id], silent)).out;
  assert.match(waiting, new RegExp(`waiting on the person: A1 is not answered\\. Ask it in your reply \\(a mention in your own words, such as what remains, does not ask it\\): quote "${e.id.replace('.', '\\.')} A1: close ${e.id.replace('.', '\\.')} as shipped`));
  codexDays(p, e.id, d);
  const r = ok(approveQ(p, e.id, d.id, codexEnv));
  assert.match(r.out, /A1 decided: yes \(their reply: "ok we can close this then\. ticket is on done\? and clean up completed\?"; follow any condition in it\)/);
  const recorded = state(p.root, e.id).decisions.find((x) => x.id === d.id).approved;
  assert.deepEqual([recorded.choice, recorded.reply], ['yes', FIELD_REPLY]);
  assert.match(recorded.via, /^chat, in their own words \(Codex, host-recorded\)$/);
  assert.doesNotMatch(ok(wf(p.root, ['resume', '--attempt', e.id], silent)).out, /waiting on the person/);
});

test('0.7.27 (I-192): Codex, the page the harness records before the person\'s first message of a day is not their turn: a "yes" the next day answers the question asked the day before', () => {
  const p = singleRepoProject('approve-open-page', {});
  const e = ok(wf(p.root, ['entry', '--item', 'ENG-1201', '--json'], silent)).json();
  const d = legacyClose(p, e.id);
  codexDays(p, e.id, d, { reply: 'yes', day2Agent: false });
  const r = ok(approveQ(p, e.id, d.id, codexEnv));
  assert.match(r.out, /^A1 decided: yes\. next:/m);
  assert.match(state(p.root, e.id).decisions[0].approved.via, /^chat \(Codex, host-recorded\)$/, 'bound to the message that quoted the question');
});

test('0.7.27 (I-192): Claude Code, the field shape: "ok we can close this then" after a status in the agent\'s own words closes it', () => {
  const p = singleRepoProject('approve-own-words-claude', {});
  const e = ok(wf(p.root, ['entry', '--item', 'ENG-1202', '--json'], silent)).json();
  const d = legacyClose(p, e.id);
  const attachment = (type, ms, extra = {}) => ({ type: 'attachment', timestamp: at(ms), attachment: { type, ...extra } });
  const result = (ms) => ({ type: 'user', timestamp: at(ms), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_x', content: 'ok' }] } });
  claudeLines(p, [
    tool(at(400)),
    result(450),
    says(`Chat approval is supported. **Yes** closes the merged ticket's bookkeeping and removes its working folders; **no** leaves it open.\n\n> ${e.id} ${d.id}: ${d.summary}\n\n- **yes**\n- **no**`, at(700)),
    attachment('date', DAY, { date: 'day 2' }),
    attachment('hook_success', DAY + 1, { hookName: 'SessionStart', content: 'the plugin rules' }),
    types('where are we? update the wf plugin', at(DAY + 10)),
  ]);
  // The first message of the day follows the message that asked the question, but speaks of something else: no answer, and
  // nothing recorded that would stand in the way of a real one (before, it was recorded as their answer in their own words).
  assert.match(approveQ(p, e.id, d.id, env).err, /no answer to A1/);
  assert.equal(state(p.root, e.id).decisions[0].approved, null);
  claudeLines(p, [
    says('The fix is merged; no deployment was performed here. I will check the current state.', at(DAY + 20)),
    tool(at(DAY + 30)),
    result(DAY + 40),
    says('- **wf updated** to the latest release available.\n- **Fix merged** on the main branch.\n- **Remaining:** workflow closure and cleanup. No deployment performed here; ticket unchanged.', at(DAY + 100)),
    types(FIELD_REPLY, at(DAY + 200)),
  ]);
  const r = ok(approveQ(p, e.id, d.id, env));
  assert.match(r.out, /A1 decided: yes \(their reply: "ok we can close this then\./);
  assert.match(state(p.root, e.id).decisions[0].approved.via, /^chat, in their own words \(Claude Code, host-recorded\)$/);
});

test('0.7.27 (I-192): words that negate, condition or ask about the closure, a bare "ok" after another message, and words that fit two open questions bind nothing', () => {
  const p = singleRepoProject('approve-own-words-negative', {});
  const e = ok(wf(p.root, ['entry', '--item', 'ENG-1203', '--json'], silent)).json();
  const d = legacyClose(p, e.id);
  const refused = (re, msg) => {
    const r = approveQ(p, e.id, d.id, env);
    assert.equal(r.code, 75, msg);
    assert.match(r.err, re, msg);
    assert.equal(state(p.root, e.id).decisions.find((x) => x.id === d.id).approved, null, msg);
    return r;
  };
  let t = 1000;
  const chat = (said, reply) => claudeChat(p, { said, reply, saidWhen: at((t += 500)), when: at((t += 500)) });
  chat('The tests passed and the branch is merged.', 'ok');
  refused(/no answer to A1 in this session's question panel, or in its chat to a message asking exactly its question, after the decision was created, and no reply of the person's since then names what it decides/, 'a bare "ok" after a message that never asked or named it');
  const ask = refused(/then, in this same reply \(this refusal never ends your turn with the question unasked\), ask them in your message, quoting the question/, 'the refusal says to ask it now');
  assert.match(ask.err, new RegExp(`"${e.id.replace('.', '\\.')} A1: close ${e.id.replace('.', '\\.')} as shipped`));
  for (const words of ["don't close it yet", 'close it after the review', 'should we close it?', 'verify the deployment, then if all good close the ticket', 'close the pull request']) {
    chat('Closure and cleanup remain.', words);
    // "close the pull request" names something else: the latest words about the closure are still the ones before it.
    refused(words === 'close the pull request' ? /the person's latest words about what it decides, "verify the deployment, then if all good close the ticket", choose nothing/ : new RegExp(`the person's latest words about what it decides, "${words.replace('?', '\\?')}", choose nothing`), words);
  }
  // A later "close it" is the person's answer, but not while another open question fits the same words.
  legacyClose(p, e.id, 2, 'feedface00000002');
  chat('Two merged changes remain to close.', 'ok close it');
  refused(/the person's words "ok close it" name what it decides, and could answer .* A2 .* as well, so they answer neither/, 'two open decisions fit "close"');
  assert.equal(approveQ(p, e.id, 'A2', env).code, 75, 'nor the other one');
  // Another open attempt's question fits "close it" too; naming the ticket says which one.
  ok(wf(p.root, ['decisions', 'withdraw', 'A2', '--reason', 'asked again on its own', '--attempt', e.id]));
  const other = ok(wf(p.root, ['entry', '--item', 'ENG-1204', '--json'], silent)).json();
  legacyClose(p, other.id);
  chat('Both merged changes can be closed.', 'close it');
  refused(/could answer ENG-1204\.1 A1/, 'another attempt\'s open question fits');
  chat('Both merged changes can be closed.', 'close ENG-1203 please');
  assert.match(ok(approveQ(p, e.id, d.id, env)).out, /A1 decided: yes/);
  // To the question quoted, a reply in the person's own words about it (it shares the question's words) is still theirs.
  const third = ok(wf(p.root, ['entry', '--item', 'ENG-1208', '--json'], silent)).json();
  const q = legacyClose(p, third.id);
  claudeChat(p, { said: `${third.id} ${q.id}: ${q.summary}\n\nyes / no`, reply: 'wait until the worktree is cleaned up', saidWhen: at((t += 500)), when: at((t += 500)) });
  assert.match(ok(approveQ(p, third.id, q.id, env)).out, /A1 decided: in the person's own words: "wait until the worktree is cleaned up"/);
});

test('0.7.27 (I-192, D41): a generic word said about something else never answers a question: escalations and short names bind only to a message that asked or named them', () => {
  const p = singleRepoProject('approve-own-words-generic', {});
  const e = ok(wf(p.root, ['entry', '--item', 'ENG-1205', '--json'], silent)).json();
  append(p.root, e.id, 'decision.created', { id: 'A1', kind: 'escalation', key: 'round-limit:test', summary: 'how ENG-1205 goes on: continue | split | deliver-core | stop', choices: ['continue', 'split', 'deliver-core', 'stop'], labels: { continue: 'Keep going as now', split: 'Split off the rest as its own ticket', 'deliver-core': 'Ship what the criteria need now', stop: 'Stop this ticket' }, aliases: { continue: ['keep going', 'go on', 'carry on'], split: ['split it'], 'deliver-core': ['ship the core'], stop: ['stop it'] } }, 'human:scenario');
  for (const [i, words] of ['stop it, you are spamming the tracker', 'keep going', 'carry on', 'continue'].entries()) {
    claudeChat(p, { said: 'The linter is noisy today.', reply: words, saidWhen: at(1000 + i * 1000), when: at(1500 + i * 1000) });
    assert.match(approveQ(p, e.id, 'A1', env).err, /no answer to A1/, words);
  }
  const q = singleRepoProject('approve-own-words-hold', {});
  const f = ok(wf(q.root, ['entry', '--item', 'ENG-1206', '--json'], silent)).json();
  ok(wf(q.root, ['hold', '--reason', 'wait for the store review', '--attempt', f.id], silent));
  assert.equal(wf(q.root, ['release', '--attempt', f.id], silent).code, 75);
  // "keep it" is a short name of the hold question's "no", for a reply to a message that asked it; said about something else it is
  // no answer.
  claudeChat(q, { said: 'The store review came back.', reply: 'keep it simple', saidWhen: at(500), when: at(1000) });
  assert.match(approveQ(q, f.id, 'A1', env).err, /no answer to A1/);
  claudeChat(q, { said: 'The store review came back.', reply: 'ok lift the pause and ship it', saidWhen: at(1500), when: at(2000) });
  assert.match(ok(approveQ(q, f.id, 'A1', env)).out, /A1 decided: yes \(their reply: "ok lift the pause and ship it"/);
  assert.match(state(q.root, f.id).decisions[0].approved.via, /^chat, in their own words/);
});

// 0.7.27 (I-192): Claude Code records a message the person typed while the agent was working as an `attachment` line
// (`queued_command`, origin human), not a user line; it is the person's words like any other reply.
test('0.7.27 (I-192): Claude Code, a message the person typed while the agent worked counts as theirs; one from anything else does not', () => {
  const p = singleRepoProject('approve-queued', {});
  const e = ok(wf(p.root, ['entry', '--item', 'ENG-1207', '--json'], silent)).json();
  const d = legacyClose(p, e.id);
  const queued = (prompt, ms, origin = 'human') => ({ type: 'attachment', timestamp: at(ms), attachment: { type: 'queued_command', prompt, source_uuid: 'u', commandMode: 'prompt', origin: { kind: origin } } });
  claudeLines(p, [says('Checking whether the change is on the main branch.', at(400)), tool(at(500)), queued('go ahead and close it', 600, 'task-notification')]);
  assert.match(approveQ(p, e.id, d.id, env).err, /no answer to A1/, 'not the person');
  claudeLines(p, [queued('go ahead and close it', 700)]);
  assert.match(ok(approveQ(p, e.id, d.id, env)).out, /A1 decided: yes \(their reply: "go ahead and close it"/);
});
