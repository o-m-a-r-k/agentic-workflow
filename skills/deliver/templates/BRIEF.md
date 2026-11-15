# Brief: <ticket id> <title>

One page. Written by Discover; the builder's and the verifier's brief.

Lane: direct | standard | critical
Why this lane: <one line>
Undo: yes | no (can the project's way of undoing a delivery reverse this?)
Screen: none | touched | shaped
Read at: <repo>@<sha>

## Outcome

What is true in the users' world once this is delivered, on the ground `STATE.md` names. What the ticket did not ask for is not outcome.

## Acceptance

- A1: <observable: a test or a walk someone can run, and what it shows>

## Cause

For a bug: the reproduction, the root cause with its `file:line`, and where else the same defect exists. Otherwise `None.`

## Approach

A few lines: what changes, where. On the critical lane, `See DESIGN.md.`

## Paths

- <repo>/<path or glob the change is expected to touch; the repo as the worktrees name it, no braces>

## Found on the way

- <the item, shown by running what>: <fix in this ticket | hotfix ticket | next ticket | file | drop>, rubric row <n>

## Questions

- Q1: <a product question no source here settles>
