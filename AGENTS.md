Appointment Confirmation: staff of a small service business record
appointments and send each client a private link to confirm or cancel. A
dashboard shows which appointments are confirmed, cancelled, or at risk of
becoming a no-show. See `docs/spec.md` for the full product and technical
specification.

Documents

- `docs/spec.md` - what the app does, data model, API, deployment, acceptance
  criteria
- `docs/decisions.md` - the calls already made, with reasons
- `docs/process.md` - how work moves from a GitHub issue to merged code
- `docs/task-template.md` - the format every groomed issue follows
- `docs/team/` - one file per agent role: PM, engineer, QA, on-call engineer
- `openapi.yaml` - the API contract

Layout

An npm workspaces monorepo:

- `backend/` - Express 5 + TypeScript API, Prisma schema and migrations
- `frontend/` - Vite + React + TypeScript
- `e2e/` - Playwright tests against the Docker Compose stack
- `infra/` - the AWS side (decision 37): `cloudformation.yaml` (the stack),
  `compose.yaml` and `compose.dev.yaml` (one environment on the instance),
  `deploy.sh <dev|prod> <image-ref>`, which runs as root on the
  instance, and `remote-deploy.sh <dev|prod> <commit-sha>`, which runs on
  the GitHub runner and calls `deploy.sh` over SSM, then waits for
  `/v1/health` to report the SHA. Agents never deploy and never
  run `aws`; they check these files offline with `docker compose config`
  and `bash -n`. The owner's steps are in the README's "Deploy to AWS"
- `.github/workflows/deploy.yml` (`Deploy`) - on every push to `main`,
  builds one arm64 image tagged with the commit SHA, pushes it to GHCR,
  and deploys it to dev; `.github/workflows/promote.yml` (`Promote to
  production`) - run by hand by the owner only, deploys the SHA dev
  reports to production (decision 38). Agents never run `promote.yml`,
  never re-run `Deploy` jobs, and check these files offline only (YAML
  parse, `bash -n` on each `run:` block, a stubbed run of
  `remote-deploy.sh`)

Commands

These are the commands the scaffolding issues must provide. Until an issue
adds one, it does not exist yet - check `package.json` before relying on it.

Use Node 24 (`nvm use` reads `.nvmrc`). `.env.example` lists the local
settings: `DATABASE_URL` points at the Postgres that `docker compose up -d db`
starts, `PORT` is the backend port, `SESSION_SECRET` signs session cookies
(at least 32 characters; the value there is local only), and
`PUBLIC_BASE_URL` is the address the browser uses (`http://localhost:5173`
under `npm run dev`, the backend's own address under `npm start`).
The backend exits on start when either of the last two is missing or
invalid. It also lists, commented out, the telemetry variables:
`OTEL_EXPORTER_OTLP_ENDPOINT` turns OTLP export of traces, metrics, and logs
on; it is unset in the normal local setup, and then nothing is exported and
logs go only to stdout. `OTEL_EXPORTER_OTLP_HEADERS` carries the
authorization header and `OTEL_SERVICE_NAME` defaults to
`appointment-confirmation`. The Grafana Cloud values come from the
repository owner (#21). Copy it to `.env` (ignored by git).
`npm run dev`, `npm start`, `npm run db:migrate`, and `npm run db:seed`
read `.env`; a value set in the shell wins, for example
`PORT=3001 npm run dev`, and a missing `.env` is not an error. Tests ignore both and always use
`appointments_test`.

- `npm install` - install every workspace
- `docker compose up -d db` - start only Postgres 17 on `localhost:5432`
  (user and password `app`), with the `appointments` and
  `appointments_test` databases, for local development
- `npm run dev` - backend on `PORT` (default 3000) and Vite on
  `http://localhost:5173`, with reload; Vite proxies `/v1` to the backend
  on the same `PORT`. Needs `docker compose up -d db` and
  `npm run db:migrate` first; the backend creates the settings row on
  start and exits if the database is unreachable or not migrated
- `npm run build` - build the frontend (`vite build`) into `frontend/dist`
- `npm start` - the backend on `PORT` with no reload, from TypeScript
  source with `tsx`, serving the API and, when `frontend/dist` exists, the
  built frontend on the same origin; without a build it logs one line and
  serves only the API. To run the single-origin app locally:
  `docker compose up -d db`, `npm run db:migrate`, `npm run build`, then
  `PUBLIC_BASE_URL=http://localhost:3000 npm start` and open that address.
  `PUBLIC_BASE_URL` must be the address the browser opens, or writes get
  `403 cross_site_request` and confirmation links point at the wrong port.
  For development keep `npm run dev` with `PUBLIC_BASE_URL=http://localhost:5173`
- `npm run db:migrate` - apply Prisma migrations (`prisma migrate dev`).
  After changing `backend/prisma/schema.prisma`, create its migration with
  `npm run db:migrate -- --name <what-changed>`
- `npm run db:seed` - wipe every row in the database `DATABASE_URL` points
  at and fill it with the demo data from `docs/spec.md` section 17. Demo
  logins: `alex@demo.test` and `sam@demo.test`, password `demo1234`.
  Refuses to run when `APP_ENV=production`
- `npm run db:seed:if-empty` - the same seed, but only when the database
  has no staff member; otherwise it logs one line and changes nothing.
  Also refuses `APP_ENV=production`
- `npm test` - Vitest once (no watch) in every workspace except e2e. Needs
  `docker compose up -d db`; backend tests migrate and use
  `appointments_test`, one file at a time
- `npm run lint` - ESLint with typescript-eslint, every workspace, from the
  one root `eslint.config.js`, then Redocly on `openapi.yaml`
  (`npm run lint:openapi` runs only Redocly; rules in `redocly.yaml`)
- `npm run typecheck` - `tsc --noEmit`, every workspace
- `npm run test:e2e` - Playwright in Chromium against a throwaway copy of
  the Docker Compose stack. Needs Docker with Compose 2.24.4 or later (for
  `!reset`/`!override` in `e2e/compose.e2e.yaml`) and, once after
  `npm install`, `npx playwright install --with-deps chromium` from the
  repository root (`--with-deps` installs the system libraries with sudo;
  where they are already present, `npx playwright install chromium` is
  enough). It builds the image and starts a separate Compose project
  `ac-e2e` on `http://localhost:8085` with its own database volume, waits
  for `/v1/health`, runs the suite, and removes the project with
  `down -v`, so it runs alongside the dev stack and never touches
  `appointments`. On failure, traces and screenshots go to
  `e2e/test-results/`; the HTML report is always written to
  `e2e/playwright-report/` (`npx playwright show-report e2e/playwright-report`)
- `docker compose up --build` - the whole app with Postgres, one command,
  at `http://localhost:8080`, using the same `appointments` database as
  `npm run dev`. Every start applies migrations (`prisma migrate deploy`),
  then seeds the demo data only when the database has no staff
  (`npm run db:seed:if-empty`). `docker compose down` keeps the data; only
  `docker compose down -v` removes it. To refresh the demo data, run
  `docker compose exec app npm run db:seed` (wipes every row)
- `GET /v1/health` - no session needed: `200` with
  `{"status":"ok","environment":...,"version":...}` after a database round
  trip, `503` with `"status":"unavailable"` when the database is down.
  `environment` is `APP_ENV` and `version` is `APP_VERSION` (the image's
  `--build-arg APP_VERSION`), each `unknown` when unset

Rules

- PostgreSQL everywhere, including tests. There is no SQLite fallback.
- Tests that need a database use their own database (`appointments_test`),
  never the development one.
- Client names, phone numbers, and confirmation tokens never go into logs,
  traces, or metrics.
- Backend code logs through the logger module, never `console.*`; log only
  route templates, never a raw path, query, header, or error message.
- Business rules (hours, thresholds, message wording) live in business
  settings in the database, not in environment variables or constants.
- `npm run lint` and `npm run typecheck` must pass before any commit.
- CI (`.github/workflows/ci.yml`) runs `npm run lint`, `npm run typecheck`,
  `npm test`, and `npm run test:e2e` on every pull request to `main`, and
  its three checks (`lint-typecheck`, `test`, `e2e`) must pass to merge.
- Ask before adding a dependency that the spec or an issue doesn't name.
- When you add or change a command, update this file in the same commit.
