ALTER TABLE registry.admission_activity
  ADD COLUMN previous_follow_up_on date,
  ADD COLUMN next_follow_up_on date;

INSERT INTO public.schema_migrations (version) VALUES ('registry:002');
