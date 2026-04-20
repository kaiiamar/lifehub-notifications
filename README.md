# Life Hub Notifications Backend

Push notification server for Kai's Life Hub.

## Setup

### 1. Create GitHub repo
- Go to github.com/new
- Name it `lifehub-notifications`
- Push this folder to it

### 2. Sign up for Vercel
- Go to vercel.com and sign up with GitHub
- Click "Import Project" and select the `lifehub-notifications` repo

### 3. Generate VAPID keys
```bash
cd lifehub-notifications
npm install
npm run generate-vapid
```
This prints two keys. Copy them.

### 4. Add environment variables in Vercel
Go to your project Settings > Environment Variables and add:
- `VAPID_PUBLIC_KEY` — the public key from step 3
- `VAPID_PRIVATE_KEY` — the private key from step 3
- `VAPID_EMAIL` — `mailto:your@email.com`

### 5. Enable Vercel KV
- In your Vercel project, go to Storage tab
- Create a new KV store (free tier)
- It auto-connects the environment variables

### 6. Deploy
Vercel auto-deploys on push. The cron job runs every minute and checks if any reminders need sending.

### 7. Update Life Hub
Set `NOTIF_API` in your Life Hub to your Vercel URL (e.g. `https://lifehub-notifications.vercel.app`).
