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
    const now = new Date();
    const hour = now.getHours();
    const minute = now.getMinutes();

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

      for (const r of reminders) {
        if (!r.enabled) continue;
        if (r.hour !== hour || r.minute !== minute) continue;

        const today = now.toISOString().slice(0, 10);
        const firedKey = `fired:${userId}:${r.id}:${today}`;
        const alreadyFired = await redis.get(firedKey);
        if (alreadyFired) continue;

        try {
          await webpush.sendNotification(subscription, JSON.stringify({
            title: r.emoji + ' ' + r.label,
            body: r.message,
            icon: '/icon-192.png'
          }));
          await redis.set(firedKey, '1', { ex: 86400 });
          sent++;
        } catch (pushErr) {
          console.error('Push failed for', userId, r.id, pushErr.statusCode || pushErr.message);
          if (pushErr.statusCode === 410 || pushErr.statusCode === 404) {
            await redis.del(`sub:${userId}`);
          }
        }
      }
    }

    res.status(200).json({ ok: true, checked: keys.length, sent: sent });
  } catch (e) {
    console.error('Cron error:', e);
    res.status(500).json({ error: 'Cron failed' });
  }
};
