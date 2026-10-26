import type { PoolClient } from "@workspace/db";
import type { AuthUser } from "./auth";
import type { ClassroomRole } from "./classroom-policy";
import { canParentViewLiveClassroom } from "./academic-scheduling-policy";

export interface ClassroomAccess {
  id: string;
  title: string;
  status: "scheduled" | "live" | "ended" | "cancelled";
  teacherId: string;
  startsAt: Date;
  startedAt: Date | null;
  endedAt: Date | null;
  parentView: boolean;
  settings: { chatEnabled?: boolean; lockRoom?: boolean; minAttendancePct?: number };
  role: ClassroomRole;
  canManage: boolean;
}

export function classroomRoom(orgId: string, sessionId: string) {
  return `campus-${orgId}-${sessionId}`;
}

export async function classroomAccess(
  client: PoolClient,
  user: AuthUser,
  sessionId: string,
): Promise<ClassroomAccess> {
  // A WebSocket can outlive its access token. Reload active roles for each action.
  const active = await client.query<{ roles: AuthUser["roles"] }>(
    `SELECT COALESCE(array_agg(ur.role) FILTER (WHERE ur.role IS NOT NULL), '{}') roles
     FROM identity.users u LEFT JOIN identity.user_roles ur ON ur.org_id = u.org_id AND ur.user_id = u.id
     WHERE u.org_id = $1 AND u.id = $2 AND u.status = 'active' AND NOT u.must_change_password GROUP BY u.id`,
    [user.orgId, user.id],
  );
  if (!active.rows[0]?.roles.length) {
    throw Object.assign(new Error("Your classroom session is no longer valid."), { status: 401, code: "UNAUTHENTICATED" });
  }
  user = { ...user, roles: active.rows[0].roles };
  const result = await client.query<{
    id: string; title: string; status: ClassroomAccess["status"]; teacher_user_id: string;
    starts_at: Date; started_at: Date | null; ended_at: Date | null;
    parent_view: boolean; settings: ClassroomAccess["settings"];
    assigned_teacher: boolean; enrolled_student: boolean; linked_parent: boolean; live_view_consented: boolean;
  }>(
    `SELECT s.id, s.title, s.status, s.teacher_user_id, s.starts_at, s.started_at,
            s.ended_at, s.parent_view, s.settings,
            EXISTS (SELECT 1 FROM live.session_sections ss
              JOIN academic.section_teachers st ON st.org_id = ss.org_id AND st.section_id = ss.section_id
              WHERE ss.org_id = s.org_id AND ss.session_id = s.id AND st.teacher_user_id = $3) assigned_teacher,
            EXISTS (SELECT 1 FROM live.session_sections ss
              JOIN academic.enrollments e ON e.org_id = ss.org_id AND e.section_id = ss.section_id
              WHERE ss.org_id = s.org_id AND ss.session_id = s.id AND e.student_user_id = $3 AND e.status = 'active') enrolled_student,
            EXISTS (SELECT 1 FROM live.session_sections ss
              JOIN academic.enrollments e ON e.org_id = ss.org_id AND e.section_id = ss.section_id
              JOIN identity.guardian_links gl ON gl.org_id = e.org_id AND gl.student_user_id = e.student_user_id
              WHERE ss.org_id = s.org_id AND ss.session_id = s.id AND e.status = 'active'
                AND gl.guardian_user_id = $3) linked_parent,
            EXISTS (SELECT 1 FROM live.session_sections ss
              JOIN academic.enrollments e ON e.org_id = ss.org_id AND e.section_id = ss.section_id
              JOIN identity.guardian_links gl ON gl.org_id = e.org_id AND gl.student_user_id = e.student_user_id
              JOIN academic.consents c ON c.org_id = e.org_id AND c.student_id = e.student_user_id
                AND c.parent_id = gl.guardian_user_id AND c.purpose = 'live_view' AND c.revoked_at IS NULL
              WHERE ss.org_id = s.org_id AND ss.session_id = s.id AND e.status = 'active'
                AND gl.guardian_user_id = $3 AND gl.can_view_live = true) live_view_consented
       FROM live.sessions s WHERE s.org_id = $1 AND s.id = $2`,
    [user.orgId, sessionId, user.id],
  );
  const row = result.rows[0];
  if (!row) throw Object.assign(new Error("Classroom not found."), { status: 404, code: "NOT_FOUND" });
  const admin = user.roles.some((role) => ["super_admin", "org_admin", "campus_admin"].includes(role));
  const teacher = user.roles.some((role) => ["teacher", "class_teacher", "hod"].includes(role));
  const owner = teacher && row.teacher_user_id === user.id;
  const assigned = teacher && row.assigned_teacher;
  const parent = canParentViewLiveClassroom(
    user.roles.includes("parent"),
    row.parent_view,
    row.linked_parent,
    row.live_view_consented,
  );
  const student = user.roles.includes("student") && row.enrolled_student;
  if (!(owner || assigned || admin || student || parent)) {
    throw Object.assign(new Error("You are not a participant in this classroom."), { status: 403, code: "FORBIDDEN" });
  }
  const role: ClassroomRole = owner || assigned ? "teacher" : admin ? "observer" : student ? "student" : "viewer";
  return {
    id: row.id, title: row.title, status: row.status, teacherId: row.teacher_user_id,
    startsAt: row.starts_at, startedAt: row.started_at, endedAt: row.ended_at,
    parentView: row.parent_view, settings: row.settings ?? {}, role,
    canManage: owner || assigned || admin,
  };
}
