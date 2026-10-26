import { Router } from "express";
import { GetStudentsQueryParams } from "@workspace/api-zod";
import { withOrg } from "@workspace/db";
import { requireAuth, type CampusRole } from "../lib/auth";

const router = Router();

const adminRoles: CampusRole[] = ["super_admin", "org_admin", "campus_admin"];
const teachingRoles: CampusRole[] = ["teacher", "class_teacher", "hod"];

function errorBody(code: string, message: string) {
  return { error: { code, message } };
}

function roleFlags(roles: CampusRole[]) {
  return {
    isAdmin: roles.some((role) => adminRoles.includes(role)),
    isTeacher: roles.some((role) => teachingRoles.includes(role)),
    isStudent: roles.includes("student"),
    isParent: roles.includes("parent"),
  };
}

router.get("/academic/classes", requireAuth, async (req, res, next) => {
  const user = req.campusUser;
  if (!user) return void res.status(401).json(errorBody("UNAUTHENTICATED", "Sign in to continue."));
  const flags = roleFlags(user.roles);

  try {
    const result = await withOrg(user.orgId, (client) =>
      client.query(
        `SELECT c.id, c.name, c.grade_level,
                COUNT(DISTINCT s.id)::int AS section_count,
                COUNT(DISTINCT e.student_user_id)::int AS student_count
           FROM academic.classes c
           LEFT JOIN academic.sections s
             ON s.class_id = c.id AND s.org_id = c.org_id
           LEFT JOIN academic.enrollments e
             ON e.section_id = s.id AND e.org_id = c.org_id AND e.status = 'active'
          WHERE c.org_id = $1
            AND (
              $2::boolean
              OR ($3::boolean AND EXISTS (
                SELECT 1 FROM academic.section_teachers st
                 WHERE st.org_id = c.org_id AND st.section_id = s.id
                   AND st.teacher_user_id = $4
              ))
              OR ($5::boolean AND EXISTS (
                SELECT 1 FROM academic.enrollments mine
                 WHERE mine.org_id = c.org_id AND mine.section_id = s.id
                   AND mine.student_user_id = $4 AND mine.status = 'active'
              ))
              OR ($6::boolean AND EXISTS (
                SELECT 1 FROM identity.guardian_links gl
                JOIN academic.enrollments child
                  ON child.student_user_id = gl.student_user_id
                 AND child.org_id = gl.org_id AND child.section_id = s.id
                 WHERE gl.org_id = c.org_id AND gl.guardian_user_id = $4
                   AND child.status = 'active'
              ))
            )
          GROUP BY c.id
          ORDER BY c.grade_level, c.name`,
        [user.orgId, flags.isAdmin, flags.isTeacher, user.id, flags.isStudent, flags.isParent],
      ),
    );

    res.json({
      items: result.rows.map((row) => ({
        id: row.id,
        name: row.name,
        gradeLevel: row.grade_level,
        sectionCount: row.section_count,
        studentCount: row.student_count,
      })),
      total: result.rowCount ?? result.rows.length,
    });
  } catch (error) {
    next(error);
  }
});

router.get("/academic/sections", requireAuth, async (req, res, next) => {
  const user = req.campusUser;
  if (!user) return void res.status(401).json(errorBody("UNAUTHENTICATED", "Sign in to continue."));
  const classId = typeof req.query.classId === "string" ? req.query.classId : null;
  if (classId && !/^[0-9a-f-]{36}$/i.test(classId)) {
    return void res.status(400).json(errorBody("INVALID_REQUEST", "classId must be a UUID."));
  }
  const flags = roleFlags(user.roles);

  try {
    const result = await withOrg(user.orgId, (client) =>
      client.query(
        `SELECT s.id, s.class_id, c.name AS class_name, s.name,
                COUNT(DISTINCT e.student_user_id)::int AS student_count
           FROM academic.sections s
           JOIN academic.classes c
             ON c.id = s.class_id AND c.org_id = s.org_id
           LEFT JOIN academic.enrollments e
             ON e.section_id = s.id AND e.org_id = s.org_id AND e.status = 'active'
          WHERE s.org_id = $1
            AND ($2::uuid IS NULL OR s.class_id = $2)
            AND (
              $3::boolean
              OR ($4::boolean AND EXISTS (
                SELECT 1 FROM academic.section_teachers st
                 WHERE st.org_id = s.org_id AND st.section_id = s.id
                   AND st.teacher_user_id = $5
              ))
              OR ($6::boolean AND EXISTS (
                SELECT 1 FROM academic.enrollments mine
                 WHERE mine.org_id = s.org_id AND mine.section_id = s.id
                   AND mine.student_user_id = $5 AND mine.status = 'active'
              ))
              OR ($7::boolean AND EXISTS (
                SELECT 1 FROM identity.guardian_links gl
                JOIN academic.enrollments child
                  ON child.student_user_id = gl.student_user_id
                 AND child.org_id = gl.org_id AND child.section_id = s.id
                 WHERE gl.org_id = s.org_id AND gl.guardian_user_id = $5
                   AND child.status = 'active'
              ))
            )
          GROUP BY s.id, c.name
          ORDER BY c.name, s.name`,
        [user.orgId, classId, flags.isAdmin, flags.isTeacher, user.id, flags.isStudent, flags.isParent],
      ),
    );

    res.json({
      items: result.rows.map((row) => ({
        id: row.id,
        classId: row.class_id,
        className: row.class_name,
        name: row.name,
        studentCount: row.student_count,
      })),
      total: result.rowCount ?? result.rows.length,
    });
  } catch (error) {
    next(error);
  }
});

router.get("/academic/students", requireAuth, async (req, res, next) => {
  const user = req.campusUser;
  if (!user) return void res.status(401).json(errorBody("UNAUTHENTICATED", "Sign in to continue."));
  const parsed = GetStudentsQueryParams.safeParse(req.query);
  if (!parsed.success) {
    return void res.status(400).json(errorBody("INVALID_REQUEST", "Provide a valid sectionId and pagination."));
  }
  const { sectionId, q, limit = 50, offset = 0 } = parsed.data;
  const flags = roleFlags(user.roles);
  const maySeeRoster = flags.isAdmin || flags.isTeacher || flags.isStudent || flags.isParent;

  if (!maySeeRoster) return void res.status(403).json(errorBody("FORBIDDEN", "You cannot view this roster."));

  try {
    const result = await withOrg(user.orgId, async (client) => {
      const where = `e.org_id = $1 AND e.section_id = $2 AND e.status = 'active'
        AND (
          $3::boolean OR $4::boolean
          OR ($5::boolean AND u.id = $6)
          OR ($7::boolean AND EXISTS (
            SELECT 1 FROM identity.guardian_links gl
             WHERE gl.org_id = e.org_id AND gl.student_user_id = u.id
               AND gl.guardian_user_id = $6
          ))
        )
        AND ($8::text IS NULL OR u.name ILIKE '%' || $8 || '%' OR e.admission_no ILIKE '%' || $8 || '%')`;
      const count = await client.query<{ total: string }>(
        `SELECT COUNT(*)::text AS total
           FROM academic.enrollments e
           JOIN academic.sections s ON s.id = e.section_id AND s.org_id = e.org_id
           JOIN identity.users u ON u.id = e.student_user_id AND u.org_id = e.org_id
          WHERE ${where}`,
        [user.orgId, sectionId, flags.isAdmin, flags.isTeacher, flags.isStudent, user.id, flags.isParent, q ?? null],
      );
      const rows = await client.query(
        `SELECT u.id, u.name, e.admission_no, s.id AS section_id,
                s.name AS section_name, e.status
           FROM academic.enrollments e
           JOIN academic.sections s ON s.id = e.section_id AND s.org_id = e.org_id
           JOIN identity.users u ON u.id = e.student_user_id AND u.org_id = e.org_id
          WHERE ${where}
          ORDER BY u.name
          LIMIT $9 OFFSET $10`,
        [user.orgId, sectionId, flags.isAdmin, flags.isTeacher, flags.isStudent, user.id, flags.isParent, q ?? null, limit, offset],
      );
      return { rows: rows.rows, total: Number(count.rows[0]?.total ?? 0) };
    });

    res.json({
      items: result.rows.map((row) => ({
        id: row.id,
        name: row.name,
        admissionNo: row.admission_no,
        sectionId: row.section_id,
        sectionName: row.section_name,
        status: row.status,
      })),
      total: result.total,
      limit,
      offset,
    });
  } catch (error) {
    next(error);
  }
});

export default router;
