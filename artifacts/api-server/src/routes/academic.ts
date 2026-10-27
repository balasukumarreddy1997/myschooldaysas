import type { FastifyPluginAsync } from "fastify";
import type { PoolClient } from "pg";
import {
  CreateStudentAdmissionsBody,
  CreateEnrollmentBody,
  GetAvailableStudentsQueryParams,
  GetGuardianLinksQueryParams,
  GetStudentsQueryParams,
  GrantConsentBody,
  RevokeConsentParams,
  UpdateGuardianLinkFlagsBody,
  UpdateGuardianLinkFlagsParams,
  UpdateEnrollmentYearBody,
  UpdateEnrollmentYearParams,
  UpdateSectionBody,
  UpdateSectionParams,
  PreviewStudentAdmissionsBody,
} from "@workspace/api-zod";
import { withOrg } from "@workspace/db";
import { createRouteRegistrar } from "../lib/fastify-routes";
import { hashPassword, requireAuth, type CampusRole } from "../lib/auth";
import { canManageAcademicSetup, sectionHasCapacity } from "../lib/academic-scheduling-policy";
import { generateTemporaryPassword } from "../lib/identity-security";

const routes: FastifyPluginAsync = async (fastify) => {
const router = createRouteRegistrar(fastify);

const adminRoles: CampusRole[] = ["super_admin", "org_admin", "campus_admin"];
const teachingRoles: CampusRole[] = ["teacher", "class_teacher", "hod"];
type ConsentPurpose = "live_view" | "recording" | "photo" | "data_processing";

type AdmissionInputRow = {
  name: string;
  email: string;
  admissionNo: string;
  dateOfBirth?: string | Date;
  gender?: string;
  phone?: string;
  address?: string;
  bloodGroup?: string;
  guardianName?: string;
  guardianEmail?: string;
  guardianPhone?: string;
  guardianRelationship?: string;
};
type AdmissionRowError = { row: number; field: string; message: string };

async function inspectAdmissions(
  client: PoolClient,
  orgId: string,
  sectionId: string,
  academicYear: string,
  rows: AdmissionInputRow[],
  lockSection: boolean,
) {
  const sectionResult = await client.query<{ id: string; name: string; capacity: number | null }>(
    `SELECT id, name, capacity
       FROM academic.sections
      WHERE org_id = $1 AND id = $2${lockSection ? " FOR UPDATE" : ""}`,
    [orgId, sectionId],
  );
  const section = sectionResult.rows[0];
  if (!section) return null;

  const errors: AdmissionRowError[] = [];
  const items = rows.map((row, index) => ({
    row: index + 1,
    name: row.name.trim(),
    email: row.email.trim().toLowerCase(),
    admissionNo: row.admissionNo.trim().toUpperCase(),
    dateOfBirth: row.dateOfBirth instanceof Date
      ? row.dateOfBirth.toISOString().slice(0, 10)
      : row.dateOfBirth?.trim() || null,
    gender: row.gender?.trim() || null,
    phone: row.phone?.trim() || null,
    address: row.address?.trim() || null,
    bloodGroup: row.bloodGroup?.trim() || null,
    guardianName: row.guardianName?.trim() || null,
    guardianEmail: row.guardianEmail?.trim().toLowerCase() || null,
    guardianPhone: row.guardianPhone?.trim() || null,
    guardianRelationship: row.guardianRelationship?.trim() || null,
  }));
  const seenEmails = new Set<string>();
  const seenAdmissionNumbers = new Set<string>();
  for (const item of items) {
    if (!item.name) errors.push({ row: item.row, field: "name", message: "Student name is required." });
    if (!item.email) errors.push({ row: item.row, field: "email", message: "Email is required." });
    if (!item.admissionNo) errors.push({ row: item.row, field: "admissionNo", message: "Admission number is required." });
    if (item.dateOfBirth) {
      const parsedDate = new Date(`${item.dateOfBirth}T00:00:00.000Z`);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(item.dateOfBirth)
        || Number.isNaN(parsedDate.getTime())
        || parsedDate.toISOString().slice(0, 10) !== item.dateOfBirth) {
        errors.push({ row: item.row, field: "dateOfBirth", message: "Use a valid date in YYYY-MM-DD format." });
      }
    }
    if (item.guardianEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(item.guardianEmail)) {
      errors.push({ row: item.row, field: "guardianEmail", message: "Provide a valid guardian email address." });
    }
    const hasGuardianContact = !!(item.guardianName || item.guardianEmail || item.guardianPhone || item.guardianRelationship);
    if (hasGuardianContact && !item.guardianName) {
      errors.push({ row: item.row, field: "guardianName", message: "Guardian name is required when providing guardian contact details." });
    }
    if (hasGuardianContact && !item.guardianEmail && !item.guardianPhone) {
      errors.push({ row: item.row, field: "guardianPhone", message: "Provide a guardian email or phone number." });
    }
    if (seenEmails.has(item.email)) errors.push({ row: item.row, field: "email", message: "Email is repeated in this batch." });
    if (seenAdmissionNumbers.has(item.admissionNo)) {
      errors.push({ row: item.row, field: "admissionNo", message: "Admission number is repeated in this batch." });
    }
    seenEmails.add(item.email);
    seenAdmissionNumbers.add(item.admissionNo);
  }

  const emails = [...new Set(items.map((item) => item.email).filter(Boolean))];
  const admissionNumbers = [...new Set(items.map((item) => item.admissionNo).filter(Boolean))];
  if (emails.length) {
    const existingUsers = await client.query<{ email: string }>(
      `SELECT lower(email) AS email
         FROM identity.users
        WHERE org_id = $1 AND lower(email) = ANY($2::text[])`,
      [orgId, emails],
    );
    const existingEmails = new Set(existingUsers.rows.map((item) => item.email));
    for (const item of items) {
      if (existingEmails.has(item.email)) {
        errors.push({ row: item.row, field: "email", message: "An account already uses this email." });
      }
    }
  }
  if (admissionNumbers.length) {
    const existingAdmissions = await client.query<{ admission_no: string }>(
      `SELECT upper(admission_no) AS admission_no
         FROM academic.enrollments
        WHERE org_id = $1 AND academic_year = $2
          AND upper(admission_no) = ANY($3::text[])`,
      [orgId, academicYear, admissionNumbers],
    );
    const existingNumbers = new Set(existingAdmissions.rows.map((item) => item.admission_no));
    for (const item of items) {
      if (existingNumbers.has(item.admissionNo)) {
        errors.push({ row: item.row, field: "admissionNo", message: "This admission number is already used for the academic year." });
      }
    }
  }

  const occupancy = await client.query<{ count: number }>(
    `SELECT COUNT(*)::int AS count
       FROM academic.enrollments
      WHERE org_id = $1 AND section_id = $2 AND status = 'active'`,
    [orgId, section.id],
  );
  const activeEnrollmentCount = occupancy.rows[0]?.count ?? 0;
  const seatsAvailable = section.capacity == null ? null : Math.max(0, section.capacity - activeEnrollmentCount);
  if (seatsAvailable != null && items.length > seatsAvailable) {
    for (const item of items.slice(seatsAvailable)) {
      errors.push({ row: item.row, field: "sectionId", message: `Only ${seatsAvailable} seat(s) are currently available.` });
    }
  }

  return {
    section,
    activeEnrollmentCount,
    seatsAvailable,
    items,
    errors,
    valid: errors.length === 0,
  };
}

async function hashAdmissionPasswords(rows: AdmissionInputRow[]) {
  const credentials = rows.map((row) => ({ ...row, temporaryPassword: generateTemporaryPassword() }));
  const hashes = new Array<string>(credentials.length);
  let nextIndex = 0;
  await Promise.all(Array.from({ length: Math.min(2, credentials.length) }, async () => {
    while (true) {
      const index = nextIndex++;
      if (index >= credentials.length) return;
      hashes[index] = await hashPassword(credentials[index]!.temporaryPassword);
    }
  }));
  return credentials.map((credential, index) => ({ ...credential, passwordHash: hashes[index]! }));
}
const unavailableConsentPurposes = new Set<ConsentPurpose>(["recording", "photo"]);

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

router.get("/academic/guardians", requireAuth, async (req, res, next) => {
  const user = req.campusUser;
  if (!user) return void res.status(401).json(errorBody("UNAUTHENTICATED", "Sign in to continue."));
  if (!user.roles.some((role) => adminRoles.includes(role))) {
    return void res.status(403).json(errorBody("FORBIDDEN", "Administrator role required."));
  }
  const parsed = GetGuardianLinksQueryParams.safeParse(req.query);
  if (!parsed.success) return void res.status(400).json(errorBody("INVALID_REQUEST", "Provide valid guardian-list filters."));
  const { q, limit = 50, offset = 0 } = parsed.data;

  try {
    const result = await withOrg(user.orgId, async (client) => {
      const count = await client.query<{ total: string }>(
        `SELECT COUNT(*)::text AS total
           FROM identity.guardian_links gl
           JOIN identity.users student
             ON student.org_id = gl.org_id AND student.id = gl.student_user_id
           JOIN identity.users guardian
             ON guardian.org_id = gl.org_id AND guardian.id = gl.guardian_user_id
          WHERE gl.org_id = $1
            AND ($2::text IS NULL OR student.name ILIKE '%' || $2 || '%'
              OR guardian.name ILIKE '%' || $2 || '%' OR guardian.email ILIKE '%' || $2 || '%')`,
        [user.orgId, q?.trim() || null],
      );
      const rows = await client.query<{
        student_id: string;
        student_name: string;
        guardian_id: string;
        guardian_name: string;
        guardian_email: string;
        relationship: string;
        can_view_live: boolean;
        can_pay_fees: boolean;
      }>(
        `SELECT gl.student_user_id AS student_id, student.name AS student_name,
                gl.guardian_user_id AS guardian_id, guardian.name AS guardian_name,
                guardian.email AS guardian_email, gl.relationship,
                gl.can_view_live, gl.can_pay_fees
           FROM identity.guardian_links gl
           JOIN identity.users student
             ON student.org_id = gl.org_id AND student.id = gl.student_user_id
           JOIN identity.users guardian
             ON guardian.org_id = gl.org_id AND guardian.id = gl.guardian_user_id
          WHERE gl.org_id = $1
            AND ($2::text IS NULL OR student.name ILIKE '%' || $2 || '%'
              OR guardian.name ILIKE '%' || $2 || '%' OR guardian.email ILIKE '%' || $2 || '%')
          ORDER BY student.name, guardian.name
          LIMIT $3 OFFSET $4`,
        [user.orgId, q?.trim() || null, limit, offset],
      );
      return {
        items: rows.rows.map((row) => ({
          studentId: row.student_id,
          studentName: row.student_name,
          guardianId: row.guardian_id,
          guardianName: row.guardian_name,
          guardianEmail: row.guardian_email,
          relationship: row.relationship,
          canViewLive: row.can_view_live,
          canPayFees: row.can_pay_fees,
        })),
        total: Number(count.rows[0]?.total ?? 0),
      };
    });
    res.json(result);
  } catch (error) {
    next(error);
  }
});

router.patch("/academic/guardians/:studentId/:guardianId", requireAuth, async (req, res, next) => {
  const user = req.campusUser;
  if (!user) return void res.status(401).json(errorBody("UNAUTHENTICATED", "Sign in to continue."));
  if (!user.roles.some((role) => adminRoles.includes(role))) {
    return void res.status(403).json(errorBody("FORBIDDEN", "Administrator role required."));
  }
  const params = UpdateGuardianLinkFlagsParams.safeParse(req.params);
  const body = UpdateGuardianLinkFlagsBody.safeParse(req.body);
  if (!params.success || !body.success) {
    return void res.status(400).json(errorBody("INVALID_REQUEST", "Provide valid guardian-link flags."));
  }

  try {
    const link = await withOrg(user.orgId, async (client) => {
      const updated = await client.query(
        `UPDATE identity.guardian_links
            SET can_view_live = $4, can_pay_fees = $5
          WHERE org_id = $1 AND student_user_id = $2 AND guardian_user_id = $3`,
        [user.orgId, params.data.studentId, params.data.guardianId, body.data.canViewLive, body.data.canPayFees],
      );
      if ((updated.rowCount ?? 0) === 0) return null;
      const result = await client.query<{
        student_id: string;
        student_name: string;
        guardian_id: string;
        guardian_name: string;
        guardian_email: string;
        relationship: string;
        can_view_live: boolean;
        can_pay_fees: boolean;
      }>(
        `SELECT gl.student_user_id AS student_id, student.name AS student_name,
                gl.guardian_user_id AS guardian_id, guardian.name AS guardian_name,
                guardian.email AS guardian_email, gl.relationship,
                gl.can_view_live, gl.can_pay_fees
           FROM identity.guardian_links gl
           JOIN identity.users student
             ON student.org_id = gl.org_id AND student.id = gl.student_user_id
           JOIN identity.users guardian
             ON guardian.org_id = gl.org_id AND guardian.id = gl.guardian_user_id
          WHERE gl.org_id = $1 AND gl.student_user_id = $2 AND gl.guardian_user_id = $3`,
        [user.orgId, params.data.studentId, params.data.guardianId],
      );
      return result.rows[0] ?? null;
    });
    if (!link) return void res.status(404).json(errorBody("NOT_FOUND", "Guardian link not found."));
    res.json({
      studentId: link.student_id,
      studentName: link.student_name,
      guardianId: link.guardian_id,
      guardianName: link.guardian_name,
      guardianEmail: link.guardian_email,
      relationship: link.relationship,
      canViewLive: link.can_view_live,
      canPayFees: link.can_pay_fees,
    });
  } catch (error) {
    next(error);
  }
});

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
        `SELECT s.id, s.class_id, c.name AS class_name, s.name, s.capacity,
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
        capacity: row.capacity,
      })),
      total: result.rowCount ?? result.rows.length,
    });
  } catch (error) {
    next(error);
  }
});

router.patch("/academic/sections/:sectionId", requireAuth, async (req, res, next) => {
  const user = req.campusUser;
  if (!user) return void res.status(401).json(errorBody("UNAUTHENTICATED", "Sign in to continue."));
  if (!canManageAcademicSetup(user.roles)) {
    return void res.status(403).json(errorBody("FORBIDDEN", "Only administrators can manage section capacity."));
  }
  const params = UpdateSectionParams.safeParse(req.params);
  const body = UpdateSectionBody.safeParse(req.body);
  if (!params.success || !body.success) {
    return void res.status(400).json(errorBody("INVALID_REQUEST", "Provide a valid section ID and capacity."));
  }

  try {
    const section = await withOrg(user.orgId, async (client) => {
      const updated = await client.query(
        `UPDATE academic.sections
            SET capacity = $3
          WHERE org_id = $1 AND id = $2
          RETURNING id`,
        [user.orgId, params.data.sectionId, body.data.capacity],
      );
      if (!updated.rowCount) return null;
      const result = await client.query(
        `SELECT s.id, s.class_id, c.name AS class_name, s.name, s.capacity,
                COUNT(DISTINCT e.student_user_id)::int AS student_count
           FROM academic.sections s
           JOIN academic.classes c ON c.id = s.class_id AND c.org_id = s.org_id
           LEFT JOIN academic.enrollments e
             ON e.org_id = s.org_id AND e.section_id = s.id AND e.status = 'active'
          WHERE s.org_id = $1 AND s.id = $2
          GROUP BY s.id, c.name`,
        [user.orgId, params.data.sectionId],
      );
      const row = result.rows[0];
      return {
        id: row.id,
        classId: row.class_id,
        className: row.class_name,
        name: row.name,
        capacity: row.capacity,
        studentCount: row.student_count,
      };
    });
    if (!section) return void res.status(404).json(errorBody("NOT_FOUND", "Section not found."));
    res.json(section);
  } catch (error) {
    next(error);
  }
});

router.get("/academic/students/available", requireAuth, async (req, res, next) => {
  const user = req.campusUser;
  if (!user) return void res.status(401).json(errorBody("UNAUTHENTICATED", "Sign in to continue."));
  if (!canManageAcademicSetup(user.roles)) {
    return void res.status(403).json(errorBody("FORBIDDEN", "Only administrators can enroll students."));
  }
  const parsed = GetAvailableStudentsQueryParams.safeParse(req.query);
  if (!parsed.success || parsed.data.academicYear.trim().length < 4) {
    return void res.status(400).json(errorBody("INVALID_REQUEST", "Provide a valid academic year and pagination."));
  }
  const { academicYear, q, limit = 50, offset = 0 } = parsed.data;
  const search = q?.trim() || null;

  try {
    const result = await withOrg(user.orgId, async (client) => {
      const count = await client.query<{ total: string }>(
        `SELECT COUNT(*)::text AS total
           FROM identity.users u
           JOIN identity.user_roles ur
             ON ur.org_id = u.org_id AND ur.user_id = u.id AND ur.role = 'student'
          WHERE u.org_id = $1 AND u.status = 'active'
            AND NOT EXISTS (
              SELECT 1 FROM academic.enrollments e
               WHERE e.org_id = u.org_id AND e.student_user_id = u.id AND e.academic_year = $2
            )
            AND ($3::text IS NULL OR u.name ILIKE '%' || $3 || '%' OR u.email ILIKE '%' || $3 || '%')`,
        [user.orgId, academicYear.trim(), search],
      );
      const rows = await client.query<{ id: string; name: string; email: string }>(
        `SELECT u.id, u.name, u.email
           FROM identity.users u
           JOIN identity.user_roles ur
             ON ur.org_id = u.org_id AND ur.user_id = u.id AND ur.role = 'student'
          WHERE u.org_id = $1 AND u.status = 'active'
            AND NOT EXISTS (
              SELECT 1 FROM academic.enrollments e
               WHERE e.org_id = u.org_id AND e.student_user_id = u.id AND e.academic_year = $2
            )
            AND ($3::text IS NULL OR u.name ILIKE '%' || $3 || '%' OR u.email ILIKE '%' || $3 || '%')
          ORDER BY u.name, u.email
          LIMIT $4 OFFSET $5`,
        [user.orgId, academicYear.trim(), search, limit, offset],
      );
      return {
        items: rows.rows,
        total: Number(count.rows[0]?.total ?? 0),
        limit,
        offset,
      };
    });
    res.json(result);
  } catch (error) {
    next(error);
  }
});

router.post("/academic/enrollments", requireAuth, async (req, res, next) => {
  const user = req.campusUser;
  if (!user) return void res.status(401).json(errorBody("UNAUTHENTICATED", "Sign in to continue."));
  if (!canManageAcademicSetup(user.roles)) {
    return void res.status(403).json(errorBody("FORBIDDEN", "Only administrators can enroll students."));
  }
  const parsed = CreateEnrollmentBody.safeParse(req.body);
  const admissionNo = parsed.success ? parsed.data.admissionNo.trim() : "";
  const academicYear = parsed.success ? parsed.data.academicYear.trim() : "";
  if (!parsed.success || !admissionNo || admissionNo.length > 40 || academicYear.length < 4 || academicYear.length > 24) {
    return void res.status(400).json(errorBody("INVALID_REQUEST", "Provide a student, section, admission number, and valid academic year."));
  }

  try {
    const result = await withOrg(user.orgId, async (client) => {
      const sectionResult = await client.query<{ id: string; name: string; capacity: number | null }>(
        `SELECT id, name, capacity
           FROM academic.sections
          WHERE org_id = $1 AND id = $2
          FOR UPDATE`,
        [user.orgId, parsed.data.sectionId],
      );
      const section = sectionResult.rows[0];
      if (!section) return { kind: "section_not_found" as const };

      const studentResult = await client.query<{ id: string; name: string }>(
        `SELECT u.id, u.name
           FROM identity.users u
           JOIN identity.user_roles ur
             ON ur.org_id = u.org_id AND ur.user_id = u.id AND ur.role = 'student'
          WHERE u.org_id = $1 AND u.id = $2 AND u.status = 'active'`,
        [user.orgId, parsed.data.studentId],
      );
      const student = studentResult.rows[0];
      if (!student) return { kind: "student_not_found" as const };

      const existing = await client.query(
        `SELECT 1 FROM academic.enrollments
          WHERE org_id = $1 AND student_user_id = $2 AND academic_year = $3
          LIMIT 1`,
        [user.orgId, student.id, academicYear],
      );
      if (existing.rowCount) return { kind: "already_enrolled" as const };

      const occupancy = await client.query<{ count: number }>(
        `SELECT COUNT(*)::int AS count
           FROM academic.enrollments
          WHERE org_id = $1 AND section_id = $2 AND status = 'active'`,
        [user.orgId, section.id],
      );
      const activeEnrollmentCount = occupancy.rows[0]?.count ?? 0;
      if (!sectionHasCapacity(section.capacity, activeEnrollmentCount)) {
        return { kind: "section_full" as const, capacity: section.capacity };
      }

      const created = await client.query<{ id: string; status: string; academic_year: string }>(
        `INSERT INTO academic.enrollments
           (org_id, student_user_id, section_id, admission_no, academic_year)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id, status, academic_year`,
        [user.orgId, student.id, section.id, admissionNo, academicYear],
      );
      return {
        kind: "created" as const,
        enrollmentId: created.rows[0]!.id,
        status: created.rows[0]!.status,
        academicYear: created.rows[0]!.academic_year,
        sectionId: section.id,
        sectionName: section.name,
        studentId: student.id,
        studentName: student.name,
      };
    });

    if (result.kind === "section_not_found") {
      return void res.status(404).json(errorBody("NOT_FOUND", "Section not found."));
    }
    if (result.kind === "student_not_found") {
      return void res.status(404).json(errorBody("NOT_FOUND", "Active student account not found."));
    }
    if (result.kind === "already_enrolled") {
      return void res.status(409).json(errorBody("CONFLICT", "The student already has an enrollment for this academic year."));
    }
    if (result.kind === "section_full") {
      return void res.status(409).json(errorBody("CONFLICT", `This section has reached its capacity of ${result.capacity}.`));
    }
    res.status(201).json({
      id: result.studentId,
      enrollmentId: result.enrollmentId,
      name: result.studentName,
      admissionNo,
      sectionId: result.sectionId,
      sectionName: result.sectionName,
      status: result.status,
      academicYear: result.academicYear,
    });
  } catch (error: any) {
    if (error?.code === "23505") {
      return void res.status(409).json(errorBody("CONFLICT", "Admission number or student enrollment already exists for this academic year."));
    }
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
        `SELECT u.id, e.id AS enrollment_id, u.name, e.admission_no, s.id AS section_id,
                s.name AS section_name, e.status, e.academic_year
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
        enrollmentId: row.enrollment_id,
        name: row.name,
        admissionNo: row.admission_no,
        sectionId: row.section_id,
        sectionName: row.section_name,
        status: row.status,
        academicYear: row.academic_year,
      })),
      total: result.total,
      limit,
      offset,
    });
  } catch (error) {
    next(error);
  }
});

router.post("/academic/admissions/preview", requireAuth, async (req, res, next) => {
  const user = req.campusUser;
  if (!user) return void res.status(401).json(errorBody("UNAUTHENTICATED", "Sign in to continue."));
  if (!canManageAcademicSetup(user.roles)) {
    return void res.status(403).json(errorBody("FORBIDDEN", "Only administrators can admit students."));
  }
  const parsed = PreviewStudentAdmissionsBody.safeParse(req.body);
  const academicYear = parsed.success ? parsed.data.academicYear.trim() : "";
  if (!parsed.success || academicYear.length < 4 || academicYear.length > 24) {
    return void res.status(400).json(errorBody("INVALID_REQUEST", "Provide a valid section, academic year, and student list."));
  }

  try {
    const inspection = await withOrg(user.orgId, (client) =>
      inspectAdmissions(client, user.orgId, parsed.data.sectionId, academicYear, parsed.data.rows, false),
    );
    if (!inspection) return void res.status(404).json(errorBody("NOT_FOUND", "Section not found."));
    res.json({
      sectionId: inspection.section.id,
      sectionName: inspection.section.name,
      academicYear,
      capacity: inspection.section.capacity,
      activeEnrollmentCount: inspection.activeEnrollmentCount,
      seatsAvailable: inspection.seatsAvailable,
      valid: inspection.valid,
      items: inspection.items,
      errors: inspection.errors,
    });
  } catch (error) {
    next(error);
  }
});

router.post("/academic/admissions", requireAuth, async (req, res, next) => {
  const user = req.campusUser;
  if (!user) return void res.status(401).json(errorBody("UNAUTHENTICATED", "Sign in to continue."));
  if (!canManageAcademicSetup(user.roles)) {
    return void res.status(403).json(errorBody("FORBIDDEN", "Only administrators can admit students."));
  }
  const parsed = CreateStudentAdmissionsBody.safeParse(req.body);
  const academicYear = parsed.success ? parsed.data.academicYear.trim() : "";
  if (!parsed.success || academicYear.length < 4 || academicYear.length > 24) {
    return void res.status(400).json(errorBody("INVALID_REQUEST", "Provide a valid section, academic year, and student list."));
  }

  try {
    const preliminary = await withOrg(user.orgId, (client) =>
      inspectAdmissions(client, user.orgId, parsed.data.sectionId, academicYear, parsed.data.rows, false),
    );
    if (!preliminary) return void res.status(404).json(errorBody("NOT_FOUND", "Section not found."));
    if (!preliminary.valid) {
      return void res.status(409).json({
        error: { code: "CONFLICT", message: "Resolve the admission preview errors and try again.", details: preliminary.errors },
      });
    }

    const preparedRows = preliminary.items.map(({
      name, email, admissionNo, dateOfBirth, gender, phone, address, bloodGroup,
      guardianName, guardianEmail, guardianPhone, guardianRelationship,
    }) => ({
      name, email, admissionNo, dateOfBirth: dateOfBirth ?? undefined,
      gender: gender ?? undefined, phone: phone ?? undefined, address: address ?? undefined,
      bloodGroup: bloodGroup ?? undefined, guardianName: guardianName ?? undefined,
      guardianEmail: guardianEmail ?? undefined, guardianPhone: guardianPhone ?? undefined,
      guardianRelationship: guardianRelationship ?? undefined,
    }));
    const credentialRows = await hashAdmissionPasswords(preparedRows);
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    const result = await withOrg(user.orgId, async (client) => {
      const current = await inspectAdmissions(
        client,
        user.orgId,
        parsed.data.sectionId,
        academicYear,
        preparedRows,
        true,
      );
      if (!current) return { kind: "section_not_found" as const };
      if (!current.valid) return { kind: "invalid" as const, errors: current.errors };

      const created = [];
      for (const [index, item] of current.items.entries()) {
        const credential = credentialRows[index]!;
        const account = await client.query<{ id: string }>(
          `INSERT INTO identity.users
             (org_id, email, name, password_hash, must_change_password, temporary_password_expires_at)
           VALUES ($1, $2, $3, $4, true, $5)
           RETURNING id`,
          [user.orgId, item.email, item.name, credential.passwordHash, expiresAt],
        );
        const studentId = account.rows[0]!.id;
        await client.query(
          `INSERT INTO identity.user_roles (org_id, user_id, role)
           VALUES ($1, $2, 'student')`,
          [user.orgId, studentId],
        );
        await client.query(
          `INSERT INTO identity.profiles
             (org_id, user_id, date_of_birth, gender, phone, address, blood_group,
              guardian_name, guardian_email, guardian_phone, guardian_relationship)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
          [
            user.orgId, studentId, item.dateOfBirth, item.gender, item.phone, item.address,
            item.bloodGroup, item.guardianName, item.guardianEmail, item.guardianPhone,
            item.guardianRelationship,
          ],
        );
        const enrollment = await client.query(
          `INSERT INTO academic.enrollments
             (org_id, student_user_id, section_id, admission_no, academic_year)
           VALUES ($1, $2, $3, $4, $5)`,
          [user.orgId, studentId, current.section.id, item.admissionNo, academicYear],
        );
        if (!enrollment.rowCount) throw new Error("Admission enrollment was not created.");
        created.push({
          id: studentId,
          name: item.name,
          email: item.email,
          admissionNo: item.admissionNo,
          sectionId: current.section.id,
          sectionName: current.section.name,
          academicYear,
          temporaryPassword: credential.temporaryPassword,
          temporaryPasswordExpiresAt: expiresAt.toISOString(),
        });
      }
      return { kind: "created" as const, items: created };
    });

    if (result.kind === "section_not_found") {
      return void res.status(404).json(errorBody("NOT_FOUND", "Section not found."));
    }
    if (result.kind === "invalid") {
      return void res.status(409).json({
        error: { code: "CONFLICT", message: "The section or student data changed after preview. Review the errors and try again.", details: result.errors },
      });
    }
    res.status(201).json({ items: result.items, total: result.items.length });
  } catch (error: any) {
    if (error?.code === "23505") {
      return void res.status(409).json(errorBody("CONFLICT", "An email or admission number was claimed by another request. Preview the batch again."));
    }
    next(error);
  }
});

router.patch("/academic/enrollments/:enrollmentId", requireAuth, async (req, res, next) => {
  const user = req.campusUser;
  if (!user) return void res.status(401).json(errorBody("UNAUTHENTICATED", "Sign in to continue."));
  if (!canManageAcademicSetup(user.roles)) {
    return void res.status(403).json(errorBody("FORBIDDEN", "Only administrators can change enrollment years."));
  }
  const params = UpdateEnrollmentYearParams.safeParse(req.params);
  const body = UpdateEnrollmentYearBody.safeParse(req.body);
  const academicYear = body.success ? body.data.academicYear.trim() : "";
  if (!params.success || !body.success || academicYear.length < 4) {
    return void res.status(400).json(errorBody("INVALID_REQUEST", "Provide a valid enrollment ID and academic year."));
  }

  try {
    const updated = await withOrg(user.orgId, async (client) => {
      const result = await client.query(
        `UPDATE academic.enrollments
            SET academic_year = $3
          WHERE org_id = $1 AND id = $2
          RETURNING id, student_user_id, admission_no, section_id, status, academic_year`,
        [user.orgId, params.data.enrollmentId, academicYear],
      );
      if (!result.rowCount) return null;
      const enrollment = result.rows[0];
      const student = await client.query(
        `SELECT u.name, s.name AS section_name
           FROM identity.users u
           JOIN academic.sections s ON s.org_id = u.org_id
          WHERE u.org_id = $1 AND u.id = $2 AND s.id = $3`,
        [user.orgId, enrollment.student_user_id, enrollment.section_id],
      );
      if (!student.rowCount) return null;
      return {
        id: enrollment.student_user_id,
        enrollmentId: enrollment.id,
        name: student.rows[0].name,
        admissionNo: enrollment.admission_no,
        sectionId: enrollment.section_id,
        sectionName: student.rows[0].section_name,
        status: enrollment.status,
        academicYear: enrollment.academic_year,
      };
    });
    if (!updated) return void res.status(404).json(errorBody("NOT_FOUND", "Enrollment not found."));
    res.json(updated);
  } catch (error: any) {
    if (error?.code === "23505") {
      return void res.status(409).json(errorBody("CONFLICT", "That student already has an enrollment for this academic year."));
    }
    next(error);
  }
});

router.get("/academic/consents/review-status", requireAuth, async (req, res, next) => {
  const user = req.campusUser;
  if (!user) return void res.status(401).json(errorBody("UNAUTHENTICATED", "Sign in to continue."));
  if (!user.roles.includes("parent")) {
    return void res.status(403).json(errorBody("FORBIDDEN", "Only a guardian can review consent choices."));
  }

  try {
    const result = await withOrg(user.orgId, (client) =>
      client.query<{ required: boolean; reviewed_at: Date | null }>(
        `SELECT EXISTS (
           SELECT 1 FROM identity.guardian_links
            WHERE org_id = $1 AND guardian_user_id = $2
         ) AS required,
         (SELECT reviewed_at FROM academic.guardian_consent_reviews
           WHERE org_id = $1 AND guardian_user_id = $2) AS reviewed_at`,
        [user.orgId, user.id],
      ),
    );
    const row = result.rows[0];
    res.json({ required: row?.required ?? false, reviewedAt: row?.reviewed_at?.toISOString() ?? null });
  } catch (error) {
    next(error);
  }
});

router.post("/academic/consents/review", requireAuth, async (req, res, next) => {
  const user = req.campusUser;
  if (!user) return void res.status(401).json(errorBody("UNAUTHENTICATED", "Sign in to continue."));
  if (!user.roles.includes("parent")) {
    return void res.status(403).json(errorBody("FORBIDDEN", "Only a guardian can review consent choices."));
  }

  try {
    const result = await withOrg(user.orgId, async (client) => {
      const saved = await client.query<{ reviewed_at: Date }>(
        `INSERT INTO academic.guardian_consent_reviews (org_id, guardian_user_id)
         VALUES ($1, $2)
         ON CONFLICT (org_id, guardian_user_id)
         DO UPDATE SET reviewed_at = now()
         RETURNING reviewed_at`,
        [user.orgId, user.id],
      );
      const linked = await client.query(
        `SELECT 1 FROM identity.guardian_links
          WHERE org_id = $1 AND guardian_user_id = $2
          LIMIT 1`,
        [user.orgId, user.id],
      );
      return { required: Boolean(linked.rowCount), reviewedAt: saved.rows[0]?.reviewed_at ?? null };
    });
    res.json({ required: result.required, reviewedAt: result.reviewedAt?.toISOString() ?? null });
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
  if (unavailableConsentPurposes.has(parsed.data.purpose)) {
    return void res.status(409).json(errorBody("FEATURE_UNAVAILABLE", "Recording and photo features are not enabled."));
  }

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
