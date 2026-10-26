import type { FastifyPluginAsync } from "fastify";
import { GetSchoolAttendanceQueryParams, MarkSchoolAttendanceBody } from "@workspace/api-zod";
import { withOrg } from "@workspace/db";
import { createRouteRegistrar } from "../lib/fastify-routes";
import { requireAuth, type CampusRole } from "../lib/auth";

const adminRoles: CampusRole[] = ["super_admin", "org_admin", "campus_admin"];
const teacherRoles: CampusRole[] = ["teacher", "class_teacher", "hod"];
const validDateOnly = (value: unknown): value is string => {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
};
const errorBody = (code: string, message: string) => ({ error: { code, message } });

async function canAccessSection(client: any, orgId: string, userId: string, roles: CampusRole[], sectionId: string) {
  if (roles.some((role) => adminRoles.includes(role))) {
    const section = await client.query("SELECT 1 FROM academic.sections WHERE org_id=$1 AND id=$2", [orgId, sectionId]);
    return Boolean(section.rowCount);
  }
  if (!roles.some((role) => teacherRoles.includes(role))) return false;
  const assignment = await client.query(
    `SELECT 1
       FROM academic.sections s
      WHERE s.org_id=$1 AND s.id=$2
        AND (
          EXISTS (SELECT 1 FROM academic.section_teachers st
                   WHERE st.org_id=s.org_id AND st.section_id=s.id AND st.teacher_user_id=$3)
          OR EXISTS (SELECT 1 FROM academic.teacher_assignments ta
                      WHERE ta.org_id=s.org_id AND ta.section_id=s.id AND ta.teacher_user_id=$3)
        )`,
    [orgId, sectionId, userId],
  );
  return Boolean(assignment.rowCount);
}

async function attendanceRoster(client: any, orgId: string, sectionId: string, date: string) {
  const result = await client.query(
    `SELECT s.id AS section_id, s.name AS section_name, e.student_user_id, u.name AS student_name,
            COALESCE(e.admission_no, '') AS admission_no, am.status, COALESCE(am.remark, '') AS remark
       FROM academic.sections s
       JOIN academic.enrollments e ON e.org_id=s.org_id AND e.section_id=s.id AND e.status='active'
       JOIN identity.users u ON u.org_id=e.org_id AND u.id=e.student_user_id
       LEFT JOIN school.attendance_sessions ses
         ON ses.org_id=s.org_id AND ses.section_id=s.id AND ses.attendance_date=$3::date AND ses.period IS NULL
       LEFT JOIN school.attendance_marks am
         ON am.org_id=ses.org_id AND am.session_id=ses.id AND am.student_user_id=e.student_user_id
      WHERE s.org_id=$1 AND s.id=$2
      ORDER BY u.name, e.student_user_id`,
    [orgId, sectionId, date],
  );
  if (!result.rowCount) {
    const exists = await client.query("SELECT id, name FROM academic.sections WHERE org_id=$1 AND id=$2", [orgId, sectionId]);
    if (!exists.rowCount) return null;
    return { sectionId, sectionName: exists.rows[0].name, date, items: [], total: 0 };
  }
  return {
    sectionId: result.rows[0].section_id,
    sectionName: result.rows[0].section_name,
    date,
    items: result.rows.map((row: any) => ({
      studentId: row.student_user_id,
      studentName: row.student_name,
      admissionNo: row.admission_no,
      status: row.status,
      remark: row.remark,
    })),
    total: result.rowCount ?? result.rows.length,
  };
}

const routes: FastifyPluginAsync = async (fastify) => {
  const router = createRouteRegistrar(fastify);

  router.get("/school/attendance", requireAuth, async (req, res, next) => {
    const user = req.campusUser;
    if (!user) return void res.status(401).json(errorBody("UNAUTHENTICATED", "Sign in to continue."));
    const rawQuery = req.query as Record<string, unknown>;
    const query = GetSchoolAttendanceQueryParams.safeParse({
      ...rawQuery,
      date: typeof rawQuery.date === "string" ? rawQuery.date : "",
    });
    if (!query.success || !validDateOnly(rawQuery.date)) return void res.status(400).json(errorBody("INVALID_REQUEST", "Provide a valid section and date."));
    try {
      const result = await withOrg(user.orgId, async (client) => {
        const allowed = await canAccessSection(client, user.orgId, user.id, user.roles, query.data.sectionId);
        if (!allowed) return { forbidden: true as const };
        const roster = await attendanceRoster(client, user.orgId, query.data.sectionId, rawQuery.date as string);
        return roster ? { roster } : { missing: true as const };
      });
      if ("forbidden" in result) return void res.status(403).json(errorBody("FORBIDDEN", "You do not have access to this section's attendance."));
      if ("missing" in result) return void res.status(404).json(errorBody("NOT_FOUND", "Section not found."));
      res.json(result.roster);
    } catch (error) { next(error); }
  });

  router.put("/school/attendance", requireAuth, async (req, res, next) => {
    const user = req.campusUser;
    if (!user) return void res.status(401).json(errorBody("UNAUTHENTICATED", "Sign in to continue."));
    const parsed = MarkSchoolAttendanceBody.safeParse(req.body);
    if (!parsed.success) return void res.status(400).json(errorBody("INVALID_REQUEST", "Provide valid attendance marks."));
    const date = parsed.data.date.toISOString().slice(0, 10);
    const ids = parsed.data.marks.map((mark) => mark.studentId);
    if (new Set(ids).size !== ids.length) return void res.status(400).json(errorBody("INVALID_REQUEST", "Each student can appear only once."));
    try {
      const result = await withOrg(user.orgId, async (client) => {
        const allowed = await canAccessSection(client, user.orgId, user.id, user.roles, parsed.data.sectionId);
        if (!allowed) return { forbidden: true as const };
        const enrolled = await client.query(
          `SELECT student_user_id
             FROM academic.enrollments
            WHERE org_id=$1 AND section_id=$2 AND status='active'
            ORDER BY student_user_id`,
          [user.orgId, parsed.data.sectionId],
        );
        const enrolledIds = enrolled.rows.map((row: any) => row.student_user_id as string);
        const submitted = new Set(ids);
        if (enrolledIds.length === 0 || enrolledIds.length !== ids.length || enrolledIds.some((id: string) => !submitted.has(id))) {
          return { invalidRoster: true as const };
        }
        const session = await client.query(
          `INSERT INTO school.attendance_sessions (org_id, section_id, attendance_date, period, marked_by)
           VALUES ($1,$2,$3::date,NULL,$4)
           ON CONFLICT (org_id, section_id, attendance_date) WHERE period IS NULL
           DO UPDATE SET marked_by=EXCLUDED.marked_by, updated_at=now()
           RETURNING id`,
          [user.orgId, parsed.data.sectionId, date, user.id],
        );
        const sessionId = session.rows[0].id;
        for (const mark of parsed.data.marks) {
          await client.query(
            `INSERT INTO school.attendance_marks (org_id, session_id, student_user_id, status, remark)
             VALUES ($1,$2,$3,$4,$5)
             ON CONFLICT (org_id, session_id, student_user_id)
             DO UPDATE SET status=EXCLUDED.status, remark=EXCLUDED.remark, updated_at=now()`,
            [user.orgId, sessionId, mark.studentId, mark.status, mark.remark.trim()],
          );
        }
        await client.query(
          `INSERT INTO school.attendance_audit_log (org_id, actor_user_id, session_id, action, metadata)
           VALUES ($1,$2,$3,'attendance.saved',$4::jsonb)`,
          [user.orgId, user.id, sessionId, JSON.stringify({ date, sectionId: parsed.data.sectionId, markCount: ids.length })],
        );
        const roster = await attendanceRoster(client, user.orgId, parsed.data.sectionId, date);
        return roster ? { roster } : { missing: true as const };
      });
      if ("forbidden" in result) return void res.status(403).json(errorBody("FORBIDDEN", "You do not have access to this section's attendance."));
      if ("invalidRoster" in result) return void res.status(400).json(errorBody("INVALID_ROSTER", "Submit exactly one mark for every active student in this section."));
      if ("missing" in result) return void res.status(404).json(errorBody("NOT_FOUND", "Section not found."));
      res.json(result.roster);
    } catch (error) { next(error); }
  });
};

export default routes;
