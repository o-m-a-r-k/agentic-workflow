# Security

Please do not open public issues for security problems.

Report them privately through GitHub's private vulnerability reporting ("Report a vulnerability" on the repository's
Security tab). Include steps to reproduce and the affected version. You will get an answer there.

## Scope

In scope, most of all:

- the evidence guard hook (`hooks/guard-evidence.mjs`): a command or tool input that writes to a project's evidence
  without being refused;
- evidence protection and verification (`engine/evidence.mjs`): a change to evidence that the next `wf` command does
  not refuse, or an engine write that follows a link out of the evidence;
- path handling (`engine/paths.mjs`, every path option of the CLI, lessons, improvements): a path that resolves
  somewhere other than where it was checked;
- export (`wf export`, `wf export screenshots`): a copy that writes outside its folder or reads through a link;
- anything that exposes secret values to an agent or a log, lets a change bypass the gate or review, or runs commands
  outside the project.

## What is and is not a security boundary

agentic-workflow is **defense in depth against a careless or mistaken agent**, not a sandbox and not a boundary
against a determined process running as the same user. Such a process can lift the protection, rewrite evidence, the
ledger, its chain and its anchor consistently; nothing local can prove otherwise. Reports that need that capability are
welcome as hardening ideas, not as vulnerabilities. See "Evidence integrity" in the [README](README.md) and "Trust
model" in [docs/DESIGN.md](docs/DESIGN.md).
