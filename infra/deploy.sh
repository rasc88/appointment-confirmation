#!/usr/bin/env bash
# Deploys one image to one environment on the EC2 instance, as root.
# Usage: infra/deploy.sh <dev|prod> <image-ref>
# #19 runs it over SSM from a checkout of the image's commit (decision 37).
# Never print a secret: no `set -x`, and SSM values go only into the env file.
set -euo pipefail

usage="usage: $0 <dev|prod> <image-ref>"
env_name="${1:-}"
image="${2:-}"

case "$env_name" in
  dev)
    host_port=8081
    app_env=dev
    ;;
  prod)
    host_port=8082
    app_env=production
    ;;
  *)
    echo "$usage" >&2
    exit 2
    ;;
esac
if [[ -z "$image" || $# -ne 2 ]]; then
  echo "$usage" >&2
  exit 2
fi

infra_dir="$(cd "$(dirname "$0")" && pwd)"
env_dir="/opt/appointment-confirmation/$env_name"
param_prefix="/appointment-confirmation/$env_name"
umask 077

# Prints the parameter's value, or nothing when it does not exist.
read_param() {
  aws ssm get-parameters --region us-east-1 --with-decryption \
    --names "$param_prefix/$1" --query 'Parameters[].Value' --output text
}

if [[ ! -f "$env_dir/secrets.env" ]]; then
  session_secret="$(openssl rand -hex 32)"
  postgres_password="$(openssl rand -hex 24)"
  {
    echo "SESSION_SECRET=$session_secret"
    echo "POSTGRES_PASSWORD=$postgres_password"
  } > "$env_dir/secrets.env.tmp"
  mv "$env_dir/secrets.env.tmp" "$env_dir/secrets.env"
  echo "Generated $env_dir/secrets.env"
fi
chmod 600 "$env_dir/secrets.env"
session_secret="$(sed -n 's/^SESSION_SECRET=//p' "$env_dir/secrets.env")"
postgres_password="$(sed -n 's/^POSTGRES_PASSWORD=//p' "$env_dir/secrets.env")"
if [[ -z "$session_secret" || -z "$postgres_password" ]]; then
  echo "$env_dir/secrets.env is incomplete" >&2
  exit 1
fi

public_base_url="$(read_param public-base-url)"
if [[ -z "$public_base_url" ]]; then
  echo "Missing parameter $param_prefix/public-base-url" >&2
  exit 1
fi
otlp_endpoint="$(read_param otlp-endpoint)"
otlp_headers="$(read_param otlp-headers)"
if [[ -n "$otlp_endpoint" && -z "$otlp_headers" ]]; then
  echo "Missing parameter $param_prefix/otlp-headers (otlp-endpoint is set)" >&2
  exit 1
fi
if [[ -z "$otlp_endpoint" && -n "$otlp_headers" ]]; then
  echo "Missing parameter $param_prefix/otlp-endpoint (otlp-headers is set)" >&2
  exit 1
fi

# Single quotes keep Compose from interpolating `$` inside a value.
{
  echo "IMAGE='$image'"
  echo "HOST_PORT='$host_port'"
  echo "APP_ENV='$app_env'"
  echo "PUBLIC_BASE_URL='$public_base_url'"
  echo "SESSION_SECRET='$session_secret'"
  echo "POSTGRES_PASSWORD='$postgres_password'"
  echo "DATABASE_URL='postgresql://app:$postgres_password@db:5432/appointments'"
  if [[ -n "$otlp_endpoint" ]]; then
    echo "OTEL_EXPORTER_OTLP_ENDPOINT='$otlp_endpoint'"
    echo "OTEL_EXPORTER_OTLP_HEADERS='$otlp_headers'"
  fi
} > "$env_dir/.env.tmp"
mv "$env_dir/.env.tmp" "$env_dir/.env"
chmod 600 "$env_dir/.env"

compose_files=(-f "$infra_dir/compose.yaml")
if [[ "$env_name" == dev ]]; then
  compose_files+=(-f "$infra_dir/compose.dev.yaml")
fi
compose() {
  docker compose --project-name "ac-$env_name" --env-file "$env_dir/.env" "${compose_files[@]}" "$@"
}

# `missing` pulls every image not on the host yet, so a tag built on the
# instance (docs/operations.md) deploys too; a tag that is neither local nor in the
# registry fails here, before anything running is touched.
compose pull --policy missing
compose up -d
docker image prune -af
echo "Deployed $image to $env_name"
