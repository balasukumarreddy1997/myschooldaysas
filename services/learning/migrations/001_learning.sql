CREATE SCHEMA IF NOT EXISTS learning AUTHORIZATION campus_migrator;

CREATE TABLE learning.assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  section_id uuid NOT NULL REFERENCES academic.sections(id) ON DELETE CASCADE,
  teacher_user_id uuid NOT NULL REFERENCES identity.users(id),
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 180),
  instructions text NOT NULL DEFAULT '' CHECK (length(instructions) <= 12000),
  due_at timestamptz NOT NULL,
  max_points numeric(8,2) NOT NULL CHECK (max_points > 0 AND max_points <= 100000),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'closed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id)
);
-- @rls learning.assignments
ALTER TABLE learning.assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE learning.assignments FORCE ROW LEVEL SECURITY;
CREATE POLICY assignments_org_scope ON learning.assignments
  USING (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = nullif(current_setting('app.org_id', true), '')::uuid);
CREATE INDEX assignments_org_section_status_due_idx ON learning.assignments (org_id, section_id, status, due_at);

CREATE TABLE learning.assignment_submissions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  assignment_id uuid NOT NULL,
  student_user_id uuid NOT NULL REFERENCES identity.users(id) ON DELETE CASCADE,
  content text NOT NULL CHECK (length(content) BETWEEN 1 AND 12000),
  submitted_at timestamptz NOT NULL DEFAULT now(),
  is_late boolean NOT NULL DEFAULT false,
  grade_points numeric(8,2),
  feedback text CHECK (length(feedback) <= 4000),
  graded_by uuid REFERENCES identity.users(id),
  graded_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  UNIQUE (org_id, assignment_id, student_user_id),
  FOREIGN KEY (org_id, assignment_id) REFERENCES learning.assignments(org_id, id) ON DELETE CASCADE,
  CHECK (grade_points IS NULL OR grade_points >= 0)
);
-- @rls learning.assignment_submissions
ALTER TABLE learning.assignment_submissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE learning.assignment_submissions FORCE ROW LEVEL SECURITY;
CREATE POLICY submissions_org_scope ON learning.assignment_submissions
  USING (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = nullif(current_setting('app.org_id', true), '')::uuid);
CREATE INDEX submissions_org_assignment_idx ON learning.assignment_submissions (org_id, assignment_id, student_user_id);
CREATE INDEX submissions_org_student_idx ON learning.assignment_submissions (org_id, student_user_id, submitted_at DESC);

CREATE TABLE learning.exam_terms (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  starts_on date NOT NULL,
  ends_on date NOT NULL,
  is_current boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  UNIQUE (org_id, name),
  CHECK (ends_on >= starts_on)
);
-- @rls learning.exam_terms
ALTER TABLE learning.exam_terms ENABLE ROW LEVEL SECURITY;
ALTER TABLE learning.exam_terms FORCE ROW LEVEL SECURITY;
CREATE POLICY exam_terms_org_scope ON learning.exam_terms
  USING (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = nullif(current_setting('app.org_id', true), '')::uuid);
CREATE INDEX exam_terms_org_current_idx ON learning.exam_terms (org_id, is_current);
CREATE UNIQUE INDEX exam_terms_one_current_idx ON learning.exam_terms (org_id) WHERE is_current;

CREATE TABLE learning.exams (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  section_id uuid NOT NULL REFERENCES academic.sections(id) ON DELETE CASCADE,
  teacher_user_id uuid NOT NULL REFERENCES identity.users(id),
  term_id uuid,
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 180),
  exam_date date NOT NULL,
  max_points numeric(8,2) NOT NULL CHECK (max_points > 0 AND max_points <= 100000),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  FOREIGN KEY (org_id, term_id) REFERENCES learning.exam_terms(org_id, id)
);
-- @rls learning.exams
ALTER TABLE learning.exams ENABLE ROW LEVEL SECURITY;
ALTER TABLE learning.exams FORCE ROW LEVEL SECURITY;
CREATE POLICY exams_org_scope ON learning.exams
  USING (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = nullif(current_setting('app.org_id', true), '')::uuid);
CREATE INDEX exams_org_section_status_idx ON learning.exams (org_id, section_id, status, exam_date);
CREATE INDEX exams_org_term_idx ON learning.exams (org_id, term_id);

CREATE TABLE learning.exam_marks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  exam_id uuid NOT NULL,
  student_user_id uuid NOT NULL REFERENCES identity.users(id) ON DELETE CASCADE,
  score numeric(8,2) NOT NULL CHECK (score >= 0),
  feedback text NOT NULL DEFAULT '' CHECK (length(feedback) <= 4000),
  marked_by uuid NOT NULL REFERENCES identity.users(id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, exam_id, student_user_id),
  FOREIGN KEY (org_id, exam_id) REFERENCES learning.exams(org_id, id) ON DELETE CASCADE
);
-- @rls learning.exam_marks
ALTER TABLE learning.exam_marks ENABLE ROW LEVEL SECURITY;
ALTER TABLE learning.exam_marks FORCE ROW LEVEL SECURITY;
CREATE POLICY exam_marks_org_scope ON learning.exam_marks
  USING (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = nullif(current_setting('app.org_id', true), '')::uuid);
CREATE INDEX exam_marks_org_student_idx ON learning.exam_marks (org_id, student_user_id, exam_id);

CREATE TABLE learning.grade_scales (
  org_id uuid PRIMARY KEY,
  bands jsonb NOT NULL,
  updated_by uuid NOT NULL REFERENCES identity.users(id),
  updated_at timestamptz NOT NULL DEFAULT now()
);
-- @rls learning.grade_scales
ALTER TABLE learning.grade_scales ENABLE ROW LEVEL SECURITY;
ALTER TABLE learning.grade_scales FORCE ROW LEVEL SECURITY;
CREATE POLICY grade_scales_org_scope ON learning.grade_scales
  USING (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = nullif(current_setting('app.org_id', true), '')::uuid);

CREATE TABLE learning.audit_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  actor_user_id uuid NOT NULL REFERENCES identity.users(id),
  action text NOT NULL,
  resource_type text NOT NULL,
  resource_id uuid NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
-- @rls learning.audit_log
ALTER TABLE learning.audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE learning.audit_log FORCE ROW LEVEL SECURITY;
CREATE POLICY learning_audit_org_scope ON learning.audit_log
  USING (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = nullif(current_setting('app.org_id', true), '')::uuid);
CREATE INDEX learning_audit_org_resource_idx ON learning.audit_log (org_id, resource_type, resource_id, created_at DESC);

GRANT USAGE ON SCHEMA learning TO campus_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA learning TO campus_app;
ALTER DEFAULT PRIVILEGES FOR ROLE campus_migrator IN SCHEMA learning
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO campus_app;
INSERT INTO public.schema_migrations (version) VALUES ('learning:001');
