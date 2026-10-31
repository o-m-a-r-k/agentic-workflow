# Plan: <ticket id> <title>

Type: hotfix | bug | enhancement | new feature (simple | complex)
Revision: 1 (what changed since the last revision)

## Risk

> Be aware of: what makes this change dangerous, in one or two lines.

**Level: low | high**

| Judged by | Level | Reasons and evidence |
|---|---|---|
| plan | | Reach: callers, data and users affected (sources). Reversibility: what can't be undone, such as migrations and external writes (sources). Uncertainty: what is still unknown. |
| ground | | |

## Goal

> Be aware of: …

What the ticket asks for, with the ticket as its source, and how we will know it is done.

## Findings

> Be aware of: …

What the investigation established. Each fact cites its source: `src/loans/renew.ts:42`, a read-only query and its result, a log line, a screenshot in `evidence/`, or an external source with its date.

## What people see

> Be aware of: …

**For the reader:** who it is for, what they must come away knowing or doing, and the questions they would ask there. The real states it can be in, the widths, languages and data shapes they meet.

**For the build:** where the change can alter composition, the product's best existing screens of the same kind it follows. The pictures in `evidence/`, as the `design` skill's Practice describes, which direction won and why, or the decision memo that asks the person. In words, what the chosen picture settles: the focal point, the groups and their names, where actions live and how they rank. The contents follow from these. The reader's file on the chosen picture. Leave this section out when nothing people see changes.

## Design

> Be aware of: …

The change, per repo and file. Each choice names the constraints it meets and the alternatives it beats, with sources. Work items that can run in parallel are marked as such. Items that share files are ordered.

## Tests

> Be aware of: …

| Behaviour or edge case | Test (file › name) | Asserts | Fails before the change? |
|---|---|---|---|
| A renewal past the limit is refused | `renew.test.ts › refuses the fourth renewal` | the response is 409 and the due date is unchanged | yes |

## Verification

> Be aware of: …

The steps in the target environment, as the project defines it. Each one maps to a check in `CHECKS.json`. A check due after a delivery step names how that step is rolled back if it fails.

## Out of scope

> Be aware of: …

What this ticket will not change, outside what it delivers, and why.

## Decisions

> Be aware of: which decisions are waiting for the person.

### D1: <question>

- **Options:** A, B, C, each with its cost and consequences.
- **Market:** what competitors do, with sources and dates.
- **Industry standard:** with sources.
- **Recommendation:** the option, and why.
- **Decided:** the person's answer, the time, and where they gave it.
