CREATE SCHEMA IF NOT EXISTS fees AUTHORIZATION campus_migrator;

CREATE TABLE fees.invoices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES identity.organizations(id) ON DELETE CASCADE,
  student_user_id uuid NOT NULL REFERENCES identity.users(id) ON DELETE RESTRICT,
  section_id uuid NOT NULL REFERENCES academic.sections(id) ON DELETE RESTRICT,
  invoice_number text NOT NULL,
  academic_year text NOT NULL,
  period text NOT NULL,
  description text NOT NULL,
  amount_paise bigint NOT NULL CHECK (amount_paise > 0 AND amount_paise <= 1000000000),
  due_date date NOT NULL,
  status text NOT NULL DEFAULT 'unpaid' CHECK (status IN ('unpaid', 'paid', 'void')),
  created_by uuid NOT NULL REFERENCES identity.users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  paid_at timestamptz,
  UNIQUE (org_id, id),
  UNIQUE (org_id, invoice_number),
  UNIQUE (org_id, student_user_id, academic_year, period),
  CHECK ((status = 'paid') = (paid_at IS NOT NULL))
);
CREATE INDEX fees_invoices_org_due_idx ON fees.invoices (org_id, status, due_date);
CREATE INDEX fees_invoices_org_student_idx ON fees.invoices (org_id, student_user_id, created_at DESC);
-- @rls fees.invoices
ALTER TABLE fees.invoices ENABLE ROW LEVEL SECURITY;
ALTER TABLE fees.invoices FORCE ROW LEVEL SECURITY;
CREATE POLICY fees_invoices_org_scope ON fees.invoices
  USING (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = nullif(current_setting('app.org_id', true), '')::uuid);

CREATE TABLE fees.payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES identity.organizations(id) ON DELETE CASCADE,
  invoice_id uuid NOT NULL,
  amount_paise bigint NOT NULL CHECK (amount_paise > 0),
  gateway text NOT NULL CHECK (gateway IN ('mock', 'razorpay', 'manual')),
  gateway_payment_id text NOT NULL,
  receipt_number text NOT NULL,
  status text NOT NULL DEFAULT 'captured' CHECK (status IN ('captured', 'failed', 'refunded')),
  received_by uuid NOT NULL REFERENCES identity.users(id) ON DELETE RESTRICT,
  captured_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  UNIQUE (org_id, invoice_id),
  UNIQUE (org_id, gateway_payment_id),
  UNIQUE (org_id, receipt_number),
  FOREIGN KEY (org_id, invoice_id) REFERENCES fees.invoices (org_id, id) ON DELETE RESTRICT
);
CREATE INDEX fees_payments_org_captured_idx ON fees.payments (org_id, captured_at DESC);
-- @rls fees.payments
ALTER TABLE fees.payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE fees.payments FORCE ROW LEVEL SECURITY;
CREATE POLICY fees_payments_org_scope ON fees.payments
  USING (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = nullif(current_setting('app.org_id', true), '')::uuid);

GRANT USAGE ON SCHEMA fees TO campus_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON fees.invoices, fees.payments TO campus_app;
ALTER DEFAULT PRIVILEGES FOR ROLE campus_migrator IN SCHEMA fees
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO campus_app;

INSERT INTO public.schema_migrations (version) VALUES ('fees:001');
