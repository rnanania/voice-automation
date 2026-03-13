# Appointment Service (AWS SAM)
Project was started with simple prompt to Cursor using GPT-5.3 Codex.

Serverless appointment API with AWS SAM, Node.js/Express, Lambda, API Gateway, DynamoDB, and S3.  
Voice channel is Amazon Connect + Lex V2 with OTP-by-SMS verification for sensitive actions.

## Quick Start

1. Install prerequisites:
   - `brew install aws-sam-cli`
   - `sam --version`
   - `aws configure`
2. Create `.env` from sample and fill values:
   - `cp .env.example .env`
3. Build + deploy:
   - `npm run env:check`
   - `npm run deploy:env`
4. Get outputs:
   - `aws cloudformation describe-stacks --stack-name voice-automation-dev --query "Stacks[0].Outputs[?OutputKey=='ApiUrl' || OutputKey=='VoiceFulfillmentFunctionArn' || OutputKey=='PhoneAuthTableName'].[OutputKey,OutputValue]" --output table`

Preflight placeholder check:

```bash
bash -c 'set -e; FILE=".env"; REQUIRED=("COGNITO_USER_POOL_ID=" "COGNITO_CLIENT_ID=" "NOTIFICATION_PHONE_NUMBER=" "CALENDAR_SCHEDULE_GROUP_NAME=" "LEX_BOT_ALIAS_ARN=" "CONNECT_INSTANCE_ARN="); for key in "${REQUIRED[@]}"; do if ! rg -n --fixed-strings "$key" "$FILE" >/dev/null; then echo "ERROR: missing $key in $FILE"; exit 1; fi; done; if rg -n "^COGNITO_USER_POOL_ID=us-east-1_XXXXXXXXX$|^COGNITO_CLIENT_ID=xxxxxxxxxxxxxxxxxxxxxxxxxx$|^LEX_BOT_ALIAS_ARN=arn:aws:lex:us-east-1:123456789012:bot-alias/XXXXXXXXXX/XXXXXXXXXX$|^CONNECT_INSTANCE_ARN=arn:aws:connect:us-east-1:123456789012:instance/xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx$" "$FILE" >/dev/null; then echo "ERROR: .env still has example placeholder values"; exit 1; fi; echo "Preflight passed."'
```

## AWS Prerequisites Before First Deploy

Assuming your AWS principal has admin access, complete these once:

1. Configure AWS CLI and region (~5 min)
   - Run:
     - `aws configure`
     - `aws configure set region us-east-1` (or your preferred region)
     - `aws sts get-caller-identity`
   - Confirm account ID is correct and keep all services in this same region (Cognito, Lex, Connect, Lambda).

2. Create or reuse Cognito User Pool and App Client (~10-20 min)
   - Console path: `Cognito` -> `User Pools` -> `Create user pool` (or open existing).
   - Create an app client under `App integration` -> `App clients`.
   - Copy:
     - User Pool ID -> `CognitoUserPoolId`
     - App Client ID -> `CognitoClientId`
   - Put both values in `samconfig.toml`.

3. Create Lex V2 bot and alias (~20-40 min)
   - Console path: `Amazon Lex` -> `Bots` -> `Create bot`.
   - Add intents used by this project:
     - `BookAppointmentIntent`
     - `VerifyOtpIntent`
     - `CancelAppointmentIntent`
     - `RescheduleAppointmentIntent`
     - `ViewAppointmentsIntent`
     - `ViewAppointmentDetailsIntent`
     - `ViewAppointmentHistoryIntent`
   - Build locale and create/publish an alias.
   - Copy alias ARN (from alias details) into `LexBotAliasArn`.

4. Create or reuse Amazon Connect instance and phone number (~15-30 min)
   - Console path: `Amazon Connect` -> `Instance alias` -> `Telephony` -> `Claim a number`.
   - Copy instance ARN from the instance overview page into `ConnectInstanceArn`.
   - You will map contact flow to this number after deploy.

5. Set SMS configuration values (~5 min)
   - `NotificationPhoneNumber` must be E.164 format (example: `+12065550100`).
   - This is used for service-level text communication config.
   - OTP messages are sent to the live caller phone captured during the call flow.

6. Set scheduler group value (~2 min)
   - Use `CalendarScheduleGroupName=appointments` (or another name).
   - Keep it simple for POC; this is used for calendar/scheduling integration settings.

7. Update `.env` and verify (~5 min)
   - `cp .env.example .env` (if not already done)
   - Set required values:
     - `COGNITO_USER_POOL_ID`
     - `COGNITO_CLIENT_ID`
     - `NOTIFICATION_PHONE_NUMBER`
     - `CALENDAR_SCHEDULE_GROUP_NAME`
     - `LEX_BOT_ALIAS_ARN`
     - `CONNECT_INSTANCE_ARN`
   - Optional:
     - `SERVICE_TIMEZONE` (default `America/New_York`)
     - `SERVICE_LANGUAGE` (default `en-US`)
     - `SERVICE_CURRENCY` (default `USD`)
   - Run preflight command from this README.

8. Deploy and capture outputs (~5-10 min)
   - Run:
     - `npm run deploy:env`
   - Capture outputs:
     - `ApiUrl`
     - `VoiceFulfillmentFunctionArn`
     - `PhoneAuthTableName`
   - Command:
     - `aws cloudformation describe-stacks --stack-name voice-automation-dev --query "Stacks[0].Outputs[?OutputKey=='ApiUrl' || OutputKey=='VoiceFulfillmentFunctionArn' || OutputKey=='PhoneAuthTableName'].[OutputKey,OutputValue]" --output table`

9. Connect Lex to Lambda and Connect flow (~10-20 min)
   - In Lex alias, configure fulfillment/code hook Lambda as `VoiceFulfillmentFunctionArn`.
   - In Amazon Connect contact flow:
     - Use `Get customer input` with your Lex bot alias.
     - Publish flow and assign it to claimed number.
   - Place a test call and verify:
     - Booking works with day/time in New York timezone.
     - Sensitive intents request OTP and require verification before action.

## API Endpoints

- `POST /appointments` (requires `firstName`, `lastName`, and `scheduledAt` or `scheduledDay` + `scheduledTime`)
- `POST /appointments/{appointmentId}/cancel`
- `PUT /appointments/{appointmentId}/reschedule` (`scheduledAt` or `scheduledDay` + `scheduledTime`)
- `GET /appointments`
- `GET /appointments/{appointmentId}`
- `GET /appointments/{appointmentId}/history`
- `GET /config`
- `GET /health`

Booking constraint:
- A phone number can have only one future active appointment (`BOOKED` or `RESCHEDULED`).
- If another future appointment exists, booking returns `409` and includes the existing `appointmentId`.
- Past appointments are unlimited.
- Appointments are fixed 15-minute windows and must start on quarter-hour boundaries (`:00`, `:15`, `:30`, `:45`).
- Only one user can hold a given 15-minute window at a time across the whole system.

## API Auth and Identity

- API is protected by Cognito JWT authorizer (API Gateway).
- Pass `Authorization: Bearer <token>` for API requests.
- Ownership is phone-based (`contactPhone`).
- For local `sam local start-api`, identity header fallback is supported:
  - `x-user-phone` (required locally)
  - `x-user-id` (optional)

## API Smoke Test

Set `API_URL`, then call with token:

```bash
curl -X POST "$API_URL/appointments" \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -H "x-user-phone: +12065551234" \
  -d '{"firstName":"Rohit","lastName":"Nanania","scheduledDay":"2026-03-20","scheduledTime":"3:00 PM","notes":"Initial consultation","source":"phone"}'
```

Scheduling is normalized to `America/New_York` (EST/EDT), then stored as UTC.
Examples:
- Valid: `12:00`, `12:15`, `12:30`, `12:45`
- Invalid: `12:10`, `12:22`

## Voice Setup (Connect + Lex)

1. Create Lex V2 bot and intents:
   - `BookAppointmentIntent` (`FirstName`, `LastName`, `ScheduledDay`, `ScheduledTime`, optional `Notes`)
   - `VerifyOtpIntent` (`OtpCode`)
   - `CancelAppointmentIntent` (`AppointmentId`, optional `Reason`)
   - `RescheduleAppointmentIntent` (`AppointmentId`, `ScheduledDay`, `ScheduledTime`, optional `Reason`)
   - `ViewAppointmentsIntent`
   - `ViewAppointmentDetailsIntent` (`AppointmentId`)
   - `ViewAppointmentHistoryIntent` (`AppointmentId`)
2. Set Lex fulfillment Lambda to `VoiceFulfillmentFunctionArn`.
3. In Amazon Connect:
   - claim phone number
   - use contact flow with Lex (`Get customer input`)
   - publish and assign flow to number

Voice security behavior:
- `cancel`, `reschedule`, `details`, and `history` require OTP verification first.
- OTP is sent by SMS to caller phone and verified via `VerifyOtpIntent`.

Deploy helpers:
- `npm run env:check`
- `npm run deploy:env` (dev)
- `npm run deploy:env:stage`
- `npm run deploy:env:prod`

## Sample Phone Call Walkthrough

This is a realistic example of how the service works during a live call.

1. Caller books an appointment
   - Caller says: "Book an appointment for John Doe tomorrow at 3 PM."
   - Lex intent: `BookAppointmentIntent`
   - Service action:
     - Converts day/time using `America/New_York`
     - Stores appointment in DynamoDB
     - Writes archive snapshot to S3
   - Voice response example:
     - "Booked. Your appointment ID is `<appointmentId>`."

2. Caller asks for details (OTP required)
   - Caller says: "Show details for appointment `<appointmentId>`."
   - Lex intent: `ViewAppointmentDetailsIntent`
   - Service action:
     - Sends OTP by SMS to caller phone
   - Voice response example:
     - "For security, I sent a verification code by text. Say verify code and provide the 6-digit code."

3. Caller verifies OTP
   - Caller says: "Verify code 123456."
   - Lex intent: `VerifyOtpIntent`
   - Service action:
     - Validates OTP from `PhoneAuthTable` (TTL-based)
   - Voice response example:
     - "Verification successful. You can continue with your request."

4. Caller retries details / reschedules / cancels
   - Caller says: "Show details for appointment `<appointmentId>`."
   - Or: "Reschedule appointment `<appointmentId>` to Friday at 10 AM."
   - Or: "Cancel appointment `<appointmentId>`."
   - Service action:
     - Allows action now that phone is verified
     - Enforces phone-based ownership (`contactPhone`)

5. Booking rule behavior
   - If caller already has one future active appointment, a second booking is blocked.
   - Caller must cancel existing future appointment or reschedule it.
   - If requested 15-minute slot is already taken by someone else, booking/rescheduling is rejected.

## Key Parameters

In `template.yaml`:

- `CognitoUserPoolId`
- `CognitoClientId`
- `ServiceTimezone`
- `ServiceLanguage`
- `ServiceCurrency`
- `CalendarScheduleGroupName`
- `NotificationPhoneNumber` (E.164)
- `LexBotAliasArn`
- `ConnectInstanceArn`
- `AppointmentSlotsTable` (output only; stores global 15-minute slot locks)

In `.env` (used by deploy script):

- `COGNITO_USER_POOL_ID`
- `COGNITO_CLIENT_ID`
- `SERVICE_TIMEZONE` (optional)
- `SERVICE_LANGUAGE` (optional)
- `SERVICE_CURRENCY` (optional)
- `CALENDAR_SCHEDULE_GROUP_NAME`
- `NOTIFICATION_PHONE_NUMBER`
- `LEX_BOT_ALIAS_ARN`
- `CONNECT_INSTANCE_ARN`

## Troubleshooting

- Lex invoke issues:
  - confirm `LexBotAliasArn`
  - check Lambda policy includes `lexv2.amazonaws.com`
- Connect invoke issues:
  - confirm `ConnectInstanceArn`
  - check Lambda policy includes `connect.amazonaws.com`
- Check policy quickly:
  - `aws lambda get-policy --function-name <VoiceFulfillmentFunctionArn>`
- Tail logs:
  - `sam logs -n VoiceFulfillmentFunction --stack-name voice-automation-dev --tail`

## Cleanup

- Delete env stack:
  - `sam delete --config-env dev`
  - `sam delete --config-env stage`
  - `sam delete --config-env prod`
