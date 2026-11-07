# Plan: <ticket id> <title>

Revision: 1
Risk: low | high
Read at: <repo>@<sha>, <repo>@<sha>

## Outcome

What is true in the users' world once this is delivered (the ticket as source), its most direct evidence, how soon; how this change reaches it.

## Deliveries

1. The users' part: <what it carries>; ships alone, or why not.
2. <the rest, when large>

## Surface

- S1 (<kind>): <fact shown or written>: <where users meet it>; equals <its record>; paths `src/loans/renew.ts:42`
- S2 (<kind>): not touched: <why, with its source>

## Risk

| By | Level | Reach, reversibility, uncertainty (sources) |
|---|---|---|
| plan | | |
| judge | | |

## Decisions

### D1: <question>

- Choice: <what>
- Source: `src/loans/renew.ts:42` `if (loan.renewals >= limit)`
- Beats: <the alternative>, because <why>

## Reach

- <consumer or sibling>: `path:line`; covered by <T<n> | C<n> | an existing test, named>

## Tests

| ID | Behaviour or edge case | Test (file › name) | Asserts | Fails before | Delivery |
|---|---|---|---|---|---|
| T1 | A renewal past the limit is refused | `src/loans/renew.test.ts › refuses the fourth renewal` | 409, the due date unchanged | yes | 1 |

## What people see

Purpose: who it is for, what they must come away knowing or doing.
Questions: their five to eight questions, in the order they bring them.
States: <state>, <state>

A state is a short name each of its screenshots carries, with the commit it shows.
Follows: the product's best existing screen of the same kind.

Leave this section out when nothing people see changes.

## Memos

### M1: <product question>

- Due: before delivery <n>
- Options: each with what the users or the business get, and its cost.
- Recommendation: <option>, because <why>.
- Decided: open | <the person's answer, time>
