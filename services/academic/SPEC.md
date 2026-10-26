# Academic route slice

This is a convenience summary derived from `MASTER_SPEC.md`; the master spec remains authoritative. These routes currently live in the shared Express API process and are not an independently deployed academic service.

## Implemented contract

- `GET /api/academic/classes` lists classes visible to the caller.
- `GET /api/academic/sections` lists sections visible to the caller and accepts optional `classId`.
- `GET /api/academic/students` requires `sectionId`; supports `q`, `limit` (1–100), and `offset`; returns `{ items, total, limit, offset }`.
- Organization administrators can read the school roster; teachers are limited to assigned sections; students see only their own row; parents see linked students.

## Data and isolation

The `academic` schema stores classes, sections, enrollments, and teacher assignments. Tenant tables use `org_id` and forced RLS. Guardian links are joined under the same organization scope.

## Not implemented

The full spec's CRUD, subjects, timetable, teacher workloads, guardians management, attendance, consent routes/enforcement, transfers, promotion, and analytics are not part of this slice.

## Acceptance checks

- Admin listing returns paginated roster data.
- Teacher access to an unassigned section is denied.
- Student and parent roster results are restricted to their own record or linked child.

