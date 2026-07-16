ALTER TABLE repositories
  ADD COLUMN IF NOT EXISTS mirror_path text,
  ADD COLUMN IF NOT EXISTS onboarding_status text NOT NULL DEFAULT 'PENDING',
  ADD COLUMN IF NOT EXISTS onboarding_report jsonb,
  ADD COLUMN IF NOT EXISTS instructions_digest text,
  ADD COLUMN IF NOT EXISTS approved_at timestamptz,
  ADD COLUMN IF NOT EXISTS approved_by text;

ALTER TABLE repositories DROP CONSTRAINT IF EXISTS repositories_onboarding_status_check;
ALTER TABLE repositories ADD CONSTRAINT repositories_onboarding_status_check
  CHECK (onboarding_status IN ('PENDING', 'INSPECTING', 'BLOCKED', 'APPROVED', 'DISABLED'));

UPDATE repositories SET onboarding_status = 'APPROVED'
  WHERE enabled = true AND onboarding_status = 'PENDING';

ALTER TABLE repositories ADD CONSTRAINT repositories_enable_requires_approval
  CHECK (enabled = false OR onboarding_status = 'APPROVED');

ALTER TABLE git_refs
  ADD COLUMN IF NOT EXISTS fencing_token bigint,
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'ACTIVE',
  ADD COLUMN IF NOT EXISTS cleaned_at timestamptz;

ALTER TABLE git_refs DROP CONSTRAINT IF EXISTS git_refs_status_check;
ALTER TABLE git_refs ADD CONSTRAINT git_refs_status_check
  CHECK (status IN ('ACTIVE', 'PUBLISHED', 'ORPHANED', 'CLEANED'));

ALTER TABLE task_attempts
  ADD COLUMN IF NOT EXISTS codex_thread_id text,
  ADD COLUMN IF NOT EXISTS prompt_version text,
  ADD COLUMN IF NOT EXISTS model text,
  ADD COLUMN IF NOT EXISTS diff_digest text,
  ADD COLUMN IF NOT EXISTS error_fingerprint text,
  ADD COLUMN IF NOT EXISTS review_cycles integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS cost_usd numeric(12, 6) NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS repository_onboarding_reports (
  id uuid PRIMARY KEY,
  repository_id uuid NOT NULL REFERENCES repositories(id),
  commit_sha text,
  policy jsonb NOT NULL,
  instructions jsonb NOT NULL,
  findings jsonb NOT NULL,
  command_results jsonb NOT NULL,
  safe_for_writes boolean NOT NULL,
  inspected_at timestamptz NOT NULL DEFAULT now(),
  inspected_by text NOT NULL,
  CHECK (jsonb_typeof(policy) = 'object'),
  CHECK (jsonb_typeof(instructions) = 'array'),
  CHECK (jsonb_typeof(findings) = 'array'),
  CHECK (jsonb_typeof(command_results) = 'array')
);

CREATE TABLE IF NOT EXISTS agent_runs (
  id uuid PRIMARY KEY,
  task_id uuid NOT NULL REFERENCES tasks(id),
  attempt_id uuid REFERENCES task_attempts(id),
  role text NOT NULL CHECK (role IN ('BUILDER', 'REVIEWER', 'REPAIR', 'REPORTER')),
  worker_profile text NOT NULL,
  thread_id text,
  prompt_version text NOT NULL,
  model text NOT NULL,
  base_sha text,
  head_sha text,
  status text NOT NULL CHECK (status IN ('PENDING', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED', 'BUDGET_EXHAUSTED', 'TIMED_OUT')),
  input_tokens bigint NOT NULL DEFAULT 0 CHECK (input_tokens >= 0),
  cached_input_tokens bigint NOT NULL DEFAULT 0 CHECK (cached_input_tokens >= 0),
  output_tokens bigint NOT NULL DEFAULT 0 CHECK (output_tokens >= 0),
  reasoning_tokens bigint NOT NULL DEFAULT 0 CHECK (reasoning_tokens >= 0),
  tool_actions jsonb NOT NULL DEFAULT '[]'::jsonb,
  result jsonb,
  transcript_reference text,
  failure_class text,
  failure_message text,
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  CHECK (jsonb_typeof(tool_actions) = 'array'),
  CHECK (result IS NULL OR jsonb_typeof(result) = 'object')
);

CREATE INDEX IF NOT EXISTS agent_runs_task_idx ON agent_runs (task_id, started_at);

CREATE TABLE IF NOT EXISTS review_runs (
  id uuid PRIMARY KEY,
  task_id uuid NOT NULL REFERENCES tasks(id),
  attempt_id uuid REFERENCES task_attempts(id),
  agent_run_id uuid REFERENCES agent_runs(id),
  reviewed_sha text NOT NULL,
  status text NOT NULL CHECK (status IN ('RUNNING', 'PASSED', 'CHANGES_REQUESTED', 'FAILED', 'INVALIDATED')),
  summary text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);

CREATE UNIQUE INDEX IF NOT EXISTS review_runs_sha_idx
  ON review_runs (task_id, reviewed_sha) WHERE status IN ('PASSED', 'CHANGES_REQUESTED');

CREATE TABLE IF NOT EXISTS policy_decisions (
  id uuid PRIMARY KEY,
  task_id uuid REFERENCES tasks(id),
  policy text NOT NULL,
  version text NOT NULL,
  decision text NOT NULL,
  reasons jsonb NOT NULL,
  evidence jsonb NOT NULL,
  actor_type text NOT NULL,
  actor_id text NOT NULL,
  correlation_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (jsonb_typeof(reasons) = 'array'),
  CHECK (jsonb_typeof(evidence) = 'object')
);

CREATE TABLE IF NOT EXISTS daily_reports (
  id uuid PRIMARY KEY,
  project_id uuid REFERENCES projects(id),
  window_start timestamptz NOT NULL,
  window_end timestamptz NOT NULL,
  timezone text NOT NULL,
  factual_data jsonb NOT NULL,
  body text NOT NULL,
  delivery_status text NOT NULL DEFAULT 'PENDING'
    CHECK (delivery_status IN ('PENDING', 'SENT', 'FAILED', 'CANCELLED')),
  idempotency_key text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  delivered_at timestamptz,
  CHECK (window_end > window_start),
  CHECK (jsonb_typeof(factual_data) = 'object')
);

CREATE TABLE IF NOT EXISTS reconciliation_actions (
  id uuid PRIMARY KEY,
  task_id uuid REFERENCES tasks(id),
  repository_id uuid REFERENCES repositories(id),
  action text NOT NULL,
  idempotency_key text NOT NULL UNIQUE,
  external_facts jsonb NOT NULL,
  result jsonb NOT NULL,
  actor_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (jsonb_typeof(external_facts) = 'object'),
  CHECK (jsonb_typeof(result) = 'object')
);

CREATE TABLE IF NOT EXISTS operator_actions (
  id uuid PRIMARY KEY,
  task_id uuid REFERENCES tasks(id),
  repository_id uuid REFERENCES repositories(id),
  action text NOT NULL,
  reason text NOT NULL,
  actor_id text NOT NULL,
  previous_value jsonb,
  new_value jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS security_assessments (
  id uuid PRIMARY KEY,
  commit_sha text NOT NULL,
  controls jsonb NOT NULL,
  findings jsonb NOT NULL,
  residual_risks jsonb NOT NULL,
  status text NOT NULL CHECK (status IN ('PASS', 'FAIL', 'APPROVAL_REQUIRED')),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (jsonb_typeof(controls) = 'array'),
  CHECK (jsonb_typeof(findings) = 'array'),
  CHECK (jsonb_typeof(residual_risks) = 'array')
);

CREATE TABLE IF NOT EXISTS acceptance_runs (
  id uuid PRIMARY KEY,
  environment text NOT NULL,
  pass_number integer NOT NULL CHECK (pass_number IN (1, 2)),
  scenarios jsonb NOT NULL,
  status text NOT NULL CHECK (status IN ('RUNNING', 'PASSED', 'FAILED', 'OPERATOR_GATED')),
  evidence jsonb NOT NULL,
  owner_signoff text,
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  CHECK (jsonb_typeof(scenarios) = 'array'),
  CHECK (jsonb_typeof(evidence) = 'object')
);

CREATE TABLE IF NOT EXISTS backup_runs (
  id uuid PRIMARY KEY,
  destination text NOT NULL,
  encrypted boolean NOT NULL,
  checksum text,
  size_bytes bigint CHECK (size_bytes >= 0),
  status text NOT NULL CHECK (status IN ('RUNNING', 'SUCCEEDED', 'FAILED', 'RESTORED')),
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  restore_tested_at timestamptz
);

CREATE TABLE IF NOT EXISTS pilot_runs (
  id uuid PRIMARY KEY,
  task_class text NOT NULL,
  sample_size integer NOT NULL CHECK (sample_size > 0),
  metrics jsonb NOT NULL,
  recommendation text NOT NULL CHECK (recommendation IN ('CONTINUE', 'CONSTRAIN', 'STOP')),
  owner_approval text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (jsonb_typeof(metrics) = 'object')
);

CREATE TABLE IF NOT EXISTS email_threads (
  id uuid PRIMARY KEY,
  provider text NOT NULL,
  external_thread_id text NOT NULL,
  sender_digest text NOT NULL,
  task_id uuid REFERENCES tasks(id),
  last_message_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, external_thread_id)
);

CREATE TABLE IF NOT EXISTS weekly_reports (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES projects(id),
  window_start timestamptz NOT NULL,
  window_end timestamptz NOT NULL,
  facts jsonb NOT NULL,
  recommendations jsonb NOT NULL,
  idempotency_key text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (window_end > window_start),
  CHECK (jsonb_typeof(facts) = 'object'),
  CHECK (jsonb_typeof(recommendations) = 'array')
);

CREATE TABLE IF NOT EXISTS project_policy_packs (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES projects(id),
  version integer NOT NULL CHECK (version > 0),
  policy jsonb NOT NULL,
  active boolean NOT NULL DEFAULT false,
  approved_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, version),
  CHECK (jsonb_typeof(policy) = 'object')
);

CREATE UNIQUE INDEX IF NOT EXISTS one_active_policy_pack_per_project_idx
  ON project_policy_packs (project_id) WHERE active = true;

ALTER TABLE deployments
  ADD COLUMN IF NOT EXISTS commit_sha text,
  ADD COLUMN IF NOT EXISTS adapter text,
  ADD COLUMN IF NOT EXISTS approval_id uuid REFERENCES approvals(id),
  ADD COLUMN IF NOT EXISTS idempotency_key text,
  ADD COLUMN IF NOT EXISTS health_evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS rollback_external_id text;

CREATE UNIQUE INDEX IF NOT EXISTS deployments_idempotency_idx
  ON deployments (idempotency_key) WHERE idempotency_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS incidents (
  id uuid PRIMARY KEY,
  task_id uuid REFERENCES tasks(id),
  deployment_id uuid REFERENCES deployments(id),
  severity text NOT NULL CHECK (severity IN ('CRITICAL', 'HIGH', 'MEDIUM', 'LOW')),
  title text NOT NULL,
  evidence jsonb NOT NULL,
  status text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'MITIGATED', 'CLOSED')),
  created_at timestamptz NOT NULL DEFAULT now(),
  closed_at timestamptz,
  CHECK (jsonb_typeof(evidence) = 'object')
);

CREATE TABLE IF NOT EXISTS email_attachments (
  id uuid PRIMARY KEY,
  email_thread_id uuid NOT NULL REFERENCES email_threads(id),
  external_message_id text NOT NULL,
  filename text NOT NULL,
  media_type text NOT NULL,
  size_bytes bigint NOT NULL CHECK (size_bytes >= 0),
  digest text NOT NULL,
  scan_status text NOT NULL CHECK (scan_status IN ('CLEAN', 'REJECTED')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (email_thread_id, external_message_id, digest)
);
