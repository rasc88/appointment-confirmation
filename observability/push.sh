#!/usr/bin/env bash
# Creates or updates the dashboard and the "Clients cannot confirm" alert rule
# in the owner's Grafana Cloud stack (decision 40). Owner only: agents run
# only --dry-run and the stubbed check.
#
#   GRAFANA_URL=https://<stack>.grafana.net GRAFANA_TOKEN=<token> observability/push.sh
#   GRAFANA_URL=https://<stack>.grafana.net observability/push.sh --dry-run
#
# Exit codes: 0 done, 1 a lookup or request failed, 2 bad arguments or settings.
set -euo pipefail

folder_uid=appointment-confirmation-folder
folder_title=appointment-confirmation
rule_group=appointment-confirmation
rule_uid=clients-cannot-confirm
contact_point=grafana-default-email
rule_group_interval_seconds=60
here=$(cd "$(dirname "$0")" && pwd)
is_dry_run=false

usage_error() {
  echo "push.sh: $1" >&2
  exit 2
}

if [[ $# -gt 1 || ( $# -eq 1 && $1 != --dry-run ) ]]; then
  usage_error "usage: observability/push.sh [--dry-run]"
fi
if [[ $# -eq 1 ]]; then
  is_dry_run=true
fi
if [[ -z ${GRAFANA_URL-} ]]; then
  usage_error "GRAFANA_URL is not set (for example https://<stack>.grafana.net)"
fi
if [[ $GRAFANA_URL != https://* || $GRAFANA_URL == */ ]]; then
  usage_error "GRAFANA_URL must start with https:// and must not end in /"
fi
if [[ $is_dry_run == false && -z ${GRAFANA_TOKEN-} ]]; then
  usage_error "GRAFANA_TOKEN is not set"
fi

step=""
status=""
body=""

# Sets status and body. The token reaches curl through a file descriptor, so it is never in curl's arguments.
request() {
  local method=$1 path=$2 data=${3-} response
  local data_args=()
  if [[ -n $data ]]; then
    data_args=(--data-binary @-)
  fi
  response=$(printf '%s' "$data" | curl -sS -X "$method" \
    -H @<(printf 'Authorization: Bearer %s\n' "$GRAFANA_TOKEN") \
    -H 'Accept: application/json' -H 'Content-Type: application/json' \
    -H 'X-Disable-Provenance: true' \
    ${data_args[@]+"${data_args[@]}"} -w '\n%{http_code}' "$GRAFANA_URL$path") || {
    echo "$step: the request to $path did not complete" >&2
    exit 1
  }
  status=${response##*$'\n'}
  body=${response%$'\n'*}
}

require_2xx() {
  if [[ $status != 2?? ]]; then
    printf '%s: HTTP %s\n%s\n' "$step" "$status" "$body" >&2
    exit 1
  fi
}

folder_payload() {
  jq -n --arg uid "$folder_uid" --arg title "$folder_title" '{uid: $uid, title: $title}'
}

dashboard_payload() {
  local message
  message=$(git -C "$here" rev-parse --short HEAD 2>/dev/null || true)
  jq --arg folder "$folder_uid" --arg message "$message" \
    '{dashboard: ., folderUid: $folder, overwrite: true} + (if $message == "" then {} else {message: $message} end)' \
    "$here/dashboard.json"
}

rule_payload() {
  jq --arg prometheus "$1" --arg url "$GRAFANA_URL" \
    'walk(if type == "string" then gsub("__PROMETHEUS_UID__"; $prometheus) | gsub("__GRAFANA_URL__"; $url) else . end)' \
    "$here/alert-rule.json"
}

print_dry_run() {
  local group_path="/api/v1/provisioning/folder/$folder_uid/rule-groups/$rule_group"
  echo "1. find the Prometheus datasource: GET /api/datasources"
  echo "2. check the contact point: GET /api/v1/provisioning/contact-points?name=$contact_point"
  echo "3. folder: GET /api/folders/$folder_uid, then only if 404: POST /api/folders"
  folder_payload
  echo "4. dashboard: POST /api/dashboards/db"
  dashboard_payload
  echo "5. alert rule: GET /api/v1/provisioning/alert-rules/$rule_uid, then POST /api/v1/provisioning/alert-rules" \
    "if 404, else PUT /api/v1/provisioning/alert-rules/$rule_uid"
  rule_payload '<looked up>'
  echo "   rule group: GET $group_path, then only if its interval is not $rule_group_interval_seconds: PUT $group_path"
  jq -n --arg folder "$folder_uid" --arg group "$rule_group" --argjson interval "$rule_group_interval_seconds" \
    '{title: $group, folderUid: $folder, interval: $interval, rules: ["<the rules as read>"]}'
}

find_prometheus_uid() {
  step="1. find the Prometheus datasource"
  request GET /api/datasources
  require_2xx
  local matches
  matches=$(jq -c '[.[] | select(.type == "prometheus" and (.name | startswith("grafanacloud-")) and (.name | endswith("-prom")))]' <<<"$body")
  if [[ $(jq length <<<"$matches") != 1 ]]; then
    echo "$step: expected exactly one Prometheus datasource named grafanacloud-*-prom; Prometheus datasources:" \
      "$(jq -r '[.[] | select(.type == "prometheus") | .name] | join(", ")' <<<"$body")" >&2
    exit 1
  fi
  prometheus_uid=$(jq -r '.[0].uid' <<<"$matches")
  echo "$step: $(jq -r '.[0].name' <<<"$matches")"
}

check_contact_point() {
  step="2. check the contact point"
  request GET "/api/v1/provisioning/contact-points?name=$contact_point"
  require_2xx
  # Grafana filters by name itself; each item's .name is the integration's, not the contact point's.
  if ! jq -e 'length > 0' <<<"$body" >/dev/null; then
    echo "$step: contact point $contact_point does not exist; nothing was written" >&2
    exit 1
  fi
  echo "$step: $contact_point exists"
}

ensure_folder() {
  step="3. folder"
  request GET "/api/folders/$folder_uid"
  if [[ $status == 404 ]]; then
    request POST /api/folders "$(folder_payload)"
    require_2xx
    echo "$step: created $folder_uid"
    return
  fi
  require_2xx
  echo "$step: $folder_uid exists"
}

save_dashboard() {
  step="4. dashboard"
  request POST /api/dashboards/db "$(dashboard_payload)"
  require_2xx
  dashboard_url="$GRAFANA_URL$(jq -r .url <<<"$body")"
  echo "$step: saved, version $(jq -r .version <<<"$body")"
}

save_alert_rule() {
  step="5. alert rule"
  local rule
  rule=$(rule_payload "$prometheus_uid")
  request GET "/api/v1/provisioning/alert-rules/$rule_uid"
  if [[ $status == 404 ]]; then
    request POST /api/v1/provisioning/alert-rules "$rule"
    require_2xx
    echo "$step: created $rule_uid"
  else
    require_2xx
    request PUT "/api/v1/provisioning/alert-rules/$rule_uid" "$rule"
    require_2xx
    echo "$step: updated $rule_uid"
  fi
}

set_rule_group_interval() {
  step="5. rule group"
  local group_path="/api/v1/provisioning/folder/$folder_uid/rule-groups/$rule_group"
  request GET "$group_path"
  require_2xx
  if [[ $(jq -r .interval <<<"$body") == "$rule_group_interval_seconds" ]]; then
    echo "$step: interval already ${rule_group_interval_seconds}s"
    return
  fi
  request PUT "$group_path" "$(jq --argjson interval "$rule_group_interval_seconds" '.interval = $interval' <<<"$body")"
  require_2xx
  echo "$step: interval set to ${rule_group_interval_seconds}s"
}

if [[ $is_dry_run == true ]]; then
  print_dry_run
  exit 0
fi
find_prometheus_uid
check_contact_point
ensure_folder
save_dashboard
save_alert_rule
set_rule_group_interval
echo "Dashboard: $dashboard_url"
