---
name: RLS write fixtures
description: Fixture design for mutation checks on tenant tables with natural-key constraints.
---

For RLS mutation checks, use distinct supporting records for fixture rows, cross-organization insert attempts, and same-organization transient writes when the table has natural-key uniqueness.

**Why:** a unique-constraint failure can happen before the intended row-level security check, causing the test to fail for the wrong reason.

**How to apply:** when adding a one-to-one or period-unique tenant table to the write-check inventory, give foreign and transient cases valid but unused related IDs, then assert the failure is specifically caused by RLS.
