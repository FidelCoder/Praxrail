# Role Permission Matrix

| Capability                 | Planner  | Builder           | Reviewer          | Release manager       | Reporter | Operator              |
| -------------------------- | -------- | ----------------- | ----------------- | --------------------- | -------- | --------------------- |
| Read task contract         | Yes      | Assigned          | Assigned          | Yes                   | Summary  | Yes                   |
| Propose task fields        | Yes      | No                | No                | No                    | No       | Yes                   |
| Change task state directly | No       | No                | No                | No                    | No       | No                    |
| Read repository            | Metadata | Assigned worktree | Assigned snapshot | Yes                   | No       | Yes                   |
| Modify worktree            | No       | Assigned only     | No                | No                    | No       | Emergency only        |
| Push task branch           | No       | No                | No                | Scoped publisher      | No       | Emergency only        |
| Merge pull request         | No       | No                | No                | Disabled in release 1 | No       | Human GitHub policy   |
| Read production secrets    | No       | No                | No                | No in release 1       | No       | Secret manager only   |
| Approve high-risk action   | No       | No                | No                | Evaluate only         | No       | Authorized owner only |

State changes are exposed only as domain commands that evaluate actor, current
state, policy, idempotency, approval, and budget in one transaction.
