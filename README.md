# Life Hub notifications backend

Private Vercel functions for authenticated browser AI/push requests, Telegram, and QStash schedules.

## Required environment

| Variable | Purpose |
|---|---|
| `APP_ORIGIN` | Exact frontend origin allowed by CORS, e.g. `https://example.github.io` |
| `APP_URL` | This backend's HTTPS origin |
| `FIREBASE_SERVICE_ACCOUNT` | Firebase Admin service-account JSON |
| `LIFEHUB_FIREBASE_UID` | The only Firebase Authentication UID allowed to call browser APIs |
| `LIFEHUB_USER_ID` | Firestore document ID; defaults to `kai` |
| `KV_REST_API_URL`, `KV_REST_API_TOKEN` | Upstash Redis and rate limiting |
| `QSTASH_TOKEN` | QStash schedule administration |
| `QSTASH_CALLBACK_SECRET` | Random bearer secret placed on QStash deliveries |
| `CRON_SECRET` | Bearer secret required by the cron endpoint |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_EMAIL` | Web Push credentials |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` | Private Telegram bot |
| `TELEGRAM_SETUP_SECRET` | Bearer secret for setup and schedule administration |
| `TELEGRAM_WEBHOOK_SECRET` | Telegram webhook `secret_token` |
| `ANTHROPIC_API_KEY` | AI narrative and review generation |

Generate long independent random values for every `*_SECRET`; never commit them.

## Security model

- Browser endpoints verify a Firebase ID token and bind it to `LIFEHUB_FIREBASE_UID`.
- Browser CORS is restricted to `APP_ORIGIN`; submitted user IDs are ignored.
- QStash destinations require `QSTASH_CALLBACK_SECRET`.
- Telegram updates require Telegram's webhook secret header.
- Setup, schedule, and cron endpoints fail closed when their secret is absent.
- Mutable and AI endpoints enforce request-size and Redis-backed rate limits.

## Deploy

1. Configure all relevant variables in Vercel and redeploy.
2. Register the Telegram webhook with the secured command in `api/telegram/README.md`.
3. Re-register schedules only after reviewing the deletion impact.
4. Confirm the deployed Firestore rule contains the real UID, not the repository placeholder.
5. Smoke-test authenticated AI, push subscription, Telegram webhook, and one scheduled callback.

The checked-in configuration does not perform live setup, schedule deletion, credential rotation, or Firestore deployment.