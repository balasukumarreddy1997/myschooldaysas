CREATE TABLE board.boards (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  session_id uuid NOT NULL REFERENCES live.sessions(id) ON DELETE CASCADE,
  config jsonb NOT NULL,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  seq bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, session_id)
);
-- @rls board.boards
ALTER TABLE board.boards ENABLE ROW LEVEL SECURITY;
ALTER TABLE board.boards FORCE ROW LEVEL SECURITY;
CREATE POLICY board_boards_org_scope ON board.boards
  USING (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = nullif(current_setting('app.org_id', true), '')::uuid);

CREATE TABLE board.ops (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL,
  board_id uuid NOT NULL REFERENCES board.boards(id) ON DELETE CASCADE,
  seq bigint NOT NULL,
  user_id uuid NOT NULL REFERENCES identity.users(id),
  op jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, board_id, seq),
  UNIQUE (org_id, board_id, id)
);
-- @rls board.ops
ALTER TABLE board.ops ENABLE ROW LEVEL SECURITY;
ALTER TABLE board.ops FORCE ROW LEVEL SECURITY;
CREATE POLICY board_ops_org_scope ON board.ops
  USING (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = nullif(current_setting('app.org_id', true), '')::uuid);
CREATE INDEX board_ops_replay_idx ON board.ops (org_id, board_id, seq);

CREATE TABLE board.draw_grants (
  org_id uuid NOT NULL,
  board_id uuid NOT NULL REFERENCES board.boards(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES identity.users(id),
  can_draw boolean NOT NULL DEFAULT false,
  PRIMARY KEY (org_id, board_id, user_id)
);
-- @rls board.draw_grants
ALTER TABLE board.draw_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE board.draw_grants FORCE ROW LEVEL SECURITY;
CREATE POLICY board_grants_org_scope ON board.draw_grants
  USING (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = nullif(current_setting('app.org_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA board TO campus_app;
INSERT INTO public.schema_migrations (version) VALUES ('board:002');
