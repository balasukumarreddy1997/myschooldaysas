CREATE SCHEMA IF NOT EXISTS identity AUTHORIZATION campus_migrator;

CREATE TABLE identity.organizations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  slug text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE identity.users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES identity.organizations(id) ON DELETE CASCADE,
  email text NOT NULL,
  name text NOT NULL,
  password_hash text NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  must_change_password boolean NOT NULL DEFAULT false,
  temporary_password_expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, email)
);
CREATE UNIQUE INDEX users_org_email_ci_idx ON identity.users (org_id, lower(email));
-- @rls identity.users
ALTER TABLE identity.users ENABLE ROW LEVEL SECURITY;
ALTER TABLE identity.users FORCE ROW LEVEL SECURITY;
CREATE POLICY users_org_scope ON identity.users
  USING (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = nullif(current_setting('app.org_id', true), '')::uuid);

CREATE TABLE identity.user_roles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES identity.organizations(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES identity.users(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN (
    'super_admin', 'org_admin', 'campus_admin', 'hod',
    'teacher', 'class_teacher', 'student', 'parent'
  )),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, user_id, role)
);
-- @rls identity.user_roles
ALTER TABLE identity.user_roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE identity.user_roles FORCE ROW LEVEL SECURITY;
CREATE POLICY user_roles_org_scope ON identity.user_roles
  USING (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = nullif(current_setting('app.org_id', true), '')::uuid);

CREATE TABLE identity.guardian_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES identity.organizations(id) ON DELETE CASCADE,
  guardian_user_id uuid NOT NULL REFERENCES identity.users(id) ON DELETE CASCADE,
  student_user_id uuid NOT NULL REFERENCES identity.users(id) ON DELETE CASCADE,
  relationship text NOT NULL DEFAULT 'guardian',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, guardian_user_id, student_user_id)
);
-- @rls identity.guardian_links
ALTER TABLE identity.guardian_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE identity.guardian_links FORCE ROW LEVEL SECURITY;
CREATE POLICY guardian_links_org_scope ON identity.guardian_links
  USING (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = nullif(current_setting('app.org_id', true), '')::uuid);

GRANT USAGE ON SCHEMA identity TO campus_app;
GRANT SELECT ON identity.organizations TO campus_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON identity.users, identity.user_roles, identity.guardian_links TO campus_app;
ALTER DEFAULT PRIVILEGES FOR ROLE campus_migrator IN SCHEMA identity
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO campus_app;

INSERT INTO public.schema_migrations (version) VALUES ('identity:001');
