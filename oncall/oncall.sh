#!/usr/bin/env bash
# Polls Grafana Cloud every 60 seconds for firing "Clients cannot confirm"
# alerts and starts the on-call engineer agent headless for each new incident
# (decision 41). Owner only: agents run only --dry-run --alert-file and the
# stubbed check.
#
#   GRAFANA_URL=https://<stack>.grafana.net GRAFANA_TOKEN=<viewer token> oncall/oncall.sh [--once] [--base <branch>]
#   oncall/oncall.sh --dry-run --alert-file oncall/example-alerts.json
#
# Exit codes (with --once or --alert-file): 0 the poll succeeded and every
# agent it started exited 0, 1 the poll or an agent failed, 2 bad arguments
# or settings.
set -euo pipefail

service=appointment-confirmation
pollSeconds=60
maxTurns=150
# Overridable only so the stubbed check can shorten it.
agentTimeout=${ONCALL_AGENT_TIMEOUT:-30m}
here=$(cd "$(dirname "$0")" && pwd)
repo=$(cd "$here/.." && pwd)
stateFile=$here/state.json
logDir=$here/logs
usage="usage: oncall/oncall.sh [--once] [--base <branch>] [--dry-run] [--alert-file <file>]"
base=main
alertFile=""
isOnce=false
isDryRun=false

usage_error() {
  echo "oncall.sh: $1" >&2
  exit 2
}

say() {
  echo "$(date -u +%H:%M:%S) $1"
}

while [[ $# -gt 0 ]]; do
  case $1 in
    --once) isOnce=true ;;
    --dry-run) isDryRun=true ;;
    --base | --alert-file)
      if [[ $# -lt 2 || $2 == -* || -z $2 ]]; then
        usage_error "$1 needs a value; $usage"
      fi
      if [[ $1 == --base ]]; then
        base=$2
      else
        alertFile=$2
      fi
      shift
      ;;
    *) usage_error "unknown argument $1; $usage" ;;
  esac
  shift
done

if [[ -n $alertFile ]]; then
  isOnce=true
  if [[ $alertFile != /* ]]; then
    alertFile=$PWD/$alertFile
  fi
fi
if [[ $isDryRun == true && $isOnce == false ]]; then
  usage_error "--dry-run needs --once or --alert-file; $usage"
fi
if [[ -z $alertFile ]]; then
  if [[ -z ${GRAFANA_URL-} ]]; then
    usage_error "GRAFANA_URL is not set (for example https://<stack>.grafana.net)"
  fi
  if [[ $GRAFANA_URL != https://* || $GRAFANA_URL == */ ]]; then
    usage_error "GRAFANA_URL must start with https:// and must not end in /"
  fi
  if [[ -z ${GRAFANA_TOKEN-} ]]; then
    usage_error "GRAFANA_TOKEN is not set"
  fi
fi
if [[ ! $base =~ ^[A-Za-z0-9._/-]+$ ]]; then
  usage_error "--base must match ^[A-Za-z0-9._/-]+$"
fi

cd "$repo"
if ! git fetch --quiet origin; then
  echo "oncall.sh: git fetch origin failed" >&2
  exit 1
fi
if ! git rev-parse --verify --quiet "refs/remotes/origin/$base" >/dev/null; then
  usage_error "origin/$base does not exist"
fi

allowedTools=(
  "Read(./**)" "Edit(./**)"
  "Bash(npm run lint)" "Bash(npm run typecheck)" "Bash(npm test)"
  "Bash(git status *)" "Bash(git diff *)" "Bash(git log *)" "Bash(git show *)"
  "Bash(git fetch)" "Bash(git fetch origin)" "Bash(git switch -c *)" "Bash(git add *)" "Bash(git commit *)"
  "Bash(git push -u origin oncall-*)"
  "Bash(gh issue create *)" "Bash(gh issue list *)" "Bash(gh issue view *)"
  "Bash(gh pr create *)" "Bash(gh pr list *)" "Bash(gh pr view *)" "Bash(gh search *)"
)
# The second group closes what the oncall-* wildcard would let through: force, delete, and refspecs onto other branches.
disallowedTools=(
  "Bash(gh pr merge:*)" "Bash(gh api:*)" "Bash(gh workflow:*)" "Bash(gh run:*)" "Bash(gh release:*)"
  "Bash(git push --force:*)" "Bash(git push -f:*)" "Bash(aws:*)" "Bash(curl:*)"
  "Bash(observability/push.sh:*)" "Bash(infra/deploy.sh:*)" "Bash(infra/remote-deploy.sh:*)"
  WebFetch WebSearch
  "Bash(git push * -f*)" "Bash(git push *--force*)" "Bash(git push *+*)" "Bash(git push * -d*)"
  "Bash(git push *--delete*)" "Bash(git push *--mirror*)" "Bash(git push *--all*)"
  "Bash(git push *--receive-pack*)" "Bash(git push *--exec*)"
  "Bash(git push *:*main*)" "Bash(git push *:*$base*)"
)
claudeCommand=(
  timeout "$agentTimeout" env -u GRAFANA_TOKEN
  claude -p --agent on-call-engineer --setting-sources project --permission-mode dontAsk
  --max-turns "$maxTurns" --output-format stream-json --verbose
  --allowedTools "${allowedTools[@]}" --disallowedTools "${disallowedTools[@]}"
)

read_alerts() {
  if [[ -n $alertFile ]]; then
    cat -- "$alertFile"
    return
  fi
  curl -sf --max-time 30 -H @<(printf 'Authorization: Bearer %s\n' "$GRAFANA_TOKEN") \
    -H 'Accept: application/json' "$GRAFANA_URL/api/prometheus/grafana/api/v1/alerts"
}

handled_keys() {
  if [[ -f $stateFile ]]; then
    cat "$stateFile"
  else
    echo '[]'
  fi
}

is_handled() {
  handled_keys | jq -e --arg key "$1" 'any(.[]; . == $key)' >/dev/null
}

record() {
  local updated
  updated=$(handled_keys | jq --arg key "$1" '. + [$key]')
  printf '%s\n' "$updated" >"$stateFile"
}

# Records a key the agent will never get, unless this is a dry run.
skip() {
  say "skipped $1: $2"
  if [[ $isDryRun == false ]]; then
    record "$1"
  fi
}

build_prompt() {
  local alert=$1 key=$2 environment=$3 version=$4
  jq -n -r --arg key "$key" --arg environment "$environment" --arg version "$version" --arg base "$base" '[
    "The \"Clients cannot confirm\" alert below is firing on the \($environment) environment. You are the on-call engineer.",
    "",
    "Incident key: `\($key)`",
    "Base branch: `\($base)`",
    "",
    "- Follow `docs/team/on-call-engineer.md`. The code that was running is `\($version)` (`git show \($version)`, `git log \($version)`).",
    "- First search issues and pull requests, open and closed, for the incident key (`gh issue list --state all --search`, `gh pr list --state all --search`, or `gh search`). If one exists, stop with a report that links it.",
    "- Branch `oncall-<short-description>` from the latest `origin/\($base)` (`git fetch origin`, then `git switch -c oncall-<short-description> origin/\($base)`), push it with `git push -u origin oncall-<short-description>`, and open the pull request against `\($base)` (`gh pr create --base \($base)`).",
    "- Put the incident key in the incident issue and in the pull request description.",
    "- If the cause is already fixed on `\($base)` or is outside the code, open the issue and no pull request.",
    "- You have no Grafana access: the evidence is this alert, its dashboard link (for a person), and the code at `\($version)`. Never ask for a token.",
    "- Run the checks with exactly `npm run lint`, `npm run typecheck` and `npm test` from the repository root. Commands outside your allowed tools are denied without a prompt.",
    "",
    "Finish with a short report: the incident key, the cause, and the links to the issue and the pull request.",
    "",
    "## Alert",
    ""
  ] | join("\n")'
  printf '```json\n%s\n```\n' "$(jq . <<<"$alert")"
}

# Returns 1 when the agent failed or timed out.
run_agent() {
  local prompt=$1 environment=$2 logFile status=0 report
  mkdir -p "$logDir"
  logFile=$logDir/$(date -u +%Y%m%d-%H%M%S)-$environment.jsonl
  # Two agents that end within one second would otherwise share a log.
  while [[ -e $logFile ]]; do
    sleep 1
    logFile=$logDir/$(date -u +%Y%m%d-%H%M%S)-$environment.jsonl
  done
  say "starting the agent, log $logFile"
  "${claudeCommand[@]}" <<<"$prompt" >"$logFile" 2>&1 || status=$?
  report=$(jq -rR 'fromjson? | select(.type? == "result") | .result // empty' "$logFile")
  printf '%s\n' "${report:-(no final report in the log)}"
  if [[ $status == 124 ]]; then
    say "the agent timed out after $agentTimeout (failed)"
    return 1
  fi
  if [[ $status != 0 ]]; then
    say "the agent failed with exit code $status"
    return 1
  fi
  say "the agent finished"
}

# Returns 1 when an agent failed; a failed fetch makes the whole poll fail.
handle_alert() {
  local alert=$1 key environment version prompt
  key=$(jq -r '[.labels.alertname, .labels.environment, .labels.version, .activeAt] | map(. // "") | join("|")' <<<"$alert")
  if is_handled "$key"; then
    return 0
  fi
  environment=$(jq -r '.labels.environment // ""' <<<"$alert")
  version=$(jq -r '.labels.version // ""' <<<"$alert")
  say "new incident $key"
  if [[ $environment != dev && $environment != production ]]; then
    skip "$key" "environment is not dev or production"
    return 0
  fi
  if [[ ! $version =~ ^[0-9a-f]{40}$ ]]; then
    skip "$key" "version is not a 40-character commit SHA"
    return 0
  fi
  if ! git cat-file -e "$version^{commit}" 2>/dev/null; then
    skip "$key" "version is not a commit in this repository"
    return 0
  fi
  if [[ -n $(git status --porcelain) ]]; then
    say "the working tree is not clean; $key will be retried on the next poll"
    return 0
  fi
  prompt=$(build_prompt "$alert" "$key" "$environment" "$version")
  if [[ $isDryRun == true ]]; then
    echo "command:"
    printf '%q ' "${claudeCommand[@]}"
    printf '<<<"$prompt"\nprompt:\n%s\n' "$prompt"
    return 0
  fi
  record "$key"
  run_agent "$prompt" "$environment"
}

# Returns 1 when the poll or an agent failed.
poll_once() {
  local response alerts alert hasFailed=false
  if ! response=$(read_alerts); then
    say "poll failed: could not read the alerts" >&2
    return 1
  fi
  if ! alerts=$(jq -c --arg service "$service" '.data.alerts[]
      | select(.labels.service == $service and ((.state // "") | startswith("Alerting"))
        and .labels.__grafana_autogenerated__ != "true")' <<<"$response"); then
    say "poll failed: the response is not a Grafana alerts list" >&2
    return 1
  fi
  if [[ -n $alerts ]] && ! git fetch --quiet origin; then
    say "poll failed: git fetch origin failed" >&2
    return 1
  fi
  while IFS= read -r alert; do
    if [[ -n $alert ]] && ! handle_alert "$alert"; then
      hasFailed=true
    fi
  done < <(printf '%s\n' "$alerts")
  [[ $hasFailed == false ]]
}

if [[ $isOnce == true ]]; then
  if poll_once; then
    exit 0
  fi
  exit 1
fi
say "watching $GRAFANA_URL every ${pollSeconds}s for firing $service alerts, base branch $base"
while true; do
  poll_once || true
  sleep "$pollSeconds"
done
