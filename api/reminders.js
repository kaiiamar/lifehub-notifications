const { Redis } = require('@upstash/redis');
const { Client } = require('@upstash/qstash');

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();

  const userId = req.query.userId || (req.body && req.body.userId);
  if (!userId) return res.status(400).json({ error: 'Missing userId' });

  const redis = new Redis({ url: process.env.KV_REST_API_URL, token: process.env.KV_REST_API_TOKEN });

  if (req.method === 'GET') {
    try {
      const data = await redis.get('reminders:' + userId);
      return res.status(200).json({ reminders: data || null });
    } catch (e) {
      return res.status(500).json({ error: 'Server error' });
    }
  }

  if (req.method === 'POST') {
    try {
      const { reminders } = req.body;
      if (!reminders) return res.status(400).json({ error: 'Missing reminders' });

      // Save to Redis
      await redis.set('reminders:' + userId, JSON.stringify(reminders));

      // Sync QStash schedules
      const qstash = new Client({ token: process.env.QSTASH_TOKEN });
      const baseUrl = process.env.APP_URL || (process.env.VERCEL_URL ? 'https://' + process.env.VERCEL_URL : '');

      if (!baseUrl) {
        return res.status(200).json({ ok: true, schedules: 'skipped - no APP_URL' });
      }

      // Get existing schedules and delete old ones for this user
      try {
        const existing = await qstash.schedules.list();
        for (const sched of existing) {
          if (sched.body) {
            try {
              const body = JSON.parse(sched.body);
              if (body.userId === userId) {
                await qstash.schedules.delete(sched.scheduleId);
              }
            } catch (pe) { /* ignore parse errors */ }
          }
        }
      } catch (listErr) {
        console.error('List schedules error:', listErr.message);
      }

      // Create new schedules for enabled reminders
      // Convert local time to UTC (offset from env var, default 0)
      var tzOffset = Number(process.env.TZ_OFFSET || 0);
      var created = 0;
      for (const r of reminders) {
        if (!r.enabled) continue;
        try {
          var utcHour = r.hour - tzOffset;
          if (utcHour < 0) utcHour += 24;
          if (utcHour >= 24) utcHour -= 24;
          await qstash.schedules.create({
            destination: baseUrl + '/api/send-one',
            cron: r.minute + ' ' + utcHour + ' * * *',
            body: JSON.stringify({
              userId: userId,
              label: r.label,
              emoji: r.emoji,
              message: r.message
            }),
            headers: { 'Content-Type': 'application/json' }
          });
          created++;
        } catch (schedErr) {
          console.error('Schedule create error:', schedErr.message);
        }
      }

      return res.status(200).json({ ok: true, scheduled: created });
    } catch (e) {
      console.error('Save reminders error:', e);
      return res.status(500).json({ error: 'Server error' });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
};
