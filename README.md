# Appointment Confirmation

[![CI](https://github.com/rasc88/appointment-confirmation/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/rasc88/appointment-confirmation/actions/workflows/ci.yml)

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

## Deploy to AWS

For the repository owner, with their own AWS credentials. Agents never
deploy. `infra/cloudformation.yaml` creates one `t4g.small` in `us-east-1`
that runs dev and production as separate Docker Compose projects, each
behind its own CloudFront address (spec section 10.4, decision 37). Every
command runs from the repository root.

> **There are no backups.** Both databases live only on the instance's
> disk. Deleting the stack, replacing the instance, or losing it for any
> other reason loses all data, dev and production.

### Create the stack

Look up the current Amazon Linux 2023 arm64 AMI and keep the id; every
later update passes the same one.

```sh
AMI_ID=$(aws ssm get-parameter --region us-east-1 \
  --name /aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-arm64 \
  --query Parameter.Value --output text)
echo "$AMI_ID"
```

Check whether the account already has the GitHub OIDC provider:

```sh
aws iam list-open-id-connect-providers --region us-east-1
```

Optionally confirm the CloudFront prefix list id the template defaults to
(`pl-3b927c52`):

```sh
aws ec2 describe-managed-prefix-lists --region us-east-1 \
  --filters Name=prefix-list-name,Values=com.amazonaws.global.cloudfront.origin-facing \
  --query 'PrefixLists[0].PrefixListId' --output text
```

Create the stack. Add
`ExistingGitHubOidcProviderArn=<arn>` to `--parameter-overrides` only if
the list above shows `token.actions.githubusercontent.com`; otherwise the
stack creates the provider.

```sh
aws cloudformation deploy --region us-east-1 \
  --stack-name appointment-confirmation \
  --template-file infra/cloudformation.yaml \
  --capabilities CAPABILITY_IAM \
  --parameter-overrides AmiId="$AMI_ID"
```

The CloudFront distributions take several minutes.

### Outputs

```sh
aws cloudformation describe-stacks --region us-east-1 \
  --stack-name appointment-confirmation \
  --query 'Stacks[0].Outputs' --output table
```

- `DevUrl` - the public dev demo (seeded with the demo logins on its first
  deploy). The stack also stores it in Parameter Store as
  `/appointment-confirmation/dev/public-base-url`
- `ProdUrl` - production, stored as
  `/appointment-confirmation/prod/public-base-url`
- `InstanceId` and `DeployRoleArn` - the deploy workflows need both
  ("Continuous deployment" below)

### Continuous deployment

Two workflows deploy the app (decision 38). Both reach the instance only
through the stack's deploy role, over OIDC and SSM; there are no AWS keys
and no repository secrets.

- `Deploy` (`.github/workflows/deploy.yml`) runs on every push to `main`.
  It builds one `linux/arm64` image on GitHub's `ubuntu-24.04-arm` runner,
  tagged with the full commit SHA (also its `APP_VERSION`), pushes it to
  `ghcr.io/rasc88/appointment-confirmation:<sha>` unless that tag already
  exists, then runs `infra/remote-deploy.sh dev <sha>`. That script checks
  out the commit on the instance and runs `infra/deploy.sh` over SSM, then
  waits until `<DevUrl>/v1/health` reports the SHA. Runs queue in push
  order and a deploy in progress is never cancelled
- `Promote to production` (`.github/workflows/promote.yml`) runs only when
  you start it. It reads the SHA dev runs now from `<DevUrl>/v1/health`
  and deploys that exact image to production the same way. It builds
  nothing and takes no input

#### Setup, once after the stack exists

1. Read the stack outputs (above).
2. Set the repository variables. They are plain variables, not secrets;
   `DEV_URL` and `PROD_URL` have no trailing slash:

   ```sh
   gh variable set AWS_DEPLOY_ROLE_ARN --body '<DeployRoleArn>'
   gh variable set AWS_INSTANCE_ID --body '<InstanceId>'
   gh variable set DEV_URL --body '<DevUrl>'
   gh variable set PROD_URL --body '<ProdUrl>'
   ```

   Or Settings → Secrets and variables → Actions → Variables → New
   repository variable, once per name. Until all are set, `Deploy` fails
   at `deploy-dev` with a message naming what is missing.
3. Create the `production` environment: Settings → Environments → New
   environment, name `production`, Configure environment. Under
   "Deployment protection rules" tick "Required reviewers", add yourself,
   and Save protection rules. Under "Deployment branches and tags" choose
   "Selected branches and tags", Add deployment branch or tag rule, enter
   `main`, and Add rule. The `dev` environment is created by the first
   `Deploy` run and needs no rules.
4. After the first `Deploy` run has pushed the image, make the package
   public so the instance can pull it without logging in: your profile →
   Packages → `appointment-confirmation` → Package settings → Change
   visibility → Public. That first run's `deploy-dev` job fails at the
   pull, before anything on the instance changes, because the package
   starts private. Re-run that job (Actions → the run → Re-run failed
   jobs) once the package is public.

#### Promote to production

Actions → "Promote to production" → Run workflow, branch `main`, or:

```sh
gh workflow run promote.yml --ref main
```

It promotes whatever dev runs at that moment, so check dev first. The run
waits for your approval (Review deployments → Approve and deploy) before
it gets AWS credentials. A dev that runs a `manual` build (the optional
first bring-up), is unhealthy, or does not answer cannot be promoted: the
run stops before any AWS call.

#### Create the first production staff account

1. Do this once, after a promotion whose image contains this command.
2. Open a Session Manager shell (EC2 console → Connect → Session Manager,
   or `aws ssm start-session --region us-east-1 --target <InstanceId>`).
   `aws ssm send-command` / Run Command does not work, because it gives
   no TTY, so the prompts cannot be answered.
3. Run exactly:

   ```sh
   sudo docker compose --project-name ac-prod \
     --env-file /opt/appointment-confirmation/prod/.env \
     -f /opt/appointment-confirmation/repo/infra/compose.yaml \
     exec app npm run staff:create
   ```

   `sudo` is needed because the env file is root-only and Docker needs
   root. Production uses `compose.yaml` alone (no `compose.dev.yaml`), the
   same as `deploy.sh`. `exec` allocates a TTY by default, so do not add
   `-T`.
4. Answer the prompts: `Name`, `Email`, `Password`. The password is not
   shown while it is typed.
5. Sign in at `<ProdUrl>`, then add further accounts from the Staff page.
6. Production never has demo data, and `npm run db:seed` refuses there.

#### Roll back

Revert the bad commit on `main` through a pull request. `Deploy` builds
the revert and puts it on dev; once dev is good, promote it.

### Verify

Open a shell on the instance with Session Manager (the EC2 console's
Connect button, or `aws ssm start-session --region us-east-1 --target
<InstanceId>` with the Session Manager plugin). There is no SSH. Then:

```sh
sudo docker compose version
ls /opt/appointment-confirmation
```

The first shows the pinned Compose plugin; the second lists `dev`, `prod`,
and `repo`. From your own machine, both CloudFront addresses answer;
`502` or `504` is expected until the first deploy:

```sh
curl -s -o /dev/null -w '%{http_code}\n' <DevUrl>/v1/health
curl -s -o /dev/null -w '%{http_code}\n' <ProdUrl>/v1/health
```

### Optional first bring-up

This also proves the image runs on arm64. On the instance, build the image
from the checkout and deploy it to dev:

```sh
sudo docker build --build-arg APP_VERSION=manual \
  -t appointment-confirmation:manual /opt/appointment-confirmation/repo
sudo /opt/appointment-confirmation/repo/infra/deploy.sh dev appointment-confirmation:manual
```

From your own machine, `curl -s <DevUrl>/v1/health` then shows
`"status":"ok","environment":"dev"`.

`infra/deploy.sh <dev|prod> <image-ref>` generates each environment's
session secret and database password on its first run and keeps them in
`/opt/appointment-confirmation/<env>/secrets.env`; they never leave the
instance. #19 calls it over SSM for every deploy.

### Telemetry and alerting

The app sends traces, metrics, and logs to Grafana Cloud (decision 36).
`observability/` holds the dashboard, the alert rule "Clients cannot
confirm", and `push.sh`, which creates or updates both in your stack
(decision 40). Only you run it; agents never hold a Grafana token.

1. Create a Grafana Cloud account and a free stack (a US East region is
   closest to the instance). Note the stack URL,
   `https://<stack>.grafana.net`.
2. In the stack, Connections → "OpenTelemetry (OTLP)": create a token with
   the metrics, logs, and traces write scopes. Copy the OTLP endpoint
   (`https://otlp-gateway-<region>.grafana.net/otlp`) and the
   `OTEL_EXPORTER_OTLP_HEADERS` value (`Authorization=Basic%20<base64>`).
3. Put them in SSM for dev, set both or neither:

   ```sh
   aws ssm put-parameter --region us-east-1 --type String \
     --name /appointment-confirmation/dev/otlp-endpoint --value '<endpoint>'
   aws ssm put-parameter --region us-east-1 --type SecureString \
     --name /appointment-confirmation/dev/otlp-headers --value '<headers>'
   ```

   Repeat with `prod` in the names for production. Add `--overwrite` to
   change an existing value. They take effect on the next deploy of that
   environment: a merge to `main` for dev, "Promote to production" for
   production.
4. Check the names: after a few requests on dev, run these in Explore.
   Both return series, the second at 0 until something fails:

   ```
   http_server_request_duration_seconds_count{environment="dev"}
   appointment_response_failures_total{environment="dev"}
   ```

   If Explore shows other names (for example dotted ones), the dashboard
   and alert queries need a follow-up issue.
5. Administration → Users and access → Service accounts: create
   `appointment-confirmation-push` with the role Admin, add a token, and
   keep it locally. You can delete the token after pushing. Narrower
   option: role Editor plus the Cloud RBAC role "Alerting provisioning
   writer".
6. Alerting → Contact points → `grafana-default-email`: check that the
   address is yours (replace a placeholder such as `<example@email.com>`),
   and press Test to receive an email. The alert notifies this contact
   point directly; `push.sh` neither creates nor changes contact points or
   the notification policies.
7. From the repository root, push the dashboard and the alert rule. Run it
   again after any change to the files in `observability/`:

   ```sh
   GRAFANA_URL=https://<stack>.grafana.net GRAFANA_TOKEN=<token> observability/push.sh
   ```

   It needs `bash`, `curl`, and `jq`, prints one line per step and the
   dashboard URL, and stops with the HTTP status and Grafana's answer on
   any error. `observability/push.sh --dry-run` (with `GRAFANA_URL` only)
   shows what it would send without sending anything.
8. Check: the dashboard "Appointment confirmation" opens with
   `environment=dev` selected, and Alerting → Alert rules shows
   "Clients cannot confirm" as Normal.
9. Optional fire drill, on dev only. The alert fires on dev at 3 or more
   failed confirms or cancels in 5 minutes (production: 1 or more). From a
   Session Manager shell, stop dev's database:

   ```sh
   sudo docker compose --project-name ac-dev \
     --env-file /opt/appointment-confirmation/dev/.env \
     -f /opt/appointment-confirmation/repo/infra/compose.yaml \
     -f /opt/appointment-confirmation/repo/infra/compose.dev.yaml \
     stop db
   ```

   Press confirm on a dev link at least 3 times, wait about 4 minutes for
   the email, then start the database again with the same command ending
   in `start db`.

### Update the stack

Pass the same `AmiId` the stack already has:

```sh
AMI_ID=$(aws cloudformation describe-stacks --region us-east-1 \
  --stack-name appointment-confirmation \
  --query "Stacks[0].Parameters[?ParameterKey=='AmiId'].ParameterValue" \
  --output text)
aws cloudformation deploy --region us-east-1 \
  --stack-name appointment-confirmation \
  --template-file infra/cloudformation.yaml \
  --capabilities CAPABILITY_IAM \
  --parameter-overrides AmiId="$AMI_ID"
```

> **Warning:** a different `AmiId` replaces the instance, which deletes
> both databases.

### Tear down

Deleting the stack deletes the instance, both databases, the
distributions, and everything else it created, and stops all AWS charges.
The `otlp-*` parameters were created by hand, so delete them by hand:

```sh
aws cloudformation delete-stack --region us-east-1 --stack-name appointment-confirmation
aws cloudformation wait stack-delete-complete --region us-east-1 --stack-name appointment-confirmation
aws ssm delete-parameters --region us-east-1 --names \
  /appointment-confirmation/dev/otlp-endpoint /appointment-confirmation/dev/otlp-headers \
  /appointment-confirmation/prod/otlp-endpoint /appointment-confirmation/prod/otlp-headers
```

## On-call agent

`oncall/oncall.sh` is the trigger for the on-call engineer agent (spec
section 15.3, decision 41). It runs on your machine, asks Grafana every 60
seconds for firing "Clients cannot confirm" alerts, and for each new
incident starts `claude -p --agent on-call-engineer` with the alert. The
agent reads the code at the alert's `version`, pushes an `oncall-*`
branch, and opens a pull request and an `mvp` incident issue. It cannot
merge, deploy, run a workflow, or reach Grafana.

Prerequisites:

- `claude` logged in with your Claude subscription (run `claude` once), and
  `gh` logged in (`gh auth status`): the agent's pull requests are opened
  with your login, so `CI` runs on them
- `jq`, `curl`, and coreutils `timeout`
- `docker compose up -d db`, so the agent can run `npm test`
- a clean checkout of this repository: the poller waits while
  `git status --porcelain` shows anything. The agent switches the checkout
  to its `oncall-*` branch and leaves it there

Create the token: in the stack, Administration → Users and access →
Service accounts, create `appointment-confirmation-oncall` with the role
Viewer, add a token, and export it with the stack URL in the shell that
runs the poller (never in a file in the repository):

```sh
export GRAFANA_URL=https://<stack>.grafana.net
export GRAFANA_TOKEN=<viewer token>
```

Run it from the repository root:

```sh
oncall/oncall.sh                       # poll every 60 seconds until Ctrl-C
oncall/oncall.sh --once                # one poll, then exit
oncall/oncall.sh --base <branch>       # the agent works from and targets <branch> instead of main
```

Try it offline, with no token and without starting `claude`. The
example's `version` must be a commit of this repository; to use the
current one:

```sh
jq --arg v "$(git rev-parse HEAD)" '.data.alerts[].labels.version = $v' \
  oncall/example-alerts.json > /tmp/alerts.json
oncall/oncall.sh --dry-run --alert-file /tmp/alerts.json
```

`--dry-run` prints the exact `claude` command and prompt for each new
incident. Without it, `--alert-file` starts the agent for real.

State and logs, both git-ignored:

- `oncall/state.json` lists the handled incident keys,
  `<alertname>|<environment>|<version>|<activeAt>`. An alert that keeps
  firing starts one agent; one that resolves and fires again starts a new
  one. To let an incident run again, remove its key from the file
- `oncall/logs/<yyyymmdd-hhmmss>-<environment>.jsonl` holds each session's
  full output; the poller prints its path and the agent's final report

What to do with the result: review the incident issue the agent opened.
Its pull request goes through QA and CI like any other change, and reaches
production only when you promote it.
