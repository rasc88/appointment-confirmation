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
- `openapi.yaml` - the API contract (added by the contract issue)

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
starts, and `PORT` is the backend port. Copy it to `.env` (ignored by git).
Nothing reads `.env` yet, so set `PORT` in the shell to change it, for
example `PORT=3001 npm run dev`.

- `npm install` - install every workspace
- `docker compose up -d db` - start only Postgres 17 on `localhost:5432`
  (user and password `app`), with the `appointments` and
  `appointments_test` databases, for local development
- `npm run dev` - backend on `PORT` (default 3000) and Vite on
  `http://localhost:5173`, with reload; Vite proxies `/v1` to the backend
  on the same `PORT`. Does not need Postgres
- `npm run db:migrate` - apply Prisma migrations (`prisma migrate dev`)
- `npm run db:seed` - reset and fill the database with the demo data from
  `docs/spec.md` section 17
- `npm test` - Vitest once (no watch) in every workspace except e2e
- `npm run lint` - ESLint with typescript-eslint, every workspace, from the
  one root `eslint.config.js`
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
