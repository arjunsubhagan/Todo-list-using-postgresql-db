import "server-only";

import { Pool, type PoolClient } from "pg";
import { migrateDatabase } from "./migrations";

type DatabaseGlobal = typeof globalThis & {
  __todoDatabase?: Promise<Pool>;
};

const globalForDatabase = globalThis as DatabaseGlobal;

function createDatabasePool(): Pool {
  const connectionString = process.env.DATABASE_URL?.trim();
  if (!connectionString) {
    throw new Error("DATABASE_URL must be configured before using the database.");
  }

  return new Pool({
    connectionString,
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 30000,
    max: 10,
  });
}

export async function getDatabase(): Promise<Pool> {
  if (!globalForDatabase.__todoDatabase) {
    const initialization = createDatabasePool();
    globalForDatabase.__todoDatabase = (async () => {
      try {
        await migrateDatabase(initialization);
        return initialization;
      } catch (error) {
        await initialization.end();
        throw error;
      }
    })();
  }

  try {
    return await globalForDatabase.__todoDatabase;
  } catch (error) {
    delete globalForDatabase.__todoDatabase;
    throw error;
  }
}

export async function closeDatabase(): Promise<void> {
  const database = globalForDatabase.__todoDatabase;
  delete globalForDatabase.__todoDatabase;
  if (database) {
    await (await database).end();
  }
}

export async function withTransaction<T>(
  database: Pool,
  operation: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await database.connect();
  try {
    await client.query("BEGIN");
    const result = await operation(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
