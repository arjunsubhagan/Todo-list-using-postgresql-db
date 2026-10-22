import "server-only";

import type { Pool } from "pg";

const MIGRATIONS = [
  {
    version: 1,
    name: "users_tasks_sessions",
    sql: `
      CREATE TABLE users (
        id TEXT PRIMARY KEY NOT NULL,
        name TEXT NOT NULL
          CHECK (name = BTRIM(name) AND CHAR_LENGTH(name) BETWEEN 1 AND 80),
        email TEXT NOT NULL
          CHECK (
            email = BTRIM(email)
            AND email = LOWER(email)
            AND CHAR_LENGTH(email) <= 254
          ),
        password_hash TEXT NOT NULL CHECK (CHAR_LENGTH(password_hash) > 0),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE UNIQUE INDEX users_email_unique_idx ON users (LOWER(email));

      CREATE TABLE tasks (
        id TEXT PRIMARY KEY NOT NULL,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        title TEXT NOT NULL
          CHECK (title = BTRIM(title) AND CHAR_LENGTH(title) BETWEEN 1 AND 200),
        description TEXT CHECK (
          description IS NULL OR CHAR_LENGTH(description) <= 5000
        ),
        due_date TEXT CHECK (
          due_date IS NULL OR due_date ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
        ),
        due_time TEXT CHECK (
          due_time IS NULL OR due_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
        ),
        priority TEXT NOT NULL DEFAULT 'medium'
          CHECK (priority IN ('low', 'medium', 'high')),
        status TEXT NOT NULL DEFAULT 'pending'
          CHECK (status IN ('pending', 'in_progress', 'completed')),
        category TEXT CHECK (
          category IS NULL OR (
            category = BTRIM(category) AND CHAR_LENGTH(category) <= 80
          )
        ),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT,
        CHECK (due_time IS NULL OR due_date IS NOT NULL),
        CHECK (
          (status = 'completed' AND completed_at IS NOT NULL)
          OR (status <> 'completed' AND completed_at IS NULL)
        )
      );

      CREATE INDEX tasks_user_idx ON tasks (user_id);
      CREATE INDEX tasks_user_due_date_idx ON tasks (user_id, due_date);
      CREATE INDEX tasks_user_status_idx ON tasks (user_id, status);
      CREATE INDEX tasks_user_priority_idx ON tasks (user_id, priority);
      CREATE INDEX tasks_user_category_idx ON tasks (user_id, category);
      CREATE INDEX tasks_user_created_at_idx ON tasks (user_id, created_at);
      CREATE INDEX tasks_user_title_idx ON tasks (user_id, LOWER(title));

      CREATE TABLE sessions (
        id TEXT PRIMARY KEY NOT NULL,
        family_id TEXT NOT NULL,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        token_hash TEXT NOT NULL UNIQUE CHECK (CHAR_LENGTH(token_hash) > 0),
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        revoked_at TEXT,
        replaced_by_id TEXT REFERENCES sessions(id) ON DELETE SET NULL
          DEFERRABLE INITIALLY DEFERRED,
        rotation INTEGER NOT NULL DEFAULT 0 CHECK (rotation >= 0),
        CHECK (expires_at > created_at),
        CHECK (revoked_at IS NULL OR revoked_at >= created_at),
        CHECK (replaced_by_id IS NULL OR replaced_by_id <> id)
      );

      CREATE INDEX sessions_user_idx ON sessions (user_id);
      CREATE INDEX sessions_family_idx ON sessions (family_id);
      CREATE INDEX sessions_expiry_idx ON sessions (expires_at);
      CREATE UNIQUE INDEX sessions_one_active_per_family_idx
        ON sessions (family_id)
        WHERE revoked_at IS NULL;

      CREATE FUNCTION prevent_session_expiry_change()
      RETURNS TRIGGER
      LANGUAGE plpgsql
      AS $$
      BEGIN
        IF NEW.expires_at IS DISTINCT FROM OLD.expires_at THEN
          RAISE EXCEPTION 'session expiry is immutable'
            USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
      END;
      $$;

      CREATE TRIGGER sessions_expiry_immutable
        BEFORE UPDATE OF expires_at ON sessions
        FOR EACH ROW
        EXECUTE FUNCTION prevent_session_expiry_change();
    `,
  },
  {
    version: 2,
    name: "auth_login_attempts",
    sql: `
      CREATE TABLE auth_login_attempts (
        email_key TEXT PRIMARY KEY NOT NULL,
        failures INTEGER NOT NULL CHECK (failures > 0),
        window_started_at TEXT NOT NULL,
        locked_until TEXT
      );

      CREATE INDEX auth_login_attempts_lock_idx
        ON auth_login_attempts (locked_until);
    `,
  },
] as const;

export async function migrateDatabase(pool: Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtext('todo-app-schema-migrations')::bigint)",
    );
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    const { rows: appliedRows } = await client.query<{
      version: number;
      name: string;
    }>(
      "SELECT version, name FROM schema_migrations ORDER BY version",
    );
    const applied = new Set(appliedRows.map(({ version }) => version));
    const latestVersion = MIGRATIONS[MIGRATIONS.length - 1].version;
    const futureVersion = appliedRows.find(
      ({ version }) => version > latestVersion,
    );
    if (futureVersion) {
      throw new Error(
        `Database schema version ${futureVersion.version} is newer than this application supports.`,
      );
    }
    for (const [index, migration] of appliedRows.entries()) {
      const expected = MIGRATIONS[index];
      if (
        !expected ||
        migration.version !== expected.version ||
        migration.name !== expected.name
      ) {
        throw new Error(
          "Database migration history is incomplete or does not match this application.",
        );
      }
    }

    if (applied.size === 0) {
      const { rows: existingTables } = await client.query<{ table_name: string }>(
        `SELECT table_name
         FROM information_schema.tables
         WHERE table_schema = current_schema()
           AND table_name = ANY($1::text[])`,
        [["users", "tasks", "sessions", "auth_login_attempts"]],
      );
      if (existingTables.length > 0) {
        throw new Error(
          "Application tables already exist without migration history; no schema changes were applied.",
        );
      }
    }

    for (const migration of MIGRATIONS) {
      if (applied.has(migration.version)) {
        continue;
      }
      await client.query(migration.sql);
      await client.query(
        "INSERT INTO schema_migrations (version, name) VALUES ($1, $2)",
        [migration.version, migration.name],
      );
    }

    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
