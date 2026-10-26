#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

if [[ "${NODE_ENV:-development}" == "production" ]]; then
  echo "Refusing to run development migration script in production." >&2
  exit 1
fi

: "${MIGRATOR_DATABASE_URL:?MIGRATOR_DATABASE_URL is required}"

psql "$MIGRATOR_DATABASE_URL" -v ON_ERROR_STOP=1 -c \
  "CREATE TABLE IF NOT EXISTS public.schema_migrations (
     version text PRIMARY KEY,
     applied_at timestamptz NOT NULL DEFAULT now()
   )"

while IFS='|' read -r version migration; do
  [[ -z "$version" ]] && continue
  applied="$(psql "$MIGRATOR_DATABASE_URL" -tAc \
    "SELECT 1 FROM public.schema_migrations WHERE version = '$version'")"
  if [[ "$applied" == "1" ]]; then
    echo "Already applied: $version"
    continue
  fi
  psql "$MIGRATOR_DATABASE_URL" --single-transaction -v ON_ERROR_STOP=1 -f "$migration"
  echo "Applied: $version"
done <<'MIGRATIONS'
identity:001|services/identity/migrations/001_identity.sql
identity:002|services/identity/migrations/002_identity_org_fk.sql
academic:001|services/academic/migrations/001_academic.sql
academic:002|services/academic/migrations/002_consents.sql
academic:003|services/academic/migrations/003_subjects.sql
school:001|services/school/migrations/001_attendance.sql
live:001|services/live/migrations/001_live.sql
board:001|services/board/migrations/001_board.sql
board:002|services/board/migrations/002_realtime.sql
live:002|services/live/migrations/002_classroom.sql
learning:001|services/learning/migrations/001_learning.sql
learning:002|services/learning/migrations/002_report_cards.sql
MIGRATIONS
