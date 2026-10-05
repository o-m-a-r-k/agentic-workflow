---
name: secrets
description: Help the user fill or fix secrets for an agentic-workflow project without ever seeing them. Use when a gate or doctor reports missing secrets or the user asks to set API keys or passwords.
---

# Secrets

You never see, type, print or move a secret value.

1. `wf secrets status` shows which needed keys are filled or missing (names only). A key is needed when a gate step lists it in `usedBy` or the catalog marks it `required: true`; the rest are listed once as "not needed by any step" and are never asked for.
2. If it prints `nothing to enter`, stop here: do not point the user at `wf secrets guide`.
3. For each missing needed key, show the user what it is for and where to get it (from `.workflow/secrets.yaml` `obtain`). Then ask the user to run `wf secrets guide` in their own terminal (not here, not with `!`). It asks only for needed keys, with a hidden prompt, checks the format and runs any verify command.
4. Poll `wf secrets status` until done, then continue the work.
