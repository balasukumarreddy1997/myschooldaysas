import type { FastifyPluginAsync } from "fastify";
import {
  CreateAnnouncementBody,
  GetAnnouncementsQueryParams,
  MarkAnnouncementReadParams,
  GetAnnouncementStatsParams,
} from "@workspace/api-zod";
import { withOrg } from "@workspace/db";
import { createRouteRegistrar } from "../lib/fastify-routes";
import { requireAuth, type CampusRole } from "../lib/auth";

const adminRoles: CampusRole[] = ["super_admin", "org_admin", "campus_admin"];
const staffRoles: CampusRole[] = [...adminRoles, "hod", "teacher", "class_teacher"];
const errorBody = (code: string, message: string) => ({ error: { code, message } });

type AnnouncementAudience = "school" | "class" | "section" | "role";
type AnnouncementRole = CampusRole;

const audienceSql = `
  (
    $3::boolean
    OR (a.audience = 'school')
    OR (a.audience = 'role' AND a.roles && $4::text[])
    OR (
      a.audience IN ('class', 'section')
      AND (
        EXISTS (
          SELECT 1
            FROM academic.enrollments e
            JOIN academic.sections s ON s.org_id=e.org_id AND s.id=e.section_id
           WHERE e.org_id=a.org_id AND e.student_user_id=$2 AND e.status='active'
             AND (
               (a.audience='section' AND s.id=ANY(a.audience_ids))
               OR (a.audience='class' AND s.class_id=ANY(a.audience_ids))
             )
        )
        OR EXISTS (
          SELECT 1
            FROM identity.guardian_links gl
            JOIN academic.enrollments e
              ON e.org_id=gl.org_id AND e.student_user_id=gl.student_user_id AND e.status='active'
            JOIN academic.sections s ON s.org_id=e.org_id AND s.id=e.section_id
           WHERE gl.org_id=a.org_id AND gl.guardian_user_id=$2
             AND (
               (a.audience='section' AND s.id=ANY(a.audience_ids))
               OR (a.audience='class' AND s.class_id=ANY(a.audience_ids))
             )
        )
        OR EXISTS (
          SELECT 1 FROM academic.section_teachers st
           WHERE st.org_id=a.org_id AND st.teacher_user_id=$2
             AND a.audience='section' AND st.section_id=ANY(a.audience_ids)
        )
        OR EXISTS (
          SELECT 1 FROM academic.teacher_assignments ta
           WHERE ta.org_id=a.org_id AND ta.teacher_user_id=$2
             AND a.audience='section' AND ta.section_id=ANY(a.audience_ids)
        )
        OR EXISTS (
          SELECT 1 FROM academic.sections s
          JOIN academic.section_teachers st ON st.org_id=s.org_id AND st.section_id=s.id
           WHERE s.org_id=a.org_id AND st.teacher_user_id=$2
             AND a.audience='class' AND s.class_id=ANY(a.audience_ids)
        )
        OR EXISTS (
          SELECT 1 FROM academic.sections s
          JOIN academic.teacher_assignments ta ON ta.org_id=s.org_id AND ta.section_id=s.id
           WHERE s.org_id=a.org_id AND ta.teacher_user_id=$2
             AND a.audience='class' AND s.class_id=ANY(a.audience_ids)
        )
      )
    )
  )
`;

function mapAnnouncement(row: any) {
  return {
    id: row.id,
    title: row.title,
    body: row.body,
    audience: row.audience as AnnouncementAudience,
    audienceId: row.audience_id ?? null,
    audienceName: row.audience_name ?? null,
    roles: row.roles as AnnouncementRole[],
    priority: row.priority as "normal" | "urgent",
    publishedAt: row.published_at instanceof Date ? row.published_at.toISOString() : new Date(row.published_at).toISOString(),
    expiresAt: row.expires_at ? (row.expires_at instanceof Date ? row.expires_at.toISOString() : new Date(row.expires_at).toISOString()) : null,
    createdBy: row.created_by,
    authorName: row.author_name,
    readAt: row.read_at ? (row.read_at instanceof Date ? row.read_at.toISOString() : new Date(row.read_at).toISOString()) : null,
  };
}

const routes: FastifyPluginAsync = async (fastify) => {
  const router = createRouteRegistrar(fastify);

  router.get("/announcements", requireAuth, async (req, res, next) => {
    const user = req.campusUser;
    if (!user) return void res.status(401).json(errorBody("UNAUTHENTICATED", "Sign in to continue."));
    const parsed = GetAnnouncementsQueryParams.safeParse(req.query);
    if (!parsed.success) return void res.status(400).json(errorBody("INVALID_REQUEST", "Provide valid announcement filters."));

    try {
      const isAdmin = user.roles.some((role) => adminRoles.includes(role));
      const result = await withOrg(user.orgId, async (client) => {
        const values = [user.orgId, user.id, isAdmin, user.roles, parsed.data.unread === true];
        const where = `a.org_id=$1 AND a.published_at <= now() AND (a.expires_at IS NULL OR a.expires_at > now())
          AND ${audienceSql}
          AND (NOT $5::boolean OR r.read_at IS NULL)`;
        const totalResult = await client.query<{ total: number }>(
          `SELECT count(*)::int AS total
             FROM school.announcements a
             LEFT JOIN school.announcement_reads r
               ON r.org_id=a.org_id AND r.announcement_id=a.id AND r.user_id=$2
            WHERE ${where}`,
          values,
        );
        const page = await client.query(
          `SELECT a.id, a.title, a.body, a.audience, a.audience_ids, a.roles, a.priority,
                  a.published_at, a.expires_at, a.created_by, author.name AS author_name,
                  r.read_at,
                  CASE WHEN a.audience='class' THEN
                    (SELECT c.name FROM academic.classes c WHERE c.org_id=a.org_id AND c.id=a.audience_ids[1])
                       WHEN a.audience='section' THEN
                    (SELECT c.name || ' · ' || s.name FROM academic.sections s
                       JOIN academic.classes c ON c.org_id=s.org_id AND c.id=s.class_id
                      WHERE s.org_id=a.org_id AND s.id=a.audience_ids[1])
                    ELSE NULL END AS audience_name,
                  CASE WHEN a.audience IN ('class','section') THEN a.audience_ids[1] ELSE NULL END AS audience_id
             FROM school.announcements a
             JOIN identity.users author ON author.org_id=a.org_id AND author.id=a.created_by
             LEFT JOIN school.announcement_reads r
               ON r.org_id=a.org_id AND r.announcement_id=a.id AND r.user_id=$2
            WHERE ${where}
            ORDER BY (a.priority='urgent') DESC, a.published_at DESC
            LIMIT 100`,
          values,
        );
        return { items: page.rows.map(mapAnnouncement), total: Number(totalResult.rows[0]?.total ?? 0) };
      });
      res.json(result);
    } catch (error) { next(error); }
  });

  router.post("/announcements", requireAuth, async (req, res, next) => {
    const user = req.campusUser;
    if (!user) return void res.status(401).json(errorBody("UNAUTHENTICATED", "Sign in to continue."));
    if (!user.roles.some((role) => staffRoles.includes(role))) {
      return void res.status(403).json(errorBody("FORBIDDEN", "Only school staff can publish announcements."));
    }
    const parsed = CreateAnnouncementBody.safeParse(req.body);
    if (!parsed.success) return void res.status(400).json(errorBody("INVALID_REQUEST", "Provide valid announcement details."));
    const input = parsed.data;
    const targetedAudience = input.audience === "class" || input.audience === "section";
    if (
      (targetedAudience && !input.audienceId) ||
      (!targetedAudience && input.audienceId) ||
      (input.audience === "role" && !input.roles?.length) ||
      (input.audience !== "role" && input.roles?.length) ||
      (input.expiresAt && new Date(input.expiresAt).getTime() <= Date.now())
    ) {
      return void res.status(400).json(errorBody("INVALID_REQUEST", "The audience, roles, or expiry time is not valid."));
    }
    const isAdmin = user.roles.some((role) => adminRoles.includes(role));
    if (!isAdmin && (input.audience !== "section" || !input.audienceId)) {
      return void res.status(403).json(errorBody("FORBIDDEN", "Teachers can publish announcements only to their assigned sections."));
    }
    if (input.audience === "role" && !isAdmin) {
      return void res.status(403).json(errorBody("FORBIDDEN", "Only school administrators can publish role announcements."));
    }
    try {
      const result = await withOrg(user.orgId, async (client) => {
        if (input.audience === "class" || input.audience === "section") {
          const scope = input.audience === "class"
            ? await client.query("SELECT id FROM academic.classes WHERE org_id=$1 AND id=$2", [user.orgId, input.audienceId])
            : await client.query("SELECT id FROM academic.sections WHERE org_id=$1 AND id=$2", [user.orgId, input.audienceId]);
          if (!scope.rowCount) return { missing: true as const };
          if (!isAdmin) {
            const assigned = await client.query(
              `SELECT 1 FROM academic.section_teachers
                WHERE org_id=$1 AND section_id=$2 AND teacher_user_id=$3
               UNION
               SELECT 1 FROM academic.teacher_assignments
                WHERE org_id=$1 AND section_id=$2 AND teacher_user_id=$3
               LIMIT 1`,
              [user.orgId, input.audienceId, user.id],
            );
            if (!assigned.rowCount) return { forbidden: true as const };
          }
        }
        const inserted = await client.query(
          `INSERT INTO school.announcements
             (org_id, title, body, audience, audience_ids, roles, priority, expires_at, created_by)
           VALUES ($1,$2,$3,$4,$5::uuid[],$6::text[],$7,$8,$9)
           RETURNING id`,
          [
            user.orgId,
            input.title.trim(),
            input.body.trim(),
            input.audience,
            targetedAudience ? [input.audienceId!] : [],
            input.roles ?? [],
            input.priority ?? "normal",
            input.expiresAt ?? null,
            user.id,
          ],
        );
        const announcement = await client.query(
          `SELECT a.id, a.title, a.body, a.audience, a.audience_ids, a.roles, a.priority,
                  a.published_at, a.expires_at, a.created_by, author.name AS author_name,
                  NULL::timestamptz AS read_at,
                  CASE WHEN a.audience='class' THEN
                    (SELECT c.name FROM academic.classes c WHERE c.org_id=a.org_id AND c.id=a.audience_ids[1])
                       WHEN a.audience='section' THEN
                    (SELECT c.name || ' · ' || s.name FROM academic.sections s
                       JOIN academic.classes c ON c.org_id=s.org_id AND c.id=s.class_id
                      WHERE s.org_id=a.org_id AND s.id=a.audience_ids[1])
                    ELSE NULL END AS audience_name,
                  CASE WHEN a.audience IN ('class','section') THEN a.audience_ids[1] ELSE NULL END AS audience_id
             FROM school.announcements a
             JOIN identity.users author ON author.org_id=a.org_id AND author.id=a.created_by
            WHERE a.org_id=$1 AND a.id=$2`,
          [user.orgId, inserted.rows[0].id],
        );
        return { item: mapAnnouncement(announcement.rows[0]) };
      });
      if ("missing" in result) return void res.status(404).json(errorBody("NOT_FOUND", "The selected audience was not found in your organization."));
      if ("forbidden" in result) return void res.status(403).json(errorBody("FORBIDDEN", "You may publish only to sections assigned to you."));
      res.status(201).json(result.item);
    } catch (error) { next(error); }
  });

  router.post("/announcements/:announcementId/read", requireAuth, async (req, res, next) => {
    const user = req.campusUser;
    if (!user) return void res.status(401).json(errorBody("UNAUTHENTICATED", "Sign in to continue."));
    const parsed = MarkAnnouncementReadParams.safeParse(req.params);
    if (!parsed.success) return void res.status(400).json(errorBody("INVALID_REQUEST", "Provide a valid announcement."));
    try {
      const result = await withOrg(user.orgId, async (client) => {
        const visible = await client.query(
          `SELECT a.id FROM school.announcements a
            LEFT JOIN school.announcement_reads r
              ON r.org_id=a.org_id AND r.announcement_id=a.id AND r.user_id=$2
           WHERE a.org_id=$1 AND a.id=$5 AND a.published_at <= now()
             AND (a.expires_at IS NULL OR a.expires_at > now())
             AND ${audienceSql}`,
          [user.orgId, user.id, user.roles.some((role) => adminRoles.includes(role)), user.roles, parsed.data.announcementId],
        );
        if (!visible.rowCount) return { missing: true as const };
        const marked = await client.query(
          `INSERT INTO school.announcement_reads (org_id, announcement_id, user_id)
           VALUES ($1,$2,$3)
           ON CONFLICT (org_id, announcement_id, user_id) DO UPDATE SET read_at=school.announcement_reads.read_at
           RETURNING read_at`,
          [user.orgId, parsed.data.announcementId, user.id],
        );
        const readAt = marked.rows[0].read_at;
        return { readAt: readAt instanceof Date ? readAt.toISOString() : new Date(readAt).toISOString() };
      });
      if ("missing" in result) return void res.status(404).json(errorBody("NOT_FOUND", "Announcement not found."));
      res.json({ readAt: result.readAt });
    } catch (error) { next(error); }
  });

  router.get("/announcements/:announcementId/stats", requireAuth, async (req, res, next) => {
    const user = req.campusUser;
    if (!user) return void res.status(401).json(errorBody("UNAUTHENTICATED", "Sign in to continue."));
    if (!user.roles.some((role) => staffRoles.includes(role))) {
      return void res.status(403).json(errorBody("FORBIDDEN", "Announcement read statistics are available to staff only."));
    }
    const parsed = GetAnnouncementStatsParams.safeParse(req.params);
    if (!parsed.success) return void res.status(400).json(errorBody("INVALID_REQUEST", "Provide a valid announcement."));
    try {
      const result = await withOrg(user.orgId, async (client) => {
        const announcement = await client.query(
          `SELECT created_by
             FROM school.announcements WHERE org_id=$1 AND id=$2`,
          [user.orgId, parsed.data.announcementId],
        );
        if (!announcement.rowCount) return { missing: true as const };
        const row = announcement.rows[0];
        const isAdmin = user.roles.some((role) => adminRoles.includes(role));
        if (!isAdmin && row.created_by !== user.id) {
          return { forbidden: true as const };
        }
        const count = await client.query(
          "SELECT count(*)::int AS total FROM school.announcement_reads WHERE org_id=$1 AND announcement_id=$2",
          [user.orgId, parsed.data.announcementId],
        );
        return { total: Number(count.rows[0]?.total ?? 0) };
      });
      if ("missing" in result) return void res.status(404).json(errorBody("NOT_FOUND", "Announcement not found."));
      if ("forbidden" in result) return void res.status(403).json(errorBody("FORBIDDEN", "You may view statistics only for your own section announcements."));
      res.json(result);
    } catch (error) { next(error); }
  });
};

export default routes;
