import type { FastifyPluginAsync } from "fastify";
import { GetStudentsQueryParams, GrantConsentBody, RevokeConsentParams } from "@workspace/api-zod";
import { withOrg } from "@workspace/db";
import { createRouteRegistrar } from "../lib/fastify-routes";
import { requireAuth, type CampusRole } from "../lib/auth";

const routes: FastifyPluginAsync = async (fastify) => {
const router = createRouteRegistrar(fastify);

const adminRoles: CampusRole[] = ["super_admin", "org_admin", "campus_admin"];
const teachingRoles: CampusRole[] = ["teacher", "class_teacher", "hod"];
type ConsentPurpose = "live_view" | "recording" | "photo" | "data_processing";

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
              OR ($3::boolean AND EXISTS (
                SELECT 1 FROM academic.teacher_assignments ta
                 WHERE ta.org_id = c.org_id AND ta.section_id = s.id
                   AND ta.teacher_user_id = $4
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
              OR ($4::boolean AND EXISTS (
                SELECT 1 FROM academic.teacher_assignments ta
                 WHERE ta.org_id = s.org_id AND ta.section_id = s.id
                   AND ta.teacher_user_id = $5
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

router.get("/academic/consents", requireAuth, async (req, res, next) => {
  const user = req.campusUser;
  if (!user) return void res.status(401).json(errorBody("UNAUTHENTICATED", "Sign in to continue."));
  if (!user.roles.includes("parent")) {
    return void res.status(403).json(errorBody("FORBIDDEN", "Only a linked guardian can view consent choices."));
  }

  try {
    const result = await withOrg(user.orgId, (client) =>
      client.query<{
        student_id: string;
        student_name: string;
        purpose: ConsentPurpose;
        granted: boolean;
        granted_at: Date | null;
        revoked_at: Date | null;
      }>(
        `SELECT gl.student_user_id AS student_id, student.name AS student_name,
                purposes.purpose,
                (latest.id IS NOT NULL AND latest.revoked_at IS NULL) AS granted,
                latest.granted_at, latest.revoked_at
           FROM identity.guardian_links gl
           JOIN identity.users student
             ON student.id = gl.student_user_id AND student.org_id = gl.org_id
           CROSS JOIN (VALUES
             ('live_view'::text), ('recording'::text), ('photo'::text), ('data_processing'::text)
           ) AS purposes(purpose)
           LEFT JOIN LATERAL (
             SELECT c.id, c.granted_at, c.revoked_at
               FROM academic.consents c
              WHERE c.org_id = gl.org_id AND c.parent_id = gl.guardian_user_id
                AND c.student_id = gl.student_user_id AND c.purpose = purposes.purpose
              ORDER BY c.granted_at DESC
              LIMIT 1
           ) latest ON true
          WHERE gl.org_id = $1 AND gl.guardian_user_id = $2
          ORDER BY student.name, purposes.purpose`,
        [user.orgId, user.id],
      ),
    );
    res.json({
      items: result.rows.map((row) => ({
        studentId: row.student_id,
        studentName: row.student_name,
        purpose: row.purpose,
        granted: row.granted,
        grantedAt: row.granted_at?.toISOString() ?? null,
        revokedAt: row.revoked_at?.toISOString() ?? null,
      })),
      total: result.rowCount ?? result.rows.length,
    });
  } catch (error) {
    next(error);
  }
});

router.post("/academic/consents", requireAuth, async (req, res, next) => {
  const user = req.campusUser;
  if (!user) return void res.status(401).json(errorBody("UNAUTHENTICATED", "Sign in to continue."));
  if (!user.roles.includes("parent")) {
    return void res.status(403).json(errorBody("FORBIDDEN", "Only a linked guardian can grant consent."));
  }
  const parsed = GrantConsentBody.safeParse(req.body);
  if (!parsed.success) return void res.status(400).json(errorBody("INVALID_REQUEST", "Provide a valid student and consent purpose."));

  try {
    const record = await withOrg(user.orgId, async (client) => {
      const link = await client.query(
        `SELECT 1 FROM identity.guardian_links
          WHERE org_id = $1 AND guardian_user_id = $2 AND student_user_id = $3`,
        [user.orgId, user.id, parsed.data.studentId],
      );
      if (!link.rowCount) return null;

      let consent = await client.query<{ granted_at: Date; revoked_at: Date | null }>(
        `INSERT INTO academic.consents (org_id, parent_id, student_id, purpose, granted_by)
         VALUES ($1, $2, $3, $4, $2)
         ON CONFLICT (org_id, parent_id, student_id, purpose) WHERE revoked_at IS NULL
         DO NOTHING
         RETURNING granted_at, revoked_at`,
        [user.orgId, user.id, parsed.data.studentId, parsed.data.purpose],
      );
      if (!consent.rowCount) {
        consent = await client.query<{ granted_at: Date; revoked_at: Date | null }>(
          `SELECT granted_at, revoked_at FROM academic.consents
            WHERE org_id = $1 AND parent_id = $2 AND student_id = $3
              AND purpose = $4 AND revoked_at IS NULL
            ORDER BY granted_at DESC LIMIT 1`,
          [user.orgId, user.id, parsed.data.studentId, parsed.data.purpose],
        );
      }
      const student = await client.query<{ name: string }>(
        "SELECT name FROM identity.users WHERE org_id = $1 AND id = $2",
        [user.orgId, parsed.data.studentId],
      );
      const row = consent.rows[0];
      if (!row || !student.rows[0]) return null;
      return {
        studentId: parsed.data.studentId,
        studentName: student.rows[0].name,
        purpose: parsed.data.purpose,
        granted: row.revoked_at === null,
        grantedAt: row.granted_at.toISOString(),
        revokedAt: row.revoked_at?.toISOString() ?? null,
      };
    });
    if (!record) return void res.status(403).json(errorBody("FORBIDDEN", "This student is not linked to your guardian account."));
    res.status(201).json(record);
  } catch (error) {
    next(error);
  }
});

router.delete("/academic/consents/:studentId/:purpose", requireAuth, async (req, res, next) => {
  const user = req.campusUser;
  if (!user) return void res.status(401).json(errorBody("UNAUTHENTICATED", "Sign in to continue."));
  if (!user.roles.includes("parent")) {
    return void res.status(403).json(errorBody("FORBIDDEN", "Only a linked guardian can revoke consent."));
  }
  const params = RevokeConsentParams.safeParse(req.params);
  if (!params.success) return void res.status(400).json(errorBody("INVALID_REQUEST", "Provide a valid student and consent purpose."));

  try {
    const result = await withOrg(user.orgId, async (client) => {
      const link = await client.query(
        `SELECT 1 FROM identity.guardian_links
          WHERE org_id = $1 AND guardian_user_id = $2 AND student_user_id = $3`,
        [user.orgId, user.id, params.data.studentId],
      );
      if (!link.rowCount) return null;
      const revoked = await client.query(
        `UPDATE academic.consents SET revoked_at = now()
          WHERE org_id = $1 AND parent_id = $2 AND student_id = $3
            AND purpose = $4 AND revoked_at IS NULL
          RETURNING id`,
        [user.orgId, user.id, params.data.studentId, params.data.purpose],
      );
      return Boolean(revoked.rowCount);
    });
    if (result === null) return void res.status(403).json(errorBody("FORBIDDEN", "This student is not linked to your guardian account."));
    res.json({ revoked: result });
  } catch (error) {
    next(error);
  }
});
};

export default routes;
