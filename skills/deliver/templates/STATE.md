# State: <ticket id>

Fixed fields, written only by the orchestrator and overwritten each cycle. The scripts read the fields named here; the narrative goes to `evidence/log.md`.

Project: <project>
Ticket: <ticket id>
Type: hotfix | bug | enhancement | new feature (named by: the person | the ticket | inferred)
Size: hotfix | small | new feature | big change
Outcome: <what is true for the users once delivered>; seen in: <its most direct evidence>; needed by: <when>
Target: <delivery target>, delivered status <status>
Started: <ISO time>
Driven by: <harness> session <id>, last cycle <time>
Profile: <name> | none
Worktree <repo>: <path from this folder or a folder above it, or absolute> on <branch>, from <base> at <sha>
Lane <name>: <path>, a lane's worktree, merged into its repo's
Delivery 1: <what it carries>: step <discover | design | challenge | build | read | review | verify | release | audit | clean> | delivered <ISO time> <where>
Plan: revision <n>; plan-shape <pass | fail n>; plan <hash>
Approval: none | asked <time> | <the person's words>, <time>, plan <hash>
Waiting for: nothing | worker: <role, started time> | outside: <what, link>
Left behind: none | <worker, run, server, container, data or file>: <created by, how to remove>
Standing instructions: none | <the person's words, time>
Lanes: <what runs together, what each writes, where they merge>
Last return: <lane>: <role> <status>, <time>

## Surface

- S1 (<kind>): <fact shown or written>: <where users meet it>; equals <its record: the stored state or the provider's>

## Outside the ticket

- [surface] <a wrong fact people act on, shown reachable now>, <what showed it>: hotfix <ticket> opened <time>, told <time>
- lead: <what may be wrong>, <why it can't be shown here>, <what would show it>: in the handoff
- <other extra>, <source>, <who meets it, what fixing takes>: decided <fix now | after | file>, evidence/decide-<k>.md
