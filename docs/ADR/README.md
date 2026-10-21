# Architecture Decision Records

One file per decision: `NNN-short-title.md`, status `Proposed | Accepted | Superseded by NNN`.
Required before the listed task starts (PRD §17, `docs/PLAN.md` §2):

| ADR                              | Topic                                   | Task     |
| -------------------------------- | --------------------------------------- | -------- |
| [000](./000-monorepo-tooling.md) | Monorepo tooling                        | T01      |
| 001                              | Private media gateway vs presigned URLs | T20      |
| 002                              | Image processor / container / queue     | T12      |
| 003                              | ZIP implementation and partition sizes  | T24      |
| 004                              | Billing rating / Stripe meter mapping   | T27      |
| 005                              | RLS and guest claim security            | T02, T07 |
| 006                              | Video provider (v1.1)                   | V01      |
| 007                              | Database access layer                   | T02      |

Template:

```md
# NNN. Title

Status: Proposed · Date: YYYY-MM-DD · Task: Txx

## Context

## Decision

## Consequences

## Alternatives considered
```
