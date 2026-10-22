import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { loadEnvConfig } from "@next/env";
import { migrateDatabase } from "@/lib/db/migrations";

loadEnvConfig(process.cwd());

export async function createTestDatabase(): Promise<{
  database: Pool;
  close: () => Promise<void>;
}> {
  const connectionString = process.env.DATABASE_URL?.trim();
  if (!connectionString) {
    throw new Error(
      "DATABASE_URL must point to a local PostgreSQL database to run database integration tests.",
    );
  }

  const schema = `todo_test_${randomUUID().replaceAll("-", "")}`;
  const admin = new Pool({ connectionString, max: 1 });
  const escapedSchema = `"${schema}"`;
  try {
    await admin.query(`CREATE SCHEMA ${escapedSchema}`);
  } catch (error) {
    await admin.end();
    throw error;
  }

  const database = new Pool({
    connectionString,
    max: 4,
    options: `-c search_path=${schema}`,
  });

  try {
    await migrateDatabase(database);
  } catch (error) {
    try {
      await database.end();
    } finally {
      try {
        await admin.query(`DROP SCHEMA ${escapedSchema} CASCADE`);
      } finally {
        await admin.end();
      }
    }
    throw error;
  }

  return {
    database,
    close: async () => {
      try {
        await database.end();
      } finally {
        try {
          await admin.query(`DROP SCHEMA ${escapedSchema} CASCADE`);
        } finally {
          await admin.end();
        }
      }
    },
  };
}
