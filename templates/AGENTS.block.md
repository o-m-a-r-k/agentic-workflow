## agentic-workflow ({project})

This project runs changes through agentic-workflow. The `wf` CLI enforces the rules below; when it refuses, fix the cause instead of working around it.

**Lifecycle.** `wf entry` → `wf plan` (criteria frozen before code) → `wf handoff implementer` → commit → `wf gate` → `wf handoff reviewer` (a different agent) → `wf review` + `wf accept` → `wf deliver` → tracker handoff with `wf tracker record`. `wf resume` always says what is next.

**Rules**
- Work only in the attempt's worktrees under `.wf-worktrees/`, never in the main checkouts.
- Never edit the worktrees while a gate runs (`wf status` shows it). A `--focused` gate is repair proof only; review and delivery need a gate without it.
- Report a step as done only after `wf` accepted it. Gate results, reviews and deliveries are proven by files under `.wf-evidence/`, which no one edits by hand.
- The reviewer never planned, wrote or owns the change.
- A user's "hold", "local only" or "don't push" is recorded at once with `wf hold --reason "<their words>"`; only they lift it (`wf release`).
- Never read, print or move secret values. Missing secrets are entered by the user with `wf secrets guide` in their own terminal.
- Tracker comments describe what to test in product language: no file paths, commits, hashes or test counts.
- Never set a ticket to done; a human does.

Lanes: {lanes}. Tracker: {tracker}. Delivery: {delivery}.

### Project invariants

{invariants}
