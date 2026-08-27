import { applyD1Migrations, type D1Migration } from "cloudflare:test";

export async function applyControlMigrations(
  database: D1Database,
  migrations: readonly D1Migration[],
) {
  if (migrations.length === 0) {
    throw new TypeError("Control Worker tests require at least one D1 migration");
  }
  await applyD1Migrations(database, [...migrations], "control_d1_migrations");
}
