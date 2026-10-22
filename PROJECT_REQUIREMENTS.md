# Personal To-Do List Application — Project Requirements

**Document status:** Original SQLite specification; PostgreSQL migration update 2026-10-22
**Version:** 1.0
**Application type:** Local-first, single-device Next.js web application

## 1. Project overview

Build a complete, responsive to-do application in the existing Next.js project. A person can create a local account, sign in, and manage a private task list. Users can create, view, edit, complete, reopen, and delete their own tasks; search by title; and organize tasks with date, status, priority, and category filters and sorting.

The application uses a PostgreSQL database configured through the server-only `DATABASE_URL`. It does not require a cloud database, email service, or paid provider to run locally. Application authentication, database access, and authorization are performed on the server.

### Goals

- Provide a usable and accessible task-management experience on desktop and mobile.
- Persist users, tasks, and sessions in PostgreSQL across browser refreshes and app restarts.
- Keep every user's tasks private through server-enforced ownership checks.
- Apply a testable 20-minute absolute session lifetime, while rotating the server-managed session credential every 30 seconds without extending that lifetime.
- Validate inputs, handle failures safely, and document setup, data storage, and backup.

### Non-goals for the core release

- Cloud storage, synchronization, or multi-device account access.
- Email verification, password-reset email, or any other email delivery.
- Push notifications or background reminder delivery.
- Public registration controls, teams, sharing, or administrator features.
- Implementing optional enhancements before the core acceptance criteria pass.

## 2. Existing project and compatibility notes

The implementation adapts the existing project; it did not scaffold a replacement project or reinstall Next.js. The following records the initial compatibility findings and their resolution:

- The existing App Router structure (`app/page.tsx`, `app/layout.tsx`, `app/globals.css`), TypeScript strict mode, and Tailwind CSS were retained.
- The project remains on Next.js `16.4.0`, React and React DOM `19.3.0`, and Tailwind CSS `4`. The PostgreSQL migration passes lint, type checking, production build, and all 31 automated tests.
- Initial inspection found a pnpm manifest/lockfile conflict with the requested npm workflow. Phase 1 resolved this in favor of npm `11.19.1`: `package.json` declares npm, `package-lock.json` is authoritative, and the pnpm lock/workspace files were removed.
- The project uses Zod, `pg`, `@node-rs/argon2`, and Vitest. SQLite dependencies and one-time transfer tools were removed after migration verification. Lucide React, date-fns, and Playwright are not installed; automated Playwright E2E tests remain outstanding.
- `next.config.ts` retains Cache Components, partial prefetching, and the Tailwind Turbopack loader. Database and authentication modules are server-only; database-backed routes use request-time execution and the Node.js runtime.
- Starter page content and metadata have been replaced with the application entry point and Daymark metadata. The layout uses local system fonts, so it does not require a Google Fonts fetch.
- `.gitignore` excludes environment files and build artifacts while allowing `.env.example`; the legacy SQLite source and backup remain local and untracked.

### PostgreSQL migration status — 2026-10-22

- Runtime database access has been converted to asynchronous, parameterized PostgreSQL queries and pooled transactions. Versioned migrations preserve the schema checks, foreign keys, indexes, active-session-family partial uniqueness, and immutable session-expiry trigger.
- PostgreSQL schema version 2 was initialized in the selected local database. The existing SQLite data was imported transactionally, and every transferred field was compared with the consistent SQLite backup.
- All 31 automated tests, lint, type checking, and the production build passed after the import. The original SQLite database and a separate backup remain local and unmodified; SQLite dependencies and transfer tools have been retired.
- See `README.md` for PostgreSQL setup and test-database isolation. The original SQLite-specific details later in this document describe the pre-migration baseline and are superseded for runtime behavior.

These notes document the implementation's compatibility decisions. Section 15 tracks implementation progress, and the verification record in Section 17 records acceptance evidence and remaining work.

## 3. Technology and runtime

| Area | Requirement |
|---|---|
| Framework | Existing Next.js App Router project; preserve compatible installed version |
| Language and UI | TypeScript, React, Tailwind CSS |
| Database | PostgreSQL via the `pg` package, accessed only by Node.js server code |
| Validation | Zod schemas shared where appropriate, with authoritative validation on the server |
| Password hashing | Argon2id or bcrypt; prefer Argon2id unless package/runtime compatibility makes bcrypt the safer supported choice |
| Authentication | Opaque, cryptographically random server-managed session credential in an HTTP-only cookie; session state in PostgreSQL |
| Icons and dates | Lucide React and date-fns where helpful |
| Tests | Vitest for unit/integration tests; Playwright for browser end-to-end tests |
| Package manager | npm, after resolving the existing pnpm manifest/lockfile conflict |
| Runtime | Node.js for all database and authentication operations; never use PostgreSQL from Edge Runtime |

Do not add a dependency merely because it is listed as a suggestion. Check for existing compatible packages and current framework guidance first.

## 4. Users, permissions, and authorization

There is one role: **registered user**. A user may access their own profile and perform all supported operations on their own tasks. There is no administrator role.

The authenticated user ID must be derived from a validated server-side session. Never accept a browser-supplied user ID as proof of identity or ownership. Every task lookup, list, search, filter, edit, completion, and deletion query must scope the operation to that authenticated user. A task belonging to another user must not be revealed through an altered ID, response body, or distinguishable error.

Unauthenticated users may access registration, login, and public error/not-found interfaces only.

## 5. Pages and navigation

| Route | Access | Requirements |
|---|---|---|
| `/` | Public | Redirect authenticated users to `/dashboard`; otherwise show a useful entry point with links to `/login` and `/register`. |
| `/register` | Public | Name, email, password, confirmation, show/hide control, password guidance, field-level validation, generic operational errors, and link to login. Successful registration redirects to `/login`. |
| `/login` | Public | Email, password, show/hide control, required-field feedback, loading feedback, generic invalid-credentials message, and link to registration. Successful login redirects to `/dashboard`. An authenticated user visiting the page is redirected to the dashboard. |
| `/dashboard` | Protected | Personalized task dashboard described in Section 6. Unauthenticated or expired sessions redirect to `/login` with a safe session-expired notice when applicable. |
| Task detail/edit interface | Protected | A task modal or dedicated page may be used. It must show full task data and preserve existing values when editing. |
| Not found and error interfaces | Any | Helpful, accessible messages that do not disclose stack traces, paths, SQL, credentials, tokens, or internal details. |

Use the project's App Router conventions. Protected server-rendered content and every protected handler must independently authenticate; hiding a link or checking a client-side flag is not protection.

## 6. Dashboard and task lifecycle

The dashboard displays the current user's name, current date, summary cards for total, pending, completed, and overdue tasks, task creation action, search, date/status/priority/category filters, sorting, a task list, account/logout menu, and appropriate loading, empty, success, and error states. Show a clear no-match state when filters or search return no tasks. Provide a way to reset filters.

### Task fields and validation defaults

All limits below are implementation defaults. Keep them centralized in shared validation schemas and enforce them on the server.

| Field | Requirement and default |
|---|---|
| `id` | Unique opaque or UUID identifier generated on the server. |
| `user_id` | Required owner foreign key derived from the authenticated session. |
| `title` | Required; trim whitespace; reject empty/whitespace-only values; maximum 200 characters. |
| `description` | Optional; maximum 5,000 characters; preserve user-entered text safely. |
| `due_date` | Optional calendar date stored as ISO `YYYY-MM-DD`; invalid calendar dates are rejected. |
| `due_time` | Optional local wall time in `HH:mm`; meaningful only with a due date. |
| `status` | `pending`, `in_progress`, or `completed`; new-task default `pending`. |
| `priority` | `low`, `medium`, or `high`; default `medium`. |
| `category` | Optional trimmed plain-text label; maximum 80 characters. |
| `reminder` | Optional preference only if UI and behavior are implemented and documented; no background delivery in core release. |
| `created_at`, `updated_at` | Server-generated UTC timestamps; update `updated_at` on every successful edit or status transition. |
| `completed_at` | UTC timestamp set on completion; null when pending or in progress. |

Creating or editing a task validates every submitted field. Editing prepopulates existing values and warns before discarding unsaved changes when practical. Deletion requires confirmation. Failed writes must never appear successful in the UI.

Task lifecycle:

1. Create in `pending` state unless the user explicitly chooses another supported status.
2. Move between `pending` and `in_progress` as the user changes status.
3. On completion, set `status=completed` and set `completed_at` using server time.
4. On reopening, set an explicitly selected non-completed status (default `pending`) and clear `completed_at`.
5. On edit, preserve fields not changed by the user and refresh `updated_at`.
6. On delete, remove only the owner's task after confirmation.

Task duplication, bulk operations, and clearing completed tasks are optional and must not delay the core lifecycle.

## 7. Search, filters, dates, and sorting

### Search

- Search task titles case-insensitively.
- Trim leading/trailing whitespace; an empty trimmed query means no title restriction.
- Update results as the user types; debounce only if needed for a server-backed search.
- Include a clear-search control.
- Combine search with all filters and sorting without changing the user's selected sort.
- Validate search and sort query parameters on the server. Every query remains scoped to the session user.
- Show a useful empty-results message.

### Date and status filters

Provide: **All**, **Today**, **Tomorrow**, **This week**, **Upcoming**, **Overdue**, and **Completed**, plus a custom date range where practical. Date filtering is based on `due_date`, not `created_at`. Date filters, status, priority, category, search, and sorting must compose predictably.

Definitions:

- **Today/Tomorrow/This week:** compare the task's due date with calendar dates in the configured application timezone. Define the week as Monday through Sunday.
- **Upcoming:** tasks with a due date after today that are not completed.
- **Overdue:** non-completed tasks with a due date earlier than today in the configured timezone, or with today's due date and an optional due time earlier than the current local time. A date-only task becomes overdue after its due date has ended (on the next local calendar day). A task without a due date is never overdue.
- **Completed:** completed tasks, regardless of due date.
- **Custom range:** inclusive start and end dates; reject malformed dates and start dates after end dates.
- Completed tasks are never overdue. Tasks without due dates remain visible in **All** and applicable status/priority/category results.

### Sorting

Provide:

- Due date: earliest first.
- Due date: latest first.
- Creation date: newest first.
- Creation date: oldest first.
- Priority: high to low.
- Priority: low to high.
- Title: alphabetical.

For due-date sorts, undated tasks appear after tasks with dates in either direction. Use a stable tie-breaker (for example, title and then ID) so ordering does not jump unexpectedly. Priority order is `high`, `medium`, `low`; reverse for low-to-high.

### Timezone and storage

- Store timestamps (`created_at`, `updated_at`, `completed_at`, session times) as UTC ISO-8601 values or integer Unix milliseconds consistently.
- Store a due date as a date-only `YYYY-MM-DD` value; do not convert it through UTC midnight.
- Store optional due time as local wall time `HH:mm`, paired with the date. Do not claim to deliver time-based reminders in the core release.
- Use `APP_TIME_ZONE` as an optional IANA timezone setting for calendar labels and date-boundary calculations; default to the Node.js host's configured local timezone when unset. Keep the setting consistent between server and UI. Tests must set a fixed timezone.
- Use date-fns for parsing/formatting where useful, with timezone-aware handling where needed. Reject invalid values rather than silently rolling them into another date.

## 8. PostgreSQL runtime and migrated data

### File location, lifecycle, and privacy

- Configure the PostgreSQL endpoint using `DATABASE_URL`; keep credentials in the ignored local `.env` or deployment environment, never in source or `.env.example`.
- Initialize the schema with versioned, transactional migrations. If application tables exist without recognized migration history, stop without altering them.
- Use parameterized PostgreSQL queries exclusively and retain a checked-out client for each multi-statement transaction.
- Keep the PostgreSQL pool server-only and close it during shutdown/scripts. Do not initialize the database in client code or Edge Runtime.
- The legacy SQLite data transfer is complete. The original database and a consistent backup are retained locally for rollback/reference, but application runtime and dependencies are PostgreSQL-only.
- Never commit database contents, user data, password hashes, session credentials, or secrets. Protect PostgreSQL credentials and SQLite backups with operating-system permissions.

### Schema

Use migrations or a versioned, reliable initialization process. Preserve the schema and constraints described below in PostgreSQL.

**`users`**

| Column | Rules |
|---|---|
| `id` | Primary key; generated server-side. |
| `name` | Required, trimmed, length 1–80. |
| `email` | Required, normalized by trim + lowercase; unique database constraint; validated length up to 254. |
| `password_hash` | Required Argon2id/bcrypt encoded hash only; never plaintext. |
| `created_at`, `updated_at` | Required UTC timestamps. |

**`tasks`**

| Column | Rules |
|---|---|
| `id` | Primary key. |
| `user_id` | Required foreign key to `users(id)` with delete behavior documented and enforced. |
| `title` | Required, trimmed, non-empty, maximum 200 characters. |
| `description` | Nullable, maximum 5,000 characters. |
| `due_date` | Nullable ISO date-only value. |
| `due_time` | Nullable `HH:mm`; null unless a due date is present. |
| `priority` | Required, constrained to `low`, `medium`, `high`. |
| `status` | Required, constrained to `pending`, `in_progress`, `completed`. |
| `category` | Nullable, maximum 80 characters. |
| `created_at`, `updated_at` | Required UTC timestamps. |
| `completed_at` | Nullable UTC timestamp; present iff status is completed, enforced in application logic and preferably a database constraint. |

**`sessions`**

| Column | Rules |
|---|---|
| `id` | Primary key, generated server-side. |
| `family_id` | Stable identifier for one login session and its credential rotations. |
| `user_id` | Required foreign key to `users(id)`. |
| `token_hash` | Unique hash of a high-entropy opaque cookie secret; never store the raw cookie secret. |
| `created_at` | UTC creation time for this credential version. |
| `expires_at` | Immutable absolute expiry for the login session: exactly 20 minutes after initial login. Rotation must copy, not extend, it. |
| `revoked_at` | Nullable UTC time; set when credential is rotated or session is logged out/revoked. |
| `replaced_by_id` | Optional session-row ID identifying the next rotated credential. |
| `rotation` | Optional monotonically increasing version for operational clarity and testing. |

**`auth_login_attempts`** (abuse prevention)

| Column | Rules |
|---|---|
| `email_key` | Primary key; SHA-256 digest of the normalized email, rather than storing the identifier again. |
| `failures` | Positive count of failed attempts in the active window. |
| `window_started_at` | UTC start of the 15-minute failure window. |
| `locked_until` | Nullable UTC time; set for 15 minutes after five failed attempts. |

This auxiliary table is versioned with the database schema. A successful login clears that email key's counter. This is a per-account local rate limit; it does not claim to provide distributed IP-based throttling.

Indexes:

- Unique index on normalized `users.email`.
- Index on `tasks(user_id)` and useful composite indexes such as `(user_id, due_date)`, `(user_id, status)`, and `(user_id, priority)`.
- Index on `(user_id, lower(title))` for scoped case-insensitive title lookup.
- Unique index on `sessions.token_hash`; indexes on `sessions(user_id)`, `sessions(family_id)`, and `sessions(expires_at)`.
- Add only indexes supported by actual query plans; indexes do not replace ownership predicates or validation.

## 9. Authentication and session architecture

### Registration and login

- Normalize email (trim and lowercase) before checking or inserting; rely on a database unique constraint to handle concurrent duplicate registrations.
- Validate on both client and server; server validation is authoritative.
- Default password policy: 12–128 characters, with strength guidance shown to the user. Do not impose arbitrary character-composition rules; the selected hash library's supported input limits must be checked.
- Hash passwords using Argon2id (preferred) or bcrypt with a per-password salt. Compare hashes using the library's verification function. Never log passwords or hashes.
- Return a generic invalid-credentials message for login failures so the UI does not reveal whether an email exists.
- Add reasonable rate limiting for login attempts. For the single-machine application, use a bounded server-side mechanism keyed by normalized account identifier and/or client address; document that IP-derived limits are approximate behind proxies. Do not rely solely on an in-memory limiter if deployments with multiple Node processes are supported.

### Primary 20-minute absolute lifetime

- On successful login, generate a cryptographically secure, unpredictable opaque session secret using the platform's cryptographic random generator.
- Store only a cryptographic hash of the secret in PostgreSQL, associated with user and session family.
- Set the absolute expiry once to `login_time + 20 minutes`. Every protected request checks server-side session existence, revocation, and expiry against server time.
- At or after expiry, reject the credential, revoke/invalidate the session family, clear the cookie, and redirect protected pages to `/login` with a session-expired message. Do not extend or revive the session.
- Expiry checks must work even when a browser tab is suspended or the client timer does not fire.

### 30-second credential renewal (secondary mechanism)

For this local application, a separate JWT access-token/refresh-token system is unnecessary and would add token exposure and synchronization risks. Use one opaque server-managed session credential, rotated every 30 seconds while the authenticated application is active. Each new credential is a new random secret delivered only in the same HTTP-only cookie; store only its hash in the session table. This rotation is the requested secondary credential renewal, not a second independently authorizing token.

- After login, an authenticated client starts a 30-second renewal timer and calls the renewal endpoint while active. Clear timers on logout, unmount, and session loss. Browser timers are best-effort, never the expiry authority.
- The server must validate the current session and confirm its absolute expiry is still in the future before rotating. The replacement row carries exactly the original `expires_at`.
- Rotate atomically: mark the current credential row revoked/replaced and create the next credential. Reject old/replayed credentials. Do not return raw credentials in JSON, URLs, logs, or JavaScript-readable storage.
- Coordinate tabs using a browser lock (such as Web Locks) and a broadcast mechanism so a single tab renews at a time. Cookies are shared among same-origin tabs. Server-side atomic compare-and-swap/transaction behavior is still required; client coordination is not an authorization control.
- A concurrent stale renewal must not create multiple valid credentials or extend expiry. Return a defined conflict/unauthorized result; the client should revalidate the shared cookie before redirecting. If the session is actually invalid or expired, clear the cookie and redirect without an infinite retry loop.
- Renewal stops at the immutable 20-minute deadline regardless of activity. A renewal cannot refresh, reset, or revive the primary lifetime.
- No localStorage or sessionStorage may contain the session secret or any bearer token. Broadcast messages may coordinate that renewal occurred but must not carry secrets.

### Cookies, CSRF, cache, and logout

- Session cookie: `HttpOnly`, `SameSite=Lax` (or stricter if compatible), path `/`, no broad domain, and `Secure` when served over HTTPS. Use a documented development setting for local HTTP; never disable Secure in production HTTPS.
- Use an appropriate cookie name/prefix based on HTTPS deployment. Do not expose secrets in routes, logs, HTML, API response bodies, or client state.
- Cookie-authenticated state-changing requests must have CSRF protection appropriate to the same-site architecture: validate `Origin`/`Host` on unsafe methods and use an anti-CSRF mechanism if cross-site use is enabled. Do not enable permissive credentialed CORS.
- Prevent caching of personalized dashboard/API responses by shared caches; set appropriate private/no-store behavior and follow installed Next.js cache guidance.
- Logout invalidates the server-side current session/family and clears the cookie. An old cookie must fail server checks. Client logout stops renewal work and redirects to `/login`; protected responses should not be restored as usable authenticated state through browser history.

## 10. API and server-operation contract

Use App Router route handlers under `app/api`. JSON responses must be typed and must not expose stack traces or database details. Every endpoint that reads or changes protected data authenticates server-side. User identity always comes from the session.

Common response convention:

```json
{ "data": {}, "error": null }
```

or

```json
{ "data": null, "error": { "code": "VALIDATION_ERROR", "message": "Please check the highlighted fields.", "fields": {} } }
```

Return appropriate HTTP status codes (`400` invalid input, `401` missing/expired session, `404` missing or not-owned task without disclosing ownership, `409` duplicate/conflict, `429` rate limit, `500` unexpected failure). Do not return success-shaped responses for failed writes.

| Operation | Method and route | Input / result | Auth and key checks |
|---|---|---|---|
| Register | `POST /api/auth/register` | Name, email, password, confirmation; create account and return safe user summary. | Public; Zod validation; normalized unique email; hash password; duplicate conflict. On success, UI goes to `/login`. |
| Login | `POST /api/auth/login` | Email and password; set HTTP-only cookie and return safe user summary. | Public; generic invalid-credentials response; rate-limited; create session with 20-minute immutable expiry. |
| Logout | `POST /api/auth/logout` | No user ID required; invalidate current session and clear cookie. | Validate session if present; idempotent response is acceptable; no client-only logout. |
| Session validation | `GET /api/auth/session` | Safe authenticated user summary and server-reported expiry/remaining time; no secret. | Validate cookie/session each time; reject/revoke expired credentials. |
| Credential renewal | `POST /api/auth/renew` | No token in request body; authenticate from cookie and rotate cookie credential. | Validate session; atomic rotation; same original absolute expiry; reject invalid, expired, revoked, or stale/replayed credential. |
| List/search/filter | `GET /api/tasks` | Validated query: `q`, date preset/range, status, priority, category, sort, optional pagination. Return scoped tasks and counts. | Auth required; derive owner from session; allowlist enums; parameterized SQL; reject invalid combinations. |
| Read task | `GET /api/tasks/:id` | Return complete safe task record. | Auth required; query by both task ID and current user ID. |
| Create task | `POST /api/tasks` | Task fields from Section 6; return created task. | Auth required; validate fields; derive `user_id`; generated ID/timestamps. |
| Update task | `PATCH /api/tasks/:id` | Changed task fields; return updated task. | Auth required; validate partial update and owner; update timestamp; handle stale/concurrent edits with version or `updated_at` precondition if practical. |
| Delete task | `DELETE /api/tasks/:id` | No body required; return successful deletion status. | Auth required; owner-scoped delete; not-found response does not reveal another user's task. |
| Complete/reopen task | `PATCH /api/tasks/:id/status` | `{ "status": "pending" \| "in_progress" \| "completed" }`. | Auth required; owner-scoped update; set/clear `completed_at` consistently. May alternatively be handled by the general PATCH endpoint. |

Server actions may be used instead of an endpoint only where that better fits the current Next.js conventions; document the equivalent input, validation, auth, and error behavior. Do not duplicate business rules between API and server-action implementations.

## 11. UI, accessibility, and feedback

- Use a clean, professional dashboard with clear hierarchy, consistent spacing, typography, and color.
- Support desktop, tablet, and mobile widths, including usable navigation and task controls on narrow screens.
- Use semantic HTML, labels associated with inputs, keyboard-operable controls, visible focus styles, and appropriate color contrast.
- Communicate loading, success, validation, empty, and server-error states. Keep errors adjacent to relevant fields when possible.
- Destructive actions require an accessible confirmation dialog or equivalent confirmation step.
- Distinguish completed and overdue tasks without relying on color alone.
- Do not overuse animation; honor reduced-motion preferences if animation is added.
- Reusable components may include navigation/user menu, task list/card/form, search, filter/sort controls, status and priority indicators, empty/loading states, confirmation dialog, toast/feedback, and session-expiry notice. Add only components justified by the design.
- A dark theme, advanced shortcuts, virtualized lists, and extensive account settings are optional.

## 12. Error handling and operational behavior

Handle these cases explicitly: invalid login, duplicate email, invalid/weak password, missing title, invalid due date/time/range, database initialization/write failure, expired/invalid/revoked session, failed renewal, unauthorized task access, task not found, invalid search/sort values, concurrent updates, rate limits, and unexpected server failures.

- Give users concise, actionable messages without exposing internal details.
- Log server failures only when useful for debugging; redact secrets, passwords, session IDs, hashes, and sensitive form data.
- A database initialization failure must prevent the application from pretending it is ready.
- A failed API mutation must leave the UI in an error state and preserve the user's input where practical.
- Do not swallow exceptions with broad catches or replace failures with empty/success-shaped data.

## 13. Suggested project structure

Adapt this to the existing repository; do not add empty or unnecessary directories.

```text
app/
  api/
    auth/
      register/route.ts
      login/route.ts
      logout/route.ts
      session/route.ts
      renew/route.ts
    tasks/
      route.ts
      [id]/route.ts
      [id]/status/route.ts
  dashboard/page.tsx
  login/page.tsx
  register/page.tsx
  error.tsx
  not-found.tsx
  page.tsx
  layout.tsx
components/
  auth/
  tasks/
  layout/
  ui/
lib/
  auth/          # server-only session, password, and rate-limit logic
  db/            # server-only PostgreSQL pool, schema migrations, query helpers
  validation/    # Zod schemas
  dates/         # date and timezone rules
  utils/
tests/
  unit/
  integration/
  e2e/
data/            # local DB at runtime; ignored by git
PROJECT_REQUIREMENTS.md
.env.example
```

Mark database and authentication modules server-only using the supported Next.js pattern. Never import them into client components. Keep PostgreSQL route handlers in the Node.js runtime.

## 14. Testing strategy

Use deterministic tests with isolated temporary PostgreSQL schemas and an injectable/mockable clock. Tests must not wait 20 minutes in real time. Run integration tests against a dedicated local test database, never a production database.

### Unit and integration tests

- Registration success; duplicate normalized email; password hashing and verification; invalid fields.
- Login success; invalid password and generic error; rate limiting.
- Protected dashboard/API denial without a session.
- Session expiry immediately before and at/after the 20-minute boundary; invalidation and cookie clearing.
- Renewal at the 30-second interval; credential rotation; old-token replay rejection; concurrent renewal behavior; renewal rejection after absolute expiry; proof that repeated renewal never extends `expires_at`.
- Logout invalidates the server-side session and prevents reuse of the old credential.
- Task create/read/edit/delete; complete/reopen and timestamps; persistence after closing/reopening the database.
- Cross-user reads and writes are denied for every task operation.
- Case-insensitive trimmed title search; search plus date/status/priority/category filters; sorting; date boundaries; undated tasks; empty results; malformed query parameters.
- Failed DB writes do not return success or mutate UI assumptions.

### End-to-end tests

- Registration and login form validation and navigation.
- Dashboard rendering, authenticated task creation/editing/completion/deletion, search/filter/sort combination, and logout.
- Unauthenticated access redirects to login; expired session redirects and communicates expiry.
- Responsive layout and keyboard-accessible core flows at representative mobile and desktop viewports.
- Loading, empty, validation, and server-error states.

### Quality gates

- Run targeted Vitest tests, relevant Playwright tests, ESLint, TypeScript checking, and a production build.
- Resolve all critical authentication, privacy, and task-ownership failures before release.
- Keep tests isolated and reliable; document the PostgreSQL connection required for integration tests.

## 15. Implementation phases and development checklist

Mark each item `[ ]` pending, `[/]` in progress, or `[x]` completed. All items begin pending.

### Phase 1 — Inspect and document

- [x] Confirm current Next.js/React versions, app structure, scripts, and installed dependencies.
- [x] Resolve npm versus existing pnpm manifest/lockfile conflict before dependency changes; use one package manager and one lockfile.
- [x] Read the installed Next.js 16.4 documentation relevant to App Router, route handlers, cookies, cache behavior, and server external packages.
- [x] Create and review this implementation-ready `PROJECT_REQUIREMENTS.md`.
- [x] Confirm SQLite/native dependency compatibility with the installed Next.js/Turbopack and Windows development environment.

### Phase 2 — Database setup

- [x] Add only required dependencies after verifying the current manifest.
- [x] Implement a server-only SQLite connection, safe initialization, schema versioning/migrations, and indexes.
- [x] Add privacy-safe `.gitignore` rules and a documented environment example without exposing secrets.
- [x] Verify foreign keys, concurrent initialization behavior, and task/user persistence across process restarts.

### Phase 3 — Authentication

- [x] Implement registration, email normalization, server validation, and secure password hashing.
- [x] Implement login with generic credential failures and reasonable rate limiting.
- [x] Implement server-managed sessions and HTTP-only cookie configuration.
- [x] Protect every authenticated task operation and enforce task ownership at query level.
- [x] Implement server-side logout invalidation and cookie clearing.

### Phase 4 — Task management

- [x] Implement dashboard and authenticated user summary.
- [x] Implement task creation, editing, detail viewing, deletion, completion, and reopening.
- [x] Enforce validation and ownership in every read/write path.
- [x] Add field-level errors, destructive-action confirmation, loading, success, and failure feedback.

### Phase 5 — Search and organization

- [x] Implement trimmed, case-insensitive title search.
- [x] Implement today, tomorrow, this-week, upcoming, overdue, completed, and custom date-range filters.
- [x] Implement sorting options and stable ordering for missing due dates.
- [x] Implement status, priority, and category filters, counts, combined queries, and reset.
- [x] Test timezone/date boundaries and ensure completed tasks are never overdue.

### Phase 6 — Session security

- [x] Enforce immutable 20-minute absolute expiry on every protected server request.
- [x] Implement opaque credential rotation every 30 seconds without exposing the credential to JavaScript or extending expiry.
- [x] Coordinate renewals across tabs and handle stale/concurrent renewal safely.
- [x] Test just-before/at/after expiry, logout, replay, renewal failure, and suspended-tab behavior.

### Phase 7 — UI polish

- [x] Complete responsive layouts, account controls, summary cards, and mobile task actions.
- [x] Add accessible empty, loading, error, and session-expiry states.
- [x] Verify labels, focus behavior, keyboard task-editor controls, and representative viewport widths.
- [ ] Complete a formal color-contrast/accessibility audit.
- [ ] Consider optional enhancements only after core behavior and tests are stable.

### Phase 8 — Testing and finalization

- [x] Pass Vitest unit/integration coverage for authentication, sessions, data access, and task operations.
- [ ] Add and pass automated Playwright end-to-end and responsive-flow tests; Playwright is not configured in this repository.
- [x] Pass linting, type checking, and production build with the installed Next.js configuration.
- [x] Confirm no real database files or local environment secrets are tracked.
- [x] Update `README.md` with setup, run, test, database location, and backup/restore instructions.

## 16. Installation, execution, and local operations

Implementation must keep these instructions accurate to the final scripts and package manager. The following is the intended npm workflow after the package-manager conflict in Section 2 is resolved:

1. Install Node.js LTS compatible with the existing Next.js version.
2. From the project root, install the locked dependencies with `npm ci`.
3. Create a local environment file only for non-committed local configuration. Set `DATABASE_URL` for the PostgreSQL database and optionally set `APP_TIME_ZONE`.
4. Start development with `npm run dev`.
5. Open `http://localhost:3000`, register a local account, then sign in.
6. Run tests, lint, type checks, and production build using the scripts documented in the completed `README.md`.
7. The one-time SQLite data transfer for this installation is complete and verified. Future SQLite deployments need a separately planned export/import; this repository no longer includes SQLite transfer tooling. Never commit database contents or personal-data backups.

No paid service or cloud credentials should be required. Exact environment variables, migration command, and test scripts must be added to the README when implementation defines them.

## 17. Measurable acceptance criteria

The core release is acceptable only when all of the following are demonstrated:

1. A new user can register with a valid name/email/password; duplicate normalized emails are rejected by the database constraint and reported safely.
2. Passwords are stored only as secure Argon2id/bcrypt hashes. Login succeeds for the correct password and fails generically for incorrect credentials.
3. Unauthenticated requests cannot access the dashboard or any protected task/session operation.
4. Two users can each create tasks, and tests prove neither can read, search, update, complete, nor delete the other's tasks by changing IDs or query parameters.
5. A user can create, edit, delete, complete, and reopen their tasks; validation and completion timestamps remain correct.
6. Tasks survive browser refresh and application/database connection restart.
7. Title search is trimmed and case-insensitive; date, status, priority, and category filters combine with search and sorting.
8. Due-date sorting places undated tasks after dated tasks in both directions. Completed tasks are never overdue; tasks without due dates are never overdue.
9. Session tests using a controllable clock accept the session immediately before its deadline and reject it at/after 20 minutes from login.
10. Repeated 30-second credential rotations do not change the original 20-minute `expires_at`; old/replayed credentials fail, concurrent requests do not create multiple valid credentials, and renewal after expiry fails.
11. Logout invalidates server state, clears the cookie, stops renewal, and the previous credential cannot access protected operations.
12. Session identifiers, passwords, password hashes, DB details, and stack traces are absent from browser-readable storage, URLs, and user-facing errors.
13. The application works with the configured PostgreSQL server and has documented setup, safe SQLite migration, and backup procedures.
14. Core flows are operable on representative mobile and desktop viewports and by keyboard; controls have labels and visible focus.
15. Targeted tests, lint, TypeScript checks, and production build pass; failed mutations are never presented as successful.

### Verification record — 2026-10-15

| # | Status | Evidence / remaining work |
|---|---|---|
| 1 | Verified | Registration and normalized duplicate-email behavior covered by auth tests and browser smoke flow. |
| 2 | Verified | Argon2id hash storage, correct login, and generic credential failure covered by auth tests. |
| 3 | Verified | Protected task handlers reject unauthenticated requests; dashboard redirects after logout in browser smoke flow. |
| 4 | Verified | Owner-scoped read, search, update, completion, and delete tests deny cross-user access without mutation or disclosure. |
| 5 | Verified | CRUD, completion/reopen timestamps, validation, and browser task lifecycle passed. |
| 6 | Verified | SQLite connection-reopen test and browser verification after restarting the app with the same database passed. |
| 7 | Verified | Search/filter/sort composition and timezone behavior covered by task tests; browser confirmed a combined filter. |
| 8 | Verified | Both due-date sort directions keep undated tasks last; overdue tests exclude completed and undated tasks. |
| 9 | Verified | Mocked-clock session tests accept just before expiry and reject at the 20-minute deadline. |
| 10 | Verified | Renewal, immutable expiry, replay, concurrency, suspended-tab delay, and expiry tests pass. |
| 11 | Verified | Server-side logout invalidation covered by tests; browser confirmed old session cannot reopen dashboard. |
| 12 | Verified by code review/tests | No localStorage/sessionStorage token use; responses and user-facing server failures avoid secrets and stack traces. |
| 13 | Verified | PostgreSQL schema v2 initialized; imported SQLite rows were verified against the source backup; all automated PostgreSQL tests passed. |
| 14 | Partial | Browser checks passed at 1440, 768, 375, and 320 CSS-pixel widths with no horizontal overflow; editor focus/Escape checked. Formal contrast and full keyboard-flow audits remain. |
| 15 | Partial | Vitest, lint, typecheck, production build, and browser smoke flows pass. Automated Playwright E2E is not configured and remains outstanding. |

## 18. Known limitations

- The database is local to one machine and is not synchronized across devices.
- The PostgreSQL server remains local to the configured host; this application does not provide cloud synchronization or multi-device account management.
- Application-level hashing does not encrypt PostgreSQL data or the retained legacy SQLite source and backup; protect the database account and backup files.
- A 30-second renewal timer is subject to browser scheduling and tab suspension; server validation and the absolute deadline remain authoritative.
- Local HTTP development cannot provide the same transport security as HTTPS. Production cookie settings must use HTTPS.
- No reminders are delivered in the background unless a separate delivery mechanism is explicitly added in a later scope.
- Password recovery is unavailable without a separately designed local recovery process or email service.
- Automated Playwright end-to-end tests and a formal WCAG contrast/accessibility audit are not configured yet.

## 19. Future enhancements (out of core scope)

Potential follow-up features include custom category management, task duplication, bulk completion/deletion, clearing completed tasks, task statistics/progress, CSV/JSON export and validated import, optional dark mode, profile/password management, account deletion confirmation, keyboard shortcuts, user-selected sort defaults, pagination/virtualization for large task lists, and explicitly designed reminders. Implement and test each independently after the core acceptance criteria pass.
