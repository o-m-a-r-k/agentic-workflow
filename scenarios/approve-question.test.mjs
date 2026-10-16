import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ok, singleRepoProject, state, wf } from './helpers.mjs';
import { channelOf } from '../engine/channels.mjs';

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
  const question = `${e.id} ${d.id}: ${d.summary}`;
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
  const question = `${e.id} ${d.id}: ${d.summary}`;
  const env = { CLAUDE_CODE_SESSION_ID: CLAUDE };
  const refusedWith = (re, msg) => {
    const r = approveQ(p, e.id, d.id, env);
    assert.equal(r.code, 75, msg);
    assert.match(r.err, re, msg);
    assert.equal(state(p.root, e.id).decisions[0].approved, null, msg);
  };

  const transcript = path.join(homeOf(p), '.claude', 'projects', 'proj', `${CLAUDE}.jsonl`);
  fs.mkdirSync(path.dirname(transcript), { recursive: true });
  fs.writeFileSync(transcript, JSON.stringify({ type: 'user', timestamp: at(1000), message: { role: 'user', content: 'yes, lift the hold on A1' } }) + '\n');
  refusedWith(/no answer to A1 in this session's question panel/, 'the person typed yes in the chat: prose is never read');
  // I-135: a panel that showed nothing is not the end of the road: the reply explains the decision, and the terminal route is given.
  refusedWith(/say in your reply, in plain words, what this decides, why, and what happens after each choice \(a question panel may not show, and its acceptance proves nothing\)/, 'the decision is explained in the reply');
  refusedWith(/When the panel does not show for them \(a phone, a mode without it\), ask in your message instead: quote the question exactly/, 'the chat route is given');
  refusedWith(new RegExp(`or they run \`wf approve A1 --attempt ${e.id.replace('.', '\\.')}\` in their own terminal`), 'the terminal route is given');
  claudeAsks(p, { question: `${e.id} ${d.id}: lift it?`, answer: 'yes' });
  refusedWith(/no answer to A1/, 'the question does not say what the decision does');
  claudeAsks(p, { question: `${d.id}: ${d.summary}`, answer: 'yes' });
  refusedWith(/no answer to A1/, 'the question does not name the attempt');
  claudeAsks(p, { question, options: ['yes', 'no', 'yes and delete the branch'], answer: 'yes' });
  refusedWith(/no answer to A1/, 'other options were offered');
  claudeAsks(p, { question, answer: 'yes', when: before });
  refusedWith(/no answer to A1/, 'answered before the decision existed');
  claudeAsks(p, { question, answer: 'yes', askedWhen: before });
  refusedWith(/no answer to A1/, 'asked before the decision existed, answered after');
  claudeAsks(p, { question: `${e.id} ${d.id}0: ${d.summary} (another decision)`, answer: 'yes' });
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

  // The person's "no" is recorded as theirs; the command stays refused and asks again.
  claudeAsks(p, { question, answer: 'no' });
  assert.match(ok(approveQ(p, e.id, d.id, env)).out, /A1 decided: no/);
  assert.equal(wf(p.root, ['release', '--attempt', e.id], silent).code, 75);
  assert.ok(state(p.root, e.id).activeHold, 'a "no" never lifts the hold');
  const again = state(p.root, e.id).decisions.at(-1);
  assert.notEqual(again.id, d.id);

  // Typed text that is not a choice (the panel's free-text option) is the person's answer too (0.7.8): recorded as `other` with
  // their words, it is answered and nothing more. It confirms nothing a choice would, so the hold stays and the next ask names it.
  claudeAsks(p, { question: `${e.id} ${again.id}: ${again.summary}`, answer: 'only on Monday' });
  const worded = ok(approveQ(p, e.id, again.id, env));
  assert.match(worded.out, /A2 decided: in the person's own words: "only on Monday" \(follow them; it grants nothing a choice would\)/);
  const own = state(p.root, e.id).decisions.find((x) => x.id === again.id).approved;
  assert.deepEqual([own.choice, own.words], ['other', 'only on Monday']);
  assert.match(own.via, /^question-panel \(Claude Code, host-recorded\)$/);
  const waits = wf(p.root, ['release', '--attempt', e.id], silent);
  assert.equal(waits.code, 75);
  assert.match(waits.err, /the earlier answer, A2, was in their own words: "only on Monday"/);
  assert.ok(state(p.root, e.id).activeHold, 'their own words never lift the hold');
  const third = state(p.root, e.id).decisions.at(-1);
  assert.notEqual(third.id, again.id);
  claudeAsks(p, { question: `${e.id} ${third.id}: ${third.summary}`, answer: 'yes' });
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
  const question = `${e.id} ${d.id}: ${d.summary}`;
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
  claudeAsks(p, { question: `${e.id} ${d.id}: ${d.summary}`, options: d.choices, answer: 'let it leave' });
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
  assert.match(asked.err, /when the panel does not show for them \(a phone, a mode without it\), ask in your message instead, quoting that question exactly/);
  const d = state(p.root, e.id).decisions[0];
  const question = `${e.id} ${d.id}: ${d.summary}`;
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
    claudeChat(p, { said: `Two questions.\n${question}\n${e.id} ${other.id}: ${other.summary}`, reply: 'yes', saidWhen: at(1500), when: at(2000) });
    assert.match(approveQ(p, e.id, d.id, env).err, /no answer to A1/);
  }
  // The question quoted exactly, its options listed, and the person's reply in their own words starting with a choice.
  claudeChat(p, { said: `Lifting the hold lets the work continue.\n\n${question}\n\nOptions: yes / no`, reply: 'Yes, go ahead', saidWhen: at(2500), when: at(3000) });
  assert.match(ok(approveQ(p, e.id, d.id, env)).out, /A1 decided: yes/);
  const recorded = state(p.root, e.id).decisions.find((x) => x.id === d.id).approved;
  assert.equal(recorded.choice, 'yes');
  assert.match(recorded.via, /^chat \(Claude Code, host-recorded\)$/);
});

test('chat on Codex: a reply after the agent\'s message with the exact question confirms; a word that only starts like a choice is the person\'s words', () => {
  const p = singleRepoProject('approve-chat-codex', {});
  const e = ok(wf(p.root, ['entry', '--item', 'ENG-941', '--json'], silent)).json();
  ok(wf(p.root, ['hold', '--reason', 'wait', '--attempt', e.id], silent));
  assert.equal(wf(p.root, ['release', '--attempt', e.id], silent).code, 75);
  const d = state(p.root, e.id).decisions[0];
  const question = `${e.id} ${d.id}: ${d.summary}`;
  const file = path.join(homeOf(p), '.codex', 'sessions', '2026', '10', '16', `rollout-chat-${CODEX}.jsonl`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const write = (reply) => fs.writeFileSync(file, [
    { timestamp: at(), type: 'session_meta', payload: { id: CODEX, source: 'vscode', originator: 'Codex Desktop' } },
    { timestamp: at(200), type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>cwd</environment_context>' }] } },
    { timestamp: at(500), type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: `The panel did not reach you, so here it is.\n\n${question}\n\nOptions: yes / no` }] } },
    { timestamp: at(1000), type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: reply }] } },
  ].map((r) => JSON.stringify(r)).join('\n') + '\n');
  const env = { CODEX_THREAD_ID: CODEX };
  write('yesterday was fine');
  assert.match(ok(approveQ(p, e.id, d.id, env)).out, /A1 decided: in the person's own words: "yesterday was fine"/);
  assert.equal(state(p.root, e.id).decisions[0].approved.choice, 'other', '"yesterday" is not "yes"');
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
  return { p, e, d, question: `${e.id} ${d.id}: ${d.summary}` };
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
  t = heldAttempt('chat-condition', 'ENG-971');
  claudeLines(t.p, [says(`${t.question}\n\nyes / no`, at(500)), types('Yes, but only after the failing test is fixed', at(1000))]);
  assert.match(ok(approveQ(t.p, t.e.id, t.d.id, env)).out, /A1 decided: yes \(their reply: "Yes, but only after the failing test is fixed"; follow any condition in it\)/);
  assert.equal(state(t.p.root, t.e.id).decisions[0].approved.reply, 'Yes, but only after the failing test is fixed');
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
