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

### 22. The client page spells out the date

`/c/{token}` shows the date as `Tuesday, 10 November 2026` and the time
as `13:00, Europe/Madrid`, with `Intl.DateTimeFormat` in `en-GB` and the
business time zone. Decision 20 still governs the message.

Why: the client reads it on their own phone, possibly from another
country, so a written month cannot be read month-first. Day before month
matches decision 20's message text, and 24-hour time matches `{time}`.
The UI is English only.

### 23. Each appointment is in one dashboard group

The dashboard decides the group in this order: `cancelled` is Cancelled;
`attended` or `no_show` is Completed; a `pending` or `confirmed`
appointment whose start time is at or before now is Needs outcome; a
`pending` or `confirmed` appointment with at least one at-risk reason is
At risk; otherwise `pending` is Pending and `confirmed` is Confirmed. So
At risk wins over Pending and Confirmed, and a started `pending` or
`confirmed` appointment is Needs outcome only, with no at-risk reasons
shown. The dashboard decides "started" with the browser clock; the server
still rejects a late action with `409`.

Why: a card in two groups double-counts and invites two different actions
on one appointment.

The dashboard's actions follow the group. Once an appointment has started
it offers only Attended and No-show, not Cancel, although the contract
(and #39) allow a staff cancel after the start. Why: after the start the
outcome is what is left to record, and a cancel then would hide a no-show
from the client's history (repository owner's call, recorded on #32).

### 24. Start times are typed as wall-clock time in the business time zone

The appointment form reads its `datetime-local` value in
`settings.timeZone`, not the browser's zone, and converts it to UTC with
`Intl`. A time skipped by a DST change is rejected; a time that happens
twice takes the earlier one.

Why: staff book in the business's local time wherever their browser is.
Rejecting a gap is clearer than silently moving the time. The earlier of
two is what `Temporal`'s default does, and it is rare enough not to need a
choice in the UI.

### 31. Staff edit and regenerate only before the start time

The edit page offers no form and no Regenerate link once an appointment
has started, judged with the browser clock when it was loaded, as on the
dashboard, although the contract allows `PATCH` on a started `pending` or
`confirmed` appointment.

Why: after the start only the outcome is left to record (decision 23,
#32), and changing the details afterwards would rewrite what the client
was asked to confirm. The server still rejects a late regenerate with
`409`.

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

### 21. The frontend reaches the API only through one `ApiService` interface

Types in `frontend/src/api/types.ts` are hand-written to match
`openapi.yaml`. Pages get the service from `useApi()`; a mock
implementation backs the frontend tests, and an HTTP one (#14) backs the
app. Every implementation rejects with `ApiError`
(`status`, `code`, `field`). Routing uses `react-router`; styling is plain
CSS.

Why: pages are built and tested against the mock before the backend
exists, and connecting the real API changes one line instead of every
page. Hand-written types avoid a generator and a build step for about 20
types. Cost accepted: the types can drift from the contract, which QA
checks.

### 25. Session tokens are HMAC-SHA256 signed JSON, valid 12 hours from sign-in

The `session` cookie holds `base64url(JSON {staffId, expiresAt})`, a dot,
and `base64url(HMAC-SHA256(SESSION_SECRET, first part))`, built with
`node:crypto` only. `SESSION_SECRET` is required everywhere, at least 32
characters, with no fallback in code. A session lasts a fixed 12 hours
from sign-in, with no renewal. Rotating the secret signs everyone out.

Why: zero dependencies and a few lines, and decision 17 needs only
"signed and expiring"; JWT libraries add algorithm choices nobody needs.
A code fallback for the secret could silently ship to a deployed
environment.

### 26. `PUBLIC_BASE_URL` is the app's own origin

The Origin check rejects a write under `/v1` (except `/v1/public`) whose
`Origin` header is present and is not `new URL(PUBLIC_BASE_URL).origin`.
A request without `Origin` passes. The session cookie is `Secure` only
when `PUBLIC_BASE_URL` is https.

Why: one variable already names the public address (for confirmation
links), and comparing `Origin` with `Host` is unreliable behind
CloudFront. Browsers send `Origin` on every cross-site write, and
`SameSite=Lax` already keeps the cookie off cross-site POSTs. Supertest
and `http://localhost` stacks cannot send `Secure` cookies, so `Secure`
follows the scheme.

### 27. Sign-in is rate-limited in memory, per IP and email

10 failed sign-ins within a fixed 15-minute window, keyed by `req.ip` and
the lowercased email, return `429` until the window ends. Only failures
count, and a success clears the key. `trust proxy` is `1` in every
environment.

Why: decision 11 runs a single instance, so an in-memory map is correct
and needs no dependency; counting failures means a real user is never
blocked by signing in normally. It is a security limit, not a business
rule, so it is a constant, not a setting. CloudFront is the only hop and
the security group admits only CloudFront (decision 11), so the
rightmost `X-Forwarded-For` is the client. Cost accepted: a restart
clears the counters, and locally a client can fake `X-Forwarded-For`.

### 28. Appointment endpoints check session, existence, state, then body

Every staff appointment action checks 401, then 404, then 409, then 422,
so a request on an appointment that can no longer change gets 409 whatever
its body. Malformed JSON is still 422 first, from the JSON parser.

Why: it matches the frontend mock (#32, #34), and the state is what the UI
reloads on. Cost accepted: a malformed body on a cancelled appointment
reports the state, not the field.

### 29. Public endpoints are rate-limited in memory, 30 requests per IP per minute

Every request to `/v1/public/appointments/{token}` and its confirm and
cancel counts against `req.ip` in a fixed 60-second window; the 31st
returns `429` with `Retry-After` until the window ends, before the token
is checked. A token that is not 22–128 base64url characters is `404`
without a database query. Every public response is
`Cache-Control: no-store`.

Why: a real client makes a handful of requests per visit, so 30 never
blocks one, and counting every request, GET included, slows token
guessing where it happens. In memory and a constant for the same reasons
as decision 27. `no-store` keeps a browser from showing a stale status
after a confirm or cancel. Cost accepted: clients behind one shared
address share the limit, and a restart clears the counters.

### 30. Business settings are checked per field sent, in a fixed order, and written all or nothing

`PATCH /v1/settings` checks only the fields sent, in the order
`businessName`, `timeZone`, `noReplyWindowHours`, `noShowThreshold`,
`noShowLookbackDays`, `lateCancellationHours`, `defaultDurationMinutes`,
`messageTemplate`, then unknown keys, and reports the first failure. It
writes nothing unless all pass. Concurrent writes are last-write-wins per
field. A time zone is `UTC` or in `Intl.supportedValuesOf('timeZone')`,
case-sensitive.

Why: it matches the frontend mock (#9) so #14 is a swap, one field error
is what the page can show, and the page offers exactly that zone set.
Cost accepted: a zone name only one browser lists is rejected.

### 32. The backend serves the built frontend and runs from TypeScript source with `tsx`

`npm run build` builds only the frontend (`vite build`); `npm start` runs
`tsx src/server.ts` with no backend compile step. The backend serves
`frontend/dist` with an `index.html` fallback for every non-`/v1` GET
outside `/assets/` whose last path segment has no `.` (any other path is a
missing file and gets `404`), hashed assets cached for a year as immutable
and everything else served `Cache-Control: no-store`, plus `nosniff`,
`Referrer-Policy: no-referrer`, and a `'self'`-only CSP. `main.tsx` always
uses the HTTP service; the mock is for tests only, with no runtime switch.

Why: one origin means no CORS and the Origin check and `SameSite` cookie
work unchanged (decision 26); #15's image needs the devDependencies anyway
(the Prisma CLI for migrations, `tsx` for the seed), so compiling the
backend would add a build config and a second layout for no gain;
`npm run dev` already runs the real backend, so a mock switch would only be
a second way to run the app to keep working. `no-referrer` keeps a
`/c/{token}` URL out of `Referer` headers, and `frame-ancestors 'none'`
stops the confirm buttons being framed. Cost accepted: `tsx` compiles on
start (a fraction of a second) and the image carries devDependencies.
`no-store` rather than `no-cache` keeps the browser from restoring a
signed-in page from its back/forward cache after sign-out (#15).

### 33. The container migrates on every start and seeds demo data only into an empty local database

The image is one stage on `node:24-slim` with `openssl` installed, keeps
the repository layout under `/app`, keeps devDependencies, sets
`NODE_ENV=production` after the build, and runs as `node`. Its default
command runs `prisma migrate deploy` and then `exec npm start`, never the
seed. Local Compose adds `npm run db:seed:if-empty` between the two, which
seeds only when there is no `StaffMember` row and still refuses
`APP_ENV=production`. `APP_VERSION` is a build argument and `APP_ENV` comes
from Compose, both `unknown` when unset, and `GET /v1/health` reports them
after a `SELECT 1` through Prisma. The container listens on 3000 in every
environment; only the host port changes (8080 locally). Compose runs `app`
with `init: true` and memory limits of 512 MB for `app` and 256 MB for `db`.

Why: Debian glibc is the base Prisma documents and tests most, and the
migration engine needs OpenSSL, which slim lacks; alpine's musl would add a
second engine target for no gain, and both images are multi-arch, so arm64
needs nothing extra. A second stage would only drop the frontend sources,
since decision 32 keeps the devDependencies. `prisma migrate deploy` is
idempotent, while the seed wipes the database, so seeding when there is no
staff gives a working demo on a fresh volume and leaves every later start
alone; production has two guards, the image's command and the seed's own
refusal. A `SEED_DEMO_DATA` flag was rejected: one more variable to get
right per environment, and on its own it would still wipe on every
restart. The health check does a real round trip because #19 needs to know
the app can serve, not only that the process is up. The version is baked
into the image so #19 can check which tag is running; the environment
differs per Compose project running the same image. Without an init
process, `sh` as PID 1 swallows `SIGTERM` and every stop waits 10 seconds.
Two environments at those limits take 1.5 GB of the 2 GiB host (decision
11), leaving room for the OS and Docker. Cost accepted: the image carries
devDependencies, and a local database that has staff but no demo data is
never reseeded automatically.

### 34. End-to-end tests run in Chromium against a throwaway Compose project

`npm run test:e2e` runs Playwright, with `@playwright/test` pinned to an
exact version, in Chromium only. Its global setup builds and starts a
separate Compose project `ac-e2e` from the root `docker-compose.yaml` plus
`e2e/compose.e2e.yaml` (no db host port, `app` on host port 8085), after a
`down -v` that clears an earlier crashed run; the global teardown removes
it again with `down -v`. The suite runs with one worker and no retries.
Time-dependent cases use short real waits, never test-only endpoints or a
fake clock.

Why: §16 is about the product behaving, not browser differences, and one
browser keeps the install and run time in CI low. Each Playwright version
expects one browser build, so an exact pin fetches the same Chromium
locally and in CI. The dev project shares the `appointments` database with
`npm run dev`, so the suite must never run in it; a separate project has
its own containers, network, image, and `ac-e2e_db-data` volume, 8080 is
the dev stack and 8081/8082 are reserved for the EC2 environments
(decision 11), and dropping the db host port avoids a clash on 5432. An
override rather than a copied Compose file keeps the e2e stack identical
to what ships. A fresh volume each run lets the stack's own seed create
demo data relative to now, which makes the tests repeatable. Tearing down
`ac-e2e` with `down -v` is the one deletion this process makes without
approval (an exception to "Nothing in this process deletes" in
`docs/process.md`), and only of what the script itself created. Tokens are
stored hashed (decision 5), so a link exists only in the UI that made it,
and a test backdoor or fake clock would put test code into the production
image; the expired-link case therefore waits once, at most about 2 min 15 s,
for a start it chose, and the at-risk cases pick start times so the rule
applies on read (decision 4). Business settings are one shared row that a
test changes, so tests run one at a time, and a retry would hide a flaky
test instead of fixing it.

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
