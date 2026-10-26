import type { PoolClient } from "@workspace/db";
import type { AuthUser } from "./auth";
import { classroomAccess } from "./classroom-access";

export const defaultBoardConfig = {
  background: { type: "ruled", color: "#fffdf8", lineColor: "#dce5e2", spacing: 32 },
  canvas: { mode: "fixed", aspect: "16:9", maxPages: 20 },
  tools: ["select", "pen", "highlighter", "eraser", "line", "arrow", "rect", "ellipse", "text", "sticky"],
  defaultTool: "pen",
  palette: ["#173e38", "#2e8b70", "#dc8b43", "#b94f47", "#596f9c"],
  penSizes: [2, 4, 8, 14],
  toolbar: { position: "left", size: "regular", autoHide: false },
  participants: { studentsCanView: true, studentsCanDraw: false, allowDrawGrants: true, studentTools: ["pen"], followTeacherPage: true },
  features: { pressureSensitivity: false, palmRejection: true, shapeRecognition: true, undoRedo: true, snapshotIntervalSec: 30, exportFormats: ["png", "pdf"] },
};

export async function ensureBoard(client: PoolClient, orgId: string, sessionId: string, teacherId: string) {
  const template = await client.query<{ config: typeof defaultBoardConfig }>(
    `SELECT config FROM board.templates
      WHERE org_id = $1 AND is_default = true
        AND (scope = 'org' OR (scope = 'teacher' AND owner_user_id = $2))
      ORDER BY CASE WHEN scope = 'teacher' THEN 0 ELSE 1 END LIMIT 1`,
    [orgId, teacherId],
  );
  const result = await client.query<{ id: string }>(
    `INSERT INTO board.boards (org_id, session_id, config)
     VALUES ($1, $2, $3::jsonb) ON CONFLICT (org_id, session_id) DO UPDATE
       SET session_id = EXCLUDED.session_id RETURNING id`,
    [orgId, sessionId, JSON.stringify(template.rows[0]?.config ?? defaultBoardConfig)],
  );
  return result.rows[0]!.id;
}

export async function boardAccess(client: PoolClient, user: AuthUser, boardId: string) {
  const result = await client.query<{ id: string; session_id: string; config: typeof defaultBoardConfig; status: string; seq: string }>(
    "SELECT id, session_id, config, status, seq::text FROM board.boards WHERE org_id = $1 AND id = $2",
    [user.orgId, boardId],
  );
  const board = result.rows[0];
  if (!board) throw Object.assign(new Error("Board not found."), { status: 404, code: "NOT_FOUND" });
  const access = await classroomAccess(client, user, board.session_id);
  if (access.role === "student" && !board.config.participants.studentsCanView) {
    throw Object.assign(new Error("Student board viewing is disabled."), { status: 403, code: "FORBIDDEN" });
  }
  const grant = await client.query<{ can_draw: boolean }>(
    "SELECT can_draw FROM board.draw_grants WHERE org_id = $1 AND board_id = $2 AND user_id = $3",
    [user.orgId, boardId, user.id],
  );
  const canDraw = board.status === "open" && access.status === "live" &&
    (access.role === "teacher" || (access.role === "student" &&
      (grant.rows[0]?.can_draw ?? board.config.participants?.studentsCanDraw ?? false)));
  return { board, access, canDraw };
}
