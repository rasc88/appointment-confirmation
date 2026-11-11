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

Commands

These are the commands the scaffolding issues must provide. Until an issue
adds one, it does not exist yet - check `package.json` before relying on it.

Use Node 24 (`nvm use` reads `.nvmrc`). `.env.example` lists the local
settings: `DATABASE_URL` points at the Postgres that `docker compose up -d db`
starts, `PORT` is the backend port, `SESSION_SECRET` signs session cookies
(at least 32 characters; the value there is local only), and
`PUBLIC_BASE_URL` is the address the browser uses (`http://localhost:5173`).
The backend exits on start when either of the last two is missing or
invalid. Copy it to `.env` (ignored by git).
`npm run dev`, `npm run db:migrate`, and `npm run db:seed` read `.env`; a
value set in the shell wins, for example `PORT=3001 npm run dev`, and a
missing `.env` is not an error. Tests ignore both and always use
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
- `npm run db:migrate` - apply Prisma migrations (`prisma migrate dev`).
  After changing `backend/prisma/schema.prisma`, create its migration with
  `npm run db:migrate -- --name <what-changed>`
- `npm run db:seed` - wipe every row in the database `DATABASE_URL` points
  at and fill it with the demo data from `docs/spec.md` section 17. Demo
  logins: `alex@demo.test` and `sam@demo.test`, password `demo1234`.
  Refuses to run when `APP_ENV=production`
- `npm test` - Vitest once (no watch) in every workspace except e2e. Needs
  `docker compose up -d db`; backend tests migrate and use
  `appointments_test`, one file at a time
- `npm run lint` - ESLint with typescript-eslint, every workspace, from the
  one root `eslint.config.js`, then Redocly on `openapi.yaml`
  (`npm run lint:openapi` runs only Redocly; rules in `redocly.yaml`)
- `npm run typecheck` - `tsc --noEmit`, every workspace
- `npm run test:e2e` - Playwright against the Docker Compose stack
- `docker compose up --build` - the whole app with Postgres, one command

Rules

- PostgreSQL everywhere, including tests. There is no SQLite fallback.
- Tests that need a database use their own database (`appointments_test`),
  never the development one.
- Client names, phone numbers, and confirmation tokens never go into logs,
  traces, or metrics.
- Business rules (hours, thresholds, message wording) live in business
  settings in the database, not in environment variables or constants.
- `npm run lint` and `npm run typecheck` must pass before any commit.
- Ask before adding a dependency that the spec or an issue doesn't name.
- When you add or change a command, update this file in the same commit.
