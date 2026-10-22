import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { vi } from "vitest";
import type { Pool } from "pg";
import { migrateDatabase } from "@/lib/db/migrations";
import { createTestDatabase } from "../database";
import {
  getValidSession,
  loginUser,
  registerUser,
  SESSION_LIFETIME_MS,
} from "@/lib/auth/service";
import { loginSchema, registrationSchema } from "@/lib/auth/validation";
import {
  loginHandler,
  logoutHandler,
  registerHandler,
  renewHandler,
  sessionHandler,
  SESSION_COOKIE,
  isSameOrigin,
} from "@/lib/auth/http";

const PASSWORD = "correct horse battery staple";
const BASE_TIME = new Date("2026-10-15T08:00:00.000Z");
const APP_ORIGIN = "http://localhost:3000";

describe("authentication and server-managed sessions", () => {
  let database: Pool;
  let closeTestDatabase: (() => Promise<void>) | undefined;

  beforeEach(async () => {
    const testDatabase = await createTestDatabase();
    database = testDatabase.database;
    closeTestDatabase = testDatabase.close;
  });

  afterEach(async () => {
    await closeTestDatabase?.();
    closeTestDatabase = undefined;
  });

  function request(
    route: string,
    method: string,
    body?: unknown,
    cookie?: string,
  ): Request {
    const headers = new Headers({ Origin: APP_ORIGIN });
    if (body !== undefined) {
      headers.set("Content-Type", "application/json");
    }
    if (cookie) {
      headers.set("Cookie", cookie);
    }

    return new Request(`${APP_ORIGIN}${route}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }

  async function createUser(
    email: string,
    name = "Test User",
  ): Promise<{ id: string; name: string; email: string }> {
    const input = registrationSchema.parse({
      name,
      email,
      password: PASSWORD,
      confirmPassword: PASSWORD,
    });
    return registerUser(database, input, BASE_TIME);
  }

  function getCookie(response: Response): string {
    const setCookie = response.headers.getSetCookie().find((value) =>
      value.startsWith(`${SESSION_COOKIE}=`),
    );
    expect(setCookie).toBeDefined();
    return setCookie!.split(";")[0].slice(SESSION_COOKIE.length + 1);
  }

  it("registers with a normalized email and stores only an Argon2id hash", async () => {
    const response = await registerHandler(
      request("/api/auth/register", "POST", {
        name: "  Ada Lovelace ",
        email: " ADA@Example.COM ",
        password: PASSWORD,
        confirmPassword: PASSWORD,
      }),
      database,
    );

    expect(response.status).toBe(201);
    const payload = await response.json();
    expect(payload.data.user).toMatchObject({
      name: "Ada Lovelace",
      email: "ada@example.com",
    });
    expect(payload.data.user).not.toHaveProperty("password");
    expect(payload.data.user).not.toHaveProperty("password_hash");

    const { rows: storedRows } = await database.query<{
      email: string;
      password_hash: string;
    }>(
      "SELECT email, password_hash FROM users WHERE id = $1",
      [payload.data.user.id],
    );
    const stored = storedRows[0];
    expect(stored.email).toBe("ada@example.com");
    expect(stored.password_hash).toMatch(/^\$argon2id\$/);
    expect(stored.password_hash).not.toBe(PASSWORD);
    expect(
      Number((await database.query("SELECT COUNT(*) AS count FROM sessions")).rows[0].count),
    ).toBe(0);
  });

  it("rejects duplicate normalized email addresses", async () => {
    await createUser("ada@example.com");

    const response = await registerHandler(
      request("/api/auth/register", "POST", {
        name: "Another User",
        email: " ADA@EXAMPLE.COM ",
        password: PASSWORD,
        confirmPassword: PASSWORD,
      }),
      database,
    );

    expect(response.status).toBe(409);
    expect((await response.json()).error.code).toBe("EMAIL_ALREADY_REGISTERED");
    expect(
      Number((await database.query("SELECT COUNT(*) AS count FROM users")).rows[0].count),
    ).toBe(1);
  });

  it("validates registration and login fields on the server", async () => {
    const registration = await registerHandler(
      request("/api/auth/register", "POST", {
        name: " ",
        email: "not-an-email",
        password: "short",
        confirmPassword: "different",
      }),
      database,
    );
    expect(registration.status).toBe(400);
    expect((await registration.json()).error.fields).toMatchObject({
      name: expect.any(String),
      email: expect.any(String),
      password: expect.any(String),
      confirmPassword: expect.any(String),
    });

    const login = await loginHandler(
      request("/api/auth/login", "POST", { email: "bad", password: "" }),
      database,
    );
    expect(login.status).toBe(400);
    expect(
      loginSchema.safeParse({ email: "BAD@example.test", password: "x" }).success,
    ).toBe(true);
    expect(loginSchema.safeParse({ email: "BAD", password: "" }).success).toBe(
      false,
    );
  });

  it("rejects cross-origin state-changing requests", async () => {
    const response = await registerHandler(
      new Request(`${APP_ORIGIN}/api/auth/register`, {
        method: "POST",
        headers: { Origin: "https://attacker.example" },
        body: JSON.stringify({
          name: "Test",
          email: "test@example.com",
          password: PASSWORD,
          confirmPassword: PASSWORD,
        }),
      }),
      database,
    );

    expect(response.status).toBe(403);
    expect(
      Number((await database.query("SELECT COUNT(*) AS count FROM users")).rows[0].count),
    ).toBe(0);
  });

  it("validates the browser Host origin when Next.js normalizes the request URL", () => {
    const normalizedRequest = new Request(
      "http://localhost:3000/api/auth/register",
      {
        method: "POST",
        headers: {
          Origin: "http://127.0.0.1:3000",
          Host: "127.0.0.1:3000",
        },
      },
    );
    expect(isSameOrigin(normalizedRequest)).toBe(true);
    const wrongHost = new Request(
      "http://localhost:3000/api/auth/register",
      {
        method: "POST",
        headers: {
          Origin: "http://attacker.example",
          Host: "127.0.0.1:3000",
        },
      },
    );
    expect(isSameOrigin(wrongHost)).toBe(false);
  });

  it("logs in with a generic invalid-credentials response", async () => {
    await createUser("ada@example.com");

    const wrongPassword = await loginHandler(
      request("/api/auth/login", "POST", {
        email: "ada@example.com",
        password: "incorrect password",
      }),
      database,
    );
    const unknownAccount = await loginHandler(
      request("/api/auth/login", "POST", {
        email: "missing@example.com",
        password: "incorrect password",
      }),
      database,
    );

    expect(wrongPassword.status).toBe(401);
    expect(unknownAccount.status).toBe(401);
    expect((await wrongPassword.json()).error).toEqual(
      (await unknownAccount.json()).error,
    );
    expect(wrongPassword.headers.get("set-cookie")).toBeNull();
  });

  it("sets an HTTP-only cookie and resolves each session to its own user", async () => {
    const firstUser = await createUser("first@example.com", "First User");
    const secondUser = await createUser("second@example.com", "Second User");

    const firstLogin = await loginHandler(
      request("/api/auth/login", "POST", {
        email: " FIRST@example.com ",
        password: PASSWORD,
      }),
      database,
    );
    const secondLogin = await loginHandler(
      request("/api/auth/login", "POST", {
        email: "second@example.com",
        password: PASSWORD,
      }),
      database,
    );
    expect(firstLogin.status).toBe(200);
    expect(secondLogin.status).toBe(200);

    const firstCookie = getCookie(firstLogin);
    const firstSetCookie = firstLogin.headers
      .getSetCookie()
      .find((value) => value.startsWith(`${SESSION_COOKIE}=`))!;
    expect(firstSetCookie).toMatch(/HttpOnly/i);
    expect(firstSetCookie).toMatch(/SameSite=Lax/i);
    expect(firstSetCookie).toMatch(/Path=\//i);
    expect(firstSetCookie).not.toMatch(/Secure/i);
    const { rows: storedSessions } = await database.query<{ token_hash: string }>(
      "SELECT token_hash FROM sessions WHERE user_id = $1",
      [firstUser.id],
    );
    const storedSession = storedSessions[0];
    expect(storedSession.token_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(storedSession.token_hash).not.toBe(firstCookie);

    const firstPayload = await firstLogin.json();
    expect(firstPayload.data.user.id).toBe(firstUser.id);
    expect(firstPayload.data).not.toHaveProperty("token");
    expect(firstPayload.data).not.toHaveProperty("session");
    expect(firstPayload.data.lifetimeSeconds).toBe(1200);

    const firstSessionResponse = await sessionHandler(
      request("/api/auth/session", "GET", undefined, `${SESSION_COOKIE}=${firstCookie}`),
      database,
    );
    const secondCookie = getCookie(secondLogin);
    const secondSessionResponse = await sessionHandler(
      request(
        "/api/auth/session",
        "GET",
        undefined,
        `${SESSION_COOKIE}=${secondCookie}`,
      ),
      database,
    );
    expect((await firstSessionResponse.json()).data.user.id).toBe(firstUser.id);
    expect((await secondSessionResponse.json()).data.user.id).toBe(
      secondUser.id,
    );
  });

  it("enforces the absolute 20-minute expiry and revokes an expired session", async () => {
    const user = await createUser("expiry@example.com");
    const result = await loginUser(
      database,
      loginSchema.parse({ email: user.email, password: PASSWORD }),
      BASE_TIME,
    );
    const expiresAt = new Date(BASE_TIME.getTime() + SESSION_LIFETIME_MS);

    expect(
      (await getValidSession(
        database,
        result.session.token,
        new Date(expiresAt.getTime() - 1),
      ))?.user.id,
    ).toBe(user.id);
    expect(
      await getValidSession(database, result.session.token, expiresAt),
    ).toBeNull();
    const { rows: expiredRows } = await database.query<{ revoked_at: string }>(
      "SELECT revoked_at FROM sessions WHERE id = $1",
      [result.session.id],
    );
    expect(expiredRows[0]).toMatchObject({
      revoked_at: expiresAt.toISOString(),
    });
    expect(
      await getValidSession(database, result.session.token, BASE_TIME),
    ).toBeNull();
  });

  it("rotates credentials every 30 seconds without extending the absolute 20-minute deadline", async () => {
    const originalTime = new Date();
    vi.setSystemTime(BASE_TIME);
    try {
      const user = await createUser("rotation@example.com");
      const login = await loginHandler(
        request("/api/auth/login", "POST", {
          email: user.email,
          password: PASSWORD,
        }),
        database,
      );
      const firstToken = getCookie(login);
      const initial = await login.json();
      const absoluteExpiry = initial.data.expiresAt;
      expect(absoluteExpiry).toBe(
        new Date(BASE_TIME.getTime() + SESSION_LIFETIME_MS).toISOString(),
      );

      const tooEarly = await renewHandler(
        request(
          "/api/auth/renew",
          "POST",
          undefined,
          `${SESSION_COOKIE}=${firstToken}`,
        ),
        database,
        new Date(BASE_TIME.getTime() + 29_999),
      );
      expect(tooEarly.status).toBe(409);
      expect((await tooEarly.json()).error.code).toBe(
        "SESSION_RENEWAL_NOT_DUE",
      );
      expect(tooEarly.headers.get("set-cookie")).toBeNull();

      const renewalTime = new Date(
        BASE_TIME.getTime() + 30_000,
      );
      const firstRenewal = await renewHandler(
        request(
          "/api/auth/renew",
          "POST",
          undefined,
          `${SESSION_COOKIE}=${firstToken}`,
        ),
        database,
        renewalTime,
      );
      expect(firstRenewal.status).toBe(200);
      const firstRenewalToken = getCookie(firstRenewal);
      const firstRenewalCookie = firstRenewal.headers
        .getSetCookie()
        .find((value) => value.startsWith(`${SESSION_COOKIE}=`))!;
      expect(firstRenewalCookie).toMatch(/HttpOnly/i);
      expect(firstRenewalCookie).toMatch(/SameSite=Lax/i);
      expect(firstRenewalCookie).not.toMatch(/Secure/i);
      expect(firstRenewalCookie).toMatch(/Max-Age=1170/i);
      const firstRenewalPayload = await firstRenewal.json();
      expect(firstRenewalPayload.data.expiresAt).toBe(absoluteExpiry);
      expect(firstRenewalPayload.data.nextRenewalAt).toBe(
        new Date(BASE_TIME.getTime() + 60_000).toISOString(),
      );
      expect(firstRenewalPayload.data.rotation).toBe(1);
      expect(firstRenewalPayload.data).not.toHaveProperty("token");
      expect(firstRenewalPayload.data).not.toHaveProperty("session");

      const replay = await renewHandler(
        request(
          "/api/auth/renew",
          "POST",
          undefined,
          `${SESSION_COOKIE}=${firstToken}`,
        ),
        database,
        new Date(BASE_TIME.getTime() + 60_000),
      );
      expect(replay.status).toBe(409);
      expect((await replay.json()).error.code).toBe("SESSION_ALREADY_ROTATED");
      expect(replay.headers.get("set-cookie")).toBeNull();
      const staleValidation = await sessionHandler(
        request(
          "/api/auth/session",
          "GET",
          undefined,
          `${SESSION_COOKIE}=${firstToken}`,
        ),
        database,
        new Date(BASE_TIME.getTime() + 60_000),
      );
      expect(staleValidation.status).toBe(409);
      expect(staleValidation.headers.get("set-cookie")).toBeNull();

      const secondRenewal = await renewHandler(
        request(
          "/api/auth/renew",
          "POST",
          undefined,
          `${SESSION_COOKIE}=${firstRenewalToken}`,
        ),
        database,
        new Date(BASE_TIME.getTime() + 60_000),
      );
      expect(secondRenewal.status).toBe(200);
      const secondToken = getCookie(secondRenewal);
      const { rows: familyRows } = await database.query<{
        expires_at: string;
        rotation: number;
        revoked_at: string | null;
      }>(
        `SELECT expires_at, rotation, revoked_at
         FROM sessions
         WHERE family_id = (
           SELECT family_id FROM sessions WHERE user_id = $1 LIMIT 1
         )
         ORDER BY rotation`,
        [user.id],
      );
      expect(familyRows.map((row) => row.expires_at)).toEqual([
        absoluteExpiry,
        absoluteExpiry,
        absoluteExpiry,
      ]);
      expect(familyRows.map((row) => row.rotation)).toEqual([0, 1, 2]);
      expect(familyRows.slice(0, 2).every((row) => row.revoked_at !== null)).toBe(
        true,
      );
      expect(familyRows[2].revoked_at).toBeNull();

      const concurrentTime = new Date(BASE_TIME.getTime() + 90_000);
      const concurrent = await Promise.all([
        renewHandler(
          request(
            "/api/auth/renew",
            "POST",
            undefined,
            `${SESSION_COOKIE}=${secondToken}`,
          ),
          database,
          concurrentTime,
        ),
        renewHandler(
          request(
            "/api/auth/renew",
            "POST",
            undefined,
            `${SESSION_COOKIE}=${secondToken}`,
          ),
          database,
          concurrentTime,
        ),
      ]);
      expect(concurrent.map((response) => response.status).sort()).toEqual([
        200,
        409,
      ]);
      expect(
        Number(
          (
            await database.query(
              `SELECT COUNT(*) AS count
               FROM sessions
               WHERE family_id = (
                 SELECT family_id FROM sessions WHERE user_id = $1 LIMIT 1
               )
                 AND revoked_at IS NULL`,
              [user.id],
            )
          ).rows[0].count,
        ),
      ).toBe(1);
      const concurrentSuccess = concurrent.find(
        (response) => response.status === 200,
      )!;
      const latestToken = getCookie(concurrentSuccess);

      const suspendedTabRenewal = await renewHandler(
        request(
          "/api/auth/renew",
          "POST",
          undefined,
          `${SESSION_COOKIE}=${latestToken}`,
        ),
        database,
        new Date(BASE_TIME.getTime() + 5 * 60_000),
      );
      expect(suspendedTabRenewal.status).toBe(200);
      const resumedToken = getCookie(suspendedTabRenewal);
      expect((await suspendedTabRenewal.json()).data.expiresAt).toBe(
        absoluteExpiry,
      );

      const failedRenewal = await renewHandler(
        request(
          "/api/auth/renew",
          "POST",
          undefined,
          `${SESSION_COOKIE}=invalid-session-credential`,
        ),
        database,
        new Date(BASE_TIME.getTime() + 5 * 60_001),
      );
      expect(failedRenewal.status).toBe(401);
      expect(failedRenewal.headers.getSetCookie().join(";")).toMatch(
        /Max-Age=0/i,
      );

      const expiry = new Date(BASE_TIME.getTime() + SESSION_LIFETIME_MS);
      const expiredRenewal = await renewHandler(
        request(
          "/api/auth/renew",
          "POST",
          undefined,
          `${SESSION_COOKIE}=${resumedToken}`,
        ),
        database,
        expiry,
      );
      expect(expiredRenewal.status).toBe(401);
      expect(expiredRenewal.headers.getSetCookie().join(";")).toMatch(
        /Max-Age=0/i,
      );
      const currentSession = await sessionHandler(
        request(
          "/api/auth/session",
          "GET",
          undefined,
          `${SESSION_COOKIE}=${resumedToken}`,
        ),
        database,
        expiry,
      );
      expect(currentSession.status).toBe(401);
      expect(currentSession.headers.getSetCookie().join(";")).toMatch(
        /Max-Age=0/i,
      );
      expect(
        Number(
          (
            await database.query(
              `SELECT COUNT(*) AS count
               FROM sessions
               WHERE family_id = (
                 SELECT family_id FROM sessions WHERE user_id = $1 LIMIT 1
               )
                 AND revoked_at IS NULL`,
              [user.id],
            )
          ).rows[0].count,
        ),
      ).toBe(0);
    } finally {
      vi.setSystemTime(originalTime);
    }
  });

  it("clears the cookie and rejects a missing or expired session", async () => {
    const unauthenticated = await sessionHandler(
      request("/api/auth/session", "GET"),
      database,
    );
    expect(unauthenticated.status).toBe(401);
    expect(unauthenticated.headers.getSetCookie().join(";")).toMatch(/Max-Age=0/i);

    const secureUnauthenticated = await sessionHandler(
      new Request("https://localhost:3000/api/auth/session"),
      database,
    );
    expect(secureUnauthenticated.headers.getSetCookie().join(";")).toMatch(
      /Secure/i,
    );

    const user = await createUser("expired@example.com");
    const result = await loginUser(
      database,
      loginSchema.parse({ email: user.email, password: PASSWORD }),
      new Date(Date.now() - SESSION_LIFETIME_MS - 1000),
    );
    const expired = await sessionHandler(
      request(
        "/api/auth/session",
        "GET",
        undefined,
        `${SESSION_COOKIE}=${result.session.token}`,
      ),
      database,
    );
    expect(expired.status).toBe(401);
    expect(expired.headers.getSetCookie().join(";")).toMatch(/Max-Age=0/i);
  });

  it("keeps existing data when migrations are rerun", async () => {
    const user = await createUser("migration@example.com");
    await migrateDatabase(database);
    const { rows: migrationRows } = await database.query<{ version: number }>(
      "SELECT version FROM schema_migrations ORDER BY version",
    );
    const { rows: userRows } = await database.query<{ id: string }>(
      "SELECT id FROM users WHERE id = $1",
      [user.id],
    );

    expect(migrationRows.map(({ version }) => version)).toEqual([1, 2]);
    expect(userRows).toEqual([{ id: user.id }]);
  });

  it("enforces immutable expiries and one active session per family", async () => {
    const user = await createUser("constraints@example.com");
    const login = await loginUser(
      database,
      loginSchema.parse({ email: user.email, password: PASSWORD }),
      BASE_TIME,
    );

    await expect(
      database.query(
        "UPDATE sessions SET expires_at = $1 WHERE id = $2",
        [
          new Date(BASE_TIME.getTime() + SESSION_LIFETIME_MS + 1000).toISOString(),
          login.session.id,
        ],
      ),
    ).rejects.toMatchObject({ code: "23514" });

    await expect(
      database.query(
        `INSERT INTO sessions
          (id, family_id, user_id, token_hash, created_at, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          randomUUID(),
          login.session.familyId,
          user.id,
          randomUUID(),
          BASE_TIME.toISOString(),
          login.session.expiresAt,
        ],
      ),
    ).rejects.toMatchObject({
      code: "23505",
      constraint: "sessions_one_active_per_family_idx",
    });
  });

  it("invalidates the server-side session during logout", async () => {
    await createUser("logout@example.com");
    const login = await loginHandler(
      request("/api/auth/login", "POST", {
        email: "logout@example.com",
        password: PASSWORD,
      }),
      database,
    );
    const token = getCookie(login);

    const logout = await logoutHandler(
      request(
        "/api/auth/logout",
        "POST",
        undefined,
        `${SESSION_COOKIE}=${token}`,
      ),
      database,
    );
    expect(logout.status).toBe(200);
    expect(logout.headers.getSetCookie().join(";")).toMatch(/Max-Age=0/i);

    const sessionAfterLogout = await sessionHandler(
      request(
        "/api/auth/session",
        "GET",
        undefined,
        `${SESSION_COOKIE}=${token}`,
      ),
      database,
    );
    expect(sessionAfterLogout.status).toBe(401);
  });

  it("logout after rotation revokes the whole session family", async () => {
    const user = await createUser("rotated-logout@example.com");
    const login = await loginHandler(
      request("/api/auth/login", "POST", {
        email: user.email,
        password: PASSWORD,
      }),
      database,
      BASE_TIME,
    );
    const originalToken = getCookie(login);
    const renewal = await renewHandler(
      request(
        "/api/auth/renew",
        "POST",
        undefined,
        `${SESSION_COOKIE}=${originalToken}`,
      ),
      database,
      new Date(BASE_TIME.getTime() + 30_000),
    );
    expect(renewal.status).toBe(200);
    const currentToken = getCookie(renewal);

    const logout = await logoutHandler(
      request(
        "/api/auth/logout",
        "POST",
        undefined,
        `${SESSION_COOKIE}=${currentToken}`,
      ),
      database,
      new Date(BASE_TIME.getTime() + 40_000),
    );
    expect(logout.status).toBe(200);
    expect(logout.headers.getSetCookie().join(";")).toMatch(/Max-Age=0/i);
    const { rows: activeRows } = await database.query(
      "SELECT COUNT(*) AS count FROM sessions WHERE user_id = $1 AND revoked_at IS NULL",
      [user.id],
    );
    expect(Number(activeRows[0].count)).toBe(0);

    const oldTokenResponse = await sessionHandler(
      request(
        "/api/auth/session",
        "GET",
        undefined,
        `${SESSION_COOKIE}=${originalToken}`,
      ),
      database,
      new Date(BASE_TIME.getTime() + 41_000),
    );
    const currentTokenResponse = await sessionHandler(
      request(
        "/api/auth/session",
        "GET",
        undefined,
        `${SESSION_COOKIE}=${currentToken}`,
      ),
      database,
      new Date(BASE_TIME.getTime() + 41_000),
    );
    expect(oldTokenResponse.status).toBe(401);
    expect(oldTokenResponse.headers.getSetCookie().join(";")).toMatch(
      /Max-Age=0/i,
    );
    expect(currentTokenResponse.status).toBe(401);
  });

  it("rate limits repeated failed logins using persistent server-side state", async () => {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const response = await loginHandler(
        request("/api/auth/login", "POST", {
          email: "rate-limit@example.com",
          password: PASSWORD,
        }),
        database,
      );
      expect(response.status).toBe(401);
    }

    const fifthFailure = await loginHandler(
      request("/api/auth/login", "POST", {
        email: "rate-limit@example.com",
        password: PASSWORD,
      }),
      database,
    );
    expect(fifthFailure.status).toBe(429);

    const limited = await loginHandler(
      request("/api/auth/login", "POST", {
        email: "rate-limit@example.com",
        password: PASSWORD,
      }),
      database,
    );
    expect(limited.status).toBe(429);
    const { rows: attempts } = await database.query(
      "SELECT failures, locked_until FROM auth_login_attempts",
    );
    expect(attempts[0]).toMatchObject({
      failures: 5,
      locked_until: expect.any(String),
    });
  });
});
