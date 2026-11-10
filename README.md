# Appointment Confirmation

Small service businesses lose income when clients miss appointments without
warning. Appointment Confirmation lets staff send each client a private link
to confirm or cancel, and shows on one dashboard which appointments are
confirmed, cancelled, or at risk of becoming a no-show.

- **Staff** sign in, record appointments, copy each client's confirmation
  link, and mark appointments as attended or no-show afterwards.
- **Clients** open the link on their phone and confirm or cancel with one
  tap, without an account.

The full product and technical specification is in [docs/spec.md](docs/spec.md).

## How this project is built

Work is done by a team of AI agents following a written process, with one
person (the repository owner) approving production releases:

- [AGENTS.md](AGENTS.md) - commands and rules for anyone working in the
  repository (Claude Code reads it through `CLAUDE.md`)
- [docs/process.md](docs/process.md) - how a GitHub issue moves from filed
  to merged: PM grooms, engineer implements and opens a pull request, QA
  posts PASS or FAIL, the orchestrator merges
- [docs/team/](docs/team/) - the PM, engineer, QA, and on-call engineer
  roles, also defined as Claude Code subagents in
  [.claude/agents/](.claude/agents/)
- [docs/decisions.md](docs/decisions.md) - the calls already made, with
  reasons
- [docs/task-template.md](docs/task-template.md) - the format of a groomed
  issue
- [GitHub Issues](https://github.com/rasc88/appointment-confirmation/issues)
  - the public task tracker

> Status: specification phase. Code, setup, and deployment instructions will
> follow.
