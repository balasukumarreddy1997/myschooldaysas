CREATE TABLE school.announcements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES identity.organizations(id) ON DELETE CASCADE,
  title text NOT NULL CHECK (char_length(title) BETWEEN 3 AND 160),
  body text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 10000),
  audience text NOT NULL CHECK (audience IN ('school', 'class', 'section', 'role')),
  audience_ids uuid[] NOT NULL DEFAULT '{}',
  roles text[] NOT NULL DEFAULT '{}',
  priority text NOT NULL DEFAULT 'normal' CHECK (priority IN ('normal', 'urgent')),
  published_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz,
  created_by uuid NOT NULL REFERENCES identity.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  CHECK (expires_at IS NULL OR expires_at > published_at),
  CHECK (
    (audience = 'school' AND cardinality(audience_ids) = 0 AND cardinality(roles) = 0)
    OR (audience IN ('class', 'section') AND cardinality(audience_ids) = 1 AND cardinality(roles) = 0)
    OR (audience = 'role' AND cardinality(audience_ids) = 0 AND cardinality(roles) BETWEEN 1 AND 8)
  )
);
CREATE INDEX announcements_org_published_idx
  ON school.announcements (org_id, published_at DESC, id);
CREATE INDEX announcements_org_audience_idx
  ON school.announcements (org_id, audience, published_at DESC);
-- @rls school.announcements
ALTER TABLE school.announcements ENABLE ROW LEVEL SECURITY;
ALTER TABLE school.announcements FORCE ROW LEVEL SECURITY;
CREATE POLICY announcements_org_scope ON school.announcements
  USING (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = nullif(current_setting('app.org_id', true), '')::uuid);

CREATE TABLE school.announcement_reads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES identity.organizations(id) ON DELETE CASCADE,
  announcement_id uuid NOT NULL,
  user_id uuid NOT NULL REFERENCES identity.users(id) ON DELETE CASCADE,
  read_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, announcement_id, user_id),
  FOREIGN KEY (org_id, announcement_id)
    REFERENCES school.announcements (org_id, id) ON DELETE CASCADE
);
CREATE INDEX announcement_reads_org_user_idx
  ON school.announcement_reads (org_id, user_id, read_at DESC);
-- @rls school.announcement_reads
ALTER TABLE school.announcement_reads ENABLE ROW LEVEL SECURITY;
ALTER TABLE school.announcement_reads FORCE ROW LEVEL SECURITY;
CREATE POLICY announcement_reads_org_scope ON school.announcement_reads
  USING (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = nullif(current_setting('app.org_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON school.announcements, school.announcement_reads TO campus_app;
INSERT INTO public.schema_migrations (version) VALUES ('school:002');
