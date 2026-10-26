ALTER TABLE identity.guardian_links
  ADD COLUMN can_view_live boolean NOT NULL DEFAULT true,
  ADD COLUMN can_pay_fees boolean NOT NULL DEFAULT true;

INSERT INTO public.schema_migrations (version) VALUES ('identity:003');
