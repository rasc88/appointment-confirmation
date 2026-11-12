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

### 36. Telemetry is the OpenTelemetry Node SDK with hand-made request spans, on only when an OTLP endpoint is set

The backend starts `@opentelemetry/sdk-node` only when `OTEL_EXPORTER_OTLP_ENDPOINT` is set, with the http/protobuf OTLP exporters, batch span and log processors at their defaults, and a 60-second metric reader. There are no auto-instrumentations. One Express middleware makes the request span, the request log line, and the duration histogram, naming the route only by its Express template; the four §15.1 counters are added in the route handlers and the error handler. Logs are JSON lines from a small logger module that also emits OTLP log records. A response failure is a `5xx` on a confirm or cancel.

Why: spans built by the app hold only the attributes it chooses, so no header, raw path, or query can leak, whereas `instrumentation-http` records `url.path` and needs an allow-list to undo it, and `instrumentation-express` needs an ESM loader hook alongside `tsx`. Prisma's instrumentation was left out for the same reason: its spans carry SQL text and another version pin, for little gain at this size (#54). With no module patching, importing the telemetry module first in `server.ts` is enough, and tests, the seed, and local runs never start the SDK. Off by default means local development, tests, CI, and e2e need no account and send nothing. A pino-style logger was not needed for two levels and a handful of lines. Counting only `5xx` keeps token guessing (`404`, `429`) and late clicks (`409`) from paging anyone. Cost accepted: traces have one span per request, with no database child spans, and a failure before the request reaches the app (CloudFront, a stopped container) is not counted.

### 37. The AWS stack is one CloudFormation template; the host deploys from a git checkout with secrets made on the instance

`infra/cloudformation.yaml` creates, in `us-east-1` only (a `Rules`
assertion), its own VPC with one public subnet, a `t4g.small` on Amazon
Linux 2023 arm64 with an Elastic IP, IMDSv2 required, and no key pair, one
security group rule (TCP 8081-8082 from CloudFront's origin-facing prefix
list), two CloudFront distributions with caching off, the two
`public-base-url` String parameters, and a GitHub OIDC role that may only
run `AWS-RunShellScript` on that instance. The AMI is a plain
`AWS::EC2::Image::Id` parameter. First-boot user data installs Docker,
git, and a pinned, checksummed Compose plugin, clones the repository, and
starts nothing. `infra/deploy.sh` writes each environment's `.env` and
runs `infra/compose.yaml` as project `ac-dev` or `ac-prod`, adding
`infra/compose.dev.yaml` (the seed step) for dev only, then prunes unused
images. It pulls only images not already on the host (`--policy missing`).

Why:
- **Amazon Linux 2023**: the SSM agent and the AWS CLI come preinstalled,
  and `deploy.sh` needs the CLI for Parameter Store; only the Compose
  plugin is downloaded, pinned and checked against its SHA-256.
- **Plain AMI parameter**: an SSM-path parameter type is re-resolved on
  every stack update, so a newer AMI would silently replace the instance
  and lose both databases.
- **Secrets**: `SESSION_SECRET` and the Postgres password are generated on
  the instance by the first deploy and never leave it, so there is no
  owner step and nothing to leak in transit, and a later deploy reuses them
  and signs nobody out. The only external secret, the Grafana OTLP
  headers, is a SecureString the owner creates, because CloudFormation
  cannot create SecureStrings and a `NoEcho` parameter would end up in user
  data. The stack writes `PUBLIC_BASE_URL` to a String parameter, so the
  instance never depends on the distributions at boot.
- **Compose files from a git checkout** of the public repository: #19
  checks out the image's commit before calling `deploy.sh`, so Compose
  file and image always match, and no Compose content is duplicated in
  user data.
- **Dev seeds through `compose.dev.yaml`, production never**: the same
  command as local Compose (decision 33); the production files have no
  seed step, and the seed's own `APP_ENV=production` refusal is the second
  guard. Dev is a public demo with the demo logins (owner decision).
- **One security group rule for 8081-8082**: a prefix-list reference
  counts as the list's maximum size (55 for CloudFront) against the
  60-rules-per-group quota, so two rules would exceed it. Any CloudFront
  distribution can reach the ports, not only ours; accepted, because the
  app has its own auth and rate limits, and a secret origin header would
  be one more secret to manage.
- **Own VPC and an Elastic IP**: CloudFront needs a DNS name as its
  origin, and the Elastic IP keeps it stable across stop and start at the
  same price as an auto-assigned public IPv4; deleting the stack removes
  everything it made. The template builds the origin name
  (`ec2-a-b-c-d.compute-1.amazonaws.com`) from the address, which is why
  the stack is limited to `us-east-1`.
- **Pruning images**: on a 20 GiB disk old tags would fill it; a rollback
  pulls its tag again from GHCR. Pulling only missing images lets a tag
  built on the instance deploy too, and a tag that is neither local nor in
  the registry still fails before anything running is touched.
- **No template linter and no new tools** (owner decision): QA reads the
  template; mistakes show up when the owner deploys.

Cost accepted: there are no backups (owner decision), so losing the
instance or deleting the stack loses all data; a mutable tag already on
the host is not pulled again, so deploys use immutable tags.

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

### 35. CI runs three parallel jobs and `main` requires all three

One workflow, `.github/workflows/ci.yml` (`CI`), runs on every pull request
to `main` and every push to `main`, with no path filters, read-only
`contents` permission, no secrets, and cancel-in-progress per ref. Its jobs
`lint-typecheck`, `test` (with a `postgres:17` service), and `e2e` run in
parallel on `ubuntu-24.04`, have no `name:` key, and use only GitHub's own
`actions/*` actions pinned to major tags. Playwright browsers are not
cached; a failed `e2e` uploads its report and traces for 7 days. `main`
requires a pull request with 0 approvals, the three checks green, and the
branch up to date; admins are not enforced, and force pushes and deletion
are blocked.

Why: the wall-clock time is the slowest job (e2e) instead of the sum,
public-repository minutes are free, and three checks show at a glance
which kind of failure it is. All three are required because spec §16 and
this process require lint, typecheck, and tests in CI, and e2e is the only
check of the Docker image before #19 deploys it. Protection matches check
names as strings, so the job id is the only name a job has, and a display
name edit cannot break merging. GitHub's own actions with a read-only
token and no secrets gain little from SHA pins, which would need a bot to
keep current. A fixed runner image keeps a silent `ubuntu-latest` move
from breaking `--with-deps`. Playwright advises against caching browsers,
and `--with-deps` needs apt anyway. `e2e` brings its own database
(decision 34). No path filters, because a required check that never starts
blocks a docs-only pull request forever. 0 approvals still refuses a
direct push to `main`, while one approval would block every merge, since
every agent acts as the same account. Admins stay unenforced so the owner
can merge when CI itself is broken (decision 14); agents never pass
`--admin`. Cost accepted: every pull request waits for the e2e job, and
renaming a job means updating the protection in the same pull request.
