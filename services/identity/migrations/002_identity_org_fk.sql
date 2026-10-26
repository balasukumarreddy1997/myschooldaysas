CREATE UNIQUE INDEX users_org_id_id_uidx ON identity.users (org_id, id);

INSERT INTO public.schema_migrations (version) VALUES ('identity:002');
