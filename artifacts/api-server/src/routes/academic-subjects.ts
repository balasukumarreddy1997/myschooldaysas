import type { FastifyPluginAsync } from "fastify";
import {
  CreateAcademicSubjectBody,
  CreateAcademicTeacherAssignmentBody,
  DeleteAcademicSubjectParams,
  DeleteAcademicTeacherAssignmentParams,
  GetAcademicTeacherAssignmentsQueryParams,
  UpdateAcademicSubjectBody,
  UpdateAcademicSubjectParams,
} from "@workspace/api-zod";
import { withOrg } from "@workspace/db";
import { createRouteRegistrar } from "../lib/fastify-routes";
import { requireAuth, type CampusRole } from "../lib/auth";

const adminRoles: CampusRole[] = ["super_admin", "org_admin", "campus_admin"];
const teacherRoles: CampusRole[] = ["teacher", "class_teacher", "hod"];
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const errorBody = (code: string, message: string) => ({ error: { code, message } });

const routes: FastifyPluginAsync = async (fastify) => {
  const router = createRouteRegistrar(fastify);

  router.get("/academic/subjects", requireAuth, async (req, res, next) => {
    const user = req.campusUser;
    if (!user) return void res.status(401).json(errorBody("UNAUTHENTICATED", "Sign in to continue."));
    try {
      const result = await withOrg(user.orgId, (client) =>
        client.query(
          `SELECT id, code, name, is_active
             FROM academic.subjects
            WHERE org_id=$1 AND ($2::boolean OR is_active=true)
            ORDER BY name, code`,
          [user.orgId, user.roles.some((role) => adminRoles.includes(role))],
        ),
      );
      res.json({
        items: result.rows.map((row: any) => ({ id: row.id, code: row.code, name: row.name, isActive: row.is_active })),
        total: result.rowCount ?? result.rows.length,
      });
    } catch (error) { next(error); }
  });

  router.post("/academic/subjects", requireAuth, async (req, res, next) => {
    const user = req.campusUser;
    if (!user) return void res.status(401).json(errorBody("UNAUTHENTICATED", "Sign in to continue."));
    if (!user.roles.some((role) => adminRoles.includes(role))) return void res.status(403).json(errorBody("FORBIDDEN", "Only administrators can manage subjects."));
    const parsed = CreateAcademicSubjectBody.safeParse(req.body);
    if (!parsed.success || !parsed.data.name.trim() || (parsed.data.code !== null && !parsed.data.code.trim())) {
      return void res.status(400).json(errorBody("INVALID_REQUEST", "Provide a valid subject name and code."));
    }
    try {
      const result = await withOrg(user.orgId, (client) =>
        client.query(
          `INSERT INTO academic.subjects (org_id, code, name)
           VALUES ($1,$2,$3)
           RETURNING id, code, name, is_active`,
          [user.orgId, parsed.data.code?.trim() || null, parsed.data.name.trim()],
        ),
      );
      const row = result.rows[0];
      res.status(201).json({ id: row.id, code: row.code, name: row.name, isActive: row.is_active });
    } catch (error: any) {
      if (error?.code === "23505") return void res.status(409).json(errorBody("CONFLICT", "A subject with that name or code already exists."));
      next(error);
    }
  });

  router.put("/academic/subjects/:subjectId", requireAuth, async (req, res, next) => {
    const user = req.campusUser;
    const params = UpdateAcademicSubjectParams.safeParse(req.params);
    if (!user) return void res.status(401).json(errorBody("UNAUTHENTICATED", "Sign in to continue."));
    if (!user.roles.some((role) => adminRoles.includes(role))) return void res.status(403).json(errorBody("FORBIDDEN", "Only administrators can manage subjects."));
    if (!params.success || !uuid.test(params.data.subjectId)) return void res.status(400).json(errorBody("INVALID_REQUEST", "Provide a valid subject ID."));
    const parsed = UpdateAcademicSubjectBody.safeParse(req.body);
    if (!parsed.success || Object.keys(parsed.data).length === 0 || (parsed.data.name !== undefined && !parsed.data.name.trim()) || (parsed.data.code != null && !parsed.data.code.trim())) {
      return void res.status(400).json(errorBody("INVALID_REQUEST", "Provide a valid subject update."));
    }
    try {
      const updated = await withOrg(user.orgId, (client) =>
        client.query(
          `UPDATE academic.subjects
              SET name=COALESCE($3,name), code=CASE WHEN $4::boolean THEN $5 ELSE code END,
                  is_active=COALESCE($6,is_active), updated_at=now()
            WHERE org_id=$1 AND id=$2
            RETURNING id, code, name, is_active`,
          [user.orgId, params.data.subjectId, parsed.data.name?.trim() ?? null,
            Object.hasOwn(parsed.data, "code"), parsed.data.code?.trim() || null, parsed.data.isActive ?? null],
        ),
      );
      if (!updated.rowCount) return void res.status(404).json(errorBody("NOT_FOUND", "Subject not found."));
      const row = updated.rows[0];
      res.json({ id: row.id, code: row.code, name: row.name, isActive: row.is_active });
    } catch (error: any) {
      if (error?.code === "23505") return void res.status(409).json(errorBody("CONFLICT", "A subject with that name or code already exists."));
      next(error);
    }
  });

  router.delete("/academic/subjects/:subjectId", requireAuth, async (req, res, next) => {
    const user = req.campusUser;
    const params = DeleteAcademicSubjectParams.safeParse(req.params);
    if (!user) return void res.status(401).json(errorBody("UNAUTHENTICATED", "Sign in to continue."));
    if (!user.roles.some((role) => adminRoles.includes(role))) return void res.status(403).json(errorBody("FORBIDDEN", "Only administrators can manage subjects."));
    if (!params.success) return void res.status(400).json(errorBody("INVALID_REQUEST", "Provide a valid subject ID."));
    try {
      const result = await withOrg(user.orgId, async (client) => {
        const used = await client.query(
          `SELECT 1 FROM learning.exams WHERE org_id=$1 AND subject_id=$2
           UNION ALL
           SELECT 1 FROM academic.teacher_assignments WHERE org_id=$1 AND subject_id=$2
           UNION ALL
           SELECT 1 FROM learning.report_card_remarks WHERE org_id=$1 AND subject_id=$2
           LIMIT 1`,
          [user.orgId, params.data.subjectId],
        );
        if (used.rowCount) return "used" as const;
        const removed = await client.query("DELETE FROM academic.subjects WHERE org_id=$1 AND id=$2", [user.orgId, params.data.subjectId]);
        return removed.rowCount ? "deleted" as const : "missing" as const;
      });
      if (result === "used") return void res.status(409).json(errorBody("CONFLICT", "Deactivate subjects that already have teaching or report records."));
      if (result === "missing") return void res.status(404).json(errorBody("NOT_FOUND", "Subject not found."));
      res.status(204).send();
    } catch (error) { next(error); }
  });

  router.get("/academic/teachers", requireAuth, async (req, res, next) => {
    const user = req.campusUser;
    if (!user) return void res.status(401).json(errorBody("UNAUTHENTICATED", "Sign in to continue."));
    if (!user.roles.some((role) => adminRoles.includes(role))) return void res.status(403).json(errorBody("FORBIDDEN", "Only administrators can manage teaching assignments."));
    try {
      const result = await withOrg(user.orgId, (client) =>
        client.query(
          `SELECT DISTINCT u.id, u.name, u.email
             FROM identity.users u
             JOIN identity.user_roles r ON r.org_id=u.org_id AND r.user_id=u.id
            WHERE u.org_id=$1 AND u.status='active' AND r.role=ANY($2::text[])
            ORDER BY u.name, u.email`,
          [user.orgId, teacherRoles],
        ),
      );
      res.json({ items: result.rows, total: result.rowCount ?? result.rows.length });
    } catch (error) { next(error); }
  });

  router.get("/academic/teacher-assignments", requireAuth, async (req, res, next) => {
    const user = req.campusUser;
    const query = GetAcademicTeacherAssignmentsQueryParams.safeParse(req.query);
    if (!user) return void res.status(401).json(errorBody("UNAUTHENTICATED", "Sign in to continue."));
    const isAdmin = user.roles.some((role) => adminRoles.includes(role));
    const isTeacher = user.roles.some((role) => teacherRoles.includes(role));
    if (!isAdmin && !isTeacher) return void res.status(403).json(errorBody("FORBIDDEN", "Teaching assignments are available to administrators and assigned teachers."));
    if (!query.success) return void res.status(400).json(errorBody("INVALID_REQUEST", "Provide a valid section filter."));
    try {
      const result = await withOrg(user.orgId, (client) =>
        client.query(
          `SELECT ta.id, ta.section_id, s.name AS section_name, ta.subject_id, sub.name AS subject_name,
                  ta.teacher_user_id, teacher.name AS teacher_name, ta.is_class_teacher
             FROM academic.teacher_assignments ta
             JOIN academic.sections s ON s.org_id=ta.org_id AND s.id=ta.section_id
             JOIN academic.subjects sub ON sub.org_id=ta.org_id AND sub.id=ta.subject_id
             JOIN identity.users teacher ON teacher.org_id=ta.org_id AND teacher.id=ta.teacher_user_id
            WHERE ta.org_id=$1 AND ($2::uuid IS NULL OR ta.section_id=$2)
              AND ($3::boolean OR ta.teacher_user_id=$4)
            ORDER BY s.name, sub.name, teacher.name`,
          [user.orgId, query.data.sectionId ?? null, isAdmin, user.id],
        ),
      );
      res.json({
        items: result.rows.map((row: any) => ({
          id: row.id, sectionId: row.section_id, sectionName: row.section_name,
          subjectId: row.subject_id, subjectName: row.subject_name, teacherId: row.teacher_user_id,
          teacherName: row.teacher_name, isClassTeacher: row.is_class_teacher,
        })),
        total: result.rowCount ?? result.rows.length,
      });
    } catch (error) { next(error); }
  });

  router.post("/academic/teacher-assignments", requireAuth, async (req, res, next) => {
    const user = req.campusUser;
    if (!user) return void res.status(401).json(errorBody("UNAUTHENTICATED", "Sign in to continue."));
    if (!user.roles.some((role) => adminRoles.includes(role))) return void res.status(403).json(errorBody("FORBIDDEN", "Only administrators can manage teaching assignments."));
    const parsed = CreateAcademicTeacherAssignmentBody.safeParse(req.body);
    if (!parsed.success) return void res.status(400).json(errorBody("INVALID_REQUEST", "Provide a valid teaching assignment."));
    try {
      const created = await withOrg(user.orgId, async (client) => {
        const valid = await client.query(
          `SELECT 1
             FROM academic.sections s
             JOIN academic.subjects sub ON sub.org_id=s.org_id AND sub.id=$3 AND sub.is_active=true
             JOIN identity.users teacher ON teacher.org_id=s.org_id AND teacher.id=$4 AND teacher.status='active'
             WHERE s.org_id=$1 AND s.id=$2
               AND EXISTS (SELECT 1 FROM identity.user_roles r WHERE r.org_id=s.org_id AND r.user_id=teacher.id AND r.role=ANY($5::text[]))`,
          [user.orgId, parsed.data.sectionId, parsed.data.subjectId, parsed.data.teacherId, teacherRoles],
        );
        if (!valid.rowCount) return null;
        const inserted = await client.query(
          `INSERT INTO academic.teacher_assignments (org_id, section_id, subject_id, teacher_user_id, is_class_teacher)
           VALUES ($1,$2,$3,$4,$5)
           ON CONFLICT (org_id, section_id, subject_id, teacher_user_id)
           DO UPDATE SET is_class_teacher=EXCLUDED.is_class_teacher
           RETURNING id, section_id, subject_id, teacher_user_id, is_class_teacher`,
          [user.orgId, parsed.data.sectionId, parsed.data.subjectId, parsed.data.teacherId, parsed.data.isClassTeacher],
        );
        const row = inserted.rows[0];
        const detail = await client.query(
          `SELECT s.name AS section_name, sub.name AS subject_name, teacher.name AS teacher_name
             FROM academic.sections s
             JOIN academic.subjects sub ON sub.org_id=s.org_id AND sub.id=$3
             JOIN identity.users teacher ON teacher.org_id=s.org_id AND teacher.id=$4
            WHERE s.org_id=$1 AND s.id=$2`,
          [user.orgId, parsed.data.sectionId, parsed.data.subjectId, parsed.data.teacherId],
        );
        return { ...row, ...detail.rows[0] };
      });
      if (!created) return void res.status(400).json(errorBody("INVALID_REQUEST", "Choose an active section, subject, and teaching staff member."));
      res.status(201).json({
        id: created.id, sectionId: created.section_id, sectionName: created.section_name,
        subjectId: created.subject_id, subjectName: created.subject_name, teacherId: created.teacher_user_id,
        teacherName: created.teacher_name, isClassTeacher: created.is_class_teacher,
      });
    } catch (error: any) {
      if (error?.code === "23505") return void res.status(409).json(errorBody("CONFLICT", "This teacher already has that subject assignment in the section."));
      next(error);
    }
  });

  router.delete("/academic/teacher-assignments/:assignmentId", requireAuth, async (req, res, next) => {
    const user = req.campusUser;
    const params = DeleteAcademicTeacherAssignmentParams.safeParse(req.params);
    if (!user) return void res.status(401).json(errorBody("UNAUTHENTICATED", "Sign in to continue."));
    if (!user.roles.some((role) => adminRoles.includes(role))) return void res.status(403).json(errorBody("FORBIDDEN", "Only administrators can manage teaching assignments."));
    if (!params.success) return void res.status(400).json(errorBody("INVALID_REQUEST", "Provide a valid assignment ID."));
    try {
      const removed = await withOrg(user.orgId, (client) =>
        client.query("DELETE FROM academic.teacher_assignments WHERE org_id=$1 AND id=$2", [user.orgId, params.data.assignmentId]),
      );
      if (!removed.rowCount) return void res.status(404).json(errorBody("NOT_FOUND", "Teaching assignment not found."));
      res.status(204).send();
    } catch (error) { next(error); }
  });
};

export default routes;
