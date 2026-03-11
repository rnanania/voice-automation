#!/usr/bin/env bash
set -euo pipefail

CONFIG_ENV="${1:-dev}"
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

SERVICE_TIMEZONE="${SERVICE_TIMEZONE:-America/New_York}"
SERVICE_LANGUAGE="${SERVICE_LANGUAGE:-en-US}"
SERVICE_CURRENCY="${SERVICE_CURRENCY:-USD}"

PARAMS=(
  "CognitoUserPoolId=$COGNITO_USER_POOL_ID"
  "CognitoClientId=$COGNITO_CLIENT_ID"
  "ServiceTimezone=$SERVICE_TIMEZONE"
  "ServiceLanguage=$SERVICE_LANGUAGE"
  "ServiceCurrency=$SERVICE_CURRENCY"
  "CalendarScheduleGroupName=$CALENDAR_SCHEDULE_GROUP_NAME"
  "NotificationPhoneNumber=$NOTIFICATION_PHONE_NUMBER"
  "LexBotAliasArn=$LEX_BOT_ALIAS_ARN"
  "ConnectInstanceArn=$CONNECT_INSTANCE_ARN"
)

echo "Building with SAM..."
sam build

echo "Deploying with samconfig env: $CONFIG_ENV"
sam deploy --config-env "$CONFIG_ENV" --parameter-overrides "${PARAMS[@]}"
