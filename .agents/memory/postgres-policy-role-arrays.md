---
name: PostgreSQL policy role arrays
description: Node-postgres handling of the roles array returned by PostgreSQL pg_policies.
---

When querying `pg_policies` through node-postgres, select `roles::text[]` if JavaScript needs an array. Without the cast, the `name[]` value may be returned as a brace-delimited string such as `"{public}"`.

**Why:** The default parser shape caused an RLS audit to incorrectly conclude that no policy applied to `campus_app`.

**How to apply:** Cast policy role arrays in the SQL projection before checking whether a policy applies to the current application role.
