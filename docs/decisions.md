# Decisions

Calls already made, with the reasons. They are settled here so issues stop
re-litigating them. To change one, change it here first, in the same pull
request as the code.

Where this file and `docs/spec.md` disagree, this file wins.

## Product

### 1. One business per deployment, all staff equal

There is no business table and no roles. Every signed-in staff member can
do everything, including editing settings.

Why: the target is a small business where everyone at the front desk
handles bookings. Roles and multi-tenancy would add permission checks to
every endpoint for a requirement nobody asked for.

### 2. The app never sends messages

Staff copy the link or a pre-written message and send it themselves.

Why: SMS and WhatsApp APIs cost money, need sign-up and verification, and
add an external service that can fail. Staff already message clients from
their phones.

### 3. Business rules live in a settings row, not in code or env vars

Hours, thresholds, the message template, time zone, and business name are
fields on the single `BusinessSettings` row, edited on the Settings page.

Why: each business tunes them differently, and changing a rule should not
need a redeploy. Environment variables hold only deployment values and
secrets.

### 4. At-risk reasons are computed on read, never stored

The dashboard calculates them from the appointment, the client's history,
the settings, and the current time, as pure functions.

Why: a stored flag needs a background job to keep it current, and goes
stale the moment a setting changes. Computed reasons are always right, and
the cost is negligible at a few hundred appointments a day.

### 5. Confirmation tokens are stored hashed and shown once

The database keeps a SHA-256 hash. The full link is returned only when it
is created or regenerated.

Why: a leaked database must not hand out working links. Cost accepted:
staff who lose a link regenerate it, which invalidates the old one.

### 6. Cancelled is final, and a time change resets confirmation

A cancelled appointment cannot be reopened. Changing the start time puts
the appointment back to `pending`.

Why: reopening invites confusion about which reply counts. A client who
confirmed 10:00 did not confirm 15:00.

### 16. An appointment's client is fixed once created

`PATCH /appointments/{id}` cannot change the client. To move an
appointment to another client, staff cancel it and create a new one.

Why: the confirmation link has already gone to the original client.
Switching the client would show that person someone else's appointment.

### 19. At-risk reasons apply only before the start time, and every rule window is elapsed time

A `pending` or `confirmed` appointment whose start time has passed gets
no at-risk reasons. The no-reply window, the no-show lookback, and the
late-cancellation window are measured in elapsed hours and days, not
local wall-clock time.

Why: once an appointment has started it can only be marked attended or
no-show, the link no longer accepts replies, and the dashboard shows it
under "Needs outcome"; keeping "No reply yet" on it would put it in two
groups. "Within 24 hours" means 24 real hours whatever the DST change,
which needs no time-zone maths and no library. Cost accepted: around a
DST change a window is one hour off from the local wall clock.

### 20. Message dates are `DD/MM/YYYY` and 24-hour time in the business time zone

`{date}` renders as `DD/MM/YYYY` and `{time}` as `HH:mm`, both in the
business time zone, with the built-in `Intl.DateTimeFormat`.

Why: numeric, so it reads the same in any message language, and it
matches the `openapi.yaml` example and the Madrid demo business. A
per-business date format is not in the MVP.

## Technical

### 7. Express 5 + TypeScript + Prisma + PostgreSQL everywhere

The same database engine in development, tests, and production. No SQLite.

Why: a Prisma schema targets one database provider. Running tests on the
database production uses avoids bugs that only appear in production.

### 8. npm workspaces monorepo

`backend/`, `frontend/`, and `e2e/` in one repository, with root scripts
that run every workspace.

Why: the rubric asks for tests that run with one command, and one
`npm test` at the root does that.

### 9. Contract first

`openapi.yaml` is written before the backend. Zod schemas validate
requests to match it.

Why: the frontend and backend can be built against the same contract, and
QA has a fixed reference to compare responses with.

### 10. ESLint with typescript-eslint, plus `tsc --noEmit`

One lint configuration for every workspace. Lint and typecheck must pass
before any commit and in CI.

Why: the most widely documented choice for Express and React with
TypeScript.

### 11. One EC2 instance for dev and production, behind CloudFront

A single `t4g.small` runs both environments as separate Docker Compose
projects. Each has its own CloudFront distribution with the default
`*.cloudfront.net` domain. No custom domain, no Caddy.

Why: lowest cost that still meets the rubric. The t4g.small free trial
covers one instance until December 31, 2026, and CloudFront gives HTTPS
without buying a domain. Cost accepted: no high availability, and dev and
production share a host (mitigated by container memory limits).

### 12. Telemetry goes straight to Grafana Cloud's free tier

The app exports traces, metrics, and logs over OTLP with no collector.

Why: free, already proven in the owner's previous project, and a
collector would use memory the small instance needs.

### 15. The OpenAPI contract is 3.1 and linted by Redocly in `npm run lint`

`openapi.yaml` declares OpenAPI 3.1.0 and is checked by `@redocly/cli`
with the `recommended` ruleset (`redocly.yaml`), run by `npm run lint`
after ESLint.

Why: 3.1 schemas are JSON Schema 2020-12, so nullable fields and `oneOf`
with a discriminator work cleanly, and Redocly and the common TypeScript
generators support it. Running Redocly inside `npm run lint` means the
"lint before commit" rule and CI cover the contract with no new step.
Redocly was chosen over Spectral as the simpler setup.

### 17. Sessions are stateless signed cookies, with no session table

The auth check loads the staff member on every request and rejects
inactive ones, which is how deactivation ends sessions (spec 6.1).

Why: no table to write on sign-in or clean up later, and deactivation
still takes effect on the next request. Cost accepted: sign-out clears
the cookie but cannot revoke a copy of the token before its 12 hours run
out.

### 18. Passwords are hashed with `bcryptjs`, cost 12

Why: pure JavaScript, so no native build on the arm64 instance or in
Docker. The 72-byte bcrypt limit is why `openapi.yaml` caps passwords at
72 characters.

## Process

### 13. One agent at a time

Issues are worked sequentially, on a branch per issue in the main
checkout. No worktrees.

Why: a roughly 20-hour project gains little from parallel agents, and
sequential work avoids merge and database conflicts between branches.

### 14. The orchestrator merges; the owner releases

The orchestrator squash-merges a pull request after QA PASS and green CI.
Only the repository owner promotes to production, and only the owner may
bypass branch protection, when CI itself is broken.

Why: the rubric needs a human gate on production, not on every merge.
Keeping merges with the orchestrator lets the backlog run without waiting.
