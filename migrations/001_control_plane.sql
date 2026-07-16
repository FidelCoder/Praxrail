CREATE SEQUENCE IF NOT EXISTS task_key_sequence START 1;

CREATE TABLE IF NOT EXISTS projects (
  id uuid PRIMARY KEY,
  slug text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,62}$'),
  name text NOT NULL CHECK (length(name) BETWEEN 2 AND 120),
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'PAUSED', 'DISABLED')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS repositories (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES projects(id),
  github_repository_id bigint,
  full_name text NOT NULL UNIQUE CHECK (full_name = lower(full_name)),
  clone_url text NOT NULL,
  default_branch text NOT NULL,
  github_installation_id bigint,
  worker_profile text NOT NULL,
  write_concurrency integer NOT NULL DEFAULT 1 CHECK (write_concurrency = 1),
  verification_commands jsonb NOT NULL DEFAULT '[]'::jsonb,
  policy jsonb NOT NULL DEFAULT '{}'::jsonb,
  enabled boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (jsonb_typeof(verification_commands) = 'array'),
  CHECK (jsonb_typeof(policy) = 'object')
);

CREATE TABLE IF NOT EXISTS product_goals (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES projects(id),
  title text NOT NULL,
  description text NOT NULL,
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'ACHIEVED', 'PAUSED', 'CANCELLED')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS tasks (
  id uuid PRIMARY KEY,
  task_key text NOT NULL UNIQUE,
  project_id uuid REFERENCES projects(id),
  repository_id uuid REFERENCES repositories(id),
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 180),
  problem text NOT NULL DEFAULT '',
  desired_outcome text NOT NULL DEFAULT '',
  status text NOT NULL CHECK (status IN (
    'INBOX', 'REFINING', 'BLOCKED', 'READY', 'BUILDING', 'FAILED',
    'REVIEWING', 'CHANGES_REQUESTED', 'CI', 'PR_READY',
    'AWAITING_APPROVAL', 'MERGED', 'DEPLOYED', 'VERIFIED',
    'CANCELLED', 'ABANDONED'
  )),
  priority integer NOT NULL DEFAULT 50 CHECK (priority BETWEEN 0 AND 100),
  risk text CHECK (risk IN ('LOW', 'MEDIUM', 'HIGH')),
  contract jsonb,
  contract_version integer,
  budget_usd numeric(12, 4) CHECK (budget_usd > 0),
  maximum_attempts integer CHECK (maximum_attempts BETWEEN 1 AND 10),
  current_attempt integer NOT NULL DEFAULT 0 CHECK (current_attempt >= 0),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  blocked_reason text,
  paused_at timestamptz,
  created_by_type text NOT NULL,
  created_by_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  CHECK (contract IS NULL OR jsonb_typeof(contract) = 'object'),
  CHECK (status <> 'READY' OR (contract IS NOT NULL AND project_id IS NOT NULL AND repository_id IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS tasks_claim_idx
  ON tasks (priority DESC, created_at ASC)
  WHERE status = 'READY' AND paused_at IS NULL;
CREATE INDEX IF NOT EXISTS tasks_status_idx ON tasks (status, updated_at);
CREATE INDEX IF NOT EXISTS tasks_repository_idx ON tasks (repository_id, status);

CREATE TABLE IF NOT EXISTS task_dependencies (
  task_id uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  dependency_task_id uuid NOT NULL REFERENCES tasks(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (task_id, dependency_task_id),
  CHECK (task_id <> dependency_task_id)
);

CREATE TABLE IF NOT EXISTS task_attempts (
  id uuid PRIMARY KEY,
  task_id uuid NOT NULL REFERENCES tasks(id),
  attempt_number integer NOT NULL CHECK (attempt_number > 0),
  status text NOT NULL CHECK (status IN ('CLAIMED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED', 'EXHAUSTED')),
  worker_id text,
  failure_class text,
  failure_fingerprint text,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (task_id, attempt_number)
);

CREATE TABLE IF NOT EXISTS task_events (
  id bigserial PRIMARY KEY,
  task_id uuid NOT NULL REFERENCES tasks(id),
  event_type text NOT NULL,
  actor_type text NOT NULL,
  actor_id text NOT NULL,
  correlation_id uuid NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  CHECK (jsonb_typeof(payload) = 'object')
);

CREATE INDEX IF NOT EXISTS task_events_timeline_idx ON task_events (task_id, id);
CREATE INDEX IF NOT EXISTS task_events_correlation_idx ON task_events (correlation_id);

CREATE TABLE IF NOT EXISTS incoming_messages (
  id uuid PRIMARY KEY,
  provider text NOT NULL CHECK (provider IN ('TELEGRAM', 'EMAIL', 'GITHUB')),
  external_id text NOT NULL,
  sender_id text NOT NULL,
  chat_or_thread_id text,
  correlation_id uuid NOT NULL,
  authenticated boolean NOT NULL,
  envelope jsonb NOT NULL,
  body_digest text NOT NULL,
  task_id uuid REFERENCES tasks(id),
  received_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  UNIQUE (provider, external_id),
  CHECK (jsonb_typeof(envelope) = 'object')
);

CREATE TABLE IF NOT EXISTS clarification_questions (
  id uuid PRIMARY KEY,
  task_id uuid NOT NULL REFERENCES tasks(id),
  question text NOT NULL,
  status text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'ANSWERED', 'EXPIRED', 'CANCELLED')),
  answer_message_id uuid REFERENCES incoming_messages(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  answered_at timestamptz
);

CREATE UNIQUE INDEX IF NOT EXISTS one_open_clarification_per_task_idx
  ON clarification_questions (task_id) WHERE status = 'OPEN';

CREATE TABLE IF NOT EXISTS approvals (
  id uuid PRIMARY KEY,
  task_id uuid NOT NULL REFERENCES tasks(id),
  action text NOT NULL,
  requested_actor_id text NOT NULL,
  token_digest text NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED', 'EXPIRED', 'REVOKED')),
  reason text NOT NULL,
  expires_at timestamptz NOT NULL,
  decided_at timestamptz,
  decision_reason text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS worker_leases (
  resource_type text NOT NULL,
  resource_id text NOT NULL,
  worker_id text NOT NULL,
  fencing_token bigint NOT NULL,
  expires_at timestamptz NOT NULL,
  heartbeat_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (resource_type, resource_id)
);

CREATE TABLE IF NOT EXISTS repository_locks (
  repository_id uuid PRIMARY KEY REFERENCES repositories(id),
  task_id uuid NOT NULL REFERENCES tasks(id),
  attempt_id uuid REFERENCES task_attempts(id),
  worker_id text NOT NULL,
  fencing_token bigint NOT NULL,
  expires_at timestamptz NOT NULL,
  heartbeat_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS verification_runs (
  id uuid PRIMARY KEY,
  task_id uuid NOT NULL REFERENCES tasks(id),
  attempt_id uuid NOT NULL REFERENCES task_attempts(id),
  name text NOT NULL,
  command jsonb NOT NULL,
  status text NOT NULL CHECK (status IN ('PENDING', 'RUNNING', 'PASSED', 'FAILED', 'SKIPPED', 'CANCELLED')),
  required boolean NOT NULL DEFAULT true,
  exit_code integer,
  output_reference text,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (jsonb_typeof(command) = 'array')
);

CREATE TABLE IF NOT EXISTS review_findings (
  id uuid PRIMARY KEY,
  task_id uuid NOT NULL REFERENCES tasks(id),
  attempt_id uuid NOT NULL REFERENCES task_attempts(id),
  reviewed_sha text NOT NULL,
  severity text NOT NULL CHECK (severity IN ('CRITICAL', 'HIGH', 'MEDIUM', 'LOW')),
  file_path text,
  line_number integer CHECK (line_number > 0),
  title text NOT NULL,
  rationale text NOT NULL,
  status text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'RESOLVED', 'DISMISSED')),
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz
);

CREATE TABLE IF NOT EXISTS git_refs (
  id uuid PRIMARY KEY,
  task_id uuid NOT NULL REFERENCES tasks(id),
  attempt_id uuid REFERENCES task_attempts(id),
  repository_id uuid NOT NULL REFERENCES repositories(id),
  base_sha text NOT NULL,
  head_sha text,
  branch_name text NOT NULL,
  worktree_path text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (repository_id, branch_name)
);

CREATE TABLE IF NOT EXISTS pull_requests (
  id uuid PRIMARY KEY,
  task_id uuid NOT NULL UNIQUE REFERENCES tasks(id),
  repository_id uuid NOT NULL REFERENCES repositories(id),
  github_pull_request_id bigint NOT NULL,
  number integer NOT NULL,
  url text NOT NULL,
  head_sha text NOT NULL,
  state text NOT NULL CHECK (state IN ('OPEN', 'CLOSED', 'MERGED')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (repository_id, github_pull_request_id),
  UNIQUE (repository_id, number)
);

CREATE TABLE IF NOT EXISTS deployments (
  id uuid PRIMARY KEY,
  task_id uuid NOT NULL REFERENCES tasks(id),
  environment text NOT NULL,
  external_id text,
  status text NOT NULL CHECK (status IN ('PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED', 'ROLLED_BACK')),
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  CHECK (jsonb_typeof(evidence) = 'object')
);

CREATE TABLE IF NOT EXISTS cost_entries (
  id uuid PRIMARY KEY,
  task_id uuid REFERENCES tasks(id),
  attempt_id uuid REFERENCES task_attempts(id),
  project_id uuid REFERENCES projects(id),
  provider text NOT NULL,
  model text,
  input_tokens bigint NOT NULL DEFAULT 0 CHECK (input_tokens >= 0),
  output_tokens bigint NOT NULL DEFAULT 0 CHECK (output_tokens >= 0),
  amount_usd numeric(12, 6) NOT NULL CHECK (amount_usd >= 0),
  occurred_at timestamptz NOT NULL DEFAULT now(),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  CHECK (jsonb_typeof(metadata) = 'object')
);

CREATE INDEX IF NOT EXISTS cost_entries_daily_idx ON cost_entries (occurred_at, project_id);

CREATE TABLE IF NOT EXISTS notification_deliveries (
  id uuid PRIMARY KEY,
  task_id uuid REFERENCES tasks(id),
  provider text NOT NULL,
  destination_digest text NOT NULL,
  event_type text NOT NULL,
  idempotency_key text NOT NULL UNIQUE,
  payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'SENDING', 'SENT', 'FAILED', 'CANCELLED')),
  provider_delivery_id text,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  delivered_at timestamptz,
  CHECK (jsonb_typeof(payload) = 'object')
);

CREATE TABLE IF NOT EXISTS idempotency_keys (
  scope text NOT NULL,
  key text NOT NULL,
  request_digest text NOT NULL,
  status text NOT NULL CHECK (status IN ('PROCESSING', 'COMPLETED', 'FAILED')),
  response jsonb,
  locked_until timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (scope, key),
  CHECK (response IS NULL OR jsonb_typeof(response) = 'object')
);

CREATE TABLE IF NOT EXISTS outbox_events (
  id uuid PRIMARY KEY,
  topic text NOT NULL,
  aggregate_type text NOT NULL,
  aggregate_id text NOT NULL,
  idempotency_key text NOT NULL UNIQUE,
  payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'PROCESSING', 'DELIVERED', 'FAILED')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  available_at timestamptz NOT NULL DEFAULT now(),
  locked_at timestamptz,
  locked_by text,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  delivered_at timestamptz,
  CHECK (jsonb_typeof(payload) = 'object')
);

CREATE INDEX IF NOT EXISTS outbox_claim_idx ON outbox_events (available_at, created_at)
  WHERE status IN ('PENDING', 'FAILED');

CREATE TABLE IF NOT EXISTS webhook_deliveries (
  provider text NOT NULL,
  delivery_id text NOT NULL,
  event_name text NOT NULL,
  repository_full_name text,
  payload_digest text NOT NULL,
  status text NOT NULL CHECK (status IN ('RECEIVED', 'PROCESSED', 'REJECTED', 'FAILED')),
  correlation_id uuid NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  last_error text,
  PRIMARY KEY (provider, delivery_id)
);
