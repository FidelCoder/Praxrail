# Runtime Lifecycle

`praxrail runtime serve` is the foreground process used by service managers.
`start`, `stop`, and `restart` manage one background process for a developer
session. Both modes use the same PID lock, Unix socket, readiness check, graceful
shutdown, durable startup reconciliation, and bounded log file.

## Linux systemd

1. Install the CLI at `/usr/local/bin/praxrail` and the runtime package on the
   same host.
2. Create the `praxrail` system user and a mode-0600
   `/etc/praxrail/runtime.env`. Put secret file references in that file rather
   than literal command-line arguments.
3. Install `ops/systemd/praxrail-runtime.service`, then enable and start it with
   `systemctl enable --now praxrail-runtime`.
4. Verify `praxrail runtime status`. Use `journalctl -u praxrail-runtime` for
   service-manager output.

The unit restarts failed processes. Runtime startup migrates queue state and
reconciles expired workers, assignments, and workspace ownership before the
socket reports ready.

## macOS launchd

1. Install the CLI at `/usr/local/bin/praxrail`.
2. Create a mode-0600 `$HOME/.config/praxrail/runtime.env` containing the
   required runtime configuration and secret file references.
3. Install `ops/launchd/io.praxrail.runtime.plist` into
   `$HOME/Library/LaunchAgents`, then bootstrap it with `launchctl bootstrap`.
4. Verify `praxrail runtime status` after login or reboot.

## Recovery

- A second process cannot acquire the active PID lock.
- A stale PID file is removed only after the recorded process is absent.
- `start` succeeds only after `/health/ready` responds through the protected
  socket.
- `stop` sends `SIGTERM` and waits for graceful runtime and database shutdown.
- `praxrail runtime logs` reads at most the last 256 KiB of the managed log.
- Persistent recovery-required work is resolved through authenticated operator
  API commands; never edit PostgreSQL rows directly.
