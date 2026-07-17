# ADR 0003: Repository-Agnostic Agentic Coding

- Status: accepted
- Date: 2026-07-17

## Context

Early delivery planning treated a fixed frontend and backend pair as the
product boundary. That framing does not support Praxrail's intended role as a
general coding system across projects, languages, and software stacks.

## Decision

Praxrail is an autonomous agentic coding tool. It is not tied to one application
or repository layout.

- A project may contain one or more approved repositories.
- Every repository defines its own worker profile, instructions, isolated
  execution image, verification commands, risk overrides, and write approval.
- Worker profiles are bounded repository-defined identifiers rather than a
  fixed frontend/backend enumeration.
- Task intake resolves an exact repository identity or an unambiguous worker
  profile. Ambiguous requests pause for clarification.
- Cross-repository changes use explicit dependent tasks and retain one
  write-capable task per repository.
- Product names and fixed software-stack roles do not belong in core policy,
  fixtures, or operational defaults.

## Consequences

Supporting a new software stack requires repository onboarding and policy, not
a Praxrail source change. Repository approval, isolated execution,
deterministic verification, independent review, budgets, manual merge, and
deployment gates remain mandatory regardless of stack.

The orchestration service may still be described as a control plane when
discussing internal security boundaries. That term does not define the product
category or limit the repositories Praxrail can work on.
