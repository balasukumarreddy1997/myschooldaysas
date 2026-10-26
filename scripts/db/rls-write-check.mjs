import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { extraTenantCases } from "./rls-write-fixtures.mjs";

const expectedDatabase = "campus_rls_test";
const expectedTenantTableCount = 33;
const localHosts = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
const organizationIds = { a: randomUUID(), b: randomUUID() };
const auxiliaryIds = {
  users: { a: randomUUID(), b: randomUUID() },
  sessions: { a: randomUUID(), b: randomUUID() },
};
let fixtureIds = {};
const failures = [];

function assert(condition, message) {
  if (!condition) failures.push(message);
}

function validateUrl(name, value, expectedRole) {
  if (!value) throw new Error(`${name} is required; the test will not use a fallback connection.`);

  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${name} is not a valid PostgreSQL URL.`);
  }

  const database = decodeURIComponent(parsed.pathname.replace(/^\/+/, ""));
  const role = decodeURIComponent(parsed.username);
  if (
    !["postgres:", "postgresql:"].includes(parsed.protocol) ||
    !localHosts.has(parsed.hostname) ||
    database !== expectedDatabase ||
    role !== expectedRole ||
    parsed.password
  ) {
    throw new Error(
      `${name} must target the password-free loopback ${expectedDatabase} test database as ${expectedRole}.`,
    );
  }
}

const baseTableCases = [
  {
    table: "identity.users",
    idColumn: "id",
    valueColumn: "name",
    selectValueSql: "SELECT name AS value FROM identity.users WHERE id = $1",
    insertSql: `
      INSERT INTO identity.users (id, org_id, email, name, password_hash)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING id
    `,
    insertValues: ({ id, orgId, side }) => [
      id,
      orgId,
      `rls-${side}-${id}@example.invalid`,
      `RLS fixture user ${side} ${id.slice(0, 8)}`,
      "non-authenticating-test-hash",
    ],
    updateSql: "UPDATE identity.users SET name = $1 WHERE id = $2 RETURNING id",
    initialValue: ({ side, id }) => `RLS fixture user ${side} ${id.slice(0, 8)}`,
    updateValue: ({ side }) => `RLS same-org user update ${side}`,
  },
  {
    table: "academic.classes",
    idColumn: "id",
    valueColumn: "name",
    selectValueSql: "SELECT name AS value FROM academic.classes WHERE id = $1",
    insertSql: `
      INSERT INTO academic.classes (id, org_id, name, grade_level)
      VALUES ($1, $2, $3, 1)
      RETURNING id
    `,
    insertValues: ({ id, orgId, side }) => [id, orgId, `RLS fixture class ${side} ${id.slice(0, 8)}`],
    updateSql: "UPDATE academic.classes SET name = $1 WHERE id = $2 RETURNING id",
    initialValue: ({ side, id }) => `RLS fixture class ${side} ${id.slice(0, 8)}`,
    updateValue: ({ side }) => `RLS same-org class update ${side}`,
  },
  {
    table: "academic.sections",
    idColumn: "id",
    valueColumn: "name",
    selectValueSql: "SELECT name AS value FROM academic.sections WHERE id = $1",
    insertSql: `
      INSERT INTO academic.sections (id, org_id, class_id, name)
      VALUES ($1, $2, $3, $4)
      RETURNING id
    `,
    insertValues: ({ id, orgId, side, ids }) => [
      id,
      orgId,
      ids["academic.classes"][side],
      `RLS fixture section ${side} ${id.slice(0, 8)}`,
    ],
    updateSql: "UPDATE academic.sections SET name = $1 WHERE id = $2 RETURNING id",
    initialValue: ({ side, id }) => `RLS fixture section ${side} ${id.slice(0, 8)}`,
    updateValue: ({ side }) => `RLS same-org section update ${side}`,
  },
  {
    table: "board.templates",
    idColumn: "id",
    valueColumn: "name",
    selectValueSql: "SELECT name AS value FROM board.templates WHERE id = $1",
    insertSql: `
      INSERT INTO board.templates (id, org_id, name, scope, config)
      VALUES ($1, $2, $3, 'org', $4::jsonb)
      RETURNING id
    `,
    insertValues: ({ id, orgId, side }) => [
      id,
      orgId,
      `RLS fixture template ${side} ${id.slice(0, 8)}`,
      JSON.stringify({ testFixture: true }),
    ],
    updateSql: "UPDATE board.templates SET name = $1 WHERE id = $2 RETURNING id",
    initialValue: ({ side, id }) => `RLS fixture template ${side} ${id.slice(0, 8)}`,
    updateValue: ({ side }) => `RLS same-org template update ${side}`,
  },
  {
    table: "learning.exam_terms",
    idColumn: "id",
    valueColumn: "name",
    selectValueSql: "SELECT name AS value FROM learning.exam_terms WHERE id = $1",
    insertSql: `
      INSERT INTO learning.exam_terms (id, org_id, name, starts_on, ends_on, is_current)
      VALUES ($1, $2, $3, '2026-01-01', '2026-12-31', false)
      RETURNING id
    `,
    insertValues: ({ id, orgId, side }) => [
      id,
      orgId,
      `RLS fixture term ${side} ${id.slice(0, 8)}`,
    ],
    updateSql: "UPDATE learning.exam_terms SET name = $1 WHERE id = $2 RETURNING id",
    initialValue: ({ side, id }) => `RLS fixture term ${side} ${id.slice(0, 8)}`,
    updateValue: ({ side }) => `RLS same-org term update ${side}`,
  },
  {
    table: "live.sessions",
    idColumn: "id",
    valueColumn: "title",
    selectValueSql: "SELECT title AS value FROM live.sessions WHERE id = $1",
    insertSql: `
      INSERT INTO live.sessions (id, org_id, title, teacher_user_id, mode, starts_at)
      VALUES ($1, $2, $3, $4, 'class', '2026-01-01T09:00:00Z')
      RETURNING id
    `,
    insertValues: ({ id, orgId, side, ids }) => [
      id,
      orgId,
      `RLS fixture session ${side} ${id.slice(0, 8)}`,
      ids["identity.users"][side],
    ],
    updateSql: "UPDATE live.sessions SET title = $1 WHERE id = $2 RETURNING id",
    initialValue: ({ side, id }) => `RLS fixture session ${side} ${id.slice(0, 8)}`,
    updateValue: ({ side }) => `RLS same-org session update ${side}`,
  },
  {
    table: "school.attendance_sessions",
    idColumn: "id",
    valueColumn: "attendance_date",
    selectValueSql: "SELECT attendance_date::text AS value FROM school.attendance_sessions WHERE id = $1",
    insertSql: `
      INSERT INTO school.attendance_sessions (id, org_id, section_id, attendance_date, marked_by)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING id
    `,
    insertValues: ({ id, orgId, side, ids, isFixture }) => [
      id,
      orgId,
      ids["academic.sections"][side],
      isFixture ? "2026-01-02" : "2026-04-02",
      ids["identity.users"][side],
    ],
    updateSql: "UPDATE school.attendance_sessions SET attendance_date = $1 WHERE id = $2 RETURNING id",
    initialValue: () => "2026-01-02",
    updateValue: () => "2026-03-02",
  },
];

const tableCases = [...baseTableCases, ...extraTenantCases];

function createContext(tableCase, side, id, isFixture = false) {
  return {
    id,
    orgId: organizationIds[side],
    side,
    ids: fixtureIds,
    auxiliaryIds,
    isFixture,
    tableCase,
  };
}

async function inOrg(pool, orgId, callback, readOnly = false) {
  const client = await pool.connect();
  let transactionStarted = false;
  try {
    await client.query(readOnly ? "BEGIN READ ONLY" : "BEGIN");
    transactionStarted = true;
    await client.query("SELECT set_config('app.org_id', $1, true)", [orgId]);
    const result = await callback(client);
    await client.query("COMMIT");
    transactionStarted = false;
    return result;
  } catch (error) {
    if (transactionStarted) await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

function keySql(tableCase, placeholderOffset = 0) {
  const predicate = tableCase.keySql ?? `${tableCase.idColumn ?? "id"} = $1`;
  if (placeholderOffset === 0) return predicate;
  return predicate.replace(/\$(\d+)/g, (_match, index) => `$${Number(index) + placeholderOffset}`);
}

function keyValues(tableCase, context) {
  return tableCase.keyValues ? tableCase.keyValues(context) : [context.id];
}

function selectRowSql(tableCase) {
  return `SELECT 1 FROM ${tableCase.table} WHERE ${keySql(tableCase)}`;
}

function deleteRowSql(tableCase) {
  return `DELETE FROM ${tableCase.table} WHERE ${keySql(tableCase)} RETURNING 1`;
}

async function expectForeignInsertDenied(client, tableCase, side, otherSide) {
  const id = randomUUID();
  const context = createContext(tableCase, otherSide, id);
  if (tableCase.table === "learning.grade_scales") context.orgId = randomUUID();
  await client.query("SAVEPOINT foreign_org_insert");
  let denied = false;
  try {
    await client.query(tableCase.insertSql, tableCase.insertValues(context));
  } catch (error) {
    if (error?.code === "42501") denied = true;
    else throw error;
  } finally {
    await client.query("ROLLBACK TO SAVEPOINT foreign_org_insert");
    await client.query("RELEASE SAVEPOINT foreign_org_insert");
  }
  assert(denied, `${tableCase.table}: INSERT for the other org was not rejected while scoped to org ${side}`);
}

async function expectOrgReassignmentDenied(client, tableCase, side, otherSide, ownContext) {
  const foreignOrgId =
    tableCase.table === "learning.grade_scales" ? randomUUID() : organizationIds[otherSide];
  await client.query("SAVEPOINT foreign_org_reassignment");
  let denied = false;
  try {
    await client.query(
      `UPDATE ${tableCase.table} SET org_id = $1 WHERE ${keySql(tableCase, 1)} RETURNING 1`,
      [foreignOrgId, ...keyValues(tableCase, ownContext)],
    );
  } catch (error) {
    if (error?.code === "42501") denied = true;
    else throw error;
  } finally {
    await client.query("ROLLBACK TO SAVEPOINT foreign_org_reassignment");
    await client.query("RELEASE SAVEPOINT foreign_org_reassignment");
  }
  assert(denied, `${tableCase.table}: changing an owned row to a foreign org was not rejected for org ${side}`);
}

async function runTenantWriteChecks(appPool) {
  const client = await appPool.connect();
  let transactionStarted = false;
  try {
    await client.query("BEGIN");
    transactionStarted = true;

    for (const tableCase of tableCases) {
      for (const side of ["a", "b"]) {
        const otherSide = side === "a" ? "b" : "a";
        const ownId = fixtureIds[tableCase.table][side];
        const foreignId = fixtureIds[tableCase.table][otherSide];
        const ownContext = createContext(tableCase, side, ownId, true);
        const foreignContext = createContext(tableCase, otherSide, foreignId, true);
        const ownKeys = keyValues(tableCase, ownContext);
        const foreignKeys = keyValues(tableCase, foreignContext);
        const predicate = keySql(tableCase);
        await client.query("SELECT set_config('app.org_id', $1, true)", [organizationIds[side]]);

        const ownRow = await client.query(selectRowSql(tableCase), ownKeys);
        assert(ownRow.rowCount === 1, `${tableCase.table}: org ${side} cannot see its own fixture row`);

        const foreignRow = await client.query(selectRowSql(tableCase), foreignKeys);
        assert(foreignRow.rowCount === 0, `${tableCase.table}: org ${side} can see org ${otherSide}'s row`);

        const blockedUpdate = await client.query(
          `UPDATE ${tableCase.table} SET org_id = org_id WHERE ${predicate} RETURNING 1`,
          foreignKeys,
        );
        assert(
          blockedUpdate.rowCount === 0,
          `${tableCase.table}: UPDATE changed a row belonging to org ${otherSide}`,
        );

        const blockedDelete = await client.query(deleteRowSql(tableCase), foreignKeys);
        assert(
          blockedDelete.rowCount === 0,
          `${tableCase.table}: DELETE changed a row belonging to org ${otherSide}`,
        );

        await expectForeignInsertDenied(client, tableCase, side, otherSide);
        await expectOrgReassignmentDenied(client, tableCase, side, otherSide, ownContext);

        if (tableCase.replaceFixtureBeforeInsert) {
          const removedFixture = await client.query(deleteRowSql(tableCase), ownKeys);
          assert(
            removedFixture.rowCount === 1,
            `${tableCase.table}: same-org DELETE control was unexpectedly denied`,
          );
        }

        const transientId = randomUUID();
        const transientContext = createContext(tableCase, side, transientId);
        const inserted = await client.query(
          tableCase.insertSql,
          tableCase.insertValues(transientContext),
        );
        assert(inserted.rowCount === 1, `${tableCase.table}: same-org INSERT was unexpectedly denied`);

        const updated = await client.query(
          `UPDATE ${tableCase.table} SET org_id = org_id WHERE ${keySql(tableCase)} RETURNING 1`,
          keyValues(tableCase, transientContext),
        );
        assert(updated.rowCount === 1, `${tableCase.table}: same-org UPDATE was unexpectedly denied`);

        const deleted = await client.query(deleteRowSql(tableCase), keyValues(tableCase, transientContext));
        assert(deleted.rowCount === 1, `${tableCase.table}: same-org DELETE was unexpectedly denied`);
      }
    }

    await client.query("ROLLBACK");
    transactionStarted = false;
  } catch (error) {
    if (transactionStarted) await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function verifyFixturesUnchanged(migratorPool) {
  for (const side of ["a", "b"]) {
    await inOrg(
      migratorPool,
      organizationIds[side],
      async (client) => {
        for (const tableCase of tableCases) {
          const id = fixtureIds[tableCase.table][side];
          const context = createContext(tableCase, side, id, true);
          const result = await client.query(selectRowSql(tableCase), keyValues(tableCase, context));
          assert(
            result.rowCount === 1,
            `${tableCase.table}: rollback did not preserve the org ${side} fixture row`,
          );
        }
      },
      true,
    );
  }
}

async function verifyTenantCaseCoverage(pool) {
  const rows = (
    await pool.query(`
      SELECT namespace.nspname AS schema_name,
             relation.relname AS table_name,
             relation.relrowsecurity AS rls_enabled,
             relation.relforcerowsecurity AS rls_forced,
             EXISTS (
               SELECT 1
                 FROM pg_attribute attribute
                WHERE attribute.attrelid = relation.oid
                  AND attribute.attname = 'org_id'
                  AND attribute.attnum > 0
                  AND NOT attribute.attisdropped
             ) AS has_org_id
        FROM pg_class relation
        JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
       WHERE relation.relkind IN ('r', 'p')
         AND namespace.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
         AND namespace.nspname NOT LIKE 'pg_temp_%'
         AND namespace.nspname NOT LIKE 'pg_toast_temp_%'
      ORDER BY namespace.nspname, relation.relname
    `)
  ).rows.filter((row) => row.has_org_id);
  const actual = new Set(rows.map((row) => `${row.schema_name}.${row.table_name}`));
  const expected = new Set(tableCases.map((tableCase) => tableCase.table));
  const missingCases = [...actual].filter((table) => !expected.has(table));
  const staleCases = [...expected].filter((table) => !actual.has(table));
  const duplicateCases = tableCases.length !== expected.size;
  const rlsFailures = rows
    .filter((row) => !row.rls_enabled || !row.rls_forced)
    .map((row) => `${row.schema_name}.${row.table_name}`);

  if (
    rows.length !== expectedTenantTableCount ||
    missingCases.length ||
    staleCases.length ||
    duplicateCases ||
    rlsFailures.length
  ) {
    throw new Error(
      [
        `Tenant-table coverage mismatch: database=${rows.length}, expected=${expectedTenantTableCount}, cases=${tableCases.length}.`,
        missingCases.length ? `Missing test cases: ${missingCases.join(", ")}.` : "",
        staleCases.length ? `Stale test cases: ${staleCases.join(", ")}.` : "",
        rlsFailures.length ? `RLS is not enabled and forced for: ${rlsFailures.join(", ")}.` : "",
      ]
        .filter(Boolean)
        .join(" "),
    );
  }
  console.log(`Tenant table inventory: all ${rows.length} tables have a write-test case and forced RLS.`);
}

async function main() {
  if (process.env.NODE_ENV === "production") {
    throw new Error("Refusing to run RLS write checks with NODE_ENV=production.");
  }
  validateUrl("DATABASE_URL", process.env.DATABASE_URL, "campus_app");
  validateUrl("MIGRATOR_DATABASE_URL", process.env.MIGRATOR_DATABASE_URL, "campus_migrator");

  const appPool = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 1,
    connectionTimeoutMillis: 5000,
    statement_timeout: 10000,
    query_timeout: 12000,
  });
  const migratorPool = new Pool({
    connectionString: process.env.MIGRATOR_DATABASE_URL,
    max: 1,
    connectionTimeoutMillis: 5000,
    statement_timeout: 10000,
    query_timeout: 12000,
  });

  try {
    const appIdentity = (
      await appPool.query(`
        SELECT current_database() AS database_name,
               current_user AS role_name,
               role.rolsuper AS is_superuser,
               role.rolbypassrls AS bypasses_rls
          FROM pg_roles role
         WHERE role.rolname = current_user
      `)
    ).rows[0];
    const migratorIdentity = (
      await migratorPool.query(`
        SELECT current_database() AS database_name,
               current_user AS role_name,
               role.rolsuper AS is_superuser,
               role.rolbypassrls AS bypasses_rls
          FROM pg_roles role
         WHERE role.rolname = current_user
      `)
    ).rows[0];

    if (
      appIdentity?.database_name !== expectedDatabase ||
      appIdentity?.role_name !== "campus_app" ||
      appIdentity?.is_superuser ||
      appIdentity?.bypasses_rls
    ) {
      throw new Error("Application connection is not the restricted campus_app role on the temporary database.");
    }
    if (
      migratorIdentity?.database_name !== expectedDatabase ||
      migratorIdentity?.role_name !== "campus_migrator" ||
      migratorIdentity?.is_superuser ||
      migratorIdentity?.bypasses_rls
    ) {
      throw new Error("Migration connection is not the non-superuser campus_migrator role on the temporary database.");
    }

    await verifyTenantCaseCoverage(appPool);

    fixtureIds = Object.fromEntries(
      tableCases.map((tableCase) => [
        tableCase.table,
        { a: randomUUID(), b: randomUUID() },
      ]),
    );

    await migratorPool.query(
      `
        INSERT INTO identity.organizations (id, name, slug)
        VALUES ($1, 'RLS fixture organization A', $2),
               ($3, 'RLS fixture organization B', $4)
      `,
      [organizationIds.a, `rls-a-${organizationIds.a}`, organizationIds.b, `rls-b-${organizationIds.b}`],
    );

    for (const side of ["a", "b"]) {
      await inOrg(migratorPool, organizationIds[side], async (client) => {
        for (const tableCase of tableCases) {
          const id = fixtureIds[tableCase.table][side];
          const context = createContext(tableCase, side, id, true);
          const result = await client.query(
            tableCase.insertSql,
            tableCase.insertValues(context),
          );
          if (result.rowCount !== 1) {
            throw new Error(`Could not create isolated fixture for ${tableCase.table}, org ${side}.`);
          }

          if (tableCase.table === "identity.users") {
            const auxiliaryUser = createContext(
              tableCase,
              side,
              auxiliaryIds.users[side],
            );
            await client.query(
              tableCase.insertSql,
              tableCase.insertValues(auxiliaryUser),
            );
          }
          if (tableCase.table === "live.sessions") {
            const auxiliarySession = createContext(
              tableCase,
              side,
              auxiliaryIds.sessions[side],
            );
            await client.query(
              tableCase.insertSql,
              tableCase.insertValues(auxiliarySession),
            );
          }
        }
      });
    }

    console.log(
      `Temporary database: migrations applied; two synthetic organizations, ${tableCases.length * 2} tenant fixtures, and 4 supporting rows created.`,
    );
    await runTenantWriteChecks(appPool);
    await verifyFixturesUnchanged(migratorPool);

    if (failures.length) {
      console.error("RLS write check failures:");
      for (const failure of failures) console.error(`- ${failure}`);
      process.exitCode = 1;
      return;
    }

    console.log(`PASS: all ${tableCases.length} tenant tables across identity, academic, board, learning, live, and school.`);
    console.log(
      "For both org contexts, cross-org SELECT returned 0 rows, UPDATE/DELETE changed 0 rows, and INSERT plus org reassignment were rejected by RLS.",
    );
    console.log("Same-org INSERT/UPDATE/DELETE controls succeeded inside a rolled-back transaction.");
    console.log("Fixture integrity confirmed after rollback; no shared database was used.");
  } finally {
    await Promise.all([appPool.end(), migratorPool.end()]);
  }
}

main().catch((error) => {
  console.error(`RLS write check failed: ${error.message}`);
  process.exitCode = 1;
});
