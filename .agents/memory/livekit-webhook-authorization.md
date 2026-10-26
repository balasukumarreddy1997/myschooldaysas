---
name: LiveKit webhook authorization
description: A non-obvious SDK difference between webhook authorization and ordinary API bearer tokens.
---

Pass LiveKit's Authorization header unchanged to its webhook receiver. For synthetic signed webhook tests, send the raw JWT in that header, not `Bearer <JWT>`, and checksum the exact raw payload.

**Why:** The SDK verifier treats the entire header as the token. Applying the app's ordinary Bearer-token convention caused correctly signed synthetic webhooks to be rejected.

**How to apply:** Preserve the raw body for `application/webhook+json` and cover both genuine SDK-signed events and forged headers in integration tests. Do not weaken signature verification to make fixtures pass.
