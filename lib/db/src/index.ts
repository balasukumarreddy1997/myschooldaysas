import pg from "pg";
import type { PoolClient, QueryResult, QueryResultRow } from "pg";

const { Pool } = pg;

export function createPool(connectionString: string): pg.Pool {
  if (!connectionString) {
    throw new Error("A database connection string is required.");
  }

  const connection = new Pool({
    connectionString,
    max: 12,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
    statement_timeout: 10_000,
    query_timeout: 12_000,
    allowExitOnIdle: false,
  });

  connection.on("error", (error) => {
    process.emitWarning(error, {
      code: "PG_POOL_IDLE_CLIENT_ERROR",
      detail: "The PostgreSQL pool received an idle client error.",
    });
  });

  return connection;
}

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error(
    "DATABASE_URL must be set. Refusing to start without an explicit database connection.",
  );
}

export const pool = createPool(databaseUrl);

export async function assertLeastPrivilegeDatabaseRole(
  connection: pg.Pool = pool,
): Promise<void> {
  const result = await connection.query<{
    role_name: string;
    rolsuper: boolean;
    rolbypassrls: boolean;
  }>(
    `SELECT current_user AS role_name, role.rolsuper, role.rolbypassrls
       FROM pg_roles AS role
      WHERE role.rolname = current_user`,
  );
  const role = result.rows[0];
  if (!role || role.rolsuper || role.rolbypassrls) {
    throw new Error(
      `Database role "${role?.role_name ?? "unknown"}" is privileged; ` +
        "Campus Live requires a non-superuser role with NOBYPASSRLS.",
    );
  }
}

export async function withOrg<T>(
  orgId: string,
  callback: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.org_id', $1, true)", [orgId]);
    const result = await callback(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export type { PoolClient, QueryResult, QueryResultRow };
