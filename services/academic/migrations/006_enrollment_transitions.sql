ALTER TABLE academic.enrollments
  ADD COLUMN ended_at timestamptz,
  ADD COLUMN ended_reason text CHECK (ended_reason IS NULL OR ended_reason IN ('transferred', 'promoted'));

ALTER TABLE academic.enrollments
  DROP CONSTRAINT IF EXISTS enrollments_org_id_admission_no_academic_year_key,
  DROP CONSTRAINT IF EXISTS enrollments_org_id_student_user_id_academic_year_key;

CREATE UNIQUE INDEX enrollments_active_org_admission_year_uidx
  ON academic.enrollments (org_id, admission_no, academic_year)
  WHERE status = 'active';

CREATE UNIQUE INDEX enrollments_active_org_student_year_uidx
  ON academic.enrollments (org_id, student_user_id, academic_year)
  WHERE status = 'active';
