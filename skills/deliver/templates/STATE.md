# State: <ticket id>

Fixed fields, written only by the orchestrator and overwritten each cycle. The scripts read them; the narrative goes to `evidence/log.md`. `Risk lane:` stays empty until Discover has returned and `lane --paths` has run; then it is `direct`, `standard` or `critical`.

Project: <project>
Ticket: <ticket id>
Type: hotfix | bug | enhancement | new feature (named by: the person | the ticket | inferred)
Risk lane:
Screen: none | touched | shaped
Hotfix: yes | no
Outcome: <what is true for the users once delivered>
Ground: <the screens, endpoints, messages or files the ticket names; never code>
Target: <delivery target>, delivered status <status>
Started: <ISO time>
Profile: <name> | none
Worktree <repo>: <path from this folder or a folder above it, or absolute> on <branch>, from <base> at <sha>
Lane <name>: <path>, an extra worktree for a part built in parallel, merged into its repo's
Step: take | discover | shape | design | build | verify | gate | read | deliver | audit | accept
Waiting for: nothing | worker: <role, started time> | the person: <what> | outside: <what, link>
Approval: none | asked <time> | <the person's words>, <time>
Question sheet: <first 12 of QUESTIONS.md's sha256, once the person has seen it>
Delivered: <ISO time> <where>
Accepted: <ISO time>
Left behind: none | <worker, run, server, container, data or file>: <created by, how to remove>
Standing instructions: none | <the person's words, time>

## Rejections

- <missed purpose | defect | new wish>: <the rejection in one line, the person's word on its class, time>

## Found on the way

The triage judge's rulings (`evidence/triage-<n>.md`).

- [fixed] <what, where; the commit once it is made>
- [hotfix <ticket>] <a wrong fact people act on, reachable now, outside this ticket>
- [next <ticket>] <a bug whose fix touches a boundary>
- [note] <wrong or worth having, not this ticket's; what shows it; in the handoff, no ticket>
- [lead] <what may be wrong, why it could not be shown, what would show it>
