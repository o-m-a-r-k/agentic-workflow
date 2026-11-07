# State: <ticket id>

Fixed fields, written only by the orchestrator and overwritten each cycle. The scripts read the fields named here; the narrative goes to `evidence/log.md`.

Project: <project>
Ticket: <ticket id>
Type: hotfix | bug | enhancement | new feature (named by: the person | the ticket | inferred)
Outcome: <what is true for the users once delivered>; seen in: <its most direct evidence>; needed by: <when>
Target: <delivery target>, delivered status <status>
Started: <ISO time>
Driven by: <harness> session <id>, last cycle <time>
Profile: <name> | none
Worktree <repo>: <path from this folder> on <branch>, from <base> at <sha>
Delivery 1: <what it carries>: step <understand | plan | judge | person | build | read | review | verify | deliver | audit | clean> | held <why> | proven <time> | delivered <ISO time> <where>
Plan: revision <n>; plan-shape <pass | fail n>; surface <hash>
Rounds: <the delivery's line `rounds` printed>
Approval: none | <the person's words>, <time>, revision <n>, surface <hash>
Waiting for: nothing | the person: <what> | worker: <role, started time> | outside: <what, link>
Left behind: none | <worker, run, server, container, data or file>: <created by, how to remove>
Standing instructions: none | <the person's words, time>
Lanes: <what runs together, what each writes, where they merge>
Last return: <lane>: <role> <status>, <time>

## Surface

- S1 (<kind>): <fact shown or written>: <where users meet it>; equals <its record: the stored state or the provider's>

## Outside the ticket

- [surface] <a wrong fact people act on, reachable now>, <source>: hotfix <ticket> opened <time>, told <time>; starts after delivery <n> | now | vetoed <time> | tracker refused: <why>
- <other extra>, <source>, <who meets it, what fixing takes>: file <link> | fix now | fix after delivery | in the handoff
