# Workspace Handoff Contract v1

Workspace ownership is separate from the task lifecycle. It controls who may
write the active task worktree.

```text
AGENT_OWNED -> PAUSING -> HUMAN_OWNED -> RETURNING -> AGENT_OWNED
      |           |             |            |
      +-----------+-------------+------------+-> RECOVERY_REQUIRED
```

## Rules

- Every ownership record carries a monotonically increasing fencing token and
  an expiring lease.
- Attach first requests agent cancellation. Human ownership is granted only
  after the worker acknowledges that the coding process stopped.
- The repository lock changes from the worker identity to `human:<actor>` using
  a new fencing token in the same transaction as the ownership transition.
- A shell receives the task worktree and a minimal explicit environment. Runtime,
  provider, database, and unrelated repository credentials are absent.
- Shell exit does not return work, approve it, resume the agent, or publish it.
- Return validates the managed path, symlinks, changed paths, forbidden content,
  and diff digest before entering `RETURNING`.
- A compatible authorized worker must claim `RETURNING` ownership with another
  fencing token before agent work resumes.
- Expired worker, assignment, human, or return leases enter
  `RECOVERY_REQUIRED`. Only an operator can choose human recovery or agent
  return, and the reason is audited.

Invalid transitions fail without changing the repository lock. Process crash,
SSH disconnect, runtime restart, worker loss, stale token, and changed worktree
tests are mandatory.

Return inspection includes tracked modifications and deletions plus untracked
files. It rejects changed symlinks, `.gitmodules`, Git submodule modes, managed
path escapes, forbidden paths, secret-like content, and evidence above 2 MiB.
The ownership row and repository lock remain human-owned after any failed
inspection.
