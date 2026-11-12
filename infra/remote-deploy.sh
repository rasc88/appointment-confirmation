#!/usr/bin/env bash
# Deploys one commit's image to one environment from a GitHub runner, over SSM.
# Usage: INSTANCE_ID=... APP_URL=... infra/remote-deploy.sh <dev|prod> <commit-sha>
# Called by .github/workflows/deploy.yml and promote.yml (decision 38).
# The SHA is checked to be 40 lowercase hex characters before it reaches a
# shell command on the instance. No `set -x`: the job log is public.
set -euo pipefail

usage="usage: INSTANCE_ID=<id> APP_URL=<url> $0 <dev|prod> <commit-sha>"
env_name="${1:-}"
sha="${2:-}"
region=us-east-1
repo_dir=/opt/appointment-confirmation/repo
lock_file=/opt/appointment-confirmation/deploy.lock
ssm_attempts=200
health_attempts=30

case "$env_name" in
  dev) app_env=dev ;;
  prod) app_env=production ;;
  *) app_env="" ;;
esac
if [[ $# -ne 2 || -z "$app_env" || ! "$sha" =~ ^[0-9a-f]{40}$ || -z "${INSTANCE_ID:-}" || -z "${APP_URL:-}" ]]; then
  echo "$usage" >&2
  exit 2
fi

image="ghcr.io/rasc88/appointment-confirmation:$sha"
remote_command="flock -w 600 $lock_file sh -c 'git -C $repo_dir fetch --quiet origin && git -C $repo_dir checkout --quiet --detach $sha && $repo_dir/infra/deploy.sh $env_name $image'"
parameters="$(jq -cn --arg command "$remote_command" '{commands: [$command], executionTimeout: ["900"]}')"

command_id="$(aws ssm send-command --region "$region" \
  --document-name AWS-RunShellScript \
  --instance-ids "$INSTANCE_ID" \
  --comment "Deploy $sha to $env_name" \
  --parameters "$parameters" \
  --query Command.CommandId --output text)"
echo "Sent SSM command $command_id: deploy $image to $env_name"

status=""
invocation="{}"
error_file="$(mktemp)"
for ((attempt = 1; attempt <= ssm_attempts; attempt++)); do
  sleep 5
  # InvocationDoesNotExist is expected until the instance has registered the command.
  if ! invocation="$(aws ssm get-command-invocation --region "$region" \
    --command-id "$command_id" --instance-id "$INSTANCE_ID" --output json 2> "$error_file")"; then
    if grep -q InvocationDoesNotExist "$error_file"; then
      invocation="{}"
      continue
    fi
    cat "$error_file" >&2
    exit 1
  fi
  status="$(jq -r '.Status' <<< "$invocation")"
  case "$status" in
    Pending | InProgress | Delayed) ;;
    *) break ;;
  esac
done

echo "SSM command status: ${status:-unknown}"
echo "--- standard output ---"
jq -r '.StandardOutputContent // ""' <<< "$invocation"
echo "--- standard error ---"
jq -r '.StandardErrorContent // ""' <<< "$invocation"
if [[ "$status" != Success ]]; then
  echo "Deploy to $env_name did not succeed (status ${status:-unknown})" >&2
  exit 1
fi

last_response=""
for ((attempt = 1; attempt <= health_attempts; attempt++)); do
  if last_response="$(curl -sS --max-time 10 -w '\n%{http_code}' "$APP_URL/v1/health" 2>&1)"; then
    http_code="$(tail -n 1 <<< "$last_response")"
    body="$(sed '$d' <<< "$last_response")"
    if [[ "$http_code" == 200 ]] && jq -e --arg sha "$sha" --arg env "$app_env" \
      '.status == "ok" and .version == $sha and .environment == $env' <<< "$body" > /dev/null 2>&1; then
      echo "$APP_URL/v1/health reports $sha on $app_env"
      exit 0
    fi
  fi
  if ((attempt < health_attempts)); then
    sleep 10
  fi
done

echo "$APP_URL/v1/health did not report $sha on $app_env after $health_attempts attempts. Last response:" >&2
echo "$last_response" >&2
exit 1
