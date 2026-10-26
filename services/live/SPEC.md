# Live-session route slice

This is a convenience summary derived from `MASTER_SPEC.md`; these routes now register as native Fastify plugins in the shared API process; live is not yet an independently deployed service.

## Implemented contract

- `GET /api/live/sessions` lists sessions visible to the caller.
- `POST /api/live/sessions` schedules a session for authorized sections.
- `POST /api/live/sessions/{sessionId}/start` and `/end` enforce session state transitions.
- `POST /api/live/sessions/{sessionId}/token` mints server-side LiveKit grants only after authorization and configuration checks.
- Session states are `scheduled`, `live`, `ended`, and `cancelled`.

## Data and isolation

The `live` schema stores sessions, section assignments, and attendance-related records. Tenant rows use `org_id` and forced RLS. Clients do not choose token grants.

## Not implemented

The LiveKit classroom client, participant controls, board/WebSocket collaboration, LiveKit webhook verification, attendance finalization, and recording lifecycle are not implemented. Parent token issuance requires a linked guardian, session parent-view permission, and active `live_view` consent. Token requests fail closed with HTTP 503 until a public LiveKit URL is configured.

## Acceptance checks

- A teacher cannot schedule for a section they do not teach.
- Invalid session state transitions are rejected.
- A token is not issued when LiveKit connection configuration is incomplete.

