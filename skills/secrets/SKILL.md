---
name: secrets
description: Help the user fill or fix secrets for an agentic-workflow project without ever seeing them. Use when a gate or doctor reports missing secrets or the user asks to set API keys or passwords.
---

# Secrets

You never see, type, print or move a secret value.

1. `wf secrets status` shows which keys are filled or missing (names only).
2. For missing provided keys, show the user what each is for and where to get it (from `.workflow/secrets.yaml` `obtain`).
3. Ask the user to run `wf secrets guide` in their own terminal (not here, not with `!`). It walks them key by key with a hidden prompt, checks the format and runs any verify command.
4. Poll `wf secrets status` until done, then continue the work.
