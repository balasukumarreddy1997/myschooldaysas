# Campus Live web slice

This is a convenience summary derived from `MASTER_SPEC.md`; the master spec remains authoritative. This artifact currently uses React 19 and Vite, rather than the target Next.js 16 app.

## Implemented screens

- Organization sign-in.
- Role-aware dashboard with live-session summaries.
- Class and section directory with paginated student roster.
- Live-session listing, scheduling, start/end controls, and classroom entry state.
- Board-template listing and configuration editing.

The screens use generated React Query hooks from `lib/api-spec/openapi.yaml` and display API loading, empty, error, and unauthenticated states. The access token is held in memory, not persisted to local storage.

## Not implemented

The full admin, teacher, student, and parent portals; admissions, attendance, assignments, marks, fees, notices, messaging, notifications, timetable, consent screens, PWA/i18n, and a real-time classroom/board client are not part of this slice.

## Acceptance checks

- The login screen renders at desktop and mobile viewport sizes.
- Authenticated screens call the API and honor the caller's role and organization.
- Loading, empty, error, and unauthenticated states do not require hard-coded server data.

