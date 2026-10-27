import { randomUUID } from "node:crypto";
import type { FastifyPluginAsync } from "fastify";
import {
  GenerateFeeInvoicesBody,
  GetFeeInvoicesQueryParams,
  GetFeeReceiptParams,
  PayFeeInvoiceParams,
} from "@workspace/api-zod";
import { withOrg } from "@workspace/db";
import { createRouteRegistrar } from "../lib/fastify-routes";
import { requireAuth, type CampusRole } from "../lib/auth";
import { canParentPayInvoice, isMockPaymentEnvironment } from "../lib/fee-payment-policy";

const adminRoles: CampusRole[] = ["super_admin", "org_admin", "campus_admin"];
const errorBody = (code: string, message: string) => ({ error: { code, message } });

type InvoiceRow = {
  id: string;
  student_user_id: string;
  student_name: string;
  section_id: string;
  invoice_number: string;
  academic_year: string;
  period: string;
  description: string;
  amount_paise: string | number;
  due_date: string | Date;
  status: "unpaid" | "paid" | "void";
  receipt_number: string | null;
  paid_at: Date | null;
  can_pay?: boolean;
};

function dateValue(value: string | Date): string {
  return value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10);
}

function dateTimeValue(value: Date | string | null): string | null {
  if (value === null) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function mapInvoice(row: InvoiceRow, canPay = false) {
  return {
    id: row.id,
    studentId: row.student_user_id,
    studentName: row.student_name,
    sectionId: row.section_id,
    invoiceNumber: row.invoice_number,
    academicYear: row.academic_year,
    period: row.period,
    description: row.description,
    amountPaise: Number(row.amount_paise),
    dueDate: dateValue(row.due_date),
    status: row.status,
    receiptNumber: row.receipt_number,
    paidAt: dateTimeValue(row.paid_at),
    canPay,
  };
}

const routes: FastifyPluginAsync = async (fastify) => {
  const router = createRouteRegistrar(fastify);

  router.get("/fees/invoices", requireAuth, async (req, res, next) => {
    const user = req.campusUser;
    if (!user) return void res.status(401).json(errorBody("UNAUTHENTICATED", "Sign in to continue."));
    if (!user.roles.some((role) => adminRoles.includes(role))) {
      return void res.status(403).json(errorBody("FORBIDDEN", "Administrator role required."));
    }
    const parsed = GetFeeInvoicesQueryParams.safeParse(req.query);
    if (!parsed.success) return void res.status(400).json(errorBody("INVALID_REQUEST", "Provide valid invoice pagination."));
    const limit = parsed.data.limit ?? 50;
    const offset = parsed.data.offset ?? 0;

    try {
      const page = await withOrg(user.orgId, async (client) => {
        const count = await client.query<{ total: string }>(
          "SELECT COUNT(*)::text AS total FROM fees.invoices WHERE org_id = $1",
          [user.orgId],
        );
        const invoices = await client.query<InvoiceRow>(
          `SELECT i.id, i.student_user_id, student.name AS student_name, i.section_id,
                  i.invoice_number, i.academic_year, i.period, i.description, i.amount_paise,
                  i.due_date, i.status, payment.receipt_number, payment.captured_at AS paid_at
             FROM fees.invoices i
             JOIN identity.users student
               ON student.org_id = i.org_id AND student.id = i.student_user_id
             LEFT JOIN fees.payments payment
               ON payment.org_id = i.org_id AND payment.invoice_id = i.id AND payment.status = 'captured'
            WHERE i.org_id = $1
            ORDER BY i.created_at DESC, i.id DESC
            LIMIT $2 OFFSET $3`,
          [user.orgId, limit, offset],
        );
        return {
          items: invoices.rows.map((row) => mapInvoice(row)),
          total: Number(count.rows[0]?.total ?? 0),
        };
      });
      res.json(page);
    } catch (error) {
      next(error);
    }
  });

  router.post("/fees/invoices/generate", requireAuth, async (req, res, next) => {
    const user = req.campusUser;
    if (!user) return void res.status(401).json(errorBody("UNAUTHENTICATED", "Sign in to continue."));
    if (!user.roles.some((role) => adminRoles.includes(role))) {
      return void res.status(403).json(errorBody("FORBIDDEN", "Administrator role required."));
    }
    const parsed = GenerateFeeInvoicesBody.safeParse(req.body);
    if (!parsed.success) return void res.status(400).json(errorBody("INVALID_REQUEST", "Provide valid invoice details."));
    const input = parsed.data;

    try {
      const result = await withOrg(user.orgId, async (client) => {
        const section = await client.query(
          "SELECT id FROM academic.sections WHERE org_id = $1 AND id = $2",
          [user.orgId, input.sectionId],
        );
        if (!section.rowCount) return { kind: "section_missing" as const };

        const students = await client.query<{ student_user_id: string }>(
          `SELECT e.student_user_id
             FROM academic.enrollments e
             JOIN identity.users student
               ON student.org_id = e.org_id AND student.id = e.student_user_id
            WHERE e.org_id = $1 AND e.section_id = $2 AND e.academic_year = $3
              AND e.status = 'active' AND student.status = 'active'
            ORDER BY e.student_user_id`,
          [user.orgId, input.sectionId, input.academicYear],
        );
        if (!students.rowCount) return { kind: "no_students" as const };
        const studentIds = students.rows.map((row) => row.student_user_id);

        const existing = await client.query<{
          student_user_id: string;
          section_id: string;
          description: string;
          amount_paise: string | number;
          due_date: string | Date;
        }>(
          `SELECT student_user_id, section_id, description, amount_paise, due_date
             FROM fees.invoices
            WHERE org_id = $1 AND student_user_id = ANY($2::uuid[])
              AND academic_year = $3 AND period = $4
            FOR UPDATE`,
          [user.orgId, studentIds, input.academicYear, input.period],
        );
        const matchesInput = existing.rows.every((invoice) =>
          invoice.section_id === input.sectionId
          && invoice.description === input.description.trim()
          && Number(invoice.amount_paise) === input.amountPaise
          && dateValue(invoice.due_date) === dateValue(input.dueDate),
        );
        if (!matchesInput) return { kind: "invoice_conflict" as const };

        let generatedCount = 0;
        for (const studentId of studentIds) {
          const inserted = await client.query(
            `INSERT INTO fees.invoices
               (org_id, student_user_id, section_id, invoice_number, academic_year, period,
                description, amount_paise, due_date, created_by)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
             ON CONFLICT (org_id, student_user_id, academic_year, period) DO NOTHING`,
            [
              user.orgId,
              studentId,
              input.sectionId,
              `INV-${randomUUID().slice(0, 12).toUpperCase()}`,
              input.academicYear,
              input.period,
              input.description.trim(),
              input.amountPaise,
              input.dueDate,
              user.id,
            ],
          );
          generatedCount += inserted.rowCount ?? 0;
        }

        const rows = await client.query<InvoiceRow>(
          `SELECT i.id, i.student_user_id, student.name AS student_name, i.section_id,
                  i.invoice_number, i.academic_year, i.period, i.description, i.amount_paise,
                  i.due_date, i.status, payment.receipt_number, payment.captured_at AS paid_at
             FROM fees.invoices i
             JOIN identity.users student
               ON student.org_id = i.org_id AND student.id = i.student_user_id
             LEFT JOIN fees.payments payment
               ON payment.org_id = i.org_id AND payment.invoice_id = i.id AND payment.status = 'captured'
            WHERE i.org_id = $1 AND i.student_user_id = ANY($2::uuid[])
              AND i.academic_year = $3 AND i.period = $4
            ORDER BY student.name, i.id`,
          [user.orgId, studentIds, input.academicYear, input.period],
        );
        const allInvoicesMatch = rows.rows.every((invoice) =>
          invoice.section_id === input.sectionId
          && invoice.description === input.description.trim()
          && Number(invoice.amount_paise) === input.amountPaise
          && dateValue(invoice.due_date) === dateValue(input.dueDate),
        );
        if (!allInvoicesMatch) {
          const conflict = new Error("Invoice generation conflicted with a concurrent request.") as Error & { code: string };
          conflict.code = "FEE_INVOICE_CONFLICT";
          throw conflict;
        }
        return {
          kind: "ok" as const,
          generatedCount,
          items: rows.rows.map((row) => mapInvoice(row)),
        };
      });

      if (result.kind === "section_missing") return void res.status(404).json(errorBody("NOT_FOUND", "Section not found."));
      if (result.kind === "no_students") return void res.status(409).json(errorBody("NO_ACTIVE_STUDENTS", "No active students are enrolled in that section and academic year."));
      if (result.kind === "invoice_conflict") return void res.status(409).json(errorBody("INVOICE_CONFLICT", "Invoices already exist for this period with different details."));
      res.json({ generatedCount: result.generatedCount, total: result.items.length, items: result.items });
    } catch (error) {
      if (["23505", "FEE_INVOICE_CONFLICT"].includes((error as { code?: string })?.code ?? "")) {
        return void res.status(409).json(errorBody("INVOICE_CONFLICT", "An invoice was issued for this student and period concurrently."));
      }
      next(error);
    }
  });

  router.get("/fees/my-invoices", requireAuth, async (req, res, next) => {
    const user = req.campusUser;
    if (!user) return void res.status(401).json(errorBody("UNAUTHENTICATED", "Sign in to continue."));
    if (!user.roles.includes("parent")) {
      return void res.status(403).json(errorBody("FORBIDDEN", "Parent access required."));
    }

    try {
      const items = await withOrg(user.orgId, (client) =>
        client.query<InvoiceRow>(
          `SELECT i.id, i.student_user_id, student.name AS student_name, i.section_id,
                  i.invoice_number, i.academic_year, i.period, i.description, i.amount_paise,
                  i.due_date, i.status, payment.receipt_number, payment.captured_at AS paid_at,
                  guardian.can_pay_fees AS can_pay
             FROM identity.guardian_links guardian
             JOIN fees.invoices i
               ON i.org_id = guardian.org_id AND i.student_user_id = guardian.student_user_id
             JOIN identity.users student
               ON student.org_id = i.org_id AND student.id = i.student_user_id
             LEFT JOIN fees.payments payment
               ON payment.org_id = i.org_id AND payment.invoice_id = i.id AND payment.status = 'captured'
            WHERE guardian.org_id = $1 AND guardian.guardian_user_id = $2
            ORDER BY i.due_date, i.created_at DESC`,
          [user.orgId, user.id],
        ),
      );
      res.json({
        items: items.rows.map((row) => mapInvoice(
          row,
          canParentPayInvoice(row.can_pay === true, row.status, process.env.NODE_ENV),
        )),
        total: items.rowCount ?? 0,
      });
    } catch (error) {
      next(error);
    }
  });

  router.post("/fees/invoices/:invoiceId/pay", requireAuth, async (req, res, next) => {
    const user = req.campusUser;
    if (!user) return void res.status(401).json(errorBody("UNAUTHENTICATED", "Sign in to continue."));
    if (!user.roles.includes("parent")) {
      return void res.status(403).json(errorBody("FORBIDDEN", "Parent access required."));
    }
    if (!isMockPaymentEnvironment(process.env.NODE_ENV)) {
      return void res.status(503).json(errorBody("PAYMENTS_UNAVAILABLE", "Online payments are not configured for this environment."));
    }
    const params = PayFeeInvoiceParams.safeParse(req.params);
    if (!params.success) return void res.status(400).json(errorBody("INVALID_REQUEST", "Provide a valid invoice ID."));

    try {
      const result = await withOrg(user.orgId, async (client) => {
        const invoice = await client.query<{
          id: string;
          invoice_number: string;
          amount_paise: string | number;
          status: "unpaid" | "paid" | "void";
          can_pay_fees: boolean;
        }>(
          `SELECT i.id, i.invoice_number, i.amount_paise, i.status, guardian.can_pay_fees
             FROM fees.invoices i
             JOIN identity.guardian_links guardian
               ON guardian.org_id = i.org_id AND guardian.student_user_id = i.student_user_id
            WHERE i.org_id = $1 AND i.id = $2 AND guardian.guardian_user_id = $3
            FOR UPDATE OF i`,
          [user.orgId, params.data.invoiceId, user.id],
        );
        const row = invoice.rows[0];
        if (!row) return { kind: "missing" as const };
        if (!row.can_pay_fees) return { kind: "forbidden" as const };
        if (row.status === "void") return { kind: "void" as const };

        if (row.status === "paid") {
          const payment = await client.query<{
            receipt_number: string;
            amount_paise: string | number;
            captured_at: Date;
          }>(
            `SELECT receipt_number, amount_paise, captured_at
               FROM fees.payments
              WHERE org_id = $1 AND invoice_id = $2 AND status = 'captured'`,
            [user.orgId, row.id],
          );
          const previous = payment.rows[0];
          if (!previous) throw new Error("Paid invoice is missing its captured payment record.");
          return {
            kind: "paid" as const,
            invoiceId: row.id,
            invoiceNumber: row.invoice_number,
            amountPaise: Number(previous.amount_paise),
            receiptNumber: previous.receipt_number,
            paidAt: dateTimeValue(previous.captured_at)!,
          };
        }

        const receiptNumber = `RCT-${randomUUID().slice(0, 12).toUpperCase()}`;
        await client.query(
          `INSERT INTO fees.payments
             (org_id, invoice_id, amount_paise, gateway, gateway_payment_id,
              receipt_number, received_by)
           VALUES ($1, $2, $3, 'mock', $4, $5, $6)`,
          [
            user.orgId,
            row.id,
            Number(row.amount_paise),
            `MOCK-${randomUUID()}`,
            receiptNumber,
            user.id,
          ],
        );
        const updated = await client.query<{ paid_at: Date }>(
          `UPDATE fees.invoices
              SET status = 'paid', paid_at = now()
            WHERE org_id = $1 AND id = $2 AND status = 'unpaid'
            RETURNING paid_at`,
          [user.orgId, row.id],
        );
        if (!updated.rowCount) throw new Error("Invoice payment state changed unexpectedly.");
        return {
          kind: "paid" as const,
          invoiceId: row.id,
          invoiceNumber: row.invoice_number,
          amountPaise: Number(row.amount_paise),
          receiptNumber,
          paidAt: dateTimeValue(updated.rows[0]!.paid_at)!,
        };
      });

      if (result.kind === "missing") return void res.status(404).json(errorBody("NOT_FOUND", "Invoice not found."));
      if (result.kind === "forbidden") return void res.status(403).json(errorBody("FEE_PAYMENT_DISABLED", "Fee payments are not enabled for this parent."));
      if (result.kind === "void") return void res.status(409).json(errorBody("INVOICE_VOID", "This invoice can no longer be paid."));
      res.json({
        invoiceId: result.invoiceId,
        invoiceNumber: result.invoiceNumber,
        amountPaise: result.amountPaise,
        status: "paid",
        receiptNumber: result.receiptNumber,
        paidAt: result.paidAt,
      });
    } catch (error) {
      if ((error as { code?: string })?.code === "23505") {
        return void res.status(409).json(errorBody("PAYMENT_CONFLICT", "This invoice has already been paid."));
      }
      next(error);
    }
  });

  router.get("/fees/receipts/:receiptNumber", requireAuth, async (req, res, next) => {
    const user = req.campusUser;
    if (!user) return void res.status(401).json(errorBody("UNAUTHENTICATED", "Sign in to continue."));
    const params = GetFeeReceiptParams.safeParse(req.params);
    if (!params.success) return void res.status(400).json(errorBody("INVALID_REQUEST", "Provide a valid receipt number."));
    const isAdmin = user.roles.some((role) => adminRoles.includes(role));
    if (!isAdmin && !user.roles.includes("parent")) {
      return void res.status(403).json(errorBody("FORBIDDEN", "Receipt access is restricted to school administrators and linked parents."));
    }

    try {
      const result = await withOrg(user.orgId, (client) =>
        client.query<{
          receipt_number: string;
          invoice_number: string;
          student_name: string;
          description: string;
          academic_year: string;
          period: string;
          amount_paise: string | number;
          captured_at: Date;
          gateway: "mock" | "razorpay" | "manual";
        }>(
          `SELECT payment.receipt_number, invoice.invoice_number, student.name AS student_name,
                  invoice.description, invoice.academic_year, invoice.period, payment.amount_paise,
                  payment.captured_at, payment.gateway
             FROM fees.payments payment
             JOIN fees.invoices invoice
               ON invoice.org_id = payment.org_id AND invoice.id = payment.invoice_id
             JOIN identity.users student
               ON student.org_id = invoice.org_id AND student.id = invoice.student_user_id
            WHERE payment.org_id = $1 AND payment.receipt_number = $2
              AND ($3::boolean OR EXISTS (
                SELECT 1 FROM identity.guardian_links guardian
                 WHERE guardian.org_id = invoice.org_id
                   AND guardian.guardian_user_id = $4
                   AND guardian.student_user_id = invoice.student_user_id
              ))`,
          [user.orgId, params.data.receiptNumber, isAdmin, user.id],
        ),
      );
      const row = result.rows[0];
      if (!row) return void res.status(404).json(errorBody("NOT_FOUND", "Receipt not found."));
      res.json({
        receiptNumber: row.receipt_number,
        invoiceNumber: row.invoice_number,
        studentName: row.student_name,
        description: row.description,
        academicYear: row.academic_year,
        period: row.period,
        amountPaise: Number(row.amount_paise),
        paidAt: dateTimeValue(row.captured_at),
        paymentMethod: row.gateway,
      });
    } catch (error) {
      next(error);
    }
  });
};

export default routes;
