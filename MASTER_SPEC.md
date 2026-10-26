# MASTER SPEC — Campus Live Platform

Single source of truth for rebuilding the whole product from an empty directory.
*Self-contained.* This file consolidates the earlier product research, RBAC, roadmap, architecture, admin, Phase 2/3, web and design documents. Their content is in Part I (§1–§17, requirements and status) and Part II (Appendices A–J, reference material). *No other file is required* to build, operate or verify the platform; if any other document disagrees with this one, this one wins.
Where older docs disagree with this file, *this file wins*.

*Revision 2 (2026-10-23): reconciled against the actual code in platform/* (four read-only audits: shared/identity/academic/gateway, live/board/notification, school/learning/fees/registry, web/infra). Sections describe what is *built and verified by reading code. Anything the original design wanted but the code lacks is listed in *§15 Gap register** with an ID (G-xx) so a builder can either implement it or consciously defer it. Nothing was executed during the audit, so "built" means "present in code", not "tests pass".

*Revision 4 (2026-10-23): production requirements.* New §17 (production requirements with IDs PR-*, evidence marks and release gates) from two further audits (security/auth/config, operations/infra/CI) plus direct spot-checks of the three most serious findings. Headline: the platform is a working dev stack, **not production-ready**; see §17.9.

*Revision 3 (2026-10-23): gap-closing pass (MODE=CONTINUE steps 1–4).* Baseline and a post-change full run passed (build, type-check, npm test, rls:check). Closed or advanced in this pass: G-01, G-02, G-03 (structural), G-04, G-05 (mute-all), G-06, G-08 (schema only), G-09 (stale), G-10. Statuses with evidence and limits are in *§15. Every fix so far is covered by unit tests with fakes; **no gated integration test, no service start and no browser check has been done for them* — see §16 for how to run those.

---

## 1. Product

Multi-tenant *school and college platform: live classes with a configurable smartboard, plus the daily operations of a school. Four logins: **Admin, Teacher/Faculty, Student, Parent*.

Differentiators (build these first, polish them most):
1. Section-wise and class-wise *live classes* (LiveKit) with server-minted, role-scoped tokens.
2. *Smartboard*: whiteboard whose whole behaviour is configuration data, editable without code, changeable live mid-class.
3. *Auto attendance* from live join events; parent live view gated by policy + consent.
4. *Student 360* and analytics for admin, teacher, parent.

Market: India (INR, IST, Razorpay, DPDP Act consent, Hindi later). Scale: 5k–50k users, <500 viewers per live room. Seed scale: Grades 1–10 × sections A,B (20 sections), ~240 students, 30 faculty, ~130 parents.

## 2. Scope

| In scope (build) | Out of scope (document only, roadmap) |
|---|---|
| Identity/RBAC, academic structure, live classes, smartboard, notifications | Transport + live bus tracking (designed in Appendix G) |
| School ops: calendar, attendance, notices, leave, HR, messaging, PTM, grievances, audit | Native Expo mobile apps (PWA-first) |
| Learning: assignments, exams, marks, report cards, diary, resources, progress | Legacy-system (Octopod) import pipeline (designed in Appendix H) — only CSV bulk import is built |
| Fees: structures, invoices, payments, Razorpay + mock gateway, receipts, reports | Payroll, hostel, canteen, library, proctored exams, white-label, public API |
| Registry: admissions, exits/TC, certificates, ID cards, student/staff records, 360 views | Supabase (the platform uses its own Postgres + JWT; any earlier Supabase design is superseded, see Appendix A) |
| Analytics hub, admin/teacher/parent/student web portals, public /apply form | HLS broadcast egress, recordings-on-demand UI beyond hook + event |

The legacy app/ folder is a Next.js + in-memory demo of the live-class RBAC idea. It is *superseded* by platform/. Do not extend it.

## 3. Architecture (fixed decisions)

Monorepo (npm workspaces), TypeScript strict ESM, Node ≥20, Fastify 5, zod, pg (no ORM), Redis Streams event bus, one Postgres with *schema per service, org_id + **RLS* on every tenant table (app connects as non-superuser campus_app), Next.js 16 + React 19 + Tailwind 4 web, LiveKit server in Docker, vitest.


Browser (Next.js :3000) ── REST Bearer JWT ──► gateway :8080 ─► identity :4001
        │  WebRTC ─► livekit :7880            (routing, JWT pre-check,  academic :4002
        │  WS /ws/board/:id (via gateway)      CORS, rate-limit,        live     :4003
        ▼                                      blocks /internal/*)      board    :4004
 postgres :5432 (schemas) · redis :6379                                 notification :4005
                                                                        school   :4006
                                                                        learning :4007
                                                                        fees     :4008
                                                                        registry :4009


Gateway prefixes: /api/{identity,academic,live,board,notify,school,learning,fees,registry}/* (notify → notification service). Public (no JWT, allow-listed in gateway/src/routes.ts): POST /api/identity/auth/{login,refresh,logout} (20/min limit), POST /api/registry/public/enquiry, GET /api/registry/public/verify/*, POST /api/fees/payments/razorpay/webhook, /health. Global rate limit 300/min per IP. GET /health/all aggregates service health + latency. WS GET /ws/board/:id proxied to board /boards/:id/ws. Gateway tests: route resolution, 401, internal 404, 502; none for WS proxy or rate limits (G-13).

### 3.1 Non-negotiable conventions

| Topic | Rule |
|---|---|
| Shared code | Only @campus/shared: JWT + Fastify auth decorators, RBAC helpers, withOrg/withSystem/migrate, EventBus, buildServer, BoardConfigSchema. Services never import each other |
| DB | Schema per service: identity, academic, live, board, notify, school, learning, fees, registry. No cross-schema SQL |
| Tenancy | Every tenant table has org_id uuid NOT NULL + RLS via a -- @rls <table> line in the migration; queries run inside withOrg(pool, claims.org, ...). identity.orgs itself has no RLS. Index FK columns (target (org_id, fk); code currently indexes single FK columns — G-14) |
| Migrations | services/<svc>/migrations/NNN_name.sql, applied at boot by migrate(pool, "<schema>", dir) |
| Auth | JWT HS256 (JWT_SECRET); claims {sub, org, name, roles:[{role,scope_type,scope_id}]}; issued only by identity; scrypt passwords; refresh rotation; login lockout. Every service verifies (gateway also) |
| Service-to-service | x-internal-key: $INTERNAL_API_KEY on /internal/* (app.internalOnly, returns **401** on missing/bad key), via internalFetch. Gateway blocks any path containing an internal segment (404) |
| Events | Redis Stream campus:events; envelope {id,type,org_id,occurred_at,data}; consumer group per service; handlers idempotent on id |
| Errors | { "error": { "code", "message", "details?" } } |
| IDs/time | uuid v4 gen_random_uuid(); ISO-8601 UTC timestamptz |
| Pagination | ?limit (≤100, default 50) &offset; lists return { items, total }. Known exception: academic GET /enrollments (default 500, max 1000) — G-15 |
| Config | Env vars only (§12). Dev defaults only where documented |
| Tests | Per service: vitest unit tests for pure logic + one integration test gated by RUN_INTEGRATION=1 |
| Commits | Conventional Commits + AB#<id>; run snyk test before adding a dependency |

### 3.2 Roles and scopes

Roles (the shared ROLES enum, exactly these 8): super_admin, org_admin, campus_admin, hod, teacher, class_teacher, student, parent. Accountant, admissions officer, HR manager, nurse are *not* separate roles today; admin roles perform those functions (G-16). In academic, hod also has write access (canWrite).
Scope types: platform > org > institution > campus > department > class > section. A grant at a scope covers everything below it; platform/org covers the whole org.

Permission matrix (R read, W write, A approve, – none, own/child scoped):

| Resource | Admin roles | Teacher | Student | Parent |
|---|---|---|---|---|
| Users, roles, org settings | RW | – | – | – |
| Students, guardians | RW | R (own sections) | R own | R child |
| Timetable | RW | R | R | R child |
| Attendance | RW | RW (own sections) | R own | R child |
| Live session | RW / observe | RW (assigned sections) | join (enrolled) | join only if session parent_view is on *and* the guardian link has can_view_live (fails closed if academic does not return the flag) |
| Assignments, marks | R | RW (own sections) | R, submit own | R child |
| Fees | RW | – | R own | R child; pay only where the guardian link has can_pay_fees |
| Notices | RW | RW own sections | R | R |
| Leave | approve | approve student leave (class teacher); apply own | apply | apply for child |
| Admissions, exits, certificates | RW | – | – | apply/request own |
| Health/discipline | RW | alerts + own-section notes | R own | R child (visible_to_parent only) |
| Audit log | R | – | – | – |

Enforcement order: *RLS (primary) → server-side access check → UI hiding (cosmetic)*. Section/student access is always decided by academic GET /internal/sections/:id/access; guardian→children via GET /internal/guardians/:parentId/students.

## 4. Shared package @campus/shared

auth.ts (sign/verify, decorators authenticate, internalOnly, role helpers) · db.ts (withOrg, withSystem, migrate, RLS macro) · events.ts (EventBus, EventType union) · errors.ts · server.ts (buildServer: uniform errors, /health, structured logs) · board-config.ts (BoardConfigSchema, client-safe subpath export @campus/shared/board-config).

EventType (in events.ts): user.created, user.role_assigned, section.created, enrollment.added, enrollment.removed, timetable.slot_created, live.session.scheduled|started|ended|cancelled, live.participant.joined|left, live.recording.ready, attendance.marked, board.created|snapshot_saved|template_changed, notice.published, leave.requested|decided, assignment.published|graded, exam.published, invoice.generated, payment.captured, fee.reminder, report_card.published, student.exited, admission.offered|admitted, certificate.issued, exit.requested, substitution.assigned, message.sent, ptm.booked, grievance.raised.

audit.ts exports createAuditClient / AuditFn / AuditRecord: best-effort POST to school /internal/audit (never throws, reports failures through onError). Every service that audits receives an audit: AuditFn dependency; tests inject a fake. Learning, live, registry, fees and identity each currently carry their own copy of a small record-builder (buildAuditRecord / makeAuditor) — consolidate into shared (G-23).

shared has one test file (audit.test.ts, 3 tests); the rest is untested (G-13). EventBus.subscribe exists but only notification consumes events.

## 5. Services

Each service ships README.md, src/, migrations/, tests and an idempotent seed, and (when built from scratch) a short SPEC.md *derived from this file* — the per-service SPEC is a convenience copy, never a second source of truth. Tables listed here and in Appendix E are the contract; add columns freely, never rename.

### 5.1 identity (4001, schema identity)
- Tables: orgs(id,slug unique,name,settings jsonb, created_at) (no RLS), users(id,org_id,email,name,phone,password_hash,status active|disabled,created_at; unique org_id+email), refresh_tokens(token_hash unique,expires_at,revoked_at), user_roles(id,user_id,role,scope_type,scope_id), profiles(user_id,org_id,kind student|staff|parent,external_no (unique per org+kind where not null),dob,gender,phone,address,department,designation,joined_on,guardian_name,guardian_phone,blood_group,photo_url,extra jsonb,updated_at) (migration 002_admin.sql).
- orgs.settings default: {parent_view_default:false, min_attendance_pct:50, academic_year:"2026-27", timezone:"Asia/Kolkata", chat_enabled_default:true}.
- API: POST /auth/login {org_slug,email,password} (gateway rate-limit 20/min), /auth/refresh, /auth/logout, GET /me (user + roles; *no profile* — G-17); GET/POST /users, GET/PATCH /users/:id (?role&q&status&ids&limit&offset), POST /users/:id/roles, DELETE /users/:id/roles/:roleId, GET|PUT /users/:id/profile, POST /users/:id/reset-password, POST /users/bulk {kind,rows,confirm} (dry-run → {valid,errors[],preview[]}; confirm → creates users, role, profile, temp password Welcome@<4digits> returned once in credentials[], parent user from guardian email; emits user.created with class_name/section_name but *no consumer enrolls* — web must call academic /enrollments/bulk, G-18), POST /orgs (super_admin), GET /stats, GET|PUT /orgs/current/settings, GET /analytics/users.
- Internal: GET /internal/users/:id, GET /internal/users (?ids= or ?org_slug=), GET /internal/users/by-role, GET /internal/orgs/by-slug/:slug, GET /internal/orgs/:id/settings, POST /internal/users/:id/status.
- Seed writes services/identity/seed-output.json (consumed by academic seed).
- *Audited* (AuditFn): role.grant, role.revoke, user.status (PATCH and internal, actor null), user.reset_password (also when PATCH carries a password; no secret in meta), user.bulk_import (confirm only), org.settings.

### 5.2 academic (4002, schema academic)
- Tables (actual): classes(name,grade_level; unique org+name), sections(class_id,name), subjects(name,code), enrollments(student_id,section_id,status; unique student+section), teacher_assignments(teacher_id,section_id,subject_id,is_class_teacher), guardians(parent_id,student_id,can_view_live bool default true,can_pay_fees bool default true), timetable_slots(section_id,subject_id,teacher_id,weekday 0-6,start_time,end_time,room), consents(parent_id,student_id,purpose live_view|recording|photo|data_processing,granted_at,revoked_at,granted_by) — all via migration 002_guardian_flags_capacity.sql, which also adds sections.capacity and enrollments.academic_year. Class teacher = teacher_assignments.is_class_teacher (derived into class_teacher_id on GET /sections?with_counts). *Schema only*: no route reads or writes capacity, academic_year, room yet (G-08), and consents has no routes and no enforcement (G-04b).
- API: CRUD classes/sections/subjects (PUT/DELETE; GET /sections?with_counts=1|true); GET|POST|DELETE /sections/:id/students, POST|DELETE /sections/:id/teachers; GET /enrollments, POST /enrollments/bulk (idempotent), /enrollments/transfer, /enrollments/promote {from_class_id,to_class_id,section_map}; /teacher-assignments, GET /teachers/:id/workload; GET|POST|DELETE /guardians (POST upserts and accepts optional can_view_live / can_pay_fees; on re-link only flags sent are changed); GET /my/sections|children|timetable; GET/POST /timetable, DELETE /timetable/:id with *conflict detection* (teacher or section overlap ⇒ 409); GET /stats; analytics strength, teacher-load, timetable-coverage.
- Internal: GET /internal/sections/:id/access?user_id= → {is_teacher,is_enrolled,is_guardian,can_view_live,class_id,section_name} (can_view_live = at least one linked child in that section allows it); GET /internal/sections/:id, /sections/:id/students, /sections/:id/teachers(?class_teacher=1), /classes/:id/sections, /teachers/:id/sections, /guardians/:parentId/students → {student_ids}, /guardians/:parentId/payable-students → {student_ids} (children with can_pay_fees), /students/:id/guardians, /students/:id/section; POST /internal/students/:id/exit.
- Seed needs identity seed first (reads seed-output.json or GET /internal/users?org_slug=demo); *skips with a warning if missing*.

### 5.3 live (4003, schema live)
- Tables (actual): sessions(id,org_id,title,teacher_id,mode section|class,class_id,status,room unique,start_at,end_at,started_at,ended_at,record,board_id,board_template_id,board_config_override jsonb,settings jsonb{chat_enabled,parent_view,lock_room,min_attendance_pct},created_at), session_audience(session_id,section_id), participants(session_id,user_id nullable,identity,role,joined_at,left_at,seconds) unique (session_id,identity,joined_at), attendance(session_id,student_id,status,source auto|manual,seconds) unique (session_id,student_id), webhook_events(id) (dedupe), recordings(session_id,url,status).
- State machine: scheduled → live → ended (cancelled from scheduled). Illegal transition ⇒ 409.
- Token grants (grants.ts; server decides, never the client): teacher = publish + data + roomAdmin; student = subscribe, canPublish=false, data only if chat_enabled; viewer (guardian) = subscribe only, *requires parent_view AND academic's can_view_live === true* (missing flag ⇒ no viewer role; admins still fall through to observer); observer (admin roles) = subscribe only + hidden. Role resolved via academic access check / teacher_id / admin roles. Token route: 409 if ended/cancelled, 409 if scheduled and caller not teacher, 403 if lock_room for student/viewer, TTL 3600 s.
- API: POST /sessions (defaults chat_enabled_default/parent_view_default from org settings, cached 60 s), GET /sessions (?mine=1), GET /sessions/:id, POST /sessions/:id/{start,end,cancel,token}, POST /sessions/:id/participants/:identity/{mute,remove,permissions} (staff only, session live; permissions {canPublish} is the mic grant/revoke), POST /sessions/:id/mute-all (same guards; mutes every participant except the caller, the session owner and anyone with role teacher; returns {muted:n}), POST|GET /sessions/:id/attendance (manual override), GET /sessions/:id/recordings, POST /livekit/webhook (LiveKit WebhookReceiver signature, idempotent on event id; handles participant_joined/left, egress_ended), GET /admin/overview, GET /reports/attendance(.csv), GET /reports/teachers, analytics engagement, teacher-sessions. Hand-raise is client-side only (LiveKit data message, in web/.../Classroom.tsx); there is no server state for it and *no waiting room* (G-05b, deferred).
- Auto attendance runs *synchronously inside endSession*: present if seconds ≥ min_attendance_pct% × duration, else absent (never auto late); manual override with source=manual. Emits attendance.marked.
- *Audited*: live.participant.remove|mute|mute_all|permissions, live.recording.access, attendance.override.
- Emits live.session.scheduled|started|ended|cancelled, live.participant.joined|left, live.recording.ready, attendance.marked. Consumes no events.
- On start: call board POST /internal/boards, store board_id. Internal: GET /internal/sessions/:id.

### 5.4 board (4004, schema board) — smartboard
- Tables (actual): templates(id,org_id nullable (system),name,scope system|org|class|section|teacher,scope_id,config jsonb,is_default,created_by), boards(id,session_id unique,section_id,class_id,teacher_id,template_id,config jsonb (already resolved+overridden),status open|closed,active_page_id,seq), pages(board_id,idx,title,snapshot jsonb,snapshot_seq) (snapshots live on the page; no separate table), ops(id bigserial,board_id,seq,page_id,user_id,op jsonb; unique (board_id,seq) and (board_id,op->>'id')), draw_grants(board_id,user_id,can_draw).
- *Config = data* (BoardConfigSchema in @campus/shared/board-config, real field names):
  - background{type blank|ruled|grid|dots|graph|music|image, color, lineColor, spacing, imageUrl?}
  - canvas{mode infinite|fixed, aspect 16:9|4:3|A4|free, maxPages}
  - tools[] of ToolId = select|pen|highlighter|eraser|laser|line|arrow|rect|ellipse|triangle|text|sticky|image|ruler|protractor|compass|graph|latex|pan, defaultTool, palette, penSizes
  - toolbar{position,size,autoHide}
  - participants{studentsCanView, studentsCanDraw, allowDrawGrants, studentTools, followTeacherPage}
  - features{pressureSensitivity, palmRejection, shapeRecognition, undoRedo, snapshotIntervalSec, exportFormats}
- Resolution (TEMPLATE_PRECEDENCE): *section > class > teacher > org > system*, deep-merged with the session's board_config_override; teacher edits live via PATCH /boards/:id/config → broadcast config frame.
- Realtime: client connects /ws/board/:id?access_token=&since=; gateway rewrites to board GET /boards/:id/ws. Frames — client: op|cursor|page|grant|undo|redo|ping; server: hello|op|cursor|page|grant|config|snapshot|synced|error|pong|closed. Server assigns monotonic seq, persists, rebroadcasts; client dedupes by seq, late-join replays from latest page snapshot, reconnect with ?since=. Students read-only until teacher grants draw per user. LiveKit carries A/V/screen only. Target ≤200 ms.
- REST: GET /boards/by-session/:sessionId, GET /boards/:id, PATCH /boards/:id/config, GET|POST /boards/:id/pages, DELETE /boards/:id/pages/:pageId, PUT|GET /boards/:id/pages/:pageId[/snapshot], GET /boards/:id/export; templates GET /templates, POST /templates/preview, GET /config/resolve, POST /templates, PATCH|DELETE /templates/:id, POST /templates/:id/set-default. Ops, page switch and draw grants happen *only over WS frames* (no REST). Internal: POST /internal/boards, POST /internal/boards/:id/close.
- Emits board.created, board.snapshot_saved, board.template_changed. Consumes none. Role resolution for WS: live GET /internal/sessions/:id + academic access check.

### 5.5 notification (4005, schema notify)
Consumes events (consumer group, idempotent via processed_events) → in-app inbox (notifications), SSE GET /notifications/stream, GET /notifications, POST /notifications/read-all, POST /notifications/:id/read, device registry POST|DELETE /devices (web|android|ios), pluggable channel providers (providers.ts; log/in-app real, push/SMS/email/WhatsApp stubbed). POST /internal/notify. Event→recipient/message mapping lives in src/mapping.ts (pure, 21 unit tests; append-only cases) and covers every event in §6 except user.role_assigned, enrollment.removed, section.created, timetable.slot_created, board.*, live.participant.*. *Preferences* (migration 002_preferences.sql, table notify.preferences(user_id,channel,category,enabled)): channels in_app|push|sms|email|whatsapp, categories academic|attendance|fees|live|admin|safety|messages; GET /preferences returns the full matrix, PUT /preferences {items} (≤50; safety cannot be disabled); a missing row means enabled. Delivery honours it: in_app off ⇒ no inbox row and no SSE; a provider whose channel is off is skipped (only webpush→push is mapped; sms/email/whatsapp providers do not exist yet). categoryOf(event) maps events by prefix; a test fails if a mapped event has no category. Route/SQL path untested (migration not applied by tests). No handler/route/provider integration tests (G-13).

### 5.6 school (4006, schema school)
- *Calendar* (calendar_events, GET /calendar/is-working-day), *daily attendance* (attendance_sessions + attendance_marks; refuses non-working days unless admin; summary %, today overview), *notices* (+notice_reads, audience org|class|section|role, urgent), *leave* (types, balances, half-day, approval chain teacher→HOD→admin, balance check 409 unless LOP, approved student leave auto-marks leave), *audit log* (audit_log, GET /audit), *stats overview*.
- *Staff HR: leave_types, leave_balances, **substitutions* (auto-open on approved staff leave; GET /substitutions/suggest pure fn: free that period, same dept first, lowest workload), *staff attendance* (check-in/out, admin mark, leave auto-fill).
- *Messaging* (threads/messages; parent↔️teacher only for their child's teachers), *PTM* (events, slots, book/cancel/done), *grievances* (+comments, analytics), *analytics* attendance-trend, attendance-by-class, absentee-heatmap, leave-stats, chronic-absentees.
- Extras beyond the original contract: GET /notices/:id/stats, /leave/types, /leave/balances, lazy default leave types (ensureLeaveTypes), leave_requests.stage hod|admin for the approval chain, internal GET /internal/attendance/student/:id/summary and POST /internal/audit (nobody calls the latter yet — G-02).
- GET /leave?user_id= and GET /substitutions?teacher_id= are honoured: admin may ask about anyone, anyone else only about self (canFilterByPerson); user_id narrows to that person's staff leave and never widens the normal scope; teacher_id matches absent or substitute teacher and no longer requires admin when it is the caller. SQL path covered only by the pure permission test (G-01 residual).
- Gap: no geofence on staff check-in (optional, deferred).

### 5.7 learning (4007, schema learning)
Assignments + submissions (late flag, grading; *publish/close are status transitions through PUT /assignments/:id, no separate routes), GET /my/assignments, GET /students/:id/assignments, terms (/terms), exams + marks (bulk grid PUT /exams/:id/marks; POST /exams/:id/publish {published} doubles as lock — editing blocked once published; parents/students see published only), GET|PUT /grade-scale (default A1..E 90/80/70/60/50/40/33), **report cards* (GET /report-cards/:id[/print], POST /report-cards/:id/remark, POST /report-cards/publish; tables report_card_remarks, report_card_publications; per-subject %, grade, rank, attendance % from school internal, printable A4 HTML), diary, resources, progress, analytics performance-distribution, subject-averages, section-comparison, student-trend, toppers, at-risk, assignment-stats, teacher-effectiveness. No internal routes. *Audited*: submission.grade, marks.edit, exam.publish|unpublish, report_card.publish|remark, grade_scale.edit.

**Current Replit slice (2026-10-26):** Assignments, learner submissions and teacher grading; assessments, marks, terms, grade-scale settings, and published-result visibility are implemented in the workspace. The learning migration has not been applied or exercised against a database in this session because `.env` and `MIGRATOR_DATABASE_URL` are unavailable. Report cards, diary, resources, progress, and analytics remain outside this slice.

### 5.8 fees (4008, schema fees)
Tables: fee_heads, fee_structures, concessions, invoices (idempotent per student+period), payments (gateway manual|razorpay|mock), receipts, number_sequences, webhook_events, family_links. Sibling discount via POST /families + family_links (extra, not in original contract). PaymentGateway interface: RazorpayGateway (REST + signature verify when keys set) and MockGateway (default; POST /dev/mock-pay/:orderId); GET /gateway reports which is active. POST /payments/razorpay/webhook (gateway-allow-listed public route; verified + idempotent on event id) and POST /payments/razorpay/verify. Manual cash/UPI/cheque payments, partial allowed; POST /invoices/:id/{void,payments,pay}. Reports: collection, defaulters (+CSV), GET /period/current, analytics collection-trend, outstanding-by-class, payment-mode-split, aging, forecast. Internal GET /internal/students/:id/dues. Printable receipts GET /receipts/:id[/print]. Reminders POST /reminders/send. POST /invoices/:id/pay additionally requires can_pay_fees for parents (canPayFor; fails closed if academic is unreachable). *Audited*: concession.create|delete, invoice.void, invoice.generate, payment.manual, payment.captured (actor null, first capture only), fee_structure.create|update|delete, family.link.

### 5.9 registry (4009, schema registry)
- *Admissions*: enquiries → applications → offer → admit with state machine (illegal ⇒ 409), activity timeline, documents, printable offer letter, admit orchestrates identity + academic + guardian + optional first invoice, funnel + analytics, capacity per class, public POST /public/enquiry.
- *Exits & certificates*: exit workflow requested → dues_check → approved → issued; TC numbering TC/2026/0001; on issue: enrollment left, user disabled, emit student.exited. Certificates (tc, bonafide, character, study, fee, dob) with printable A4 + inline-SVG QR + public GET /public/verify/:number. ID cards (single + batch 8-up).
- *Records*: student_records (health fields redacted for non-authorised), health_checkups, discipline_notes (visible_to_parent), achievements, student_documents, staff_records.
- *Student 360* GET /students/:id/360 fans out with caller JWT, each call failure-tolerant (section null), returns {profile, academics, attendance, performance, assignments, fees|null, behaviour, achievements, health|null, documents, flags[]}; flags from a pure function (low_attendance, falling_marks, fees_overdue, incident) with org-setting thresholds. Response also carries student_id, term_id, generated_at, live, meta. *Staff 360* likewise, but currently shows the wrong person's leave/substitutions (G-01). Extras: exit sub-routes dues-check, approve, reject, cancel, issue-tc; certificates.number null until issued; staff ID card print; GET|PUT /admissions/capacity; enquiry notes via POST /enquiries/:id/notes stored in admission_activity. No internal routes. *Audited*: application.admit|status|offer, exit.request|dues_check|approve|reject|cancel|issue_tc, certificate.request|issue|reject, student_record.edit, health_checkup.create|delete, discipline.create|edit|delete, student_document.verify, staff_record.edit, admissions.capacity (no free text in meta). Not audited: enquiry/application create/update/documents, achievements, document upload/delete, public enquiry.

## 6. Event catalogue (actual)

Only *notification* consumes events. Everything else is synchronous HTTP.

| Producer | Emits | Notification maps? |
|---|---|---|
| identity | user.created, user.role_assigned | created yes; role_assigned no |
| academic | section.created, enrollment.added|removed, timetable.slot_created | enrollment.added only |
| live | live.session.scheduled|started|ended|cancelled, live.participant.joined|left, live.recording.ready, attendance.marked | sessions, recording, attendance yes; participant no |
| board | board.created, board.snapshot_saved, board.template_changed | no |
| school | attendance.marked(source manual), notice.published, leave.requested|decided, substitution.assigned, message.sent, ptm.booked, grievance.raised | all yes |
| learning | assignment.published|graded, exam.published, report_card.published | all yes |
| fees | invoice.generated, payment.captured, fee.reminder | all yes |
| registry | admission.offered|admitted, exit.requested, certificate.issued, student.exited | all yes |

Attendance finalisation after a live class is *not* event-driven (done inside endSession).

## 7. Web (@campus/web, :3000)

Next.js 16 App Router, React 19, Tailwind 4, @livekit/components-react, livekit-client, perfect-freehand, recharts. Auth: access token in memory + refresh in localStorage; client AuthGate. *No async/redirect() in layouts. Gate any profile/session/role UI on mounted; no Date.now()/locale formatting directly in JSX* (hydration rule). Run next dev on Windows, not WSL against /mnt/c.

Routes:
- Public: /login (org slug default demo), /apply (enquiry form).
- /dashboard role-based; notification bell (SSE).
- Live: /sessions/new, /sessions/[id], /classroom/[sessionId] (role-adaptive; *dark-first, bypasses AppShell*), /boards/templates, /boards/templates/[id] (no-code configurator with live preview, scope picker).
- Admin /admin/* (built): dashboard, students (+[id] Student 360, bulk import component), faculty (+[id]), parents, classes (+[sectionId]), timetable grid, live monitor, reports, settings, calendar, notices, leave, fees, audit, admissions (Kanban + funnel components), exits, certificates, analytics hub, grievances, PTM, substitutions, staff-attendance, attendance, exams. ID-card sheet is a button on /admin/certificates (openAuthedHtml(.../id-cards/print?section_id=); per-student print has no UI); the promote-class wizard exists on /admin/classes (3 steps → POST /enrollments/promote).
- Teacher /teach/* (built): my day, attendance, assignments + grading, marks grid, diary, notices, leave, messages, analytics, profile, ptm, students (+[id] 360), substitutions.
- Student /learn/*: **timetable** (weekday×time table from md up, stacked per-day list below; today highlighted after mount; shows subject + time only because the timetable API carries no teacher name or room), assignments, results, attendance, diary, resources, notices, profile + progress graphs. Not viewed in a browser.
- Parent /family/*: child switcher, child 360, attendance calendar, results/report card, assignments, fees + pay, notices, leave, messages, PTM booking, grievances, certificates, exit request, live view if enabled.

*Classroom: main stage = Board; side = participant tiles, chat (LiveKit data channel), hand-raise; teacher bar (mic/cam/screen, mute-all, lock, end, grant draw per student, **Board settings drawer* applying config live). Join via POST /api/live/sessions/:id/token; audio-only fallback; reconnect handled by LiveKit.

*SmartBoard component*: canvas layers (background → committed ops → live stroke → cursors); pressure + palm rejection (pen vs touch); pan/zoom in infinite mode; toolbar per config; undo/redo; page strip with follow-teacher; laser, shapes, text, eraser, image insert; export PNG/PDF/JSON; useBoardSocket(boardId) with optimistic apply, reconcile by seq, backoff reconnect; read-only when canDraw false. Smartboard hardware mode: full-screen, large-toolbar preset, touch targets ≥44 px. Renderer is a pure renderOps(ctx, ops, config, viewport). Shortcuts: P pen, H highlighter, E eraser, L laser, V select, T text, Ctrl+Z/Y.

Web tests today: 14 vitest files for pure logic (board reducer/renderer/snapshot, config form model, admin csv/registry/reports/school/timetable, chart helpers, portal exit/helpers/leave/threads, profile360 helpers). No component/DOM tests, no Playwright (G-13). PDF export is a hand-written writer (components/board/export.ts), no jspdf. Role layouts exist for admin/teach/learn/family; none uses async/redirect().

Shared UI: DataTable (sort/search/pagination, empty/loading/error), Drawer, FormField, Toast, Skeleton, EmptyState; keyboard accessible; works at 360 px.

### 7.1 Design system (src/app/globals.css)
- Tokens only, no hard-coded hex: bg surface surface-2 surface-3 fg fg-muted fg-subtle line line-strong brand brand-2 brand-soft brand-soft-fg success warn danger (+ -soft) --brand-grad(indigo→violet) --ring --overlay --stage; radii 10/14/20; shadows xs–lg; motion 150 ms; Inter 14px; tabular numbers in tables.
- Theme: html[data-theme=light|dark] set by inline script before first paint (localStorage["campus-theme"], else prefers-color-scheme); suppressHydrationWarning on <html> only; useTheme() hook.
- Classes: .btn(-primary -ghost -danger -icon -sm) .input .card .lbl .badge(-brand -success -warn -danger) .chip .tooltip .switch .seg .swatch .skeleton .empty-state .toast .menu .glass .ctl .live-dot. Every button sets explicit color. *Do not import @livekit/components-styles* (leaks global colours; the package is still listed in web/package.json but unused — remove it, G-12). Known rule violations to fix: hard-coded hex in login/page.tsx, apply/page.tsx, board/SmartBoard.tsx, board/export.ts (board canvas colours may stay as a documented exception); toLocaleString/new Date() rendered directly in admin/audit/page.tsx, admin/exits/page.tsx, classroom/Panels.tsx (G-12). Duplicate radius scales (--r-* and --radius-*) in globals.css. The shared State component still renders plain "Loading…" / "Nothing to show." with legacy slate/red styles instead of .skeleton / .empty-state (G-24).

## 8. Seeds (idempotent, npm run seed runs in order identity → academic → school → learning → fees → registry)

- identity: org demo ("Demo School"); 7 demo users incl. admin@demo.edu, teacher@demo.edu, student1@demo.edu, parent@demo.edu, all password Passw0rd! (existing users' passwords are not reset); 240 students (ADM2026###), 33 faculty (EMP###), 130 parents; writes services/identity/seed-output.json; runs migrations first.
- academic: Grades 1–10 × A,B; subjects Math, Science, English, Social, Hindi, PE; one class teacher per section; Mon–Fri timetable (sections with <5 slots regenerated); falls back to Grade 8 only if <7 teachers; skips if identity seed missing.
- school: year holidays + exam/PTM/event rows, last 20 working days attendance (~92%), 6 notices, *only 3 base leaves* (2 student, 1 staff) plus HR seed: leave balances, ~15 staff leaves + substitutions from the timetable, 30 days staff attendance, 12 threads, 1 PTM event (6 bookings), 8 grievances. HR seed departments: Mathematics/Science/English/Social Studies/Languages (no PE — G-20).
- learning: 1 term ("Term 1"), Grades 8–10 only, 3 subjects × 2 unit tests (25 marks) published, assignments for the first 2 subjects per section (graded past-due + upcoming), diary per section/subject.
- fees: structure per class, current-period invoices, 60% paid, partial/overdue, sibling concessions.
- registry: 40 enquiries, 25 applications across stages, class capacity, 4 TCs + 2 exits in flight, 10 bonafides, student records (~15% allergies), 25 discipline notes, 20 achievements, staff records.

## 9. Infra

docker-compose.yml: postgres:16 (healthcheck; infra/init.sql creates the campus_app role NOSUPERUSER NOBYPASSRLS; *schemas are created by each service's migrate(), not init.sql), redis:7, livekit (livekit.yaml, dev keys, ports 7880/7881/7882-udp, --node-ip 127.0.0.1, webhook → http://live:4003/livekit/webhook), one container per service (infra/Dockerfile.service), web (infra/Dockerfile.web, depends on gateway). Compose gives services LIVEKIT_URL (browser-facing ws://localhost:7880) **and* LIVEKIT_INTERNAL_URL (server-to-LiveKit). NEXT_PUBLIC_API_URL, NEXT_PUBLIC_BOARD_WS_URL, NEXT_PUBLIC_DEMO are *build args* in Dockerfile.web and compose (Next inlines them at build; runtime env has no effect). Image build not yet exercised. The token endpoint returns the LiveKit URL, so NEXT_PUBLIC_LIVEKIT_URL is unnecessary. Scripts: dev-up.sh, dev-down.sh (pid files in .run/), scripts/e2e.mjs. Root scripts: build, type-check, test, lint, infra:up, stack:up, stack:down, seed, e2e, dev:up, dev:up:web, dev:down. WSL note: LiveKit UDP 7882 must be reachable from the browser.

## 10. Security and compliance

- Clients never choose LiveKit grants. Webhooks verified + idempotent. Lockout on repeated login failure. No secrets in code except documented dev defaults.
- RLS on every table with positive + negative tests (cross-tenant, cross-section, unlinked parent). Admin/system DB access only at documented call sites.
- Minimise child PII; consent per DPDP (timestamp, purpose, guardian). Recording opt-in per session + guardian consent for minors. Revoking a guardian link takes effect immediately.
- Audit: role changes, grade edits, fee waivers, removals from live, recording access, imports, impersonation.
- Retention (confirm with legal): recordings 90 d, audit ≥1 y, attendance/marks life of record.

## 11. Acceptance (done = all true)

1. docker compose up --build brings the stack up; npm run seed creates demo data; npm run e2e passes (login → schedule → start → token → board WS → end, through gateway).
2. Teacher schedules and starts a class for 8A, picks/edits a board template; student1 joins, sees video + board; teacher draws and student sees it ≤~200 ms; student cannot draw until granted; teacher changes board background mid-class and student view updates.
3. After end, student1 auto-marked present; parent sees the class only when parent_view on; cross-org access impossible (RLS test).
4. Admin: add student (user+profile+enrollment+guardian), bulk import dry-run→confirm, timetable conflict rejected, promote class, attendance report + CSV, Student 360 with flags, admissions enquiry→admit end-to-end, exit→TC with dues check, analytics charts render.
5. Teacher: take attendance, grade assignment, enter marks, apply leave → substitution opened. Parent: switch child, view results/report card, pay invoice via mock gateway → receipt, book PTM, request certificate. Student: see timetable/assignments/results.
6. Every service has a README and passing unit and gated integration tests (and, if generated, a SPEC.md/SKILL.md derived from this file). All workspaces type-check, lint, test, build green. Web works at 360 px and in light/dark.
7. All *P0* gaps in §15 closed with tests; every *P1* gap either closed or explicitly deferred with a note in §15 of this file.
8. *Production release* additionally requires every §17.1 gate. Items 1–7 describe a working product; only 8 describes a shippable one.

## 12. Environment variables


JWT_SECRET INTERNAL_API_KEY DATABASE_URL=postgres://campus_app:campus_app@localhost:5432/campus REDIS_URL
LIVEKIT_URL=ws://localhost:7880 LIVEKIT_API_KEY=devkey LIVEKIT_API_SECRET
IDENTITY_URL ACADEMIC_URL LIVE_URL BOARD_URL NOTIFICATION_URL GATEWAY_URL SCHOOL_URL LEARNING_URL FEES_URL REGISTRY_URL
RAZORPAY_KEY_ID RAZORPAY_KEY_SECRET (optional; MockGateway when unset)
LIVEKIT_INTERNAL_URL
NEXT_PUBLIC_API_URL NEXT_PUBLIC_BOARD_WS_URL

.env.example currently lacks LIVEKIT_INTERNAL_URL, RAZORPAY_*; platform/.env lacks SCHOOL_URL, LEARNING_URL, FEES_URL, REGISTRY_URL (G-11). platform/.env holds dev placeholders only (no real secrets) — still keep it git-ignored.

## 13. Roadmap beyond this spec (designs in Part II)

Transport + live bus tracking (GPS ingest, geofence/ETA, boarding scans, SOS) · Expo mobile apps · Octopod import pipeline · Hindi UI · HLS broadcast · library, health module, gate/pickup passes · payroll, hostel, canteen · tenant billing/white-label/public API · AI helpers. Keep behind feature flags in orgs.settings.

## 14. Known open questions

College credit/semester rules · parent live-view default (currently off) · recording retention per institution · phone GPS vs certified hardware for buses · maps provider · Octopod export formats.

## 15. Gap register (status after the 2026-10-26 security pass)

Priority: *P0* wrong behaviour / safety, *P1* spec feature missing, *P2* hygiene. Status words: *DONE* (code + unit tests, passing), *DONE\* (code done but a path is untested — stated), **PARTIAL, **OPEN, **STALE* (the original claim was wrong), *DEFERRED* (decision, with reason).

**Current Replit classroom evidence (2026-10-26): PARTIAL.** The workspace now implements a full-screen classroom, LiveKit client/SDK grants, an independent persistent WebSocket stroke board with teacher draw grants, verified/idempotent LiveKit webhooks, attendance finalization and a scoped report/manual-override UI. API/web type checks, 16 API unit tests, the web production build, and a real PostgreSQL/HTTP/WebSocket integration test passed. The integration uses signed synthetic media events, not real audio/video. Public LiveKit setup and signed-in browser journeys are not verified. Advanced board tools/pages, chat/hand raises, full moderation/audit, multi-instance fan-out, session-settings UI and complete generated classroom contracts remain open. The historic platform audit rows below do not establish that those features exist in this Replit checkout; see `ARCHITECTURE.md` for the workspace-specific evidence and limitations. No G-* item is newly declared fully closed by this classroom slice.

| ID | P | Status | Evidence / what remains |
|---|---|---|---|
| G-01 | P0 | DONE\* | canFilterByPerson + user_id on GET /leave, teacher_id on GET /substitutions (school). 2 unit tests. The SQL and the Staff 360 round trip are untested (needs DB + services) |
| G-02 | P0 | DONE\* | Shared createAuditClient; audited actions listed per service in §5 (learning, live, registry, fees, identity). Unit tests prove records and failure isolation; routes not exercised against a DB. Helpers duplicated per service (G-23). Not audited: recording consent events, imports other than identity bulk, impersonation (does not exist) |
| G-03 | P0 | PARTIAL | npm run rls:check (77 tables, mutation-tested). *Open*: HTTP-level cross-section and unlinked-parent tests; identity.orgs stays without RLS by design (allowlisted) |
| G-04 | P1 | PARTIAL | Guardian flags + consent storage exist. Consent list/grant/revoke routes and a parent privacy page now exist; parent LiveKit token issuance requires an active live_view consent. Local HTTP+DB checks passed. *G-04b remains PARTIAL*: no first-login consent flow, recording/photo/marketing enforcement is not built (those features are not enabled), and there is no admin flag UI |
| G-05 | P1 | DONE\* | POST /sessions/:id/mute-all + classroom uses it. Route guards and real LiveKit call untested. *G-05b DEFERRED*: waiting room, server-side hand-raise state |
| G-06 | P1 | DONE\* | Preferences table/routes/delivery filter, 42 unit tests. Migration and routes not run against a DB. Only push provider mapped; sms/email/whatsapp providers do not exist. No web UI for preferences |
| G-07 | P1 | DONE\* | /learn/timetable built (tsc, lint, 7 unit tests). Not rendered in a browser; no teacher name/room in the API. ID-card sheet and promote wizard already existed (STALE part of the gap) |
| G-08 | P1 | PARTIAL | Columns added (migration 002). *OPEN*: no route/zod/UI reads or writes capacity, academic_year, room; admissions seats still use class_capacity |
| G-09 | P1 | STALE | min_attendance_pct already mapped; zod .partial() does not re-apply defaults (verified) |
| G-10 | P1 | DONE\* | Build args in Dockerfile.web + compose; docker compose config renders them. Image not built |
| G-11 | P2 | PARTIAL | .env.example still lacks LIVEKIT_INTERNAL_URL, RAZORPAY_*, CORS_ORIGINS, ACCESS_TOKEN_TTL, DB_POOL_MAX, UPSTREAM_TIMEOUT_MS and others read in code; service URL defaults exist so local dev works |
| G-12 | P2 | OPEN | Unused @livekit/components-styles; hex colours in login/apply; toLocale*/new Date() in admin/audit, admin/exits, classroom/Panels |
| G-13 | P2 | PARTIAL | Added: shared audit, notification preferences, per-service audit tests. The Replit slice now includes assignments, submissions/grading, assessments/marks, terms and grade-scale UI/API; DB migration and HTTP/browser journeys are still unverified. *Open*: gateway WS/rate-limit/health/all, school HR/engage/analytics HTTP, staff-attendance, PTM, learning print/seed, Playwright |
| G-14 | P2 | OPEN | Existing index coverage still needs review across academic, board, fees, learning, live, notification, registry and school; the new Replit learning indexes lead with org_id |
| G-15 | P2 | OPEN | GET /enrollments default 500 / max 1000 |
| G-16 | P2 | OPEN | Only 8 roles; accountant/admissions/HR/nurse not separate |
| G-17 | P2 | OPEN | GET /me omits profile |
| G-18 | P2 | PARTIAL | Web chains /enrollments/bulk after bulk import (web/src/lib/admin/bulk.ts); no server-side consumer. Decision pending: document or add consumer |
| G-19 | P2 | PARTIAL | Per-service SPEC.md files inside the code repo are derived copies and have drifted (seed example, gateway public routes/prefixes, and none yet mention guardian flags, preferences, mute-all or audit). Regenerate them from this file or delete them |
| G-20 | P2 | OPEN | School HR seed departments differ from identity seed (no PE) |
| G-21 | P2 | PARTIAL | .gitignore already covers .run, .next, tsbuildinfo, .env; *open*: services/identity/seed-output.json, empty contracts/, no web/README.md |
| G-22 | P2 | OPEN | Auto attendance never late (decide: add late_after_min or drop from enum) |
| G-23 | P2 | OPEN | Five copies of the audit record builder → move buildAuditRecord/makeAuditor into @campus/shared |
| G-24 | P2 | OPEN | Shared web State component ignores the design system (.skeleton, .empty-state) |
| G-25 | P2 | OPEN | npm run lint only exists in @campus/web; services have no lint script |
Not gaps (intentional): per-service routes beyond the original Phase 2/3 contracts (documented in §5); academic hod write access; gateway public webhook route.

## 16. How to verify (commands that were actually used)

Run from platform/ (WSL is fine for everything except next dev).

| Check | Command | Notes |
|---|---|---|
| Shared build | npm run build -w @campus/shared | Must run first; services import dist/ |
| Types | npm run type-check | 12 workspaces, ~2 min |
| Unit tests | npm test | ~2 min; gated integration suites are skipped |
| Lint | npm run lint | Runs *only* in @campus/web today (G-25) |
| Tenant isolation | npm run rls:check | Needs Postgres up and migrations applied (start each service once or run an integration suite). Read-only, rolled-back transactions, connects as campus_app and refuses a superuser |
| Gated integration | set -a; . ./.env; set +a; RUN_INTEGRATION=1 npx vitest run --root services/<svc> src/integration.test.ts | *Always load .env first.* Without DATABASE_URL, createPool() falls back to the superuser campus, which bypasses RLS: tests fail falsely and migrations create tables owned by the wrong role |
| Full stack | docker compose up --build, npm run seed, npm run e2e | Not yet run in this pass |
| Web dev server | Windows PowerShell: npm run dev -w @campus/web | Never from WSL against /mnt/c |

Last recorded full run (after G-01…G-03): build, type-check, all unit tests and rls:check green. Later changes (G-04…G-10) were verified per workspace (academic, live, fees, notification, web unit tests + tsc); a fresh full run is required before release.

---

## 17. Production requirements

Everything above makes the product work. This section is the bar for running it for real schools with real children's data. *Today the platform is a working dev stack that is not production-ready* (assessed 2026-10-23). Each requirement has an ID, a testable statement, current state, and priority.

Evidence key: *V* = verified by reading the code directly in this session; *A* = reported by an audit agent, not independently re-read (re-verify before relying on it).
Priority: *B* = release blocker, *H* = fix before pilot with real users, *M* = fix within the first release cycle.
Numeric targets marked (proposed) are defaults to confirm with the school, not commitments.

**Workspace release status (2026-10-26): NO-GO, unchanged.** Classroom ticketing and webhook checks are implemented and exercised locally, but this is not closure of PR-S14 or any entire release gate. Real media, authenticated role/browser journeys, passive-client revocation, distributed board transport, durable audit coverage, and the remaining §17 production controls are unverified or incomplete. CI is explicitly deferred; no deployment, cloud changes or release rehearsal were performed.

### 17.1 Release gates (all must be true to ship)

1. Every *B* item below is closed with a test or a documented verification.
2. CI is green on the release commit: build, type-check, lint (all workspaces), unit tests, rls:check, gated integration tests against a throwaway Postgres + Redis, snyk test (no high/critical), container image scan.
3. A *restore drill* has been performed from backup into a clean environment, with timings recorded (PR-D4, §17.4).
4. The §11 acceptance run has been executed end to end on the release build in a production-like environment (not dev compose), with results recorded.
5. Load tests meet §17.7 targets.
6. Runbooks listed in PR-F5 (§17.8) exist and were read by the on-call person.
7. The incident-response, consent, retention, deletion and data-export policies listed in Appendix J ("Policies to define before pilot") are written and approved by the school.

### 17.2 Security

| ID | P | Requirement | State | Ev |
|---|---|---|---|---|
| PR-S1 | B | assertProdConfig() in @campus/shared, called at boot by every service: when NODE_ENV=production, refuse to start if JWT_SECRET, INTERNAL_API_KEY, DATABASE_URL, REDIS_URL, LIVEKIT_API_KEY/SECRET are missing, equal a known dev default, or (secrets) are shorter than 32 chars. Validate all env with zod at boot | PARTIAL: API entrypoint now validates its env with Zod before loading the app, tests missing/short/default cases, and refuses production startup without required values; shared helper and remaining independent-service entrypoints are not migrated | V |
| PR-S2 | B | In production the *mock payment gateway must not exist: no RAZORPAY_KEY_ID/SECRET ⇒ fees refuses to start (or disables payments entirely). Webhook route must verify against the real webhook secret only. Cross-check captured amount and currency against the invoice/payment row | **ABSENT.* createGateway falls back to MockGateway with the hard-coded mock-gateway-secret; the webhook route is registered in all environments, so anyone who can create an order can forge a "captured" event and mark an invoice paid | V |
| PR-S3 | B | No guessable credentials: temp passwords ≥ 12 random chars (CSPRNG); must_change_password flag forces change at first login; self-service POST /auth/change-password; temp passwords expire (e.g. 7 days) and are never logged; bulk-import credentials delivered once and not stored | PARTIAL: admin reset issues a 32-character CSPRNG temporary password with a 7-day expiry; authentication forces change, the web screen is wired, and change/expiry paths passed local HTTP+DB checks. Bulk-import delivery is not implemented | V |
| PR-S4 | B | Privilege-escalation guard: an admin may reset, disable or re-role only users whose highest role is ≤ their own (campus_admin cannot touch org_admin/super_admin); role grants likewise; last super_admin cannot be removed. Applies to PATCH /users/:id password path, reset-password, role routes | PARTIAL: reset-password compares the target's highest role with the actor and rejects higher roles; local DB route test and role-matrix unit tests passed. Disable/re-role/role-grant routes and last-super-admin protection are not implemented | V |
| PR-S5 | H | Refresh-token reuse detection: presenting a revoked refresh token revokes the whole token family and audits auth.reuse_detected | ABSENT | A |
| PR-S6 | H | Login lockout and rate limits stored in Redis (shared across replicas), keyed on IP *and* account, with exponential back-off, so an attacker cannot lock out a victim or reset limits by restarting a process. Per-route limits for password reset, bulk import, public enquiry, certificate verify | PARTIAL: in-memory LoginLimiter, per-process; gateway 20/min on auth routes | A |
| PR-S7 | H | Access tokens: add aud; stop sharing one HS256 secret across all services — either asymmetric keys (identity signs with private key, services verify with public key / JWKS, with kid rotation) or per-service verify keys. Documented rotation procedure. Check user status on sensitive writes or shorten access TTL | PARTIAL: HS256 shared by all 10 services; exp/iat/iss present; 15 min TTL; no aud, no rotation | A |
| PR-S8 | H | Security headers on web and API: CSP (no inline script except hashed theme script), HSTS, X-Content-Type-Options, Referrer-Policy, frame-ancestors 'none', poweredByHeader: false. next.config.ts headers + @fastify/helmet on the gateway | ABSENT (next.config.ts is 5 lines) | A |
| PR-S9 | H | Printable HTML endpoints (report cards, receipts, TC, offers, ID cards) served with Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'; img-src data: and escaped output; the web must not open them as same-origin blob URLs that can read localStorage | PARTIAL: esc() used in all three renderers; openAuthedHtml opens a same-origin blob with no CSP | A |
| PR-S10 | H | trustProxy configured to the real LB hops so req.ip is the client; rate limiters and audit use it | ABSENT (all clients behind an LB would share one IP) | A |
| PR-S11 | H | pino redact for authorization, x-internal-key, *.password, *.token, *.temp_password, req.url query access_token; no guardian emails or phones in log lines | ABSENT (registry/routes-admissions.ts:243 logs emails) | A |
| PR-S12 | H | Request limits: body size per route group, server requestTimeout/connectionTimeout, header timeout | ABSENT (Fastify default 1 MB only) | A |
| PR-S13 | H | Attachment/document/photo URLs validated: https: only, host allow-list (object storage), length ≤ 1000, no .passthrough() on stored objects. Provide real storage (presigned S3/R2 uploads with size/type limits and malware scan) before enabling uploads | ABSENT (any string accepted, javascript: possible if rendered as a link) | A |
| PR-S14 | M | Web socket auth without a token in the URL (short-lived single-use ticket or Sec-WebSocket-Protocol), so tokens do not land in access logs | ABSENT (?access_token=) | A |
| PR-S15 | M | Public certificate verification: unguessable verification codes (not sequential numbers), per-IP rate limit, no student name unless the code matches | PARTIAL: sequential TC/2026/0001, returns name/kind/date, only global 300/min | A |
| PR-S16 | M | Refresh token in an HttpOnly; Secure; SameSite=Strict cookie (with CSRF protection on the refresh endpoint) instead of localStorage | ABSENT (7-day refresh in localStorage) | A |
| PR-S17 | M | Password hashing: scrypt N ≥ 2¹⁷ or argon2id, run off the event loop (async scrypt/worker); complexity + breached-password check | PARTIAL: scrypt now uses N=131072 asynchronously and upgrades older hashes after successful login; complexity and breached-password checks remain | V |
| PR-S18 | M | Service-to-service identity: per-service internal credentials (or mTLS) instead of one shared INTERNAL_API_KEY; internal services bound to a private network, not published to the host | ABSENT (one key, all ports published in compose) | A |
| PR-S19 | M | Authz review of every withSystem (RLS-bypass) call site: each must filter org_id explicitly or document why not (list in §17 appendix of each service SPEC); board system-template write path (canManageScope) reviewed | UNREVIEWED (≈25 sites) | A |
| PR-S20 | M | Escape %/_ in ILIKE search; numeric paging parse failures return 400, not an SQL error | ABSENT | A |

### 17.3 Reliability and resilience

| ID | P | Requirement | State | Ev |
|---|---|---|---|---|
| PR-R1 | B | /health (liveness, no dependencies) and /ready (DB SELECT 1, Redis PING, event-consumer heartbeat, migrations applied) on every service; orchestrator uses /ready. Gateway /health/all not public | /health only, checks nothing; /health/all public | A |
| PR-R2 | B | Graceful shutdown in every service: on SIGTERM stop accepting, drain in-flight requests (and close board/SSE streams with a retry hint), stop the consumer loop, close pool and Redis, exit within 30 s | PARTIAL: only fees handles signals | A |
| PR-R3 | H | DB pool: pool.on('error') handler (no crash on idle-client error), connectionTimeoutMillis, statement_timeout (e.g. 15 s), idle_in_transaction_session_timeout, application_name per service. Connection budget documented: Σ(replicas × DB_POOL_MAX) < max_connections − headroom; pgbouncer (transaction mode is incompatible with set_config(..., true) unless used per transaction — it is, via withOrg) | ABSENT: 10 services × pool 10 = 100 = Postgres default max | A |
| PR-R4 | H | Event bus: reclaim pending entries (XAUTOCLAIM), bounded retries, dead-letter stream with alert, stable consumer names (${service}-${hostname}), consumer lag metric; stream cap sized for the worst outage. *Transactional outbox* for events that must not be lost (payments, admissions, exits) | PARTIAL: groups + XACK; failed entries stay pending forever; consumer name c-${pid}; no outbox | A |
| PR-R5 | H | Upstream HTTP: every service-to-service call has a timeout (default 5 s), bounded retries with jitter for idempotent GETs, and a circuit breaker for the academic access check (live join path) | PARTIAL: gateway 30 s, registry/audit have timeouts; fees/learning/school clients and internalFetch have none | A |
| PR-R6 | H | Idempotency for money and irreversible actions: Idempotency-Key on POST /invoices/:id/pay, manual payments, admit, issue-tc; duplicate returns the original result | PARTIAL: webhook dedupe and payment unique ids only | A |
| PR-R7 | H | Gateway rate-limit store in Redis; per-IP and per-user limits; WebSocket connection limits per user | PARTIAL: in-memory, ×N replicas | A |
| PR-R8 | M | Board WebSocket multi-instance correctness: undo stacks, recent-op ids and rate limiter are in-process — document sticky routing or move to Redis; handle lagging instances (replay from since) | PARTIAL | A |
| PR-R9 | M | Notification SSE: heartbeat comments every 15–25 s, Last-Event-ID resume, cross-instance fan-out through Redis verified | UNVERIFIED | A |
| PR-R10 | M | Event handlers and /internal/* mutations idempotent on event id; request_id propagated into event envelopes and logs (validate incoming x-request-id format) | PARTIAL | A |

### 17.4 Data protection and compliance (DPDP Act)

| ID | P | Requirement | State | Ev |
|---|---|---|---|---|
| PR-D1 | B | Consent is recorded and enforced: consents routes (grant/revoke/list per guardian×student×purpose), first-login consent screen for guardians, *recording and photo use blocked without consent*, marketing messages blocked until consent | PARTIAL: guardian-scoped list/grant/revoke routes, parent privacy UI, RLS, idempotent grants, and live_view token enforcement are implemented and passed local HTTP+DB checks. First-login consent, recording/photo enforcement, and marketing enforcement remain; those features are not enabled | V |
| PR-D2 | B | Data-subject rights: per-person *export* (JSON/ZIP of everything held on a student/guardian/staff) and *erasure/anonymisation* workflow with an audit trail and a legal-hold exception list; admin UI + runbook | ABSENT (only board export exists) | A |
| PR-D3 | B | Retention jobs, configurable per org, run on a schedule and audited: recordings 90 d (proposed), GPS n/a, notify.notifications 90 d, live.participants 1 y, board.ops compacted into snapshots after the session ends then purged 90 d, audit log ≥ 1 y, raw import files 30 d, refresh tokens expired+7 d | ABSENT | A |
| PR-D4 | B | Backups: automated daily base backup + WAL archiving (PITR) with *RPO ≤ 15 min, RTO ≤ 4 h* (proposed); encrypted, stored in a separate account/region; restore drill documented and rehearsed (release gate 3) | ABSENT | A |
| PR-D5 | H | Encryption: TLS everywhere (edge, between services if not on a private mesh, to Postgres/Redis); disk/volume encryption; field-level encryption (or tokenisation) for Aadhaar-adjacent and health fields, with key management and rotation | ABSENT | A |
| PR-D6 | H | Database least privilege: separate migrator role (DDL) from campus_app (DML only, no CREATE on database); migrations run as a *separate release job*, not at every service boot, with lock_timeout, statement_timeout, checksum verification of applied files, and a documented expand/contract rollback approach | ABSENT: app role has CREATE, every service migrates at boot | A |
| PR-D7 | H | Seeds and dev routes cannot run in production: seed entrypoints refuse when NODE_ENV=production; /dev/* routes not registered; demo users absent | ABSENT for seeds | A |
| PR-D8 | M | Table growth: partition or archive school.audit_log, notify.notifications, board.ops, live.participants; indexes reviewed against real query plans (G-14) | ABSENT | A |
| PR-D9 | M | Breach-response procedure (detect, contain, notify authority and guardians within the statutory window) written and rehearsed | ABSENT | – |
| PR-D10 | M | Data residency: primary and backup in India region; sub-processors (LiveKit Cloud, SMS/WhatsApp, email, maps) listed with DPAs | UNDEFINED | – |

### 17.5 Delivery pipeline and environments

| ID | P | Requirement | State | Ev |
|---|---|---|---|---|
| PR-P1 | B | CI pipeline (GitHub Actions or Azure Pipelines — confirm which; TR work normally uses ADO + AB# links) running on every PR: install with npm ci, build, type-check, lint (add lint to every workspace, G-25), unit tests with coverage threshold, rls:check + gated integration tests against service containers (Postgres 16, Redis 7), snyk test + snyk container test, secret scan, image build. Required checks on the protected branch; Conventional Commit + AB# check | ABSENT (no pipeline, no repo; /mnt/c/work/mcp is not under git) | A |
| PR-P2 | B | Source control: the project lives in a git repository with branch protection, CODEOWNERS and signed/linked commits | ABSENT | V (not a git repo) |
| PR-P3 | H | Container images: pinned base by digest, multi-stage, npm ci --omit=dev, *non-root USER*, read-only root filesystem where possible, HEALTHCHECK, .dockerignore (excludes .env, node_modules, .next), one image per service (not one image holding all services), Next.js output: "standalone", reproducible install (no npm ci \|\| npm install fallback), SBOM + vulnerability scan, image signing | PARTIAL: multi-stage service image only; root, dev deps, unpinned | A |
| PR-P4 | H | Environments: dev (compose) is *separate* from production manifests. Production compose/Helm: only the gateway and web are exposed; Postgres, Redis and services on a private network; restart policies, resource requests/limits, readiness gates, Redis with auth + persistence, pinned versions (no :latest LiveKit), real LiveKit keys and a TURN/UDP plan | ABSENT (docker-compose.yml is dev-only and publishes every port with default credentials) | A |
| PR-P5 | H | Secrets: stored in a secret manager (not env files in the repo or image), injected at runtime, rotation procedure for JWT keys, INTERNAL_API_KEY, DB passwords, Razorpay/LiveKit keys | ABSENT | A |
| PR-P6 | H | Versioning and release: semantic version per release, changelog, tagged images, migration job ordering, blue/green or rolling deploy with automatic rollback on failed /ready | ABSENT (static 0.1.0) | A |
| PR-P7 | M | Staging environment mirroring production for the release rehearsal and restore drill | ABSENT | – |

### 17.6 Observability

| ID | P | Requirement | State | Ev |
|---|---|---|---|---|
| PR-O1 | H | Metrics: /metrics (Prometheus) per service — request rate/latency/error by route, DB pool usage, event consumer lag and DLQ size, LiveKit participants/rooms, board WS connections and op rate, payment webhook outcomes | ABSENT | A |
| PR-O2 | H | Tracing: OpenTelemetry with context propagation gateway → services → DB; trace id in logs | ABSENT | A |
| PR-O3 | H | Error tracking (Sentry or equivalent) for services and web, with PII scrubbing and release tagging | ABSENT | A |
| PR-O4 | H | Alerts with owners: 5xx rate, p95 latency, readiness failures, consumer lag/DLQ > 0, payment webhook failures, backup failure/age, disk and connection saturation, certificate expiry | ABSENT | – |
| PR-O5 | M | Uptime probes from outside; status page; synthetic login → join live → board op journey every 5 min | ABSENT | – |
| PR-O6 | M | Structured audit and security logs shipped to an append-only store separate from the app DB | ABSENT | – |

### 17.7 Performance and capacity

SLOs (proposed): API availability 99.5% monthly in school hours; p95 read < 300 ms, p95 write < 600 ms at the gateway; board op propagation p95 ≤ 200 ms for 100 students in a room; live join (token) p95 < 1 s; payment webhook processed < 5 s.

| ID | P | Requirement | State |
|---|---|---|---|
| PR-L1 | H | Load test (k6 or Artillery, committed under scripts/load/): 500 subscribers in one LiveKit room with join latency/CPU measured; 100 students drawing on one board (op rate, p95 latency, no lost ops after reconnect); 2,000 concurrent API users on a read-heavy mix (dashboards, attendance, timetable); bulk import of 5,000 rows; fee invoice generation for 2,000 students | ABSENT |
| PR-L2 | H | Capacity doc: connections, CPU/RAM per service, LiveKit minutes/month estimate (method in Appendix F), Postgres sizing, growth of board.ops/audit_log | ABSENT |
| PR-L3 | M | Query review: EXPLAIN on the 20 hottest queries at seeded and 10× scale; add org-leading indexes (G-14); no unbounded lists (all list endpoints paginated, G-15) | ABSENT |

### 17.8 Frontend, accessibility, operations documentation

| ID | P | Requirement | State | Ev |
|---|---|---|---|---|
| PR-F1 | H | error.tsx, global-error.tsx, not-found.tsx; offline/retry states; no raw stack traces; State component uses the design system (G-24) | ABSENT | A |
| PR-F2 | H | Accessibility: WCAG 2.1 AA for login, dashboards, forms, tables; automated checks (axe in Playwright) on the main role journeys; keyboard-operable classroom controls; visible focus; colour contrast in both themes | PARTIAL: 359 aria- uses, no automated checks | A |
| PR-F3 | H | Browser e2e (Playwright) per role at 360 px and desktop: login, student sees timetable, teacher takes attendance, parent pays (mock off — use Razorpay test mode in staging), admin admits a student, live class join + board draw | ABSENT | A |
| PR-F4 | M | i18n scaffold (Hindi first) with externalised strings and locale-aware formatting after mount; PWA manifest + service worker for the low-bandwidth cases the product promises | ABSENT | A |
| PR-F5 | H | Runbooks under ops/runbooks/ (created by the build, not an external folder): deploy and rollback; restore from backup (with the drilled timings); rotate secrets; consumer stuck / DLQ; Postgres connection exhaustion; LiveKit outage; payment webhook failures and reconciliation; DPDP erasure request; child-safety incident (who is called, in what order, within what time) | ABSENT | A |
| PR-F6 | M | README split into Developer, Operator and Security guides; an architecture note (trust boundaries and data-flow diagrams); threat model (STRIDE) reviewed once | PARTIAL | A |

### 17.9 Production-readiness summary (as assessed)

Blockers today: PR-S1, S2, S3, S4, R1, R2, D1, D2, D3, D4, P1, P2. Roughly: *secrets and config guard, the forgeable mock payment, credential and privilege-escalation fixes, health/readiness and shutdown, consent/erasure/retention/backups, and the absence of any pipeline or repository.* None of the existing functional gaps in §15 outranks these.

---

# PART II — Reference appendices (self-contained)

These appendices carry the full product, RBAC, data-model, live-streaming, transport, migration and delivery content that earlier lived in separate design documents. *No other file is needed to build or operate the platform from this spec.* Each appendix says what is *BUILT* (present in code), *PARTIAL, or **ROADMAP* (designed, not built).

## Appendix A — Product context and decisions

*What it is.* A multi-tenant platform for schools and colleges with Admin, Teacher/Faculty, Student and Parent logins, class-wise and section-wise live classes, and daily school operations.

*Decisions (fixed).*

| Area | Decision |
|---|---|
| Tenancy | Multi-tenant SaaS; org_id isolation enforced by Postgres RLS |
| Backend | Fastify microservices, one Postgres (schema per service), Redis Streams events, own JWT issuer (identity). Earlier designs used Supabase; that was dropped |
| Web | Next.js 16, React 19, TypeScript 5, Tailwind 4 |
| Live | LiveKit (Cloud first, self-host when minutes cost justifies) |
| Market | India: INR, IST, Razorpay, SMS/WhatsApp (DLT-registered templates), DPDP Act consent, Hindi UI later |
| Scale | 5k–50k users, < 500 concurrent viewers per live room |
| Mobile | PWA first; native Expo apps are ROADMAP |
| Payments | Razorpay (UPI, cards, netbanking) with webhook + reconciliation |
| Notifications | In-app + SSE (BUILT); push/SMS/WhatsApp/email providers ROADMAP |

*Market gap.* Competitors (Fedena, Teachmint, PowerSchool, Classter, ClassDojo, Google Classroom, QuickSchools) cover ERP, attendance, parent messaging or assignments. No source found for *section-wise live view with parent access control* or *automatic attendance from live-join events* — that is the differentiator. Live bus tracking is expected by Indian parents (ROADMAP, Appendix G). Competitor feature claims came from aggregator pages and were not verified; treat as directional.

*Live-vendor choice.* LiveKit: Apache-2.0, Go SFU, simulcast/SVC, server-side egress, HLS support, self-hostable. Agora is managed and priced per participant-minute; Jitsi is a conferencing drop-in that suits custom role flows poorly. Re-check current vendor pricing before committing to volume.

*Alternatives considered (not chosen).* NestJS + Postgres + React Native (more control, more effort); Java/Spring + Angular (slower to start); Agora (per-minute cost, less control over roles).

## Appendix B — Organization hierarchy and scope rules


Platform (super admin)
└─ Organization (trust / group)            ← tenant boundary
   └─ Institution (school | college)
      └─ Campus / Branch
         ├─ Department (college) / Wing (school)
         ├─ Academic Year → Term / Semester
         ├─ Class / Grade (school) | Program → Batch (college)
         │   └─ Section
         │       └─ Course Offering (subject + section + teacher + term)
         └─ Staff, Students, Guardians


*Rules.* Organization is the tenant; every row carries org_id. An organization may hold several institutions. School uses Class → Section; college uses Program → Batch → Section (same classes/sections tables, labels by institution type). A student has one active enrollment per academic year, pointing to one section. Guardian ↔️ Student is many-to-many (siblings, multiple guardians). A staff member can hold roles at several scopes (class teacher of 6-A and teacher of 7-B).

*Scope types (RBAC):* platform > org > institution > campus > department > class > section; vehicle hangs below campus for Driver/Attendant roles (ROADMAP). A role granted at a scope applies to everything below it.

*Status.* BUILT: org → class → section, subjects, enrollments, teacher assignments, timetable, exam_terms (learning). *Not built as entities:* institution, campus, department, academic-year/term master tables (department and academic year exist only as text on profiles / orgs.settings.academic_year). Add them only when a multi-campus customer needs them.

*Example.* Org "Aaditri Educational Trust" → Institution "Aaditri Public School" (school) → Campus Main → Class 8 → Sections A, B, C; and Institution "Aaditri College of Science" (college) → Campus North → Dept Physics → Program B.Sc → Batch 2026 → Sections A, B.

## Appendix C — RBAC reference

*Model.* Roles are assigned at a scope; a grant at a higher scope covers everything below. Tables: user_roles(user_id, role, scope_type, scope_id, org_id) (BUILT in identity). A role_permissions(role, resource, action) table was designed but permissions are currently enforced in code by role helpers per service.

*Roles.*

| Role | Scope | Summary | Status |
|---|---|---|---|
| Super Admin | platform | Tenant management, billing, support access | BUILT (super_admin) |
| Org Admin / Principal | org/institution | Full control inside their org | BUILT (org_admin) |
| Campus Admin / Registrar | campus | Users, admissions, fees, timetable for the campus | BUILT (campus_admin) |
| HOD | department | Department courses and faculty (college); also write in academic and first approver for staff leave | BUILT (hod) |
| Teacher / Faculty | section(s) | Attendance, marks, assignments, start live class for assigned sections only | BUILT (teacher) |
| Class Teacher | section | Teacher rights plus roster, student-leave approval, parent communication | BUILT (class_teacher) |
| Student | self | Own data, enrolled section's live classes, submissions | BUILT |
| Parent / Guardian | linked children | Attendance, grades, fees, notices; live view only if enabled | BUILT |
| Accountant, Librarian, Transport Manager, Driver, Attendant, Security Guard, Admissions Officer, HR Manager, Nurse | campus/vehicle/institution | Module roles | ROADMAP — admin roles perform these functions today (G-16) |

*Permission matrix* (R read, W write, A approve, – none; "own" = own record, "child" = linked children):

| Resource | Super Admin | Org Admin | Campus Admin | Teacher | Student | Parent |
|---|---|---|---|---|---|---|
| Organizations / institutions | RW | RW (own) | R | – | – | – |
| Users and roles | RW | RW | RW (campus) | – | – | – |
| Students, guardians | RW | RW | RW | R (section) | R (own) | R (child) |
| Timetable | RW | RW | RW | R | R | R (child) |
| Attendance | RW | RW | RW | RW (section) | R (own) | R (child) |
| Live session | RW | RW | RW | RW (section) | Join (enrolled) | Join if enabled |
| Recordings | RW | RW | R | R (section) | R (enrolled) | R if consent |
| Assignments | R | R | R | RW (section) | R, submit (own) | R (child) |
| Marks / report cards | R | RW | RW | RW (section) | R (own) | R (child) |
| Fees / invoices | RW | RW | RW | – | R (own) | R, pay (child) |
| Notices | RW | RW | RW | RW (section) | R | R |
| Leave requests | R | RW | RW (approve) | RW (approve, section) | Apply (own) | Apply (child) |
| Admissions | RW | RW | RW | – | – | Apply (own application) |
| Gate pass and pickup (ROADMAP) | R | R | RW | R (section) | – | RW (child's authorised persons) |
| Health records | – | R (summary) | R | R (alerts only) | R (own) | RW (child) |
| Vehicles/routes/live bus (ROADMAP) | RW | RW | RW | – | – | R (child's route, trip window only) |
| Payroll (ROADMAP) | – | R | – | – | – | – |
| Audit logs | R | R | – | – | – | – |

Module roles act inside their module only (ROADMAP): Transport Manager (transport tables, trip history, linked student names/stops); Driver (own vehicle's route and today's student list; trip start/end, positions, SOS); Attendant (boarding/drop/absent events, SOS); Security Guard (gate pass by QR, visitor log, pickup confirmation); Admissions Officer (applications, offers); HR Manager (staff records, leave decisions, payroll); Nurse (health notes and incidents); Accountant (invoices, concessions); Librarian (circulation).

*Enforcement order.* (1) RLS — primary. (2) API layer re-checks permission by role and by academic's per-section access answer. (3) UI hides actions — cosmetic only. (4) Audit log for role changes, grade edits, fee waivers, recording access, impersonation.

*RLS pattern (as built).* Every tenant table gets, from the -- @rls <table> migration macro: ENABLE + FORCE ROW LEVEL SECURITY and a policy tenant_isolation with USING and WITH CHECK of current_setting('app.bypass_rls', true) = 'on' OR org_id = nullif(current_setting('app.org_id', true), '')::uuid. withOrg(pool, org, fn) opens a transaction and sets app.org_id with set_config(..., true); withSystem sets the bypass flag for webhooks, internal routes and jobs (each call site must filter org_id explicitly or justify not doing so — PR-S19). Exception by design: board.templates has split policies so system templates (org_id IS NULL) are readable by every org while tenant rows stay isolated.

*Parent and child data rules.* Parents see only rows reachable through the guardian link. Live view for parents is a per-session parent_view setting (default from org settings) *and* a per-guardian can_view_live flag. Recording access for parents requires recorded consent. Minimise child PII; record consent per DPDP with timestamp, purpose and guardian id. Revoking a guardian link takes effect immediately (RLS/queries). Health records visible to the guardian and the Nurse; teachers see alerts (e.g., allergy) not full records. Bus location (ROADMAP) visible only on the child's own route while the trip is live plus a 10-minute grace window. Pickup (ROADMAP) is released only to an authorised person verified by QR.

*RBAC tests (required for every table).* A positive test per allowed role; negative tests for cross-tenant, cross-section and unlinked-parent access, run in CI (PR-P1). npm run rls:check covers the structural/cross-tenant part; HTTP-level cross-section and unlinked-parent tests are still to be written (G-03).

## Appendix D — Data model (target) and build status

All tables carry org_id uuid NOT NULL and RLS (except the documented non-tenant tables). Primary keys are uuid; timestamps timestamptz. Index (org_id, <fk>) on every table (G-14). Unique: (org_id, admission_no) on students; one active enrollment per student per year; (session_id, identity, joined_at) on live participants; razorpay_payment_id/gateway ids on payments.

| Domain | Tables | Status |
|---|---|---|
| Tenancy & structure | organizations(=identity.orgs), institutions, campuses, departments, academic_years, terms, classes, sections, subjects, course_offerings | orgs, classes, sections, subjects BUILT (§5.1–5.2); the rest ROADMAP (App. B) |
| People & access | profiles, user_roles, role_permissions, students, guardians, student_guardians, enrollments, staff, consents | users/profiles/user_roles/enrollments/guardians/consents BUILT (students/staff are users+profile kinds; staff_records, student_records in registry) |
| Academics | timetable_slots, attendance, assignments, submissions, exams, marks, notices, messages | BUILT across academic/school/learning (App. E) |
| Live | live_sessions, live_participants, recordings, live_session_audience | BUILT as live.sessions, participants, recordings, session_audience (§5.3) |
| Transport | vehicles, drivers, routes, stops, route_stops, student_stops, trips, trip_events, vehicle_positions | ROADMAP (App. G) |
| School operations | leave_requests, calendar_events, ptm_slots, homework(=learning diary), admission_enquiries/applications, visitors, pickup_authorisations, pickup_events, certificates, health_records/health_incidents, library_items/library_loans, grievances | leave, calendar, PTM, diary, admissions, certificates, grievances, health checkups BUILT; visitors, pickup, library ROADMAP |
| Learning | content_items, question_bank, quizzes, quiz_attempts | resources BUILT (lite); quizzes/question bank ROADMAP |
| Platform | tenant_settings(=orgs.settings), import_jobs, import_mappings, import_staging_rows, legacy_ids, notification_preferences(=notify.preferences), subscriptions, api_keys, webhook_endpoints | settings, preferences BUILT; import pipeline, subscriptions, API keys ROADMAP |
| Finance & system | fee_structures, invoices, payments, notifications, audit_logs | BUILT (fees.*, notify.notifications, school.audit_log) |

Column-level contracts for what is built are in §5 and Appendix E. Roadmap table columns are in Appendices G and H.

## Appendix E — Service data contracts (school, learning, fees, registry, admin module)

Tables below list the columns the code implements (names exact). Additional operational columns exist; never rename listed ones. All are tenant tables with org_id.

### E.1 school (schema school)
- calendar_events(id,title,kind holiday|exam|event|ptm|working_day,start_date,end_date,scope org|class|section,scope_id,description). GET/POST /calendar (?from&to), PUT/DELETE /calendar/:id, GET /calendar/is-working-day?date= (Sundays + holidays).
- attendance_sessions(id,section_id,date,period nullable,marked_by) unique(section,date,period); attendance_marks(session_id,student_id,status present|absent|late|leave,remark). POST /attendance {section_id,date,period?,marks[]} (class/subject teacher of the section or admin; upsert; refuses non-working days unless admin), GET /attendance, /attendance/student/:id, /attendance/summary, /attendance/today (admin overview). Emits attendance.marked (source:'manual'); absent ⇒ notification.
- notices(id,title,body,audience org|class|section|role,audience_ids uuid[],roles text[],priority normal|urgent,attachments jsonb,published_at,expires_at,created_by), notice_reads(notice_id,user_id,read_at). Admin: any audience; teacher: only own sections. GET /notices (mine; ?unread=1), POST /notices/:id/read, GET /notices/:id/stats.
- leave_requests(id,applicant_id,applicant_kind student|staff,on_behalf_of_student,section_id,from_date,to_date,reason,status pending|approved|rejected|cancelled,decided_by,decided_at,decision_note,type_id,half_day first|second,document_url,days,stage hod|admin,department,balance_year). Student/parent apply; class teacher approves student leave (approved ⇒ leave marks for unmarked days); staff leave chain teacher → HOD (if department) → admin; staff may never approve own; balance check 409 unless LOP; cancel returns balance. leave_types(code,name,applies_to,annual_quota,carry_forward,requires_doc) seeded staff CL 12, SL 10, EL 15, ML, LOP and student sick/casual/event; leave_balances(user_id,type_id,year,quota,used,pending).
- substitutions(id,date,timetable_slot_id,section_id,subject_id,absent_teacher_id,substitute_teacher_id,status open|assigned|accepted|declined,note,start_time,end_time,section_label,leave_request_id): auto-opened on approved staff leave from academic timetable; GET /substitutions/suggest?slot= (free teachers that period, same department first, lowest workload — pure function); assign/accept/decline; GET /my/substitutions.
- staff_attendance(user_id,date,check_in,check_out,status present|absent|late|half_day|leave|holiday,source self|admin|auto,leave_request_id); check-in/out, admin mark, monthly summary; approved leave auto-fills.
- threads(subject,student_id,participants uuid[],last_message_at,created_by), messages(thread_id,sender_id,body,attachments), thread_reads. Parents may message only their child's class/subject teachers; teachers only guardians of their students; admin any; ?after= polling.
- ptm_events(title,date,slot_minutes,start_time,end_time,class_id|section_id), ptm_slots(event_id,teacher_id,start_at,end_at,booked_by,student_id,status open|booked|done|cancelled,notes) — one booked slot per teacher per child.
- grievances(raised_by,student_id,category academic|transport|fees|facilities|conduct|other,subject,body,status open|in_progress|resolved|closed,assigned_to,priority,resolution) + grievance_comments; analytics by category/status/avg resolution days.
- audit_log(actor_id,action,entity,entity_id,meta,at); GET /audit (admin; filters actor/entity/date); GET /stats/overview (today's attendance %, unmarked sections, pending leaves, active notices, upcoming events).
- Analytics (chart-ready {series:[…]} or {labels,datasets}): attendance-trend, attendance-by-class, absentee-heatmap, leave-stats, chronic-absentees.

### E.2 learning (schema learning)
- assignments(section_id,subject_id,title,instructions,due_at,max_marks,attachments jsonb,allow_late,created_by,status draft|published|closed); submissions(assignment_id,student_id,text,attachments,submitted_at,late,marks,feedback,graded_by,graded_at,status submitted|graded|returned) unique(assignment,student). Teacher of the section CRUDs/grades; student GET /my/assignments?status=pending|submitted|graded, POST /assignments/:id/submit; parent reads child's.
- exam_terms(name,academic_year,start_date,end_date), exams(term_id,class_id,subject_id,name,date,max_marks,pass_marks,weightage), marks(exam_id,student_id,marks nullable,absent,remark,entered_by) unique(exam,student); bulk grid entry; publish gates visibility to parents/students.
- grade_scales (default A1..E at 90/80/70/60/50/40/33), report_card_remarks, report_card_publications. Report card = per-subject marks, %, grade, rank in section, attendance % (school internal), remark; printable A4 HTML.
- diary(section_id,subject_id,date,text), resources(section_id|class_id,subject_id,title,kind link|file|note,url,body), GET /progress/:studentId (per-subject trend + assignment completion %).
- Analytics: performance-distribution, subject-averages, section-comparison, student-trend/:id, toppers, at-risk (below pass % in ≥ 2 subjects), assignment-stats, teacher-effectiveness.

### E.3 fees (schema fees)
- fee_heads(name,kind tuition|transport|lab|misc,active), fee_structures(class_id,academic_year,items jsonb[{head_id,amount,due_month}],installments), concessions(student_id,type sibling|merit|staff|custom,percent|amount,reason,active), family_links (+POST /families) for sibling detection.
- invoices(student_id,number unique,academic_year,period,items,gross,discount,total,due_date,status unpaid|partial|paid|void,class_id,discount_breakdown,last_reminded_at), payments(invoice_id,amount,method cash|upi|card|netbanking|cheque|online,reference,gateway manual|razorpay|mock,gateway_order_id,gateway_payment_id,status created|captured|failed|refunded,received_by,paid_at), receipts(payment_id,number unique,issued_at), number_sequences, webhook_events.
- POST /invoices/generate {class_id|section_id|student_ids,period} (idempotent per student+period; applies concessions and sibling discount); manual payments (partial allowed, receipt issued); reports collection/defaulters(+CSV); reminders; analytics collection-trend, outstanding-by-class, payment-mode-split, aging (0–30/31–60/61–90/90+), forecast; GET /internal/students/:id/dues → {total_due,overdue,has_dues}.
- Online pay: POST /invoices/:id/pay creates a gateway order; PaymentGateway interface with RazorpayGateway (REST + signature verification) and MockGateway (*development only — must not exist in production, PR-S2*); webhook POST /payments/razorpay/webhook (signature verified, idempotent on event id) captures, issues receipt, emits payment.captured.

### E.4 registry (schema registry)
- *Admissions* enquiries(child_name,dob,class_applying,guardian_name,phone,email,source walk-in|web|referral|campaign|other,notes,status new|contacted|visit_scheduled|application_issued|closed|lost,assigned_to,follow_up_on); admission_activity(subject_type,subject_id,actor_id,action,note,at); applications(application_no unique e.g. APP2026-0001,enquiry_id,academic_year,class_id,child_name,dob,gender,blood_group,previous_school,previous_class,address,guardians jsonb,documents jsonb,status submitted|under_review|test_scheduled|interviewed|shortlisted|offered|accepted|admitted|rejected|waitlisted|withdrawn,test_score,interview_notes,decision_note,fee_paid). State machine (illegal ⇒ 409). admit {section_id,admission_no?} creates the student via identity, enrolls via academic, links/creates the parent, optionally generates the first invoice, returns credentials. Funnel and analytics (monthly series, by source/class, seats vs class_capacity). Public POST /public/enquiry (rate-limited).
- *Exit & certificates* exit_requests(student_id,requested_by,reason transfer|relocation|completed|other,destination_school,last_working_day,status requested|dues_check|approved|issued|rejected|cancelled,dues_cleared,library_cleared,remarks,approved_by,certificate_id); workflow request → fee-dues check (fees internal) → approve → *issue TC* (TC/2026/0001: name, admission no, DOB, last class, admission/leaving dates, conduct, reason, dues status) which sets enrollment left, disables the user and emits student.exited. certificates(student_id,kind tc|bonafide|character|study|fee|dob,number unique (null until issued),issued_on,issued_by,payload,status requested|issued|rejected); printable A4 HTML with inline-SVG QR; public GET /public/verify/:number. ID cards single and batch (8-up A4) with QR; staff ID card.
- *Records* student_records(student_id PK,address,emergency_contacts,allergies,conditions,medications,vaccinations,height_cm,weight_kg,blood_group,transport_mode,house,religion,category,aadhaar_last4,previous_school,language_pref,photo_url), health_checkups, discipline_notes(kind commendation|incident|counselling|note,severity 1–3,title,body,visible_to_parent), achievements, student_documents(type,name,url,verified), staff_records(qualification,experience_years,date_of_joining,employment_type permanent|contract|visiting,reporting_to,emergency_contact,bank_masked,documents). Health fields are redacted for roles other than nurse/admin/parent; parents see only visible_to_parent discipline notes.
- *Student 360* GET /students/:id/360?term_id= fans out with the caller's JWT (each section failure-tolerant ⇒ null) to identity, academic, school, learning, fees (parents/admin only), live and registry; returns {profile, academics, attendance{percent,month_series,last30}, performance{subjects,rank,overall_percent,term_series}, assignments{completed,pending,late}, fees|null, behaviour, achievements, health|null, documents, flags[]}. flags come from a pure function (low_attendance, falling_marks, fees_overdue, incident) using org-setting thresholds. *Staff 360*: profile + workload + leave balances/history + staff attendance + classes taught analytics.
### E.5 Admin module (cross-service behaviour)
- *Identity* bulk import: POST /users/bulk {kind student|staff, rows[{name,email,phone?,external_no?,dob?,gender?,class_name?,section_name?,department?,designation?,guardian_name?,guardian_phone?,guardian_email?}], confirm}: dry run returns valid count, per-row errors (duplicates by email/external_no flagged) and preview; confirm creates users, role, profile, temp credentials (returned once), and parent users from guardian email; student rows return enroll[] for the web to forward to academic /enrollments/bulk. Also GET /users?role&q&status&ids, profile get/put, reset password, enable/disable, GET /stats, org settings get/put {parent_view_default, min_attendance_pct, academic_year, timezone, chat_enabled_default}.
- *Academic* extras: POST /enrollments/transfer, /promote (end-of-year; old rows left), GET /teachers/:id/workload, timetable conflict check (409), sections with counts and class-teacher info, stats (sections without class teacher, enrolled counts).
- *Live* extras: GET /admin/overview (live now, today's counts, upcoming 10), GET /reports/attendance(.csv) (per-student present/absent/late/percent), GET /reports/teachers (sessions/minutes), session defaults from org settings.
- *Admin web behaviour:* dashboard cards + live-now with "Observe"; students table (search/filter/pagination) + detail tabs + add form (shows temp password once) + bulk import (dry-run table → confirm → credentials CSV); faculty likewise with assignments/class-teacher toggle/workload/timetable; parents with linked children; classes tree with counts and section roster (add/remove/transfer) and promote wizard; timetable grid per section/teacher with conflict errors; live monitor (cancel/observe/attendance override); reports (attendance % bars, defaulter list below threshold, CSV, teacher activity); settings form + board template configurator link; calendar, notices, leave, fees, audit, admissions Kanban + funnel + drawer + offer/admit wizard, exits, certificates desk, analytics hub (recharts line/bar/area/donut/heatmap, date range + class filter, CSV/PNG export), grievances, PTM manager, substitution board, staff attendance.

## Appendix F — Live streaming design reference

*Modes.* Section-wise: one room per section session ({org}:{section}:{session}), audience = enrolled students + linked parents if enabled. Class-wise: one room for the whole class ({org}:class-{class}:{session}) for assemblies/joint lectures, audience = all sections of the class. Broadcast (HLS egress for overflow above ~100 passive viewers or a school-wide event) is ROADMAP. Audience comes from session_audience (one row per allowed section) so a section can be added without a new room.

*Roles and grants.* Teacher: publish audio/video/screen, subscribe, chat, moderate (mute, remove, room admin). Co-teacher/TA (ROADMAP as distinct role; any teacher assigned to the section gets teacher grants today). Student: no publish by default (hand-raise grants temporary mic), subscribe, chat if enabled. Parent: subscribe only if enabled. Admin/Principal: observe only (hidden).

*Lifecycle.* Schedule (ad-hoc by a teacher; timetable auto-generation is ROADMAP) → Start (status live, students and guardians notified, board created) → Join (client requests token; server checks RBAC and enrollment/guardian link and mints a short-TTL token with role grants) → During (simulcast; audio-only fallback; hand-raise, mute, mute-all, remove, lock room) → End (teacher ends, or an auto-end after slot + grace; egress finalises recording) → After (recording stored with consent checks; attendance finalised).

*Auto attendance.* LiveKit webhooks participant_joined/left write participants (idempotent); at session end a student is present when watched seconds ≥ min_attendance_pct of the session (default 50%, per org/session), else absent. Manual attendance overrides (source=manual); late is only manual today (G-22).

*Scale and cost.* Target < 500 viewers per room on LiveKit Cloud; above ~100 passive viewers publish HLS for parents/observers (ROADMAP). Load-test 500 subscribers in one room (join latency, CPU) before pilot. Capacity example: 2,000 students × 5 sessions × 40 min = 400,000 participant-minutes/day ≈ 8M/month over 20 school days; multiply by the vendor rate and compare with self-hosting.

*Safety.* Recording opt-in per session and requires guardian consent for minors (consent enforcement is PR-D1). Parent view = org toggle + per-session override + per-guardian flag. Waiting room optional (ROADMAP). Only enrolled/linked users can enter — no public links. Teacher can remove a participant (audited). Recording retention default 90 days, configurable. Optional viewer-name watermark (ROADMAP).

*Failure handling.* Client refreshes token before TTL; LiveKit auto-reconnect; participant events de-duplicated by (session, identity, joined_at); egress failure keeps the session running, raises an alert, marks the recording failed.

## Appendix G — Transport and live bus tracking (ROADMAP, full design)

*Goals.* Parent sees the child's vehicle during the trip only; alerts for approaching, boarded, dropped, delayed; school sees the fleet, trip history and exceptions; driver and attendant use a simple app.

*Roles.* Transport Manager (campus: vehicles, routes, stops, assignments, fleet view, reports); Driver (assigned vehicle: start/end trip, GPS, SOS); Attendant (assigned vehicle: boarding/drop scans, mark absent, SOS); Parent (child's vehicle during trip window, alerts); Campus Admin (read fleet and history). Drivers/attendants get a staff user and a role at scope vehicle.

*Tables.* vehicles(reg_no,type bus|van,capacity,device_id,status), drivers(staff_id,licence_no,licence_expiry,phone), routes(campus_id,name,direction pickup|drop,vehicle_id,driver_id,attendant_id,scheduled_start), stops(name,lat,lng,radius_m default 200), route_stops(route_id,stop_id,seq,scheduled_time), student_stops(student_id,route_id,stop_id,direction,valid_from,valid_to) unique active (student,route,direction), trips(route_id,date,status scheduled|live|ended|cancelled,started_at,ended_at,last_lat,last_lng,last_seen_at), trip_events(trip_id,type stop_arrived|boarded|dropped|absent|sos|delayed,student_id,stop_id,at), vehicle_positions(trip_id,at,lat,lng,speed,heading,accuracy_m) day-partitioned, 30-day retention. Indexes (trip_id, at desc), (org_id, route_id).

*GPS ingest.* Driver app (background location) sends batched pings every 5–10 s with offline retry → worker POST /ingest/position (signed per-vehicle device token) → Redis latest position per trip → private realtime channel trip:{id} → batch insert every 30 s; geofence + ETA evaluation every 30 s per live trip. Drop pings with accuracy worse than 100 m or older than 60 s; smooth with a short moving window; duplicates/out-of-order never move the vehicle backwards. Hardware trackers can post to the same endpoint via an adapter (AIS-140 is common in India — check state rules before choosing phone-only GPS).

*Privacy.* Channel admits a subscriber only if a linked child has an active student_stops row on that trip; location visible only while the trip is live (+10 min grace before start); parent sees the vehicle, the child's stop and ETA — not other children, the driver's phone or other routes; raw positions deleted after 30 days; revoking a guardian link or stop assignment cuts access immediately; driver consent limited to trip hours.

*Alerts.* Trip started → linked parents; approaching (ETA ≤ N min, default 5) → parents; boarded/dropped (attendant scan) → parents; absent at stop → parents; delay (ETA slips > 10 min vs schedule) → parents + Transport Manager; SOS → Transport Manager, Principal, on-call with location; speeding/off-route → Transport Manager. ETA via a routing service (Mapbox, Google Directions or self-hosted OSRM) recomputed every 30 s; stop arrival = geofence enter on stops.radius_m.

*Boarding scan.* QR on the student ID card or RFID, scanned by the attendant app; writes trip_events; works offline and syncs without duplicates; without an attendant the driver app lists students at the stop for a manual tick; a boarded scan can set the school-gate attendance flag (per institution).

*Screens.* Driver: today's route, big Start Trip, stop list with progress, SOS. Attendant: stop-by-stop student list, scan, absent. Parent: map, ETA, child status, alert history. Manager web: fleet map, trips, route editor, exceptions, reports (on-time %, distance, incidents).

*Operations.* Document-expiry reminders (licence, fitness, insurance, permit); Android battery-optimisation exemption + persistent notification; test on low-end devices. Capacity example: 50 vehicles × 2 trips × 45 min at 1 ping/10 s ≈ 27,000 rows/day/campus. Tests: RLS (parent on route A cannot subscribe to route B), ingest dedupe/out-of-order, geofence/ETA replay, offline scan sync, load of 200 live trips and 1,000 subscribed parents with p95 delivery < 3 s. MVP scope: vehicles/routes/stops/assignment, driver GPS + trip + SOS, parent live map + ETA + started/approaching/boarded/dropped alerts, manager fleet map and history. Later: hardware adapter, route optimisation, speeding/off-route rules, fuel/maintenance log, transport fee per stop.

## Appendix H — Legacy-system migration (Octopod) (ROADMAP, full design)

*Purpose.* Load a school's existing data once (students, parents, staff, fees) so it can switch without re-keying. *Assumptions to confirm:* the legacy system exports CSV/Excel per module; the school owns the data and its contract allows export; the import is one-time with an optional final delta before cutover. If any is false (PDF-only, or an API exists), change only the source options.

*Pipeline.* Upload export files (admin web) → store raw files untouched (encrypted, restricted, deleted 30 days after cutover) → parse into import_staging_rows (one row per source row, JSON payload) → apply a mapping profile (source column → platform field, value maps) → validate and normalise (duplicates, references, phone E.164 +91, dates, class names) → *dry-run report* (counts, errors, warnings, samples) reviewed by the admin → admin confirms → load in dependency order, in batches within a batch_id → reconciliation report (source vs loaded counts, fee balances; load blocked on mismatch until accepted) → optional rollback of one batch. Nothing is written to real tables before confirmation. Every run writes to the audit log.

*Load order.* 1 institution/campus/year/terms → 2 classes/sections/subjects → 3 staff and teacher assignments → 4 students, guardians, links, enrollments → 5 attendance history (optional, summarised) → 6 fee structures, opening balances, past payments → 7 marks/report cards history (optional) → 8 transport routes/stops/student stops → 9 photos and documents.

*Mapping profile = data, not code:* import_mappings(source, entity, column_map, value_maps) e.g. "Adm No" → admission_no; class "VIII A" and "8-A" → Class 8, Section A. Editable in a preview screen with sample rows; saved per school and reusable across its campuses.

*Identity and de-duplication.* Students key on (org, admission_no); a repeated number is an error for the admin to resolve (never auto-merged). Guardians: one person across siblings — match on normalised phone, then name + phone; flag a phone shared by more than 5 students. Staff: match employee number, then phone. A guardian without a phone cannot use OTP login: load them, list them as "no login possible". legacy_ids(source, entity, legacy_id, new_id) makes every load an upsert so re-runs and the final delta create no duplicates.

*Data-quality rules.* Mixed date formats parsed per profile (ambiguous rows rejected); inconsistent class names handled by value maps with unmapped values listed; missing mandatory field ⇒ row skipped and listed with its source row number; UTF-8 only; fee balance mismatch blocks the load until accepted.

*Fees.* Import an opening balance per student at the cutover date plus past payments as read-only history; do not rebuild the old ledger; reconcile total outstanding before go-live.

*Privacy.* Imported guardians must give consent on first login (DPDP); no marketing messages before that; raw files hold full personal data (encrypt, restrict to Super Admin and the school's Org Admin, delete after retention).

*Cutover.* Trial import into a staging tenant → fix the mapping → freeze (or note) the cutover date → full import to production and review reconciliation → optional delta → send first-login invites by SMS/WhatsApp → keep the old system read-only for a short overlap → delete raw files after retention. *Tests:* fixture exports with realistic mess (mixed dates, duplicate admission numbers, siblings sharing a phone, missing phones); dry-run error counts; re-run creates no duplicates; rollback removes exactly one batch; cross-tenant isolation; reconciliation of counts and fee totals.

## Appendix I — Feature catalog with phases

MVP ships in the first pilot, P2 follows, P3 later. "Code" = status today.

| Area | Feature | Roles | Phase | Code |
|---|---|---|---|---|
| Platform | Org/institution/campus setup | Super/Org Admin | MVP | PARTIAL (org only) |
| | Users, roles, scoped RBAC, audit log | Org/Campus Admin | MVP | BUILT |
| | Phone-OTP and email login, device sessions | All | MVP | PARTIAL (email + password only; OTP ROADMAP) |
| | Parent multi-child switcher | Parent | MVP | BUILT |
| | Bulk CSV import (students, guardians, staff, fees) | Campus Admin | MVP | PARTIAL (students/staff) |
| | One-time legacy (Octopod) import | Org/Super Admin | MVP | ROADMAP (App. H) |
| | Backups, restore drill, data export | Super Admin | MVP | ABSENT (PR-D2, PR-D4) |
| | Per-tenant branding; audited impersonation | Org/Super Admin | P2 | ROADMAP |
| | Subscriptions/billing, white-label, public API/webhooks/SSO | Super/Org Admin | P3 | ROADMAP |
| Academics | Classes, sections, subjects, offerings | Campus Admin | MVP | BUILT (no offerings entity) |
| | Timetable + substitute teachers | Campus Admin, Teacher | MVP | BUILT |
| | Academic calendar, holidays, events | Campus Admin | MVP | BUILT |
| | Attendance (manual, live-join, bus boarding) | Teacher, Student, Parent | MVP | manual + live BUILT; bus ROADMAP |
| | Assignments and submissions | Teacher, Student | MVP | BUILT |
| | Homework diary; exams, marks, report cards | Teacher, Parent | P2 | BUILT |
| | College credits/semesters/electives | HOD, Student | P2 | ROADMAP |
| | Content library, quizzes, question bank | Teacher, Student | P2 | resources BUILT; quizzes ROADMAP |
| | Online proctored exams | Teacher, Student | P3 | ROADMAP |
| Live | Section/class-wise live; parent view-only; auto attendance | Teacher, Student, Parent | MVP | BUILT |
| | Recording with consent + retention | Teacher, Parent | MVP | PARTIAL (hook + event; consent/retention PR-D1/D3) |
| | Hand raise, mute all, remove | Teacher | MVP | BUILT (hand-raise client-side) |
| | Recordings on demand, chat and polls, HLS broadcast | Student, Parent, Principal | P2 | chat BUILT (data channel); rest ROADMAP |
| Transport | Vehicles/routes/stops, driver + attendant apps, live tracking, alerts, SOS, fleet map, QR/RFID scan | Transport roles, Parent | MVP/P2 | ROADMAP (App. G) |
| Communication | Notices by school/class/section; in-app delivery log | Admin, Teacher | MVP | BUILT |
| | Push/SMS/WhatsApp/email providers; preferences | System, All | MVP | preferences BUILT; providers ROADMAP |
| | Parent-teacher chat, PTM, grievances | Teacher, Parent | P2 | BUILT |
| | Hindi/regional UI and templates | All | P2 | ROADMAP |
| Finance | Fee structures, invoices, receipts, Razorpay, defaulters, reminders | Accountant, Parent | MVP | BUILT |
| | Concessions and sibling discounts | Accountant | P2 | BUILT |
| | Payroll; Tally export | HR, Accountant | P3 | ROADMAP |
| School ops | Leave (student, staff) | Parent, Teacher, HR | MVP | BUILT |
| | Admissions, certificates/TC, ID cards, health records, staff HR | Admissions, Admin, Nurse, HR | P2 | BUILT (health checkups, not full health module) |
| | Visitors/gate, authorised pickup + QR, library | Security, Librarian | P2 | ROADMAP |
| | Hostel, canteen/wallet, inventory, alumni | Wardens etc. | P3 | ROADMAP |
| Insight | Admin dashboards and analytics hub; student progress for parents | Principal, Parent | P2 | BUILT |
| | Early-warning flags | Class Teacher | P3 | BUILT (flags in 360) |
| | AI helpers | Teacher | P3 | ROADMAP |
| Offline | Offline-tolerant mobile (cached timetable, queued scans) | All | MVP | ROADMAP (PWA caching not built) |
| | Low-bandwidth live (audio-only fallback) | All | MVP | PARTIAL (LiveKit adaptive; explicit toggle in classroom) |

## Appendix J — Delivery phases, risks, policies, open questions

*Delivery phases (original plan).* 1 Foundation (auth, tenancy, hierarchy, RBAC/RLS, audit, bulk import, backups) → 2 Academics (students, guardians, timetable, attendance, calendar, leave, legacy import loaders) → 3 Live (rooms, scheduling, role tokens, audience, auto attendance, recording with consent) → 4 Comms and fees (notices, preferences, delivery log, Razorpay, defaulter reports) → 5 Transport → pilot (one institution, one class live, two buses tracked) → 6 Phase-2 features → 7 Phase-3 features. Transport follows fees so it can reuse notifications; swap phases 3 and 5 if a pilot school needs buses first. Gate each phase on the pilot; keep P2/P3 behind feature flags in orgs.settings.

*Risks and mitigations.*

| Risk | Mitigation |
|---|---|
| Child safety and consent for streaming/recording | Consent table, opt-in recording, parent-view toggles, audit logs |
| RLS misconfiguration leaks cross-tenant data | rls:check, negative tests per table in CI, review checklist |
| Bus location leaks to the wrong parent | Private channel tied to student_stops, trip-window limit, negative tests |
| GPS accuracy/battery on low-end phones | Batched pings, accuracy filter, battery-exemption guide, hardware option |
| Driver adoption | One-button Start Trip, Hindi/regional labels, on-site onboarding |
| SOS liability | Clear escalation chain, delivery receipt, drills, documented limits |
| Low bandwidth in India | Simulcast, audio-only fallback, PWA caching, offline queue for scans |
| Live cost at scale | LiveKit Cloud first, track participant-minutes, self-host trigger point |
| SMS/WhatsApp delivery in India | DLT template registration early; push as primary channel |
| Scope creep | Phase gating and feature flags |

*Policies to define before pilot (required by release gate 7).*
- Incident response: who is called, in what order and within what time for a child-safety event in a live class, on a bus or at the gate, including SOS handling.
- Retention (proposed — confirm with legal): recordings 90 days; raw GPS 30 days; trip events for the academic year; attendance and marks for the life of the student record; audit logs ≥ 1 year; raw import files 30 days after cutover; notifications 90 days.
- Deletion: guardian requests under the DPDP Act with a documented process and a log.
- Data export: a tenant can export all its data on exit; a person can export their own data.

*Open questions.* College credit/semester rules per university · parent live-view default (currently off) · recording retention required by target institutions · native Expo apps in MVP or PWA first · phone GPS vs certified hardware trackers (state rules) · boarding scan QR vs RFID · maps provider (Mapbox, Google, OSRM) · legacy export formats, modules in use, history depth, export fee, photo/document bulk export, API availability, delta import vs hard freeze.