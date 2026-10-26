CREATE SCHEMA IF NOT EXISTS academic AUTHORIZATION campus_migrator;

CREATE TABLE academic.classes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  name text NOT NULL,
  grade_level integer NOT NULL CHECK (grade_level BETWEEN 1 AND 12),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, name)
);
-- @rls academic.classes
ALTER TABLE academic.classes ENABLE ROW LEVEL SECURITY;
ALTER TABLE academic.classes FORCE ROW LEVEL SECURITY;
CREATE POLICY classes_org_scope ON academic.classes
  USING (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = nullif(current_setting('app.org_id', true), '')::uuid);

CREATE TABLE academic.sections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  class_id uuid NOT NULL REFERENCES academic.classes(id) ON DELETE CASCADE,
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, class_id, name)
);
-- @rls academic.sections
ALTER TABLE academic.sections ENABLE ROW LEVEL SECURITY;
ALTER TABLE academic.sections FORCE ROW LEVEL SECURITY;
CREATE POLICY sections_org_scope ON academic.sections
  USING (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = nullif(current_setting('app.org_id', true), '')::uuid);

CREATE TABLE academic.enrollments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  student_user_id uuid NOT NULL REFERENCES identity.users(id) ON DELETE CASCADE,
  section_id uuid NOT NULL REFERENCES academic.sections(id) ON DELETE CASCADE,
  admission_no text NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  academic_year text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, admission_no, academic_year),
  UNIQUE (org_id, student_user_id, academic_year)
);
-- @rls academic.enrollments
ALTER TABLE academic.enrollments ENABLE ROW LEVEL SECURITY;
ALTER TABLE academic.enrollments FORCE ROW LEVEL SECURITY;
CREATE POLICY enrollments_org_scope ON academic.enrollments
  USING (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = nullif(current_setting('app.org_id', true), '')::uuid);

CREATE TABLE academic.section_teachers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  section_id uuid NOT NULL REFERENCES academic.sections(id) ON DELETE CASCADE,
  teacher_user_id uuid NOT NULL REFERENCES identity.users(id) ON DELETE CASCADE,
  is_class_teacher boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, section_id, teacher_user_id)
);
-- @rls academic.section_teachers
ALTER TABLE academic.section_teachers ENABLE ROW LEVEL SECURITY;
ALTER TABLE academic.section_teachers FORCE ROW LEVEL SECURITY;
CREATE POLICY section_teachers_org_scope ON academic.section_teachers
  USING (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = nullif(current_setting('app.org_id', true), '')::uuid);

CREATE INDEX enrollments_org_section_idx ON academic.enrollments (org_id, section_id, status);
CREATE INDEX section_teachers_org_teacher_idx ON academic.section_teachers (org_id, teacher_user_id, section_id);

GRANT USAGE ON SCHEMA academic TO campus_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA academic TO campus_app;
ALTER DEFAULT PRIVILEGES FOR ROLE campus_migrator IN SCHEMA academic
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO campus_app;

INSERT INTO public.schema_migrations (version) VALUES ('academic:001');
