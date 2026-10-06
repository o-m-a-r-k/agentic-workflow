// How each deferral channel is named wherever a deferral is printed (the delivery output, the refusal that asks for the
// owner's acknowledgement, the delivered comment's known limits). No channel proves a person; each says how far it goes.
export const CHANNEL = {
  'host-recorded': "host-recorded (the owner session's transcript; a process running as you could have written it)",
  'interactive-terminal (unverified)': 'interactive-terminal (unverified: typed at a terminal; a pseudo-terminal wrapper can answer it)',
};
export const channelOf = (d) => CHANNEL[d.deferred?.source?.provenance] ?? (d.deferred?.source?.provenance ?? 'recorded before 0.4.5 (unverified)');
