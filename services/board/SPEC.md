# Board-template route slice

This is a convenience summary derived from `MASTER_SPEC.md`; these routes now register as native Fastify plugins in the shared API process; board is not yet an independently deployed service.

## Implemented contract

- `GET /api/board/templates` lists templates visible to the caller.
- `POST /api/board/templates` creates an authorized organization/class/section/teacher template.
- `PATCH /api/board/templates/{templateId}` updates an authorized template.
- Template configuration is validated before storage.

## Data and isolation

The `board` schema stores templates. Tenant templates use `org_id` and forced RLS; system templates are read-only in this slice.

## Not implemented

Boards, pages, drawing operations, snapshots, exports, WebSocket transport, sequence/replay handling, draw grants, template previews, and full template-precedence resolution are not implemented.

## Acceptance checks

- Unauthenticated callers cannot list or mutate templates.
- Non-admin users cannot write organization-wide templates.
- Invalid board configuration is rejected before persistence.

