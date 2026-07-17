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

## Terminal Product API

| Capability                                   | Owner | Developer | Reviewer | Worker                     | Operator |
| -------------------------------------------- | ----- | --------- | -------- | -------------------------- | -------- |
| Runtime status                               | Yes   | Yes       | No       | Yes                        | Yes      |
| Project-scoped task/events/output read       | Yes   | Yes       | Yes      | Assigned                   | Yes      |
| Register, heartbeat, and claim worker work   | No    | No        | No       | Own identity               | Yes      |
| Request and return human workspace ownership | Yes   | Yes       | No       | Pause acknowledgement only | Yes      |
| Bind or resume agent workspace ownership     | No    | No        | No       | Own active assignment      | Yes      |
| Drain or revoke workers                      | No    | No        | No       | No                         | Yes      |
| Recover expired or revoked ownership         | No    | No        | No       | No                         | Yes      |
| Rotate or revoke own API token               | Yes   | Yes       | Yes      | Yes                        | Yes      |

Bearer tokens are stored only as SHA-256 digests. Each identity has a role and
optional project scope. Authorization runs before service execution; worker
operations additionally require identity match, active lease, repository scope,
profile compatibility, assignment fence, and repository fence.
