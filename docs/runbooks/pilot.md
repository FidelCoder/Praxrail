# Controlled Calibration Pilot

Begin only after deployment, reboot recovery, and the restore drill have passed.
Select an agreed sample count before starting. Eligible classes are
documentation, test-only changes, and isolated low-risk bug fixes. Every merge
is manual and every task retains its full evidence package.

For each class track first-pass CI rate, clarification rate, build/review retry
rate, finding severity, false completion, cost per reviewed PR, operator
interventions, manual rejections, rollbacks, and reverted changes. Review after
the sample count, not elapsed time.

Recommend:

- `CONTINUE` only when there is no false completion, critical/high finding,
  rollback, or scope expansion and intervention/retry rates meet the agreed
  gate.
- `CONSTRAIN` when work is useful but a repeated bounded failure needs a
  reliability task or narrower task class.
- `STOP` for security boundary failure, false completion, unbounded cost,
  unauthorized side effect, or unexplained rollback.

Any auto-merge proposal must name an eligible class, minimum sample size,
maximum rollback rate, required checks, kill switch, monitoring owner, and
explicit owner approval. The default remains off. Production deployment
remains separately approved and is never enabled by pilot metrics alone.
