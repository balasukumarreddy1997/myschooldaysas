# Campus Live — current build architecture

`MASTER_SPEC.md` is the product and security source of truth. This document records the runnable first slice in this Replit workspace; it does not replace or reduce the target architecture in the master spec.

## Current build

This build covers sign-in, a role-scoped dashboard, class/section directories, a paginated student roster with admin profile management, live-session scheduling and state changes, board-template configuration, a learning and assessment workspace, and the live classroom described below.

| Area | Current implementation | Target in `MASTER_SPEC.md` |
|---|---|---|
| Web | Next.js 16 App Router + React 19 artifact at `/` | Next.js 16 App Router |
| API | One Fastify 5 API process at `/api`, with identity, academic, live, board, learning, and dashboard route modules | Fastify 5 gateway plus independently deployed services |
| Data | PostgreSQL 16; `identity`, `academic`, `live`, `board`, and learning migrations | Those schemas plus notify, school, fees, and registry |
| Tenant access | `campus_app` is a non-superuser without `BYPASSRLS`; tenant tables use forced RLS and transaction-local `app.org_id` | Same principle, shared helpers and per-service enforcement |
| Migrations | A separate local `campus_migrator` role applies numbered migrations before the API starts | Release migration job, checksums, lock/statement limits |
| Redis | Readiness check only | Redis Streams event bus and service consumers |
| LiveKit | Local container is present; token minting refuses to proceed without `LIVEKIT_PUBLIC_URL` | LiveKit classroom, webhook processing, attendance, and recording flows |
| Authentication | Organization-scoped login, scrypt password verification, short-lived signed access token held in browser memory | Refresh rotation, lockout/rate limits, change-password flow, production key management |

The web and API use the required Next.js and Fastify frameworks. The single API process remains an explicit scaffold compromise, not a claim that the spec's independent-service architecture has been met. No application code in this slice relies on Replit's managed database superuser.

## Workspace tooling

The repository uses npm workspaces with one root `package-lock.json`; use `npm ci` for a reproducible install. Shared TypeScript libraries are built before the application type checks. The former pnpm catalog versions and security overrides are represented in npm-compatible manifests. The 24-hour release-age safeguard and explicit dependency install-script allowlist are retained.

## Trust boundaries and data flow

1. The browser is untrusted. It submits credentials and requests using an in-memory bearer token; it never selects LiveKit grants.
2. The API validates the token, reloads the user's current roles, applies route-level authorization, and derives organization scope from the authenticated user.
3. Database work runs in a transaction that sets `app.org_id` locally. Forced row-level security limits the non-superuser app role to that organization. The migration role is separate from the runtime role.
4. Redis is currently used only by the readiness probe. No event consumer or notification delivery path is implemented.
5. The LiveKit server is a separate trust boundary. The client now connects using server-derived grants; students are subscribe-only until a teacher grants microphone access. Board drawing never grants media publishing. The WebSocket board operates independently of media availability. A publicly reachable LiveKit URL is still required to verify real media from this preview.

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

This build is a development vertical slice, not a production release. In particular, it does not satisfy the master spec's independent-service architecture, all §11 acceptance flows, or §17 release gates. Fees/payments, the full school-wide registry and student lifecycle, notification, school operations, consent enforcement, export/erasure, retention, backup/restore drills, CI, production containers, observability, accessibility automation, and release runbooks remain open. The browser preview has been checked at the login screen; authenticated screens were verified through API checks, not through a signed-in browser session.

## Local verification

- `npm run typecheck:libs`
- `npm run typecheck --workspace=@workspace/api-server`
- `npm run test:unit --workspace=@workspace/api-server`
- `npm run typecheck --workspace=@workspace/campus-live`
- `npm run build --workspace=@workspace/campus-live`
- API smoke checks against local PostgreSQL/Redis, including administrator, teacher, student, and parent access

The separate `snyk test` command was attempted but Snyk is not installed in this environment. No production deployment was performed.

## Learning and assessment implementation (2026-10-26)

- Admission profile intake update (2026-10-27): optional student date of birth, gender, phone, address, blood group, and guardian contact details now accompany single/batch admissions and persist atomically in the new tenant-RLS `identity.profiles` table. Guardian contact details are not account links. Migration `identity:004` applied locally; RLS audit passed for 34 tenant tables; academic integration passed including persisted profile fields and incomplete-guardian validation; `/api/healthz` and `/api/ready` returned `ok` and `ready`. Workspace build and API unit tests passed.
- Student profile management (2026-10-27): admins can find students within the selected section roster using contact fields, view current enrollment/profile details, and update or clear profile values. Read/write routes are admin-only and organization-scoped; guardian contacts do not create accounts or links. Workspace build passed, API unit suite passed 31/31, and local academic integration passed profile persistence, validation, role restrictions, and admin-only guardian-contact search. Health/readiness returned `ok`/`ready`. Only `/login` was verified in the browser; the signed-in profile UI was not browser-verified. No new migration was needed.
- The `/learning` page supports role-aware assignment creation, publishing/closing, student submissions, teacher grading and feedback, assessment marks, result publishing/unpublishing, academic terms, and grade-scale configuration.
- The API checks teacher section assignments, student enrollment, and guardian-child links on the server. Students can submit only their own work; guardian views are read-only; unpublished exam results are hidden from students and guardians. Exam marks lock while results are published.
- `services/learning/migrations/001_learning.sql` adds organization-scoped learning tables with forced RLS and org-leading indexes. The new numbered subject, attendance, and report-card migrations are registered and have now been applied to the local development database as `campus_migrator`; production was not touched.
- OpenAPI remains the API contract; generated React Query and Zod clients cover the learning routes. Audit entries are written for grading, mark edits, result publication, and grade-scale changes.
- Verification update (2026-10-27): `PORT=5179 BASE_PATH=/ npm run build` passed type-check and all workspace builds; API unit tests passed 26/26. Local authenticated API/PostgreSQL checks applied pending migrations, verified health/readiness, tenant scoping, and 4 subjects, 24 sections, and a 10-student attendance roster. A foreign-org token was rejected with 401. The demo report-card journey then published marks and 10 report cards, confirmed drafts are hidden from a linked parent, verified published student/parent reads, and rendered printable A4 HTML with CSP. The attendance percentage is unset because no attendance records were added. The preview screenshot only verified `/login`, not signed-in feature screens. `npm run rls:check` passed: all 31 tenant tables have forced RLS and scoped policies; 25 populated tables returned no rows under a foreign-org context, and 6 were empty. `npm run rls:write-check` passed on a temporary PostgreSQL 16 cluster for all 31 current tenant tables; cross-org INSERT and org reassignment were rejected, UPDATE/DELETE affected zero rows, same-org controls passed and rolled back, fixture integrity held, and the temporary cluster was stopped and removed. HTTP-level authorization cases, CI wiring, and the query-plan review remain open.
- The follow-on slice adds an admin-managed subject catalog and teacher assignments, a daily attendance register, and term report cards with published subject marks, percentages, grade, section rank, recorded attendance percentage, remarks, family read-only publication, and printable A4 HTML. Report-card APIs have been exercised against local PostgreSQL; attendance capture within the report-card term and the signed-in UI remain unverified. No production-readiness gate is claimed closed.
- Verification update (2026-10-27, G-04/G-08): section capacity, enrollment year, timetable room, persisted parent consent review, guardian live-view/payment controls, existing-account enrollment, up to 20 new student accounts, and admin profile viewing/editing are implemented. The new account, student role, and enrollment are one transaction; random temporary credentials require a password change and expire after seven days. Capacity checks lock the section row. Academic migration 006 adds enrollment end metadata and active-only uniqueness, enabling transfer and promotion to preserve previous records; local integration verified admin-only transfer, mapped cohort promotion, historical reasons, atomic capacity rejection, and existing admissions/profile checks. The migration runner now records versions after successful application. `PORT=8081 BASE_PATH=/ npm run build` passed all workspaces; API unit tests passed 31/31; API health/readiness returned `ok`/`ready`. The earlier `rls:check` and temporary-cluster `rls:write-check` passed for 33 tenant tables. Signed-in browser UI, school-wide registry, admission audit entries, fee enforcement, legal consent decisions, HTTP-wide authorization, CI and production gates remain open.
- Still outside this slice: calendar/non-working-day rules, attendance imports/history, diary, resources, progress, and learning analytics. No production-readiness gate is claimed closed.

## Live classroom implementation and evidence (2026-10-26)

- Starting a class creates one organization-scoped persistent board, using the teacher default template, then the organization default, then the built-in configuration. Class/section template precedence is not implemented because templates do not yet carry a class/section association.
- The full-screen classroom bypasses the admin shell. It has media connection/error states, camera/microphone/screen-share controls, audio-only video unsubscription, a shared stroke canvas, teacher configuration, drawing grants, and an attendance panel with manual overrides.
- Board traffic uses a same-origin WebSocket, never LiveKit data messages. A 30-second one-use ticket authenticates the upgrade; JWTs are not placed in the WebSocket URL. Operations are validated, sequence-numbered in PostgreSQL, deduplicated by UUID, and replayed on reconnect. Frames are capped at 64 KiB and 30 messages/second/socket. Above 5,000 operations, reconnect fails explicitly rather than silently returning incomplete history.
- LiveKit webhooks retain the exact raw payload and use the SDK's signature/checksum verifier. Event IDs are deduplicated transactionally. Join intervals are merged and clipped to the class duration; ending a class finalizes attendance at a configurable percentage. Automatic recomputation preserves manual status overrides. Board-only activity does not count as media attendance.
- Parent classroom access requires the session's parent-view flag, an enrolled linked child, and an active live-view consent. Recording is disabled. Organization scope and active roles are rechecked for board actions.

### Derived API surface

All paths have the `/api` prefix. HTTP classroom routes require the identity bearer token, except the independently signed webhook.

| Path | Behavior |
|---|---|
| `GET /live/sessions/:id/classroom` | Role-scoped session, board ID, drawing/manage flags and media availability |
| `POST /live/sessions/:id/token` | Server-scoped LiveKit SDK token; 503 if media is not configured |
| `PATCH /live/sessions/:id/settings` | Staff-only chat, room lock, parent view and attendance threshold |
| `GET/POST /live/sessions/:id/attendance` | Scoped report / staff override |
| `POST /live/sessions/:id/participants/:userId/permissions` | Teacher microphone grant/revoke for an enrolled student |
| `POST /board/boards/:id/ticket` | Short-lived one-use board ticket |
| `WS /board/boards/:id/ws?ticket=…` | Hello/replay, stroke, config, draw-grant and closed messages |
| `POST /live/livekit/webhook` | Verified `application/webhook+json` or JSON payload |

### Verification performed

| Check | Result / kind |
|---|---|
| API and web workspace type checks | Passed |
| API unit suite | 16 passed; includes grant separation and interval merging |
| Web production build | Passed |
| `RUN_CLASSROOM_INTEGRATION=1 npm run test:integration:classroom --workspace=@workspace/api-server` | Passed with an explicitly supplied least-privilege development `DATABASE_URL`; real PostgreSQL, HTTP and two WebSocket clients |
| Integration coverage | Teacher start/end, parent rejection, student override rejection, read-only/revoked drawing rejection, persisted replay/deduplication, forged webhook rejection, verified synthetic event deduplication, finalized attendance and preserved manual override |
| `npm audit --omit=dev --audit-level=high` | 0 vulnerabilities |
| Browser screenshot | Login renders without errors; signed-in classroom UI not visually verified |

No real camera/audio/screen-share session was exercised: the existing LiveKit container is loopback-only and `LIVEKIT_PUBLIC_URL` is unset. The signed events in the integration test are synthetic and must not be presented as a real LiveKit call.

### Still open; not production-ready

Tickets and broadcasts are process-local; multi-instance Redis fan-out, reconnect snapshots/compaction, durable moderation auditing, immediate passive-subscriber revocation, per-user connection limits, and complete security/browser journeys remain open. The current canvas supports strokes only, not multi-page boards, undo/redo, shapes, text, export or replay playback. Chat/hand-raise UI, mute/remove controls, the session-settings UI, and generated OpenAPI contracts for the new classroom endpoints remain incomplete. Microphone changes require a running public LiveKit connection and have not been verified against one. CI remains deferred at the user's request. No §17 release gate is claimed closed by this work.
