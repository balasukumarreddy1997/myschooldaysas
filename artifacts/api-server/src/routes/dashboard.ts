import type { FastifyPluginAsync } from "fastify";
import { withOrg } from "@workspace/db";
import { createRouteRegistrar } from "../lib/fastify-routes";
import { requireAuth, type CampusRole } from "../lib/auth";

const routes: FastifyPluginAsync = async (fastify) => {
const router = createRouteRegistrar(fastify);
const adminRoles: CampusRole[] = ["super_admin", "org_admin", "campus_admin"];
const teacherRoles: CampusRole[] = ["teacher", "class_teacher", "hod"];

function errorBody(code: string, message: string) {
  return { error: { code, message } };
}

router.get("/dashboard/overview", requireAuth, async (req, res, next) => {
  const user = req.campusUser;
  if (!user) return void res.status(401).json(errorBody("UNAUTHENTICATED", "Sign in to continue."));

  const isAdmin = user.roles.some((role) => adminRoles.includes(role));
  const isTeacher = user.roles.some((role) => teacherRoles.includes(role));
  const isStudent = user.roles.includes("student");
  const isParent = user.roles.includes("parent");

  try {
    const dashboard = await withOrg(user.orgId, async (client) => {
      const stats = await client.query<{
        students: number;
        classes: number;
        sections: number;
        teachers: number;
      }>(
        `WITH visible_sections AS (
           SELECT s.id, s.class_id
             FROM academic.sections s
            WHERE s.org_id = $1
              AND (
                $2::boolean
                OR ($3::boolean AND EXISTS (
                  SELECT 1 FROM academic.section_teachers st
                   WHERE st.org_id = s.org_id AND st.section_id = s.id
                     AND st.teacher_user_id = $4
                ))
                OR ($5::boolean AND EXISTS (
                  SELECT 1 FROM academic.enrollments mine
                   WHERE mine.org_id = s.org_id AND mine.section_id = s.id
                     AND mine.student_user_id = $4 AND mine.status = 'active'
                ))
                OR ($6::boolean AND EXISTS (
                  SELECT 1 FROM academic.enrollments child
                  JOIN identity.guardian_links gl
                    ON gl.org_id = child.org_id AND gl.student_user_id = child.student_user_id
                   WHERE child.org_id = s.org_id AND child.section_id = s.id
                     AND gl.guardian_user_id = $4 AND gl.can_view_live = true AND child.status = 'active'
                ))
              )
         )
         SELECT
           (SELECT COUNT(DISTINCT e.student_user_id)::int
              FROM academic.enrollments e
              JOIN visible_sections vs ON vs.id = e.section_id
             WHERE e.org_id = $1 AND e.status = 'active') AS students,
           (SELECT COUNT(DISTINCT vs.class_id)::int FROM visible_sections vs) AS classes,
           (SELECT COUNT(*)::int FROM visible_sections) AS sections,
           (SELECT COUNT(DISTINCT st.teacher_user_id)::int
              FROM academic.section_teachers st
             WHERE st.org_id = $1
               AND ($2::boolean OR st.teacher_user_id = $4)) AS teachers`,
        [user.orgId, isAdmin, isTeacher, user.id, isStudent, isParent],
      );

      const sessions = await client.query(
        `SELECT s.id, s.title, teacher.name AS teacher_name, s.mode, s.status,
                s.starts_at, s.parent_view,
                COALESCE(array_remove(array_agg(DISTINCT sec.name), NULL), '{}') AS sections
           FROM live.sessions s
           JOIN identity.users teacher
             ON teacher.id = s.teacher_user_id AND teacher.org_id = s.org_id
           LEFT JOIN live.session_sections ss
             ON ss.session_id = s.id AND ss.org_id = s.org_id
           LEFT JOIN academic.sections sec
             ON sec.id = ss.section_id AND sec.org_id = ss.org_id
          WHERE s.org_id = $1 AND s.status IN ('scheduled', 'live')
            AND s.starts_at >= now() - interval '2 hours'
            AND (
              $2::boolean OR s.teacher_user_id = $3
              OR ($4::boolean AND EXISTS (
                SELECT 1 FROM academic.section_teachers st
                 WHERE st.org_id = s.org_id AND st.section_id = ss.section_id
                   AND st.teacher_user_id = $3
              ))
              OR ($5::boolean AND EXISTS (
                SELECT 1 FROM academic.enrollments e
                 WHERE e.org_id = s.org_id AND e.section_id = ss.section_id
                   AND e.student_user_id = $3 AND e.status = 'active'
              ))
              OR ($6::boolean AND s.parent_view AND EXISTS (
                SELECT 1 FROM academic.enrollments e
                JOIN identity.guardian_links gl
                  ON gl.org_id = e.org_id AND gl.student_user_id = e.student_user_id
                 WHERE e.org_id = s.org_id AND e.section_id = ss.section_id
                   AND gl.guardian_user_id = $3 AND gl.can_view_live = true AND e.status = 'active'
              ))
            )
          GROUP BY s.id, teacher.name
          ORDER BY s.starts_at
          LIMIT 6`,
        [user.orgId, isAdmin, user.id, isTeacher, isStudent, isParent],
      );

      const activity = await client.query(
        `SELECT id, label, description, occurred_at
           FROM (
             SELECT 'attendance-' || audit.id::text AS id,
                    'Attendance recorded'::text AS label,
                    classes.name || ' · ' || sections.name || ' · ' ||
                      COALESCE(audit.metadata->>'markCount', '0') || ' students marked' AS description,
                    audit.created_at AS occurred_at
               FROM school.attendance_audit_log audit
               JOIN school.attendance_sessions attendance
                 ON attendance.org_id = audit.org_id AND attendance.id = audit.session_id
               JOIN academic.sections sections
                 ON sections.org_id = attendance.org_id AND sections.id = attendance.section_id
               JOIN academic.classes classes
                 ON classes.org_id = sections.org_id AND classes.id = sections.class_id
              WHERE audit.org_id = $1
                AND (
                  $2::boolean
                  OR ($3::boolean AND EXISTS (
                    SELECT 1 FROM academic.section_teachers assigned
                     WHERE assigned.org_id = attendance.org_id
                       AND assigned.section_id = attendance.section_id
                       AND assigned.teacher_user_id = $4
                  ))
                )
             UNION ALL
             SELECT 'payment-' || payment.id::text AS id,
                    'Fee payment received'::text AS label,
                    COALESCE(student.name, 'Student') || ' · ' || invoice.description AS description,
                    payment.captured_at AS occurred_at
               FROM fees.payments payment
               JOIN fees.invoices invoice
                 ON invoice.org_id = payment.org_id AND invoice.id = payment.invoice_id
               JOIN identity.users student
                 ON student.org_id = invoice.org_id AND student.id = invoice.student_user_id
              WHERE payment.org_id = $1 AND payment.status = 'captured' AND $2::boolean
           ) school_activity
          ORDER BY occurred_at DESC
          LIMIT 8`,
        [user.orgId, isAdmin, isTeacher, user.id],
      );

      let adminInsights;
      if (isAdmin) {
        const attendance = await client.query(
          `SELECT CURRENT_DATE::text AS attendance_date,
                  COUNT(marks.id)::int AS marked_students,
                  COUNT(*) FILTER (WHERE marks.status IN ('present', 'late'))::int AS present_students,
                  ROUND(
                    100.0 * COUNT(*) FILTER (WHERE marks.status IN ('present', 'late'))
                    / NULLIF(COUNT(marks.id), 0),
                    1
                  ) AS attendance_percent
             FROM school.attendance_sessions attendance
             JOIN school.attendance_marks marks
               ON marks.org_id = attendance.org_id AND marks.session_id = attendance.id
            WHERE attendance.org_id = $1
              AND attendance.attendance_date = CURRENT_DATE
              AND attendance.period IS NULL`,
          [user.orgId],
        );
        const fees = await client.query(
          `SELECT
             COALESCE((
               SELECT SUM(payment.amount_paise)
                 FROM fees.payments payment
                WHERE payment.org_id = $1
                  AND payment.status = 'captured'
                  AND payment.captured_at >= date_trunc('month', now())
                  AND payment.captured_at < date_trunc('month', now()) + interval '1 month'
             ), 0)::text AS collected_this_month_paise,
             COALESCE((
               SELECT SUM(invoice.amount_paise)
                 FROM fees.invoices invoice
                WHERE invoice.org_id = $1 AND invoice.status = 'unpaid'
             ), 0)::text AS outstanding_paise,
             (
               SELECT COUNT(*)::int
                 FROM fees.invoices invoice
                WHERE invoice.org_id = $1
                  AND invoice.status = 'unpaid'
                  AND invoice.due_date < CURRENT_DATE
             ) AS overdue_invoice_count`,
          [user.orgId],
        );
        const collectionTrend = await client.query(
          `SELECT to_char(months.month_start, 'YYYY-MM') AS month,
                  COALESCE(SUM(payment.amount_paise), 0)::text AS collected_paise
             FROM generate_series(
                    date_trunc('month', now()) - interval '5 months',
                    date_trunc('month', now()),
                    interval '1 month'
                  ) AS months(month_start)
             LEFT JOIN fees.payments payment
               ON payment.org_id = $1
              AND payment.status = 'captured'
              AND payment.captured_at >= months.month_start
              AND payment.captured_at < months.month_start + interval '1 month'
            GROUP BY months.month_start
            ORDER BY months.month_start`,
          [user.orgId],
        );
        const attendanceRow = attendance.rows[0];
        const feeRow = fees.rows[0];
        adminInsights = {
          attendanceToday: {
            attendanceDate: attendanceRow.attendance_date,
            markedStudents: Number(attendanceRow.marked_students),
            presentStudents: Number(attendanceRow.present_students),
            attendancePercent: attendanceRow.attendance_percent === null
              ? null
              : Number(attendanceRow.attendance_percent),
          },
          fees: {
            collectedThisMonthPaise: Number(feeRow.collected_this_month_paise),
            outstandingPaise: Number(feeRow.outstanding_paise),
            overdueInvoiceCount: Number(feeRow.overdue_invoice_count),
            collectionTrend: collectionTrend.rows.map((row: any) => ({
              month: row.month,
              collectedPaise: Number(row.collected_paise),
            })),
          },
        };
      }

      return {
        stats: stats.rows[0],
        sessions: sessions.rows,
        activity: activity.rows,
        adminInsights,
      };
    });

    const stats = dashboard.stats ?? { students: 0, classes: 0, sections: 0, teachers: 0 };
    const sessionCount = dashboard.sessions.length;
    const metrics = isAdmin
      ? [
          { label: "Enrolled students", value: String(stats.students), change: "Active enrollments", tone: "positive" },
          { label: "Classes", value: String(stats.classes), change: `${stats.sections} active sections`, tone: "neutral" },
          { label: "Upcoming live classes", value: String(sessionCount), change: "Next sessions", tone: "neutral" },
          { label: "Teaching staff", value: String(stats.teachers), change: "Assigned to sections", tone: "positive" },
        ]
      : [
          { label: isParent ? "Linked students" : isStudent ? "Your student record" : "Students in your sections", value: String(stats.students), change: "Based on your access", tone: "positive" },
          { label: "Classes", value: String(stats.classes), change: `${stats.sections} accessible sections`, tone: "neutral" },
          { label: "Upcoming live classes", value: String(sessionCount), change: "Next sessions", tone: "neutral" },
          { label: "Your role", value: user.roles[0]?.replaceAll("_", " ") ?? "Member", change: "School workspace", tone: "neutral" },
        ];

    res.json({
      userName: user.name,
      role: user.roles[0] ?? "student",
      metrics,
      upcomingSessions: dashboard.sessions.map((row) => ({
        id: row.id,
        title: row.title,
        teacherName: row.teacher_name,
        mode: row.mode,
        status: row.status,
        startAt: row.starts_at,
        parentView: row.parent_view,
        sections: row.sections,
      })),
      recentActivity: dashboard.activity.map((row: any) => ({
        id: row.id,
        label: row.label,
        description: row.description,
        occurredAt: row.occurred_at,
      })),
      ...(dashboard.adminInsights ? { adminInsights: dashboard.adminInsights } : {}),
    });
  } catch (error) {
    next(error);
  }
});
};

export default routes;
