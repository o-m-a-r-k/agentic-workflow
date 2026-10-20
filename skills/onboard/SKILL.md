---
name: onboard
description: Onboard or re-evaluate a project for agentic-workflow. Use when the user asks to set up or onboard.
---

1. Run `wf init` (`--from-07` for a 0.7 project).
2. Have a cheap model draft the policy from what `wf init` found.
3. Show the user each change, its reason, any hand edit it replaces and modules to rewrite. Write only what they confirm.
4. Run `wf doctor` and fix what it names.
