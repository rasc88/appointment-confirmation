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

### Telemetry

Add the Grafana Cloud values (#21) whenever they exist. They take effect
on the next deploy of that environment; set both or neither:

```sh
aws ssm put-parameter --region us-east-1 --type String \
  --name /appointment-confirmation/dev/otlp-endpoint --value '<endpoint>'
aws ssm put-parameter --region us-east-1 --type SecureString \
  --name /appointment-confirmation/dev/otlp-headers --value '<headers>'
```

Repeat with `prod` in the names for production. Add `--overwrite` to
change an existing value.

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
