# Identity route slice

This is a convenience summary derived from `MASTER_SPEC.md`; the master spec remains authoritative. These routes now register as native Fastify plugins in the shared API process; identity is not yet an independently deployed service.

## Implemented contract

- `POST /api/identity/auth/login` accepts `orgSlug`, `email`, and `password`; returns a signed access token and user summary.
- `GET /api/identity/me` requires a bearer token and returns the current user and current roles.
- Password hashes use scrypt. Access-token verification rejects altered and expired tokens.
- Organization membership and user status are checked during sign-in. Authorization middleware reloads roles before protected requests.

## Data and isolation

The `identity` schema stores organizations, users, user roles, guardian links, and student profile/contact data. Guardian links carry `can_view_live` and `can_pay_fees` flags, added by migration `identity:003`. `identity.profiles` stores student date of birth, gender, phone, address, blood group, and contact-only guardian name/email/phone/relationship; migration `identity:004` adds this table with forced tenant RLS. Admission intake creates the profile in the same transaction as the student account and enrollment. Contact details do not create guardian accounts or access links. Tenant rows carry `org_id` and use forced RLS. The runtime database role is separate from the local migration role.

## Not implemented

Refresh/logout rotation, change-password and forced-change UI, lockout/rate limiting, role grants/revocation, user administration, bulk import, reset-password, organization settings, and complete audit events.

## Acceptance checks

- Valid demo credentials return a token; invalid credentials do not.
- Missing, tampered, and expired tokens cannot access protected routes.
- A user's active roles are reloaded from the database for API authorization.

