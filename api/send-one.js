const { Redis } = require('@upstash/redis');
const webpush = require('web-push');

webpush.setVapidDetails(
  process.env.VAPID_EMAIL || 'mailto:[email]',
  process.env.VAPID_PUBLIC_KEY,
  process.env.VAPID_PRIVATE_KEY
);

module.exports = async function handler(req, res) {
  try {
    const { userId, label, emoji, message } = req.body || {};
    if (!userId) return res.status(400).json({ error: 'Missing userId' });

    const redis = new Redis({ url: process.env.KV_REST_API_URL, token: process.env.KV_REST_API_TOKEN });
    const subRaw = await redis.get('sub:' + userId);
    if (!subRaw) return res.status(404).json({ error: 'No subscription found' });

    const subscription = typeof subRaw === 'string' ? JSON.parse(subRaw) : subRaw;

    await webpush.sendNotification(subscription, JSON.stringify({
      title: (emoji || '') + ' ' + (label || 'Reminder'),
      body: message || 'Time to check in!',
      icon: '/icon-192.png'
    }));

    res.status(200).json({ ok: true });
  } catch (e) {
    console.error('Send-one error:', e.statusCode || e.message);
    if (e.statusCode === 410 || e.statusCode === 404) {
      // Clean up dead subscription
      const redis = new Redis({ url: process.env.KV_REST_API_URL, token: process.env.KV_REST_API_TOKEN });
      await redis.del('sub:' + (req.body && req.body.userId));
    }
    res.status(500).json({ error: 'Push failed' });
  }
};
