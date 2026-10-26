ALTER TABLE live.sessions ADD COLUMN settings jsonb NOT NULL
  DEFAULT '{"chatEnabled":true,"lockRoom":false,"minAttendancePct":50}'::jsonb;

CREATE TABLE live.participants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  session_id uuid NOT NULL REFERENCES live.sessions(id) ON DELETE CASCADE,
  user_id uuid REFERENCES identity.users(id),
  participant_sid text NOT NULL,
  joined_at timestamptz NOT NULL,
  left_at timestamptz,
  UNIQUE (org_id, session_id, participant_sid)
);
-- @rls live.participants
ALTER TABLE live.participants ENABLE ROW LEVEL SECURITY;
ALTER TABLE live.participants FORCE ROW LEVEL SECURITY;
CREATE POLICY live_participants_org_scope ON live.participants
  USING (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = nullif(current_setting('app.org_id', true), '')::uuid);
CREATE INDEX live_participants_student_idx ON live.participants (org_id, session_id, user_id);

CREATE TABLE live.webhook_events (
  org_id uuid NOT NULL,
  event_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, event_id)
);
-- @rls live.webhook_events
ALTER TABLE live.webhook_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE live.webhook_events FORCE ROW LEVEL SECURITY;
CREATE POLICY live_webhooks_org_scope ON live.webhook_events
  USING (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = nullif(current_setting('app.org_id', true), '')::uuid);

ALTER TABLE live.session_attendance ADD COLUMN seconds integer NOT NULL DEFAULT 0;
ALTER TABLE live.session_attendance ADD COLUMN source text NOT NULL DEFAULT 'auto'
  CHECK (source IN ('auto', 'manual'));
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA live TO campus_app;
INSERT INTO public.schema_migrations (version) VALUES ('live:002');
