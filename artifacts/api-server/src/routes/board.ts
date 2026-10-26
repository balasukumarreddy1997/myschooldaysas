import type { FastifyPluginAsync } from "fastify";
import { CreateBoardTemplateBody, UpdateBoardTemplateBody } from "@workspace/api-zod";
import { withOrg } from "@workspace/db";
import { createRouteRegistrar } from "../lib/fastify-routes";
import { requireAuth, type CampusRole } from "../lib/auth";

const routes: FastifyPluginAsync = async (fastify) => {
const router = createRouteRegistrar(fastify);
const adminRoles: CampusRole[] = ["super_admin", "org_admin", "campus_admin"];
const teacherRoles: CampusRole[] = ["teacher", "class_teacher", "hod"];

function errorBody(code: string, message: string) {
  return { error: { code, message } };
}

function canAdministerBoard(roles: CampusRole[]) {
  return roles.some((role) => adminRoles.includes(role));
}

function canTeach(roles: CampusRole[]) {
  return roles.some((role) => teacherRoles.includes(role));
}

router.get("/board/templates", requireAuth, async (req, res, next) => {
  const user = req.campusUser;
  if (!user) return void res.status(401).json(errorBody("UNAUTHENTICATED", "Sign in to continue."));

  try {
    const result = await withOrg(user.orgId, (client) =>
      client.query(
        `SELECT id, name, scope, config, is_default
           FROM board.templates
          WHERE org_id = $1
            AND (scope <> 'teacher' OR owner_user_id = $2 OR $3::boolean)
          ORDER BY is_default DESC, name`,
        [user.orgId, user.id, canAdministerBoard(user.roles)],
      ),
    );
    res.json({
      items: result.rows.map((row) => ({
        id: row.id,
        name: row.name,
        scope: row.scope,
        config: row.config,
        isDefault: row.is_default,
      })),
      total: result.rowCount ?? 0,
    });
  } catch (error) {
    next(error);
  }
});

router.post("/board/templates", requireAuth, async (req, res, next) => {
  const user = req.campusUser;
  if (!user) return void res.status(401).json(errorBody("UNAUTHENTICATED", "Sign in to continue."));
  const parsed = CreateBoardTemplateBody.safeParse(req.body);
  if (!parsed.success) return void res.status(400).json(errorBody("INVALID_REQUEST", "Check the smartboard template details."));
  const isAdmin = canAdministerBoard(user.roles);
  if (!isAdmin && (!canTeach(user.roles) || parsed.data.scope !== "teacher")) {
    return void res.status(403).json(errorBody("FORBIDDEN", "Teachers can create personal templates; administrators can create school templates."));
  }

  try {
    const result = await withOrg(user.orgId, async (client) => {
      const ownerId = parsed.data.scope === "teacher" ? user.id : null;
      const inserted = await client.query(
        `INSERT INTO board.templates (org_id, owner_user_id, name, scope, config)
         VALUES ($1, $2, $3, $4, $5::jsonb)
         RETURNING id, name, scope, config, is_default`,
        [user.orgId, ownerId, parsed.data.name.trim(), parsed.data.scope, JSON.stringify(parsed.data.config)],
      );
      return inserted.rows[0];
    });
    res.status(201).json({
      id: result.id,
      name: result.name,
      scope: result.scope,
      config: result.config,
      isDefault: result.is_default,
    });
  } catch (error) {
    next(error);
  }
});

router.patch("/board/templates/:templateId", requireAuth, async (req, res, next) => {
  const user = req.campusUser;
  if (!user) return void res.status(401).json(errorBody("UNAUTHENTICATED", "Sign in to continue."));
  const parsed = UpdateBoardTemplateBody.safeParse(req.body);
  if (!parsed.success || Object.keys(parsed.data ?? {}).length === 0) {
    return void res.status(400).json(errorBody("INVALID_REQUEST", "Provide a valid template update."));
  }

  try {
    const result = await withOrg(user.orgId, async (client) => {
      const found = await client.query<{
        id: string;
        owner_user_id: string | null;
        scope: string;
      }>(
        "SELECT id, owner_user_id, scope FROM board.templates WHERE org_id = $1 AND id = $2 FOR UPDATE",
        [user.orgId, req.params.templateId],
      );
      const template = found.rows[0];
      if (!template) throw Object.assign(new Error("Smartboard template not found."), { status: 404, code: "NOT_FOUND" });
      const isAdmin = canAdministerBoard(user.roles);
      if (!isAdmin && (!canTeach(user.roles) || template.owner_user_id !== user.id || template.scope !== "teacher")) {
        throw Object.assign(new Error("You can update only your own teacher templates."), { status: 403, code: "FORBIDDEN" });
      }

      const values: unknown[] = [user.orgId, template.id];
      const assignments: string[] = [];
      if (parsed.data.name !== undefined) {
        values.push(parsed.data.name.trim());
        assignments.push(`name = $${values.length}`);
      }
      if (parsed.data.config !== undefined) {
        values.push(JSON.stringify(parsed.data.config));
        assignments.push(`config = $${values.length}::jsonb`);
      }
      if (parsed.data.isDefault !== undefined) {
        if (parsed.data.isDefault) {
          await client.query(
            `UPDATE board.templates
                SET is_default = false, updated_at = now()
              WHERE org_id = $1 AND scope = $2
                AND owner_user_id IS NOT DISTINCT FROM $3
                AND id <> $4`,
            [user.orgId, template.scope, template.owner_user_id, template.id],
          );
        }
        values.push(parsed.data.isDefault);
        assignments.push(`is_default = $${values.length}`);
      }
      assignments.push("updated_at = now()");

      const updated = await client.query(
        `UPDATE board.templates
            SET ${assignments.join(", ")}
          WHERE org_id = $1 AND id = $2
          RETURNING id, name, scope, config, is_default`,
        values,
      );
      return updated.rows[0];
    });
    res.json({
      id: result.id,
      name: result.name,
      scope: result.scope,
      config: result.config,
      isDefault: result.is_default,
    });
  } catch (error) {
    next(error);
  }
});
};

export default routes;
