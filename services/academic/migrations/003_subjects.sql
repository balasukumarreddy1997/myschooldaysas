CREATE UNIQUE INDEX sections_org_id_id_unique_idx ON academic.sections (org_id, id);

CREATE TABLE academic.subjects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  code text CHECK (code IS NULL OR length(trim(code)) BETWEEN 1 AND 24),
  name text NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 100),
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  UNIQUE (org_id, name)
);
-- @rls academic.subjects
ALTER TABLE academic.subjects ENABLE ROW LEVEL SECURITY;
ALTER TABLE academic.subjects FORCE ROW LEVEL SECURITY;
CREATE POLICY subjects_org_scope ON academic.subjects
  USING (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = nullif(current_setting('app.org_id', true), '')::uuid);
CREATE UNIQUE INDEX subjects_org_code_ci_idx ON academic.subjects (org_id, lower(code)) WHERE code IS NOT NULL;
CREATE INDEX subjects_org_active_name_idx ON academic.subjects (org_id, is_active, name);

CREATE TABLE academic.teacher_assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  section_id uuid NOT NULL,
  subject_id uuid NOT NULL,
  teacher_user_id uuid NOT NULL REFERENCES identity.users(id) ON DELETE CASCADE,
  is_class_teacher boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  UNIQUE (org_id, section_id, subject_id, teacher_user_id),
  FOREIGN KEY (org_id, section_id) REFERENCES academic.sections(org_id, id) ON DELETE CASCADE,
  FOREIGN KEY (org_id, subject_id) REFERENCES academic.subjects(org_id, id) ON DELETE CASCADE
);
-- @rls academic.teacher_assignments
ALTER TABLE academic.teacher_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE academic.teacher_assignments FORCE ROW LEVEL SECURITY;
CREATE POLICY teacher_assignments_org_scope ON academic.teacher_assignments
  USING (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = nullif(current_setting('app.org_id', true), '')::uuid);
CREATE INDEX teacher_assignments_org_teacher_section_idx ON academic.teacher_assignments (org_id, teacher_user_id, section_id, subject_id);
CREATE INDEX teacher_assignments_org_section_subject_idx ON academic.teacher_assignments (org_id, section_id, subject_id, teacher_user_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON academic.subjects, academic.teacher_assignments TO campus_app;
ALTER DEFAULT PRIVILEGES FOR ROLE campus_migrator IN SCHEMA academic
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO campus_app;
INSERT INTO public.schema_migrations (version) VALUES ('academic:003');
