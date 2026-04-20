const { Redis } = require('@upstash/redis');
const webpush = require('web-push');

webpush.setVapidDetails(
  process.env.VAPID_EMAIL || 'mailto:[email]',
  process.env.VAPID_PUBLIC_KEY,
  process.env.VAPID_PRIVATE_KEY
);

module.exports = async function handler(req, res) {
  try {
    const redis = new Redis({ url: process.env.KV_REST_API_URL, token: process.env.KV_REST_API_TOKEN });
    const today = new Date().toISOString().slice(0, 10);

    // Scan for all reminder keys
    const keys = [];
    let cursor = 0;
    do {
      const result = await redis.scan(cursor, { match: 'reminders:*', count: 100 });
      cursor = result[0];
      keys.push(...result[1]);
    } while (cursor !== 0);

    let sent = 0;

    for (const key of keys) {
      const userId = key.replace('reminders:', '');
      const remindersRaw = await redis.get(key);
      if (!remindersRaw) continue;

      const reminders = typeof remindersRaw === 'string' ? JSON.parse(remindersRaw) : remindersRaw;
      const subRaw = await redis.get(`sub:${userId}`);
      if (!subRaw) continue;

      const subscription = typeof subRaw === 'string' ? JSON.parse(subRaw) : subRaw;
      const enabled = reminders.filter(function(r) { return r.enabled; });
      if (!enabled.length) continue;

      // Send a single daily summary notification
      const firedKey = `fired:${userId}:daily:${today}`;
      const alreadyFired = await redis.get(firedKey);
      if (alreadyFired) continue;

      const lines = enabled.map(function(r) {
        return r.emoji + ' ' + r.label + ' (' + (r.hour < 10 ? '0' : '') + r.hour + ':' + (r.minute < 10 ? '0' : '') + r.minute + ')';
      });

      try {
        await webpush.sendNotification(subscription, JSON.stringify({
          title: '\u2600\uFE0F Good morning!',
          body: 'Today\'s reminders: ' + enabled.length + '\n' + lines.join(' \u00b7 '),
          icon: '/icon-192.png'
        }));
        await redis.set(firedKey, '1', { ex: 86400 });
        sent++;
      } catch (pushErr) {
        console.error('Push failed for', userId, pushErr.statusCode || pushErr.message);
        if (pushErr.statusCode === 410 || pushErr.statusCode === 404) {
          await redis.del(`sub:${userId}`);
        }
      }
    }

    res.status(200).json({ ok: true, checked: keys.length, sent: sent });
  } catch (e) {
    console.error('Cron error:', e);
    res.status(500).json({ error: 'Cron failed' });
  }
};
