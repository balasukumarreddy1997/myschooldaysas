CREATE SCHEMA IF NOT EXISTS school AUTHORIZATION campus_migrator;

CREATE TABLE school.attendance_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  section_id uuid NOT NULL,
  attendance_date date NOT NULL,
  period smallint CHECK (period IS NULL OR period BETWEEN 1 AND 24),
  marked_by uuid NOT NULL REFERENCES identity.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  FOREIGN KEY (org_id, section_id) REFERENCES academic.sections(org_id, id) ON DELETE CASCADE
);
-- @rls school.attendance_sessions
ALTER TABLE school.attendance_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE school.attendance_sessions FORCE ROW LEVEL SECURITY;
CREATE POLICY attendance_sessions_org_scope ON school.attendance_sessions
  USING (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = nullif(current_setting('app.org_id', true), '')::uuid);
CREATE UNIQUE INDEX attendance_sessions_daily_unique_idx
  ON school.attendance_sessions (org_id, section_id, attendance_date) WHERE period IS NULL;
CREATE UNIQUE INDEX attendance_sessions_period_unique_idx
  ON school.attendance_sessions (org_id, section_id, attendance_date, period) WHERE period IS NOT NULL;
CREATE INDEX attendance_sessions_org_section_date_idx
  ON school.attendance_sessions (org_id, section_id, attendance_date DESC);

CREATE TABLE school.attendance_marks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  session_id uuid NOT NULL,
  student_user_id uuid NOT NULL REFERENCES identity.users(id) ON DELETE CASCADE,
  status text NOT NULL CHECK (status IN ('present', 'absent', 'late', 'leave')),
  remark text NOT NULL DEFAULT '' CHECK (length(remark) <= 500),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  UNIQUE (org_id, session_id, student_user_id),
  FOREIGN KEY (org_id, session_id) REFERENCES school.attendance_sessions(org_id, id) ON DELETE CASCADE
);
-- @rls school.attendance_marks
ALTER TABLE school.attendance_marks ENABLE ROW LEVEL SECURITY;
ALTER TABLE school.attendance_marks FORCE ROW LEVEL SECURITY;
CREATE POLICY attendance_marks_org_scope ON school.attendance_marks
  USING (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = nullif(current_setting('app.org_id', true), '')::uuid);
CREATE INDEX attendance_marks_org_student_idx ON school.attendance_marks (org_id, student_user_id, session_id);

CREATE TABLE school.attendance_audit_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  actor_user_id uuid NOT NULL REFERENCES identity.users(id),
  session_id uuid NOT NULL,
  action text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  FOREIGN KEY (org_id, session_id) REFERENCES school.attendance_sessions(org_id, id) ON DELETE CASCADE
);
-- @rls school.attendance_audit_log
ALTER TABLE school.attendance_audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE school.attendance_audit_log FORCE ROW LEVEL SECURITY;
CREATE POLICY attendance_audit_org_scope ON school.attendance_audit_log
  USING (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = nullif(current_setting('app.org_id', true), '')::uuid);
CREATE INDEX attendance_audit_org_session_idx ON school.attendance_audit_log (org_id, session_id, created_at DESC);

GRANT USAGE ON SCHEMA school TO campus_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA school TO campus_app;
ALTER DEFAULT PRIVILEGES FOR ROLE campus_migrator IN SCHEMA school
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO campus_app;
INSERT INTO public.schema_migrations (version) VALUES ('school:001');
