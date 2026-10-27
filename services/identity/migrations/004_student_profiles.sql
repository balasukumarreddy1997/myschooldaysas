CREATE TABLE identity.profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES identity.organizations(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  date_of_birth date,
  gender text,
  phone text,
  address text,
  blood_group text,
  guardian_name text,
  guardian_email text,
  guardian_phone text,
  guardian_relationship text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, user_id),
  FOREIGN KEY (org_id, user_id) REFERENCES identity.users(org_id, id) ON DELETE CASCADE
);
-- @rls identity.profiles
ALTER TABLE identity.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE identity.profiles FORCE ROW LEVEL SECURITY;
CREATE POLICY profiles_org_scope ON identity.profiles
  USING (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = nullif(current_setting('app.org_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON identity.profiles TO campus_app;
ALTER DEFAULT PRIVILEGES FOR ROLE campus_migrator IN SCHEMA identity
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO campus_app;

INSERT INTO public.schema_migrations (version) VALUES ('identity:004');
