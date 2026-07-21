# Life Hub Telegram bot

Single-user bot for logging and scheduled Life Hub check-ins.

## Required security variables

- `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID`
- `TELEGRAM_SETUP_SECRET`: bearer secret for setup/schedule administration
- `TELEGRAM_WEBHOOK_SECRET`: random Telegram `secret_token`
- `QSTASH_TOKEN` and independent `QSTASH_CALLBACK_SECRET`
- `FIREBASE_SERVICE_ACCOUNT`, `LIFEHUB_FIREBASE_UID`, and `LIFEHUB_USER_ID`
- `APP_URL`, Redis variables, and `TZ_OFFSET`

## First-time setup

1. Create the bot with `@BotFather` and configure the required Vercel variables.
2. Redeploy so all handlers see the new secrets.
3. Register the webhook:

```bash
curl -X POST \
  -H "Authorization: Bearer $TELEGRAM_SETUP_SECRET" \
  "$APP_URL/api/telegram/setup"
```

The setup call registers `TELEGRAM_WEBHOOK_SECRET`; direct webhook requests without Telegram's matching header are rejected.

4. Review existing QStash schedules, then register the current set:

```bash
curl -X POST \
  -H "Authorization: Bearer $TELEGRAM_SETUP_SECRET" \
  "$APP_URL/api/telegram/schedule"
```

**Caution:** schedule registration deletes existing Life Hub Telegram schedules marked with `__telegram` before recreating them. Inspect unmarked legacy schedules separately.

## Current local schedule

- 08:00 consolidated morning check-in
- 12:30 midday check-in
- 15:00 conditional water prompt
- 17:00 conditional re-entry check
- 22:00 evening check-in
- Sunday 09:00 weekly review

## Protected endpoints

- `POST /api/telegram/webhook`: Telegram secret header and configured chat ID
- `POST /api/telegram/prompt`: `QSTASH_CALLBACK_SECRET` bearer only
- `POST /api/telegram/setup`: `TELEGRAM_SETUP_SECRET` bearer only
- `POST /api/telegram/schedule`: `TELEGRAM_SETUP_SECRET` bearer only

Prompt `GET` requests and query-string setup secrets are intentionally unsupported.