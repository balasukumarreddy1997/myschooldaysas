import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { after, test } from "node:test";
import { Pool } from "pg";

const adminRoles = ["super_admin", "org_admin", "campus_admin"];
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const apiBase = new URL(process.env.FEES_API_URL ?? "http://127.0.0.1:8080/api");
if (!["127.0.0.1", "localhost", "::1"].includes(apiBase.hostname)) {
  throw new Error("Fee integration tests may only call a loopback API server.");
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
      authorization: `Bearer ${token}`,
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
    const { orgId, academicYear, period } = cleanupTarget;
    await withOrg(orgId, async (client) => {
      await client.query(
        `DELETE FROM fees.payments
          WHERE org_id = $1
            AND invoice_id IN (
              SELECT id FROM fees.invoices
               WHERE org_id = $1 AND academic_year = $2 AND period = $3
            )`,
        [orgId, academicYear, period],
      );
      await client.query(
        "DELETE FROM fees.invoices WHERE org_id = $1 AND academic_year = $2 AND period = $3",
        [orgId, academicYear, period],
      );
    });
  }
  await pool.end();
});

test("fee MVP issues invoices, gates parent payment, and returns one idempotent receipt", {
  skip: process.env.RUN_FEES_INTEGRATION !== "1",
}, async (t) => {
  const identity = await pool.query(
    "SELECT current_database() AS database_name, current_user AS role_name",
  );
  assert.equal(identity.rows[0]?.database_name, "campus", "fee integration must use the local campus database");
  assert.equal(identity.rows[0]?.role_name, "campus_app", "fee integration must use the least-privilege application role");

  const organizations = await pool.query(
    "SELECT id FROM identity.organizations ORDER BY created_at LIMIT 1",
  );
  const orgId = organizations.rows[0]?.id;
  if (!orgId) return t.skip("No seeded organization is available.");

  const users = await withOrg(orgId, async (client) => {
    const adminResult = await client.query(
      `SELECT user_record.id, user_record.name, user_record.email,
              array_agg(user_role.role ORDER BY user_role.role) AS roles
         FROM identity.users user_record
         JOIN identity.user_roles user_role
           ON user_role.org_id = user_record.org_id AND user_role.user_id = user_record.id
        WHERE user_record.org_id = $1 AND user_role.role = ANY($2::text[])
        GROUP BY user_record.id
        ORDER BY user_record.created_at
        LIMIT 1`,
      [orgId, adminRoles],
    );
    const parentResult = await client.query(
      `SELECT guardian.id, guardian.name, guardian.email, enrollment.section_id, enrollment.academic_year
         FROM identity.guardian_links link
         JOIN identity.users guardian
           ON guardian.org_id = link.org_id AND guardian.id = link.guardian_user_id
         JOIN identity.user_roles guardian_role
           ON guardian_role.org_id = guardian.org_id
          AND guardian_role.user_id = guardian.id
          AND guardian_role.role = 'parent'
         JOIN academic.enrollments enrollment
           ON enrollment.org_id = link.org_id
          AND enrollment.student_user_id = link.student_user_id
          AND enrollment.status = 'active'
         JOIN identity.users student
           ON student.org_id = enrollment.org_id
          AND student.id = enrollment.student_user_id
          AND student.status = 'active'
        WHERE link.org_id = $1 AND link.can_pay_fees = true
        ORDER BY guardian.created_at
        LIMIT 1`,
      [orgId],
    );
    return { admin: adminResult.rows[0], parent: parentResult.rows[0] };
  });
  if (!users.admin || !users.parent) {
    return t.skip("A seeded administrator and a fee-enabled parent with an active enrollment are required.");
  }

  const period = `fee-test-${randomUUID().slice(0, 10)}`;
  cleanupTarget = { orgId, academicYear: users.parent.academic_year, period };
  const adminToken = createTestToken({
    id: users.admin.id,
    orgId,
    name: users.admin.name,
    email: users.admin.email,
    roles: users.admin.roles,
    mustChangePassword: false,
  });
  const parentToken = createTestToken({
    id: users.parent.id,
    orgId,
    name: users.parent.name,
    email: users.parent.email,
    roles: ["parent"],
    mustChangePassword: false,
  });

  const generateBody = {
    sectionId: users.parent.section_id,
    academicYear: users.parent.academic_year,
    period,
    description: "Gated fee integration fixture",
    amountPaise: 12345,
    dueDate: "2099-12-31",
  };
  const generated = await apiRequest("POST", "/fees/invoices/generate", adminToken, generateBody);
  assert.equal(generated.statusCode, 200, generated.body);
  const generatedBody = generated.json();
  assert.ok(generatedBody.generatedCount > 0);
  assert.ok(generatedBody.items.some((invoice) => invoice.studentId));

  const repeated = await apiRequest("POST", "/fees/invoices/generate", adminToken, generateBody);
  assert.equal(repeated.statusCode, 200, repeated.body);
  assert.equal(repeated.json().generatedCount, 0, "repeating a section period must not issue duplicate invoices");

  const forbiddenAdminPayment = await apiRequest("POST", `/fees/invoices/${generatedBody.items[0].id}/pay`, adminToken);
  assert.equal(forbiddenAdminPayment.statusCode, 403);

  const parentList = await apiRequest("GET", "/fees/my-invoices", parentToken);
  assert.equal(parentList.statusCode, 200, parentList.body);
  const parentInvoice = parentList.json().items.find((invoice) => invoice.period === period);
  assert.ok(parentInvoice, "linked parent should see the child's invoice");
  assert.equal(parentInvoice.canPay, true);

  const firstPayment = await apiRequest("POST", `/fees/invoices/${parentInvoice.id}/pay`, parentToken, { amountPaise: 1 });
  assert.equal(firstPayment.statusCode, 200, firstPayment.body);
  const payment = firstPayment.json();
  assert.equal(payment.status, "paid");
  assert.equal(payment.amountPaise, 12345, "the server must take the invoice amount, not a client-supplied amount");
  assert.ok(payment.receiptNumber);

  const repeatedPayment = await apiRequest("POST", `/fees/invoices/${parentInvoice.id}/pay`, parentToken);
  assert.equal(repeatedPayment.statusCode, 200, repeatedPayment.body);
  assert.equal(repeatedPayment.json().receiptNumber, payment.receiptNumber);

  const receipt = await apiRequest("GET", `/fees/receipts/${encodeURIComponent(payment.receiptNumber)}`, parentToken);
  assert.equal(receipt.statusCode, 200, receipt.body);
  assert.equal(receipt.json().paymentMethod, "mock");
  assert.equal(receipt.json().amountPaise, 12345);
});
