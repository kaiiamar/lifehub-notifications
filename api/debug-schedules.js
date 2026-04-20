const { Client } = require('@upstash/qstash');

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  try {
    const qstash = new Client({ token: process.env.QSTASH_TOKEN });
    const schedules = await qstash.schedules.list();
    const baseUrl = process.env.APP_URL || process.env.VERCEL_URL || 'not set';
    res.status(200).json({
      appUrl: baseUrl,
      tzOffset: process.env.TZ_OFFSET || 'not set',
      totalSchedules: schedules.length,
      schedules: schedules.map(function(s) {
        return {
          id: s.scheduleId,
          cron: s.cron,
          destination: s.destination,
          body: s.body ? s.body.substring(0, 200) : null
        };
      })
    });
  } catch (e) {
    res.status(200).json({ error: e.message });
  }
};
