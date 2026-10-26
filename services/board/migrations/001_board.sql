CREATE SCHEMA IF NOT EXISTS board AUTHORIZATION campus_migrator;

CREATE TABLE board.templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  owner_user_id uuid REFERENCES identity.users(id) ON DELETE SET NULL,
  name text NOT NULL,
  scope text NOT NULL CHECK (scope IN ('system', 'org', 'class', 'section', 'teacher')),
  config jsonb NOT NULL,
  is_default boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, name)
);
CREATE UNIQUE INDEX board_one_default_per_scope_idx
  ON board.templates (org_id, scope, COALESCE(owner_user_id, '00000000-0000-0000-0000-000000000000'::uuid))
  WHERE is_default = true;
-- @rls board.templates
ALTER TABLE board.templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE board.templates FORCE ROW LEVEL SECURITY;
CREATE POLICY board_templates_org_scope ON board.templates
  USING (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = nullif(current_setting('app.org_id', true), '')::uuid);

CREATE INDEX board_templates_org_scope_idx ON board.templates (org_id, scope, is_default);
GRANT USAGE ON SCHEMA board TO campus_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA board TO campus_app;
ALTER DEFAULT PRIVILEGES FOR ROLE campus_migrator IN SCHEMA board
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO campus_app;

INSERT INTO public.schema_migrations (version) VALUES ('board:001');
