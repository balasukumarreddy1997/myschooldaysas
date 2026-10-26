import { createHmac, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import { pool, withOrg } from "@workspace/db";
import { needsPasswordRehash } from "./identity-security.ts";
import type {} from "./fastify-routes.ts";

const TOKEN_ISSUER = "campus-live-identity";
const TOKEN_AUDIENCE = "campus-live-web";
const ACCESS_TOKEN_SECONDS = 15 * 60;
const DEV_JWT_SECRET = "campus-live-development-jwt-secret-not-for-production";

export type CampusRole =
  | "super_admin"
  | "org_admin"
  | "campus_admin"
  | "hod"
  | "teacher"
  | "class_teacher"
  | "student"
  | "parent";

export interface AuthUser {
  id: string;
  orgId: string;
  name: string;
  email: string;
  roles: CampusRole[];
  mustChangePassword: boolean;
}

interface JwtPayload extends AuthUser {
  iss: string;
  aud: string;
  iat: number;
  exp: number;
  sub: string;
}

export function getJwtSecret(): string {
  const value =
    process.env.JWT_SECRET ??
    (process.env.NODE_ENV === "production" ? "" : DEV_JWT_SECRET);

  if (value.length < 32) {
    throw new Error("JWT_SECRET must be at least 32 characters.");
  }
  if (process.env.NODE_ENV === "production" && /development|change.?me|example/i.test(value)) {
    throw new Error("JWT_SECRET must not use a development placeholder in production.");
  }
  return value;
}

function encodeJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function signPart(value: string, secret: string): string {
  return createHmac("sha256", secret).update(value).digest("base64url");
}

export function createAccessToken(user: AuthUser, nowSeconds = Math.floor(Date.now() / 1000)): string {
  const secret = getJwtSecret();
  const header = encodeJson({ alg: "HS256", typ: "JWT" });
  const payload: JwtPayload = {
    ...user,
    iss: TOKEN_ISSUER,
    aud: TOKEN_AUDIENCE,
    iat: nowSeconds,
    exp: nowSeconds + ACCESS_TOKEN_SECONDS,
    sub: user.id,
  };
  const encodedPayload = encodeJson(payload);
  const content = `${header}.${encodedPayload}`;
  return `${content}.${signPart(content, secret)}`;
}

function isCampusRole(value: unknown): value is CampusRole {
  return (
    value === "super_admin" ||
    value === "org_admin" ||
    value === "campus_admin" ||
    value === "hod" ||
    value === "teacher" ||
    value === "class_teacher" ||
    value === "student" ||
    value === "parent"
  );
}

export function verifyAccessToken(token: string, nowSeconds = Math.floor(Date.now() / 1000)): AuthUser | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;

  try {
    const header = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8")) as { alg?: string };
    if (header.alg !== "HS256") return null;

    const expected = Buffer.from(signPart(`${parts[0]}.${parts[1]}`, getJwtSecret()));
    const actual = Buffer.from(parts[2]);
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;

    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as Partial<JwtPayload>;
    if (
      payload.iss !== TOKEN_ISSUER ||
      payload.aud !== TOKEN_AUDIENCE ||
      !payload.sub ||
      payload.sub !== payload.id ||
      !payload.orgId ||
      !payload.name ||
      !payload.email ||
      !Array.isArray(payload.roles) ||
      payload.roles.length === 0 ||
      !payload.roles.every(isCampusRole) ||
      typeof payload.exp !== "number" ||
      payload.exp <= nowSeconds ||
      typeof payload.mustChangePassword !== "boolean"
    ) {
      return null;
    }

    return {
      id: payload.sub,
      orgId: payload.orgId,
      name: payload.name,
      email: payload.email,
      roles: payload.roles,
      mustChangePassword: payload.mustChangePassword,
    };
  } catch {
    return null;
  }
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = await deriveScrypt(password, salt, 64, {
    N: 131072,
    r: 8,
    p: 1,
    maxmem: 256 * 1024 * 1024,
  });

  return `$scrypt$131072$8$1$${salt.toString("base64url")}$${derived.toString("base64url")}`;
}

export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  const [, algorithm, nText, rText, pText, saltText, keyText] = encoded.split("$");
  const n = Number(nText);
  const r = Number(rText);
  const p = Number(pText);
  if (
    algorithm !== "scrypt" ||
    !Number.isInteger(n) ||
    n < 16384 ||
    n > 131072 ||
    !Number.isInteger(r) ||
    r < 1 ||
    r > 16 ||
    !Number.isInteger(p) ||
    p < 1 ||
    p > 4 ||
    !saltText ||
    !keyText
  ) {
    return false;
  }

  try {
    const salt = Buffer.from(saltText, "base64url");
    const expected = Buffer.from(keyText, "base64url");
    const actual = await deriveScrypt(password, salt, expected.length, {
      N: n,
      r,
      p,
      maxmem: 256 * 1024 * 1024,
    });
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

function deriveScrypt(
  password: string,
  salt: Buffer,
  keyLength: number,
  options: { N: number; r: number; p: number; maxmem: number },
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, keyLength, options, (error, key) => {
      if (error) reject(error);
      else resolve(key as Buffer);
    });
  });
}

export const requireAuth = async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
  const authorization = req.headers.authorization;
  const token = authorization?.startsWith("Bearer ") ? authorization.slice(7) : "";
  const claims = token ? verifyAccessToken(token) : null;
  if (!claims) {
    reply.code(401).send({ error: { code: "UNAUTHENTICATED", message: "Sign in to continue." } });
    return;
  }

  try {
    const result = await withOrg(claims.orgId, async (client) =>
      client.query<{
        id: string;
        org_id: string;
        name: string;
        email: string;
        must_change_password: boolean;
         temporary_password_expires_at: Date | null;
        roles: CampusRole[];
      }>(
        `SELECT u.id, u.org_id, u.name, u.email, u.must_change_password,
                u.temporary_password_expires_at,
                COALESCE(array_agg(ur.role) FILTER (WHERE ur.role IS NOT NULL), '{}') AS roles
           FROM identity.users AS u
           LEFT JOIN identity.user_roles AS ur
             ON ur.user_id = u.id AND ur.org_id = u.org_id
          WHERE u.id = $1 AND u.org_id = $2 AND u.status = 'active'
          GROUP BY u.id`,
        [claims.id, claims.orgId],
      ),
    );
    const user = result.rows[0];
    if (
      !user ||
      user.roles.length === 0 ||
      user.must_change_password !== claims.mustChangePassword
    ) {
      reply.code(401).send({ error: { code: "UNAUTHENTICATED", message: "Your session is no longer valid." } });
      return;
    }
    if (
      user.must_change_password &&
      (!user.temporary_password_expires_at ||
        user.temporary_password_expires_at.getTime() <= Date.now())
    ) {
      reply.code(403).send({ error: { code: "PASSWORD_EXPIRED", message: "Your temporary password has expired." } });
      return;
    }
    req.campusUser = {
      id: user.id,
      orgId: user.org_id,
      name: user.name,
      email: user.email,
      roles: user.roles,
      mustChangePassword: user.must_change_password,
    };
    const requestPath = req.url.split("?")[0].replace(/^\/api(?=\/)/, "");
    if (
      user.must_change_password &&
      requestPath !== "/identity/me" &&
      requestPath !== "/identity/auth/change-password"
    ) {
      reply.code(403).send({ error: { code: "PASSWORD_CHANGE_REQUIRED", message: "Change your temporary password to continue." } });
      return;
    }
  } catch (error) {
    throw error;
  }
};

export function requireRoles(...allowed: CampusRole[]) {
  return async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const user = req.campusUser;
    if (!user || !user.roles.some((role) => allowed.includes(role))) {
      reply.code(403).send({ error: { code: "FORBIDDEN", message: "You do not have access to this action." } });
      return;
    }
  };
}

export async function findOrganizationBySlug(slug: string): Promise<{ id: string; name: string } | null> {
  const result = await pool.query<{ id: string; name: string }>(
    "SELECT id, name FROM identity.organizations WHERE slug = $1 LIMIT 1",
    [slug],
  );
  return result.rows[0] ?? null;
}
