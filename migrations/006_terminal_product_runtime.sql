CREATE TABLE IF NOT EXISTS api_identities (
  id uuid PRIMARY KEY,
  actor_id text NOT NULL,
  role text NOT NULL CHECK (role IN (
    'OWNER', 'DEVELOPER', 'PLANNER', 'SCHEDULER', 'WORKER',
    'BUILDER_WORKER', 'REVIEWER', 'CI_RECONCILER',
    'GITHUB_RECONCILER', 'RELEASE_MANAGER', 'REPORTER', 'OPERATOR'
  )),
  project_ids uuid[] NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'ACTIVE'
    CHECK (status IN ('ACTIVE', 'DISABLED')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (actor_id, role)
);

CREATE TABLE IF NOT EXISTS api_tokens (
  id uuid PRIMARY KEY,
  identity_id uuid NOT NULL REFERENCES api_identities(id) ON DELETE CASCADE,
  token_digest text NOT NULL UNIQUE CHECK (token_digest ~ '^[a-f0-9]{64}$'),
  label text NOT NULL,
  expires_at timestamptz,
  revoked_at timestamptz,
  last_used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS api_tokens_active_idx
  ON api_tokens (token_digest)
  WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS workers (
  id uuid PRIMARY KEY,
  identity_id uuid NOT NULL REFERENCES api_identities(id),
  name text NOT NULL UNIQUE,
  mode text NOT NULL CHECK (mode IN ('EMBEDDED', 'REMOTE')),
  version text NOT NULL,
  status text NOT NULL DEFAULT 'ACTIVE'
    CHECK (status IN ('ACTIVE', 'DRAINING', 'OFFLINE', 'REVOKED')),
  profiles text[] NOT NULL,
  repository_ids uuid[] NOT NULL,
  capabilities jsonb NOT NULL DEFAULT '[]'::jsonb,
  fencing_token bigint NOT NULL,
  lease_expires_at timestamptz NOT NULL,
  heartbeat_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (cardinality(profiles) BETWEEN 1 AND 50),
  CHECK (cardinality(repository_ids) BETWEEN 1 AND 500),
  CHECK (jsonb_typeof(capabilities) = 'array')
);

CREATE INDEX IF NOT EXISTS workers_claim_idx
  ON workers (status, lease_expires_at);

CREATE TABLE IF NOT EXISTS worker_assignments (
  id uuid PRIMARY KEY,
  worker_id uuid NOT NULL REFERENCES workers(id),
  task_id uuid NOT NULL REFERENCES tasks(id),
  repository_id uuid NOT NULL REFERENCES repositories(id),
  attempt_id uuid NOT NULL REFERENCES task_attempts(id),
  status text NOT NULL CHECK (status IN (
    'CLAIMED', 'RUNNING', 'CANCELLING', 'COMPLETED', 'FAILED',
    'CANCELLED', 'LOST'
  )),
  fencing_token bigint NOT NULL,
  lease_expires_at timestamptz NOT NULL,
  heartbeat_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);

CREATE UNIQUE INDEX IF NOT EXISTS one_live_assignment_per_task_idx
  ON worker_assignments (task_id)
  WHERE status IN ('CLAIMED', 'RUNNING', 'CANCELLING');

CREATE INDEX IF NOT EXISTS worker_assignments_lease_idx
  ON worker_assignments (lease_expires_at)
  WHERE status IN ('CLAIMED', 'RUNNING', 'CANCELLING');

CREATE TABLE IF NOT EXISTS workspace_ownerships (
  task_id uuid PRIMARY KEY REFERENCES tasks(id),
  repository_id uuid NOT NULL REFERENCES repositories(id),
  git_ref_id uuid REFERENCES git_refs(id),
  assignment_id uuid REFERENCES worker_assignments(id),
  state text NOT NULL CHECK (state IN (
    'AGENT_OWNED', 'PAUSING', 'HUMAN_OWNED', 'RETURNING',
    'RECOVERY_REQUIRED'
  )),
  owner_actor_id text,
  requested_actor_id text,
  worker_id uuid REFERENCES workers(id),
  fencing_token bigint NOT NULL,
  lease_expires_at timestamptz NOT NULL,
  reason text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (
    (state = 'HUMAN_OWNED' AND owner_actor_id IS NOT NULL) OR
    (state <> 'HUMAN_OWNED')
  )
);

CREATE INDEX IF NOT EXISTS workspace_ownerships_lease_idx
  ON workspace_ownerships (state, lease_expires_at);

CREATE TABLE IF NOT EXISTS task_output_chunks (
  id bigserial PRIMARY KEY,
  task_id uuid NOT NULL REFERENCES tasks(id),
  attempt_id uuid REFERENCES task_attempts(id),
  stream text NOT NULL CHECK (stream IN ('STDOUT', 'STDERR', 'SYSTEM')),
  content text NOT NULL CHECK (octet_length(content) <= 32768),
  truncated boolean NOT NULL DEFAULT false,
  occurred_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS task_output_chunks_cursor_idx
  ON task_output_chunks (task_id, id);

CREATE TABLE IF NOT EXISTS runtime_events (
  id bigserial PRIMARY KEY,
  event_type text NOT NULL,
  actor_type text NOT NULL,
  actor_id text NOT NULL,
  task_id uuid REFERENCES tasks(id),
  worker_id uuid REFERENCES workers(id),
  correlation_id uuid NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  CHECK (jsonb_typeof(payload) = 'object')
);

CREATE INDEX IF NOT EXISTS runtime_events_cursor_idx
  ON runtime_events (id);
