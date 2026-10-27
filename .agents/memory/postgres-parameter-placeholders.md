---
name: PostgreSQL parameter placeholders
description: Positional parameter numbering when composing query fragments.
---

When composing parameterized SQL from reusable fragments, keep numbered placeholders contiguous and ensure each bound value is referenced. Skipping a slot such as `$5` while using `$6` can cause PostgreSQL to fail with an indeterminate-parameter-type error.

**Why:** a composed read-scope query had an unused bound value, which made the production-shaped PostgreSQL request fail at runtime.

**How to apply:** align SQL placeholder numbers with the values array whenever changing a parameterized query; run it against PostgreSQL, not only a mocked pool.
