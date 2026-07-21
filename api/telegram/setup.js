// One-time setup endpoint to register the Telegram webhook.
// Call with POST and Authorization: Bearer <TELEGRAM_SETUP_SECRET>.
// Once this runs successfully, Telegram will deliver all messages from your bot
// to /api/telegram/webhook.
const { tg } = require('./_helpers.js');
const { requireServiceBearer } = require('../../lib/security.js');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!requireServiceBearer(req, res, 'TELEGRAM_SETUP_SECRET')) return;
  if (!process.env.TELEGRAM_WEBHOOK_SECRET) {
    return res.status(503).json({ error: 'TELEGRAM_WEBHOOK_SECRET is not configured' });
  }

  const baseUrl = process.env.APP_URL || (process.env.VERCEL_URL ? 'https://' + process.env.VERCEL_URL : '');
  if (!baseUrl) return res.status(500).json({ error: 'APP_URL not set' });

  const webhookUrl = baseUrl.replace(/\/$/, '') + '/api/telegram/webhook';

  try {
    const result = await tg('setWebhook', {
      url: webhookUrl,
      secret_token: process.env.TELEGRAM_WEBHOOK_SECRET,
      allowed_updates: ['message', 'callback_query']
    });
    // Also fetch info to confirm
    const info = await tg('getWebhookInfo', {});
    return res.status(200).json({ ok: true, set: result, info });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
