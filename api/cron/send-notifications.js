const { Redis } = require('@upstash/redis');
const webpush = require('web-push');
const { requireServiceBearer } = require('../../lib/security.js');

module.exports = async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!requireServiceBearer(req, res, 'CRON_SECRET')) return;
  const userId = process.env.LIFEHUB_FIREBASE_UID;
  if (!userId) return res.status(503).json({ error: 'LIFEHUB_FIREBASE_UID is not configured' });
  if (!process.env.VAPID_PUBLIC_KEY || !process.env.VAPID_PRIVATE_KEY || !process.env.VAPID_EMAIL) {
    return res.status(503).json({ error: 'Push notifications are not configured' });
  }

  try {
    const redis = new Redis({ url: process.env.KV_REST_API_URL, token: process.env.KV_REST_API_TOKEN });
    const remindersRaw = await redis.get('reminders:' + userId);
    const subRaw = await redis.get('sub:' + userId);
    if (!remindersRaw || !subRaw) return res.status(200).json({ ok: true, checked: 1, sent: 0 });

    const reminders = typeof remindersRaw === 'string' ? JSON.parse(remindersRaw) : remindersRaw;
    const subscription = typeof subRaw === 'string' ? JSON.parse(subRaw) : subRaw;
    const enabled = Array.isArray(reminders) ? reminders.filter(function (item) { return item.enabled; }) : [];
    if (!enabled.length) return res.status(200).json({ ok: true, checked: 1, sent: 0 });

    const today = new Date().toISOString().slice(0, 10);
    const firedKey = 'fired:' + userId + ':daily:' + today;
    if (await redis.get(firedKey)) return res.status(200).json({ ok: true, checked: 1, sent: 0 });

    const lines = enabled.map(function (item) {
      const hour = (item.hour < 10 ? '0' : '') + item.hour;
      const minute = (item.minute < 10 ? '0' : '') + item.minute;
      return item.emoji + ' ' + item.label + ' (' + hour + ':' + minute + ')';
    });
    webpush.setVapidDetails(process.env.VAPID_EMAIL, process.env.VAPID_PUBLIC_KEY, process.env.VAPID_PRIVATE_KEY);
    await webpush.sendNotification(subscription, JSON.stringify({
      title: '\u2600\uFE0F Good morning!',
      body: 'Today\'s reminders: ' + enabled.length + '\n' + lines.join(' \u00b7 '),
      icon: '/Life-Hub/icon-192.jpg'
    }));
    await redis.set(firedKey, '1', { ex: 86400 });
    return res.status(200).json({ ok: true, checked: 1, sent: 1 });
  } catch (error) {
    console.error('Cron error:', error.statusCode || error.message);
    if (error.statusCode === 410 || error.statusCode === 404) {
      try {
        const redis = new Redis({ url: process.env.KV_REST_API_URL, token: process.env.KV_REST_API_TOKEN });
        await redis.del('sub:' + userId);
      } catch (cleanupError) { /* Keep the original delivery error. */ }
    }
    return res.status(500).json({ error: 'Cron failed' });
  }
};