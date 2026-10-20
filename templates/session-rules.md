agentic-workflow runs changes here ({project}; tracker: {tracker}; delivery: {delivery}). When `wf` refuses, fix the cause it names.

- Work only in the attempt's worktrees under `.wf-worktrees/`.
- Run `wf` from your PATH; never copy or change the plugin.
- A step is done once `wf` accepted it.
- Never answer the person's decisions for them; record their words with `wf approve`.
- When the person says hold, stop or don't push, run `wf hold --reason "<their words>"` at once.
- Never read, print or move secret values.
- Tracker comments say what to test, in product language.
- Move a ticket to Done only when the delivery or the person says so.

{invariants}
