# Managed database setup

## Chosen scope

Use Replit-managed PostgreSQL for the published application. Preserve the existing local database. Copy the application schema, not the local demo accounts.

The managed **development** database was initially empty. The existing 22 service migrations listed in `scripts/db/migrate.sh` were applied there in one transaction, without editing any applied migration. No local data or credentials were copied.

## Verification performed

Against the managed development database:

| Check | Result |
| --- | --- |
| `SELECT COUNT(*) FROM public.schema_migrations` | 22 |
| Tenant tables with an `org_id` column | 40 |
| Tenant tables with enabled and forced RLS | 40 |
| Tenant tables with read/write RLS predicates | 40 |
| `SELECT COUNT(*) FROM identity.organizations` | 0 |
| `SELECT COUNT(*) FROM identity.users` | 0 |
| `campus_app` role | NOSUPERUSER, NOBYPASSRLS, no public-schema CREATE |
| `campus_migrator` role | NOSUPERUSER, NOBYPASSRLS; owns service schemas |

A transaction-only isolation test created two synthetic organizations and users, switched to `campus_app`, and verified:

- Own-organization rows were visible.
- Another organization's rows were hidden.
- A cross-organization update affected zero rows.
- A cross-organization insert raised `insufficient_privilege`.
- The app role could not create objects in `identity`/`public` or truncate `identity.users`.

The test transaction was rolled back. A subsequent query confirmed that organizations and users were both still empty.

## Remaining publication requirements

1. Supply `JWT_SECRET` and `INTERNAL_API_KEY` through secure production Secrets.
2. Publish through Replit's supported schema-diff flow. No production database was available during the development-schema checks above. No direct production DDL, startup migration, or deployment-build migration has been added.
3. Verify custom ownership/grants and the **actual production connection role**. The administrative SQL tool's identity is not proof of the application's runtime identity. The two custom development roles were deliberately created `NOLOGIN`; no database passwords or developer default credentials were assigned. Do not assume that custom roles, role passwords or memberships are transferred by schema publishing.
4. Keep the API startup rejection of superuser/BYPASSRLS connections intact. If the managed production runtime role is privileged, resolve its credentials/permissions through supported database administration before exposing the app; do not use `SET ROLE` on an authenticated superuser connection as a security substitute.
5. Provision the school's first organization and administrator securely, then verify real signed-in core journeys. An empty schema does not provide a usable login. Do not import demo passwords or seed production.

## Future schema work

The local API workflow sources `.env` and migrates the local database. That does not update the managed database automatically. Apply future numbered service migrations to managed **development** explicitly, verifying the target and tracking migration versions; Publishing is responsible for managed production schema changes. Never add production DDL to API startup or build commands.
