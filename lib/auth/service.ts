import "server-only";

import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { withTransaction } from "@/lib/db";
import {
  burnPasswordVerificationTime,
  hashPassword,
  verifyPassword,
} from "@/lib/auth/password";
import type { LoginInput, RegistrationInput } from "@/lib/auth/validation";

export const SESSION_LIFETIME_MS = 20 * 60 * 1000;
export const SESSION_RENEWAL_INTERVAL_MS = 30 * 1000;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_LOCK_MS = 15 * 60 * 1000;
const MAX_LOGIN_FAILURES = 5;

export type PublicUser = {
  id: string;
  name: string;
  email: string;
};

export type Session = {
  id: string;
  familyId: string;
  userId: string;
  token: string;
  createdAt: string;
  expiresAt: string;
};

export type AuthenticatedSession = {
  user: PublicUser;
  session: Omit<Session, "token">;
};

type UserRow = PublicUser & {
  password_hash: string;
};

export type SessionInput = Pick<Session, "token">;

export class DuplicateEmailError extends Error {
  constructor() {
    super("A user with this email already exists.");
    this.name = "DuplicateEmailError";
  }
}

export class LoginRateLimitError extends Error {
  constructor() {
    super("Too many login attempts.");
    this.name = "LoginRateLimitError";
  }
}

export class InvalidCredentialsError extends Error {
  constructor() {
    super("Invalid credentials.");
    this.name = "InvalidCredentialsError";
  }
}

export class InvalidSessionError extends Error {
  constructor() {
    super("The session is invalid.");
    this.name = "InvalidSessionError";
  }
}

export class ExpiredSessionError extends Error {
  constructor() {
    super("The session has expired.");
    this.name = "ExpiredSessionError";
  }
}

export class SessionRotationConflictError extends Error {
  constructor() {
    super("The session credential has already been rotated.");
    this.name = "SessionRotationConflictError";
  }
}

export class SessionRenewalNotDueError extends Error {
  readonly nextRenewalAt: string;

  constructor(nextRenewalAt: string) {
    super("The session credential is not due for renewal yet.");
    this.name = "SessionRenewalNotDueError";
    this.nextRenewalAt = nextRenewalAt;
  }
}

function nowIso(now: Date): string {
  return now.toISOString();
}

function sessionTokenHash(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function loginEmailKey(email: string): string {
  return createHash("sha256").update(email, "utf8").digest("hex");
}

function publicUserFromRow(user: UserRow): PublicUser {
  return { id: user.id, name: user.name, email: user.email };
}

function isEmailUniqueConstraint(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "23505" &&
    "constraint" in error &&
    error.constraint === "users_email_unique_idx"
  );
}

async function createSession(
  database: PoolClient,
  userId: string,
  now: Date,
): Promise<Session> {
  const session: Session = {
    id: randomUUID(),
    familyId: randomUUID(),
    userId,
    token: randomBytes(32).toString("base64url"),
    createdAt: nowIso(now),
    expiresAt: new Date(now.getTime() + SESSION_LIFETIME_MS).toISOString(),
  };

  await database.query(
    `INSERT INTO sessions
      (id, family_id, user_id, token_hash, created_at, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      session.id,
      session.familyId,
      session.userId,
      sessionTokenHash(session.token),
      session.createdAt,
      session.expiresAt,
    ],
  );

  return session;
}

export async function registerUser(
  database: Pool,
  input: RegistrationInput,
  now = new Date(),
): Promise<PublicUser> {
  const user: PublicUser = {
    id: randomUUID(),
    name: input.name.trim(),
    email: input.email.trim().toLowerCase(),
  };
  const passwordHash = await hashPassword(input.password);
  const timestamp = nowIso(now);

  try {
    await database.query(
      `INSERT INTO users (id, name, email, password_hash, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        user.id,
        user.name,
        user.email,
        passwordHash,
        timestamp,
        timestamp,
      ],
    );
  } catch (error) {
    if (isEmailUniqueConstraint(error)) {
      throw new DuplicateEmailError();
    }

    throw error;
  }

  return user;
}

async function getLoginLock(
  database: Pool,
  emailKey: string,
  now: Date,
): Promise<string | null> {
  return withTransaction(database, async (client) => {
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtext($1)::bigint)",
      [emailKey],
    );
    const { rows } = await client.query<{
      failures: number;
      window_started_at: string;
      locked_until: string | null;
    }>(
      `SELECT failures, window_started_at, locked_until
       FROM auth_login_attempts
       WHERE email_key = $1`,
      [emailKey],
    );
    const row = rows[0];

    if (!row) {
      return null;
    }

    if (row.locked_until && Date.parse(row.locked_until) > now.getTime()) {
      return row.locked_until;
    }

    if (now.getTime() - Date.parse(row.window_started_at) >= LOGIN_WINDOW_MS) {
      await client.query(
        "DELETE FROM auth_login_attempts WHERE email_key = $1",
        [emailKey],
      );
    }

    return null;
  });
}

async function recordLoginFailure(
  database: Pool,
  emailKey: string,
  now: Date,
): Promise<string | null> {
  const timestamp = nowIso(now);
  return withTransaction(database, async (client) => {
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtext($1)::bigint)",
      [emailKey],
    );
    const { rows } = await client.query<{
      failures: number;
      window_started_at: string;
    }>(
      `SELECT failures, window_started_at
       FROM auth_login_attempts
       WHERE email_key = $1
       FOR UPDATE`,
      [emailKey],
    );
    const row = rows[0];

    const windowExpired =
      row && now.getTime() - Date.parse(row.window_started_at) >= LOGIN_WINDOW_MS;
    const failures = row && !windowExpired ? row.failures + 1 : 1;
    const windowStartedAt =
      row && !windowExpired ? row.window_started_at : timestamp;
    const lockedUntil =
      failures >= MAX_LOGIN_FAILURES
        ? new Date(now.getTime() + LOGIN_LOCK_MS).toISOString()
        : null;

    await client.query(
      `INSERT INTO auth_login_attempts
        (email_key, failures, window_started_at, locked_until)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT(email_key) DO UPDATE SET
         failures = EXCLUDED.failures,
         window_started_at = EXCLUDED.window_started_at,
         locked_until = EXCLUDED.locked_until`,
      [emailKey, failures, windowStartedAt, lockedUntil],
    );

    return lockedUntil;
  });
}

async function clearLoginFailures(
  database: PoolClient,
  emailKey: string,
): Promise<void> {
  await database.query(
    "SELECT pg_advisory_xact_lock(hashtext($1)::bigint)",
    [emailKey],
  );
  await database.query(
    "DELETE FROM auth_login_attempts WHERE email_key = $1",
    [emailKey],
  );
}

export async function loginUser(
  database: Pool,
  input: LoginInput,
  now = new Date(),
): Promise<{ user: PublicUser; session: Session }> {
  const email = input.email.trim().toLowerCase();
  const emailKey = loginEmailKey(email);
  const lock = await getLoginLock(database, emailKey, now);

  if (lock) {
    throw new LoginRateLimitError();
  }

  const { rows } = await database.query<UserRow>(
    `SELECT id, name, email, password_hash
     FROM users
     WHERE LOWER(email) = LOWER($1)`,
    [email],
  );
  const user = rows[0];

  const passwordMatches = user
    ? await verifyPassword(user.password_hash, input.password)
    : (await burnPasswordVerificationTime(input.password), false);

  if (!user || !passwordMatches) {
    const lockedUntil = await recordLoginFailure(database, emailKey, now);
    if (lockedUntil) {
      throw new LoginRateLimitError();
    }
    throw new InvalidCredentialsError();
  }

  const session = await withTransaction(database, async (client) => {
    await clearLoginFailures(client, emailKey);
    return createSession(client, user.id, now);
  });

  return { user: publicUserFromRow(user), session };
}

export async function getValidSession(
  database: Pool,
  token: string,
  now = new Date(),
): Promise<AuthenticatedSession | null> {
  const { rows } = await database.query<
    PublicUser & {
      session_id: string;
      family_id: string;
      user_id: string;
      session_created_at: string;
      expires_at: string;
    }
  >(
    `SELECT
       sessions.id AS session_id,
       sessions.family_id,
       sessions.user_id,
       sessions.created_at AS session_created_at,
       sessions.expires_at,
       users.id,
       users.name,
       users.email
     FROM sessions
     JOIN users ON users.id = sessions.user_id
     WHERE sessions.token_hash = $1
       AND sessions.revoked_at IS NULL`,
    [sessionTokenHash(token)],
  );
  const row = rows[0];

  if (!row) {
    return null;
  }

  if (Date.parse(row.expires_at) <= now.getTime()) {
    await database.query(
      `UPDATE sessions
       SET revoked_at = $1
       WHERE family_id = $2 AND revoked_at IS NULL`,
      [nowIso(now), row.family_id],
    );
    return null;
  }

  return {
    user: { id: row.id, name: row.name, email: row.email },
    session: {
      id: row.session_id,
      familyId: row.family_id,
      userId: row.user_id,
      createdAt: row.session_created_at,
      expiresAt: row.expires_at,
    },
  };
}

export async function isRotatedSessionCredential(
  database: Pool,
  token: string,
  now = new Date(),
): Promise<boolean> {
  const { rows } = await database.query(
    `SELECT 1
     FROM sessions AS previous
     WHERE previous.token_hash = $1
       AND previous.replaced_by_id IS NOT NULL
       AND EXISTS (
         SELECT 1
         FROM sessions AS current
         WHERE current.family_id = previous.family_id
           AND current.revoked_at IS NULL
           AND current.expires_at > $2
       )`,
    [sessionTokenHash(token), nowIso(now)],
  );

  return rows.length > 0;
}

export async function rotateSession(
  database: Pool,
  token: string,
  now = new Date(),
): Promise<{ user: PublicUser; session: Session; rotation: number }> {
  const timestamp = nowIso(now);
  const replacement: Session = {
    id: randomUUID(),
    familyId: "",
    userId: "",
    token: randomBytes(32).toString("base64url"),
    createdAt: timestamp,
    expiresAt: "",
  };
  const result = await withTransaction(database, async (client) => {
    const { rows } = await client.query<
      PublicUser & {
        session_id: string;
        family_id: string;
        user_id: string;
        credential_created_at: string;
        expires_at: string;
        revoked_at: string | null;
        replaced_by_id: string | null;
        rotation: number;
      }
    >(
      `SELECT
         sessions.id AS session_id,
         sessions.family_id,
         sessions.user_id,
         sessions.token_hash,
         sessions.created_at AS credential_created_at,
         sessions.expires_at,
         sessions.revoked_at,
         sessions.replaced_by_id,
         sessions.rotation,
         users.id,
         users.name,
         users.email
       FROM sessions
       JOIN users ON users.id = sessions.user_id
       WHERE sessions.token_hash = $1
       FOR UPDATE OF sessions`,
      [sessionTokenHash(token)],
    );
    const row = rows[0];

    if (!row) {
      return { outcome: "invalid" as const };
    }
    if (row.revoked_at) {
      return {
        outcome: row.replaced_by_id
          ? ("rotated" as const)
          : ("invalid" as const),
      };
    }
    if (Date.parse(row.expires_at) <= now.getTime()) {
      await client.query(
        `UPDATE sessions
         SET revoked_at = $1
         WHERE family_id = $2 AND revoked_at IS NULL`,
        [timestamp, row.family_id],
      );
      return { outcome: "expired" as const };
    }

    const nextRenewalAt = new Date(
      Date.parse(row.credential_created_at) + SESSION_RENEWAL_INTERVAL_MS,
    ).toISOString();
    if (now.getTime() < Date.parse(nextRenewalAt)) {
      return { outcome: "not_due" as const, nextRenewalAt };
    }

    replacement.familyId = row.family_id;
    replacement.userId = row.user_id;
    replacement.expiresAt = row.expires_at;

    await client.query(
      `INSERT INTO sessions
        (id, family_id, user_id, token_hash, created_at, expires_at, revoked_at, rotation)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        replacement.id,
        replacement.familyId,
        replacement.userId,
        sessionTokenHash(replacement.token),
        replacement.createdAt,
        replacement.expiresAt,
        timestamp,
        row.rotation + 1,
      ],
    );

    const revoked = await client.query(
      `UPDATE sessions
       SET revoked_at = $1, replaced_by_id = $2
       WHERE id = $3 AND token_hash = $4 AND revoked_at IS NULL
         AND expires_at > $5`,
      [
        timestamp,
        replacement.id,
        row.session_id,
        sessionTokenHash(token),
        timestamp,
      ],
    );
    if (revoked.rowCount !== 1) {
      return { outcome: "rotated" as const };
    }

    await client.query(
      `UPDATE sessions
       SET revoked_at = NULL
       WHERE id = $1 AND family_id = $2 AND revoked_at = $3`,
      [replacement.id, replacement.familyId, timestamp],
    );

    return {
      outcome: "rotated_successfully" as const,
      user: { id: row.id, name: row.name, email: row.email },
      nextRenewalAt: new Date(
        now.getTime() + SESSION_RENEWAL_INTERVAL_MS,
      ).toISOString(),
      rotation: row.rotation + 1,
    };
  });

  if (result.outcome === "invalid") {
    throw new InvalidSessionError();
  }
  if (result.outcome === "expired") {
    throw new ExpiredSessionError();
  }
  if (result.outcome === "rotated") {
    throw new SessionRotationConflictError();
  }
  if (result.outcome === "not_due") {
    throw new SessionRenewalNotDueError(result.nextRenewalAt);
  }
  if (result.outcome !== "rotated_successfully") {
    throw new Error("Session rotation ended in an unsupported state.");
  }

  return {
    user: result.user,
    session: replacement,
    rotation: result.rotation,
  };
}

export async function revokeSession(
  database: Pool,
  token: string,
  now = new Date(),
): Promise<void> {
  const timestamp = nowIso(now);
  await withTransaction(database, async (client) => {
    const { rows } = await client.query<{ family_id: string }>(
      `SELECT family_id
       FROM sessions
       WHERE token_hash = $1`,
      [sessionTokenHash(token)],
    );
    const row = rows[0];

    if (row) {
      await client.query(
        `UPDATE sessions
         SET revoked_at = $1
         WHERE family_id = $2 AND revoked_at IS NULL`,
        [timestamp, row.family_id],
      );
    }
  });
}

export function getSessionTokenHash(token: string): string {
  return sessionTokenHash(token);
}
