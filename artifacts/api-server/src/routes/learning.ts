import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import {
  CreateLearningAssignmentBody,
  UpdateLearningAssignmentBody,
  SubmitLearningAssignmentBody,
  GradeLearningSubmissionBody,
  CreateLearningExamBody,
  UpdateLearningExamMarksBody,
  PublishLearningExamBody,
  CreateLearningTermBody,
  UpdateLearningGradeScaleBody,
} from "@workspace/api-zod";
import { withOrg } from "@workspace/db";
import { createRouteRegistrar } from "../lib/fastify-routes";
import { requireAuth, type CampusRole } from "../lib/auth";
import {
  assignmentTransitionAllowed,
  canManageLearningSection,
  canReadStudentLearning,
  canSubmitLearningWork,
  gradeForScore,
  isLateSubmission,
  isValidGradeScale,
} from "../lib/learning-policy";

const routes: FastifyPluginAsync = async (fastify) => {
  const router = createRouteRegistrar(fastify);
  const adminRoles: CampusRole[] = ["super_admin", "org_admin", "campus_admin"];
  const teachingRoles: CampusRole[] = ["teacher", "class_teacher", "hod"];
  const defaultBands = [
    { grade: "A1", minPercent: 90 }, { grade: "A2", minPercent: 80 },
    { grade: "B1", minPercent: 70 }, { grade: "B2", minPercent: 60 },
    { grade: "C", minPercent: 50 }, { grade: "D", minPercent: 40 },
    { grade: "E", minPercent: 33 }, { grade: "F", minPercent: 0 },
  ];
  const errorBody = (code: string, message: string) => ({ error: { code, message } });
  const flags = (roles: CampusRole[]) => ({
    admin: roles.some((role) => adminRoles.includes(role)),
    teacher: roles.some((role) => teachingRoles.includes(role)),
    student: roles.includes("student"),
    parent: roles.includes("parent"),
  });
  const userFor = (req: FastifyRequest) => req.campusUser;
  const validId = (value: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
  const dateOnly = (value: unknown) => value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10);
  const idParam = (req: FastifyRequest, name: string) => (req.params as Record<string, string>)[name] ?? "";
  const audit = (client: any, orgId: string, actorId: string, action: string, type: string, id: string, metadata: object = {}) =>
    client.query(
      `INSERT INTO learning.audit_log (org_id, actor_user_id, action, resource_type, resource_id, metadata)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
      [orgId, actorId, action, type, id, JSON.stringify(metadata)],
    );
  const canTeachSection = async (client: any, userId: string, orgId: string, sectionId: string, role: ReturnType<typeof flags>) => {
    if (role.admin || !role.teacher) {
      const found = await client.query("SELECT 1 FROM academic.sections WHERE org_id=$1 AND id=$2", [orgId, sectionId]);
      return canManageLearningSection(role, Boolean(found.rowCount));
    }
    const found = await client.query(
      `SELECT 1 FROM academic.section_teachers
        WHERE org_id=$1 AND section_id=$2 AND teacher_user_id=$3`,
      [orgId, sectionId, userId],
    );
    return canManageLearningSection(role, Boolean(found.rowCount));
  };
  const bandsFor = async (client: any, orgId: string): Promise<{ grade: string; minPercent: number }[]> => {
    const result = await client.query(
      "SELECT bands FROM learning.grade_scales WHERE org_id=$1",
      [orgId],
    );
    return (result.rows[0]?.bands as { grade: string; minPercent: number }[] | undefined) ?? defaultBands;
  };
  const readStudentAssignments = async (orgId: string, studentId: string, teacherId: string | null = null, limit = 100, offset = 0) =>
    withOrg(orgId, async (client) => {
      const result = await client.query(
        `SELECT a.id, a.section_id, s.name AS section_name, a.title, a.instructions, a.due_at,
                a.max_points, a.status, teacher.name AS teacher_name, 0::int AS submission_count,
                student.id AS student_id, student.name AS student_name,
                CASE WHEN sub.id IS NULL THEN NULL ELSE jsonb_build_object(
                  'studentId', student.id, 'studentName', student.name, 'content', sub.content,
                  'submittedAt', sub.submitted_at, 'isLate', sub.is_late, 'gradePoints', sub.grade_points,
                  'feedback', sub.feedback, 'gradedAt', sub.graded_at
                ) END AS my_submission,
                count(*) OVER()::int AS total
           FROM learning.assignments a
           JOIN academic.sections s ON s.id=a.section_id AND s.org_id=a.org_id
           JOIN identity.users teacher ON teacher.id=a.teacher_user_id AND teacher.org_id=a.org_id
           JOIN academic.enrollments e ON e.org_id=a.org_id AND e.section_id=a.section_id
             AND e.student_user_id=$2 AND e.status='active'
           JOIN identity.users student ON student.id=e.student_user_id AND student.org_id=e.org_id
           LEFT JOIN learning.assignment_submissions sub ON sub.org_id=a.org_id
             AND sub.assignment_id=a.id AND sub.student_user_id=e.student_user_id
          WHERE a.org_id=$1 AND a.status <> 'draft'
            AND ($3::uuid IS NULL OR EXISTS (
              SELECT 1 FROM academic.section_teachers st
               WHERE st.org_id=a.org_id AND st.section_id=a.section_id AND st.teacher_user_id=$3
            ))
          ORDER BY a.due_at DESC, a.created_at DESC LIMIT $4 OFFSET $5`,
        [orgId, studentId, teacherId, limit, offset],
      );
      return {
        items: result.rows.map((row: any) => ({
          id: row.id, sectionId: row.section_id, sectionName: row.section_name, title: row.title,
          instructions: row.instructions, dueAt: row.due_at.toISOString(), maxPoints: Number(row.max_points),
          status: row.status, teacherName: row.teacher_name, submissionCount: row.submission_count,
          studentId: row.student_id, studentName: row.student_name, mySubmission: row.my_submission,
        })),
        total: result.rows[0]?.total ?? 0, limit, offset,
      };
    });
  const readSubmissions = async (orgId: string, assignmentId: string, studentIds: string[] | null) =>
    withOrg(orgId, async (client) => {
      const result = await client.query(
        `SELECT sub.student_user_id, u.name, sub.content, sub.submitted_at, sub.is_late,
                sub.grade_points, sub.feedback, sub.graded_at
           FROM learning.assignment_submissions sub
           JOIN identity.users u ON u.id=sub.student_user_id AND u.org_id=sub.org_id
          WHERE sub.org_id=$1 AND sub.assignment_id=$2
            AND ($3::uuid[] IS NULL OR sub.student_user_id=ANY($3::uuid[]))
          ORDER BY sub.submitted_at DESC`,
        [orgId, assignmentId, studentIds],
      );
      return { items: result.rows.map((row: any) => ({
        studentId: row.student_user_id, studentName: row.name, content: row.content,
        submittedAt: row.submitted_at.toISOString(), isLate: row.is_late,
        gradePoints: row.grade_points === null ? null : Number(row.grade_points),
        feedback: row.feedback, gradedAt: row.graded_at?.toISOString() ?? null,
      })), total: result.rowCount ?? result.rows.length };
    });

  router.get("/learning/assignments", requireAuth, async (req, res, next) => {
    const user = userFor(req);
    if (!user) return void res.status(401).json(errorBody("UNAUTHENTICATED", "Sign in to continue."));
    const role = flags(user.roles);
    if (role.student || role.parent) {
      try {
        const studentIds = await withOrg(user.orgId, async (client) => {
          const result = role.student
            ? await client.query("SELECT id FROM identity.users WHERE org_id=$1 AND id=$2", [user.orgId, user.id])
            : await client.query("SELECT student_user_id AS id FROM identity.guardian_links WHERE org_id=$1 AND guardian_user_id=$2", [user.orgId, user.id]);
          return result.rows.map((row: any) => row.id as string);
        });
        const pages = await Promise.all(studentIds.map((studentId) => readStudentAssignments(user.orgId, studentId)));
        const items = pages.flatMap((page) => page.items);
        return void res.json({ items, total: items.length, limit: 100, offset: 0 });
      } catch (error) { return next(error); }
    }
    if (!role.admin && !role.teacher) return void res.status(403).json(errorBody("FORBIDDEN", "You cannot view assignments."));
    const sectionId = typeof req.query === "object" ? (req.query as Record<string, unknown>).sectionId : undefined;
    const status = typeof req.query === "object" ? (req.query as Record<string, unknown>).status : undefined;
    if (sectionId !== undefined && (typeof sectionId !== "string" || !validId(sectionId))) {
      return void res.status(400).json(errorBody("INVALID_REQUEST", "sectionId must be a UUID."));
    }
    if (status !== undefined && !["draft", "published", "closed"].includes(String(status))) {
      return void res.status(400).json(errorBody("INVALID_REQUEST", "Invalid assignment status."));
    }
    try {
      const page = await withOrg(user.orgId, async (client) => {
        const result = await client.query(
          `SELECT a.id, a.section_id, s.name AS section_name, a.title, a.instructions, a.due_at,
                  a.max_points, a.status, teacher.name AS teacher_name,
                  (SELECT count(*)::int FROM learning.assignment_submissions sub
                    WHERE sub.org_id=a.org_id AND sub.assignment_id=a.id) AS submission_count,
                  count(*) OVER()::int AS total
             FROM learning.assignments a
             JOIN academic.sections s ON s.id=a.section_id AND s.org_id=a.org_id
             JOIN identity.users teacher ON teacher.id=a.teacher_user_id AND teacher.org_id=a.org_id
            WHERE a.org_id=$1
              AND ($2::boolean OR EXISTS (SELECT 1 FROM academic.section_teachers st
                WHERE st.org_id=a.org_id AND st.section_id=a.section_id AND st.teacher_user_id=$3))
              AND ($4::uuid IS NULL OR a.section_id=$4)
              AND ($5::text IS NULL OR a.status=$5)
            ORDER BY a.due_at DESC, a.created_at DESC LIMIT 100`,
          [user.orgId, role.admin, user.id, sectionId ?? null, status ?? null],
        );
        return { items: result.rows.map((row: any) => ({
          id: row.id, sectionId: row.section_id, sectionName: row.section_name, title: row.title,
          instructions: row.instructions, dueAt: row.due_at.toISOString(), maxPoints: Number(row.max_points),
          status: row.status, teacherName: row.teacher_name, submissionCount: row.submission_count,
          studentId: null, studentName: null, mySubmission: null,
        })), total: result.rows[0]?.total ?? 0, limit: 100, offset: 0 };
      });
      res.json(page);
    } catch (error) { next(error); }
  });

  router.get("/learning/my/assignments", requireAuth, async (req, res, next) => {
    const user = userFor(req);
    if (!user) return void res.status(401).json(errorBody("UNAUTHENTICATED", "Sign in to continue."));
    const role = flags(user.roles);
    if (!role.student && !role.parent) return void res.status(403).json(errorBody("FORBIDDEN", "This view is for students and guardians."));
    try {
      const studentIds = await withOrg(user.orgId, async (client) => {
        const result = role.student
          ? await client.query("SELECT id FROM identity.users WHERE org_id=$1 AND id=$2", [user.orgId, user.id])
          : await client.query("SELECT student_user_id AS id FROM identity.guardian_links WHERE org_id=$1 AND guardian_user_id=$2", [user.orgId, user.id]);
        return result.rows.map((row: any) => row.id as string);
      });
      const pages = await Promise.all(studentIds.map((studentId) => readStudentAssignments(user.orgId, studentId)));
      const items = pages.flatMap((page) => page.items);
      res.json({ items, total: items.length, limit: 100, offset: 0 });
    } catch (error) { next(error); }
  });

  router.get("/learning/students/:studentId/assignments", requireAuth, async (req, res, next) => {
    const user = userFor(req);
    const studentId = idParam(req, "studentId");
    if (!user) return void res.status(401).json(errorBody("UNAUTHENTICATED", "Sign in to continue."));
    if (!validId(studentId)) return void res.status(400).json(errorBody("INVALID_REQUEST", "studentId must be a UUID."));
    const role = flags(user.roles);
    try {
      const page = await withOrg(user.orgId, async (client) => {
        let isLinkedChild = false;
        let teachesSection = false;
        if (role.parent && !role.admin) {
          const linked = await client.query(
            "SELECT 1 FROM identity.guardian_links WHERE org_id=$1 AND guardian_user_id=$2 AND student_user_id=$3",
            [user.orgId, user.id, studentId],
          );
          isLinkedChild = Boolean(linked.rowCount);
        }
        if (role.teacher && !role.admin) {
          const assigned = await client.query(
            `SELECT 1 FROM academic.enrollments e JOIN academic.section_teachers st
              ON st.org_id=e.org_id AND st.section_id=e.section_id
             WHERE e.org_id=$1 AND e.student_user_id=$2 AND e.status='active' AND st.teacher_user_id=$3`,
            [user.orgId, studentId, user.id],
          );
          teachesSection = Boolean(assigned.rowCount);
        }
        if (!canReadStudentLearning(role, { isSelf: user.id === studentId, isLinkedChild, teachesSection })) return null;
        const teacherScope = role.teacher && !role.admin && !role.parent && !role.student ? user.id : null;
        return readStudentAssignments(user.orgId, studentId, teacherScope);
      });
      if (!page) return void res.status(403).json(errorBody("FORBIDDEN", "You cannot view this student's assignments."));
      res.json(await page);
    } catch (error) { next(error); }
  });

  router.post("/learning/assignments", requireAuth, async (req, res, next) => {
    const user = userFor(req);
    if (!user) return void res.status(401).json(errorBody("UNAUTHENTICATED", "Sign in to continue."));
    const parsed = CreateLearningAssignmentBody.safeParse(req.body);
    if (!parsed.success) return void res.status(400).json(errorBody("INVALID_REQUEST", "Provide a valid assignment."));
    const role = flags(user.roles);
    if (!role.admin && !role.teacher) return void res.status(403).json(errorBody("FORBIDDEN", "Only teaching staff can create assignments."));
    const input = parsed.data;
    if (!input.title.trim()) return void res.status(400).json(errorBody("INVALID_REQUEST", "Assignment title is required."));
    try {
      const created = await withOrg(user.orgId, async (client) => {
        if (!(await canTeachSection(client, user.id, user.orgId, input.sectionId, role))) return null;
        const result = await client.query(
          `INSERT INTO learning.assignments
             (org_id, section_id, teacher_user_id, title, instructions, due_at, max_points)
           VALUES ($1,$2,$3,$4,$5,$6,$7)
           RETURNING id, section_id, title, instructions, due_at, max_points, status`,
          [user.orgId, input.sectionId, user.id, input.title.trim(), input.instructions, input.dueAt, input.maxPoints],
        );
        const row = result.rows[0];
        const section = await client.query("SELECT name FROM academic.sections WHERE org_id=$1 AND id=$2", [user.orgId, input.sectionId]);
        await audit(client, user.orgId, user.id, "assignment.created", "assignment", row.id);
        return { ...row, section_name: section.rows[0]?.name ?? "" };
      });
      if (!created) return void res.status(403).json(errorBody("FORBIDDEN", "You are not assigned to this section."));
      res.status(201).json({
        id: created.id, sectionId: created.section_id, sectionName: created.section_name, title: created.title,
        instructions: created.instructions, dueAt: new Date(created.due_at).toISOString(),
        maxPoints: Number(created.max_points), status: created.status, teacherName: user.name,
        submissionCount: 0, studentId: null, studentName: null, mySubmission: null,
      });
    } catch (error) { next(error); }
  });

  router.put("/learning/assignments/:assignmentId", requireAuth, async (req, res, next) => {
    const user = userFor(req);
    const assignmentId = idParam(req, "assignmentId");
    if (!user) return void res.status(401).json(errorBody("UNAUTHENTICATED", "Sign in to continue."));
    if (!validId(assignmentId)) return void res.status(400).json(errorBody("INVALID_REQUEST", "assignmentId must be a UUID."));
    const parsed = UpdateLearningAssignmentBody.safeParse(req.body);
    if (!parsed.success || Object.keys(parsed.data).length === 0) return void res.status(400).json(errorBody("INVALID_REQUEST", "Provide a valid update."));
    const role = flags(user.roles);
    if (!role.admin && !role.teacher) return void res.status(403).json(errorBody("FORBIDDEN", "Only teaching staff can update assignments."));
    try {
      const updated = await withOrg(user.orgId, async (client) => {
        const current = await client.query(
          "SELECT * FROM learning.assignments WHERE org_id=$1 AND id=$2",
          [user.orgId, assignmentId],
        );
        const row = current.rows[0];
        if (!row || !(await canTeachSection(client, user.id, user.orgId, row.section_id, role))) return { denied: true } as const;
        const input = parsed.data;
        if (row.status !== "draft" && Object.keys(input).some((key) => key !== "status")) return { conflict: true } as const;
        if (input.status && !assignmentTransitionAllowed(row.status, input.status)) return { conflict: true } as const;
        const nextStatus = input.status ?? row.status;
        const result = await client.query(
          `UPDATE learning.assignments SET title=$3, instructions=$4, due_at=$5, max_points=$6,
             status=$7, updated_at=now()
           WHERE org_id=$1 AND id=$2
           RETURNING id, section_id, title, instructions, due_at, max_points, status`,
          [user.orgId, assignmentId, input.title?.trim() ?? row.title, input.instructions ?? row.instructions,
            input.dueAt ?? row.due_at, input.maxPoints ?? row.max_points, nextStatus],
        );
        const detail = await client.query(
          `SELECT s.name AS section_name, teacher.name AS teacher_name
             FROM learning.assignments a
             JOIN academic.sections s ON s.org_id=a.org_id AND s.id=a.section_id
             JOIN identity.users teacher ON teacher.org_id=a.org_id AND teacher.id=a.teacher_user_id
            WHERE a.org_id=$1 AND a.id=$2`,
          [user.orgId, assignmentId],
        );
        await audit(client, user.orgId, user.id, input.status ? `assignment.${nextStatus}` : "assignment.updated", "assignment", assignmentId);
        return { updated: { ...result.rows[0], ...detail.rows[0] } } as const;
      });
      if ("denied" in updated) return void res.status(403).json(errorBody("FORBIDDEN", "Assignment not found or not assigned to you."));
      if ("conflict" in updated) return void res.status(409).json(errorBody("CONFLICT", "This assignment state does not allow that change."));
      const row = updated.updated;
      res.json({
        id: row.id, sectionId: row.section_id, sectionName: row.section_name, title: row.title, instructions: row.instructions,
        dueAt: new Date(row.due_at).toISOString(), maxPoints: Number(row.max_points), status: row.status,
        teacherName: row.teacher_name, submissionCount: 0, studentId: null, studentName: null, mySubmission: null,
      });
    } catch (error) { next(error); }
  });

  router.get("/learning/assignments/:assignmentId/submissions", requireAuth, async (req, res, next) => {
    const user = userFor(req);
    const assignmentId = idParam(req, "assignmentId");
    if (!user) return void res.status(401).json(errorBody("UNAUTHENTICATED", "Sign in to continue."));
    if (!validId(assignmentId)) return void res.status(400).json(errorBody("INVALID_REQUEST", "assignmentId must be a UUID."));
    const role = flags(user.roles);
    try {
      const access = await withOrg(user.orgId, async (client) => {
        const result = await client.query("SELECT section_id, status FROM learning.assignments WHERE org_id=$1 AND id=$2", [user.orgId, assignmentId]);
        const assignment = result.rows[0];
        if (!assignment) return null;
        if (role.admin || (role.teacher && await canTeachSection(client, user.id, user.orgId, assignment.section_id, role))) return { all: true, studentIds: null as string[] | null };
        if (role.student && assignment.status !== "draft") return { all: false, studentIds: [user.id] };
        if (role.parent && assignment.status !== "draft") {
          const children = await client.query(
            `SELECT gl.student_user_id FROM identity.guardian_links gl
              JOIN academic.enrollments e ON e.org_id=gl.org_id AND e.student_user_id=gl.student_user_id
             WHERE gl.org_id=$1 AND gl.guardian_user_id=$2 AND e.section_id=$3 AND e.status='active'`,
            [user.orgId, user.id, assignment.section_id],
          );
          return { all: false, studentIds: children.rows.map((row: any) => row.student_user_id as string) };
        }
        return null;
      });
      if (access === null) return void res.status(403).json(errorBody("FORBIDDEN", "You cannot view these submissions."));
      res.json(await readSubmissions(user.orgId, assignmentId, access.studentIds));
    } catch (error) { next(error); }
  });

  router.post("/learning/assignments/:assignmentId/submissions", requireAuth, async (req, res, next) => {
    const user = userFor(req);
    const assignmentId = idParam(req, "assignmentId");
    if (!user) return void res.status(401).json(errorBody("UNAUTHENTICATED", "Sign in to continue."));
    if (!validId(assignmentId)) return void res.status(400).json(errorBody("INVALID_REQUEST", "assignmentId must be a UUID."));
    if (!canSubmitLearningWork(flags(user.roles))) return void res.status(403).json(errorBody("FORBIDDEN", "Only a student can submit work."));
    const parsed = SubmitLearningAssignmentBody.safeParse(req.body);
    if (!parsed.success) return void res.status(400).json(errorBody("INVALID_REQUEST", "Provide valid assignment work."));
    if (!parsed.data.content.trim()) return void res.status(400).json(errorBody("INVALID_REQUEST", "Submission content cannot be blank."));
    try {
      const submission = await withOrg(user.orgId, async (client) => {
        const result = await client.query(
          `SELECT a.due_at FROM learning.assignments a
            JOIN academic.enrollments e ON e.org_id=a.org_id AND e.section_id=a.section_id
              AND e.student_user_id=$3 AND e.status='active'
           WHERE a.org_id=$1 AND a.id=$2 AND a.status='published'`,
          [user.orgId, assignmentId, user.id],
        );
        const assignment = result.rows[0];
        if (!assignment) return null;
        const written = await client.query(
          `INSERT INTO learning.assignment_submissions (org_id, assignment_id, student_user_id, content, is_late)
           VALUES ($1,$2,$3,$4,$5)
           ON CONFLICT (org_id, assignment_id, student_user_id) DO UPDATE
             SET content=EXCLUDED.content, submitted_at=now(), is_late=EXCLUDED.is_late, updated_at=now()
             WHERE learning.assignment_submissions.grade_points IS NULL
           RETURNING student_user_id, content, submitted_at, is_late, grade_points, feedback, graded_at`,
          [user.orgId, assignmentId, user.id, parsed.data.content.trim(), isLateSubmission(new Date(assignment.due_at).getTime(), Date.now())],
        );
        if (!written.rowCount) return false;
        await audit(client, user.orgId, user.id, "assignment.submitted", "assignment", assignmentId);
        return written.rows[0];
      });
      if (!submission) return void res.status(404).json(errorBody("NOT_FOUND", "Published assignment or active enrollment not found."));
      if (submission === false) return void res.status(409).json(errorBody("CONFLICT", "This work has already been graded and cannot be changed."));
      res.status(201).json({
        studentId: user.id, studentName: user.name, content: submission.content,
        submittedAt: submission.submitted_at.toISOString(), isLate: submission.is_late,
        gradePoints: submission.grade_points === null ? null : Number(submission.grade_points),
        feedback: submission.feedback, gradedAt: submission.graded_at?.toISOString() ?? null,
      });
    } catch (error) { next(error); }
  });

  router.put("/learning/assignments/:assignmentId/submissions/:studentId/grade", requireAuth, async (req, res, next) => {
    const user = userFor(req);
    const assignmentId = idParam(req, "assignmentId");
    const studentId = idParam(req, "studentId");
    if (!user) return void res.status(401).json(errorBody("UNAUTHENTICATED", "Sign in to continue."));
    if (!validId(assignmentId) || !validId(studentId)) return void res.status(400).json(errorBody("INVALID_REQUEST", "Provide valid IDs."));
    const parsed = GradeLearningSubmissionBody.safeParse(req.body);
    if (!parsed.success) return void res.status(400).json(errorBody("INVALID_REQUEST", "Provide a valid grade and feedback."));
    const role = flags(user.roles);
    if (!role.admin && !role.teacher) return void res.status(403).json(errorBody("FORBIDDEN", "Only teaching staff can grade work."));
    try {
      const graded = await withOrg(user.orgId, async (client) => {
        const result = await client.query(
          `SELECT a.section_id, a.max_points FROM learning.assignments a
            JOIN academic.enrollments e ON e.org_id=a.org_id AND e.section_id=a.section_id
              AND e.student_user_id=$3 AND e.status='active'
           WHERE a.org_id=$1 AND a.id=$2`,
          [user.orgId, assignmentId, studentId],
        );
        const assignment = result.rows[0];
        if (!assignment || !(await canTeachSection(client, user.id, user.orgId, assignment.section_id, role))) return { denied: true } as const;
        if (parsed.data.gradePoints > Number(assignment.max_points)) return { invalid: true } as const;
        const submission = await client.query(
          `UPDATE learning.assignment_submissions SET grade_points=$4, feedback=$5, graded_by=$6,
             graded_at=now(), updated_at=now()
           WHERE org_id=$1 AND assignment_id=$2 AND student_user_id=$3
           RETURNING content, submitted_at, is_late, grade_points, feedback, graded_at`,
          [user.orgId, assignmentId, studentId, parsed.data.gradePoints, parsed.data.feedback, user.id],
        );
        if (!submission.rowCount) return { missing: true } as const;
        await audit(client, user.orgId, user.id, "submission.grade", "assignment", assignmentId, { studentId, gradePoints: parsed.data.gradePoints });
        return { submission: submission.rows[0] } as const;
      });
      if ("denied" in graded) return void res.status(403).json(errorBody("FORBIDDEN", "You cannot grade this student."));
      if ("invalid" in graded) return void res.status(400).json(errorBody("INVALID_REQUEST", "Grade cannot exceed the assignment maximum."));
      if ("missing" in graded) return void res.status(404).json(errorBody("NOT_FOUND", "Student submission not found."));
      const row = graded.submission;
      res.json({
        studentId, studentName: "", content: row.content, submittedAt: row.submitted_at.toISOString(),
        isLate: row.is_late, gradePoints: Number(row.grade_points), feedback: row.feedback, gradedAt: row.graded_at.toISOString(),
      });
    } catch (error) { next(error); }
  });

  router.get("/learning/exams", requireAuth, async (req, res, next) => {
    const user = userFor(req);
    if (!user) return void res.status(401).json(errorBody("UNAUTHENTICATED", "Sign in to continue."));
    const role = flags(user.roles);
    if (!role.admin && !role.teacher && !role.student && !role.parent) return void res.status(403).json(errorBody("FORBIDDEN", "You cannot view assessments."));
    const sectionId = (req.query as Record<string, unknown>)?.sectionId;
    if (sectionId !== undefined && (typeof sectionId !== "string" || !validId(sectionId))) {
      return void res.status(400).json(errorBody("INVALID_REQUEST", "sectionId must be a UUID."));
    }
    try {
      const page = await withOrg(user.orgId, async (client) => {
        const [result, bands] = await Promise.all([
          client.query(
            `SELECT ex.id, ex.section_id, s.name AS section_name, ex.term_id, term.name AS term_name,
                    ex.title, ex.exam_date, ex.max_points, ex.status,
                    COALESCE(results.items, '[]'::jsonb) AS results,
                    count(*) OVER()::int AS total
               FROM learning.exams ex
               JOIN academic.sections s ON s.id=ex.section_id AND s.org_id=ex.org_id
               LEFT JOIN learning.exam_terms term ON term.id=ex.term_id AND term.org_id=ex.org_id
               LEFT JOIN LATERAL (
                 SELECT jsonb_agg(jsonb_build_object(
                   'studentId', u.id, 'studentName', u.name, 'score', mark.score, 'feedback', mark.feedback
                 ) ORDER BY u.name) AS items
                   FROM academic.enrollments e
                   JOIN identity.users u ON u.id=e.student_user_id AND u.org_id=e.org_id
                   LEFT JOIN learning.exam_marks mark ON mark.org_id=ex.org_id AND mark.exam_id=ex.id
                     AND mark.student_user_id=e.student_user_id
                  WHERE e.org_id=ex.org_id AND e.section_id=ex.section_id AND e.status='active'
                    AND (($5::boolean AND e.student_user_id=$4)
                      OR ($6::boolean AND EXISTS (
                        SELECT 1 FROM identity.guardian_links gl WHERE gl.org_id=e.org_id
                          AND gl.guardian_user_id=$4 AND gl.student_user_id=e.student_user_id
                      )))
               ) results ON true
              WHERE ex.org_id=$1 AND ($2::uuid IS NULL OR ex.section_id=$2)
                AND ($3::boolean OR ($7::boolean AND EXISTS (
                  SELECT 1 FROM academic.section_teachers st WHERE st.org_id=ex.org_id
                    AND st.section_id=ex.section_id AND st.teacher_user_id=$4
                )) OR (ex.status='published' AND EXISTS (
                  SELECT 1 FROM academic.enrollments e
                  WHERE e.org_id=ex.org_id AND e.section_id=ex.section_id AND e.status='active'
                    AND (($5::boolean AND e.student_user_id=$4) OR ($6::boolean AND EXISTS (
                      SELECT 1 FROM identity.guardian_links gl WHERE gl.org_id=e.org_id
                        AND gl.guardian_user_id=$4 AND gl.student_user_id=e.student_user_id
                    )))
                )))
              ORDER BY ex.exam_date DESC, ex.created_at DESC LIMIT 100`,
            [user.orgId, sectionId ?? null, role.admin, user.id, role.student, role.parent, role.teacher],
          ),
          bandsFor(client, user.orgId),
        ]);
        return {
          items: result.rows.map((row: any) => ({
            id: row.id, sectionId: row.section_id, sectionName: row.section_name,
            termId: row.term_id, termName: row.term_name, title: row.title,
            examDate: dateOnly(row.exam_date),
            maxPoints: Number(row.max_points), status: row.status,
            results: (row.results ?? []).map((item: any) => ({
              studentId: item.studentId, studentName: item.studentName, score: item.score === null ? null : Number(item.score),
              grade: item.score === null ? null : gradeForScore(Number(item.score), Number(row.max_points), bands),
              feedback: item.feedback,
            })),
          })),
          total: result.rows[0]?.total ?? 0, limit: 100, offset: 0,
        };
      });
      res.json(page);
    } catch (error) { next(error); }
  });

  router.post("/learning/exams", requireAuth, async (req, res, next) => {
    const user = userFor(req);
    if (!user) return void res.status(401).json(errorBody("UNAUTHENTICATED", "Sign in to continue."));
    const parsed = CreateLearningExamBody.safeParse(req.body);
    if (!parsed.success) return void res.status(400).json(errorBody("INVALID_REQUEST", "Provide valid assessment details."));
    if (!parsed.data.title.trim()) return void res.status(400).json(errorBody("INVALID_REQUEST", "Assessment title is required."));
    const role = flags(user.roles);
    if (!role.admin && !role.teacher) return void res.status(403).json(errorBody("FORBIDDEN", "Only teaching staff can create assessments."));
    try {
      const exam = await withOrg(user.orgId, async (client) => {
        if (!(await canTeachSection(client, user.id, user.orgId, parsed.data.sectionId, role))) return null;
        const created = await client.query(
          `INSERT INTO learning.exams (org_id, section_id, teacher_user_id, term_id, title, exam_date, max_points)
           VALUES ($1,$2,$3,$4,$5,$6,$7)
           RETURNING id, section_id, term_id, title, exam_date, max_points, status`,
          [user.orgId, parsed.data.sectionId, user.id, parsed.data.termId ?? null,
            parsed.data.title.trim(), parsed.data.examDate, parsed.data.maxPoints],
        );
        const row = created.rows[0];
        const detail = await client.query(
          `SELECT s.name AS section_name, term.name AS term_name
             FROM academic.sections s
             LEFT JOIN learning.exam_terms term ON term.org_id=s.org_id AND term.id=$3
            WHERE s.org_id=$1 AND s.id=$2`,
          [user.orgId, parsed.data.sectionId, parsed.data.termId ?? null],
        );
        await audit(client, user.orgId, user.id, "exam.created", "exam", row.id);
        return { ...row, ...detail.rows[0] };
      });
      if (!exam) return void res.status(403).json(errorBody("FORBIDDEN", "You are not assigned to this section."));
      res.status(201).json({
        id: exam.id, sectionId: exam.section_id, sectionName: exam.section_name, termId: exam.term_id, termName: exam.term_name,
        title: exam.title, examDate: dateOnly(exam.exam_date), maxPoints: Number(exam.max_points),
        status: exam.status, results: [],
      });
    } catch (error) { next(error); }
  });

  const marksForExam = async (orgId: string, examId: string, roles: CampusRole[], userId: string) => {
    const role = flags(roles);
    return withOrg(orgId, async (client) => {
      const examResult = await client.query(
        "SELECT section_id, max_points, status FROM learning.exams WHERE org_id=$1 AND id=$2",
        [orgId, examId],
      );
      const exam = examResult.rows[0];
      if (!exam) return { missing: true as const };
      if (!role.admin && !role.teacher && !role.student && !role.parent) return { denied: true as const };
      const staff = role.admin || (role.teacher && await canTeachSection(client, userId, orgId, exam.section_id, role));
      if (!staff && exam.status !== "published") return { denied: true as const };
      const [result, bands] = await Promise.all([
        client.query(
          `SELECT u.id AS student_id, u.name AS student_name, mark.score, COALESCE(mark.feedback, '') AS feedback
             FROM academic.enrollments e
             JOIN identity.users u ON u.id=e.student_user_id AND u.org_id=e.org_id
             LEFT JOIN learning.exam_marks mark ON mark.org_id=e.org_id AND mark.exam_id=$2
               AND mark.student_user_id=e.student_user_id
            WHERE e.org_id=$1 AND e.section_id=$3 AND e.status='active'
              AND ($4::boolean OR ($5::boolean AND e.student_user_id=$6) OR ($7::boolean AND EXISTS (
                SELECT 1 FROM identity.guardian_links gl WHERE gl.org_id=e.org_id
                  AND gl.guardian_user_id=$6 AND gl.student_user_id=e.student_user_id
              )))
            ORDER BY u.name`,
          [orgId, examId, exam.section_id, staff, role.student, userId, role.parent],
        ),
        bandsFor(client, orgId),
      ]);
      return {
        items: result.rows.map((row: any) => ({
          studentId: row.student_id, studentName: row.student_name,
          score: row.score === null ? null : Number(row.score),
          feedback: row.feedback,
          grade: row.score === null ? null : gradeForScore(Number(row.score), Number(exam.max_points), bands),
        })),
        total: result.rowCount ?? result.rows.length,
      };
    });
  };

  router.get("/learning/exams/:examId/marks", requireAuth, async (req, res, next) => {
    const user = userFor(req);
    const examId = idParam(req, "examId");
    if (!user) return void res.status(401).json(errorBody("UNAUTHENTICATED", "Sign in to continue."));
    if (!validId(examId)) return void res.status(400).json(errorBody("INVALID_REQUEST", "examId must be a UUID."));
    try {
      const result = await marksForExam(user.orgId, examId, user.roles, user.id);
      if ("missing" in result) return void res.status(404).json(errorBody("NOT_FOUND", "Assessment not found."));
      if ("denied" in result) return void res.status(403).json(errorBody("FORBIDDEN", "Results are not available to you."));
      res.json(result);
    } catch (error) { next(error); }
  });

  router.put("/learning/exams/:examId/marks", requireAuth, async (req, res, next) => {
    const user = userFor(req);
    const examId = idParam(req, "examId");
    if (!user) return void res.status(401).json(errorBody("UNAUTHENTICATED", "Sign in to continue."));
    if (!validId(examId)) return void res.status(400).json(errorBody("INVALID_REQUEST", "examId must be a UUID."));
    const parsed = UpdateLearningExamMarksBody.safeParse(req.body);
    if (!parsed.success) return void res.status(400).json(errorBody("INVALID_REQUEST", "Provide a valid marks grid."));
    const role = flags(user.roles);
    if (!role.admin && !role.teacher) return void res.status(403).json(errorBody("FORBIDDEN", "Only teaching staff can update marks."));
    try {
      const result = await withOrg(user.orgId, async (client) => {
        const examResult = await client.query("SELECT section_id, max_points, status FROM learning.exams WHERE org_id=$1 AND id=$2", [user.orgId, examId]);
        const exam = examResult.rows[0];
        if (!exam || !(await canTeachSection(client, user.id, user.orgId, exam.section_id, role))) return { denied: true as const };
        if (exam.status !== "draft") return { locked: true as const };
        const uniqueIds = new Set(parsed.data.marks.map((mark) => mark.studentId));
        if (uniqueIds.size !== parsed.data.marks.length) return { invalid: true as const };
        if (parsed.data.marks.some((mark) => mark.score !== null && mark.score > Number(exam.max_points))) {
          return { invalid: true as const };
        }
        if (uniqueIds.size) {
          const enrolled = await client.query(
            "SELECT student_user_id FROM academic.enrollments WHERE org_id=$1 AND section_id=$2 AND student_user_id=ANY($3::uuid[]) AND status='active'",
            [user.orgId, exam.section_id, [...uniqueIds]],
          );
          if (enrolled.rowCount !== uniqueIds.size) return { invalid: true as const };
        }
        for (const mark of parsed.data.marks) {
          if (mark.score === null) {
            await client.query("DELETE FROM learning.exam_marks WHERE org_id=$1 AND exam_id=$2 AND student_user_id=$3", [user.orgId, examId, mark.studentId]);
          } else {
            await client.query(
              `INSERT INTO learning.exam_marks (org_id, exam_id, student_user_id, score, feedback, marked_by)
               VALUES ($1,$2,$3,$4,$5,$6)
               ON CONFLICT (org_id, exam_id, student_user_id) DO UPDATE
                 SET score=EXCLUDED.score, feedback=EXCLUDED.feedback, marked_by=EXCLUDED.marked_by, updated_at=now()`,
              [user.orgId, examId, mark.studentId, mark.score, mark.feedback, user.id],
            );
          }
        }
        await audit(client, user.orgId, user.id, "marks.edit", "exam", examId, { count: parsed.data.marks.length });
        return { saved: true as const };
      });
      if ("denied" in result) return void res.status(403).json(errorBody("FORBIDDEN", "You cannot update marks for this assessment."));
      if ("locked" in result) return void res.status(409).json(errorBody("CONFLICT", "Published assessment marks are locked."));
      if ("invalid" in result) return void res.status(400).json(errorBody("INVALID_REQUEST", "Marks contain duplicate, unenrolled, or out-of-range students."));
      res.json(await marksForExam(user.orgId, examId, user.roles, user.id));
    } catch (error) { next(error); }
  });

  router.post("/learning/exams/:examId/publish", requireAuth, async (req, res, next) => {
    const user = userFor(req);
    const examId = idParam(req, "examId");
    if (!user) return void res.status(401).json(errorBody("UNAUTHENTICATED", "Sign in to continue."));
    if (!validId(examId)) return void res.status(400).json(errorBody("INVALID_REQUEST", "examId must be a UUID."));
    const parsed = PublishLearningExamBody.safeParse(req.body);
    if (!parsed.success) return void res.status(400).json(errorBody("INVALID_REQUEST", "Provide a publication state."));
    const role = flags(user.roles);
    if (!role.admin && !role.teacher) return void res.status(403).json(errorBody("FORBIDDEN", "Only teaching staff can publish results."));
    try {
      const updated = await withOrg(user.orgId, async (client) => {
        const result = await client.query("SELECT section_id, status FROM learning.exams WHERE org_id=$1 AND id=$2", [user.orgId, examId]);
        const exam = result.rows[0];
        if (!exam || !(await canTeachSection(client, user.id, user.orgId, exam.section_id, role))) return { denied: true as const };
        if (parsed.data.published) {
          const counts = await client.query(
            `SELECT count(*)::int AS enrolled,
                    count(mark.student_user_id)::int AS marked
               FROM academic.enrollments e
               LEFT JOIN learning.exam_marks mark ON mark.org_id=e.org_id AND mark.exam_id=$3
                 AND mark.student_user_id=e.student_user_id
              WHERE e.org_id=$1 AND e.section_id=$2 AND e.status='active'`,
            [user.orgId, exam.section_id, examId],
          );
          if (!counts.rows[0]?.enrolled || counts.rows[0].enrolled !== counts.rows[0].marked) return { incomplete: true as const };
        }
        const status = parsed.data.published ? "published" : "draft";
        await client.query("UPDATE learning.exams SET status=$3, updated_at=now() WHERE org_id=$1 AND id=$2", [user.orgId, examId, status]);
        await audit(client, user.orgId, user.id, parsed.data.published ? "exam.publish" : "exam.unpublish", "exam", examId);
        return { status };
      });
      if ("denied" in updated) return void res.status(403).json(errorBody("FORBIDDEN", "You cannot publish this assessment."));
      if ("incomplete" in updated) return void res.status(409).json(errorBody("CONFLICT", "Enter a score for every active student before publishing."));
      const [page, marks] = await Promise.all([
        withOrg(user.orgId, async (client) => client.query(
          `SELECT ex.id, ex.section_id, s.name AS section_name, ex.term_id, term.name AS term_name,
                  ex.title, ex.exam_date, ex.max_points, ex.status
             FROM learning.exams ex JOIN academic.sections s ON s.id=ex.section_id AND s.org_id=ex.org_id
             LEFT JOIN learning.exam_terms term ON term.id=ex.term_id AND term.org_id=ex.org_id
            WHERE ex.org_id=$1 AND ex.id=$2`, [user.orgId, examId],
        )),
        marksForExam(user.orgId, examId, user.roles, user.id),
      ]);
      const row = page.rows[0];
      const markItems = "items" in marks && Array.isArray(marks.items) ? marks.items : [];
      res.json({
        id: row.id, sectionId: row.section_id, sectionName: row.section_name, termId: row.term_id,
        termName: row.term_name, title: row.title,
        examDate: dateOnly(row.exam_date),
        maxPoints: Number(row.max_points), status: row.status,
        results: markItems.map((mark: any) => ({ studentId: mark.studentId, studentName: mark.studentName, score: mark.score, grade: mark.grade, feedback: mark.feedback })),
      });
    } catch (error) { next(error); }
  });

  router.get("/learning/terms", requireAuth, async (req, res, next) => {
    const user = userFor(req);
    if (!user) return void res.status(401).json(errorBody("UNAUTHENTICATED", "Sign in to continue."));
    try {
      const result = await withOrg(user.orgId, (client) =>
        client.query("SELECT id, name, starts_on, ends_on, is_current FROM learning.exam_terms WHERE org_id=$1 ORDER BY starts_on DESC", [user.orgId]),
      );
      res.json({ items: result.rows.map((row: any) => ({
        id: row.id, name: row.name, startsOn: dateOnly(row.starts_on),
        endsOn: dateOnly(row.ends_on), isCurrent: row.is_current,
      })), total: result.rowCount ?? result.rows.length });
    } catch (error) { next(error); }
  });

  router.post("/learning/terms", requireAuth, async (req, res, next) => {
    const user = userFor(req);
    if (!user) return void res.status(401).json(errorBody("UNAUTHENTICATED", "Sign in to continue."));
    if (!flags(user.roles).admin) return void res.status(403).json(errorBody("FORBIDDEN", "Only an administrator can manage assessment terms."));
    const parsed = CreateLearningTermBody.safeParse(req.body);
    if (!parsed.success || !parsed.data.name.trim() || parsed.data.endsOn < parsed.data.startsOn) return void res.status(400).json(errorBody("INVALID_REQUEST", "Provide a valid term name and date range."));
    try {
      const term = await withOrg(user.orgId, async (client) => {
        if (parsed.data.isCurrent) await client.query("UPDATE learning.exam_terms SET is_current=false WHERE org_id=$1", [user.orgId]);
        const created = await client.query(
          `INSERT INTO learning.exam_terms (org_id, name, starts_on, ends_on, is_current)
           VALUES ($1,$2,$3,$4,$5) RETURNING id,name,starts_on,ends_on,is_current`,
          [user.orgId, parsed.data.name.trim(), parsed.data.startsOn, parsed.data.endsOn, parsed.data.isCurrent],
        );
        await audit(client, user.orgId, user.id, "term.created", "term", created.rows[0].id);
        return created.rows[0];
      });
      res.status(201).json({
        id: term.id, name: term.name, startsOn: dateOnly(term.starts_on),
        endsOn: dateOnly(term.ends_on), isCurrent: term.is_current,
      });
    } catch (error) { next(error); }
  });

  router.get("/learning/grade-scale", requireAuth, async (req, res, next) => {
    const user = userFor(req);
    if (!user) return void res.status(401).json(errorBody("UNAUTHENTICATED", "Sign in to continue."));
    try {
      const result = await withOrg(user.orgId, async (client) => ({ bands: await bandsFor(client, user.orgId) }));
      res.json(result);
    } catch (error) { next(error); }
  });

  router.put("/learning/grade-scale", requireAuth, async (req, res, next) => {
    const user = userFor(req);
    if (!user) return void res.status(401).json(errorBody("UNAUTHENTICATED", "Sign in to continue."));
    if (!flags(user.roles).admin) return void res.status(403).json(errorBody("FORBIDDEN", "Only an administrator can update the grade scale."));
    const parsed = UpdateLearningGradeScaleBody.safeParse(req.body);
    if (!parsed.success) return void res.status(400).json(errorBody("INVALID_REQUEST", "Provide valid grade bands."));
    const bands = parsed.data.bands;
    if (!isValidGradeScale(bands)) {
      return void res.status(400).json(errorBody("INVALID_REQUEST", "Grades and thresholds must be unique and include a zero-percent band."));
    }
    try {
      const normalized = [...bands].map((band) => ({ grade: band.grade.trim().toUpperCase(), minPercent: band.minPercent }))
        .sort((a, b) => b.minPercent - a.minPercent);
      const result = await withOrg(user.orgId, async (client) => {
        await client.query(
          `INSERT INTO learning.grade_scales (org_id, bands, updated_by) VALUES ($1,$2::jsonb,$3)
           ON CONFLICT (org_id) DO UPDATE SET bands=EXCLUDED.bands, updated_by=EXCLUDED.updated_by, updated_at=now()`,
          [user.orgId, JSON.stringify(normalized), user.id],
        );
        await audit(client, user.orgId, user.id, "grade_scale.edit", "grade_scale", user.id);
        return { bands: normalized };
      });
      res.json(result);
    } catch (error) { next(error); }
  });
};

export default routes;
