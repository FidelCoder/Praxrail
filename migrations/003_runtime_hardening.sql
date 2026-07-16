CREATE TABLE IF NOT EXISTS planner_runs (
  id uuid PRIMARY KEY,
  task_id uuid NOT NULL REFERENCES tasks(id),
  correlation_id uuid NOT NULL,
  planner text NOT NULL,
  model text NOT NULL,
  prompt_version text NOT NULL,
  input_tokens bigint NOT NULL DEFAULT 0 CHECK (input_tokens >= 0),
  output_tokens bigint NOT NULL DEFAULT 0 CHECK (output_tokens >= 0),
  validation_result text NOT NULL CHECK (validation_result IN ('READY', 'BLOCKED', 'INVALID')),
  proposal jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (jsonb_typeof(proposal) = 'object')
);

CREATE INDEX IF NOT EXISTS planner_runs_task_idx ON planner_runs (task_id, created_at);
CREATE INDEX IF NOT EXISTS planner_runs_correlation_idx ON planner_runs (correlation_id);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'praxrail_app') THEN
    EXECUTE 'GRANT USAGE ON SCHEMA public TO praxrail_app';
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO praxrail_app';
    EXECUTE 'GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO praxrail_app';
    EXECUTE 'ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO praxrail_app';
    EXECUTE 'ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO praxrail_app';
  END IF;
END
$$;
