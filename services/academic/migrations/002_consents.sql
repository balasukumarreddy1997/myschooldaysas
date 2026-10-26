CREATE TABLE academic.consents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  parent_id uuid NOT NULL,
  student_id uuid NOT NULL,
  purpose text NOT NULL CHECK (purpose IN (
    'live_view', 'recording', 'photo', 'data_processing'
  )),
  granted_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  granted_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (org_id, parent_id) REFERENCES identity.users(org_id, id) ON DELETE CASCADE,
  FOREIGN KEY (org_id, student_id) REFERENCES identity.users(org_id, id) ON DELETE CASCADE,
  FOREIGN KEY (org_id, granted_by) REFERENCES identity.users(org_id, id) ON DELETE CASCADE
);

-- @rls academic.consents
ALTER TABLE academic.consents ENABLE ROW LEVEL SECURITY;
ALTER TABLE academic.consents FORCE ROW LEVEL SECURITY;
CREATE POLICY consents_org_scope ON academic.consents
  USING (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = nullif(current_setting('app.org_id', true), '')::uuid);

CREATE UNIQUE INDEX consents_one_active_idx
  ON academic.consents (org_id, parent_id, student_id, purpose)
  WHERE revoked_at IS NULL;
CREATE INDEX consents_org_student_purpose_idx
  ON academic.consents (org_id, student_id, purpose, granted_at DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON academic.consents TO campus_app;
INSERT INTO public.schema_migrations (version) VALUES ('academic:002');
