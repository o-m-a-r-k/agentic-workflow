# Security

Please do not open public issues for security problems.

Report them privately through GitHub's private vulnerability reporting ("Report a vulnerability" on the repository's
Security tab). Include steps to reproduce and the affected version. You will get an answer there.

## Scope

In scope, most of all:

- anything that exposes a secret value to an agent, a log or a project command that does not list it, or passes an
  agent runtime's credentials to a project command (`engine/secrets.mjs`, `engine/env.mjs`);
- a path or id that resolves somewhere other than where it was checked, or a write that follows a link out of the
  project's state folders or the tickets folder (`adapters/tracker/files.mjs`, `engine/state-folders.mjs`);
- a project module that loads from an attempt's worktree instead of the fetched base (`engine/base-module.mjs`), so a
  ticket could change the code that judges or delivers it;
- an answer recorded as the person's that the person did not give (`engine/decisions.mjs`, `engine/hosts/`);
- a change to a ledger that the next read does not refuse (`engine/ledger.mjs`);
- anything that lets a change bypass review or the merge facts, or runs commands outside the project.

## What is and is not a security boundary

agentic-workflow catches the mistakes of a careless or mistaken agent; it is not a sandbox and not a boundary against
a determined process running as the same user (D6 in [docs/DESIGN.md](docs/DESIGN.md)). Such a process can rewrite a
ledger and its chain consistently; nothing local can prove otherwise. Reports that need that capability are welcome as
hardening ideas, not as vulnerabilities.
