# Campus Live — current build architecture

`MASTER_SPEC.md` is the product and security source of truth. This document records the runnable first slice in this Replit workspace; it does not replace or reduce the target architecture in the master spec.

## Current build

This build covers sign-in, a role-scoped dashboard, class/section directories, a paginated student roster, live-session scheduling and state changes, and board-template configuration.

| Area | Current implementation | Target in `MASTER_SPEC.md` |
|---|---|---|
| Web | React 19 + Vite artifact at `/` | Next.js 16 App Router |
| API | One Express API process at `/api`, with identity, academic, live, board, and dashboard route modules | Fastify 5 gateway plus independently deployed services |
| Data | PostgreSQL 16; `identity`, `academic`, `live`, and `board` schemas | Those schemas plus notify, school, learning, fees, and registry |
| Tenant access | `campus_app` is a non-superuser without `BYPASSRLS`; tenant tables use forced RLS and transaction-local `app.org_id` | Same principle, shared helpers and per-service enforcement |
| Migrations | A separate local `campus_migrator` role applies numbered migrations before the API starts | Release migration job, checksums, lock/statement limits |
| Redis | Readiness check only | Redis Streams event bus and service consumers |
| LiveKit | Local container is present; token minting refuses to proceed without `LIVEKIT_PUBLIC_URL` | LiveKit classroom, webhook processing, attendance, and recording flows |
| Authentication | Organization-scoped login, scrypt password verification, short-lived signed access token held in browser memory | Refresh rotation, lockout/rate limits, change-password flow, production key management |

The Vite/Express and single-process choices are explicit scaffold compromises, not a claim that the spec's Next.js/Fastify/microservice requirements have been met. No application code in this slice relies on Replit's managed database superuser.

## Trust boundaries and data flow

1. The browser is untrusted. It submits credentials and requests using an in-memory bearer token; it never selects LiveKit grants.
2. The API validates the token, reloads the user's current roles, applies route-level authorization, and derives organization scope from the authenticated user.
3. Database work runs in a transaction that sets `app.org_id` locally. Forced row-level security limits the non-superuser app role to that organization. The migration role is separate from the runtime role.
4. Redis is currently used only by the readiness probe. No event consumer or notification delivery path is implemented.
5. The LiveKit server is a separate trust boundary. Join-token generation is server-side, but classroom media and board collaboration are not available until the external URL and client integration are completed.

## Threat model (initial STRIDE pass)

| Threat | Current controls | Remaining risk |
|---|---|---|
| Spoofing | Password hashes, signed short-lived JWTs, current roles reloaded from the database | No refresh rotation, account lockout, password-change flow, asymmetric keys, or production key rotation |
| Tampering | Zod request validation, server-owned session grants, database constraints and RLS | Not every target endpoint exists; no complete privileged-user management surface |
| Repudiation | Structured request logging | No durable audit-log service or complete audit coverage |
| Information disclosure | Organization-scoped SQL, RLS, role-filtered academic queries, no token in local storage | Consent, export, erasure, retention, and full child-data access reviews are not implemented |
| Denial of service | API body-size cap and dependency readiness checks | No distributed rate limits, per-route budgets, load tests, or production capacity plan |
| Elevation of privilege | Route role checks and server-minted LiveKit grants | Full role-management safeguards and last-super-admin protection are not implemented |

## Important production gaps

This build is a development vertical slice, not a production release. In particular, it does not satisfy the master spec's Next/Fastify architecture, all §11 acceptance flows, or §17 release gates. Fees/payments, admissions/registry, notification, school operations, learning, consent enforcement, export/erasure, retention, backup/restore drills, CI, production containers, observability, accessibility automation, and release runbooks remain open. The browser preview has been checked at the login screen; authenticated screens were verified through API checks, not through a signed-in browser session.

## Local verification

- `pnpm -w run typecheck:libs`
- `pnpm --filter @workspace/api-server run typecheck`
- `pnpm --filter @workspace/api-server run test:unit`
- `pnpm --filter @workspace/campus-live run typecheck`
- `pnpm --filter @workspace/campus-live run build`
- API smoke checks against local PostgreSQL/Redis, including administrator, teacher, student, and parent access

The separate `snyk test` command was attempted but Snyk is not installed in this environment. No production deployment was performed.
