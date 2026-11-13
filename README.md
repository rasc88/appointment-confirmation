# Appointment Confirmation

[![CI](https://github.com/rasc88/appointment-confirmation/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/rasc88/appointment-confirmation/actions/workflows/ci.yml)

## Problem and what the app does

Small service businesses (salons, physiotherapists, tutors, repair shops)
lose income when clients miss appointments without warning: the slot
stays empty and the staff member who kept it free earns nothing.
Appointment Confirmation lets staff send each client a private link to
confirm or cancel, and shows on one dashboard which appointments are
confirmed, cancelled, or at risk of becoming a no-show.

- **Staff** sign in, record appointments, copy each client's confirmation
  link (or a ready-made message) to send through the messaging app they
  already use, confirm or cancel for a client, and mark appointments as
  attended or no-show afterwards. They also add staff accounts and edit
  the business settings.
- **Clients** open the link on their phone and confirm or cancel with one
  tap, without an account.

Expected behaviour:

- An appointment is `pending`, `confirmed`, `cancelled`, `attended`, or
  `no_show` (no-show). Confirm and cancel happen before the start time;
  attended and no-show are marked after it
  ([spec section 7](docs/spec.md#7-appointment-state-machine)).
- A `pending` or `confirmed` appointment that has not started is **at
  risk** with one or both reasons
  ([spec section 6.5](docs/spec.md#65-at-risk-rules)):
  - "No reply yet": still `pending` and starting within
    `noReplyWindowHours` (default 24)
  - "Missed N before": the client has at least `noShowThreshold`
    (default 1) no-shows in the last `noShowLookbackDays` (default 180)
- A cancellation made less than `lateCancellationHours` (default 12)
  before the start is flagged **Late cancellation**, so staff know the
  slot may still be refillable. Every threshold is a business setting
  that staff change on the Settings page.
- After the start time, the link no longer accepts confirm or cancel.
- Regenerating a link makes the old link return 404.
- The dashboard refreshes every 30 seconds without a page reload.

The rest is in the full product and technical specification,
[docs/spec.md](docs/spec.md), including its
[MVP acceptance criteria](docs/spec.md#16-mvp-acceptance-criteria).

## Live demo

- Dev: Not deployed yet - the repository owner adds this address after the first deploy (#64).
- Production: Not deployed yet - the repository owner adds this address after the first deploy (#64).

Demo logins, **dev only**: `alex@demo.test` and `sam@demo.test`, password
`demo1234`. Production has no demo data and no demo login.

What you cannot guess:

- Dev is a shared public demo: other reviewers may have changed the data.
  Type made-up names and phone numbers, never real ones.
- All times are in the business time zone shown on the dashboard
  (`Europe/Madrid` in the demo), not your own.
- The demo appointments are placed around the moment the database was
  seeded. If "today" is empty, pick an earlier date on the dashboard or
  create a new appointment.
- To see the client side: create or open an appointment, press Copy link,
  and open the link in a private window (no account needed).

## Run locally

Prerequisite: Docker with Compose.

```sh
docker compose up --build
```

Then open `http://localhost:8080` and sign in with the same demo logins.
The command starts Postgres and the app, applies the database migrations,
and seeds the demo data when the database is empty. `docker compose down`
keeps the data.

For the development setup (`npm run dev` with reload), see
[AGENTS.md](AGENTS.md).

## Tests

With Node 24 (`nvm use`) and `npm install`:

```sh
docker compose up -d db
npm test
```

`npm test` runs the Vitest unit and integration tests: the backend
against a real Postgres database, `appointments_test`, and the frontend
with React Testing Library.

```sh
npx playwright install --with-deps chromium   # once
npm run test:e2e
```

`npm run test:e2e` runs Playwright against a throwaway Docker Compose
stack.

CI runs all of them on every pull request
([.github/workflows/ci.yml](.github/workflows/ci.yml)).

## For reviewers: rubric map

The course's [project rubric](https://github.com/DataTalksClub/ai-dev-tools-zoomcamp/tree/main/project)
has 12 criteria. Where to find the evidence for each:

| Criterion | Where to look |
|---|---|
| Problem Description | [Problem and what the app does](#problem-and-what-the-app-does) above |
| Product Specification | [docs/spec.md](docs/spec.md), [openapi.yaml](openapi.yaml), the public [issue tracker](https://github.com/rasc88/appointment-confirmation/issues), a groomed issue with acceptance criteria ([#21](https://github.com/rasc88/appointment-confirmation/issues/21)), and the template every groomed issue follows, [docs/task-template.md](docs/task-template.md) |
| Agent Team Specification | [docs/process.md](docs/process.md), [docs/team/](docs/team/), [.claude/agents/](.claude/agents/), and [How the agents built it](#how-the-agents-built-it) below |
| Context Management | [AGENTS.md](AGENTS.md) (and [CLAUDE.md](CLAUDE.md), which is `@AGENTS.md`), [docs/decisions.md](docs/decisions.md), [docs/process.md](docs/process.md), [docs/team/](docs/team/) |
| Application | `docker compose up --build` ([Run locally](#run-locally)), [frontend/](frontend/), [backend/](backend/), [backend/prisma/schema.prisma](backend/prisma/schema.prisma) |
| Testing | `npm test` and `npm run test:e2e` ([Tests](#tests)), [e2e/tests/](e2e/tests/); examples: backend integration [backend/src/public-routes.test.ts](backend/src/public-routes.test.ts), unit [backend/src/at-risk.test.ts](backend/src/at-risk.test.ts), frontend [frontend/src/pages/DashboardPage.test.tsx](frontend/src/pages/DashboardPage.test.tsx) |
| Containerization | [Dockerfile](Dockerfile), [docker-compose.yaml](docker-compose.yaml) |
| Deployment | [infra/cloudformation.yaml](infra/cloudformation.yaml), [infra/deploy.sh](infra/deploy.sh), [infra/remote-deploy.sh](infra/remote-deploy.sh), [spec section 10.4](docs/spec.md#104-deployment-layout-and-cost), [Live demo](#live-demo), [docs/operations.md](docs/operations.md). Not deployed yet: the live URLs come with [#64](https://github.com/rasc88/appointment-confirmation/issues/64) |
| CI/CD | [ci.yml](.github/workflows/ci.yml) (three required checks on every pull request; [runs](https://github.com/rasc88/appointment-confirmation/actions/workflows/ci.yml)), [deploy.yml](.github/workflows/deploy.yml) (every merge to `main` deploys to dev; [runs](https://github.com/rasc88/appointment-confirmation/actions/workflows/deploy.yml)), [promote.yml](.github/workflows/promote.yml) (manual, owner-approved promotion of the image dev runs; [runs](https://github.com/rasc88/appointment-confirmation/actions/workflows/promote.yml)), and the rollback line under [Operations](#operations) |
| Observability | [spec section 15](docs/spec.md#15-observability-and-alerting), [backend/src/telemetry.ts](backend/src/telemetry.ts), [backend/src/request-telemetry.ts](backend/src/request-telemetry.ts), [backend/src/metrics.ts](backend/src/metrics.ts), [backend/src/logger.ts](backend/src/logger.ts), [observability/dashboard.json](observability/dashboard.json), and the test that proves no client data is exported: [backend/src/telemetry.test.ts](backend/src/telemetry.test.ts), "records no token, client name, phone, search term or /c/ path". Not there yet: Grafana UI evidence, which comes with [#64](https://github.com/rasc88/appointment-confirmation/issues/64) |
| Alerting on User Impact | [spec section 15.2](docs/spec.md#152-alert): "Clients cannot confirm" fires on failed client confirms or cancels, 1 or more in production or 3 or more in dev, within 5 minutes; [observability/alert-rule.json](observability/alert-rule.json) |
| On-Call Agent | [spec section 15.3](docs/spec.md#153-on-call-agent), [docs/team/on-call-engineer.md](docs/team/on-call-engineer.md), [.claude/agents/on-call-engineer.md](.claude/agents/on-call-engineer.md), [oncall/oncall.sh](oncall/oncall.sh), [#22](https://github.com/rasc88/appointment-confirmation/issues/22). The agent wakes on a firing alert and answers with a fix pull request with a regression test and an incident issue; the fix merges only through QA and CI, and reaches production only through the owner's promotion (decision 41). Not there yet: the recorded demo run, [#62](https://github.com/rasc88/appointment-confirmation/issues/62) |

## How the agents built it

Every change was made by AI agents (Claude Code) following a written
process, with one person, the repository owner, answering questions and
releasing to production.

| Role | Does | Instructions | Agent definition |
|---|---|---|---|
| Orchestrator | Picks the next issue, launches the other roles, squash-merges | [docs/process.md](docs/process.md) | The main Claude Code session |
| PM | Grooms an issue into the task template before anyone implements it | [docs/team/pm.md](docs/team/pm.md) | [.claude/agents/pm.md](.claude/agents/pm.md) |
| Engineer | Implements one groomed issue and opens its pull request | [docs/team/software-engineer.md](docs/team/software-engineer.md) | [.claude/agents/software-engineer.md](.claude/agents/software-engineer.md) |
| QA | Checks the pull request against the acceptance criteria | [docs/team/qa-engineer.md](docs/team/qa-engineer.md) | [.claude/agents/qa-engineer.md](.claude/agents/qa-engineer.md) |
| On-call engineer | Investigates a firing alert and proposes a fix | [docs/team/on-call-engineer.md](docs/team/on-call-engineer.md) | [.claude/agents/on-call-engineer.md](.claude/agents/on-call-engineer.md) |
| Repository owner (a person) | Answers open questions, promotes releases to production | [docs/process.md](docs/process.md), [docs/operations.md](docs/operations.md) | - |

The PM grooms each issue, the engineer opens a pull request, CI runs, QA
posts PASS or FAIL, and the orchestrator squash-merges on PASS with CI
green; only the owner promotes to production
([docs/process.md](docs/process.md) has the diagram). The PM and QA
agents have no Edit or Write tools, so they cannot change code. Each step
leaves a comment on the issue headed `## PM: groomed`,
`## Engineer: ready for QA`, and `## QA: PASS` or `## QA: FAIL`.

Worked examples:

- [#7](https://github.com/rasc88/appointment-confirmation/issues/7), QA
  FAIL then PASS:
  [PM groomed](https://github.com/rasc88/appointment-confirmation/issues/7#issuecomment-6783616587),
  [the owner answered the PM's questions](https://github.com/rasc88/appointment-confirmation/issues/7#issuecomment-6783721453),
  [QA FAIL](https://github.com/rasc88/appointment-confirmation/issues/7#issuecomment-6783999269)
  because the dashboard's counts scrolled out of view instead of staying
  sticky with the filters as the criterion required,
  [QA PASS](https://github.com/rasc88/appointment-confirmation/issues/7#issuecomment-6784533019)
  after the fix, merged as
  [PR #33](https://github.com/rasc88/appointment-confirmation/pull/33).
- [#21](https://github.com/rasc88/appointment-confirmation/issues/21), QA
  tested against a real Grafana:
  [PM groomed](https://github.com/rasc88/appointment-confirmation/issues/21#issuecomment-6833360319),
  [the owner answered](https://github.com/rasc88/appointment-confirmation/issues/21#issuecomment-6835326638),
  [QA FAIL](https://github.com/rasc88/appointment-confirmation/issues/21#issuecomment-6836080990):
  running `push.sh` against a throwaway Grafana OSS container found two
  bugs the stubbed check could not (the contact-point lookup and a
  folder/dashboard uid clash),
  [the PM re-groomed the criteria in the same round](https://github.com/rasc88/appointment-confirmation/issues/21#issuecomment-6836099986),
  [QA PASS](https://github.com/rasc88/appointment-confirmation/issues/21#issuecomment-6836396402),
  merged as [PR #61](https://github.com/rasc88/appointment-confirmation/pull/61).
- [#22](https://github.com/rasc88/appointment-confirmation/issues/22),
  owner decisions and a follow-up:
  [PM groomed](https://github.com/rasc88/appointment-confirmation/issues/22#issuecomment-6836478627),
  [follow-up #62 filed](https://github.com/rasc88/appointment-confirmation/issues/22#issuecomment-6836487831),
  [the owner answered](https://github.com/rasc88/appointment-confirmation/issues/22#issuecomment-6862113685),
  [QA FAIL](https://github.com/rasc88/appointment-confirmation/issues/22#issuecomment-6862978645):
  the agent's push allowlist could delete remote branches, and a
  malformed state file relaunched agents,
  [QA PASS](https://github.com/rasc88/appointment-confirmation/issues/22#issuecomment-6863318329),
  merged as [PR #63](https://github.com/rasc88/appointment-confirmation/pull/63).

## Architecture

| Layer | Choice |
|---|---|
| Frontend | Vite, React, TypeScript |
| Backend | Node.js 24, Express 5, TypeScript, Prisma, PostgreSQL 17 |
| Container | One image serving the API under `/v1` and the built frontend |
| Hosting | One AWS EC2 instance running dev and production, each behind CloudFront |
| CI/CD | GitHub Actions |
| Telemetry | OpenTelemetry to Grafana Cloud |

Details in [spec section 10](docs/spec.md#10-technical-architecture).

## Operations

Deploying, promoting to production, telemetry and alerting setup, and the
on-call poller are the repository owner's steps, in
[docs/operations.md](docs/operations.md).

Rollback: revert the bad commit on `main` through a pull request; `Deploy`
puts the revert on dev; the owner promotes it.
