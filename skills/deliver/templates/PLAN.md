# Plan: <ticket id> <title>

Type: hotfix | bug | enhancement | new feature (simple | complex)
Revision: 1

## Risk

> Be aware of: what makes this change dangerous, in one or two lines.

**Level: low | high**

| Judged by | Level | Reasons and evidence |
|---|---|---|
| plan | | Reach: callers, data and users affected (sources). Reversibility: migrations, external writes, deploys (sources). Uncertainty: what is still unknown. |
| ground | | |

Approval (high only): the person's words, the time, and where they were given.

## Goal

> Be aware of: …

What the ticket asks for, with the ticket as its source, and how we will know it is done.

## Findings

> Be aware of: …

What the investigation established. Each fact cites its source: `src/loans/renew.ts:42`, a read-only query and its result, a log line, a screenshot in `evidence/`, or an external source with its date.

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

The steps in the target environment, as the project defines it. Each one maps to a check in `CHECKS.json`.

## Out of scope

> Be aware of: …

What this ticket will not change, and the separate tickets filed for what was found along the way.

## Decisions

> Be aware of: which decisions are waiting for the person.

### D1: <question>

- **Options:** A, B, C, each with its cost and consequences.
- **Market:** what competitors do, with sources and dates.
- **Industry standard:** with sources.
- **Recommendation:** the option, and why.
- **Decided:** the person's answer, the time, and where they gave it.
