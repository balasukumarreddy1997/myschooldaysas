# Temporary core-only release

Live classes and online payments are deferred for this release. Their existing implementation is preserved; they are explicitly disabled rather than supplied with fake production credentials.

## Publishing configuration

Set these non-secret variables in the **production** environment before building:

```text
ENABLE_LIVE_CLASSES=false
ENABLE_ONLINE_PAYMENTS=false
ENABLE_REDIS=false
NEXT_PUBLIC_ENABLE_LIVE_CLASSES=false
NEXT_PUBLIC_ENABLE_ONLINE_PAYMENTS=false
```

The `NEXT_PUBLIC_*` values are compiled into the web build. Changing these requires a rebuild and republish. They must match the corresponding API settings. Development defaults remain enabled.

With these switches:

- Live session APIs, LiveKit webhooks, classroom tickets and classroom websocket connections return HTTP 503 `FEATURE_DISABLED` before invoking their handlers.
- Live navigation and dashboard actions are hidden or replaced with core-learning/timetable actions. Direct live/classroom links explain that the feature is unavailable.
- Payment submission is blocked and invoice responses do not advertise payment eligibility. Invoices, fee balances and existing receipts remain accessible to their authorized users.
- Readiness still checks PostgreSQL, but does not require Redis. Redis is not used by the core API workflows.
- LiveKit, Razorpay and Redis credentials are no longer mandatory. Re-enabling a provider restores the production credential requirements.

## Requirements that are NOT bypassed

- `DATABASE_URL` must point to a reachable production PostgreSQL database with the application's schemas and migrations.
- The runtime database role must be non-superuser and `NOBYPASSRLS`.
- `JWT_SECRET` and `INTERNAL_API_KEY` must each be separate, securely generated values of at least 32 characters, not development placeholders. Store them in production Secrets, never in source code or chat.
- Development seeds and demo credentials must not be used to provision real production users.

The local `.env` may select a database separate from Replit's managed database. Local migration or login success does not prove that the managed publishing source has the application schema. Verify the intended database and get approval before copying schema or data; do not migrate at API startup.

This change is not a declaration that the full production-hardening specification is complete. The published revision, database schema/role and signed-in core journeys must still be verified. Publish through Replit's Publishing UI after supplying the required settings; the agent does not publish automatically.

## Re-enable later

Provision the real services and add their credentials securely. For each feature, switch both API and web flags to `true`, rebuild, and verify against the provider's testing environment before using it with real users. Enabling a switch alone does not establish that the underlying payment/live implementation meets the complete production acceptance requirements.

## Focused verification

After building the API, run the local real-database, read-only bootstrap check with the local environment loaded:

```sh
set -a; . ./.env; set +a
node --test scripts/tests/core-only-startup.mjs
```

Run the mocked-account UI checks against a **core-only production web build**:

```sh
CORE_ONLY_UI_TESTS=1 CAMPUS_LIVE_BASE_URL=http://127.0.0.1:19558 \
  npx playwright test --config artifacts/campus-live/playwright.config.ts core-only.spec.ts
```

The core-only UI checks are skipped by default in the full-feature development dashboard suite.
