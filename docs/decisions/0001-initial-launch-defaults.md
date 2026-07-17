# ADR 0001: Initial Launch Defaults

- Status: accepted for the foundation release
- Date: 2026-07-16

## Decision

- Product and repository name: Praxrail / `FidelCoder/Praxrail`.
- Product category: repository-agnostic autonomous agentic coding tool.
- Runtime: TypeScript on pinned Node.js 22 and pnpm 10.
- Deployment shape: one orchestration service plus PostgreSQL.
- Local and first-host packaging: Docker Compose.
- Source of truth and initial queue: PostgreSQL.
- GitHub identity: GitHub App, scoped to explicitly allowed repositories.
- Repository scope: multiple projects and software stacks through approved,
  repository-specific policies.
- Intake order: Telegram first; email deferred.
- Concurrency: one write-capable task per repository.
- Merge and production deployment: manual during calibration.
- Owner presentation timezone: `Africa/Nairobi` by default, configurable.
- Initial budget defaults: USD 5 per task, USD 25 per day, USD 300 per month.
- Retry defaults: three build attempts and two review-fix cycles.

The production host/provider, initial approved repository URLs, authorized
Telegram IDs, and live credentials are deployment inputs. The service refuses
to enable an integration until those inputs validate.

## Consequences

This keeps the first release operationally simple and makes external authority
explicit. Moving to multiple services, another queue, automatic merge, or
production deployment requires a new ADR and measured calibration evidence.
