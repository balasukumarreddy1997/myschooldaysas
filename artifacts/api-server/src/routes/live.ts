import { createHash } from "node:crypto";
import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { AccessToken, RoomServiceClient, TrackSource, WebhookReceiver } from "livekit-server-sdk";
import { z } from "zod";
import type { PoolClient, QueryResult } from "@workspace/db";
import { CreateSessionBody } from "@workspace/api-zod";
import { withOrg } from "@workspace/db";
import { createRouteRegistrar } from "../lib/fastify-routes";
import { requireAuth, type CampusRole } from "../lib/auth";
import { classroomAccess, classroomRoom } from "../lib/classroom-access";
import { ensureBoard, boardAccess } from "../lib/classroom-board";
import { attendanceSeconds, mediaGrants } from "../lib/classroom-policy";
import { closeBoardConnections } from "./classroom-board";

const routes: FastifyPluginAsync = async (fastify) => {
const router = createRouteRegistrar(fastify);
const adminRoles: CampusRole[] = ["super_admin", "org_admin", "campus_admin"];
const teacherRoles: CampusRole[] = ["teacher", "class_teacher", "hod"];

function errorBody(code: string, message: string) {
  return { error: { code, message } };
}

function sessionAccess(user: NonNullable<FastifyRequest["campusUser"]>) {
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
  user: NonNullable<FastifyRequest["campusUser"]>,
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
  user: NonNullable<FastifyRequest["campusUser"]>,
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
      await ensureBoard(client, user.orgId, sessionId, row.teacher_user_id);
    } else if (target === "ended" && row.status === "live") {
      const ended = await client.query<{ started_at: Date; ended_at: Date; settings: { minAttendancePct?: number } }>(
        "UPDATE live.sessions SET status = 'ended', ended_at = now(), updated_at = now() WHERE org_id = $1 AND id = $2 RETURNING started_at, ended_at, settings",
        [user.orgId, sessionId],
      );
      await client.query("UPDATE board.boards SET status = 'closed' WHERE org_id = $1 AND session_id = $2", [user.orgId, sessionId]);
      const endedRow = ended.rows[0]!;
      await finalizeAttendance(client, user.orgId, sessionId, endedRow.started_at, endedRow.ended_at, endedRow.settings?.minAttendancePct ?? 50);
    } else if ((target === "live" && row.status !== "live") || (target === "ended" && row.status !== "ended")) {
      throw Object.assign(new Error(`A ${row.status} session cannot be changed to ${target}.`), { status: 409, code: "INVALID_SESSION_STATE" });
    }

    const result = await listVisibleSessions(client, user);
    return result.rows.find((session) => session.id === sessionId);
  });
}

async function finalizeAttendance(client: PoolClient, orgId: string, sessionId: string, start: Date, end: Date, threshold: number) {
  const students = await client.query<{ student_user_id: string }>(
    `SELECT DISTINCT e.student_user_id FROM live.session_sections ss
     JOIN academic.enrollments e ON e.org_id = ss.org_id AND e.section_id = ss.section_id
     WHERE ss.org_id = $1 AND ss.session_id = $2 AND e.status = 'active'`,
    [orgId, sessionId],
  );
  const duration = Math.max(0, (end.getTime() - start.getTime()) / 1000);
  for (const { student_user_id: studentId } of students.rows) {
    const joins = await client.query<{ joined_at: Date; left_at: Date | null }>(
      "SELECT joined_at, left_at FROM live.participants WHERE org_id = $1 AND session_id = $2 AND user_id = $3",
      [orgId, sessionId, studentId],
    );
    const seconds = attendanceSeconds(start.getTime(), end.getTime(), joins.rows.map(row => ({
      joinedAt: row.joined_at.getTime(), leftAt: row.left_at?.getTime() ?? null,
    })));
    const status = seconds > 0 && seconds >= duration * Math.max(0, Math.min(threshold, 100)) / 100 ? "present" : "absent";
    await client.query(
      `INSERT INTO live.session_attendance (org_id, session_id, student_user_id, joined_at, left_at, attendance_status, seconds, source)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'auto')
       ON CONFLICT (org_id, session_id, student_user_id) DO UPDATE
         SET attendance_status = CASE WHEN live.session_attendance.source = 'manual'
              THEN live.session_attendance.attendance_status ELSE EXCLUDED.attendance_status END,
             seconds = EXCLUDED.seconds, left_at = EXCLUDED.left_at`,
      [orgId, sessionId, studentId, start, end, status, seconds],
    );
  }
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
    const boards = await withOrg(user.orgId, client => client.query<{ id: string }>(
      "SELECT id FROM board.boards WHERE org_id = $1 AND session_id = $2", [user.orgId, sessionId],
    ));
    if (boards.rows[0]) closeBoardConnections(boards.rows[0].id);
    if (process.env.LIVEKIT_PUBLIC_URL && process.env.LIVEKIT_INTERNAL_URL && process.env.LIVEKIT_API_KEY && process.env.LIVEKIT_API_SECRET) {
      await new RoomServiceClient(process.env.LIVEKIT_INTERNAL_URL, process.env.LIVEKIT_API_KEY, process.env.LIVEKIT_API_SECRET, { requestTimeout: 8 })
        .deleteRoom(classroomRoom(user.orgId, sessionId));
    }
    if (!session) return void res.status(404).json(errorBody("NOT_FOUND", "Live class not found."));
    res.json(serializeSessions([session])[0]);
  } catch (error) {
    next(error);
  }
});

router.get("/live/sessions/:sessionId/classroom", requireAuth, async (req, res, next) => {
  const user = req.campusUser!;
  const sessionId = req.params.sessionId;
  try {
    const details = await withOrg(user.orgId, async client => {
      const access = await classroomAccess(client, user, sessionId);
      const result = await client.query<{ id: string }>(
        "SELECT id FROM board.boards WHERE org_id = $1 AND session_id = $2", [user.orgId, sessionId],
      );
      const boardId = result.rows[0]?.id ?? null;
      const canDraw = boardId ? (await boardAccess(client, user, boardId)).canDraw : false;
      return {
        session: { id: access.id, title: access.title, status: access.status },
        boardId, role: access.role, canManage: access.canManage, canDraw,
        userId: user.id,
        mediaConfigured: Boolean(process.env.LIVEKIT_PUBLIC_URL && process.env.LIVEKIT_API_KEY && process.env.LIVEKIT_API_SECRET),
      };
    });
    res.json(details);
  } catch (error) { next(error); }
});

const sessionSettings = z.object({
  chatEnabled: z.boolean().optional(),
  lockRoom: z.boolean().optional(),
  parentView: z.boolean().optional(),
  minAttendancePct: z.number().int().min(1).max(100).optional(),
}).strict();

router.patch("/live/sessions/:sessionId/settings", requireAuth, async (req, res, next) => {
  const user = req.campusUser!;
  const parsed = sessionSettings.safeParse(req.body);
  if (!parsed.success || Object.keys(parsed.data).length === 0) {
    return void res.status(400).json(errorBody("INVALID_REQUEST", "Provide valid classroom settings."));
  }
  try {
    const settings = await withOrg(user.orgId, async client => {
      const access = await classroomAccess(client, user, req.params.sessionId);
      if (!access.canManage || ["ended", "cancelled"].includes(access.status)) {
        throw Object.assign(new Error("Only teaching staff can adjust a current classroom."), { status: 403, code: "FORBIDDEN" });
      }
      const { parentView, ...changes } = parsed.data;
      const result = await client.query<{ settings: object; parent_view: boolean }>(
        `UPDATE live.sessions SET settings = settings || $3::jsonb,
           parent_view = COALESCE($4::boolean, parent_view), updated_at = now()
           WHERE org_id = $1 AND id = $2 RETURNING settings, parent_view`,
        [user.orgId, access.id, JSON.stringify(changes), parentView ?? null],
      );
      return { ...result.rows[0]?.settings, parentView: result.rows[0]?.parent_view };
    });
    res.json(settings);
  } catch (error) { next(error); }
});

router.get("/live/sessions/:sessionId/attendance", requireAuth, async (req, res, next) => {
  const user = req.campusUser!;
  try {
    const items = await withOrg(user.orgId, async client => {
      const access = await classroomAccess(client, user, req.params.sessionId);
      const result = await client.query<{
        student_user_id: string; name: string; attendance_status: string; source: string; seconds: number;
      }>(
        `SELECT DISTINCT e.student_user_id, u.name, COALESCE(a.attendance_status, 'pending') attendance_status,
                COALESCE(a.source, 'auto') source, COALESCE(a.seconds, 0) seconds
         FROM live.session_sections ss
         JOIN academic.enrollments e ON e.org_id = ss.org_id AND e.section_id = ss.section_id AND e.status = 'active'
         JOIN identity.users u ON u.org_id = e.org_id AND u.id = e.student_user_id
         LEFT JOIN live.session_attendance a ON a.org_id = ss.org_id AND a.session_id = ss.session_id AND a.student_user_id = e.student_user_id
         WHERE ss.org_id = $1 AND ss.session_id = $2
         AND ($3::boolean OR e.student_user_id = $4 OR ($5::boolean AND EXISTS
           (SELECT 1 FROM identity.guardian_links gl WHERE gl.org_id = e.org_id
             AND gl.guardian_user_id = $4 AND gl.student_user_id = e.student_user_id)))
         ORDER BY u.name`,
        [user.orgId, access.id, access.canManage, user.id, access.role === "viewer"],
      );
      return result.rows.map(row => ({
        studentId: row.student_user_id, name: row.name,
        status: row.attendance_status, source: row.source, seconds: row.seconds,
      }));
    });
    res.json({ items, total: items.length });
  } catch (error) { next(error); }
});

router.post("/live/sessions/:sessionId/attendance", requireAuth, async (req, res, next) => {
  const user = req.campusUser!;
  const parsed = z.object({ studentId: z.string().uuid(), status: z.enum(["present", "late", "absent"]) }).strict().safeParse(req.body);
  if (!parsed.success) return void res.status(400).json(errorBody("INVALID_REQUEST", "Choose a student and attendance status."));
  try {
    await withOrg(user.orgId, async client => {
      const access = await classroomAccess(client, user, req.params.sessionId);
      if (!access.canManage || access.status === "cancelled") {
        throw Object.assign(new Error("Only teaching staff can override attendance."), { status: 403, code: "FORBIDDEN" });
      }
      const member = await client.query(
        `SELECT 1 FROM live.session_sections ss JOIN academic.enrollments e
           ON e.org_id = ss.org_id AND e.section_id = ss.section_id
         WHERE ss.org_id = $1 AND ss.session_id = $2
           AND e.student_user_id = $3 AND e.status = 'active' LIMIT 1`,
        [user.orgId, access.id, parsed.data.studentId],
      );
      if (!member.rowCount) throw Object.assign(new Error("Student is not enrolled in the classroom."), { status: 403, code: "FORBIDDEN" });
      await client.query(
        `INSERT INTO live.session_attendance (org_id, session_id, student_user_id, attendance_status, source)
         VALUES ($1, $2, $3, $4, 'manual')
         ON CONFLICT (org_id, session_id, student_user_id)
         DO UPDATE SET attendance_status = EXCLUDED.attendance_status, source = 'manual'`,
        [user.orgId, access.id, parsed.data.studentId, parsed.data.status],
      );
    });
    res.json({ studentId: parsed.data.studentId, status: parsed.data.status, source: "manual" });
  } catch (error) { next(error); }
});

router.post("/live/sessions/:sessionId/token", requireAuth, async (req, res, next) => {
  const user = req.campusUser;
  if (!user) return void res.status(401).json(errorBody("UNAUTHENTICATED", "Sign in to continue."));
  const sessionId = Array.isArray(req.params.sessionId) ? req.params.sessionId[0] : req.params.sessionId;
  if (!sessionId) return void res.status(400).json(errorBody("INVALID_REQUEST", "A valid session ID is required."));
  try {
    const access = await withOrg(user.orgId, client => classroomAccess(client, user, sessionId));
    if (access.status === "ended" || access.status === "cancelled") {
        throw Object.assign(new Error("This live class has ended."), { status: 409, code: "SESSION_ENDED" });
    }
    if (access.role !== "teacher" && access.status !== "live") {
        throw Object.assign(new Error("This live class has not started yet."), { status: 409, code: "SESSION_NOT_LIVE" });
    }
    if (access.settings?.lockRoom && ["student", "viewer"].includes(access.role)) {
      throw Object.assign(new Error("This classroom is locked."), { status: 403, code: "ROOM_LOCKED" });
    }
    const publicUrl = process.env.LIVEKIT_PUBLIC_URL;
    const apiKey = process.env.LIVEKIT_API_KEY;
    const apiSecret = process.env.LIVEKIT_API_SECRET;
    if (!publicUrl || !apiKey || !apiSecret) {
      return void res.status(503).json(errorBody("REALTIME_UNAVAILABLE", "The classroom service is not configured."));
    }
    const roomName = classroomRoom(user.orgId, sessionId);
    const grants = mediaGrants(access.role, access.settings?.chatEnabled !== false);
    const token = new AccessToken(apiKey, apiSecret, { identity: user.id, name: user.name, ttl: "1h" });
    token.metadata = JSON.stringify({ role: access.role });
    token.addGrant({ roomJoin: true, room: roomName, ...grants });
    res.json({ url: publicUrl, token: await token.toJwt(), roomName });
  } catch (error) {
    next(error);
  }
});

router.post("/live/sessions/:sessionId/participants/:userId/permissions", requireAuth, async (req, res, next) => {
  const user = req.campusUser!;
  const parsed = z.object({ canPublish: z.boolean() }).strict().safeParse(req.body);
  if (!parsed.success) return void res.status(400).json(errorBody("INVALID_REQUEST", "Provide a microphone permission."));
  try {
    await withOrg(user.orgId, async client => {
      const access = await classroomAccess(client, user, req.params.sessionId);
      if (access.role !== "teacher" || access.status !== "live") {
        throw Object.assign(new Error("Only teaching staff may change microphone permissions."), { status: 403, code: "FORBIDDEN" });
      }
      const student = await client.query(
        `SELECT 1 FROM live.session_sections ss JOIN academic.enrollments e
         ON e.org_id = ss.org_id AND e.section_id = ss.section_id
         WHERE ss.org_id = $1 AND ss.session_id = $2 AND e.student_user_id = $3 AND e.status = 'active' LIMIT 1`,
        [user.orgId, access.id, req.params.userId],
      );
      if (!student.rowCount) throw Object.assign(new Error("Only an enrolled student may receive a microphone grant."), { status: 403, code: "FORBIDDEN" });
      const { LIVEKIT_INTERNAL_URL: url, LIVEKIT_API_KEY: key, LIVEKIT_API_SECRET: secret, LIVEKIT_PUBLIC_URL: publicUrl } = process.env;
      if (!url || !key || !secret || !publicUrl) throw Object.assign(new Error("Live media is not configured."), { status: 503, code: "REALTIME_UNAVAILABLE" });
      await new RoomServiceClient(url, key, secret, { requestTimeout: 8 }).updateParticipant(
        classroomRoom(user.orgId, access.id), req.params.userId,
        { permission: { canPublish: parsed.data.canPublish, canPublishSources: [TrackSource.MICROPHONE] } },
      );
    });
    res.json({ userId: req.params.userId, canPublish: parsed.data.canPublish });
  } catch (error) { next(error); }
});

// This parser is encapsulated: every other /live route retains Fastify's normal JSON parser.
await fastify.register(async webhookRoutes => {
  webhookRoutes.removeContentTypeParser("application/json");
  webhookRoutes.addContentTypeParser(["application/json", "application/webhook+json"], { parseAs: "string" }, (_request, body, done) => done(null, body));
  webhookRoutes.post("/live/livekit/webhook", async (request, reply) => {
    const key = process.env.LIVEKIT_API_KEY;
    const secret = process.env.LIVEKIT_API_SECRET;
    if (!key || !secret) return reply.code(503).send(errorBody("REALTIME_UNAVAILABLE", "LiveKit is not configured."));
    let event: Awaited<ReturnType<WebhookReceiver["receive"]>>;
    try {
      event = await new WebhookReceiver(key, secret).receive(
        request.body as string, request.headers.authorization ?? "",
      );
    } catch {
      return reply.code(401).send(errorBody("INVALID_SIGNATURE", "Invalid LiveKit webhook signature."));
    }
    const roomName = event.room?.name ?? "";
    const match = /^campus-([0-9a-f-]{36})-([0-9a-f-]{36})$/i.exec(roomName);
    if (!match || !event.participant?.sid || !event.participant.identity) {
      return reply.send({ accepted: true });
    }
    const [, orgId, sessionId] = match;
    const identity = event.participant.identity;
    if (!z.string().uuid().safeParse(identity).success) return reply.send({ accepted: true });
    const eventId = event.id || createHash("sha256").update(request.body as string).digest("hex");
    const timestamp = Number(event.createdAt) * 1000;
    const occurred = Number.isFinite(timestamp) && timestamp > 0 ? new Date(timestamp) : new Date();
    const handled = await withOrg(orgId, async client => {
      const session = await client.query<{
        id: string; status: string; started_at: Date | null; ended_at: Date | null;
        settings: { minAttendancePct?: number };
      }>(
        "SELECT id, status, started_at, ended_at, settings FROM live.sessions WHERE org_id = $1 AND id = $2 FOR UPDATE",
        [orgId, sessionId],
      );
      const row = session.rows[0];
      if (!row) return false;
      const fresh = await client.query(
        "INSERT INTO live.webhook_events (org_id, event_id) VALUES ($1, $2) ON CONFLICT DO NOTHING RETURNING event_id",
        [orgId, eventId],
      );
      if (!fresh.rowCount) return false;
      const member = await client.query<{ id: string }>(
        "SELECT id FROM identity.users WHERE org_id = $1 AND id = $2", [orgId, identity],
      );
      if (event.event === "participant_joined") {
        await client.query(
          `INSERT INTO live.participants (org_id, session_id, user_id, participant_sid, joined_at)
           VALUES ($1, $2, $3, $4, $5) ON CONFLICT (org_id, session_id, participant_sid)
             DO UPDATE SET joined_at = LEAST(live.participants.joined_at, EXCLUDED.joined_at)`,
          [orgId, sessionId, member.rows[0]?.id ?? null, event.participant!.sid, occurred],
        );
      }
      if (event.event === "participant_left") {
        const joinedTimestamp = Number(event.participant!.joinedAt) * 1000;
        const joinedAt = Number.isFinite(joinedTimestamp) && joinedTimestamp > 0 ? new Date(joinedTimestamp) : occurred;
        await client.query(
          `INSERT INTO live.participants (org_id, session_id, user_id, participant_sid, joined_at, left_at)
           VALUES ($1, $2, $3, $4, $5, GREATEST($5::timestamptz, $6::timestamptz))
           ON CONFLICT (org_id, session_id, participant_sid) DO UPDATE
             SET left_at = COALESCE(live.participants.left_at, EXCLUDED.left_at),
                 joined_at = LEAST(live.participants.joined_at, EXCLUDED.joined_at)`,
          [orgId, sessionId, member.rows[0]?.id ?? null, event.participant!.sid, joinedAt, occurred],
        );
      }
      if (row.status === "ended" && row.started_at && row.ended_at &&
        ["participant_joined", "participant_left"].includes(event.event)) {
        await finalizeAttendance(client, orgId, sessionId, row.started_at, row.ended_at, row.settings?.minAttendancePct ?? 50);
      }
      return true;
    });
    return reply.send({ accepted: handled });
  });
});
};

export default routes;
