#!/usr/bin/env bash
set -euo pipefail

npm ci --no-audit --no-fund

# The API workflow applies numbered migrations and builds the server on restart.
# Do not use drizzle-kit push here; it can reconcile a shared database schema.
