// How each deferral channel is named wherever a deferral is printed (the delivery output, the refusal that asks for the
// owner's acknowledgement, the delivered comment's known limits). No channel proves a person; each says how far it goes.
// 0.4.x ledgers record host-recorded and interactive-terminal sources; 0.7.0 records approved-decision.
export const CHANNEL = {
  'approved-decision': 'approved-decision (confirmed with `wf approve` at an interactive terminal; a pseudo-terminal wrapper can answer it)',
  // 0.7.3 (D12): the person answered in the agent session's question panel.
  'approved-decision:question-panel': 'approved-decision (answered by the person in the question panel; the harness recorded the answer, not a signature)',
  // Recorded only before 0.7.7: from then a deferral is always the person's decision (D17).
  'severity-rule': "the owner agent's judgement under the person's severity rule of 0.7.6 and earlier (a medium or low issue could wait; D10)",
  'host-recorded': "host-recorded (the owner session's transcript; a process running as you could have written it)",
  'interactive-terminal (unverified)': 'interactive-terminal (unverified: typed at a terminal; a pseudo-terminal wrapper can answer it)',
};
const keyOf = (source) => (source?.provenance === 'approved-decision' && String(source.via ?? '').startsWith('question-panel') ? 'approved-decision:question-panel' : source?.provenance);
export const channelOf = (d) => CHANNEL[keyOf(d.deferred?.source)] ?? (d.deferred?.source?.provenance ?? 'recorded before 0.4.5 (unverified)');
