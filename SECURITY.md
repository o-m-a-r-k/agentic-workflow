# Security

Please do not open public issues for security problems.

Report them through GitHub's private vulnerability reporting ("Report a vulnerability" on the repository's Security tab). Include steps to reproduce and the affected version.

Areas that matter most: anything that could expose secret values to an agent or a log, let a change bypass the gate or review, or run commands outside the project.

## Scope

agentic-workflow detects mistakes; it is not a sandbox. See "Trust model" in [docs/DESIGN.md](docs/DESIGN.md) for what its evidence does and does not prove.
