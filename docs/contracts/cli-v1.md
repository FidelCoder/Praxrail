# CLI Contract v1

## Grammar

```text
pxr [global flags] <command> [arguments]
```

Implemented groups are `runtime`, `profile`, `project`, `repo`, `task`,
`channel`, `approval`, `upgrade`, `support`, and `doctor`.

Global flags:

- `--profile NAME`
- `--json`
- `--quiet`
- `--no-color`
- `--non-interactive`
- `--timeout MILLISECONDS`
- `--dry-run`
- `--yes`
- `--follow`
- `--version`
- `--help`

## Output

- Human output is concise and written to stdout on success.
- Errors and remediation are written to stderr.
- `--json` emits one complete JSON value per command and no ANSI sequences.
- `--quiet` suppresses successful human output but not errors.
- Secrets, authorization headers, verification codes, approval tokens, and
  private message bodies never appear in successful output.

## Exit Codes

| Code | Meaning                                            |
| ---: | -------------------------------------------------- |
|    0 | Success                                            |
|    1 | Runtime or unexpected failure                      |
|    2 | Usage or validation error                          |
|    3 | Requested resource or runtime is not active        |
|    4 | Operation completed with degraded or blocked state |
|    5 | Authentication failed                              |
|    6 | Authorization denied                               |
|    7 | Conflict or stale version                          |
|    8 | Temporary remote failure                           |

Mutating commands carry generated idempotency keys. Destructive or high-risk
commands require `--yes` after the caller has reviewed the target and reason.

## Command Surface

```text
pxr version
pxr start|stop|restart|status|logs
pxr ask|command|cmd REQUEST
pxr watch|output|shell TASK
praxrail runtime serve|start|stop|restart|status|logs
praxrail profile list|use
praxrail project create|list|show|update|archive
praxrail repo add|inspect|approve|list|show|disable|remove
praxrail task create|list|show|status|watch|logs|events
praxrail task clarify|prioritize|pause|resume|cancel|retry|abandon|archive
praxrail task ownership|attach|shell|return|recover
praxrail task attempts|costs|verification|findings|diff|pull-request
praxrail task check|review|fix|publish
praxrail channel setup|link|verify|status|test|preference|rotate|disable|revoke
praxrail approval approve|reject
praxrail upgrade preflight
praxrail support bundle
praxrail doctor
```

Safe reads and commands carrying an idempotency key may retry bounded transient
failures. Non-idempotent mutations are never retried automatically. Watch and
log commands resume from durable cursors and honor cancellation signals.

## Representative Transcripts

```text
$ pxr --json version
{"version":"0.3.0"}

$ pxr --json status
{"running":true,"pid":4120,"status":{"apiVersion":"v1","status":"READY"}}

$ pxr task publish PXR-0001 --reason "review passed"
This command requires --yes after reviewing the target and reason

$ pxr --json unknown
{"error":"USAGE_ERROR","message":"Unknown command. Run pxr --help.","exitCode":2}
```

`--help`, completion scripts, and the manpage are generated release artifacts.
Scripts must use command names and JSON keys, never completion output.
