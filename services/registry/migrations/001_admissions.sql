CREATE SCHEMA IF NOT EXISTS registry AUTHORIZATION campus_migrator;

CREATE TABLE registry.admission_enquiries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES identity.organizations(id) ON DELETE CASCADE,
  child_name text NOT NULL CHECK (char_length(child_name) BETWEEN 2 AND 120),
  date_of_birth date,
  class_applying text NOT NULL CHECK (char_length(class_applying) BETWEEN 1 AND 80),
  guardian_name text NOT NULL CHECK (char_length(guardian_name) BETWEEN 2 AND 120),
  guardian_phone text NOT NULL CHECK (char_length(guardian_phone) BETWEEN 7 AND 32),
  guardian_email text CHECK (guardian_email IS NULL OR char_length(guardian_email) <= 254),
  source text NOT NULL DEFAULT 'web'
    CHECK (source IN ('walk-in', 'web', 'referral', 'campaign', 'other')),
  notes text CHECK (notes IS NULL OR char_length(notes) <= 1000),
  status text NOT NULL DEFAULT 'new'
    CHECK (status IN ('new', 'contacted', 'visit_scheduled', 'application_issued', 'closed', 'lost')),
  follow_up_on date,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES identity.users(id) ON DELETE SET NULL,
  UNIQUE (org_id, id)
);

CREATE INDEX admission_enquiries_org_status_created_idx
  ON registry.admission_enquiries (org_id, status, created_at DESC);
CREATE INDEX admission_enquiries_org_phone_idx
  ON registry.admission_enquiries (org_id, guardian_phone);

-- @rls registry.admission_enquiries
ALTER TABLE registry.admission_enquiries ENABLE ROW LEVEL SECURITY;
ALTER TABLE registry.admission_enquiries FORCE ROW LEVEL SECURITY;
CREATE POLICY admission_enquiries_org_scope ON registry.admission_enquiries
  USING (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = nullif(current_setting('app.org_id', true), '')::uuid);

CREATE TABLE registry.admission_activity (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES identity.organizations(id) ON DELETE CASCADE,
  enquiry_id uuid NOT NULL,
  action text NOT NULL
    CHECK (action IN ('submitted', 'status_changed', 'follow_up_changed', 'note_added')),
  previous_status text
    CHECK (previous_status IS NULL OR previous_status IN ('new', 'contacted', 'visit_scheduled', 'application_issued', 'closed', 'lost')),
  next_status text
    CHECK (next_status IS NULL OR next_status IN ('new', 'contacted', 'visit_scheduled', 'application_issued', 'closed', 'lost')),
  note text CHECK (note IS NULL OR char_length(note) <= 1000),
  actor_id uuid REFERENCES identity.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  FOREIGN KEY (org_id, enquiry_id)
    REFERENCES registry.admission_enquiries (org_id, id) ON DELETE CASCADE
);

CREATE INDEX admission_activity_org_enquiry_created_idx
  ON registry.admission_activity (org_id, enquiry_id, created_at DESC);

-- @rls registry.admission_activity
ALTER TABLE registry.admission_activity ENABLE ROW LEVEL SECURITY;
ALTER TABLE registry.admission_activity FORCE ROW LEVEL SECURITY;
CREATE POLICY admission_activity_org_scope ON registry.admission_activity
  USING (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = nullif(current_setting('app.org_id', true), '')::uuid);

GRANT USAGE ON SCHEMA registry TO campus_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON registry.admission_enquiries, registry.admission_activity TO campus_app;
ALTER DEFAULT PRIVILEGES FOR ROLE campus_migrator IN SCHEMA registry
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO campus_app;

INSERT INTO public.schema_migrations (version) VALUES ('registry:001');
