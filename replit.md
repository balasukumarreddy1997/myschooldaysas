# [Project name]

_Replace the heading above with the project's name, and this line with one sentence describing what this app does for users._

## Run & Operate

- `npm run dev --workspace=@workspace/api-server` — run the API server
- `npm run typecheck` — full typecheck across all packages
- `npm run build` — typecheck + build all packages
- `npm run rls:check` — read-only tenant RLS audit against the local `campus` DB; requires root `.env`
- `npm run rls:write-check` — write-denial checks on all 31 current tenant tables using a fresh temporary PostgreSQL 16 cluster; requires root `.env` and local PostgreSQL tools; leaves the shared DB untouched
- `npm run codegen --workspace=@workspace/api-spec` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `npm run push --workspace=@workspace/db` — push DB schema changes (dev only)
- The API development workflow expects the ignored root `.env`; see `.env.example` for local-only defaults. It needs both `DATABASE_URL` (application role) and `MIGRATOR_DATABASE_URL` (migration role), plus the configured service URLs/secrets.
- The API development workflow loads the ignored root `.env`, then runs migrations and the development seed before starting. Use `.env.example` only for local development; never copy its defaults into production.

## Stack

- npm workspaces, Node.js 24, TypeScript 5.9
- API: Fastify 5
- DB: PostgreSQL + `pg` (raw SQL; no ORM)
- Validation: Zod (`zod/v4`), `drizzle-zod`
- API codegen: Orval (from OpenAPI spec)
- Build: esbuild (ESM bundle)

## Where things live

_Populate as you build — short repo map plus pointers to the source-of-truth file for DB schema, API contracts, theme files, etc._

## Architecture decisions

_Populate as you build — non-obvious choices a reader couldn't infer from the code (3-5 bullets)._

## Product

_Describe the high-level user-facing capabilities of this app once they exist._

## User preferences

_Populate as you build — explicit user instructions worth remembering across sessions._

## Gotchas

_Populate as you build — sharp edges, "always run X before Y" rules._

## Pointers

- See `MASTER_SPEC.md` for the product and production requirements
