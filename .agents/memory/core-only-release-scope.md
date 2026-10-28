---
name: Core-only release scope
description: User-approved temporary scope for publishing the school MVP without external live and payment services.
---

The user approved temporarily skipping live classes and online payments so the core school application can be published first. Preserve the existing implementation for later rather than deleting it or replacing real production payments with mock transactions.

**Why:** The user asked to skip those features for now when presented with the external service credentials needed for publishing.

**How to apply:** Keep these features out of the production release until the user asks to enable them. This is a production scope decision, not authorization to redesign or remove the development classroom. Authentication and tenant/database security must remain enforced.
