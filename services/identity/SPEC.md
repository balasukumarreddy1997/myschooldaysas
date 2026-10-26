# Identity route slice

This is a convenience summary derived from `MASTER_SPEC.md`; the master spec remains authoritative. These routes currently live in the shared Express API process and are not an independently deployed identity service.

## Implemented contract

- `POST /api/identity/auth/login` accepts `orgSlug`, `email`, and `password`; returns a signed access token and user summary.
- `GET /api/identity/me` requires a bearer token and returns the current user and current roles.
- Password hashes use scrypt. Access-token verification rejects altered and expired tokens.
- Organization membership and user status are checked during sign-in. Authorization middleware reloads roles before protected requests.

## Data and isolation

The `identity` schema stores organizations, users, user roles, and guardian links. Tenant rows carry `org_id` and use forced RLS. The runtime database role is separate from the local migration role.

## Not implemented

Refresh/logout rotation, change-password and forced-change UI, lockout/rate limiting, role grants/revocation, user administration, bulk import, reset-password, organization settings, and complete audit events.

## Acceptance checks

- Valid demo credentials return a token; invalid credentials do not.
- Missing, tampered, and expired tokens cannot access protected routes.
- A user's active roles are reloaded from the database for API authorization.

