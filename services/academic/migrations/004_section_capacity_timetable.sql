ALTER TABLE academic.sections
  ADD COLUMN capacity integer CHECK (capacity IS NULL OR capacity > 0);

CREATE TABLE academic.timetable_slots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  section_id uuid NOT NULL,
  subject_id uuid NOT NULL,
  teacher_user_id uuid NOT NULL REFERENCES identity.users(id) ON DELETE CASCADE,
  weekday smallint NOT NULL CHECK (weekday BETWEEN 0 AND 6),
  start_time time NOT NULL,
  end_time time NOT NULL,
  room text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (end_time > start_time),
  FOREIGN KEY (org_id, section_id) REFERENCES academic.sections(org_id, id) ON DELETE CASCADE,
  FOREIGN KEY (org_id, subject_id) REFERENCES academic.subjects(org_id, id) ON DELETE CASCADE
);
-- @rls academic.timetable_slots
ALTER TABLE academic.timetable_slots ENABLE ROW LEVEL SECURITY;
ALTER TABLE academic.timetable_slots FORCE ROW LEVEL SECURITY;
CREATE POLICY timetable_slots_org_scope ON academic.timetable_slots
  USING (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = nullif(current_setting('app.org_id', true), '')::uuid);

CREATE INDEX timetable_slots_org_section_day_idx
  ON academic.timetable_slots (org_id, section_id, weekday, start_time);
CREATE INDEX timetable_slots_org_teacher_day_idx
  ON academic.timetable_slots (org_id, teacher_user_id, weekday, start_time);

GRANT SELECT, INSERT, UPDATE, DELETE ON academic.timetable_slots TO campus_app;
INSERT INTO public.schema_migrations (version) VALUES ('academic:004');
