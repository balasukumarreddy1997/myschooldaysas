---
name: Local container health checks
description: Distinguish Docker health-check execution failures from actual local PostgreSQL and Redis reachability.
---

When `platform-postgres` or `platform-redis` is marked unhealthy and Docker reports an OCI `setns` error while launching the health check, the health-check process itself may be failing to start. Do not infer that the service is unreachable from the container status alone. Check PostgreSQL with `pg_isready` and Redis with a TCP `PING` from the workspace before restarting or changing containers.

**Why:** Both services accepted host-level connections while their in-container health checks failed with an OCI runtime execution error.

**How to apply:** Use this distinction when debugging this project's local Compose database/cache. Only inspect or operate containers named `platform-*`.
