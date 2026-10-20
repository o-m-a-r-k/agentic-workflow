# agentic-workflow

You give it a ticket, or a group of tickets, and they get delivered. You see the plan. You are asked only to approve a high-risk plan or to make a product decision, and each decision comes with the options, what the market does, the industry standard and a recommendation.

The plugin is text only: two skills and the files they read. Agents do the work, and fresh agents check it against raw sources (code, git, logs, data, the running app). No scripts or hooks enforce anything. It works in Claude Code and in Codex.

## How it works

Each ticket is sized when it is taken. Its type (hotfix, bug, enhancement, new feature) and size set which of these steps it gets, and how deep; every change is reviewed and verified:

1. take the ticket: a folder and fresh worktrees;
2. understand it, from several angles in parallel;
3. plan it, citing a source for every claim;
4. ground the plan: a fresh agent checks each claim;
5. challenge it: assume the plan failed, and ask why;
6. judge the risk: a high-risk plan waits for your approval;
7. build;
8. review;
9. verify in the target environment;
10. deliver, after a fresh agent checks the whole chain;
11. clean up.

The full method is [`skills/deliver/WORKFLOW.md`](skills/deliver/WORKFLOW.md). It takes a few minutes to read.

## Install

Claude Code:

```bash
claude plugin marketplace add o-m-a-r-k/agentic-workflow
claude plugin install agentic-workflow@agentic-workflow
```

Codex:

```bash
codex plugin marketplace add o-m-a-r-k/agentic-workflow
codex plugin add agentic-workflow@agentic-workflow
```

Claude Code sets each worker's effort from version 2.1.292, and reads `AGENTS.md` without a `CLAUDE.md` from 2.1.277. Earlier versions still work; workers then run at the session's effort.

## Use

1. **Onboard a project once:** ask for the `onboard` skill. An agent describes how your project delivers, from its repos, CI and your words, then proves the description by walking a practice ticket through every safe step, and shows you what it found, what it proved and what proving a change costs. Run it again at any time. It writes only what you confirm.
2. **Deliver:** ask for the `deliver` skill with one or more tickets and their type, for example "deliver EX-41 and EX-42, both bugs".

## Where things live

| What | Where |
|---|---|
| The project's rules | each repo's `AGENTS.md` |
| The project definition | `~/.agents/projects/<project>.md` |
| A ticket's state | `<work>/<ticket>/`, where `work` is set in the project definition: `PLAN.md`, `CHECKS.json`, `PROGRESS.md`, `evidence/` and the worktrees. It is never committed; inside a repo, it is excluded through `.git/info/exclude`. |
| Your role models | `~/.agents/workflow.yaml`, which overrides [`defaults.yaml`](skills/deliver/defaults.yaml) |
| Finished tickets | `~/.agents/records.jsonl`, one line each |

## Coming from 0.x

0.9.0 replaces 0.8 and earlier entirely. There is no `wf` command, no hooks, and no adapter. Remove the old `wf` link from your PATH, the `wf-*` agent definitions 0.x generated in each project, and the parts of each `AGENTS.md` that describe the `wf` workflow. Then run `onboard` for each project. The earlier code remains in the git history and its tags.

## License

[MIT](LICENSE)
