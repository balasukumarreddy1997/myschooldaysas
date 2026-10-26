#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

if [[ ! -f .env ]]; then
  echo "Missing root .env; copy .env.example for local development." >&2
  exit 2
fi

# Load the project environment first, then replace both database URLs with
# credentials for the isolated local test cluster below.
set -a
. ./.env
set +a

if [[ "${NODE_ENV:-development}" == "production" ]]; then
  echo "Refusing to run the RLS write check with NODE_ENV=production." >&2
  exit 2
fi

INITDB="$(command -v initdb || true)"
PG_CTL="$(command -v pg_ctl || true)"
PSQL="$(command -v psql || true)"
if [[ -z "$INITDB" || -z "$PG_CTL" || -z "$PSQL" ]]; then
  echo "Local PostgreSQL 16 tools (initdb, pg_ctl, psql) are required; no containers or shared DBs will be used." >&2
  exit 2
fi

PG_VERSION="$("$INITDB" --version)"
PG_MAJOR="${PG_VERSION##* }"
PG_MAJOR="${PG_MAJOR%%.*}"
if [[ "$PG_MAJOR" != "16" ]]; then
  echo "This check requires PostgreSQL 16; found: $PG_VERSION" >&2
  exit 2
fi

umask 077
TEST_ROOT="$(mktemp -d /tmp/hardentest-rls.XXXXXX)"
PGDATA="$TEST_ROOT/data"
SOCKET_DIR="$TEST_ROOT/socket"
LOG_FILE="$TEST_ROOT/postgres.log"
PORT=""

cleanup() {
  local status=$?
  trap - EXIT

  if [[ -n "$PGDATA" && -d "$PGDATA" ]] && "$PG_CTL" -D "$PGDATA" status >/dev/null 2>&1; then
    "$PG_CTL" -D "$PGDATA" -m immediate -w stop >/dev/null 2>&1 || true
  fi

  if [[ -n "$TEST_ROOT" ]]; then
    if [[ -n "$PGDATA" && -d "$PGDATA" ]] && "$PG_CTL" -D "$PGDATA" status >/dev/null 2>&1; then
      echo "Could not stop the temporary PostgreSQL process; its test files were kept at $TEST_ROOT." >&2
      status=1
      if [[ -f "$LOG_FILE" ]]; then tail -n 25 "$LOG_FILE" >&2; fi
    elif [[ "$TEST_ROOT" == /tmp/hardentest-rls.* ]]; then
      rm -rf -- "$TEST_ROOT"
      if [[ "$status" -eq 0 ]]; then
        echo "Temporary PostgreSQL cluster stopped and removed."
      elif [[ -f "$LOG_FILE" ]]; then
        tail -n 25 "$LOG_FILE" >&2
      fi
    else
      echo "Refusing to remove an unexpected temporary path." >&2
      status=1
    fi
  fi

  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

mkdir -p "$SOCKET_DIR"
PORT="$(node -e "const net=require('node:net');const server=net.createServer();server.listen(0,'127.0.0.1',()=>{console.log(server.address().port);server.close()})")"

"$INITDB" -D "$PGDATA" --username=postgres --no-locale --encoding=UTF8 \
  --auth-local=trust --auth-host=trust >"$TEST_ROOT/initdb.log"
"$PG_CTL" -D "$PGDATA" -l "$LOG_FILE" \
  -o "-h 127.0.0.1 -p $PORT -k $SOCKET_DIR -F" -w start

"$PSQL" -h 127.0.0.1 -p "$PORT" -U postgres -d postgres -v ON_ERROR_STOP=1 <<'SQL'
CREATE ROLE campus_migrator LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
CREATE ROLE campus_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
CREATE DATABASE campus_rls_test OWNER campus_migrator;
SQL

export NODE_ENV=development
export DATABASE_URL="postgresql://campus_app@127.0.0.1:${PORT}/campus_rls_test"
export MIGRATOR_DATABASE_URL="postgresql://campus_migrator@127.0.0.1:${PORT}/campus_rls_test"

bash scripts/db/migrate.sh
node scripts/db/rls-write-check.mjs
