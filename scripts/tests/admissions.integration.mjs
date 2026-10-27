import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { after, test } from "node:test";
import { Pool } from "pg";

const adminRoles = ["super_admin", "org_admin", "campus_admin"];
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const apiBase = new URL(process.env.ADMISSIONS_API_URL ?? "http://127.0.0.1:8080/api");
if (!["127.0.0.1", "localhost", "::1"].includes(apiBase.hostname)) {
  throw new Error("Admissions integration tests may only call a loopback API server.");
}
const developmentJwtSecret = "campus-live-development-jwt-secret-not-for-production";
let cleanupTarget = null;

async function withOrg(orgId, callback) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.org_id', $1, true)", [orgId]);
    const result = await callback(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

function createTestToken(user) {
  const secret = process.env.JWT_SECRET ?? developmentJwtSecret;
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({
    ...user,
    iss: "campus-live-identity",
    aud: "campus-live-web",
    iat: now,
    exp: now + 900,
    sub: user.id,
  })).toString("base64url");
  const content = `${header}.${payload}`;
  const signature = createHmac("sha256", secret).update(content).digest("base64url");
  return `${content}.${signature}`;
}

async function apiRequest(method, path, token, payload) {
  const response = await fetch(`${apiBase.toString().replace(/\/+$/, "")}${path}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(payload ? { "content-type": "application/json" } : {}),
    },
    ...(payload ? { body: JSON.stringify(payload) } : {}),
  });
  const body = await response.text();
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    parsed = body;
  }
  return { statusCode: response.status, body, json: () => parsed };
}

after(async () => {
  if (cleanupTarget) {
    await withOrg(cleanupTarget.orgId, async (client) => {
      await client.query(
        "DELETE FROM registry.admission_enquiries WHERE org_id = $1 AND id = $2",
        [cleanupTarget.orgId, cleanupTarget.id],
      );
    });
  }
  await pool.end();
});

test("public enquiries enter an admin triage queue with status history", {
  skip: process.env.RUN_ADMISSIONS_INTEGRATION !== "1",
}, async (t) => {
  const identity = await pool.query(
    "SELECT current_database() AS database_name, current_user AS role_name",
  );
  assert.equal(identity.rows[0]?.database_name, "campus", "admissions integration must use the local campus database");
  assert.equal(identity.rows[0]?.role_name, "campus_app", "admissions integration must use the least-privilege application role");

  const organizations = await pool.query(
    "SELECT id, slug FROM identity.organizations ORDER BY created_at LIMIT 1",
  );
  const organization = organizations.rows[0];
  if (!organization) return t.skip("No seeded active organization is available.");

  const users = await withOrg(organization.id, async (client) => {
    const result = await client.query(
      `SELECT user_record.id, user_record.name, user_record.email,
              array_agg(user_role.role ORDER BY user_role.role) AS roles
         FROM identity.users user_record
         JOIN identity.user_roles user_role
           ON user_role.org_id = user_record.org_id AND user_role.user_id = user_record.id
        WHERE user_record.org_id = $1 AND user_role.role = ANY($2::text[])
        GROUP BY user_record.id
        ORDER BY user_record.created_at
        LIMIT 1`,
      [organization.id, adminRoles],
    );
    const studentResult = await client.query(
      `SELECT user_record.id, user_record.name, user_record.email,
              array_agg(user_role.role ORDER BY user_role.role) AS roles
         FROM identity.users user_record
         JOIN identity.user_roles user_role
           ON user_role.org_id = user_record.org_id AND user_role.user_id = user_record.id
        WHERE user_record.org_id = $1 AND user_role.role = 'student'
        GROUP BY user_record.id
        ORDER BY user_record.created_at
        LIMIT 1`,
      [organization.id],
    );
    return { admin: result.rows[0], student: studentResult.rows[0] };
  });
  const admin = users.admin;
  if (!admin) return t.skip("A seeded school administrator is required.");

  const token = createTestToken({
    id: admin.id,
    orgId: organization.id,
    name: admin.name,
    email: admin.email,
    roles: admin.roles,
    mustChangePassword: false,
  });
  const childName = `Integration child ${randomUUID().slice(0, 8)}`;
  const guardianName = `Integration guardian ${randomUUID().slice(0, 8)}`;

  const created = await apiRequest("POST", "/registry/public/enquiry", null, {
    orgSlug: organization.slug,
    childName,
    classApplying: "Grade 1",
    guardianName,
    guardianPhone: "5550100000",
    notes: "Please share admission dates.",
  });
  assert.equal(created.statusCode, 201, created.body);
  const createdBody = created.json();
  assert.equal(createdBody.status, "new");
  cleanupTarget = { orgId: organization.id, id: createdBody.id };

  const invalidOrg = await apiRequest("POST", "/registry/public/enquiry", null, {
    orgSlug: `missing-${randomUUID().slice(0, 8)}`,
    childName,
    classApplying: "Grade 1",
    guardianName,
    guardianPhone: "5550100000",
  });
  assert.equal(invalidOrg.statusCode, 404);

  const unauthorized = await apiRequest("GET", "/registry/enquiries");
  assert.equal(unauthorized.statusCode, 401);
  if (users.student) {
    const studentToken = createTestToken({
      id: users.student.id,
      orgId: organization.id,
      name: users.student.name,
      email: users.student.email,
      roles: users.student.roles,
      mustChangePassword: false,
    });
    const forbidden = await apiRequest("GET", "/registry/enquiries", studentToken);
    assert.equal(forbidden.statusCode, 403);
  }

  const list = await apiRequest(
    "GET",
    `/registry/enquiries?search=${encodeURIComponent(childName)}`,
    token,
  );
  assert.equal(list.statusCode, 200, list.body);
  const listBody = list.json();
  assert.equal(listBody.total, 1);
  assert.equal(listBody.items[0].id, createdBody.id);
  assert.equal(listBody.items[0].guardianName, guardianName);

  const updated = await apiRequest("PATCH", `/registry/enquiries/${createdBody.id}`, token, {
    status: "contacted",
    followUpOn: "2099-06-01",
    note: "Integration follow-up note.",
  });
  assert.equal(updated.statusCode, 200, updated.body);
  const updatedBody = updated.json();
  assert.equal(updatedBody.status, "contacted");
  assert.equal(updatedBody.followUpOn, "2099-06-01");
  assert.ok(updatedBody.activity.some((entry) => entry.action === "submitted"));
  assert.ok(updatedBody.activity.some((entry) => entry.action === "status_changed"));
  const followUpEvent = updatedBody.activity.find((entry) => entry.action === "follow_up_changed");
  assert.equal(followUpEvent?.previousFollowUpOn, null);
  assert.equal(followUpEvent?.nextFollowUpOn, "2099-06-01");
  assert.ok(updatedBody.activity.some((entry) => entry.action === "note_added"));

  const missing = await apiRequest("PATCH", `/registry/enquiries/${randomUUID()}`, token, {
    status: "contacted",
  });
  assert.equal(missing.statusCode, 404);
});
