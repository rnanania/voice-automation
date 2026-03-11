#!/usr/bin/env bash
set -euo pipefail

ENV_FILE=".env"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "Missing $ENV_FILE. Copy .env.example to .env and fill values."
  exit 1
fi

set -a
source "$ENV_FILE"
set +a

required_vars=(
  COGNITO_USER_POOL_ID
  COGNITO_CLIENT_ID
  NOTIFICATION_PHONE_NUMBER
  CALENDAR_SCHEDULE_GROUP_NAME
  LEX_BOT_ALIAS_ARN
  CONNECT_INSTANCE_ARN
)

for v in "${required_vars[@]}"; do
  if [[ -z "${!v:-}" ]]; then
    echo "Missing required env var: $v"
    exit 1
  fi
done

if [[ "${COGNITO_USER_POOL_ID}" == "us-east-1_XXXXXXXXX" ]] || \
   [[ "${COGNITO_CLIENT_ID}" == "xxxxxxxxxxxxxxxxxxxxxxxxxx" ]] || \
   [[ "${LEX_BOT_ALIAS_ARN}" == "arn:aws:lex:us-east-1:123456789012:bot-alias/XXXXXXXXXX/XXXXXXXXXX" ]] || \
   [[ "${CONNECT_INSTANCE_ARN}" == "arn:aws:connect:us-east-1:123456789012:instance/xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" ]]; then
  echo "Placeholder values detected in .env. Replace sample values before deploy."
  exit 1
fi

echo "Env check passed."
