# Release Acceptance

Run the 14 scenarios from `RELEASE_ACCEPTANCE_SCENARIOS` against a development
Telegram bot and sandbox GitHub organization. Use a clean database, clean
managed roots, new provider delivery IDs, and a new cost window for each pass.

For every scenario record the acceptance run ID, task ID, attempt IDs, event
range, commit/diff digest, PR number, provider delivery IDs, cost IDs, and
redacted logs. A scenario is `OPERATOR_GATED` when credentials or external
resources are absent; it is not a pass.

Required scenarios cover clear and ambiguous intake, unauthorized/replayed
Telegram, repository serialization, crash recovery, bounded verification
repair, reviewer repair and rereview, no-progress termination, budget
exhaustion, GitHub replay, manual merge reconciliation, daily report totals,
prompt-injection containment, and restart convergence at every lifecycle
boundary.

Run pass 1, destroy the environment, then run pass 2 from a clean environment.
The owner must sign notification clarity and manual merge behavior. Store both
runs through `AcceptanceService`. Release requires all scenario statuses
`PASSED`, no critical/high finding, and owner signoff.
