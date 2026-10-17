// How each deferral channel is named wherever a deferral is printed (the delivery output, the refusal that asks for the
// owner's acknowledgement, the delivered comment's known limits). No channel proves a person; each says how far it goes.
// 0.4.x ledgers record host-recorded and interactive-terminal sources; 0.7.0 records approved-decision.
export const CHANNEL = {
  'approved-decision': 'approved-decision (confirmed with `wf approve` at an interactive terminal; a pseudo-terminal wrapper can answer it)',
  // 0.7.3 (D12): the person answered in the agent session's question panel.
  'approved-decision:question-panel': 'approved-decision (answered by the person in the question panel; the harness recorded the answer, not a signature)',
  // 0.7.18 (D26): the person replied in the chat to a message that asked exactly this question.
  'approved-decision:chat': 'approved-decision (answered by the person in the chat, replying to a message that asked exactly this question; the harness recorded the reply, not a signature)',
  // Recorded only before 0.7.7: from then a deferral is always the person's decision (D17).
  'severity-rule': "the owner agent's judgement under the person's severity rule of 0.7.6 and earlier (a medium or low issue could wait; D10)",
  // 0.7.8: the project's `leaving:` policy let the owner decide this level, with its recorded reason.
  'owner-reason': "the owner agent's recorded reason, under the project's `leaving:` policy",
  // 0.7.27 (I-188): an independent reviewer judged the issue not to be a defect, with its evidence and rationale.
  'reviewer-verdict': "an independent reviewer's verdict, with its evidence and rationale",
  'host-recorded': "host-recorded (the owner session's transcript; a process running as you could have written it)",
  'interactive-terminal (unverified)': 'interactive-terminal (unverified: typed at a terminal; a pseudo-terminal wrapper can answer it)',
};
const keyOf = (source) => (source?.provenance === 'approved-decision' && /^(question-panel|chat)\b/.test(String(source.via ?? '')) ? `approved-decision:${String(source.via).startsWith('chat') ? 'chat' : 'question-panel'}` : source?.provenance);
// The channel of a deferral, or of the closing of an issue as not a defect (0.7.27, I-188).
export const channelOf = (d) => {
  const source = (d.deferred ?? d.notADefect)?.source;
  return CHANNEL[keyOf(source)] ?? (source?.provenance ?? 'recorded before 0.4.5 (unverified)');
};
