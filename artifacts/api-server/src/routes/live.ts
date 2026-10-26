import { createHmac } from "node:crypto";
import { Router } from "express";
import type { PoolClient, QueryResult } from "@workspace/db";
import { CreateSessionBody } from "@workspace/api-zod";
import { withOrg } from "@workspace/db";
import { requireAuth, type CampusRole } from "../lib/auth";

const router = Router();
const adminRoles: CampusRole[] = ["super_admin", "org_admin", "campus_admin"];
const teacherRoles: CampusRole[] = ["teacher", "class_teacher", "hod"];

function errorBody(code: string, message: string) {
  return { error: { code, message } };
}

function sessionAccess(user: NonNullable<Express.Request["campusUser"]>) {
  return {
    isAdmin: user.roles.some((role) => adminRoles.includes(role)),
    isTeacher: user.roles.some((role) => teacherRoles.includes(role)),
    isStudent: user.roles.includes("student"),
    isParent: user.roles.includes("parent"),
  };
}

interface LiveSessionRow extends Record<string, unknown> {
  id: string;
  title: string;
  teacher_name: string;
  mode: string;
  status: string;
  starts_at: Date;
  parent_view: boolean;
  sections: string[];
}

async function listVisibleSessions(
  client: PoolClient,
  user: NonNullable<Express.Request["campusUser"]>,
  upcomingOnly = false,
): Promise<QueryResult<LiveSessionRow>> {
  const flags = sessionAccess(user);
  return client.query<LiveSessionRow>(
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
      WHERE s.org_id = $1
        AND ($2::boolean OR s.teacher_user_id = $3
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
               AND gl.guardian_user_id = $3 AND e.status = 'active'
          )))
        AND (NOT $7::boolean OR (s.status IN ('scheduled', 'live') AND s.starts_at >= now() - interval '2 hours'))
      GROUP BY s.id, teacher.name
      ORDER BY s.starts_at DESC
      LIMIT 100`,
    [
      user.orgId,
      flags.isAdmin,
      user.id,
      flags.isTeacher,
      flags.isStudent,
      flags.isParent,
      upcomingOnly,
    ],
  );
}

function serializeSessions(rows: LiveSessionRow[]) {
  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    teacherName: row.teacher_name,
    mode: row.mode,
    status: row.status,
    startAt: row.starts_at,
    parentView: row.parent_view,
    sections: row.sections,
  }));
}

router.get("/live/sessions", requireAuth, async (req, res, next) => {
  const user = req.campusUser;
  if (!user) return void res.status(401).json(errorBody("UNAUTHENTICATED", "Sign in to continue."));
  try {
    const result = await withOrg(user.orgId, (client) => listVisibleSessions(client, user));
    res.json({ items: serializeSessions(result.rows), total: result.rowCount ?? 0 });
  } catch (error) {
    next(error);
  }
});

router.post("/live/sessions", requireAuth, async (req, res, next) => {
  const user = req.campusUser;
  if (!user) return void res.status(401).json(errorBody("UNAUTHENTICATED", "Sign in to continue."));
  const parsed = CreateSessionBody.safeParse(req.body);
  if (!parsed.success) return void res.status(400).json(errorBody("INVALID_REQUEST", "Check the live class details."));

  const flags = sessionAccess(user);
  if (!flags.isAdmin && !flags.isTeacher) {
    return void res.status(403).json(errorBody("FORBIDDEN", "Only school administrators and teaching staff can schedule classes."));
  }

  const { title, mode, startAt, classId, sectionIds, parentView } = parsed.data;
  if (mode === "class" && !classId) {
    return void res.status(400).json(errorBody("INVALID_REQUEST", "Choose a class for a whole-class session."));
  }

  try {
    const session = await withOrg(user.orgId, async (client) => {
      const sections = await client.query<{ id: string; class_id: string }>(
        `SELECT s.id, s.class_id
           FROM academic.sections s
          WHERE s.org_id = $1 AND s.id = ANY($2::uuid[])`,
        [user.orgId, sectionIds],
      );
      if (sections.rowCount !== sectionIds.length) {
        throw Object.assign(new Error("One or more selected sections are unavailable."), { status: 400, code: "INVALID_SECTIONS" });
      }
      if (mode === "class" && sections.rows.some((section) => section.class_id !== classId)) {
        throw Object.assign(new Error("A selected section does not belong to the chosen class."), { status: 400, code: "INVALID_SECTIONS" });
      }
      if (flags.isTeacher && !flags.isAdmin) {
        const assigned = await client.query<{ count: string }>(
          `SELECT COUNT(DISTINCT section_id)::text AS count
             FROM academic.section_teachers
            WHERE org_id = $1 AND teacher_user_id = $2 AND section_id = ANY($3::uuid[])`,
          [user.orgId, user.id, sectionIds],
        );
        if (Number(assigned.rows[0]?.count ?? 0) !== sectionIds.length) {
          throw Object.assign(new Error("You can schedule classes only for sections assigned to you."), { status: 403, code: "FORBIDDEN" });
        }
      }

      const inserted = await client.query<{ id: string }>(
        `INSERT INTO live.sessions
           (org_id, title, teacher_user_id, mode, starts_at, parent_view)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id`,
        [user.orgId, title.trim(), user.id, mode, startAt, parentView],
      );
      const sessionId = inserted.rows[0]?.id;
      if (!sessionId) throw new Error("Failed to create the live class.");
      for (const sectionId of sectionIds) {
        await client.query(
          "INSERT INTO live.session_sections (org_id, session_id, section_id) VALUES ($1, $2, $3)",
          [user.orgId, sessionId, sectionId],
        );
      }
      const details = await listVisibleSessions(client, user);
      return details.rows.find((row) => row.id === sessionId);
    });
    if (!session) return void res.status(500).json(errorBody("INTERNAL_ERROR", "The live class could not be created."));
    res.status(201).json(serializeSessions([session])[0]);
  } catch (error) {
    next(error);
  }
});

async function changeSessionStatus(
  sessionId: string,
  user: NonNullable<Express.Request["campusUser"]>,
  target: "live" | "ended",
) {
  return withOrg(user.orgId, async (client) => {
    const found = await client.query<{
      id: string;
      status: string;
      teacher_user_id: string;
    }>(
      "SELECT id, status, teacher_user_id FROM live.sessions WHERE org_id = $1 AND id = $2 FOR UPDATE",
      [user.orgId, sessionId],
    );
    const row = found.rows[0];
    if (!row) throw Object.assign(new Error("Live class not found."), { status: 404, code: "NOT_FOUND" });
    const flags = sessionAccess(user);
    if (!flags.isAdmin && (row.teacher_user_id !== user.id || !flags.isTeacher)) {
      throw Object.assign(new Error("Only the session teacher or a school administrator can change its status."), { status: 403, code: "FORBIDDEN" });
    }

    if (target === "live" && row.status === "scheduled") {
      await client.query(
        "UPDATE live.sessions SET status = 'live', started_at = now(), updated_at = now() WHERE org_id = $1 AND id = $2",
        [user.orgId, sessionId],
      );
    } else if (target === "ended" && row.status === "live") {
      await client.query(
        "UPDATE live.sessions SET status = 'ended', ended_at = now(), updated_at = now() WHERE org_id = $1 AND id = $2",
        [user.orgId, sessionId],
      );
    } else if ((target === "live" && row.status !== "live") || (target === "ended" && row.status !== "ended")) {
      throw Object.assign(new Error(`A ${row.status} session cannot be changed to ${target}.`), { status: 409, code: "INVALID_SESSION_STATE" });
    }

    const result = await listVisibleSessions(client, user);
    return result.rows.find((session) => session.id === sessionId);
  });
}

router.post("/live/sessions/:sessionId/start", requireAuth, async (req, res, next) => {
  const user = req.campusUser;
  if (!user) return void res.status(401).json(errorBody("UNAUTHENTICATED", "Sign in to continue."));
  const sessionId = Array.isArray(req.params.sessionId) ? req.params.sessionId[0] : req.params.sessionId;
  if (!sessionId) return void res.status(400).json(errorBody("INVALID_REQUEST", "A valid session ID is required."));
  try {
    const session = await changeSessionStatus(sessionId, user, "live");
    if (!session) return void res.status(404).json(errorBody("NOT_FOUND", "Live class not found."));
    res.json(serializeSessions([session])[0]);
  } catch (error) {
    next(error);
  }
});

router.post("/live/sessions/:sessionId/end", requireAuth, async (req, res, next) => {
  const user = req.campusUser;
  if (!user) return void res.status(401).json(errorBody("UNAUTHENTICATED", "Sign in to continue."));
  const sessionId = Array.isArray(req.params.sessionId) ? req.params.sessionId[0] : req.params.sessionId;
  if (!sessionId) return void res.status(400).json(errorBody("INVALID_REQUEST", "A valid session ID is required."));
  try {
    const session = await changeSessionStatus(sessionId, user, "ended");
    if (!session) return void res.status(404).json(errorBody("NOT_FOUND", "Live class not found."));
    res.json(serializeSessions([session])[0]);
  } catch (error) {
    next(error);
  }
});

router.post("/live/sessions/:sessionId/token", requireAuth, async (req, res, next) => {
  const user = req.campusUser;
  if (!user) return void res.status(401).json(errorBody("UNAUTHENTICATED", "Sign in to continue."));
  const sessionId = Array.isArray(req.params.sessionId) ? req.params.sessionId[0] : req.params.sessionId;
  if (!sessionId) return void res.status(400).json(errorBody("INVALID_REQUEST", "A valid session ID is required."));
  const publicUrl = process.env.LIVEKIT_PUBLIC_URL;
  const apiKey = process.env.LIVEKIT_API_KEY;
  const apiSecret = process.env.LIVEKIT_API_SECRET;

  try {
    const grant = await withOrg(user.orgId, async (client) => {
      const result = await client.query<{
        id: string;
        status: string;
        teacher_user_id: string;
        parent_view: boolean;
        assigned_teacher: boolean;
        enrolled_student: boolean;
        linked_parent: boolean;
        live_view_consented: boolean;
        students_can_draw: boolean;
      }>(
        `SELECT s.id, s.status, s.teacher_user_id, s.parent_view,
                EXISTS (
                  SELECT 1 FROM live.session_sections ss
                  JOIN academic.section_teachers st
                    ON st.section_id = ss.section_id AND st.org_id = ss.org_id
                  WHERE ss.org_id = s.org_id AND ss.session_id = s.id
                    AND st.teacher_user_id = $3
                ) AS assigned_teacher,
                EXISTS (
                  SELECT 1 FROM live.session_sections ss
                  JOIN academic.enrollments e
                    ON e.section_id = ss.section_id AND e.org_id = ss.org_id
                  WHERE ss.org_id = s.org_id AND ss.session_id = s.id
                    AND e.student_user_id = $3 AND e.status = 'active'
                ) AS enrolled_student,
                EXISTS (
                  SELECT 1 FROM live.session_sections ss
                  JOIN academic.enrollments e
                    ON e.section_id = ss.section_id AND e.org_id = ss.org_id
                  JOIN identity.guardian_links gl
                    ON gl.student_user_id = e.student_user_id AND gl.org_id = e.org_id
                  WHERE ss.org_id = s.org_id AND ss.session_id = s.id
                    AND gl.guardian_user_id = $3 AND e.status = 'active'
                ) AS linked_parent,
                EXISTS (
                  SELECT 1 FROM live.session_sections ss
                  JOIN academic.enrollments e
                    ON e.section_id = ss.section_id AND e.org_id = ss.org_id
                  JOIN identity.guardian_links gl
                    ON gl.student_user_id = e.student_user_id AND gl.org_id = e.org_id
                  JOIN academic.consents consent
                    ON consent.org_id = e.org_id AND consent.parent_id = gl.guardian_user_id
                   AND consent.student_id = e.student_user_id
                   AND consent.purpose = 'live_view' AND consent.revoked_at IS NULL
                  WHERE ss.org_id = s.org_id AND ss.session_id = s.id
                    AND gl.guardian_user_id = $3 AND e.status = 'active'
                ) AS live_view_consented,
                COALESCE((
                  SELECT (bt.config->'participants'->>'studentsCanDraw')::boolean
                    FROM board.templates bt
                   WHERE bt.org_id = s.org_id AND bt.is_default = true
                   ORDER BY bt.updated_at DESC
                   LIMIT 1
                ), false) AS students_can_draw
           FROM live.sessions s
          WHERE s.org_id = $1 AND s.id = $2`,
        [user.orgId, sessionId, user.id],
      );
      const session = result.rows[0];
      if (!session) throw Object.assign(new Error("Live class not found."), { status: 404, code: "NOT_FOUND" });

      const flags = sessionAccess(user);
      const isOwner = session.teacher_user_id === user.id;
      const authorized =
        flags.isAdmin ||
        isOwner ||
        (flags.isTeacher && session.assigned_teacher) ||
        (flags.isStudent && session.enrolled_student) ||
        (flags.isParent && session.parent_view && session.linked_parent && session.live_view_consented);
      if (!authorized) throw Object.assign(new Error("You are not a participant in this live class."), { status: 403, code: "FORBIDDEN" });
      if (session.status === "ended" || session.status === "cancelled") {
        throw Object.assign(new Error("This live class has ended."), { status: 409, code: "SESSION_ENDED" });
      }
      if (!flags.isAdmin && !flags.isTeacher && session.status !== "live") {
        throw Object.assign(new Error("This live class has not started yet."), { status: 409, code: "SESSION_NOT_LIVE" });
      }

      const canPublish =
        (flags.isTeacher && (isOwner || session.assigned_teacher)) ||
        (flags.isStudent && session.students_can_draw);
      return {
        roomName: `campus-${user.orgId}-${session.id}`,
        canPublish,
      };
    });
    if (!publicUrl || !apiKey || !apiSecret) {
      return void res.status(503).json(errorBody("REALTIME_UNAVAILABLE", "The classroom service is not configured."));
    }

    const now = Math.floor(Date.now() / 1000);
    const roomName = grant.roomName;
    const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
    const payload = Buffer.from(
      JSON.stringify({
        iss: apiKey,
        sub: user.id,
        name: user.name,
        iat: now,
        nbf: now,
        exp: now + 60 * 60,
        metadata: JSON.stringify({ orgId: user.orgId, roles: user.roles }),
        video: {
          roomJoin: true,
          room: roomName,
          canPublish: grant.canPublish,
          canPublishData: grant.canPublish,
          canSubscribe: true,
        },
      }),
    ).toString("base64url");
    const content = `${header}.${payload}`;
    const signature = createHmac("sha256", apiSecret).update(content).digest("base64url");
    res.json({ url: publicUrl, token: `${content}.${signature}`, roomName });
  } catch (error) {
    next(error);
  }
});

export default router;
