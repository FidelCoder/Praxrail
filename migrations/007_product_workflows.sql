ALTER TABLE tasks ADD COLUMN IF NOT EXISTS archived_at timestamptz;

CREATE INDEX IF NOT EXISTS tasks_product_list_idx
  ON tasks (project_id, repository_id, status, priority DESC, updated_at DESC)
  WHERE archived_at IS NULL;

CREATE TABLE IF NOT EXISTS channel_identities (
  id uuid PRIMARY KEY,
  identity_id uuid NOT NULL REFERENCES api_identities(id) ON DELETE CASCADE,
  project_id uuid REFERENCES projects(id) ON DELETE CASCADE,
  channel text NOT NULL CHECK (channel IN ('EMAIL', 'TELEGRAM')),
  role text NOT NULL,
  external_identity_digest text NOT NULL CHECK (external_identity_digest ~ '^[a-f0-9]{64}$'),
  destination text NOT NULL CHECK (length(destination) BETWEEN 1 AND 500),
  destination_hint text NOT NULL CHECK (length(destination_hint) BETWEEN 1 AND 200),
  status text NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING', 'VERIFIED', 'DISABLED', 'REVOKED')),
  verification_digest text CHECK (verification_digest ~ '^[a-f0-9]{64}$'),
  verification_expires_at timestamptz,
  verified_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (channel, external_identity_digest)
);

CREATE INDEX IF NOT EXISTS channel_identities_actor_idx
  ON channel_identities (identity_id, channel, status);

CREATE TABLE IF NOT EXISTS channel_preferences (
  id uuid PRIMARY KEY,
  identity_id uuid NOT NULL REFERENCES api_identities(id) ON DELETE CASCADE,
  project_id uuid REFERENCES projects(id) ON DELETE CASCADE,
  channel text NOT NULL CHECK (channel IN ('EMAIL', 'TELEGRAM')),
  minimum_severity text NOT NULL DEFAULT 'INFO'
    CHECK (minimum_severity IN ('INFO', 'ACTION_REQUIRED', 'WARNING', 'CRITICAL')),
  delivery_mode text NOT NULL DEFAULT 'IMMEDIATE'
    CHECK (delivery_mode IN ('IMMEDIATE', 'DIGEST', 'MUTED')),
  quiet_hours_start time,
  quiet_hours_end time,
  timezone text NOT NULL DEFAULT 'UTC',
  escalation_minutes integer CHECK (escalation_minutes BETWEEN 0 AND 10080),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS channel_preferences_scope_idx
  ON channel_preferences (
    identity_id,
    channel,
    COALESCE(project_id, '00000000-0000-0000-0000-000000000000'::uuid)
  );

CREATE TABLE IF NOT EXISTS channel_threads (
  id uuid PRIMARY KEY,
  channel_identity_id uuid NOT NULL REFERENCES channel_identities(id) ON DELETE CASCADE,
  project_id uuid REFERENCES projects(id),
  task_id uuid REFERENCES tasks(id),
  provider_thread_id text NOT NULL,
  last_provider_message_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (channel_identity_id, provider_thread_id)
);

CREATE TABLE IF NOT EXISTS remote_action_grants (
  id uuid PRIMARY KEY,
  channel_identity_id uuid NOT NULL REFERENCES channel_identities(id) ON DELETE CASCADE,
  task_id uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  action text NOT NULL CHECK (action IN (
    'TASK_CREATE', 'CLARIFY', 'APPROVE', 'REJECT', 'PAUSE', 'RESUME', 'STATUS'
  )),
  policy_revision text NOT NULL,
  token_digest text NOT NULL UNIQUE CHECK (token_digest ~ '^[a-f0-9]{64}$'),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS connector_states (
  channel text PRIMARY KEY CHECK (channel IN ('EMAIL', 'TELEGRAM')),
  enabled boolean NOT NULL DEFAULT false,
  credential_reference text,
  configuration jsonb NOT NULL DEFAULT '{}'::jsonb,
  failure_count integer NOT NULL DEFAULT 0 CHECK (failure_count >= 0),
  circuit_open_until timestamptz,
  last_success_at timestamptz,
  last_failure_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (jsonb_typeof(configuration) = 'object')
);

INSERT INTO connector_states (channel) VALUES ('EMAIL'), ('TELEGRAM')
ON CONFLICT (channel) DO NOTHING;
