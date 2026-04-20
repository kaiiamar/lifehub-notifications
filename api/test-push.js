const { Redis } = require('@upstash/redis');
const webpush = require('web-push');

webpush.setVapidDetails(
  process.env.VAPID_EMAIL || 'mailto:[email]',
  process.env.VAPID_PUBLIC_KEY,
  process.env.VAPID_PRIVATE_KEY
);

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  try {
    var userId = req.query.userId || 'kai-lifehub';
    const redis = new Redis({ url: process.env.KV_REST_API_URL, token: process.env.KV_REST_API_TOKEN });
    const subRaw = await redis.get('sub:' + userId);

    if (!subRaw) {
      return res.status(200).json({ error: 'No push subscription found for ' + userId, hint: 'The browser needs to subscribe first. Open the app and enable notifications.' });
    }

    const subscription = typeof subRaw === 'string' ? JSON.parse(subRaw) : subRaw;

    await webpush.sendNotification(subscription, JSON.stringify({
      title: '\uD83D\uDD14 Test notification',
      body: 'If you see this, push notifications are working!',
      icon: '/icon-192.png'
    }));

    res.status(200).json({ ok: true, message: 'Test notification sent!' });
  } catch (e) {
    res.status(200).json({ error: 'Push failed', detail: e.message, statusCode: e.statusCode });
  }
};
