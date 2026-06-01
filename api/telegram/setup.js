// One-time setup endpoint to register the Telegram webhook.
// Call: POST /api/telegram/setup?secret=<TELEGRAM_SETUP_SECRET>
// Once this runs successfully, Telegram will deliver all messages from your bot
// to /api/telegram/webhook.
const { tg } = require('./_helpers.js');

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();

  // Light protection — don't let randos call this
  const secret = req.query.secret || (req.body && req.body.secret);
  if (process.env.TELEGRAM_SETUP_SECRET && secret !== process.env.TELEGRAM_SETUP_SECRET) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  const baseUrl = process.env.APP_URL || (process.env.VERCEL_URL ? 'https://' + process.env.VERCEL_URL : '');
  if (!baseUrl) return res.status(500).json({ error: 'APP_URL not set' });

  const webhookUrl = baseUrl.replace(/\/$/, '') + '/api/telegram/webhook';

  try {
    const result = await tg('setWebhook', {
      url: webhookUrl,
      allowed_updates: ['message', 'callback_query']
    });
    // Also fetch info to confirm
    const info = await tg('getWebhookInfo', {});
    return res.status(200).json({ ok: true, set: result, info });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
