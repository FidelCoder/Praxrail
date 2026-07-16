DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'praxrail_app') THEN
    CREATE ROLE praxrail_app LOGIN PASSWORD 'praxrail_app'
      NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;
  END IF;
END
$$;

GRANT CONNECT ON DATABASE praxrail TO praxrail_app;
GRANT USAGE ON SCHEMA public TO praxrail_app;
CREATE SCHEMA IF NOT EXISTS praxrail_jobs AUTHORIZATION praxrail_app;
