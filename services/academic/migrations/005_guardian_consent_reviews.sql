CREATE TABLE academic.guardian_consent_reviews (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  guardian_user_id uuid NOT NULL,
  reviewed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, id),
  UNIQUE (org_id, guardian_user_id),
  FOREIGN KEY (org_id, guardian_user_id)
    REFERENCES identity.users(org_id, id) ON DELETE CASCADE
);

-- @rls academic.guardian_consent_reviews
ALTER TABLE academic.guardian_consent_reviews ENABLE ROW LEVEL SECURITY;
ALTER TABLE academic.guardian_consent_reviews FORCE ROW LEVEL SECURITY;
CREATE POLICY guardian_consent_reviews_org_scope ON academic.guardian_consent_reviews
  USING (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = nullif(current_setting('app.org_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON academic.guardian_consent_reviews TO campus_app;
INSERT INTO public.schema_migrations (version) VALUES ('academic:005');
