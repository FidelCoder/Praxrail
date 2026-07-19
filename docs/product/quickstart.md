# Quickstart

This quickstart is the terminal-first product path. Email and Telegram are for
notifications and short remote actions; active development happens in the shell.

1. Diagnose the runtime.

```bash
praxrail doctor
praxrail runtime status
```

2. Create a project and add a repository.

```bash
praxrail project create --slug platform --name "Platform"
praxrail repo add owner/repo --project <project-id> --worker-profile default
praxrail repo inspect <repository-id>
praxrail repo approve <repository-id> --yes
```

Repository approval is intentionally separate from GitHub App installation. A
repository must pass inspection and owner approval before Praxrail writes to it.

3. Create and watch a task.

```bash
pxr chat --project <project-id> --repository <repository-id>
```

Inside the prompt:

```text
pxr> Make validation deterministic
pxr> /tasks
pxr> /exit
```

Scripted flows can still use the stable command form:

```bash
praxrail task create --project <project-id> --repository <repository-id> \
  --title "Improve validation" --request "Make validation deterministic"
praxrail task watch PXR-0001 --follow
praxrail task logs PXR-0001 --follow
```

4. Review evidence and publish.

```bash
praxrail task verification PXR-0001
praxrail task findings PXR-0001
praxrail task diff PXR-0001
praxrail task review PXR-0001 --reason "Verification is green"
praxrail task publish PXR-0001 --reason "Reviewed and ready" --yes
```

5. Use a human handoff only when active development is needed.

```bash
praxrail task attach PXR-0001 --reason "Need interactive diagnosis"
praxrail task shell PXR-0001
praxrail task return PXR-0001 --fencing-token <token> --reason "Patch ready"
```

The shell exits without returning ownership. Return, abandon, or recover the
workspace explicitly so the agent and human never write concurrently.
