## agentic-workflow ({project})

This project runs changes through agentic-workflow. The `wf` CLI enforces the rules below; when it refuses, fix the cause instead of working around it.

**Lifecycle.** `wf entry` → `wf plan` (criteria frozen before code) → `wf handoff implementer` → commit → code review (`wf handoff reviewer`, a different agent each round, `wf review`) until a round comes back clean → ONE `wf gate` on that tree → evidence review by a new reviewer → `wf accept` → `wf deliver` → show every delivered screenshot to the user in the chat with its caption and `wf shown` → tracker handoff (screenshots uploaded as files) with `wf tracker record`. `wf resume` always says what is next.

**Rules**

- Work only in the attempt's worktrees under `.wf-worktrees/`, never in the main checkouts.
- Review and gate never run side by side: no gate until a code-review round on the tree comes back clean, and no reviewer handoff while a gate runs (`wf` refuses both; only the user skips the order: they start a message with `override <attempt>:gate`, then `wf gate --reason "<their words>"` records it). Never edit the worktrees while a gate runs (`wf status` shows it); a stop needs its class (`wf stop --class major-finding|tree-change|owner-decision --reason "<why>"`). A `--focused` gate is repair proof only; acceptance and delivery need a gate without it.
- Report a step as done only after `wf` accepted it. Gate results, reviews and deliveries are proven by files under `.wf-evidence/`, which no one edits by hand.
- The reviewer never planned, wrote or owns the change.
- A user's "hold", "local only" or "don't push" is recorded at once with `wf hold --reason "<their words>"`; only they lift it: they start a message with `release <attempt>`, then `wf release`. Every owner-only decision is taken from the user's own message, never from a flag an agent passes (docs/trust-model.md).
- Never read, print or move secret values. Missing secrets are entered by the user with `wf secrets guide` in their own terminal.
- Tracker comments describe what to test in product language: no file paths, commits, hashes or test counts.
- Never set a ticket to done; a human does.
- Prior decisions (an earlier merge, an existing test, a prior verdict) are inputs, not authority: justify kept behaviour from who uses the surface and what they need.
- Lessons the project learned live in each repo's `.workflow/lessons/` (cross-repo ones in the adapter repo; `wf lesson list`). When the user corrects you or a ticket is reopened, record one in the repo it concerns with `wf lesson add --repo <name>` (committed and delivered with the attempt); a finding about the workflow itself is a plugin improvement (`wf improve add`), never a lesson.

Lanes: {lanes}. Tracker: {tracker}. Delivery: {delivery}.

### Project invariants

{invariants}
