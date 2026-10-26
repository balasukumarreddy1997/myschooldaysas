import type { FastifyPluginAsync } from "fastify";
import {
  CreateTimetableSlotBody,
  DeleteTimetableSlotParams,
  GetTimetableQueryParams,
} from "@workspace/api-zod";
import { withOrg } from "@workspace/db";
import { createRouteRegistrar } from "../lib/fastify-routes";
import { requireAuth } from "../lib/auth";
import { canManageAcademicSetup, isValidAcademicTimeRange } from "../lib/academic-scheduling-policy";

const teacherRoles = ["teacher", "class_teacher", "hod"];
const errorBody = (code: string, message: string) => ({ error: { code, message } });

const routes: FastifyPluginAsync = async (fastify) => {
  const router = createRouteRegistrar(fastify);

  router.get("/academic/timetable", requireAuth, async (req, res, next) => {
    const user = req.campusUser;
    if (!user) return void res.status(401).json(errorBody("UNAUTHENTICATED", "Sign in to continue."));
    const parsed = GetTimetableQueryParams.safeParse(req.query);
    if (!parsed.success) {
      return void res.status(400).json(errorBody("INVALID_REQUEST", "Provide a valid section ID."));
    }
    const isAdmin = canManageAcademicSetup(user.roles);
    const isTeacher = user.roles.some((role) => teacherRoles.includes(role));
    const isStudent = user.roles.includes("student");
    const isParent = user.roles.includes("parent");

    try {
      const result = await withOrg(user.orgId, (client) =>
        client.query(
          `SELECT slot.id, slot.section_id, section.name AS section_name,
                  slot.subject_id, subject.name AS subject_name,
                  slot.teacher_user_id AS teacher_id, teacher.name AS teacher_name,
                  slot.weekday, slot.start_time::text, slot.end_time::text, slot.room
             FROM academic.timetable_slots slot
             JOIN academic.sections section
               ON section.org_id = slot.org_id AND section.id = slot.section_id
             JOIN academic.subjects subject
               ON subject.org_id = slot.org_id AND subject.id = slot.subject_id
             JOIN identity.users teacher
               ON teacher.org_id = slot.org_id AND teacher.id = slot.teacher_user_id
            WHERE slot.org_id = $1
              AND ($2::uuid IS NULL OR slot.section_id = $2)
              AND (
                $3::boolean
                OR ($4::boolean AND slot.teacher_user_id = $5)
                OR ($6::boolean AND EXISTS (
                  SELECT 1 FROM academic.enrollments enrollment
                   WHERE enrollment.org_id = slot.org_id
                     AND enrollment.section_id = slot.section_id
                     AND enrollment.student_user_id = $5
                     AND enrollment.status = 'active'
                ))
                OR ($7::boolean AND EXISTS (
                  SELECT 1
                    FROM identity.guardian_links guardian
                    JOIN academic.enrollments enrollment
                      ON enrollment.org_id = guardian.org_id
                     AND enrollment.student_user_id = guardian.student_user_id
                   WHERE guardian.org_id = slot.org_id
                     AND guardian.guardian_user_id = $5
                     AND enrollment.section_id = slot.section_id
                     AND enrollment.status = 'active'
                ))
              )
            ORDER BY slot.weekday, slot.start_time, section.name, subject.name`,
          [
            user.orgId,
            parsed.data.sectionId ?? null,
            isAdmin,
            isTeacher,
            user.id,
            isStudent,
            isParent,
          ],
        ),
      );
      res.json({
        items: result.rows.map((row) => ({
          id: row.id,
          sectionId: row.section_id,
          sectionName: row.section_name,
          subjectId: row.subject_id,
          subjectName: row.subject_name,
          teacherId: row.teacher_id,
          teacherName: row.teacher_name,
          weekday: Number(row.weekday),
          startTime: String(row.start_time).slice(0, 5),
          endTime: String(row.end_time).slice(0, 5),
          room: row.room,
        })),
        total: result.rowCount ?? result.rows.length,
      });
    } catch (error) {
      next(error);
    }
  });

  router.post("/academic/timetable", requireAuth, async (req, res, next) => {
    const user = req.campusUser;
    if (!user) return void res.status(401).json(errorBody("UNAUTHENTICATED", "Sign in to continue."));
    if (!canManageAcademicSetup(user.roles)) {
      return void res.status(403).json(errorBody("FORBIDDEN", "Only administrators can manage the timetable."));
    }
    const parsed = CreateTimetableSlotBody.safeParse(req.body);
    if (
      !parsed.success ||
      !isValidAcademicTimeRange(parsed.data.startTime, parsed.data.endTime) ||
      (parsed.data.room !== undefined && parsed.data.room !== null && parsed.data.room.trim().length > 80)
    ) {
      return void res.status(400).json(errorBody("INVALID_REQUEST", "Provide a valid timetable slot and time range."));
    }

    try {
      const created = await withOrg(user.orgId, async (client) => {
        await client.query("SELECT pg_advisory_xact_lock(hashtext($1), $2)", [user.orgId, parsed.data.weekday]);
        const assignment = await client.query(
          `SELECT 1 FROM academic.teacher_assignments
            WHERE org_id = $1 AND section_id = $2
              AND subject_id = $3 AND teacher_user_id = $4`,
          [user.orgId, parsed.data.sectionId, parsed.data.subjectId, parsed.data.teacherId],
        );
        if (!assignment.rowCount) return { kind: "invalid-assignment" as const };

        const conflict = await client.query(
          `SELECT 1
             FROM academic.timetable_slots
            WHERE org_id = $1 AND weekday = $2
              AND (section_id = $3 OR teacher_user_id = $4)
              AND start_time < $6::time AND end_time > $5::time
            LIMIT 1`,
          [
            user.orgId,
            parsed.data.weekday,
            parsed.data.sectionId,
            parsed.data.teacherId,
            parsed.data.startTime,
            parsed.data.endTime,
          ],
        );
        if (conflict.rowCount) return { kind: "conflict" as const };

        const inserted = await client.query(
          `INSERT INTO academic.timetable_slots
            (org_id, section_id, subject_id, teacher_user_id, weekday, start_time, end_time, room)
           VALUES ($1, $2, $3, $4, $5, $6::time, $7::time, $8)
           RETURNING id`,
          [
            user.orgId,
            parsed.data.sectionId,
            parsed.data.subjectId,
            parsed.data.teacherId,
            parsed.data.weekday,
            parsed.data.startTime,
            parsed.data.endTime,
            parsed.data.room?.trim() || null,
          ],
        );
        const result = await client.query(
          `SELECT slot.id, slot.section_id, section.name AS section_name,
                  slot.subject_id, subject.name AS subject_name,
                  slot.teacher_user_id AS teacher_id, teacher.name AS teacher_name,
                  slot.weekday, slot.start_time::text, slot.end_time::text, slot.room
             FROM academic.timetable_slots slot
             JOIN academic.sections section
               ON section.org_id = slot.org_id AND section.id = slot.section_id
             JOIN academic.subjects subject
               ON subject.org_id = slot.org_id AND subject.id = slot.subject_id
             JOIN identity.users teacher
               ON teacher.org_id = slot.org_id AND teacher.id = slot.teacher_user_id
            WHERE slot.org_id = $1 AND slot.id = $2`,
          [user.orgId, inserted.rows[0].id],
        );
        const row = result.rows[0];
        return {
          kind: "created" as const,
          item: {
            id: row.id,
            sectionId: row.section_id,
            sectionName: row.section_name,
            subjectId: row.subject_id,
            subjectName: row.subject_name,
            teacherId: row.teacher_id,
            teacherName: row.teacher_name,
            weekday: Number(row.weekday),
            startTime: String(row.start_time).slice(0, 5),
            endTime: String(row.end_time).slice(0, 5),
            room: row.room,
          },
        };
      });
      if (created.kind === "invalid-assignment") {
        return void res.status(400).json(errorBody("INVALID_REQUEST", "The teacher is not assigned to that section and subject."));
      }
      if (created.kind === "conflict") {
        return void res.status(409).json(errorBody("CONFLICT", "The section or teacher already has a timetable slot during that time."));
      }
      res.status(201).json(created.item);
    } catch (error) {
      next(error);
    }
  });

  router.delete("/academic/timetable/:slotId", requireAuth, async (req, res, next) => {
    const user = req.campusUser;
    if (!user) return void res.status(401).json(errorBody("UNAUTHENTICATED", "Sign in to continue."));
    if (!canManageAcademicSetup(user.roles)) {
      return void res.status(403).json(errorBody("FORBIDDEN", "Only administrators can manage the timetable."));
    }
    const params = DeleteTimetableSlotParams.safeParse(req.params);
    if (!params.success) return void res.status(400).json(errorBody("INVALID_REQUEST", "Provide a valid timetable slot ID."));
    try {
      const deleted = await withOrg(user.orgId, (client) =>
        client.query(
          "DELETE FROM academic.timetable_slots WHERE org_id = $1 AND id = $2 RETURNING id",
          [user.orgId, params.data.slotId],
        ),
      );
      if (!deleted.rowCount) return void res.status(404).json(errorBody("NOT_FOUND", "Timetable slot not found."));
      res.status(204).send();
    } catch (error) {
      next(error);
    }
  });
};

export default routes;
