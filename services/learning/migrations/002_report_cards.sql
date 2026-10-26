ALTER TABLE learning.exams
  ADD COLUMN subject_id uuid;
ALTER TABLE learning.exams
  ADD CONSTRAINT exams_org_subject_fk
  FOREIGN KEY (org_id, subject_id) REFERENCES academic.subjects(org_id, id);
CREATE INDEX exams_org_subject_term_idx ON learning.exams (org_id, subject_id, term_id, status);

CREATE TABLE learning.report_card_publications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  student_user_id uuid NOT NULL REFERENCES identity.users(id) ON DELETE CASCADE,
  section_id uuid NOT NULL,
  term_id uuid NOT NULL,
  published boolean NOT NULL DEFAULT false,
  published_by uuid REFERENCES identity.users(id),
  published_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  UNIQUE (org_id, student_user_id, term_id),
  FOREIGN KEY (org_id, term_id) REFERENCES learning.exam_terms(org_id, id) ON DELETE CASCADE,
  FOREIGN KEY (org_id, section_id) REFERENCES academic.sections(org_id, id) ON DELETE CASCADE
);
-- @rls learning.report_card_publications
ALTER TABLE learning.report_card_publications ENABLE ROW LEVEL SECURITY;
ALTER TABLE learning.report_card_publications FORCE ROW LEVEL SECURITY;
CREATE POLICY report_card_publications_org_scope ON learning.report_card_publications
  USING (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = nullif(current_setting('app.org_id', true), '')::uuid);
CREATE INDEX report_card_publications_org_section_term_idx
  ON learning.report_card_publications (org_id, section_id, term_id, published, student_user_id);

CREATE TABLE learning.report_card_remarks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  student_user_id uuid NOT NULL REFERENCES identity.users(id) ON DELETE CASCADE,
  term_id uuid NOT NULL,
  subject_id uuid REFERENCES academic.subjects(id),
  remark text NOT NULL CHECK (length(trim(remark)) BETWEEN 1 AND 2000),
  created_by uuid NOT NULL REFERENCES identity.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  FOREIGN KEY (org_id, term_id) REFERENCES learning.exam_terms(org_id, id) ON DELETE CASCADE,
  FOREIGN KEY (org_id, subject_id) REFERENCES academic.subjects(org_id, id)
);
-- @rls learning.report_card_remarks
ALTER TABLE learning.report_card_remarks ENABLE ROW LEVEL SECURITY;
ALTER TABLE learning.report_card_remarks FORCE ROW LEVEL SECURITY;
CREATE POLICY report_card_remarks_org_scope ON learning.report_card_remarks
  USING (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = nullif(current_setting('app.org_id', true), '')::uuid);
CREATE UNIQUE INDEX report_card_remarks_subject_unique_idx
  ON learning.report_card_remarks (org_id, student_user_id, term_id, subject_id) WHERE subject_id IS NOT NULL;
CREATE UNIQUE INDEX report_card_remarks_general_unique_idx
  ON learning.report_card_remarks (org_id, student_user_id, term_id) WHERE subject_id IS NULL;
CREATE INDEX report_card_remarks_org_student_term_idx
  ON learning.report_card_remarks (org_id, student_user_id, term_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON learning.report_card_publications, learning.report_card_remarks TO campus_app;
ALTER DEFAULT PRIVILEGES FOR ROLE campus_migrator IN SCHEMA learning
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO campus_app;
INSERT INTO public.schema_migrations (version) VALUES ('learning:002');
