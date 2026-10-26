# Academic route slice

This is a convenience summary derived from `MASTER_SPEC.md`; these routes now register as native Fastify plugins in the shared API process; academic is not yet an independently deployed service.

## Implemented contract

- `GET /api/academic/classes` lists classes visible to the caller.
- `GET /api/academic/sections` lists sections visible to the caller and accepts optional `classId`.
- `GET /api/academic/students` requires `sectionId`; supports `q`, `limit` (1–100), and `offset`; returns `{ items, total, limit, offset }`.
- Organization administrators can read the school roster; teachers are limited to assigned sections; students see only their own row; parents see linked students.

## Data and isolation

The `academic` schema stores classes, sections, subjects, enrollments, teacher assignments, timetable slots, consent records, and consent-review status. `identity.guardian_links` stores guardian relationships and the `can_view_live` / `can_pay_fees` flags. Tenant tables use `org_id` and forced RLS; guardian links are joined under the same organization scope. Sections expose optional capacity; enrollment records expose academic year; timetable slots include an optional room.

## Implemented in this checkout

- Admins can manage section capacity and academic year through the academic API and class/roster screens.
- Timetable slots can be created and removed by admins, are visible according to the caller's section/teacher/guardian relationships, include room, and reject overlapping teacher or section slots.
- Subject catalog, teacher assignments, student attendance, and term report cards are implemented in adjacent academic/learning screens.
- Parent consent review status is persisted; the parent must explicitly review choices, and that action grants no permission.
- Administrators can list guardian links and update live-view/payment flags. Parent live-session discovery and classroom access require session `parent_view`, a linked student, `can_view_live`, and an active `live_view` consent.
- Recording/photo consent grants return 409 while the corresponding product features are unavailable.

## Remaining gaps

Admissions seat enforcement still uses the legacy `class_capacity` field because registry/admissions is not present in this checkout. No fee-payment feature exists to enforce `can_pay_fees`; audit entries for consent-review and guardian-flag changes, marketing/data-processing consent policy and enforcement remain open. Calendar rules, transfers/promotion UI, and academic analytics are also not implemented.

## Acceptance checks

- Admin listing returns paginated roster data.
- Teacher access to an unassigned section is denied.
- Student and parent roster results are restricted to their own record or linked child.

