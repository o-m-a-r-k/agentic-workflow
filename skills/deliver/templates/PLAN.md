# Plan: <ticket id> <title>

Revision: 1
Risk: low | high
Read at: <repo>@<sha>, <repo>@<sha>
Oracles changed: none | <the checks_allow path the outcome needs changed>

## Outcome

What is true in the users' world once this is delivered (the ticket as source), its most direct evidence, how soon; how this design reaches it from the current state (`evidence/discover-<angle>.md`).

## Deliveries

1. <the ticket's work>

A second only when people are failing now and part 1 ends that sooner: who they are.

## Surface

- S1 (<kind>): <fact shown or written>: <where users meet it>; equals <its record>; paths `src/loans/renew.ts:42`
- S2 (<kind>): not touched: <why, with its source>

## Risk

Reach, reversibility, uncertainty, with sources.

## Design

The backend: contracts, data and migrations with their way back, state machines, sequences, idempotency and failure paths, linking the documents in `design/`. Every defect and impact Discover found, and where the design covers it.

## Decisions

### D1: <question>

- Choice: <what>
- Source: `src/loans/renew.ts:42` `if (loan.renewals >= limit)`, or the decision judge's file with what its sources establish
- Beats: <the alternative>, because <why>

## Questions

- Q1: <a product question no source here settles>: until the decision judge answers it and it becomes a decision.

## Tests

| ID | Behaviour or edge case | Test (file › name) | Asserts | Fails before | Delivery |
|---|---|---|---|---|---|
| T1 | A renewal past the limit is refused | `src/loans/renew.test.ts › refuses the fourth renewal` | 409, the due date unchanged | yes | 1 |

## What people see

Purpose: who it is for, what they must come away knowing or doing, and whether it brings them value.
Questions: their five to eight questions, in the order they bring them.
States: <name>, <name>
Pictured at: <for each state, its widths, languages and themes>
Follows: the product's best existing screen of the same kind.

Write `None.` here when nothing people see changes.
