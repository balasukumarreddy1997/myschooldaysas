CREATE SCHEMA IF NOT EXISTS live AUTHORIZATION campus_migrator;

CREATE TABLE live.sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  title text NOT NULL,
  teacher_user_id uuid NOT NULL REFERENCES identity.users(id),
  mode text NOT NULL CHECK (mode IN ('section', 'class')),
  status text NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'live', 'ended', 'cancelled')),
  starts_at timestamptz NOT NULL,
  started_at timestamptz,
  ended_at timestamptz,
  parent_view boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
-- @rls live.sessions
ALTER TABLE live.sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE live.sessions FORCE ROW LEVEL SECURITY;
CREATE POLICY sessions_org_scope ON live.sessions
  USING (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = nullif(current_setting('app.org_id', true), '')::uuid);

CREATE TABLE live.session_sections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  session_id uuid NOT NULL REFERENCES live.sessions(id) ON DELETE CASCADE,
  section_id uuid NOT NULL REFERENCES academic.sections(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, session_id, section_id)
);
-- @rls live.session_sections
ALTER TABLE live.session_sections ENABLE ROW LEVEL SECURITY;
ALTER TABLE live.session_sections FORCE ROW LEVEL SECURITY;
CREATE POLICY session_sections_org_scope ON live.session_sections
  USING (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = nullif(current_setting('app.org_id', true), '')::uuid);

CREATE TABLE live.session_attendance (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  session_id uuid NOT NULL REFERENCES live.sessions(id) ON DELETE CASCADE,
  student_user_id uuid NOT NULL REFERENCES identity.users(id),
  joined_at timestamptz NOT NULL DEFAULT now(),
  left_at timestamptz,
  attendance_status text NOT NULL DEFAULT 'present' CHECK (attendance_status IN ('present', 'late', 'absent')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, session_id, student_user_id)
);
-- @rls live.session_attendance
ALTER TABLE live.session_attendance ENABLE ROW LEVEL SECURITY;
ALTER TABLE live.session_attendance FORCE ROW LEVEL SECURITY;
CREATE POLICY session_attendance_org_scope ON live.session_attendance
  USING (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = nullif(current_setting('app.org_id', true), '')::uuid);

CREATE INDEX sessions_org_start_idx ON live.sessions (org_id, starts_at DESC);
CREATE INDEX session_sections_org_session_idx ON live.session_sections (org_id, session_id);
GRANT USAGE ON SCHEMA live TO campus_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA live TO campus_app;
ALTER DEFAULT PRIVILEGES FOR ROLE campus_migrator IN SCHEMA live
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO campus_app;

INSERT INTO public.schema_migrations (version) VALUES ('live:001');
