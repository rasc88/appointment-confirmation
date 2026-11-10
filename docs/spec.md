# Appointment Confirmation

## Product and Technical Specification — MVP v1.0

**Status:** Draft  
**Date:** November 10, 2026  
**Audience:** Product, Engineering, QA, and Operations  

---

## 1. Product Summary

Small service businesses (salons, physiotherapists, tutors, repair shops) lose income when clients miss appointments without warning. The slot stays empty, and the staff member who kept it free earns nothing.

**Appointment Confirmation** is a browser-based tool for a single business with several staff members. Staff record upcoming appointments, send each client a private confirmation link through the messaging app they already use, and see on one dashboard which appointments are confirmed, cancelled, or **at risk** of becoming a no-show. Clients open the link on their phone and confirm or cancel with one tap, without creating an account.

After each appointment, staff mark it as attended or no-show. That history feeds back into the at-risk rules, so repeat no-shows stand out before their next visit.

---

## 2. Goals

The MVP must:

1. Allow staff to sign in with email and password.
2. Allow staff to create, edit, confirm, and cancel appointments for any staff member, for example when a client replies by phone instead of using the link.
3. Generate a unique, unguessable confirmation link per appointment that staff can copy and send themselves.
4. Allow clients to confirm or cancel through that link without an account.
5. Show a dashboard for a chosen day, grouped by status, with at-risk appointments highlighted.
6. Allow staff to mark past appointments as attended or no-show, and keep each client's history.
7. Persist all data in PostgreSQL.

---

## 3. Non-Goals for MVP

The following are intentionally excluded:

- Sending SMS, email, or WhatsApp messages from the app. Staff send the link themselves.
- Automatic reminders or scheduled jobs.
- Online self-booking by clients, or rescheduling through the link.
- Deposits, payments, or cancellation fees.
- Multiple businesses (multi-tenant). One deployment serves one business.
- Roles and permissions between staff. All staff are equal.
- Calendar sync (Google Calendar, Outlook) or overlap detection between appointments.
- Real-time push updates. The dashboard refreshes by polling.
- Native mobile apps. The web UI is responsive instead.

---

## 4. Users and Roles

### 4.1 Staff Member
An authenticated user of the business who can:
- Sign in and sign out with email and password.
- Add other staff accounts.
- Create, edit, and cancel appointments for any staff member.
- Confirm or cancel an appointment on the client's behalf, when the client replies by phone, message, or in person.
- Copy an appointment's confirmation link or ready-to-send message.
- Regenerate a confirmation link, which invalidates the previous one.
- View the dashboard for any day, optionally filtered by staff member.
- Mark past appointments as attended or no-show.
- View a client's appointment history and no-show count.

### 4.2 Client
An unauthenticated visitor holding a confirmation link who can:
- See the business name, service, staff member, date, and time of their appointment.
- Confirm the appointment.
- Cancel the appointment.
- Not see any other client's data, or any appointment other than their own.

---

## 5. Core User Flows

```mermaid
sequenceDiagram
    actor S as Staff
    participant A as App
    actor C as Client
    S->>A: Create appointment (client, staff, service, time)
    A-->>S: Confirmation link + message text
    S->>C: Sends link via WhatsApp / SMS (outside the app)
    C->>A: Opens link
    A-->>C: Appointment details
    C->>A: Confirm or Cancel
    A-->>S: Dashboard shows new status on next refresh
    S->>A: After the visit, mark attended or no-show
```

### 5.1 Creating an Appointment
Staff pick an existing client or create a new one (name, optional phone), choose the staff member, enter the service name, start time, and duration. The app creates the appointment in `pending` status with a fresh confirmation token and shows a **Copy link** button and a **Copy message** button. The message is a short, pre-filled text containing the business name, date, time, and link.

### 5.2 Client Confirms or Cancels
The client opens `/c/{token}`. If the appointment is `pending`, they see **Confirm** and **Cancel**. If already `confirmed`, they see the confirmation and a **Cancel** option. Cancelling asks for a second tap to prevent accidents. After the appointment start time, the link shows a read-only "this appointment has passed" page.

### 5.3 Daily Dashboard
Staff open the dashboard, which defaults to today in the business time zone. Appointments are grouped as **At risk**, **Pending**, **Confirmed**, **Cancelled**, and **Completed** (attended or no-show), each sorted by start time. A date picker and a staff filter narrow the view. The page polls for updates every 30 seconds.

### 5.4 Staff Confirms or Cancels for the Client
When a client replies outside the link (a phone call, a chat message, or at the front desk), staff open the appointment on the dashboard and tap **Confirm** or **Cancel**. Cancelling asks for a second tap, as on the client page. The appointment records that staff made the change, so the dashboard can show "Confirmed by staff" or "Confirmed by client".

### 5.5 Closing the Day
For each appointment whose start time has passed, staff mark **Attended** or **No-show**. Unmarked past appointments stay visible in a "Needs outcome" group until marked.

---

## 6. Functional Requirements

### 6.1 Authentication and Staff Accounts
- Email and password sign-in. Passwords are hashed with a slow hash (bcrypt or argon2).
- The session is a signed token in an `HttpOnly`, `Secure`, `SameSite=Lax` cookie, valid for 12 hours.
- Any signed-in staff member can add a staff account (name, email, initial password).
- Staff accounts cannot be deleted in the MVP. They can be marked inactive, which blocks sign-in and hides them from the staff picker.

### 6.2 Clients
- A client has a name and an optional phone number.
- Staff can search clients by name or phone when creating an appointment.
- A client page lists their appointments and their no-show count.

### 6.3 Appointments
- Fields: client, staff member, service name, start time, duration in minutes.
- Staff can edit any field while the appointment is `pending` or `confirmed`. Editing the start time resets status to `pending`, because the client confirmed a different time.
- Staff can confirm a `pending` appointment before its start time. The confirmation records that it was confirmed by staff.
- Staff can cancel a `pending` or `confirmed` appointment. The cancellation records that it was cancelled by staff.

### 6.4 Confirmation Link
- The link is `/c/{token}`, where the token is at least 128 bits of cryptographically random data, URL-safe encoded.
- The token is stored hashed, so a database leak does not expose working links.
- The link stops accepting actions once the appointment has started.
- Regenerating a link invalidates the previous token immediately.

### 6.5 At-Risk Rules
An appointment is **at risk** when it is `pending` or `confirmed` and any of these is true:

| Rule | Condition | Shown reason |
|---|---|---|
| No reply | Status is `pending` and the start time is within 24 hours | "No reply yet" |
| History | The client has 1 or more `no_show` appointments in the last 180 days | "Missed N before" |

A cancellation made less than 12 hours before the start time is flagged **Late cancellation**, so staff know the slot may still be refillable.

All thresholds are constants in one module so they can be tuned later.

### 6.6 Dashboard
- Defaults to today in the business time zone.
- Shows each appointment's time, client name, staff member, service, status, and at-risk reasons.
- Shows counts per group at the top.
- Refreshes every 30 seconds without a full page reload.

---

## 7. Appointment State Machine

| From | Action | Actor | To |
|---|---|---|---|
| — | Create | Staff | `pending` |
| `pending` | Confirm (before start) | Client or Staff | `confirmed` |
| `pending`, `confirmed` | Cancel | Client or Staff | `cancelled` |
| `confirmed` | Change start time | Staff | `pending` |
| `pending`, `confirmed` | Mark attended (after start) | Staff | `attended` |
| `pending`, `confirmed` | Mark no-show (after start) | Staff | `no_show` |
| `attended`, `no_show` | Undo outcome | Staff | previous status |

- `cancelled` is final in the MVP. A client who changes their mind contacts the business, and staff create a new appointment.
- Confirming an already `confirmed` appointment succeeds without changes, so double taps are harmless.
- Any other transition is rejected with `409 Conflict`.

---

## 8. UX Layout and Responsive Design

- **Client page:** mobile-first, a single card with the appointment details and large buttons. No navigation, no sign-in prompt.
- **Staff dashboard:** works from 360 px wide. On narrow screens the groups stack as collapsible sections, and on desktop they show as a list with a sticky header for date and filters.
- Times are always shown in the business time zone, with the zone named on the client page (for example "10:30, Europe/Madrid").

---

## 9. Permissions Matrix

| Action | Anonymous | Client (valid token) | Staff |
|---|---|---|---|
| View own appointment via link | — | ✅ | ✅ |
| Confirm / cancel via link | — | ✅ (before start) | — |
| Sign in | ✅ | ✅ | ✅ |
| View dashboard, clients, history | — | — | ✅ |
| Create / edit appointments | — | — | ✅ |
| Confirm / cancel from the dashboard | — | — | ✅ (confirm before start) |
| Mark attended / no-show | — | — | ✅ |
| Add or deactivate staff | — | — | ✅ |

---

## 10. Technical Architecture

### 10.1 Stack

| Layer | Choice |
|---|---|
| Frontend | Vite + React + TypeScript |
| Backend | Node.js 24 LTS, Express 5, TypeScript |
| Validation | Zod, matching the OpenAPI contract |
| Database | PostgreSQL 17 via Prisma (schema, migrations, client) |
| API contract | `openapi.yaml`, written before the backend |
| Tests | Vitest + Supertest (backend), Vitest + React Testing Library (frontend), Playwright (end to end) |
| Containers | One Dockerfile (frontend built into the backend image), Docker Compose with Postgres |
| Hosting | AWS EC2 per environment (dev, production), Docker Compose, Caddy for HTTPS, defined in CloudFormation |
| CI/CD | GitHub Actions: tests on every PR, auto-deploy to dev on `main`, manual promotion of the same image to production |
| Telemetry | OpenTelemetry (traces, metrics, logs) exported over OTLP to Grafana Cloud |

### 10.2 Runtime Layout
A single container serves the API under `/v1` and the built frontend as static files, so the browser always talks to the same origin. Locally, `docker compose up` starts the app and Postgres with one command, applies Prisma migrations, and seeds demo data.

### 10.3 Configuration
| Variable | Purpose |
|---|---|
| `DATABASE_URL` | Postgres connection string |
| `SESSION_SECRET` | Signs session tokens |
| `BUSINESS_NAME` | Shown on client pages and messages |
| `BUSINESS_TIMEZONE` | IANA zone, for example `Europe/Madrid` |
| `PUBLIC_BASE_URL` | Used to build confirmation links |
| `APP_ENV`, `APP_VERSION` | Environment and image tag, reported by `/health` and telemetry |
| `OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_EXPORTER_OTLP_HEADERS` | Telemetry export; off when unset |

---

## 11. Data Model

All timestamps are stored in UTC.

### StaffMember
| Field | Type | Notes |
|---|---|---|
| id | uuid | |
| name | text | |
| email | text | unique, lowercase |
| passwordHash | text | |
| isActive | boolean | default true |
| createdAt | timestamp | |

### Client
| Field | Type | Notes |
|---|---|---|
| id | uuid | |
| name | text | |
| phone | text, nullable | |
| createdAt | timestamp | |

### Appointment
| Field | Type | Notes |
|---|---|---|
| id | uuid | |
| clientId | uuid | FK Client |
| staffMemberId | uuid | FK StaffMember |
| service | text | |
| startsAt | timestamp | |
| durationMinutes | integer | 5–480 |
| status | enum | `pending`, `confirmed`, `cancelled`, `attended`, `no_show` |
| confirmedBy | enum, nullable | `client`, `staff` |
| cancelledBy | enum, nullable | `client`, `staff` |
| statusChangedAt | timestamp | |
| tokenHash | text | unique, SHA-256 of the confirmation token |
| createdAt, updatedAt | timestamp | |

Indexes: `Appointment(startsAt)`, `Appointment(clientId, status)`, unique `Appointment(tokenHash)`.

---

## 12. API Surface

All endpoints are under `/v1` and defined in `openapi.yaml`. Errors use a single JSON shape: `{ "error": { "code", "message" } }`.

### 12.1 Staff (session cookie required)
| Method | Path | Purpose |
|---|---|---|
| POST | `/auth/login` | Sign in |
| POST | `/auth/logout` | Sign out |
| GET | `/auth/me` | Current staff member |
| GET, POST | `/staff` | List / add staff |
| PATCH | `/staff/{id}` | Rename or deactivate |
| GET, POST | `/clients` | Search (`?q=`) / create |
| GET | `/clients/{id}` | Client with history and no-show count |
| GET | `/appointments?date=YYYY-MM-DD&staffId=` | Day view with at-risk reasons |
| POST | `/appointments` | Create; returns the confirmation link once |
| PATCH | `/appointments/{id}` | Edit fields |
| POST | `/appointments/{id}/confirm` | Confirm by staff |
| POST | `/appointments/{id}/cancel` | Cancel by staff |
| POST | `/appointments/{id}/outcome` | `{ "outcome": "attended" \| "no_show" }` |
| POST | `/appointments/{id}/undo-outcome` | Revert an outcome |
| POST | `/appointments/{id}/link` | Regenerate link; returns the new link once |

Because only the token hash is stored, the full link is returned only when it is created or regenerated. The UI keeps it in memory so staff can copy it right away; if lost, staff regenerate it.

### 12.2 Client (token in path, no session)
| Method | Path | Purpose |
|---|---|---|
| GET | `/public/appointments/{token}` | Appointment details for the client page |
| POST | `/public/appointments/{token}/confirm` | Confirm |
| POST | `/public/appointments/{token}/cancel` | Cancel |

Unknown or invalidated tokens return `404`, never a hint about whether the appointment exists.

### 12.3 Operations
| Method | Path | Purpose |
|---|---|---|
| GET | `/health` | Database round trip, plus `environment` and `version` |

---

## 13. Security and Privacy

- Client names, phone numbers, and confirmation tokens never appear in logs, traces, or metrics.
- Request URLs for `/c/{token}` and `/v1/public/appointments/{token}` are recorded only by their route template, never the raw path.
- Public endpoints are rate-limited per IP (for example 30 requests per minute) to slow token guessing.
- Sign-in is rate-limited per email and IP.
- All state-changing staff endpoints require the session cookie and reject cross-site requests.
- Secrets come only from environment variables, never from the repository.

---

## 14. Performance and Reliability Targets

- Client page loads and confirm action: p95 under 500 ms on the deployed environment.
- Dashboard for a day with 100 appointments: p95 under 800 ms.
- Expected scale: up to 20 staff and 300 appointments per day. One instance per environment is enough.

---

## 15. Observability and Alerting

The key user journey is **client opens link → confirms or cancels**. It is instrumented with traces, metrics, and structured JSON logs that share the trace ID.

### 15.1 Application Metrics
| Metric | Type | Labels |
|---|---|---|
| `appointments_created_total` | counter | `environment`, `version` |
| `appointment_responses_total` | counter | `action` (`confirm`, `cancel`), `actor` (`client`, `staff`), `environment`, `version` |
| `appointment_response_failures_total` | counter | `action`, `actor`, `environment`, `version` |
| `appointment_outcomes_total` | counter | `outcome` (`attended`, `no_show`), `environment`, `version` |

### 15.2 Alert
**Clients cannot confirm:** fires when 3 or more `appointment_response_failures_total` increments occur within 5 minutes in one environment, sustained for 2 minutes. Each alert carries `service`, `environment`, `version`, and `severity` labels and a link to the dashboard filtered to that environment and version.

### 15.3 On-Call Agent
When the alert fires, a coding agent receives the alert, investigates with logs and traces, writes a fix with a test on a branch, and opens a pull request for human review. It never deploys to production.

---

## 16. MVP Acceptance Criteria

1. `docker compose up` starts the app and Postgres, seeds demo data, and the app is usable at `http://localhost:8080`.
2. A staff member can sign in with the seeded account, create an appointment, and copy its link.
3. Opening that link in a private window shows the appointment and lets the client confirm.
4. The staff dashboard shows the appointment as `confirmed` within 30 seconds, without a manual reload.
5. A `pending` appointment starting within 24 hours appears under **At risk** with "No reply yet".
6. A client with a previous no-show is flagged on their next appointment.
7. After the start time, the link no longer accepts confirm or cancel.
8. Staff can confirm or cancel an appointment from the dashboard, and it shows whether the client or staff made the change.
9. Regenerating a link makes the old link return 404.
10. Unit, integration, and end-to-end tests run with one command each and pass in CI.
11. No client name, phone number, or token appears in exported logs or traces.

---

## 17. Demo Seed Data

- Business name "Demo Studio", time zone `Europe/Madrid` (configurable).
- Two staff accounts: `alex@demo.test` and `sam@demo.test`, password `demo1234`.
- Eight clients, two of them with past no-shows.
- Appointments today and tomorrow covering every status and every at-risk rule.

---

## 18. Delivery Phases

1. **Spec and contract:** this document, `openapi.yaml`, `AGENTS.md`, and the GitHub Issues backlog.
2. **Frontend prototype:** staff dashboard and client page against a mocked API.
3. **Backend:** Express + Prisma implementation of the contract, with unit and integration tests.
4. **Connect:** frontend on the real API, end-to-end test of the confirm journey.
5. **Containerize:** Dockerfile and Docker Compose with Postgres.
6. **Deploy:** CloudFormation stacks for dev and production on AWS, CI/CD with manual promotion.
7. **Operate:** OpenTelemetry, Grafana dashboard, alert, and on-call agent.

---

## 19. Open Questions

1. **Domain for HTTPS:** do we have a domain for dev and production, or do we use CloudFront's default domain?
2. **Instance size:** `t4g.small` (about $19/month per environment) or `t4g.micro` to halve the cost?
3. **Observability backend:** Grafana Cloud free tier (as in `next-in-dining`), or a self-hosted stack on AWS?
4. **Language:** is the UI in English only, or also another language? Documentation stays in English either way.
