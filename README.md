# Daymark

Daymark is a personal task list built with Next.js App Router, TypeScript,
Tailwind CSS, and PostgreSQL. Accounts, tasks, and opaque server-managed
sessions are stored in PostgreSQL. Application database access runs on the
Node.js server runtime.

## Requirements

- Node.js LTS compatible with Next.js 16
- npm 11 (the repository uses `package-lock.json`)
- A PostgreSQL server and a database named `todo-app`

## Configure and run

1. Copy `.env.example` to `.env`.
2. Set `DATABASE_URL` in `.env` to the PostgreSQL connection URL for `todo-app`.
   Keep the username/password local; do not commit `.env` or share its contents.
3. Initialize the schema and start the app:

```powershell
npm ci
npm run db:init
npm run dev
```

The application also checks and applies its versioned, non-destructive
migrations when it first opens the database. It refuses to initialize when
application tables already exist without recognized migration history, rather
than overwriting an unknown schema. The PostgreSQL schema preserves foreign
keys, validation checks, indexes, the partial unique index for active session
families, and the trigger that prevents session-expiry changes.

Optionally set `APP_TIME_ZONE` to an IANA timezone such as `Asia/Kolkata`. If
unset, the server's local timezone is used for date filtering and dashboard
timestamps.

## Database migration status

The existing SQLite data has been transferred to PostgreSQL and verified
against a consistent backup. The original SQLite database and a separate
backup are preserved locally; neither is used by the application. SQLite
dependencies and one-time transfer utilities have been retired.

This repository now supports PostgreSQL only. Deployments migrating from
another SQLite database must plan and verify a separate data export/import
before switching the application to PostgreSQL.

## Checks

```powershell
npm run lint
npm run typecheck
npm run test
npm run build
```

Authentication and task integration tests use a unique temporary PostgreSQL
schema per test and drop only that schema afterward. Configure `DATABASE_URL`
for a **dedicated local test database**, not production, before running them.
Vitest also includes client-side task-selection tests. There is no Playwright
configuration or automated browser end-to-end test script.

## Security and limitations

- Passwords are stored as Argon2id hashes. Session credentials are random,
  stored server-side only as hashes, and delivered through HTTP-only cookies.
- A login session has a fixed 20-minute absolute lifetime. Its opaque cookie
  credential rotates every 30 seconds while active; rotation never extends
  that deadline.
- All task access is scoped to the authenticated user on the server.
- Database credentials belong only in `.env` or the deployment environment.
  Do not prefix them with `NEXT_PUBLIC_`, commit them, or include them in logs.
- PostgreSQL access is configured through `DATABASE_URL`; the app does not
  infer or hardcode a password.
- Local HTTP development does not provide HTTPS transport security. Use HTTPS
  and protect the host before exposing the app beyond the local machine.
- There is no cloud synchronization, password recovery, email delivery, or
  background reminder delivery.
