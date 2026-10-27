import type { FastifyPluginAsync } from "fastify";
import type { PoolClient } from "pg";
import {
  CreateStudentAdmissionsBody,
  CreateEnrollmentBody,
  GetAvailableStudentsQueryParams,
  GetGuardianLinksQueryParams,
  GetStudentEnrollmentHistoryParams,
  GetStudentProfileParams,
  GetStudentsQueryParams,
  GraduateStudentEnrollmentBody,
  GrantConsentBody,
  RevokeConsentParams,
  UpdateGuardianLinkFlagsBody,
  UpdateGuardianLinkFlagsParams,
  UpdateEnrollmentYearBody,
  UpdateEnrollmentYearParams,
  UpdateSectionBody,
  UpdateSectionParams,
  UpdateStudentProfileBody,
  UpdateStudentProfileParams,
  PreviewStudentAdmissionsBody,
  PromoteStudentsBody,
  TransferStudentEnrollmentBody,
  PreviewEnrollmentTransferBody,
  CommitEnrollmentTransferBody,
  PreviewEnrollmentPromotionBody,
  CommitEnrollmentPromotionBody,
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

type EnrollmentMoveInput =
  | { kind: "transfer"; studentId: string; sourceAcademicYear: string; targetSectionId: string; targetAcademicYear: string }
  | { kind: "promotion"; sourceClassId: string; sourceAcademicYear: string; targetAcademicYear: string; sectionMap: { sourceSectionId: string; targetSectionId: string }[] };

type EnrollmentMoveItem = {
  enrollmentId: string;
  studentId: string;
  studentName: string;
  admissionNo: string;
  sourceSectionId: string;
  sourceSectionName: string;
  targetSectionId: string;
  targetSectionName: string;
  sourceAcademicYear: string;
  targetAcademicYear: string;
  eligible: boolean;
  conflicts: string[];
};

async function inspectEnrollmentMove(client: PoolClient, orgId: string, input: EnrollmentMoveInput, lock = false) {
  let sourceClassId: string | null = null;
  let sourceGrade: number | null = null;
  if (input.kind === "promotion") {
    const source = await client.query<{ id: string; grade_level: number }>(
      `SELECT id, grade_level FROM academic.classes WHERE org_id = $1 AND id = $2`,
      [orgId, input.sourceClassId],
    );
    if (!source.rows[0]) return { kind: "source_not_found" as const };
    sourceClassId = source.rows[0].id;
    sourceGrade = source.rows[0].grade_level;
  }

  const candidatesResult = input.kind === "transfer"
    ? await client.query<{
      enrollment_id: string; student_id: string; student_name: string; admission_no: string;
      source_section_id: string; source_section_name: string;
    }>(
      `SELECT e.id AS enrollment_id, u.id AS student_id, u.name AS student_name, e.admission_no,
              s.id AS source_section_id, s.name AS source_section_name
         FROM academic.enrollments e
         JOIN academic.sections s ON s.org_id = e.org_id AND s.id = e.section_id
         JOIN identity.users u ON u.org_id = e.org_id AND u.id = e.student_user_id
        WHERE e.org_id = $1 AND e.student_user_id = $2 AND e.academic_year = $3
          AND e.status = 'active'
        ${lock ? "FOR UPDATE OF e" : ""}`,
      [orgId, input.studentId, input.sourceAcademicYear],
    )
    : await client.query<{
      enrollment_id: string; student_id: string; student_name: string; admission_no: string;
      source_section_id: string; source_section_name: string;
    }>(
      `SELECT e.id AS enrollment_id, u.id AS student_id, u.name AS student_name, e.admission_no,
              s.id AS source_section_id, s.name AS source_section_name
         FROM academic.enrollments e
         JOIN academic.sections s ON s.org_id = e.org_id AND s.id = e.section_id
         JOIN identity.users u ON u.org_id = e.org_id AND u.id = e.student_user_id
        WHERE e.org_id = $1 AND s.class_id = $2 AND e.academic_year = $3
          AND e.status = 'active'
        ORDER BY s.name, u.name
        ${lock ? "FOR UPDATE OF e" : ""}`,
      [orgId, sourceClassId, input.sourceAcademicYear],
    );

  if (input.kind === "transfer" && !candidatesResult.rows.length) return { kind: "student_not_found" as const };
  if (input.kind === "promotion" && input.targetAcademicYear === input.sourceAcademicYear) {
    return { kind: "invalid_year" as const };
  }
  const sourceSectionIds = [...new Set(candidatesResult.rows.map((candidate) => candidate.source_section_id))];
  const mapping = input.kind === "transfer"
    ? new Map([[sourceSectionIds[0] ?? "", input.targetSectionId]])
    : new Map(input.sectionMap.map((entry) => [entry.sourceSectionId, entry.targetSectionId]));
  const targetIds = [...new Set(mapping.values())];
  const targets = targetIds.length
    ? await client.query<{ id: string; name: string; class_id: string; capacity: number | null; grade_level: number }>(
      `SELECT s.id, s.name, s.class_id, s.capacity, c.grade_level
         FROM academic.sections s
         JOIN academic.classes c ON c.org_id = s.org_id AND c.id = s.class_id
        WHERE s.org_id = $1 AND s.id = ANY($2::uuid[])
        ORDER BY s.id${lock ? " FOR UPDATE OF s" : ""}`,
      [orgId, targetIds],
    )
    : { rows: [] as { id: string; name: string; class_id: string; capacity: number | null; grade_level: number }[] };
  if (targets.rows.length !== targetIds.length) return { kind: "target_not_found" as const };
  const targetById = new Map(targets.rows.map((target) => [target.id, target]));
  const counts = new Map<string, number>();
  for (const targetId of targetIds) {
    const occupancy = await client.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM academic.enrollments
        WHERE org_id = $1 AND section_id = $2 AND status = 'active'`,
      [orgId, targetId],
    );
    counts.set(targetId, occupancy.rows[0]?.count ?? 0);
  }

  const items: EnrollmentMoveItem[] = [];
  for (const candidate of candidatesResult.rows) {
    const targetSectionId = mapping.get(candidate.source_section_id) ?? "";
    const target = targetById.get(targetSectionId);
    const conflicts: string[] = [];
    if (!target) conflicts.push("Choose a valid destination section for this student.");
    if (target && input.kind === "promotion" && target.grade_level <= (sourceGrade ?? target.grade_level)) {
      conflicts.push("Promotion destination must be a higher grade.");
    }
    if (target && target.id === candidate.source_section_id && input.targetAcademicYear === input.sourceAcademicYear) {
      conflicts.push("Student is already enrolled in this section for this year.");
    }
    if (target) {
      const duplicate = await client.query(
        `SELECT 1 FROM academic.enrollments
          WHERE org_id = $1 AND student_user_id = $2 AND academic_year = $3 AND status = 'active'
            AND id <> $4
          LIMIT 1`,
        [orgId, candidate.student_id, input.targetAcademicYear, candidate.enrollment_id],
      );
      if (duplicate.rowCount) conflicts.push("Student already has an active enrollment for the destination year.");
      const duplicateAdmission = await client.query(
        `SELECT 1 FROM academic.enrollments
          WHERE org_id = $1 AND admission_no = $2 AND academic_year = $3 AND status = 'active'
            AND id <> $4
          LIMIT 1`,
        [orgId, candidate.admission_no, input.targetAcademicYear, candidate.enrollment_id],
      );
      if (duplicateAdmission.rowCount) conflicts.push("Admission number is already active for the destination year.");
      const used = counts.get(target.id) ?? 0;
      if (target.capacity != null && used >= target.capacity) {
        conflicts.push(`Destination section capacity (${target.capacity}) would be exceeded.`);
      }
      if (!conflicts.length) counts.set(target.id, used + 1);
    }
    items.push({
      enrollmentId: candidate.enrollment_id,
      studentId: candidate.student_id,
      studentName: candidate.student_name,
      admissionNo: candidate.admission_no,
      sourceSectionId: candidate.source_section_id,
      sourceSectionName: candidate.source_section_name,
      targetSectionId,
      targetSectionName: target?.name ?? "Unavailable section",
      sourceAcademicYear: input.sourceAcademicYear,
      targetAcademicYear: input.targetAcademicYear,
      eligible: conflicts.length === 0,
      conflicts,
    });
  }
  return { kind: "ok" as const, items };
}

function movePreview(items: EnrollmentMoveItem[]) {
  return {
    total: items.length,
    eligibleCount: items.filter((item) => item.eligible).length,
    conflictCount: items.filter((item) => !item.eligible).length,
    items: items.map(({ enrollmentId: _enrollmentId, ...item }) => item),
  };
}

async function executeEnrollmentMove(client: PoolClient, orgId: string, input: EnrollmentMoveInput) {
  const inspection = await inspectEnrollmentMove(client, orgId, input, true);
  if (inspection.kind !== "ok") return inspection;
  const items: { studentId: string; studentName: string; succeeded: boolean; message: string; enrollmentId?: string }[] = [];
  for (const [index, item] of inspection.items.entries()) {
    if (!item.eligible) {
      items.push({ studentId: item.studentId, studentName: item.studentName, succeeded: false, message: item.conflicts.join(" ") });
      continue;
    }
    const savepoint = `move_student_${index}`;
    await client.query(`SAVEPOINT ${savepoint}`);
    try {
      await client.query(
        `UPDATE academic.enrollments
            SET status = 'disabled', ended_at = now(), ended_reason = $3
          WHERE org_id = $1 AND id = $2 AND status = 'active'`,
        [orgId, item.enrollmentId, input.kind === "transfer" ? "transferred" : "promoted"],
      );
      const created = await client.query<{ id: string }>(
        `INSERT INTO academic.enrollments (org_id, student_user_id, section_id, admission_no, academic_year)
         VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [orgId, item.studentId, item.targetSectionId, item.admissionNo, item.targetAcademicYear],
      );
      await client.query(`RELEASE SAVEPOINT ${savepoint}`);
      items.push({
        studentId: item.studentId,
        studentName: item.studentName,
        succeeded: true,
        message: "Enrollment moved successfully.",
        enrollmentId: created.rows[0]!.id,
      });
    } catch (error: any) {
      await client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
      await client.query(`RELEASE SAVEPOINT ${savepoint}`);
      items.push({
        studentId: item.studentId,
        studentName: item.studentName,
        succeeded: false,
        message: error?.code === "23505"
          ? "An active enrollment or admission number now conflicts. Review the student and try again."
          : "This enrollment could not be moved. Review the student and retry.",
      });
    }
  }
  return {
    kind: "ok" as const,
    succeeded: items.filter((item) => item.succeeded).length,
    failed: items.filter((item) => !item.succeeded).length,
    items,
  };
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

router.post("/academic/enrollments/transfer", requireAuth, async (req, res, next) => {
  const user = req.campusUser;
  if (!user) return void res.status(401).json(errorBody("UNAUTHENTICATED", "Sign in to continue."));
  if (!canManageAcademicSetup(user.roles)) {
    return void res.status(403).json(errorBody("FORBIDDEN", "Only administrators can transfer students."));
  }
  const body = TransferStudentEnrollmentBody.safeParse(req.body);
  if (!body.success) {
    return void res.status(400).json(errorBody("INVALID_REQUEST", "Provide an active enrollment and target section."));
  }

  try {
    const result = await withOrg(user.orgId, async (client) => {
      const sourceSnapshot = await client.query<{
        id: string;
        student_user_id: string;
        section_id: string;
        admission_no: string;
        academic_year: string;
      }>(
        `SELECT id, student_user_id, section_id, admission_no, academic_year
           FROM academic.enrollments
          WHERE org_id = $1 AND id = $2 AND status = 'active'`,
        [user.orgId, body.data.enrollmentId],
      );
      const sourceRecord = sourceSnapshot.rows[0];
      if (!sourceRecord) return { kind: "enrollment_not_found" as const };
      if (sourceRecord.section_id === body.data.targetSectionId) return { kind: "same_section" as const };

      const sectionResult = await client.query<{
        id: string;
        class_id: string;
        name: string;
        capacity: number | null;
      }>(
        `SELECT id, class_id, name, capacity
           FROM academic.sections
          WHERE org_id = $1 AND id = ANY($2::uuid[])
          ORDER BY id
          FOR UPDATE`,
        [user.orgId, [sourceRecord.section_id, body.data.targetSectionId]],
      );
      const targetSection = sectionResult.rows.find((section) => section.id === body.data.targetSectionId);
      if (!targetSection || sectionResult.rowCount !== 2) return { kind: "section_not_found" as const };

      const sourceResult = await client.query<{
        id: string;
        student_user_id: string;
        section_id: string;
        admission_no: string;
        academic_year: string;
      }>(
        `SELECT id, student_user_id, section_id, admission_no, academic_year
           FROM academic.enrollments
          WHERE org_id = $1 AND id = $2 AND status = 'active'
          FOR UPDATE`,
        [user.orgId, body.data.enrollmentId],
      );
      const source = sourceResult.rows[0];
      if (!source || source.section_id !== sourceRecord.section_id) return { kind: "enrollment_not_found" as const };

      const occupancy = await client.query<{ count: number }>(
        `SELECT COUNT(*)::int AS count
           FROM academic.enrollments
          WHERE org_id = $1 AND section_id = $2 AND status = 'active'`,
        [user.orgId, targetSection.id],
      );
      const activeEnrollmentCount = occupancy.rows[0]?.count ?? 0;
      if (!sectionHasCapacity(targetSection.capacity, activeEnrollmentCount)) {
        return { kind: "section_full" as const, capacity: targetSection.capacity };
      }

      const ended = await client.query(
        `UPDATE academic.enrollments
            SET status = 'disabled', ended_at = now(), ended_reason = 'transferred'
          WHERE org_id = $1 AND id = $2 AND status = 'active'`,
        [user.orgId, source.id],
      );
      if (ended.rowCount !== 1) return { kind: "enrollment_not_found" as const };

      const created = await client.query<{ id: string }>(
        `INSERT INTO academic.enrollments
           (org_id, student_user_id, section_id, admission_no, academic_year)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id`,
        [user.orgId, source.student_user_id, targetSection.id, source.admission_no, source.academic_year],
      );
      const summary = await client.query(
        `SELECT u.id, e.id AS "enrollmentId", u.name,
                e.admission_no AS "admissionNo", s.id AS "sectionId",
                s.name AS "sectionName", e.status, e.academic_year AS "academicYear"
           FROM academic.enrollments e
           JOIN identity.users u ON u.org_id = e.org_id AND u.id = e.student_user_id
           JOIN academic.sections s ON s.org_id = e.org_id AND s.id = e.section_id
          WHERE e.org_id = $1 AND e.id = $2`,
        [user.orgId, created.rows[0]!.id],
      );
      return { kind: "transferred" as const, student: summary.rows[0] };
    });

    if (result.kind === "enrollment_not_found") {
      return void res.status(404).json(errorBody("NOT_FOUND", "Active enrollment not found."));
    }
    if (result.kind === "section_not_found") {
      return void res.status(404).json(errorBody("NOT_FOUND", "Target section not found."));
    }
    if (result.kind === "same_section") {
      return void res.status(409).json(errorBody("CONFLICT", "The student is already enrolled in that section."));
    }
    if (result.kind === "section_full") {
      return void res.status(409).json(errorBody("CONFLICT", `The target section has reached its capacity of ${result.capacity}.`));
    }
    res.json(result.student);
  } catch (error: any) {
    if (error?.code === "23505") {
      return void res.status(409).json(errorBody("CONFLICT", "This student already has an active enrollment for the academic year."));
    }
    next(error);
  }
});

router.post("/academic/enrollments/graduate", requireAuth, async (req, res, next) => {
  const user = req.campusUser;
  if (!user) return void res.status(401).json(errorBody("UNAUTHENTICATED", "Sign in to continue."));
  if (!canManageAcademicSetup(user.roles)) {
    return void res.status(403).json(errorBody("FORBIDDEN", "Only administrators can graduate students."));
  }
  const body = GraduateStudentEnrollmentBody.safeParse(req.body);
  if (!body.success) {
    return void res.status(400).json(errorBody("INVALID_REQUEST", "Provide an active enrollment to graduate."));
  }

  try {
    const result = await withOrg(user.orgId, async (client) => {
      const enrollmentResult = await client.query<{
        id: string;
        student_user_id: string;
        academic_year: string;
        class_name: string;
        grade_level: number;
      }>(
        `SELECT e.id, e.student_user_id, e.academic_year,
                c.name AS class_name, c.grade_level
           FROM academic.enrollments e
           JOIN academic.sections s ON s.org_id = e.org_id AND s.id = e.section_id
           JOIN academic.classes c ON c.org_id = s.org_id AND c.id = s.class_id
          WHERE e.org_id = $1 AND e.id = $2 AND e.status = 'active'
          FOR UPDATE OF e`,
        [user.orgId, body.data.enrollmentId],
      );
      const enrollment = enrollmentResult.rows[0];
      if (!enrollment) return { kind: "enrollment_not_found" as const };
      if (enrollment.grade_level !== 12) {
        return { kind: "not_final_grade" as const, gradeLevel: enrollment.grade_level };
      }

      const ended = await client.query<{ ended_at: Date }>(
        `UPDATE academic.enrollments
            SET status = 'disabled', ended_at = now(), ended_reason = 'graduated'
          WHERE org_id = $1 AND id = $2 AND status = 'active'
          RETURNING ended_at`,
        [user.orgId, enrollment.id],
      );
      if (ended.rowCount !== 1) return { kind: "enrollment_not_found" as const };

      return {
        kind: "graduated" as const,
        studentId: enrollment.student_user_id,
        enrollmentId: enrollment.id,
        academicYear: enrollment.academic_year,
        className: enrollment.class_name,
        gradeLevel: enrollment.grade_level,
        endedAt: ended.rows[0]!.ended_at,
      };
    });

    if (result.kind === "enrollment_not_found") {
      return void res.status(404).json(errorBody("NOT_FOUND", "Active enrollment not found."));
    }
    if (result.kind === "not_final_grade") {
      return void res.status(409).json(errorBody("CONFLICT", "Students can only graduate from Grade 12."));
    }
    res.json({
      studentId: result.studentId,
      enrollmentId: result.enrollmentId,
      academicYear: result.academicYear,
      className: result.className,
      gradeLevel: result.gradeLevel,
      endedAt: result.endedAt,
      endedReason: "graduated",
    });
  } catch (error) {
    next(error);
  }
});

router.post("/academic/enrollments/promote", requireAuth, async (req, res, next) => {
  const user = req.campusUser;
  if (!user) return void res.status(401).json(errorBody("UNAUTHENTICATED", "Sign in to continue."));
  if (!canManageAcademicSetup(user.roles)) {
    return void res.status(403).json(errorBody("FORBIDDEN", "Only administrators can promote students."));
  }
  const body = PromoteStudentsBody.safeParse(req.body);
  if (!body.success) {
    return void res.status(400).json(errorBody("INVALID_REQUEST", "Provide valid classes, academic years, and section mappings."));
  }
  const input = body.data;
  const fromAcademicYear = input.fromAcademicYear.trim();
  const toAcademicYear = input.toAcademicYear.trim();
  if (input.fromClassId === input.toClassId || fromAcademicYear.length < 4 || toAcademicYear.length < 4
    || fromAcademicYear === toAcademicYear) {
    return void res.status(400).json(errorBody("INVALID_REQUEST", "Choose different classes and academic years."));
  }

  try {
    const result = await withOrg(user.orgId, async (client) => {
      const classResult = await client.query<{ id: string }>(
        `SELECT id
           FROM academic.classes
          WHERE org_id = $1 AND id = ANY($2::uuid[])
          ORDER BY id
          FOR UPDATE`,
        [user.orgId, [input.fromClassId, input.toClassId]],
      );
      if (classResult.rowCount !== 2) return { kind: "class_not_found" as const };

      const sectionResult = await client.query<{
        id: string;
        class_id: string;
        name: string;
        capacity: number | null;
      }>(
        `SELECT id, class_id, name, capacity
           FROM academic.sections
          WHERE org_id = $1 AND class_id = ANY($2::uuid[])
          ORDER BY id
          FOR UPDATE`,
        [user.orgId, [input.fromClassId, input.toClassId]],
      );
      const sourceSections = sectionResult.rows.filter((section) => section.class_id === input.fromClassId);
      const targetSections = sectionResult.rows.filter((section) => section.class_id === input.toClassId);
      if (!sourceSections.length || !targetSections.length) return { kind: "sections_missing" as const };

      const sourceSectionIds = new Set(sourceSections.map((section) => section.id));
      const targetSectionsById = new Map(targetSections.map((section) => [section.id, section]));
      const sectionMap = input.sectionMap;
      if (sourceSections.some((section) => !targetSectionsById.has(sectionMap[section.id]))
        || Object.keys(sectionMap).some((sectionId) => !sourceSectionIds.has(sectionId))) {
        return { kind: "invalid_mapping" as const };
      }

      const enrollments = await client.query<{
        id: string;
        student_user_id: string;
        section_id: string;
        admission_no: string;
      }>(
        `SELECT e.id, e.student_user_id, e.section_id, e.admission_no
           FROM academic.enrollments e
           JOIN academic.sections s ON s.org_id = e.org_id AND s.id = e.section_id
          WHERE e.org_id = $1 AND s.class_id = $2
            AND e.academic_year = $3 AND e.status = 'active'
          ORDER BY e.id
          FOR UPDATE OF e`,
        [user.orgId, input.fromClassId, fromAcademicYear],
      );
      if (!enrollments.rowCount) return { kind: "no_students" as const };

      const existingTargetYear = await client.query(
        `SELECT 1
           FROM academic.enrollments e
          WHERE e.org_id = $1 AND e.academic_year = $2
            AND e.student_user_id = ANY($3::uuid[])
          LIMIT 1`,
        [user.orgId, toAcademicYear, enrollments.rows.map((enrollment) => enrollment.student_user_id)],
      );
      if (existingTargetYear.rowCount) return { kind: "already_promoted" as const };

      const incomingBySection = new Map<string, number>();
      for (const enrollment of enrollments.rows) {
        const targetSectionId = sectionMap[enrollment.section_id]!;
        incomingBySection.set(targetSectionId, (incomingBySection.get(targetSectionId) ?? 0) + 1);
      }
      for (const [sectionId, incomingCount] of incomingBySection) {
        const target = targetSectionsById.get(sectionId)!;
        const occupancy = await client.query<{ count: number }>(
          `SELECT COUNT(*)::int AS count
             FROM academic.enrollments
            WHERE org_id = $1 AND section_id = $2 AND status = 'active'`,
          [user.orgId, sectionId],
        );
        const activeCount = occupancy.rows[0]?.count ?? 0;
        if (target.capacity !== null && activeCount + incomingCount > target.capacity) {
          return { kind: "section_full" as const, sectionName: target.name, capacity: target.capacity };
        }
      }

      const sourceIds = enrollments.rows.map((enrollment) => enrollment.id);
      const ended = await client.query(
        `UPDATE academic.enrollments
            SET status = 'disabled', ended_at = now(), ended_reason = 'promoted'
          WHERE org_id = $1 AND id = ANY($2::uuid[]) AND status = 'active'`,
        [user.orgId, sourceIds],
      );
      if (ended.rowCount !== enrollments.rowCount) return { kind: "enrollment_conflict" as const };

      const newEnrollmentIds: string[] = [];
      for (const enrollment of enrollments.rows) {
        const created = await client.query<{ id: string }>(
          `INSERT INTO academic.enrollments
             (org_id, student_user_id, section_id, admission_no, academic_year)
           VALUES ($1, $2, $3, $4, $5)
           RETURNING id`,
          [
            user.orgId,
            enrollment.student_user_id,
            sectionMap[enrollment.section_id],
            enrollment.admission_no,
            toAcademicYear,
          ],
        );
        newEnrollmentIds.push(created.rows[0]!.id);
      }

      const items = await client.query(
        `SELECT u.id, e.id AS "enrollmentId", u.name,
                e.admission_no AS "admissionNo", s.id AS "sectionId",
                s.name AS "sectionName", e.status, e.academic_year AS "academicYear"
           FROM academic.enrollments e
           JOIN identity.users u ON u.org_id = e.org_id AND u.id = e.student_user_id
           JOIN academic.sections s ON s.org_id = e.org_id AND s.id = e.section_id
          WHERE e.org_id = $1 AND e.id = ANY($2::uuid[])
          ORDER BY u.name, e.admission_no`,
        [user.orgId, newEnrollmentIds],
      );
      return { kind: "promoted" as const, promotedCount: items.rows.length, items: items.rows };
    });

    if (result.kind === "class_not_found") {
      return void res.status(404).json(errorBody("NOT_FOUND", "Source or target class not found."));
    }
    if (result.kind === "sections_missing") {
      return void res.status(400).json(errorBody("INVALID_REQUEST", "Both classes need at least one section."));
    }
    if (result.kind === "invalid_mapping") {
      return void res.status(400).json(errorBody("INVALID_REQUEST", "Map every source section to a section in the target class."));
    }
    if (result.kind === "no_students") {
      return void res.status(409).json(errorBody("CONFLICT", "No active students were found for that class and academic year."));
    }
    if (result.kind === "already_promoted") {
      return void res.status(409).json(errorBody("CONFLICT", "At least one student already has an enrollment in the target academic year."));
    }
    if (result.kind === "enrollment_conflict") {
      return void res.status(409).json(errorBody("CONFLICT", "The source enrollments changed before promotion could complete."));
    }
    if (result.kind === "section_full") {
      return void res.status(409).json(errorBody("CONFLICT", `Section ${result.sectionName} has reached its capacity of ${result.capacity}.`));
    }
    res.json({ promotedCount: result.promotedCount, items: result.items });
  } catch (error: any) {
    if (error?.code === "23505") {
      return void res.status(409).json(errorBody("CONFLICT", "A student enrollment already exists for the target year."));
    }
    next(error);
  }
});

router.post("/academic/enrollments/transfer/preview", requireAuth, async (req, res, next) => {
  const user = req.campusUser;
  if (!user) return void res.status(401).json(errorBody("UNAUTHENTICATED", "Sign in to continue."));
  if (!canManageAcademicSetup(user.roles)) {
    return void res.status(403).json(errorBody("FORBIDDEN", "Only administrators can transfer students."));
  }
  const parsed = PreviewEnrollmentTransferBody.safeParse(req.body);
  if (!parsed.success || parsed.data.sourceAcademicYear.trim().length < 4 || parsed.data.targetAcademicYear.trim().length < 4) {
    return void res.status(400).json(errorBody("INVALID_REQUEST", "Provide a student, source year, destination section, and destination year."));
  }
  const input: EnrollmentMoveInput = {
    kind: "transfer",
    ...parsed.data,
    sourceAcademicYear: parsed.data.sourceAcademicYear.trim(),
    targetAcademicYear: parsed.data.targetAcademicYear.trim(),
  };
  try {
    const result = await withOrg(user.orgId, (client) => inspectEnrollmentMove(client, user.orgId, input));
    if (result.kind === "student_not_found") return void res.status(404).json(errorBody("NOT_FOUND", "Active source enrollment not found."));
    if (result.kind !== "ok") return void res.status(404).json(errorBody("NOT_FOUND", "Student or destination section not found."));
    res.json(movePreview(result.items));
  } catch (error) {
    next(error);
  }
});

router.post("/academic/enrollments/transfer/commit", requireAuth, async (req, res, next) => {
  const user = req.campusUser;
  if (!user) return void res.status(401).json(errorBody("UNAUTHENTICATED", "Sign in to continue."));
  if (!canManageAcademicSetup(user.roles)) {
    return void res.status(403).json(errorBody("FORBIDDEN", "Only administrators can transfer students."));
  }
  const parsed = CommitEnrollmentTransferBody.safeParse(req.body);
  if (!parsed.success || parsed.data.sourceAcademicYear.trim().length < 4 || parsed.data.targetAcademicYear.trim().length < 4) {
    return void res.status(400).json(errorBody("INVALID_REQUEST", "Provide a student, source year, destination section, and destination year."));
  }
  const input: EnrollmentMoveInput = {
    kind: "transfer",
    ...parsed.data,
    sourceAcademicYear: parsed.data.sourceAcademicYear.trim(),
    targetAcademicYear: parsed.data.targetAcademicYear.trim(),
  };
  try {
    const result = await withOrg(user.orgId, (client) => executeEnrollmentMove(client, user.orgId, input));
    if (result.kind === "student_not_found") return void res.status(404).json(errorBody("NOT_FOUND", "Active source enrollment not found."));
    if (result.kind !== "ok") return void res.status(404).json(errorBody("NOT_FOUND", "Student or destination section not found."));
    res.json({ succeeded: result.succeeded, failed: result.failed, items: result.items });
  } catch (error) {
    next(error);
  }
});

router.post("/academic/enrollments/promote/preview", requireAuth, async (req, res, next) => {
  const user = req.campusUser;
  if (!user) return void res.status(401).json(errorBody("UNAUTHENTICATED", "Sign in to continue."));
  if (!canManageAcademicSetup(user.roles)) {
    return void res.status(403).json(errorBody("FORBIDDEN", "Only administrators can promote a class cohort."));
  }
  const parsed = PreviewEnrollmentPromotionBody.safeParse(req.body);
  if (!parsed.success || parsed.data.sourceAcademicYear.trim().length < 4 || parsed.data.targetAcademicYear.trim().length < 4 || parsed.data.sectionMap.some((entry, index, entries) =>
    entries.findIndex((candidate) => candidate.sourceSectionId === entry.sourceSectionId) !== index)) {
    return void res.status(400).json(errorBody("INVALID_REQUEST", "Provide a source class, academic years, and one destination mapping per section."));
  }
  const input: EnrollmentMoveInput = {
    kind: "promotion",
    ...parsed.data,
    sourceAcademicYear: parsed.data.sourceAcademicYear.trim(),
    targetAcademicYear: parsed.data.targetAcademicYear.trim(),
  };
  try {
    const result = await withOrg(user.orgId, (client) => inspectEnrollmentMove(client, user.orgId, input));
    if (result.kind === "source_not_found") return void res.status(404).json(errorBody("NOT_FOUND", "Source class not found."));
    if (result.kind === "invalid_year") return void res.status(400).json(errorBody("INVALID_REQUEST", "Promotion must use a different academic year."));
    if (result.kind !== "ok") return void res.status(404).json(errorBody("NOT_FOUND", "Source class or mapped section not found."));
    res.json(movePreview(result.items));
  } catch (error) {
    next(error);
  }
});

router.post("/academic/enrollments/promote/commit", requireAuth, async (req, res, next) => {
  const user = req.campusUser;
  if (!user) return void res.status(401).json(errorBody("UNAUTHENTICATED", "Sign in to continue."));
  if (!canManageAcademicSetup(user.roles)) {
    return void res.status(403).json(errorBody("FORBIDDEN", "Only administrators can promote a class cohort."));
  }
  const parsed = CommitEnrollmentPromotionBody.safeParse(req.body);
  if (!parsed.success || parsed.data.sourceAcademicYear.trim().length < 4 || parsed.data.targetAcademicYear.trim().length < 4 || parsed.data.sectionMap.some((entry, index, entries) =>
    entries.findIndex((candidate) => candidate.sourceSectionId === entry.sourceSectionId) !== index)) {
    return void res.status(400).json(errorBody("INVALID_REQUEST", "Provide a source class, academic years, and one destination mapping per section."));
  }
  const input: EnrollmentMoveInput = {
    kind: "promotion",
    ...parsed.data,
    sourceAcademicYear: parsed.data.sourceAcademicYear.trim(),
    targetAcademicYear: parsed.data.targetAcademicYear.trim(),
  };
  try {
    const result = await withOrg(user.orgId, (client) => executeEnrollmentMove(client, user.orgId, input));
    if (result.kind === "source_not_found") return void res.status(404).json(errorBody("NOT_FOUND", "Source class not found."));
    if (result.kind === "invalid_year") return void res.status(400).json(errorBody("INVALID_REQUEST", "Promotion must use a different academic year."));
    if (result.kind !== "ok") return void res.status(404).json(errorBody("NOT_FOUND", "Source class or mapped section not found."));
    res.json({ succeeded: result.succeeded, failed: result.failed, items: result.items });
  } catch (error) {
    next(error);
  }
});

router.get("/academic/students", requireAuth, async (req, res, next) => {
  const user = req.campusUser;
  if (!user) return void res.status(401).json(errorBody("UNAUTHENTICATED", "Sign in to continue."));
  const parsed = GetStudentsQueryParams.safeParse(req.query);
  if (!parsed.success) {
    return void res.status(400).json(errorBody("INVALID_REQUEST", "Provide valid registry filters and pagination."));
  }
  const { sectionId, classId, q, limit = 50, offset = 0 } = parsed.data;
  const flags = roleFlags(user.roles);
  const maySeeRoster = flags.isAdmin || flags.isTeacher || flags.isStudent || flags.isParent;

  if (!maySeeRoster) return void res.status(403).json(errorBody("FORBIDDEN", "You cannot view this roster."));
  if (!flags.isAdmin && !sectionId) {
    return void res.status(400).json(errorBody("INVALID_REQUEST", "A sectionId is required for this roster."));
  }
  if (!flags.isAdmin && classId) {
    return void res.status(403).json(errorBody("FORBIDDEN", "Only administrators can search across classes."));
  }

  try {
    const result = await withOrg(user.orgId, async (client) => {
      const currentEnrollments = `WITH current_enrollments AS (
        SELECT DISTINCT ON (e.org_id, e.student_user_id) e.*
          FROM academic.enrollments e
         WHERE e.org_id = $1 AND e.status = 'active'
         ORDER BY e.org_id, e.student_user_id, e.academic_year DESC, e.created_at DESC, e.id DESC
      )`;
      const where = `e.org_id = $1
        AND ($2::uuid IS NULL OR e.section_id = $2)
        AND ($3::uuid IS NULL OR c.id = $3)
        AND (
          $4::boolean
          OR ($5::boolean AND (
            EXISTS (
              SELECT 1 FROM academic.section_teachers st
               WHERE st.org_id = e.org_id AND st.section_id = e.section_id
                 AND st.teacher_user_id = $7
            )
            OR EXISTS (
              SELECT 1 FROM academic.teacher_assignments ta
               WHERE ta.org_id = e.org_id AND ta.section_id = e.section_id
                 AND ta.teacher_user_id = $7
            )
          ))
          OR ($6::boolean AND u.id = $7)
          OR ($8::boolean AND EXISTS (
            SELECT 1 FROM identity.guardian_links gl
             WHERE gl.org_id = e.org_id AND gl.student_user_id = u.id
               AND gl.guardian_user_id = $7
          ))
        )
        AND (
          $9::text IS NULL
          OR u.name ILIKE '%' || $9 || '%'
          OR e.admission_no ILIKE '%' || $9 || '%'
          OR ($4::boolean AND (
            u.email ILIKE '%' || $9 || '%'
            OR EXISTS (
              SELECT 1 FROM identity.profiles profile
               WHERE profile.org_id = e.org_id AND profile.user_id = u.id
                 AND (
                    profile.phone ILIKE '%' || $9 || '%'
                    OR profile.guardian_name ILIKE '%' || $9 || '%'
                    OR profile.guardian_email ILIKE '%' || $9 || '%'
                    OR profile.guardian_phone ILIKE '%' || $9 || '%'
                 )
            )
          ))
        )`;
      const queryParams = [
        user.orgId,
        sectionId ?? null,
        classId ?? null,
        flags.isAdmin,
        flags.isTeacher,
        flags.isStudent,
        user.id,
        flags.isParent,
        q ?? null,
      ];
      const count = await client.query<{ total: string }>(
        `${currentEnrollments}
         SELECT COUNT(*)::text AS total
           FROM current_enrollments e
           JOIN academic.sections s ON s.id = e.section_id AND s.org_id = e.org_id
           JOIN academic.classes c ON c.id = s.class_id AND c.org_id = s.org_id
           JOIN identity.users u ON u.id = e.student_user_id AND u.org_id = e.org_id
          WHERE ${where}`,
        queryParams,
      );
      const rows = await client.query(
        `${currentEnrollments}
         SELECT u.id, e.id AS enrollment_id, u.name, e.admission_no, s.id AS section_id,
                s.name AS section_name, c.id AS class_id, c.name AS class_name,
                e.status, e.academic_year
           FROM current_enrollments e
           JOIN academic.sections s ON s.id = e.section_id AND s.org_id = e.org_id
           JOIN academic.classes c ON c.id = s.class_id AND c.org_id = s.org_id
           JOIN identity.users u ON u.id = e.student_user_id AND u.org_id = e.org_id
          WHERE ${where}
           ORDER BY u.name, u.id
           LIMIT $10 OFFSET $11`,
        [...queryParams, limit, offset],
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
        classId: row.class_id,
        className: row.class_name,
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

async function readStudentProfile(client: PoolClient, orgId: string, studentId: string) {
  const result = await client.query<{
    id: string;
    name: string;
    email: string;
    status: "active" | "disabled";
    admission_no: string | null;
    academic_year: string | null;
    class_name: string | null;
    grade_level: number | null;
    section_name: string | null;
    enrollment_id: string | null;
    section_id: string | null;
    date_of_birth: string | null;
    gender: string | null;
    phone: string | null;
    address: string | null;
    blood_group: string | null;
    guardian_name: string | null;
    guardian_email: string | null;
    guardian_phone: string | null;
    guardian_relationship: string | null;
  }>(
    `SELECT u.id, u.name, u.email, u.status,
            enrollment.id AS enrollment_id, enrollment.section_id,
            enrollment.admission_no, enrollment.academic_year,
            enrollment.class_name, enrollment.grade_level, enrollment.section_name,
            p.date_of_birth::text AS date_of_birth, p.gender, p.phone, p.address, p.blood_group,
            p.guardian_name, p.guardian_email, p.guardian_phone, p.guardian_relationship
       FROM identity.users u
       LEFT JOIN identity.profiles p ON p.org_id = u.org_id AND p.user_id = u.id
       LEFT JOIN LATERAL (
          SELECT e.id, e.section_id, e.admission_no, e.academic_year,
                  c.name AS class_name, c.grade_level, s.name AS section_name
           FROM academic.enrollments e
           JOIN academic.sections s ON s.org_id = e.org_id AND s.id = e.section_id
           JOIN academic.classes c ON c.org_id = s.org_id AND c.id = s.class_id
          WHERE e.org_id = u.org_id AND e.student_user_id = u.id AND e.status = 'active'
          ORDER BY e.academic_year DESC, e.created_at DESC
          LIMIT 1
       ) enrollment ON true
      WHERE u.org_id = $1 AND u.id = $2
        AND EXISTS (
          SELECT 1 FROM identity.user_roles role
           WHERE role.org_id = u.org_id AND role.user_id = u.id AND role.role = 'student'
        )`,
    [orgId, studentId],
  );
  const row = result.rows[0];
  if (!row) return null;
  const historyResult = await client.query<{
    enrollment_id: string;
    admission_no: string;
    academic_year: string;
    class_name: string;
    section_name: string;
    status: "active" | "disabled";
  }>(
    `SELECT e.id AS enrollment_id, e.admission_no, e.academic_year,
            c.name AS class_name, s.name AS section_name, e.status
       FROM academic.enrollments e
       JOIN academic.sections s ON s.org_id = e.org_id AND s.id = e.section_id
       JOIN academic.classes c ON c.org_id = s.org_id AND c.id = s.class_id
      WHERE e.org_id = $1 AND e.student_user_id = $2
      ORDER BY e.academic_year DESC, e.created_at DESC, e.id`,
    [orgId, studentId],
  );
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    status: row.status,
    currentEnrollment: row.admission_no === null ? null : {
      enrollmentId: row.enrollment_id!,
      sectionId: row.section_id!,
      admissionNo: row.admission_no,
      academicYear: row.academic_year!,
      className: row.class_name!,
      gradeLevel: row.grade_level!,
      sectionName: row.section_name!,
    },
    enrollmentHistory: historyResult.rows.map((enrollment) => ({
      enrollmentId: enrollment.enrollment_id,
      admissionNo: enrollment.admission_no,
      academicYear: enrollment.academic_year,
      className: enrollment.class_name,
      sectionName: enrollment.section_name,
      status: enrollment.status,
    })),
    profile: {
      dateOfBirth: row.date_of_birth,
      gender: row.gender,
      phone: row.phone,
      address: row.address,
      bloodGroup: row.blood_group,
      guardianName: row.guardian_name,
      guardianEmail: row.guardian_email,
      guardianPhone: row.guardian_phone,
      guardianRelationship: row.guardian_relationship,
    },
  };
}

router.get("/academic/students/:studentId/profile", requireAuth, async (req, res, next) => {
  const user = req.campusUser;
  if (!user) return void res.status(401).json(errorBody("UNAUTHENTICATED", "Sign in to continue."));
  if (!canManageAcademicSetup(user.roles)) {
    return void res.status(403).json(errorBody("FORBIDDEN", "Only administrators can view student profiles."));
  }
  const params = GetStudentProfileParams.safeParse(req.params);
  if (!params.success) return void res.status(400).json(errorBody("INVALID_REQUEST", "Provide a valid student ID."));

  try {
    const profile = await withOrg(user.orgId, (client) =>
      readStudentProfile(client, user.orgId, params.data.studentId),
    );
    if (!profile) return void res.status(404).json(errorBody("NOT_FOUND", "Student not found."));
    res.json(profile);
  } catch (error) {
    next(error);
  }
});

router.get("/academic/students/:studentId/enrollments", requireAuth, async (req, res, next) => {
  const user = req.campusUser;
  if (!user) return void res.status(401).json(errorBody("UNAUTHENTICATED", "Sign in to continue."));
  if (!canManageAcademicSetup(user.roles)) {
    return void res.status(403).json(errorBody("FORBIDDEN", "Only administrators can view enrollment history."));
  }
  const params = GetStudentEnrollmentHistoryParams.safeParse(req.params);
  if (!params.success) return void res.status(400).json(errorBody("INVALID_REQUEST", "Provide a valid student ID."));

  try {
    const history = await withOrg(user.orgId, async (client) => {
      const student = await client.query(
        `SELECT u.id
           FROM identity.users u
          WHERE u.org_id = $1 AND u.id = $2
            AND EXISTS (
              SELECT 1 FROM identity.user_roles role
               WHERE role.org_id = u.org_id AND role.user_id = u.id AND role.role = 'student'
            )`,
        [user.orgId, params.data.studentId],
      );
      if (!student.rowCount) return null;
      const items = await client.query(
        `SELECT e.id, e.admission_no AS "admissionNo", e.academic_year AS "academicYear",
                c.name AS "className", s.name AS "sectionName", e.status,
                e.created_at AS "createdAt", e.ended_at AS "endedAt",
                e.ended_reason AS "endedReason"
           FROM academic.enrollments e
           JOIN academic.sections s ON s.org_id = e.org_id AND s.id = e.section_id
           JOIN academic.classes c ON c.org_id = s.org_id AND c.id = s.class_id
          WHERE e.org_id = $1 AND e.student_user_id = $2
          ORDER BY e.academic_year DESC, e.created_at DESC`,
        [user.orgId, params.data.studentId],
      );
      return { items: items.rows, total: items.rows.length };
    });
    if (!history) return void res.status(404).json(errorBody("NOT_FOUND", "Student not found."));
    res.json(history);
  } catch (error) {
    next(error);
  }
});

router.put("/academic/students/:studentId/profile", requireAuth, async (req, res, next) => {
  const user = req.campusUser;
  if (!user) return void res.status(401).json(errorBody("UNAUTHENTICATED", "Sign in to continue."));
  if (!canManageAcademicSetup(user.roles)) {
    return void res.status(403).json(errorBody("FORBIDDEN", "Only administrators can update student profiles."));
  }
  const params = UpdateStudentProfileParams.safeParse(req.params);
  const parsed = UpdateStudentProfileBody.safeParse(req.body);
  if (!params.success || !parsed.success) {
    return void res.status(400).json(errorBody("INVALID_REQUEST", "Provide valid student profile fields."));
  }

  const clean = (value: string | null) => value?.trim() || null;
  const profile = {
    dateOfBirth: clean(parsed.data.dateOfBirth),
    gender: clean(parsed.data.gender),
    phone: clean(parsed.data.phone),
    address: clean(parsed.data.address),
    bloodGroup: clean(parsed.data.bloodGroup),
    guardianName: clean(parsed.data.guardianName),
    guardianEmail: clean(parsed.data.guardianEmail)?.toLowerCase() ?? null,
    guardianPhone: clean(parsed.data.guardianPhone),
    guardianRelationship: clean(parsed.data.guardianRelationship),
  };
  if (profile.dateOfBirth) {
    const parsedDate = new Date(`${profile.dateOfBirth}T00:00:00.000Z`);
    if (Number.isNaN(parsedDate.getTime()) || parsedDate.toISOString().slice(0, 10) !== profile.dateOfBirth) {
      return void res.status(400).json(errorBody("INVALID_REQUEST", "Date of birth must be a real date in YYYY-MM-DD format."));
    }
  }
  const hasGuardianContact = !!(
    profile.guardianName || profile.guardianEmail || profile.guardianPhone || profile.guardianRelationship
  );
  if (hasGuardianContact && !profile.guardianName) {
    return void res.status(400).json(errorBody("INVALID_REQUEST", "Guardian name is required when contact details are provided."));
  }
  if (hasGuardianContact && !profile.guardianEmail && !profile.guardianPhone) {
    return void res.status(400).json(errorBody("INVALID_REQUEST", "Provide a guardian email or phone number."));
  }

  try {
    const updated = await withOrg(user.orgId, async (client) => {
      const student = await client.query(
        `SELECT u.id
           FROM identity.users u
          WHERE u.org_id = $1 AND u.id = $2
            AND EXISTS (
              SELECT 1 FROM identity.user_roles role
               WHERE role.org_id = u.org_id AND role.user_id = u.id AND role.role = 'student'
            )`,
        [user.orgId, params.data.studentId],
      );
      if (!student.rowCount) return null;
      await client.query(
        `INSERT INTO identity.profiles
           (org_id, user_id, date_of_birth, gender, phone, address, blood_group,
            guardian_name, guardian_email, guardian_phone, guardian_relationship, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, now())
         ON CONFLICT (org_id, user_id) DO UPDATE
           SET date_of_birth = EXCLUDED.date_of_birth,
               gender = EXCLUDED.gender,
               phone = EXCLUDED.phone,
               address = EXCLUDED.address,
               blood_group = EXCLUDED.blood_group,
               guardian_name = EXCLUDED.guardian_name,
               guardian_email = EXCLUDED.guardian_email,
               guardian_phone = EXCLUDED.guardian_phone,
               guardian_relationship = EXCLUDED.guardian_relationship,
               updated_at = now()`,
        [
          user.orgId, params.data.studentId, profile.dateOfBirth, profile.gender, profile.phone,
          profile.address, profile.bloodGroup, profile.guardianName, profile.guardianEmail,
          profile.guardianPhone, profile.guardianRelationship,
        ],
      );
      return readStudentProfile(client, user.orgId, params.data.studentId);
    });
    if (!updated) return void res.status(404).json(errorBody("NOT_FOUND", "Student not found."));
    res.json(updated);
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
