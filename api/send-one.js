const { Redis } = require('@upstash/redis');
const webpush = require('web-push');
const { assertBodySize, requireServiceBearer } = require('../lib/security.js');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!requireServiceBearer(req, res, 'QSTASH_CALLBACK_SECRET')) return;
  if (!assertBodySize(req, res, 4096)) return;

  const { userId, label, emoji, message } = req.body || {};
  const expectedUid = process.env.LIFEHUB_FIREBASE_UID;
  if (!expectedUid) return res.status(503).json({ error: 'LIFEHUB_FIREBASE_UID is not configured' });
  if (userId !== expectedUid) return res.status(403).json({ error: 'Forbidden' });
  if (String(label || '').length > 80 || String(emoji || '').length > 24 || String(message || '').length > 280) {
    return res.status(400).json({ error: 'Reminder content is too long' });
  }
  if (!process.env.VAPID_PUBLIC_KEY || !process.env.VAPID_PRIVATE_KEY || !process.env.VAPID_EMAIL) {
    return res.status(503).json({ error: 'Push notifications are not configured' });
  }

  const redis = new Redis({ url: process.env.KV_REST_API_URL, token: process.env.KV_REST_API_TOKEN });
  try {
    const subRaw = await redis.get('sub:' + userId);
    if (!subRaw) return res.status(404).json({ error: 'No subscription found' });
    const subscription = typeof subRaw === 'string' ? JSON.parse(subRaw) : subRaw;
    webpush.setVapidDetails(process.env.VAPID_EMAIL, process.env.VAPID_PUBLIC_KEY, process.env.VAPID_PRIVATE_KEY);
    await webpush.sendNotification(subscription, JSON.stringify({
      title: (emoji || '') + ' ' + (label || 'Reminder'),
      body: message || 'Time to check in!',
      icon: '/Life-Hub/icon-192.jpg'
    }));
    return res.status(200).json({ ok: true });
  } catch (error) {
    console.error('Send-one error:', error.statusCode || error.message);
    if (error.statusCode === 410 || error.statusCode === 404) await redis.del('sub:' + userId);
    return res.status(500).json({ error: 'Push failed' });
  }
};