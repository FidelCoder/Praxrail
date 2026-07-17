# External Integration Setup

No live credential belongs in this repository. Use a managed secret store or
host-level secret injection.

## Telegram

1. Create a development bot through BotFather.
2. Generate a high-entropy webhook path secret.
3. Record authorized numeric user and chat IDs.
4. Set `TELEGRAM_ENABLED=true` only after token, secret, and both allowlists are
   populated.
5. Register `https://<host>/webhooks/telegram/<secret>` with Telegram.
6. Send an unauthorized and authorized test update and verify audit outcomes.

## GitHub App

1. Create the App using `config/github-app-manifest.example.json` as the minimum
   permission reference.
2. Generate a private key and store only its base64-encoded secret-store value.
3. Generate a high-entropy webhook secret.
4. Install the App only on sandbox repositories first.
5. Configure exact `owner/name` entries in `GITHUB_ALLOWED_REPOSITORIES`.
6. Set `GITHUB_ENABLED=true` only after all values validate.
7. Deliver signed `ping`, `pull_request`, and `workflow_run` fixtures.

Repository access is project-independent. Add each target explicitly, complete
its repository-specific inspection and owner approval, and verify its isolated
worker profile before allowing Praxrail to write to it. Installing the App does
not itself approve a repository for coding work.

## OpenAI/Codex

1. Create two development-only project-scoped service accounts with budget
   limits: one builder identity and one reviewer identity.
2. Mount them separately as `CODEX_BUILDER_API_KEY_FILE` and
   `CODEX_REVIEWER_API_KEY_FILE`. Configuration rejects missing or identical
   identities.
3. Never inject either key into repository commands. The reviewer runs
   read-only with network and web search disabled; the builder is restricted to
   its assigned worktree with network disabled.
4. Revoke each service-account key independently during a credential drill and
   prove that the other worker remains functional.

## DNS And TLS

1. Allocate a development-only hostname for provider webhooks.
2. Terminate TLS with an automatically renewed public certificate.
3. Forward only the Telegram and GitHub webhook paths to Praxrail.
4. Verify certificate renewal, request-size limits, and provider delivery from
   outside the private network before enabling either integration.

## Redacted Inventory

Record provider, credential owner, secret-store reference, environment, scoped
resources, created date, last rotation, next rotation, and revocation procedure.
Never record token values, private keys, webhook secrets, or screenshots that
display them. Attach the exported GitHub App manifest and provider delivery IDs
as evidence.

## Rotation

Disable the integration, revoke or rotate the provider credential, update the
secret store, restart the service, run the readiness check, then re-enable event
delivery. Search logs and audit records for suspected exposure without copying
secret values into the incident record.

Telegram, GitHub, OpenAI, DNS/TLS, and sandbox repositories must each be
disableable or revocable without changing the others. A successful rotation
ends with a signed test delivery and a check that the previous credential no
longer authenticates.
