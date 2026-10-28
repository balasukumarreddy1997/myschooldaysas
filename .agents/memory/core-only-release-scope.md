---
name: Core-only release scope
description: User-approved temporary scope for publishing the school MVP without external live and payment services.
---

The user approved temporarily skipping live classes and online payments so the core school application can be published first. Preserve the existing implementation for later rather than deleting it or replacing real production payments with mock transactions.

**Why:** The user asked to skip those features for now when presented with the external service credentials needed for publishing.

**How to apply:** Keep these features out of the production release until the user asks to enable them. This is a production scope decision, not authorization to redesign or remove the development classroom. Authentication and tenant/database security must remain enforced.

The user selected Replit-managed PostgreSQL for the published app, with the existing local database preserved and no demo accounts copied.

**Why:** The user accepted the managed-database option after being told the publishing database did not yet contain the school schema.

**How to apply:** Treat managed development as the schema source for Publishing, separately from local development data. Do not silently switch back to an external database or copy demo credentials into production.
