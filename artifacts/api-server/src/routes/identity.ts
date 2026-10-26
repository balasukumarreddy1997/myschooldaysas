import { Router } from "express";
import { LoginBody } from "@workspace/api-zod";
import { pool, withOrg } from "@workspace/db";
import { createAccessToken, requireAuth, verifyPassword } from "../lib/auth";

const router = Router();

function invalid(message: string, code = "INVALID_REQUEST") {
  return { error: { code, message } };
}

router.post("/identity/auth/login", async (req, res, next) => {
  const parsed = LoginBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json(invalid("Enter a valid organization, email, and password."));
    return;
  }

  try {
    const orgResult = await pool.query<{ id: string; name: string }>(
      "SELECT id, name FROM identity.organizations WHERE slug = $1 LIMIT 1",
      [parsed.data.orgSlug.trim().toLowerCase()],
    );
    const org = orgResult.rows[0];
    if (!org) {
      res.status(401).json(invalid("Invalid organization or credentials.", "INVALID_CREDENTIALS"));
      return;
    }

    const userResult = await withOrg(org.id, async (client) =>
      client.query<{
        id: string;
        org_id: string;
        name: string;
        email: string;
        password_hash: string;
        status: string;
        must_change_password: boolean;
        temporary_password_expires_at: Date | null;
        roles: Array<"super_admin" | "org_admin" | "campus_admin" | "hod" | "teacher" | "class_teacher" | "student" | "parent">;
      }>(
        `SELECT u.id, u.org_id, u.name, u.email, u.password_hash, u.status,
                u.must_change_password, u.temporary_password_expires_at,
                COALESCE(array_agg(ur.role) FILTER (WHERE ur.role IS NOT NULL), '{}') AS roles
           FROM identity.users AS u
           LEFT JOIN identity.user_roles AS ur
             ON ur.user_id = u.id AND ur.org_id = u.org_id
          WHERE u.org_id = $1 AND lower(u.email) = lower($2)
          GROUP BY u.id`,
        [org.id, parsed.data.email],
      ),
    );
    const user = userResult.rows[0];
    if (
      !user ||
      user.status !== "active" ||
      user.roles.length === 0 ||
      !(await verifyPassword(parsed.data.password, user.password_hash))
    ) {
      res.status(401).json(invalid("Invalid organization or credentials.", "INVALID_CREDENTIALS"));
      return;
    }
    if (
      user.must_change_password &&
      user.temporary_password_expires_at &&
      user.temporary_password_expires_at.getTime() <= Date.now()
    ) {
      res.status(403).json(invalid("Your temporary password has expired.", "PASSWORD_EXPIRED"));
      return;
    }

    const authUser = {
      id: user.id,
      orgId: user.org_id,
      name: user.name,
      email: user.email,
      roles: user.roles,
      mustChangePassword: user.must_change_password,
    };
    res.status(200).json({ accessToken: createAccessToken(authUser), user: authUser });
  } catch (error) {
    next(error);
  }
});

router.get("/identity/me", requireAuth, (req, res) => {
  const user = req.campusUser;
  if (!user) {
    res.status(401).json(invalid("Sign in to continue.", "UNAUTHENTICATED"));
    return;
  }
  res.json({
    id: user.id,
    orgId: user.orgId,
    name: user.name,
    email: user.email,
    roles: user.roles,
  });
});

export default router;
