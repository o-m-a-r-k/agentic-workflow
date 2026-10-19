---
name: onboard
description: Onboard or re-evaluate a project for agentic-workflow. Use when the user asks to set up or onboard.
---

1. Run `wf init` in the project folder (`--from-07` for a 0.7 project).
2. Have a cheap model draft the policy from what `wf init` found. Judge risk by what a mistake costs: money, writes outside that cannot be undone, data lost, access granted. Each risk path cites its files.
3. Show the user each change, its reason and any hand edit it replaces. Write only what they confirm.
4. Run `wf doctor` and fix what it names.
