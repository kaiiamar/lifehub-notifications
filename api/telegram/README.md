# Life Hub Telegram bot

Single-user bot for logging gratitude, habits, mood, sleep and water without opening the app.

## Required env vars in Vercel

| Variable | Purpose |
|---|---|
| `TELEGRAM_BOT_TOKEN` | From @BotFather |
| `TELEGRAM_CHAT_ID` | Your numeric chat ID (see Setup) |
| `TELEGRAM_SETUP_SECRET` | Random string protecting setup/schedule endpoints |
| `FIREBASE_SERVICE_ACCOUNT` | Full JSON of a Firebase service account (paste as one-line JSON) |
| `LIFEHUB_USER_ID` | Defaults to `kai` — Firestore doc id under `users/` |
| `APP_URL` | Already set — your Vercel URL |
| `TZ_OFFSET` | Already set — hours offset from UTC (UK: 0 winter, 1 summer) |
| `QSTASH_TOKEN` | Already set |

## First-time setup

1. **Create the bot.** Talk to `@BotFather` on Telegram. Send `/newbot`. Save the token.
2. **Add env vars** in Vercel (Settings → Environment Variables). At minimum: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_SETUP_SECRET`, `FIREBASE_SERVICE_ACCOUNT`. Redeploy.
3. **Get your chat ID.** Message your bot anything (e.g. `hi`). The bot will reply with your chat ID. Copy it.
4. **Add `TELEGRAM_CHAT_ID`** to Vercel env vars. Redeploy.
5. **Register the webhook.** Visit (or POST):
   ```
   https://<your-vercel-url>/api/telegram/setup?secret=<your-setup-secret>
   ```
   Should return `ok: true`. Now Telegram will deliver messages to the bot.
6. **Register the schedules.** Same secret:
   ```
   https://<your-vercel-url>/api/telegram/schedule?secret=<your-setup-secret>
   ```
   Creates QStash crons for 7am morning, anchor habit prompts, water, 9pm bedtime, Saturday weekly.
7. **Test.** Message `/start` to your bot. Expect a welcome reply. Try `/today`, `mood 4`, `gratitude: testing the bot`.

## Daily schedule (local time)

| Time | Prompt |
|---|---|
| 07:00 | Mood emoji buttons + sleep follow-up |
| 09:00 | Morning-anchored daily habits (tap-to-tick) |
| 11:00 | Water reminder |
| 13:00 | Midday-anchored daily habits |
| 14:00 | Water reminder |
| 17:00 | Water reminder |
| 19:00 | Evening-anchored daily habits |
| 20:00 | Water reminder |
| 21:00 | Bedtime catch-up: untracked daily habits + gratitude reflection |
| Sat 14:00 | Weekly habits check-in |

## Free-form commands

Send any of these as plain text to the bot:

- `gratitude: <text>` — log a gratitude entry
- `win: <text>` — log a win
- `tick <habit name>` — fuzzy-matches and ticks a habit
- `mood 1-5` — quick mood log
- `sleep 7.5` — log sleep hours
- `water 250` — add water in ml
- `/today` — show what is still untracked
- `/help` — list commands

## Re-registering webhook / schedules

If the Vercel URL changes, run setup + schedule again. They wipe and recreate.

## Endpoints

- `POST /api/telegram/webhook` — Telegram delivers updates here (do not call directly)
- `POST /api/telegram/setup?secret=...` — Register webhook
- `POST /api/telegram/schedule?secret=...` — Register/refresh QStash schedules
- `POST /api/telegram/prompt` (body: `{type:...}`) — Internal, called by QStash. Can also be hit manually to test a prompt: `?type=morning`, `?type=bedtime`, etc.
