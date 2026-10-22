import { loadEnvConfig } from "@next/env";
import { closeDatabase, getDatabase } from "../lib/db";

loadEnvConfig(process.cwd());

async function initialize(): Promise<void> {
  const database = await getDatabase();
  try {
    const { rows } = await database.query<{ version: number }>(
      "SELECT MAX(version) AS version FROM schema_migrations",
    );
    console.info(
      `PostgreSQL database initialized at schema version ${rows[0].version}.`,
    );
  } finally {
    await closeDatabase();
  }
}

initialize().catch((error: unknown) => {
  console.error(
    "PostgreSQL database initialization failed:",
    error instanceof Error ? error.message : "Unknown error.",
  );
  process.exitCode = 1;
});
