import type { FastifyPluginAsync } from "fastify";
import {
  CreatePublicAdmissionEnquiryBody,
  GetAdmissionEnquiriesQueryParams,
  UpdateAdmissionEnquiryBody,
  UpdateAdmissionEnquiryParams,
} from "@workspace/api-zod";
import { pool, withOrg } from "@workspace/db";
import { createRouteRegistrar } from "../lib/fastify-routes";
import { requireAuth, type CampusRole } from "../lib/auth";
import { createFixedWindowRateLimiter } from "../lib/admission-policy";

const adminRoles: CampusRole[] = ["super_admin", "org_admin", "campus_admin"];
const errorBody = (code: string, message: string) => ({ error: { code, message } });
const allowPublicEnquiry = createFixedWindowRateLimiter(10, 15 * 60 * 1000);

type EnquiryStatus =
  | "new"
  | "contacted"
  | "visit_scheduled"
  | "application_issued"
  | "closed"
  | "lost";

type EnquiryRow = {
  id: string;
  child_name: string;
  date_of_birth: string | Date | null;
  class_applying: string;
  guardian_name: string;
  guardian_phone: string;
  guardian_email: string | null;
  source: "walk-in" | "web" | "referral" | "campaign" | "other";
  notes: string | null;
  status: EnquiryStatus;
  follow_up_on: string | Date | null;
  created_at: string | Date;
  updated_at: string | Date;
  activity: Array<{
    id: string;
    action: "submitted" | "status_changed" | "follow_up_changed" | "note_added";
    note: string | null;
    previousStatus: EnquiryStatus | null;
    nextStatus: EnquiryStatus | null;
    previousFollowUpOn: string | Date | null;
    nextFollowUpOn: string | Date | null;
    actorName: string | null;
    createdAt: string | Date;
  }>;
};

function dateValue(value: string | Date | null): string | null {
  if (value === null) return null;
  return value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10);
}

function dateTimeValue(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

const enquirySelect = `
  SELECT e.id, e.child_name, e.date_of_birth, e.class_applying, e.guardian_name,
         e.guardian_phone, e.guardian_email, e.source, e.notes, e.status,
         e.follow_up_on, e.created_at, e.updated_at,
         COALESCE((
           SELECT json_agg(
             json_build_object(
               'id', a.id,
               'action', a.action,
               'note', a.note,
               'previousStatus', a.previous_status,
               'nextStatus', a.next_status,
               'previousFollowUpOn', a.previous_follow_up_on,
               'nextFollowUpOn', a.next_follow_up_on,
               'actorName', actor.name,
               'createdAt', a.created_at
             ) ORDER BY a.created_at DESC
           )
           FROM (
             SELECT activity.*
               FROM registry.admission_activity activity
              WHERE activity.org_id = e.org_id AND activity.enquiry_id = e.id
              ORDER BY activity.created_at DESC
              LIMIT 10
           ) a
           LEFT JOIN identity.users actor
             ON actor.org_id = a.org_id AND actor.id = a.actor_id
         ), '[]'::json) AS activity
    FROM registry.admission_enquiries e
`;

function mapEnquiry(row: EnquiryRow) {
  return {
    id: row.id,
    childName: row.child_name,
    dateOfBirth: dateValue(row.date_of_birth),
    classApplying: row.class_applying,
    guardianName: row.guardian_name,
    guardianPhone: row.guardian_phone,
    guardianEmail: row.guardian_email,
    source: row.source,
    notes: row.notes,
    status: row.status,
    followUpOn: dateValue(row.follow_up_on),
    createdAt: dateTimeValue(row.created_at),
    updatedAt: dateTimeValue(row.updated_at),
    activity: row.activity.map((item) => ({
      ...item,
      previousFollowUpOn: dateValue(item.previousFollowUpOn),
      nextFollowUpOn: dateValue(item.nextFollowUpOn),
      createdAt: dateTimeValue(item.createdAt),
    })),
  };
}

const routes: FastifyPluginAsync = async (fastify) => {
  const router = createRouteRegistrar(fastify);

  router.post("/registry/public/enquiry", async (req, res, next) => {
    if (!allowPublicEnquiry(req.ip)) {
      return void res.status(429).json(errorBody("RATE_LIMITED", "Too many enquiries from this connection. Please try again later."));
    }
    const parsed = CreatePublicAdmissionEnquiryBody.safeParse(req.body);
    if (!parsed.success) {
      return void res.status(400).json(errorBody("INVALID_REQUEST", "Provide valid child and guardian contact details."));
    }

    try {
      const orgResult = await pool.query<{ id: string }>(
        "SELECT id FROM identity.organizations WHERE slug = $1 LIMIT 1",
        [parsed.data.orgSlug.trim().toLowerCase()],
      );
      const orgId = orgResult.rows[0]?.id;
      if (!orgId) return void res.status(404).json(errorBody("NOT_FOUND", "School not found."));

      const enquiryId = await withOrg(orgId, async (client) => {
        const enquiry = await client.query<{ id: string }>(
          `INSERT INTO registry.admission_enquiries
             (org_id, child_name, date_of_birth, class_applying, guardian_name,
              guardian_phone, guardian_email, source, notes)
           VALUES ($1, $2, $3, $4, $5, $6, $7, 'web', $8)
           RETURNING id`,
          [
            orgId,
            parsed.data.childName.trim(),
            parsed.data.dateOfBirth ?? null,
            parsed.data.classApplying.trim(),
            parsed.data.guardianName.trim(),
            parsed.data.guardianPhone.trim(),
            parsed.data.guardianEmail?.trim().toLowerCase() ?? null,
            parsed.data.notes?.trim() || null,
          ],
        );
        const id = enquiry.rows[0]!.id;
        await client.query(
          `INSERT INTO registry.admission_activity (org_id, enquiry_id, action)
           VALUES ($1, $2, 'submitted')`,
          [orgId, id],
        );
        return id;
      });

      res.status(201).json({ id: enquiryId, status: "new" });
    } catch (error) {
      next(error);
    }
  });

  router.get("/registry/enquiries", requireAuth, async (req, res, next) => {
    const user = req.campusUser;
    if (!user) return void res.status(401).json(errorBody("UNAUTHENTICATED", "Sign in to continue."));
    if (!user.roles.some((role) => adminRoles.includes(role))) {
      return void res.status(403).json(errorBody("FORBIDDEN", "Administrator role required."));
    }
    const parsed = GetAdmissionEnquiriesQueryParams.safeParse(req.query);
    if (!parsed.success) return void res.status(400).json(errorBody("INVALID_REQUEST", "Provide valid enquiry filters."));
    const limit = parsed.data.limit ?? 50;
    const offset = parsed.data.offset ?? 0;
    const status = parsed.data.status ?? null;
    const search = parsed.data.search?.trim() || null;

    try {
      const page = await withOrg(user.orgId, async (client) => {
        const count = await client.query<{ total: string }>(
          `SELECT COUNT(*)::text AS total
             FROM registry.admission_enquiries e
            WHERE e.org_id = $1
              AND ($2::text IS NULL OR e.status = $2)
              AND ($3::text IS NULL OR
                   e.child_name ILIKE $3 OR e.guardian_name ILIKE $3 OR
                   e.guardian_phone ILIKE $3 OR e.guardian_email ILIKE $3 OR e.class_applying ILIKE $3)`,
          [user.orgId, status, search ? `%${search}%` : null],
        );
        const rows = await client.query<EnquiryRow>(
          `${enquirySelect}
            WHERE e.org_id = $1
              AND ($2::text IS NULL OR e.status = $2)
              AND ($3::text IS NULL OR
                   e.child_name ILIKE $3 OR e.guardian_name ILIKE $3 OR
                   e.guardian_phone ILIKE $3 OR e.guardian_email ILIKE $3 OR e.class_applying ILIKE $3)
            ORDER BY e.created_at DESC, e.id DESC
            LIMIT $4 OFFSET $5`,
          [user.orgId, status, search ? `%${search}%` : null, limit, offset],
        );
        return { items: rows.rows.map(mapEnquiry), total: Number(count.rows[0]?.total ?? 0) };
      });
      res.json(page);
    } catch (error) {
      next(error);
    }
  });

  router.patch("/registry/enquiries/:enquiryId", requireAuth, async (req, res, next) => {
    const user = req.campusUser;
    if (!user) return void res.status(401).json(errorBody("UNAUTHENTICATED", "Sign in to continue."));
    if (!user.roles.some((role) => adminRoles.includes(role))) {
      return void res.status(403).json(errorBody("FORBIDDEN", "Administrator role required."));
    }
    const parsedParams = UpdateAdmissionEnquiryParams.safeParse(req.params);
    const parsedBody = UpdateAdmissionEnquiryBody.safeParse(req.body);
    if (!parsedParams.success || !parsedBody.success) {
      return void res.status(400).json(errorBody("INVALID_REQUEST", "Provide valid enquiry update details."));
    }

    try {
      const updated = await withOrg(user.orgId, async (client) => {
        const currentResult = await client.query<{
          status: EnquiryStatus;
          follow_up_on: string | Date | null;
        }>(
          `SELECT status, follow_up_on
             FROM registry.admission_enquiries
            WHERE org_id = $1 AND id = $2
            FOR UPDATE`,
          [user.orgId, parsedParams.data.enquiryId],
        );
        const current = currentResult.rows[0];
        if (!current) return null;

        const input = parsedBody.data;
        const statusChanged = current.status !== input.status;
        const hasFollowUp = Object.hasOwn(input, "followUpOn");
        const nextFollowUp = hasFollowUp ? input.followUpOn ?? null : dateValue(current.follow_up_on);
        const followUpChanged = hasFollowUp && dateValue(current.follow_up_on) !== nextFollowUp;
        const note = input.note?.trim() || null;

        await client.query(
          `UPDATE registry.admission_enquiries
              SET status = $3, follow_up_on = $4, updated_by = $5, updated_at = now()
            WHERE org_id = $1 AND id = $2`,
          [user.orgId, parsedParams.data.enquiryId, input.status, nextFollowUp, user.id],
        );
        if (statusChanged) {
          await client.query(
            `INSERT INTO registry.admission_activity
               (org_id, enquiry_id, action, previous_status, next_status, actor_id)
             VALUES ($1, $2, 'status_changed', $3, $4, $5)`,
            [user.orgId, parsedParams.data.enquiryId, current.status, input.status, user.id],
          );
        }
        if (followUpChanged) {
          await client.query(
            `INSERT INTO registry.admission_activity
               (org_id, enquiry_id, action, previous_status, next_status,
                previous_follow_up_on, next_follow_up_on, actor_id)
             VALUES ($1, $2, 'follow_up_changed', $3, $4, $5, $6, $7)`,
            [user.orgId, parsedParams.data.enquiryId, current.status, input.status, dateValue(current.follow_up_on), nextFollowUp, user.id],
          );
        }
        if (note) {
          await client.query(
            `INSERT INTO registry.admission_activity
               (org_id, enquiry_id, action, previous_status, next_status, note, actor_id)
             VALUES ($1, $2, 'note_added', $3, $4, $5, $6)`,
            [user.orgId, parsedParams.data.enquiryId, current.status, input.status, note, user.id],
          );
        }

        const row = await client.query<EnquiryRow>(
          `${enquirySelect}
            WHERE e.org_id = $1 AND e.id = $2`,
          [user.orgId, parsedParams.data.enquiryId],
        );
        return row.rows[0] ?? null;
      });

      if (!updated) return void res.status(404).json(errorBody("NOT_FOUND", "Enquiry not found."));
      res.json(mapEnquiry(updated));
    } catch (error) {
      next(error);
    }
  });
};

export default routes;
