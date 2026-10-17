import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ok, singleRepoProject, state, wf } from './helpers.mjs';
import { channelOf } from '../engine/channels.mjs';
import { append } from '../engine/ledger.mjs';
import { FRAMES, composeAsk } from '../engine/asking.mjs';

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
// 0.7.27 (D41): the agent's reading of the person's words, with the words it relies on.
const readQ = (p, id, decision, env, choice, quote) => wf(p.root, ['approve', decision, '--from-question', '--attempt', id, '--choice', choice, '--quote', quote], { env, ...silent });

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
  // A "yes" typed to no message that asked the question is recorded by nothing automatically: the agent reads it (0.7.27, D41;
  // scenarios below).
  fs.writeFileSync(transcript, JSON.stringify({ type: 'user', timestamp: at(1000), message: { role: 'user', content: 'yes, go ahead with A1' } }) + '\n');
  refusedWith(/A1 is not recorded by itself: it followed no message of yours/, 'the person typed yes in the chat, to no message that asked it');
  refusedWith(/read their words yourself/, 'the agent is told to read them');
  // I-135: a panel that showed nothing is not the end of the road: the reply explains the decision, and the terminal route is given.
  refusedWith(/say in your reply, in plain words, what this decides, why, and what happens after each choice \(a question panel may not show, and its acceptance proves nothing\)/, 'the decision is explained in the reply');
  refusedWith(/ask them in your message, quoting the question ".*" exactly with its options .* so they can type the answer \(you may also show it in your question panel: a typed reply and a panel answer both count; in the panel, in `AskUserQuestion` each option's `label` is its label alone/, 'the chat route is given first, with how the host\'s panel takes its options');
  refusedWith(new RegExp(`or they run \`wf approve A1 --attempt ${e.id.replace('.', '\\.')}\` in their own terminal`), 'the terminal route is given');
  claudeAsks(p, { question: `${e.id} ${d.id}: lift it?`, answer: 'yes' });
  refusedWith(/A1 is not recorded by itself: the panel question named A1 but did not quote its question as wf printed it/, 'the question does not say what the decision does');
  claudeAsks(p, { question: `${d.id}: ${d.plain ?? d.summary}`, answer: 'yes' });
  refusedWith(/A1 is not recorded by itself: the panel question did not carry A1's question as wf printed it/, 'the question does not name the attempt');
  claudeAsks(p, { question, options: ['yes', 'no', 'yes and delete the branch'], answer: 'yes' });
  refusedWith(/A1 is not recorded by itself: the panel offered "yes", "no", "yes and delete the branch", not exactly A1's options \("Lift the pause", "Keep it paused"\)/, 'other options were offered');
  claudeAsks(p, { question, answer: 'yes', when: before });
  refusedWith(/A1 is not recorded by itself/, 'answered before the decision existed');
  claudeAsks(p, { question, answer: 'yes', askedWhen: before });
  refusedWith(/A1 is not recorded by itself: the panel question was asked before A1 existed/, 'asked before the decision existed, answered after');
  claudeAsks(p, { question: `${e.id} ${d.id}0: ${d.plain ?? d.summary} (another decision)`, answer: 'yes' });
  refusedWith(/A1 is not recorded by itself: the panel question did not carry A1's question/, 'a question for A10 is not one for A1');
  claudeAsks(p, { question: `X${question}`, answer: 'yes' });
  refusedWith(/A1 is not recorded by itself: the panel question did not carry A1's question/, 'another attempt whose id ends the same');
  claudeAsks(p, { question, answer: 'yes', sidechain: true });
  refusedWith(/A1 is not recorded by itself/, 'a sub-agent line is not the session\'s panel');
  claudeAsks(p, { question, answer: 'yes', session: 'c1aude00-0000-4000-8000-0000000000ff' });
  refusedWith(/A1 is not recorded by itself/, 'another session\'s panel');

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

  // Typed text that is not a choice (the panel's free-text option) is the person's answer too (0.7.8). From 0.7.27 (D41) the
  // engine records no meaning of its own for it: the agent reads it, and records words that choose no option as theirs (`other`).
  // It confirms nothing a choice would, so the hold stays and the next ask names it.
  claudeAsks(p, { question: `${e.id} ${again.id}: ${again.plain ?? again.summary}`, answer: 'only on Monday' });
  const free = approveQ(p, e.id, again.id, env);
  assert.equal(free.code, 75);
  assert.match(free.err, /the person's latest words since then: "only on Monday" \(their answer in the question panel\)/);
  const worded = ok(wf(p.root, ['approve', again.id, '--from-question', '--attempt', e.id, '--choice', 'other', '--quote', 'only on Monday'], { env, ...silent }));
  assert.match(worded.out, /A2 decided: in the person's own words: "only on Monday" \(follow them; it grants nothing a choice would\)/);
  const own = state(p.root, e.id).decisions.find((x) => x.id === again.id).approved;
  assert.deepEqual([own.choice, own.words, own.quote], ['other', 'only on Monday', 'only on Monday']);
  assert.match(own.via, /^question-panel, read by the agent \(Claude Code, host-recorded\)$/);
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
  assert.match(approveQ(p, e.id, d.id, env).err, /A1 is not recorded by itself: your message before it did not carry A1's question as wf printed it/);
  // A message that also carries another open decision's question binds no reply to either.
  // A second open decision: taking over the live owner's attempt.
  assert.equal(adopt(p, e.id, env).code, 75);
  const other = state(p.root, e.id).decisions.find((x) => x.id !== d.id && !x.approved);
  assert.ok(other, "a second open decision exists");
  {
    claudeChat(p, { said: `Two questions.\n${question}\n${e.id} ${other.id}: ${other.plain ?? other.summary}`, reply: 'yes', saidWhen: at(1500), when: at(2000) });
    assert.match(approveQ(p, e.id, d.id, env).err, /A1 is not recorded by itself: your message before it carried another decision's question too/);
  }
  // The question quoted exactly, its options listed, and the person's reply exactly one of them.
  claudeChat(p, { said: `Lifting the hold lets the work continue.\n\n${question}\n\nOptions: yes / no`, reply: 'Yes.', saidWhen: at(2500), when: at(3000) });
  assert.match(ok(approveQ(p, e.id, d.id, env)).out, /A1 decided: yes/);
  const recorded = state(p.root, e.id).decisions.find((x) => x.id === d.id).approved;
  assert.equal(recorded.choice, 'yes');
  assert.match(recorded.via, /^chat \(Claude Code, host-recorded\)$/);
  // A reply in more words than an option's name is the agent's to read (0.7.27, D41): refused by itself, recorded with its words.
  ok(wf(p.root, ['decisions', 'withdraw', other.id, '--reason', 'asked on its own later', '--attempt', e.id]));
  assert.equal(adopt(p, e.id, env).code, 75);
  const take = state(p.root, e.id).decisions.at(-1);
  const takeQ = `${e.id} ${take.id}: ${take.plain ?? take.summary}`;
  claudeChat(p, { said: `Taking it over lets this session carry on.\n\n${takeQ}\n\nOptions: yes / no`, reply: 'Yes, go ahead', saidWhen: at(3500), when: at(4000) });
  const refused = approveQ(p, e.id, take.id, env);
  assert.equal(refused.code, 75);
  assert.match(refused.err, /the person's latest words since then: "Yes, go ahead" \(a reply to your message that asked it\)/);
  assert.match(refused.err, new RegExp(`read their words yourself .*--choice <choice> --quote "<their words`));
  const read = ok(readQ(p, e.id, take.id, env, 'yes', 'Yes, go ahead'));
  assert.match(read.out, new RegExp(`${take.id} decided: yes, as you read the person's words "Yes, go ahead"`));
  assert.match(state(p.root, e.id).decisions.find((x) => x.id === take.id).approved.via, /^chat, read by the agent \(Claude Code, host-recorded\)$/);
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
  assert.match(approveQ(p, e.id, d.id, env).err, /A1 is not recorded by itself: their reply is not exactly one of its options/);
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
function heldAttempt(name, item, reason = 'wait') {
  const p = singleRepoProject(name, {});
  const e = ok(wf(p.root, ['entry', '--item', item, '--json'], silent)).json();
  ok(wf(p.root, ['hold', '--reason', reason, '--attempt', e.id], silent));
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
  assert.match(approveQ(t.p, t.e.id, t.d.id, env).err, /A1 is not recorded by itself: your message before it did not carry A1's question/);
  // A question written between tool calls is not the message the person answers.
  t = heldAttempt('chat-midturn', 'ENG-961');
  claudeLines(t.p, [says(`${t.question}\n\nyes / no`, at(500)), tool(at(600)), says('Waiting for the gate.', at(700)), types('yes', at(1000))]);
  assert.match(approveQ(t.p, t.e.id, t.d.id, env).err, /A1 is not recorded by itself: your message before it did not carry A1's question/);
  // A message that also names another attempt's decision binds to neither.
  t = heldAttempt('chat-other-attempt', 'ENG-962');
  claudeLines(t.p, [says(`${t.question}\nENG-999.1 A1: close ENG-999.1\n\nyes / no`, at(500)), types('yes', at(1000))]);
  assert.match(approveQ(t.p, t.e.id, t.d.id, env).err, /A1 is not recorded by itself: your message before it carried another decision's question too/);
});

// 0.7.27 (D41): the engine reads no meaning into a reply. One that takes it back, or adds a condition, is refused by itself and
// recorded by nothing; the agent reads it, records the choice it makes with the words it relies on, and follows the rest.
test('chat choice: a reply that is not exactly one option records nothing by itself; the agent\'s reading keeps the whole message', () => {
  for (const [i, words] of ['yes, actually no', 'Yes, but keep the old export button visible', 'Yes, but only after the failing test is fixed'].entries()) {
    const t = heldAttempt(`chat-more-${i}`, `ENG-97${i}`);
    claudeLines(t.p, [says(`${t.question}\n\nyes / no`, at(500)), types(words, at(1000))]);
    const r = approveQ(t.p, t.e.id, t.d.id, env);
    assert.equal(r.code, 75, words);
    assert.match(r.err, /read their words yourself/, words);
    assert.equal(state(t.p.root, t.e.id).decisions[0].approved, null, words);
    if (i !== 1) continue;
    // The condition does not move the action: the agent records "yes" from "Yes", and the whole message stays beside it.
    const read = ok(readQ(t.p, t.e.id, t.d.id, env, 'yes', 'Yes'));
    assert.match(read.out, /A1 decided: yes, as you read the person's words "Yes" in their message "Yes, but keep the old export button visible"/);
    assert.match(read.out, /follow anything else their message asks/);
    const recorded = state(t.p.root, t.e.id).decisions[0].approved;
    assert.deepEqual([recorded.choice, recorded.quote, recorded.message], ['yes', 'Yes', words]);
  }
  assert.match(channelOf({ deferred: { source: { provenance: 'approved-decision', via: 'chat (Claude Code, host-recorded)' } } }), /answered by the person in the chat/);
  assert.match(channelOf({ deferred: { source: { provenance: 'approved-decision', via: 'chat, read by the agent (Claude Code, host-recorded)' } } }), /the owner agent read them as this answer and quoted them/);
  // 0.7.27's first form (`chat, in their own words`) still reads in a ledger that recorded it.
  assert.match(channelOf({ deferred: { source: { provenance: 'approved-decision', via: 'chat, in their own words (Codex, host-recorded)' } } }), /in their own words naming what it decides/);
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
  assert.match(ok(approveQ(u.p, u.e.id, u.d.id, env)).out, /^A1 decided: yes\. In this same reply, tell them what you recorded/m);
  assert.equal(state(u.p.root, u.e.id).decisions[0].approved.reply, undefined);
});

// 0.7.23, the person's rule: "why are you stopping me from just typing no, why do i have to answer the questionnaire? both
// should be accepted". Named failure (field): the person typed "ok fix all and continue" to the round-limit question; the
// session had explained the question in its own words, and the reply did not start with a choice, so it was refused twice and
// the session put the question panel in front of them.
test('typed replies: exactly one option binds; without the question quoted, only an option\'s label binds; anything else is the agent\'s to read', () => {
  const p = singleRepoProject('approve-typed', {});
  const e = ok(wf(p.root, ['entry', '--item', 'ENG-950', '--json'], silent)).json();
  ok(wf(p.root, ['hold', '--reason', 'wait for the store review', '--attempt', e.id], silent));
  assert.equal(wf(p.root, ['release', '--attempt', e.id], silent).code, 75);
  const d = state(p.root, e.id).decisions[0];
  const env = { CLAUDE_CODE_SESSION_ID: CLAUDE };
  // The session explained the question in its own words: a bare "yes" says nothing about which question it answers.
  claudeChat(p, { said: 'The store review came back. Want me to carry on?', reply: 'yes' });
  assert.match(approveQ(p, e.id, d.id, env).err, /A1 is not recorded by itself: your message before it did not carry A1's question/);
  // A message that never names the decision binds no bare choice or word of its own ("carry on" is no name of this one).
  claudeChat(p, { said: 'The store review came back. Should the pause end?', reply: 'ok carry on then', saidWhen: at(1200), when: at(1400) });
  assert.match(approveQ(p, e.id, d.id, env).err, /A1 is not recorded by itself: your message before it did not carry A1's question/);
  // A message that names the decision in the session's own words binds only a reply that is exactly an option's label.
  for (const [i, words] of ["don't lift the pause yet", 'ok lift the pause and ship it', 'yes'].entries()) {
    claudeChat(p, { said: `About ${e.id} ${d.id}: the store review came back. Should the pause end?`, reply: words, saidWhen: at(1500 + i * 400), when: at(1700 + i * 400) });
    assert.match(approveQ(p, e.id, d.id, env).err, /A1 is not recorded by itself: your message before it named A1 but did not quote its question as wf printed it, so only an option's label binds there/, words);
  }
  claudeChat(p, { said: `About ${e.id} ${d.id}: the store review came back. Should the pause end?`, reply: 'Lift the pause', saidWhen: at(2500), when: at(3000) });
  const typed = ok(approveQ(p, e.id, d.id, env));
  assert.match(typed.out, /^A1 decided: yes\. In this same reply, tell them what you recorded/m);
  const recorded = state(p.root, e.id).decisions[0].approved;
  assert.equal(recorded.choice, 'yes');
  assert.match(recorded.via, /^chat, the question not quoted \(Claude Code, host-recorded\)$/);

  // With the question quoted, "ok", "nope", "proceed", "go for it" and "do it" are answers; a question back is the agent's to answer.
  const q = singleRepoProject('approve-typed-quoted', {});
  const f = ok(wf(q.root, ['entry', '--item', 'ENG-951', '--json'], silent)).json();
  ok(wf(q.root, ['hold', '--reason', 'wait', '--attempt', f.id], silent));
  assert.equal(wf(q.root, ['release', '--attempt', f.id], silent).code, 75);
  const g = state(q.root, f.id).decisions[0];
  const question = `${f.id} ${g.id}: ${g.plain}`;
  claudeChat(q, { said: question, reply: 'ok but why now?' });
  assert.match(approveQ(q, f.id, g.id, env).err, /the person's latest words since then: "ok but why now\?" \(a reply to your message that asked it\)/);
  assert.equal(state(q.root, f.id).decisions[0].approved, null, 'a question back is no answer');
  claudeChat(q, { said: `Because the review is in.\n\n${question}`, reply: 'nope', saidWhen: at(1500), when: at(2000) });
  assert.match(ok(approveQ(q, f.id, g.id, env)).out, /A1 decided: no/);
  for (const [i, words] of ['proceed', 'Go for it!', 'do it', 'confirm', 'OK.'].entries()) {
    ok(wf(q.root, ['decisions', 'withdraw', state(q.root, f.id).decisions.at(-1).id, '--reason', 'asked afresh', '--attempt', f.id]));
    assert.equal(wf(q.root, ['release', '--attempt', f.id], silent).code, 75);
    const h = state(q.root, f.id).decisions.at(-1);
    claudeChat(q, { said: `${f.id} ${h.id}: ${h.plain}`, reply: words, saidWhen: at(2500 + i * 1000), when: at(3000 + i * 1000) });
    assert.match(ok(approveQ(q, f.id, h.id, env)).out, new RegExp(`${h.id} decided: yes`), words);
  }
});

// 0.7.27 (I-192, D41), named failure (field): the person's clear answer in their own words was refused. A decision `wf close
// --shipped` had created under 0.7.17 (no labels or plain words) was asked exactly, with yes and no, on day 1, and the person did
// not answer that day. On day 2 the harness put its context and the page open beside the chat before their first message, the
// agent described the closure as what remained in its own words, and the person replied "ok we can close this then. ticket is on
// done? and clean up completed?". `wf approve --from-question` refused it, and the agent ended its turn without asking anything.
// The first fix read the reply's meaning with patterns; an independent review proved it bound replies the person never meant
// ("close it if the deploy is fine", "lift the pause on" another ticket) and refused or misfiled clear ones ("do it", "proceed").
// Now the agent, which has the whole conversation, reads the words and names the choice and the words it relies on; the engine
// proves only what it can: the words are verbatim from one of the person's own messages in this session, written after the
// question existed, and the choice is one of the question's.
const DAY = 24 * 3600 * 1000;
const shippedSummary = (id) => `close ${id} as shipped without its acceptance (app 1a2b3c4d5e (worktree) on origin/main)`;
// A close-shipped decision as 0.7.17 recorded it: kind and key, summary, choices, nothing else.
function legacyClose(p, attempt, n = 1, hash = 'feedface00000001') {
  append(p.root, attempt, 'decision.created', { id: `A${n}`, kind: 'override-gate', key: `close-shipped:${attempt}:${hash}`, summary: shippedSummary(attempt), choices: ['yes', 'no'] }, 'human:scenario');
  return state(p.root, attempt).decisions.find((x) => x.id === `A${n}`);
}
const FIELD_REPLY = 'ok we can close this then. ticket is on done? and clean up completed?';
const STATUS = '- **wf updated** to the latest release available.\n- **Fix merged** on the main branch.\n- **Remaining:** workflow closure and cleanup. No deployment performed here; ticket unchanged.';
// The day-1/day-2 shape of the field transcript, anonymized: Codex Desktop items as the harness writes them.
function codexDays(p, attempt, d, { reply = FIELD_REPLY, day2Agent = true } = {}) {
  const item = (payload, ms, extra = {}) => ({ timestamp: at(ms), type: 'response_item', payload: { ...payload, ...extra } });
  const kinds = (k) => ({ internal_chat_message_metadata_passthrough: { turn_id: 't', content_item_kinds: [k] } });
  const user = (text, ms, k = 'user.text') => item({ type: 'message', role: 'user', content: [{ type: 'input_text', text }] }, ms, kinds(k));
  const dev = (text, ms, k) => item({ type: 'message', role: 'developer', content: [{ type: 'input_text', text }] }, ms, kinds(k));
  const agent = (text, ms, phase = 'final_answer') => item({ type: 'message', role: 'assistant', phase, content: [{ type: 'output_text', text }] }, ms, kinds('unknown'));
  const tool = (ms) => [item({ type: 'custom_tool_call', name: 'exec', call_id: `c${ms}`, input: 'wf status' }, ms), item({ type: 'custom_tool_call_output', call_id: `c${ms}`, output: [{ type: 'input_text', text: 'the tool says close it now' }] }, ms + 50)];
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
      agent(STATUS, DAY + 100),
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
// Not a word of the refusal makes the person answer again what they may have answered: it says to read their words first.
const readsFirst = (err, msg) => {
  assert.match(err, /read their words yourself \(you have the whole conversation\)/, msg);
  assert.match(err, /--choice <choice> --quote "<their words, exactly as they typed them>"/, msg);
  assert.doesNotMatch(err, /ask (?:it|them|the question) again|answer (?:it )?again/i, msg);
};

test('0.7.27 (I-192, D41): Codex, the field shape: the agent records "yes" from "ok we can close this then"; with no choice named, the reply is the agent\'s to read', () => {
  const p = singleRepoProject('approve-own-words-codex', {});
  const e = ok(wf(p.root, ['entry', '--item', 'ENG-1200', '--json'], silent)).json();
  const d = legacyClose(p, e.id);
  assert.equal(d.labels, undefined, 'created as an older release did: no words of the frame');
  // Until it is answered, `wf status` and `wf resume` name it where the owner reads what is next, with the form that asks it.
  const waiting = ok(wf(p.root, ['resume', '--attempt', e.id], silent)).out;
  assert.match(waiting, new RegExp(`waiting on the person: A1 is not answered\\. Ask it in your reply \\(a mention in your own words, such as what remains, does not ask it\\): quote "${e.id.replace('.', '\\.')} A1: close ${e.id.replace('.', '\\.')} as shipped`));
  assert.match(waiting, /--choice <choice> --quote "<their words>"/, 'and how their answer in more words is recorded');
  codexDays(p, e.id, d);
  const refused = approveQ(p, e.id, d.id, codexEnv);
  assert.equal(refused.code, 75);
  assert.match(refused.err, /the person's latest words since then: "ok we can close this then\. ticket is on done\? and clean up completed\?" \(a reply to a message that did not ask it\); their reply to your message that asked it: "where are we\? update the wf plugin"/);
  readsFirst(refused.err, 'the field reply with no choice named');
  assert.equal(state(p.root, e.id).decisions[0].approved, null);
  // Words the harness, a tool or the agent wrote are never the person's.
  for (const words of ['page_id', 'current_date', 'the tool says close it now', 'workflow closure and cleanup']) {
    const r = readQ(p, e.id, d.id, codexEnv, 'yes', words);
    assert.equal(r.code, 75, words);
    assert.match(r.err, new RegExp(`not recorded: "${words}" is in no message of the person's in this session`), words);
  }
  const r = ok(readQ(p, e.id, d.id, codexEnv, 'yes', 'ok we can close this then'));
  assert.match(r.out, /A1 decided: yes, as you read the person's words "ok we can close this then" in their message "ok we can close this then\. ticket is on done\? and clean up completed\?"/);
  assert.match(r.out, /In this same reply, tell them what you recorded and from which words/);
  const recorded = state(p.root, e.id).decisions.find((x) => x.id === d.id).approved;
  assert.deepEqual([recorded.choice, recorded.quote, recorded.message], ['yes', 'ok we can close this then', FIELD_REPLY]);
  assert.equal(recorded.question.text, STATUS, 'the agent message the reply answered');
  assert.match(recorded.via, /^chat, read by the agent \(Codex, host-recorded\)$/);
  assert.doesNotMatch(ok(wf(p.root, ['resume', '--attempt', e.id], silent)).out, /waiting on the person/);
  assert.match(ok(wf(p.root, ['decisions', '--attempt', e.id])).out, /A1 {2}override-gate {2}decided: yes \(read from their words "ok we can close this then"\)/);
});

test('0.7.27 (I-192): Codex, the page the harness records before the person\'s first message of a day is not their turn: a "yes" the next day answers the question asked the day before', () => {
  const p = singleRepoProject('approve-open-page', {});
  const e = ok(wf(p.root, ['entry', '--item', 'ENG-1201', '--json'], silent)).json();
  const d = legacyClose(p, e.id);
  codexDays(p, e.id, d, { reply: 'yes', day2Agent: false });
  const r = ok(approveQ(p, e.id, d.id, codexEnv));
  assert.match(r.out, /^A1 decided: yes\. In this same reply, tell them what you recorded/m);
  assert.match(state(p.root, e.id).decisions[0].approved.via, /^chat \(Codex, host-recorded\)$/, 'bound to the message that quoted the question');
});

test('0.7.27 (I-192, D41): Claude Code, the field shape: the first message of the day records nothing; the agent records "yes" from "ok we can close this then"', () => {
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
  // The first message of the day follows the message that asked the question but speaks of something else: nothing is recorded
  // that would stand in the way of a real answer.
  const first = approveQ(p, e.id, d.id, env);
  assert.match(first.err, /A1 is not recorded by itself: their reply is not exactly one of its options/);
  readsFirst(first.err, 'the first message of the day');
  assert.equal(state(p.root, e.id).decisions[0].approved, null);
  claudeLines(p, [
    says('The fix is merged; no deployment was performed here. I will check the current state.', at(DAY + 20)),
    tool(at(DAY + 30)),
    result(DAY + 40),
    says(STATUS, at(DAY + 100)),
    types(FIELD_REPLY, at(DAY + 200)),
  ]);
  readsFirst(approveQ(p, e.id, d.id, env).err, 'the field reply with no choice named');
  const r = ok(readQ(p, e.id, d.id, env, 'yes', 'ok we can close this then'));
  assert.match(r.out, /A1 decided: yes, as you read the person's words "ok we can close this then"/);
  const recorded = state(p.root, e.id).decisions[0].approved;
  assert.match(recorded.via, /^chat, read by the agent \(Claude Code, host-recorded\)$/);
  assert.deepEqual([recorded.quote, recorded.message, recorded.question.text], ['ok we can close this then', FIELD_REPLY, STATUS]);
});

// The independent review of the first fix proved each of these recorded an answer the person did not give, or refused one they
// gave. None is recorded by the engine by itself, even replying to a message that quoted the question exactly.
test('0.7.27 (D41): replies a pattern misread are never recorded by themselves; the agent\'s reading of a clear one is', () => {
  const p = singleRepoProject('approve-never-auto', {});
  const e = ok(wf(p.root, ['entry', '--item', 'ENG-1301', '--json'], silent)).json();
  const close = legacyClose(p, e.id);
  append(p.root, e.id, 'decision.created', { id: 'A2', kind: 'waive-finding', key: 'r1:F1', summary: 'waive r1:F1', plain: 'Should ENG-1301 ship with a problem the reviewers found accepted as it is, instead of fixed?', choices: ['yes', 'no'], labels: { yes: 'Accept it and ship', no: 'No, fix it first' } }, 'human:scenario');
  append(p.root, e.id, 'decision.created', { id: 'A3', kind: 'escalation', key: 'round-limit:test', summary: 'how ENG-1301 goes on', choices: ['continue', 'split', 'deliver-core', 'stop'], labels: { continue: 'Keep going as now', split: 'Split off the rest as its own ticket', 'deliver-core': 'Ship what the criteria need now', stop: 'Stop this ticket' } }, 'human:scenario');
  const other = ok(wf(p.root, ['entry', '--item', 'ENG-1302', '--json'], silent)).json();
  ok(wf(p.root, ['hold', '--reason', 'wait for the store review', '--attempt', e.id], silent));
  ok(wf(p.root, ['hold', '--reason', 'wait for the store review', '--attempt', other.id], silent));
  assert.equal(wf(p.root, ['release', '--attempt', e.id], silent).code, 75);
  const hold = state(p.root, e.id).decisions.at(-1);
  const q = (d) => `${e.id} ${d.id}: ${d.plain ?? d.summary}`;
  const cases = [
    [close, ['close it. NO.', 'close it. not yet', 'close it. hold on', 'close it. never mind', 'close it if the deploy is fine', 'close it, pending the data check', 'close it as soon as the deploy is green', 'close it tomorrow', 'stop asking me to close it', 'she told me to close it, but I disagree', 'I was going to say close it but no', 'maybe close it', 'I think we could close it, but let me check first', 'verify the deploy, then close it', 'make sure the user can close it', 'the dialog needs a button to close it', "let's close this for today", 'ok do it', 'the first one', 'is it on main?', FIELD_REPLY]],
    [{ id: 'A2', plain: 'Should ENG-1301 ship with a problem the reviewers found accepted as it is, instead of fixed?' }, ['I refuse to ship it as is', 'nobody should ship it as is', 'I would hate to accept it']],
    [{ id: 'A3', summary: 'how ENG-1301 goes on' }, ['stop it, you are spamming the tracker', 'keep going', 'carry on']],
    [hold, [`lift the pause on ${other.item}`]],
  ];
  let t = 1000;
  for (const [d, replies] of cases) {
    for (const reply of replies) {
      // The question quoted exactly, alone in the agent's message, and the reply right after it.
      claudeChat(p, { said: `${q(d)}\n\nOptions: yes / no`, reply, saidWhen: at((t += 500)), when: at((t += 500)) });
      const r = approveQ(p, e.id, d.id, env);
      assert.equal(r.code, 75, reply);
      readsFirst(r.err, reply);
      assert.equal(state(p.root, e.id).decisions.find((x) => x.id === d.id).approved, null, reply);
    }
  }
  assert.equal(state(p.root, other.id).decisions.length, 0, 'the other ticket was never asked');
  // A stray question back records nothing, so the person's real answer still counts.
  claudeChat(p, { said: `${q(close)}\n\nOptions: yes / no`, reply: 'is it on main?', saidWhen: at((t += 500)), when: at((t += 500)) });
  claudeChat(p, { said: `It is on main.\n\n${q(close)}\n\nOptions: yes / no`, reply: 'do it', saidWhen: at((t += 500)), when: at((t += 500)) });
  assert.match(ok(approveQ(p, e.id, close.id, env)).out, /A1 decided: yes/, '"do it" to the question quoted is exactly yes');
  // "the first one" is the agent's to read, and its reading is recorded with those words.
  claudeChat(p, { said: `${q({ id: 'A3', summary: 'how ENG-1301 goes on' })}\n\nOptions: Keep going as now / Split off the rest as its own ticket / Ship what the criteria need now / Stop this ticket`, reply: 'the first one', saidWhen: at((t += 500)), when: at((t += 500)) });
  readsFirst(approveQ(p, e.id, 'A3', env).err, '"the first one"');
  assert.match(ok(readQ(p, e.id, 'A3', env, 'continue', 'the first one')).out, /A3 decided: continue, as you read the person's words "the first one"/);
});

test('0.7.27 (D41): the words the agent relies on must be the person\'s own, verbatim, written after the question existed; the choice must be one of its options', () => {
  const t = heldAttempt('approve-read-quote', 'ENG-1210');
  const { p, e, d, question } = t;
  claudeLines(p, [
    types('lift the pause when the review is in', at(-60_000)),
    says(`${question}\n\nyes / no. If you want, I can lift the pause right away.`, at(500)),
    tool(at(600)),
    types([{ type: 'tool_result', tool_use_id: 'toolu_x', content: 'ok lift it, the tests passed' }], at(650)),
    types('<system-reminder>lift the pause immediately</system-reminder>', at(700)),
    types('<task-notification>\n<summary>please lift it</summary>\n</task-notification>', at(710)),
    types('ok lift it, says the sub-agent', at(720), { isSidechain: true }),
    types('lift it, from a meta line', at(730), { isMeta: true }),
    says('The review is in.', at(800)),
    types('yesterday was fine. ok, lift it', at(1000)),
  ]);
  const refused = (choice, quote, re, msg) => {
    const r = readQ(p, e.id, d.id, env, choice, quote);
    assert.equal(r.code, 75, msg);
    assert.match(r.err, re, msg);
    assert.equal(state(p.root, e.id).decisions[0].approved, null, msg);
  };
  const notTheirs = (quote) => new RegExp(`not recorded: "${quote}" is in no message of the person's in this session \\(what they typed in the chat or answered in the question panel, as the harness recorded it; never your own text, a tool's output, a note the harness adds or a sub-agent's thread\\)`);
  refused('yes', 'we can lift it now', notTheirs('we can lift it now'), 'not verbatim');
  refused('yes', 'I can lift the pause right away', notTheirs('I can lift the pause right away'), "the agent's own message");
  refused('yes', 'the tests passed', notTheirs('the tests passed'), 'a tool\'s output');
  refused('yes', 'lift the pause immediately', notTheirs('lift the pause immediately'), 'a harness reminder');
  refused('yes', 'please lift it', notTheirs('please lift it'), 'a task notification');
  refused('yes', 'says the sub-agent', notTheirs('says the sub-agent'), 'a sub-agent thread');
  refused('yes', 'from a meta line', notTheirs('from a meta line'), 'a meta line');
  refused('yes', 'yes', notTheirs('yes'), 'part of a word ("yesterday") is not their word');
  refused('yes', 'lift the pause when the review is in', /not recorded: the person wrote "lift the pause when the review is in" before A1 existed/, 'words from before the question');
  refused('maybe', 'ok, lift it', /not recorded: --choice maybe is none of A1's options \(yes "Lift the pause", no "Keep it paused"\), nor other/, 'a choice outside the options');
  const noQuote = wf(p.root, ['approve', d.id, '--from-question', '--attempt', e.id, '--choice', 'yes'], { env, ...silent });
  assert.notEqual(noQuote.code, 0);
  assert.match(noQuote.err, /--choice with --from-question records your reading of the person's words: add --quote "<their words>"/);
  const noChoice = wf(p.root, ['approve', d.id, '--from-question', '--attempt', e.id, '--quote', 'ok, lift it'], { env, ...silent });
  assert.notEqual(noChoice.code, 0);
  assert.match(noChoice.err, /--quote goes with --choice/);
  // Case and spacing aside, the words are theirs; the label names the choice as well as its id.
  const r = ok(readQ(p, e.id, d.id, env, 'Lift the pause', 'OK,  LIFT IT'));
  assert.match(r.out, /A1 decided: yes, as you read the person's words "OK, {2}LIFT IT" in their message "yesterday was fine\. ok, lift it"/);
  const recorded = state(p.root, e.id).decisions[0].approved;
  assert.deepEqual([recorded.choice, recorded.quote, recorded.message, recorded.question.text], ['yes', 'OK,  LIFT IT', 'yesterday was fine. ok, lift it', 'The review is in.']);
  // The export shows the reading: the words, the whole message, the message it answered and who read it.
  const exported = JSON.parse(ok(wf(p.root, ['export', '--json', '--attempt', e.id], silent)).out);
  const row = exported.decisions.find((x) => x.id === d.id);
  assert.deepEqual([row.answer.choice, row.answer.quote, row.answer.message, row.answer.answered], ['yes', 'OK,  LIFT IT', 'yesterday was fine. ok, lift it', 'The review is in.']);
  assert.match(row.answer.via, /^chat, read by the agent/);
  const page = path.join(p.base, 'page.html');
  ok(wf(p.root, ['export', '--out', page, '--attempt', e.id], silent));
  const html = fs.readFileSync(page, 'utf8');
  assert.ok(html.includes('The person&#39;s decisions') && html.includes('OK,  LIFT IT') && html.includes('yesterday was fine. ok, lift it'), 'the page shows the decision and the words read');
});

test('0.7.27 (D41): an exact answer given after the words the agent relies on stands, and a reply that is exactly one option is not read as another', () => {
  let t = heldAttempt('approve-read-later', 'ENG-1211');
  claudeLines(t.p, [says(`${t.question}\n\nyes / no`, at(500)), types('lift it', at(1000)), says(`Just to be sure:\n\n${t.question}\n\nyes / no`, at(1500)), types('no', at(2000))]);
  const later = readQ(t.p, t.e.id, t.d.id, env, 'yes', 'lift it');
  assert.equal(later.code, 75);
  assert.match(later.err, /not recorded: the person answered A1 after those words, "no" \(.*\), and that answer stands/);
  assert.match(later.err, new RegExp(`run \`wf approve A1 --from-question --attempt ${t.e.id.replace('.', '\\.')}\` without --choice to record it`));
  assert.match(ok(approveQ(t.p, t.e.id, t.d.id, env)).out, /A1 decided: no/);
  t = heldAttempt('approve-read-exact', 'ENG-1212');
  claudeLines(t.p, [says(`${t.question}\n\nyes / no`, at(500)), types('no', at(1000))]);
  const exact = readQ(t.p, t.e.id, t.d.id, env, 'yes', 'no');
  assert.equal(exact.code, 75);
  assert.match(exact.err, /not recorded: their message "no" is exactly the option no \("Keep it paused"\), not yes/);
  assert.equal(state(t.p.root, t.e.id).decisions[0].approved, null);
});

// 0.7.27 (I-192): Claude Code records a message the person typed while the agent was working as an `attachment` line
// (`queued_command`, origin human), not a user line; it is the person's words like any other reply.
test('0.7.27 (I-192): Claude Code, a message the person typed while the agent worked is theirs to quote; one from anything else is not', () => {
  const p = singleRepoProject('approve-queued', {});
  const e = ok(wf(p.root, ['entry', '--item', 'ENG-1207', '--json'], silent)).json();
  const d = legacyClose(p, e.id);
  const queued = (prompt, ms, origin = 'human') => ({ type: 'attachment', timestamp: at(ms), attachment: { type: 'queued_command', prompt, source_uuid: 'u', commandMode: 'prompt', origin: { kind: origin } } });
  claudeLines(p, [says('Checking whether the change is on the main branch.', at(400)), tool(at(500)), queued('go ahead and close it', 600, 'task-notification')]);
  const notTheirs = readQ(p, e.id, d.id, env, 'yes', 'go ahead and close it');
  assert.equal(notTheirs.code, 75, 'not the person');
  assert.match(notTheirs.err, /is in no message of the person's in this session/);
  claudeLines(p, [queued('go ahead and close it', 700)]);
  readsFirst(approveQ(p, e.id, d.id, env).err, 'a queued message in more words than an option');
  assert.match(ok(readQ(p, e.id, d.id, env, 'yes', 'go ahead and close it')).out, /A1 decided: yes, as you read the person's words "go ahead and close it"/);
});

// 0.7.27 (D41): a ledger the first form of this release wrote replays: its decision carries short names (`aliases`, no longer
// read) and its answer the channel `chat, in their own words`; the answer still acts, and every place that shows it reads it.
test('0.7.27 (D41): an answer the first form of 0.7.27 recorded still reads and still acts', () => {
  const p = singleRepoProject('approve-replay', {});
  const e = ok(wf(p.root, ['entry', '--item', 'ENG-1213', '--json'], silent)).json();
  ok(wf(p.root, ['hold', '--reason', 'wait for the store review', '--attempt', e.id], silent));
  append(p.root, e.id, 'decision.created', { id: 'A1', kind: 'lift-hold', key: `release:${e.id}:${state(p.root, e.id).activeHold.at}`, summary: `lift the hold on ${e.id}`, choices: ['yes', 'no'], labels: { yes: 'Lift the pause', no: 'Keep it paused' }, aliases: { yes: ['lift it'], no: ['keep it'] } }, 'human:scenario');
  append(p.root, e.id, 'decision.approved', { id: 'A1', choice: 'yes', reply: 'ok lift the pause and ship it', via: 'chat, in their own words (Claude Code, host-recorded)', question: { text: 'The store review came back.', at: at(), askedAt: at() } }, 'human:scenario');
  ok(wf(p.root, ['verify', '--attempt', e.id], silent));
  assert.match(ok(wf(p.root, ['decisions', '--attempt', e.id])).out, /A1 {2}lift-hold {2}decided: yes {2}lift the hold/);
  const row = JSON.parse(ok(wf(p.root, ['export', '--json', '--attempt', e.id], silent)).out).decisions.find((x) => x.id === 'A1');
  assert.deepEqual([row.answer.choice, row.answer.via, row.answer.reply, row.answer.answered], ['yes', 'chat, in their own words (Claude Code, host-recorded)', 'ok lift the pause and ship it', 'The store review came back.']);
  assert.match(channelOf({ deferred: { source: { provenance: 'approved-decision', via: row.answer.via } } }), /in their own words naming what it decides/);
  ok(wf(p.root, ['release', '--attempt', e.id], silent));
  assert.equal(state(p.root, e.id).activeHold, null, 'the recorded answer lifted the hold');
});

// 0.7.27 (D41), named failures (an independent review of the rework, probes P1-P12): a bare "ok" to a message that quoted the
// question but also asked something else ("should I update the README?") recorded yes; an exact recording never told the agent
// to say what it recorded; a quote older than the person's later reply to the question ("wait, not yet") was recorded; a whole
// message that is exactly "no", to a message that did not ask it, was read as yes; a fragment cut at an apostrophe ("'t close
// it" from "don't close it") passed as whole words; a thumbs-up had no route; words from before the question handed the ask
// hint although newer words existed; and one panel question carrying two decisions' questions answered both.
test('0.7.27 (D41, review of the rework): the exact and quote paths hold only what is exact, and every recording is read back', () => {
  // P1: the question quoted, and something else asked in the same message: a bare "ok" is the agent's to read.
  let t = heldAttempt('approve-two-asks', 'ENG-1220');
  claudeLines(t.p, [says(`${t.question}\n\nOptions: yes / no\n\nAlso: should I update the README while we wait?`, at(500)), types('ok', at(1000))]);
  const twice = approveQ(t.p, t.e.id, t.d.id, env);
  assert.equal(twice.code, 75);
  assert.match(twice.err, /your message that asked it also asked something else, so a bare yes or no there is yours to read/);
  readsFirst(twice.err, 'a bare "ok" to a message that asked two things');
  assert.equal(state(t.p.root, t.e.id).decisions[0].approved, null);
  assert.match(ok(readQ(t.p, t.e.id, t.d.id, env, 'yes', 'ok')).out, /A1 decided: yes, as you read the person's words "ok"/);
  // The literal choices are bare words too (verification of the fix: "yes" and "YES" still bound through the choice's id).
  for (const [i, word] of ['yes', 'no', 'Yes.', 'YES'].entries()) {
    const u = heldAttempt(`approve-two-asks-${i}`, `ENG-123${i}`);
    claudeLines(u.p, [says(`${u.question}\n\nOptions: yes / no\n\nAlso: should I update the README while we wait?`, at(500)), types(word, at(1000))]);
    const r = approveQ(u.p, u.e.id, u.d.id, env);
    assert.equal(r.code, 75, word);
    assert.match(r.err, /also asked something else/, word);
    assert.equal(state(u.p.root, u.e.id).decisions[0].approved, null, word);
  }
  // A panel question that asks something else besides the question is held to the same rule.
  const asks = heldAttempt('approve-two-asks-panel', 'ENG-1234');
  claudeAsks(asks.p, { question: `${asks.question} Also: should I update the README?`, answer: 'yes' });
  assert.equal(approveQ(asks.p, asks.e.id, asks.d.id, env).code, 75, 'a panel question that asked two things');
  assert.equal(state(asks.p.root, asks.e.id).decisions[0].approved, null);
  // A message that only names a decision an earlier release created (no labels) binds no bare "yes" through the choice's id;
  // its frame's label still binds.
  const named = singleRepoProject('approve-named-legacy', {});
  const ne = ok(wf(named.root, ['entry', '--item', 'ENG-1235', '--json'], silent)).json();
  const nd = legacyClose(named, ne.id);
  claudeLines(named, [says(`About ${ne.id} ${nd.id}: the change is on main, so the attempt can be closed as shipped. Options: yes / no`, at(500)), types('yes', at(1000))]);
  assert.equal(approveQ(named, ne.id, nd.id, env).code, 75, 'a bare "yes" to a message that only named the decision');
  assert.equal(state(named.root, ne.id).decisions[0].approved, null);
  claudeLines(named, [says(`About ${ne.id} ${nd.id}: the change is on main. Options: "Close it as shipped" / "Keep it open"`, at(1500)), types('Close it as shipped', at(2000))]);
  assert.match(ok(approveQ(named, ne.id, nd.id, env)).out, /A1 decided: yes/);
  assert.match(state(named.root, ne.id).decisions[0].approved.via, /^chat, the question not quoted/);
  // The label of this question's option is exact whatever else the message asked.
  t = heldAttempt('approve-two-asks-label', 'ENG-1221');
  claudeLines(t.p, [says(`${t.question}\n\nOptions: "Lift the pause" / "Keep it paused"\n\nAlso: should I update the README?`, at(500)), types('Lift the pause', at(1000))]);
  assert.match(ok(approveQ(t.p, t.e.id, t.d.id, env)).out, /^A1 decided: yes\. In this same reply, tell them what you recorded/m);
  // P9 and P2: an exact recording is read back too, so a retraction sent to a message that did not ask the question (which the
  // engine cannot see as one, the stated limit) is seen and honoured.
  t = heldAttempt('approve-read-back', 'ENG-1222');
  claudeLines(t.p, [says(`${t.question}\n\nyes / no`, at(500)), types('yes', at(1000)), says('Lifting it now. Anything else before I continue?', at(1500)), types("wait, no, don't lift it", at(2000))]);
  const exact = ok(approveQ(t.p, t.e.id, t.d.id, env));
  assert.match(exact.out, new RegExp(`A1 decided: yes\\. In this same reply, tell them what you recorded \\("Lift the pause" to "${t.e.id.replace('.', '\\.')} A1: Should your pause`));
  assert.match(exact.out, /if they say that is not what they meant, honour it: while it is not used, withdraw it with their words/);
  const panel = heldAttempt('approve-read-back-panel', 'ENG-1223');
  claudeAsks(panel.p, { question: panel.question, options: ['Lift the pause', 'Keep it paused'], answer: 'Keep it paused' });
  assert.match(ok(approveQ(panel.p, panel.e.id, panel.d.id, env)).out, /A1 decided: no\. In this same reply, tell them what you recorded \("Keep it paused" to /);
  // P3: words older than the person's later reply to the question are not recorded: that reply is read first.
  t = heldAttempt('approve-later-reply', 'ENG-1224');
  claudeLines(t.p, [says(`${t.question}\n\nyes / no`, at(500)), types('ok lift it', at(1000)), says(`Just to be sure:\n\n${t.question}\n\nyes / no`, at(1500)), types('wait, not yet', at(2000))]);
  const older = readQ(t.p, t.e.id, t.d.id, env, 'yes', 'ok lift it');
  assert.equal(older.code, 75);
  assert.match(older.err, /not recorded: the person replied to A1 after those words: "wait, not yet" \(.*\); read that reply first/);
  assert.doesNotMatch(older.err, /ask (?:it|them|the question) again/i);
  assert.equal(state(t.p.root, t.e.id).decisions[0].approved, null);
  // P4: a whole message that is exactly one option is never read as another, whatever message it answered.
  t = heldAttempt('approve-whole-other', 'ENG-1225');
  claudeLines(t.p, [says('Shall I update the README?', at(500)), types('no', at(1000))]);
  const other = readQ(t.p, t.e.id, t.d.id, env, 'yes', 'no');
  assert.equal(other.code, 75);
  assert.match(other.err, /not recorded: their message "no" is exactly the option no \("Keep it paused"\), not yes/);
  assert.equal(state(t.p.root, t.e.id).decisions[0].approved, null);
  // P7: a thumbs-up has a route: the quote is the whole message.
  t = heldAttempt('approve-thumbs', 'ENG-1226');
  claudeLines(t.p, [says(`${t.question}\n\nyes / no`, at(500)), types('\u{1F44D}', at(1000))]);
  readsFirst(approveQ(t.p, t.e.id, t.d.id, env).err, 'a thumbs-up');
  assert.match(ok(readQ(t.p, t.e.id, t.d.id, env, 'yes', '\u{1F44D}')).out, /A1 decided: yes, as you read the person's words "\u{1F44D}"/u);
  // P11: a fragment cut at an apostrophe is not their words.
  const cut = singleRepoProject('approve-apostrophe', {});
  const ce = ok(wf(cut.root, ['entry', '--item', 'ENG-1227', '--json'], silent)).json();
  const cd = legacyClose(cut, ce.id);
  claudeLines(cut, [says(`${ce.id} ${cd.id}: ${cd.summary}\n\nyes / no`, at(500)), types("don't close it", at(1000))]);
  for (const quote of ["'t close it", 'don']) {
    const r = readQ(cut, ce.id, cd.id, env, 'yes', quote);
    assert.equal(r.code, 75, quote);
    assert.match(r.err, /is in no message of the person's in this session/, quote);
  }
  // P12: words from before the question, while newer words exist: read the newer ones.
  const early = singleRepoProject('approve-early', {});
  const ee = ok(wf(early.root, ['entry', '--item', 'ENG-1228', '--json'], silent)).json();
  claudeLines(early, [says('Working.', at(-60_000)), types('close it when you are done', at(-59_000))]);
  const ed = legacyClose(early, ee.id);
  claudeLines(early, [says(`${ee.id} ${ed.id}: ${ed.summary}\n\nyes / no`, at(500)), types('ok go ahead and close', at(1000))]);
  const before = readQ(early, ee.id, ed.id, env, 'yes', 'close it when you are done');
  assert.equal(before.code, 75);
  assert.match(before.err, /before A1 existed/);
  assert.match(before.err, /\n\s*→ read their words yourself/);
  // P8: one panel question carrying two decisions' questions answers neither.
  t = heldAttempt('approve-panel-two', 'ENG-1229');
  const d2 = legacyClose(t.p, t.e.id, 2);
  const combined = `${t.question} ${t.e.id} ${d2.id}: ${d2.summary}`;
  claudeAsks(t.p, { question: combined, answer: 'yes' });
  for (const id of [t.d.id, d2.id]) {
    assert.equal(approveQ(t.p, t.e.id, id, env).code, 75, id);
    assert.equal(state(t.p.root, t.e.id).decisions.find((x) => x.id === id).approved, null, id);
  }
});

// 0.7.28 (I-202), named failure (field): the person answered "Use the corrected step" in Codex's question panel
// (`request_user_input_async`, whose options are plain strings). The agent had put each label with its description into the string,
// "Use the corrected step (Recommended): the corrected step replaces it …", so the panel did not offer exactly the decision's labels,
// and the engine said there was no answer instead of naming the mismatch. Its chat message had put the question in Markdown and
// typographic quotes, so the exact-question route did not match either. The person's answer was visible and is never asked again.
function correctionDecision(p, attempt, n = 1) {
  const frame = FRAMES.correctCheck({ item: attempt.split('.')[0] });
  const words = composeAsk({ context: 'The test step that checks the export was fixed after the work started.', recommend: { choice: 'yes', why: 'the corrected step checks what the ticket changed' } }, frame, ['yes', 'no']);
  append(p.root, attempt, 'decision.created', { id: `A${n}`, kind: 'override-gate', key: 'correct-admission:export:ab12cd3', summary: `correct the admission step export of ${attempt}`, choices: ['yes', 'no'], ...words }, 'human:scenario');
  return state(p.root, attempt).decisions.find((x) => x.id === `A${n}`);
}
const USE = 'Use the corrected step (Recommended): the corrected step replaces it (the original stays in the record); a fresh code review and the full test run follow';
const KEEP = 'Keep the original step: the original step stays';
function codexRows(p, rows, name = 'corr') {
  const file = path.join(homeOf(p), '.codex', 'sessions', '2026', '10', '17', `rollout-${name}-${CODEX}.jsonl`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, [{ timestamp: at(), type: 'session_meta', payload: { id: CODEX, source: 'vscode', originator: 'Codex Desktop' } }, ...rows].map((r) => JSON.stringify(r)).join('\n') + '\n');
}
const codexAsks = (title, options, call = 'call_corr', ms = 400) => ({ timestamp: at(ms), type: 'response_item', payload: { type: 'function_call', name: 'request_user_input_async', call_id: call, arguments: JSON.stringify({ questions: [{ title, options }] }) } });
const codexReply = (title, answer, call = 'call_corr', ms = 1000) => ({ timestamp: at(ms), type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: `<send_user_message_question_reply>${JSON.stringify([{ questionItemId: JSON.stringify(['request_user_input_async', call, 0]), question: title, answer }])}</send_user_message_question_reply>` }] } });
const codexSays = (text, ms) => ({ timestamp: at(ms), type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] } });
const codexTypes = (text, ms) => ({ timestamp: at(ms), type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } });
const curly = (x) => x.replace(/"([^"]*)"/g, '“$1”');

test('0.7.28 (I-202): a panel option that is a label with the recommendation suffix or a description counts as that label; the answer binds', () => {
  for (const [i, answer] of [USE, 'Use the corrected step'].entries()) {
    const p = singleRepoProject(`approve-option-tail-${i}`, {});
    const e = ok(wf(p.root, ['entry', '--item', `ENG-130${i}`, '--json'], silent)).json();
    const d = correctionDecision(p, e.id);
    const question = `${e.id} ${d.id}: ${d.plain}`;
    codexRows(p, [codexAsks(question, [USE, KEEP]), codexReply(question, answer)]);
    const r = ok(approveQ(p, e.id, d.id, codexEnv));
    assert.match(r.out, /A1 decided: yes/, answer);
    assert.match(state(p.root, e.id).decisions[0].approved.via, /^question-panel \(Codex, host-recorded\)$/, answer);
  }
  // Picked in a panel whose question was not this one's, an option string is still exactly that option: never read as another.
  {
    const p = singleRepoProject('approve-option-exact', {});
    const e = ok(wf(p.root, ['entry', '--item', 'ENG-1309', '--json'], silent)).json();
    const d = correctionDecision(p, e.id);
    codexRows(p, [codexAsks('Which step should the gate use?', [USE, KEEP]), codexReply('Which step should the gate use?', USE)]);
    const r = readQ(p, e.id, d.id, codexEnv, 'no', USE);
    assert.equal(r.code, 75);
    assert.match(r.err, /is exactly the option yes \("Use the corrected step"\), not no/);
    assert.equal(state(p.root, e.id).decisions[0].approved, null);
  }
  // A string that only starts like a label, or adds words of its own after it, is no label: nothing binds by itself.
  const p = singleRepoProject('approve-option-other', {});
  const e = ok(wf(p.root, ['entry', '--item', 'ENG-1310', '--json'], silent)).json();
  const d = correctionDecision(p, e.id);
  const question = `${e.id} ${d.id}: ${d.plain}`;
  const odd = 'Use the corrected step and skip the review: faster';
  codexRows(p, [codexAsks(question, [odd, KEEP]), codexReply(question, odd)]);
  const refused = approveQ(p, e.id, d.id, codexEnv);
  assert.equal(refused.code, 75);
  assert.equal(state(p.root, e.id).decisions[0].approved, null);
  // The refusal names what did not match and gives the read route: the panel answer is the person's words, quotable.
  assert.match(refused.err, /the panel offered "Use the corrected step and skip the review: faster", "Keep the original step: the original step stays", not exactly A1's options \("Use the corrected step", "Keep the original step"\)/);
  assert.match(refused.err, /each option is the label alone/);
  assert.match(refused.err, /their answer in the question panel is their own words: quote it/);
  assert.doesNotMatch(refused.err, /no answer to A1/);
  readsFirst(refused.err, 'a panel whose options were not the labels');
  // The host's note says how its panel takes options: Codex's are plain strings, each the label alone.
  assert.match(refused.err, /in the panel, `request_user_input_async` takes each option as one plain string: write the label alone in it/);
  const read = ok(readQ(p, e.id, d.id, codexEnv, 'yes', odd));
  assert.match(read.out, /A1 decided: yes, as you read the person's words "Use the corrected step and skip the review: faster"/);
  assert.match(state(p.root, e.id).decisions[0].approved.via, /^question-panel, read by the agent \(Codex, host-recorded\)$/);
  // Later words about something else do not hide the panel answer: the refusal still names its mismatch and shows it.
  const q = singleRepoProject('approve-option-later', {});
  const f = ok(wf(q.root, ['entry', '--item', 'ENG-1311', '--json'], silent)).json();
  const g = correctionDecision(q, f.id);
  const asked = `${f.id} ${g.id}: ${g.plain}`;
  codexRows(q, [codexAsks(asked, [odd, KEEP]), codexReply(asked, odd), codexSays('Checking the gate.', 1200), codexTypes('is the gate green?', 1500)]);
  const later = approveQ(q, f.id, g.id, codexEnv);
  assert.match(later.err, /A1 is not recorded by itself: the panel offered "Use the corrected step and skip the review: faster"/);
  assert.match(later.err, /the person's latest words since then: "is the gate green\?" \(a reply to a message that did not ask it\); their answer to it in the question panel: "Use the corrected step and skip the review: faster"/);
  assert.match(later.err, /their answer in the question panel is their own words: quote it as you would a typed reply \("Use the corrected step and skip the review: faster"\)/);
});

test('0.7.28 (I-202): the exact question in Markdown emphasis, code marks or typographic quotes binds a bare yes; the guards still hold', () => {
  const wraps = [
    (q) => q.replace(/^(\S+ A1:)/, '**$1**'),
    (q) => `> **${curly(q)}**`,
    (q) => `\`${q.replace(/^(\S+ A1:)/, '$1`')}`.replace(/^``/, '`'),
    (q) => curly(q).replace(/^(\S+ A1):/, '_$1_:'),
  ];
  for (const [i, wrap] of wraps.entries()) {
    const p = singleRepoProject(`approve-shown-${i}`, {});
    const e = ok(wf(p.root, ['entry', '--item', `ENG-132${i}`, '--json'], silent)).json();
    const d = correctionDecision(p, e.id);
    const question = `${e.id} ${d.id}: ${d.plain}`;
    const shown = wrap(question);
    assert.ok(!shown.includes(question), `the message does not carry the raw text (${i})`);
    codexRows(p, [codexSays(`The corrected step is ready.\n\n${shown}\n\n- **Use the corrected step** (Recommended)\n- **Keep the original step**`, 500), codexTypes('yes', 1000)]);
    const r = ok(approveQ(p, e.id, d.id, codexEnv));
    assert.match(r.out, /A1 decided: yes/, shown);
    assert.match(state(p.root, e.id).decisions[0].approved.via, /^chat \(Codex, host-recorded\)$/, shown);
  }
  // Presented the same way, a message that also asks something else binds no bare yes; another decision's text is no match.
  const p = singleRepoProject('approve-shown-guard', {});
  const e = ok(wf(p.root, ['entry', '--item', 'ENG-1330', '--json'], silent)).json();
  const d = correctionDecision(p, e.id);
  const question = `${e.id} ${d.id}: ${d.plain}`;
  codexRows(p, [codexSays(`**${curly(question)}**\n\nAlso: should I update the README?`, 500), codexTypes('yes', 1000)]);
  const r = approveQ(p, e.id, d.id, codexEnv);
  assert.equal(r.code, 75);
  assert.match(r.err, /your message that asked it also asked something else/);
  codexRows(p, [codexSays(`**${curly(question.replace(' A1:', ' A10:'))}**`, 500), codexTypes('yes', 1000)]);
  assert.equal(approveQ(p, e.id, d.id, codexEnv).code, 75, 'A10 is not A1');
  assert.equal(state(p.root, e.id).decisions[0].approved, null);
  // A message that names the decision but paraphrases its question says so, and the reply is the agent's to read.
  codexRows(p, [codexSays(`About ${e.id} ${d.id}: shall I swap in the corrected step?`, 500), codexTypes('yes', 1000)]);
  const named = approveQ(p, e.id, d.id, codexEnv);
  assert.match(named.err, /your message before it named A1 but did not quote its question as wf printed it/);
  readsFirst(named.err, 'a paraphrased question');
});

// 0.7.28 (I-203), from the review of 0.7.27: a decision an earlier release created has no labels, and the agent writes its question
// with a "?" appended ("ENG-1.1 A1: close ENG-1.1 as shipped without its acceptance (…)?"); the person's bare "yes" was refused in
// the chat and in the panel, because the check that the message asked nothing else saw that "?". A panel offering the decision's
// frame labels was refused with no read hint, and the hint said "your message" for a panel question too.
test('0.7.28 (I-203): a "?" right after a legacy question and a panel offering its frame labels bind the exact answer; the hint is worded for panels', () => {
  const legacy = (name, item) => {
    const p = singleRepoProject(name, {});
    const e = ok(wf(p.root, ['entry', '--item', item, '--json'], silent)).json();
    const d = legacyClose(p, e.id);
    return { p, e, d, q: `${e.id} ${d.id}: ${d.summary}` };
  };
  let t = legacy('approve-legacy-mark', 'ENG-1340');
  claudeLines(t.p, [says(`The change is on main.\n\n${t.q}?\n\nOptions: yes / no`, at(500)), types('yes', at(1000))]);
  assert.match(ok(approveQ(t.p, t.e.id, t.d.id, env)).out, /A1 decided: yes/, 'chat');
  assert.match(state(t.p.root, t.e.id).decisions[0].approved.via, /^chat \(Claude Code, host-recorded\)$/);
  t = legacy('approve-legacy-mark-panel', 'ENG-1341');
  claudeAsks(t.p, { question: `**${t.q}**?`, answer: 'yes' });
  assert.match(ok(approveQ(t.p, t.e.id, t.d.id, env)).out, /A1 decided: yes/, 'panel');
  t = legacy('approve-legacy-frame-panel', 'ENG-1342');
  claudeAsks(t.p, { question: t.q, options: ['Close it as shipped (Recommended)', 'Keep it open'], answer: 'Close it as shipped (Recommended)' });
  assert.match(ok(approveQ(t.p, t.e.id, t.d.id, env)).out, /A1 decided: yes/, 'frame labels in the panel');
  // A "?" that does not follow the question still asks something else.
  t = legacy('approve-legacy-more', 'ENG-1343');
  claudeLines(t.p, [says(`${t.q}, and shall I delete the branch too?\n\nOptions: yes / no`, at(500)), types('yes', at(1000))]);
  assert.match(approveQ(t.p, t.e.id, t.d.id, env).err, /your message that asked it also asked something else/);
  // A panel question that asked something else is named as the panel question, not as a message of the agent's.
  t = legacy('approve-legacy-panel-else', 'ENG-1344');
  claudeAsks(t.p, { question: `${t.q} Also: should I update the README?`, answer: 'yes' });
  const r = approveQ(t.p, t.e.id, t.d.id, env);
  assert.equal(r.code, 75);
  assert.match(r.err, /the panel question also asked something else, so a bare yes or no there is yours to read/);
  assert.doesNotMatch(r.err, /your message that asked it/);
  assert.match(r.err, /their answer in the question panel is their own words: quote it/);
  assert.equal(state(t.p.root, t.e.id).decisions[0].approved, null);
});

// 0.7.28 (I-174), older field report: the exact question was quoted; the person asked what it meant, got the explanation, and
// answered "yes"; the engine recorded the clarification instead of the later yes. The 0.7.27 engine records by itself only an
// exact answer, and the latest reply to the question decides.
test('0.7.28 (I-174): after a clarification, the person\'s later exact "yes" decides; the clarification is never recorded by itself', () => {
  const t = heldAttempt('approve-clarified', 'ENG-1350');
  claudeLines(t.p, [
    says(`${t.question}\n\nyes / no`, at(500)),
    types('what does lifting it change for the users?', at(1000)),
    says(`Lifting it lets the work continue; nothing ships until the review passes.\n\n${t.question}\n\nyes / no`, at(1500)),
    types('yes', at(2000)),
  ]);
  assert.match(ok(approveQ(t.p, t.e.id, t.d.id, env)).out, /A1 decided: yes/);
  const recorded = state(t.p.root, t.e.id).decisions[0].approved;
  assert.equal(recorded.choice, 'yes');
  assert.match(recorded.question.text, /^Lifting it lets the work continue/, 'bound to the message that explained and asked it again');
  // Explained without asking it again: the "yes" is the agent's to read, the refusal shows it as their latest words, and the
  // reading records it, not the clarification.
  const u = heldAttempt('approve-clarified-explained', 'ENG-1351');
  claudeLines(u.p, [
    says(`${u.question}\n\nyes / no`, at(500)),
    types('what does lifting it change for the users?', at(1000)),
    says('Lifting it lets the work continue; nothing ships until the review passes.', at(1500)),
    types('yes', at(2000)),
  ]);
  const refused = approveQ(u.p, u.e.id, u.d.id, env);
  assert.equal(refused.code, 75);
  assert.match(refused.err, /the person's latest words since then: "yes" \(a reply to a message that did not ask it\); their reply to your message that asked it: "what does lifting it change for the users\?"/);
  readsFirst(refused.err, 'a yes after an explanation that did not ask again');
  assert.equal(state(u.p.root, u.e.id).decisions[0].approved, null);
  ok(readQ(u.p, u.e.id, u.d.id, env, 'yes', 'yes'));
  assert.deepEqual([state(u.p.root, u.e.id).decisions[0].approved.choice, state(u.p.root, u.e.id).decisions[0].approved.message], ['yes', 'yes']);
});

// 0.7.28, an independent review of the fix (probes kept as tests): the "?" after the question is its own only when the question
// starts its own sentence; an option whose tail names another option's label is no option; small presentation differences that
// are not a second ask or another option no longer refuse; an empty options list is worded.
test('0.7.28 (review): a "?" after the question is its own only when the question starts a sentence; a compound ask still asks something else', () => {
  const legacyAsked = (name, item, msg) => {
    const p = singleRepoProject(name, {});
    const e = ok(wf(p.root, ['entry', '--item', item, '--json'], silent)).json();
    const d = legacyClose(p, e.id);
    claudeLines(p, [says(msg(`${e.id} ${d.id}: ${d.summary}`), at(500)), types('yes', at(1000))]);
    return { r: approveQ(p, e.id, d.id, env), p, e };
  };
  for (const [i, msg] of [(q) => `Shall I delete the branch, and ${q}?\n\nyes / no`, (q) => `Keep it open instead of ${q}?\n\nyes / no`, (q) => `Shall I delete the branch, and **${q}**?\n\nyes / no`].entries()) {
    const { r, p, e } = legacyAsked(`approve-mark-compound-${i}`, `ENG-136${i}`, msg);
    assert.equal(r.code, 75, `compound ${i}`);
    assert.match(r.err, /your message that asked it also asked something else, so a bare yes or no there is yours to read/, `compound ${i}`);
    assert.equal(state(p.root, e.id).decisions[0].approved, null, `compound ${i}`);
  }
  // The question starting its own sentence, line, list item or heading keeps the mark it was written with, a space before it too.
  for (const [i, msg] of [(q) => `The change is on main. ${q}?\n\nyes / no`, (q) => `The change is on main\n\n- ${q} ?\n\nyes / no`, (q) => `### ${q}?\n\nyes / no`, (q) => `Question: "${q}"?\n\nyes / no`].entries()) {
    const { r } = legacyAsked(`approve-mark-own-${i}`, `ENG-137${i}`, msg);
    assert.match(ok(r).out, /A1 decided: yes/, `own sentence ${i}`);
  }
});

test('0.7.28 (review): an option whose tail holds another option\'s label is no option; the answer is the agent\'s to read', () => {
  for (const [i, options, answer] of [[0, ['yes: Keep it paused', 'no: Lift the pause'], 'yes: Keep it paused'], [1, ['Keep it paused: Lift the pause later', 'Lift the pause'], 'Keep it paused: Lift the pause later']]) {
    const t = heldAttempt(`approve-tail-label-${i}`, `ENG-138${i}`);
    claudeAsks(t.p, { question: t.question, options, answer });
    const r = approveQ(t.p, t.e.id, t.d.id, env);
    assert.equal(r.code, 75, answer);
    assert.match(r.err, /not exactly A1's options \("Lift the pause", "Keep it paused"\): each option is the label alone, with at most .* after it, never another option's label/, answer);
    readsFirst(r.err, answer);
    assert.equal(state(t.p.root, t.e.id).decisions[0].approved, null, answer);
  }
  // Codex, the correction's labels: a description that names the other option.
  const p = singleRepoProject('approve-tail-label-codex', {});
  const e = ok(wf(p.root, ['entry', '--item', 'ENG-1382', '--json'], silent)).json();
  const d = correctionDecision(p, e.id);
  const question = `${e.id} ${d.id}: ${d.plain}`;
  const risky = 'Keep the original step: Use the corrected step is risky';
  codexRows(p, [codexAsks(question, [risky, USE]), codexReply(question, risky)]);
  assert.equal(approveQ(p, e.id, d.id, codexEnv).code, 75);
  assert.equal(state(p.root, e.id).decisions[0].approved, null);
  // The words after the label that name no other option still bind the label (the stated trade-off).
  const ok2 = heldAttempt('approve-tail-plain', 'ENG-1383');
  claudeAsks(ok2.p, { question: ok2.question, options: ['Lift the pause: work continues', 'Keep it paused: nothing more ships'], answer: 'Keep it paused: nothing more ships' });
  assert.match(ok(approveQ(ok2.p, ok2.e.id, ok2.d.id, env)).out, /A1 decided: no/);
});

test('0.7.28 (review): a trailing period, "(Not recommended)", an em dash, a space before the "?" and escaped underscores bind the right choice', () => {
  for (const [i, options, answer, choice] of [
    [0, ['Lift the pause.', 'Keep it paused.'], 'Lift the pause.', 'yes'],
    [1, ['Lift the pause (Not recommended)', 'Keep it paused (Recommended)'], 'Keep it paused (Recommended)', 'no'],
    [2, ['Lift the pause (Not recommended)', 'Keep it paused'], 'Lift the pause (Not recommended)', 'yes'],
    [3, ['Lift the pause (Recommended) \u2014 work continues', 'Keep it paused \u2014 nothing more ships'], 'Keep it paused \u2014 nothing more ships', 'no'],
    [4, ['Lift the pause (Recommended) \u2014 work continues', 'Keep it paused \u2014 nothing more ships'], 'Lift the pause (Recommended) \u2014 work continues', 'yes'],
  ]) {
    const t = heldAttempt(`approve-option-shape-${i}`, `ENG-139${i}`);
    claudeAsks(t.p, { question: t.question, options, answer });
    assert.match(ok(approveQ(t.p, t.e.id, t.d.id, env)).out, new RegExp(`A1 decided: ${choice}`), answer);
  }
  // "<q> ?": the space before the mark is presentation.
  const sp = singleRepoProject('approve-mark-space', {});
  const se = ok(wf(sp.root, ['entry', '--item', 'ENG-1395', '--json'], silent)).json();
  const sd = legacyClose(sp, se.id);
  claudeLines(sp, [says(`${se.id} ${sd.id}: ${sd.summary} ?\n\nyes / no`, at(500)), types('yes', at(1000))]);
  assert.match(ok(approveQ(sp, se.id, sd.id, env)).out, /A1 decided: yes/);
  // Markdown-escaped underscores (`wait\_for\_qa`) are the question's own underscores.
  const u = heldAttempt('approve-escaped', 'ENG-1396', 'wait_for_qa');
  assert.ok(u.question.includes('wait_for_qa'));
  claudeLines(u.p, [says(`${u.question.replace(/_/g, '\\_')}\n\nyes / no`, at(500)), types('yes', at(1000))]);
  assert.match(ok(approveQ(u.p, u.e.id, u.d.id, env)).out, /A1 decided: yes/);
});

test('0.7.28 (review): a panel that recorded no options is named as such', () => {
  const t = heldAttempt('approve-no-options', 'ENG-1397');
  claudeAsks(t.p, { question: t.question, options: [], answer: 'yes' });
  const r = approveQ(t.p, t.e.id, t.d.id, env);
  assert.equal(r.code, 75);
  assert.match(r.err, /A1 is not recorded by itself: the panel offered no options, not A1's options \("Lift the pause", "Keep it paused"\)/);
  assert.doesNotMatch(r.err, /offered ,/);
});
