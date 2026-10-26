-- Development-only PostgreSQL roles. Production credentials belong in a
-- secret manager and must never use these values.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'campus_migrator') THEN
    CREATE ROLE campus_migrator
      LOGIN PASSWORD 'migrator_dev_only'
      NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'campus_app') THEN
    CREATE ROLE campus_app
      LOGIN PASSWORD 'campus_app'
      NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
  END IF;
END
$$;

ALTER DATABASE campus OWNER TO campus_migrator;
GRANT CONNECT ON DATABASE campus TO campus_app;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
