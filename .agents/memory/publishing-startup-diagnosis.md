---
name: Publishing startup diagnosis
description: Avoid misdiagnosing generic publishing health-check failures in the multi-service application.
---

Do not infer which service failed, or which probe path was actually used, from the generic publishing message mentioning GET /. Check production configuration presence and startup validation before changing probes.

**Why:** Publishing compiled both services successfully but failed promotion with a generic root-probe message. Failed-revision runtime logs were empty. Adding a dedicated web health route did not resolve the failure; checking production settings then exposed deterministic API startup validation failures.

**How to apply:** Separate successful compilation from runtime readiness. Inspect production variable presence without revealing values, compare it with startup requirements, and reproduce validation in isolation without connecting to a database. Keep production safety guards intact and never substitute local container endpoints or development defaults.
