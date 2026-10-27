ALTER TABLE academic.enrollments
  DROP CONSTRAINT IF EXISTS enrollments_ended_reason_check;

ALTER TABLE academic.enrollments
  ADD CONSTRAINT enrollments_ended_reason_check
    CHECK (ended_reason IS NULL OR ended_reason IN ('transferred', 'promoted', 'graduated'));
