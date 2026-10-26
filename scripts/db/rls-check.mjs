import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const nonTenantAllowlist = new Set([
  "identity.organizations",
  "public.schema_migrations",
]);
const checkedActions = ["SELECT", "INSERT", "UPDATE", "DELETE"];
const failures = [];

function quoteIdentifier(identifier) {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function relationKey(schema, table) {
  return `${schema}.${table}`;
}

function fail(message) {
  failures.push(message);
}

function appliesToApp(policy, appRole) {
  const roles = Array.isArray(policy.roles) ? policy.roles : [];
  return roles.some((role) => {
    const normalized = String(role).toLowerCase();
    return normalized === "public" || normalized === appRole.toLowerCase();
  });
}

function hasOrgPredicate(expression) {
  if (typeof expression !== "string") return false;
  const references = expression.match(/current_setting\s*\(\s*'app\.org_id'/gi) ?? [];
  return (
    /\borg_id\s*=\s*.*current_setting\s*\(\s*'app\.org_id'/i.test(expression) &&
    references.length === 1 &&
    !/\bOR\b/i.test(expression)
  );
}

function policyCoversAction(policy, action) {
  if (policy.cmd !== "ALL" && policy.cmd !== action) return false;
  if (action === "INSERT") return hasOrgPredicate(policy.with_check);
  if (action === "UPDATE") {
    return hasOrgPredicate(policy.qual) && hasOrgPredicate(policy.with_check);
  }
  return hasOrgPredicate(policy.qual);
}

function listMigrationFiles(directory) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return listMigrationFiles(fullPath);
    return entry.isFile() && fullPath.split(path.sep).includes("migrations") && entry.name.endsWith(".sql")
      ? [fullPath]
      : [];
  });
}

function inspectRlsMarkers() {
  const migrationFiles = listMigrationFiles(path.join(root, "services"));
  const markers = [];
  const markerPattern = /^\s*--\s*@rls\s+([a-z_][a-z0-9_]*)\.([a-z_][a-z0-9_]*)\s*$/gim;

  for (const file of migrationFiles) {
    const content = readFileSync(file, "utf8");
    const matches = [...content.matchAll(markerPattern)];
    for (const [index, match] of matches.entries()) {
      const schema = match[1].toLowerCase();
      const table = match[2].toLowerCase();
      const blockEnd = matches[index + 1]?.index ?? content.length;
      const block = content.slice(match.index, blockEnd);
      const qualified = `(?:"?${schema}"?\\s*\\.\\s*"?${table}"?)`;
      const enable = new RegExp(
        `ALTER\\s+TABLE\\s+(?:ONLY\\s+)?${qualified}\\s+ENABLE\\s+ROW\\s+LEVEL\\s+SECURITY`,
        "i",
      );
      const force = new RegExp(
        `ALTER\\s+TABLE\\s+(?:ONLY\\s+)?${qualified}\\s+FORCE\\s+ROW\\s+LEVEL\\s+SECURITY`,
        "i",
      );
      const key = relationKey(schema, table);
      markers.push({ key, file });
      if (!enable.test(block)) fail(`${key}: @rls marker has no matching ENABLE ROW LEVEL SECURITY`);
      if (!force.test(block)) fail(`${key}: @rls marker has no matching FORCE ROW LEVEL SECURITY`);
    }
  }

  if (!migrationFiles.length) fail("No service migration files were found under services/*/migrations");
  return { markers, migrationFiles };
}

function verifyPolicies(table, policies, appRole) {
  const applicable = policies.filter((policy) => appliesToApp(policy, appRole));
  for (const action of checkedActions) {
    const permissive = applicable.filter(
      (policy) => policy.permissive === "PERMISSIVE" && (policy.cmd === "ALL" || policy.cmd === action),
    );
    if (!permissive.length) {
      fail(`${table}: no applicable permissive RLS policy covers ${action}`);
      continue;
    }
    if (permissive.some((policy) => !policyCoversAction(policy, action))) {
      fail(`${table}: an applicable permissive policy for ${action} is not org-scoped`);
    }
  }
}

async function main() {
  if (process.env.NODE_ENV === "production") {
    throw new Error("Refusing to run the RLS audit with NODE_ENV=production.");
  }
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is required; the audit will not use a fallback connection.");
  }

  let parsedUrl;
  try {
    parsedUrl = new URL(process.env.DATABASE_URL);
  } catch {
    throw new Error("DATABASE_URL is not a valid PostgreSQL URL.");
  }

  const localHosts = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
  const databaseName = decodeURIComponent(parsedUrl.pathname.replace(/^\/+/, ""));
  const databaseUser = decodeURIComponent(parsedUrl.username);
  if (!localHosts.has(parsedUrl.hostname) || databaseName !== "campus" || databaseUser !== "campus_app") {
    throw new Error("Refusing non-local audit target; use the local campus database with the campus_app role.");
  }

  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 1,
    connectionTimeoutMillis: 5000,
    statement_timeout: 10000,
    query_timeout: 12000,
  });

  try {
    const client = await pool.connect();
    try {
      const identity = (await client.query(`
        SELECT current_database() AS database_name,
               current_user AS app_role,
               role.rolsuper AS is_superuser,
               role.rolbypassrls AS bypasses_rls
          FROM pg_roles role
         WHERE role.rolname = current_user
      `)).rows[0];

      if (!identity || identity.database_name !== "campus" || identity.app_role !== "campus_app") {
        fail("Connected role/database did not match the expected local campus_app/campus target");
      }
      if (identity?.is_superuser || identity?.bypasses_rls) {
        fail("Connected role is superuser or has BYPASSRLS");
      }

      const tables = (await client.query(`
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
      `)).rows;

      const tenantTables = tables.filter((table) => table.has_org_id);
      const unexpectedUnscoped = tables
        .filter((table) => !table.has_org_id)
        .map((table) => relationKey(table.schema_name, table.table_name))
        .filter((key) => !nonTenantAllowlist.has(key));
      for (const key of unexpectedUnscoped) fail(`${key}: table lacks org_id and is not on the non-tenant allowlist`);

      for (const table of tenantTables) {
        const key = relationKey(table.schema_name, table.table_name);
        if (!table.rls_enabled) fail(`${key}: RLS is not enabled`);
        if (!table.rls_forced) fail(`${key}: RLS is not forced`);
      }

      const policies = (await client.query(`
        SELECT schemaname AS schema_name,
               tablename AS table_name,
               policyname AS policy_name,
               permissive,
               roles::text[] AS roles,
               cmd,
               qual,
               with_check
          FROM pg_policies
         ORDER BY schemaname, tablename, policyname
      `)).rows;
      for (const table of tenantTables) {
        const key = relationKey(table.schema_name, table.table_name);
        verifyPolicies(
          key,
          policies.filter((policy) => policy.schema_name === table.schema_name && policy.table_name === table.table_name),
          identity?.app_role ?? "campus_app",
        );
      }

      const migrationAudit = inspectRlsMarkers();
      const databaseTenantKeys = new Set(
        tenantTables.map((table) => relationKey(table.schema_name, table.table_name)),
      );
      const migrationTenantKeys = new Set(migrationAudit.markers.map((marker) => marker.key));
      for (const key of databaseTenantKeys) {
        if (!migrationTenantKeys.has(key)) fail(`${key}: tenant table has no -- @rls migration marker`);
      }
      for (const key of migrationTenantKeys) {
        if (!databaseTenantKeys.has(key)) fail(`${key}: migration marker does not match a tenant table in this database`);
      }

      const [organization] = (await client.query(
        "SELECT id FROM identity.organizations ORDER BY id LIMIT 1",
      )).rows;
      if (!organization) {
        fail("No local organization exists to exercise row visibility");
      } else {
        let foreignOrgId = crypto.randomUUID();
        while (foreignOrgId === organization.id) foreignOrgId = crypto.randomUUID();

        await client.query("BEGIN READ ONLY");
        try {
          let populated = 0;
          let empty = 0;
          for (const table of tenantTables) {
            const qualifiedName = `${quoteIdentifier(table.schema_name)}.${quoteIdentifier(table.table_name)}`;
            await client.query("SELECT set_config('app.org_id', $1, true)", [organization.id]);
            const ownCount = Number((await client.query(`SELECT count(*)::bigint AS count FROM ${qualifiedName}`)).rows[0].count);
            await client.query("SELECT set_config('app.org_id', $1, true)", [foreignOrgId]);
            const foreignCount = Number((await client.query(`SELECT count(*)::bigint AS count FROM ${qualifiedName}`)).rows[0].count);
            if (ownCount > 0) populated += 1;
            else empty += 1;
            if (foreignCount !== 0) {
              fail(`${relationKey(table.schema_name, table.table_name)}: ${foreignCount} row(s) visible under a foreign organization context`);
            }
          }
          console.log(`Read-only visibility checks: ${populated} populated tables, ${empty} empty tables; no foreign-context rows returned.`);
        } finally {
          await client.query("ROLLBACK");
        }
      }

      const tenantCount = tenantTables.length;
      const excluded = tables
        .filter((table) => !table.has_org_id)
        .map((table) => relationKey(table.schema_name, table.table_name));
      console.log(`Target: local database campus, role campus_app (superuser=${identity?.is_superuser ?? "unknown"}, BYPASSRLS=${identity?.bypasses_rls ?? "unknown"}).`);
      console.log(`Catalog: ${tables.length} application tables; ${tenantCount} tenant tables; ${excluded.length} non-tenant tables.`);
      console.log(`Migration metadata: scanned ${migrationAudit.migrationFiles.length} SQL migrations and ${migrationAudit.markers.length} -- @rls markers.`);
      console.log(`Explicit non-tenant tables: ${excluded.length ? excluded.join(", ") : "none"}.`);
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
  }

  if (failures.length) {
    console.error(`RLS audit FAILED with ${failures.length} issue(s):`);
    for (const failure of failures) console.error(`- ${failure}`);
    process.exitCode = 1;
    return;
  }

  console.log("RLS audit PASSED. No database writes were issued.");
}

main().catch((error) => {
  console.error(`RLS audit could not run: ${error instanceof Error ? error.message : "unknown error"}`);
  process.exitCode = 1;
});
