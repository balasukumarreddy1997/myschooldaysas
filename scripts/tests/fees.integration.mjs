import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";
import Fastify from "fastify";
import { pool, withOrg } from "@workspace/db";
import feeRoutes from "../../artifacts/api-server/src/routes/fees.ts";
import { createAccessToken } from "../../artifacts/api-server/src/lib/auth.ts";

const adminRoles = ["super_admin", "org_admin", "campus_admin"];
let cleanupTarget = null;

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
  const adminToken = createAccessToken({
    id: users.admin.id,
    orgId,
    name: users.admin.name,
    email: users.admin.email,
    roles: users.admin.roles,
    mustChangePassword: false,
  });
  const parentToken = createAccessToken({
    id: users.parent.id,
    orgId,
    name: users.parent.name,
    email: users.parent.email,
    roles: ["parent"],
    mustChangePassword: false,
  });

  const app = Fastify();
  await app.register(feeRoutes, { prefix: "/api" });
  await app.ready();
  t.after(() => app.close());

  const generateBody = {
    sectionId: users.parent.section_id,
    academicYear: users.parent.academic_year,
    period,
    description: "Gated fee integration fixture",
    amountPaise: 12345,
    dueDate: "2099-12-31",
  };
  const adminHeaders = { authorization: `Bearer ${adminToken}` };
  const parentHeaders = { authorization: `Bearer ${parentToken}` };

  const generated = await app.inject({
    method: "POST",
    url: "/api/fees/invoices/generate",
    headers: adminHeaders,
    payload: generateBody,
  });
  assert.equal(generated.statusCode, 200, generated.body);
  const generatedBody = generated.json();
  assert.ok(generatedBody.generatedCount > 0);
  assert.ok(generatedBody.items.some((invoice) => invoice.studentId));

  const repeated = await app.inject({
    method: "POST",
    url: "/api/fees/invoices/generate",
    headers: adminHeaders,
    payload: generateBody,
  });
  assert.equal(repeated.statusCode, 200, repeated.body);
  assert.equal(repeated.json().generatedCount, 0, "repeating a section period must not issue duplicate invoices");

  const forbiddenAdminPayment = await app.inject({
    method: "POST",
    url: `/api/fees/invoices/${generatedBody.items[0].id}/pay`,
    headers: adminHeaders,
  });
  assert.equal(forbiddenAdminPayment.statusCode, 403);

  const parentList = await app.inject({
    method: "GET",
    url: "/api/fees/my-invoices",
    headers: parentHeaders,
  });
  assert.equal(parentList.statusCode, 200, parentList.body);
  const parentInvoice = parentList.json().items.find((invoice) => invoice.period === period);
  assert.ok(parentInvoice, "linked parent should see the child's invoice");
  assert.equal(parentInvoice.canPay, true);

  const firstPayment = await app.inject({
    method: "POST",
    url: `/api/fees/invoices/${parentInvoice.id}/pay`,
    headers: parentHeaders,
    payload: { amountPaise: 1 },
  });
  assert.equal(firstPayment.statusCode, 200, firstPayment.body);
  const payment = firstPayment.json();
  assert.equal(payment.status, "paid");
  assert.equal(payment.amountPaise, 12345, "the server must take the invoice amount, not a client-supplied amount");
  assert.ok(payment.receiptNumber);

  const repeatedPayment = await app.inject({
    method: "POST",
    url: `/api/fees/invoices/${parentInvoice.id}/pay`,
    headers: parentHeaders,
  });
  assert.equal(repeatedPayment.statusCode, 200, repeatedPayment.body);
  assert.equal(repeatedPayment.json().receiptNumber, payment.receiptNumber);

  const receipt = await app.inject({
    method: "GET",
    url: `/api/fees/receipts/${encodeURIComponent(payment.receiptNumber)}`,
    headers: parentHeaders,
  });
  assert.equal(receipt.statusCode, 200, receipt.body);
  assert.equal(receipt.json().paymentMethod, "mock");
  assert.equal(receipt.json().amountPaise, 12345);
});
