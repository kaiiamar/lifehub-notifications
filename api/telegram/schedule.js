// Register all the Telegram bot prompt schedules with QStash.
// ============================================================
// Call: POST /api/telegram/schedule?secret=<TELEGRAM_SETUP_SECRET>
// Wipes any previously-registered telegram schedules and creates fresh ones.
//
// All times below are LOCAL — converted to UTC via TZ_OFFSET env var.
const { Client } = require('@upstash/qstash');

const SCHEDULES = [
  // 8:00 — consolidated morning check-in (mood + training + morning habits)
  { type: 'morning', hour: 8, minute: 0, days: '*' },
  // 12:30 — midday check-in
  { type: 'midday', hour: 12, minute: 30, days: '*' },
  // 22:00 — evening / bedtime check-in
  { type: 'evening', hour: 22, minute: 0, days: '*' },
  // 15:00 — water reminder
  { type: 'water', hour: 15, minute: 0, days: '*' },
  // Sunday 18:00 — AI weekly digest (Claude Sonnet reflection)
  { type: 'weekly-digest', hour: 18, minute: 0, days: '0' },
  // Daily 17:00 — rut detector (only fires a message if 2+ quiet days)
  { type: 'rut-check', hour: 17, minute: 0, days: '*' },
  // Sunday 09:00 — weekly planning prompt (set weekly intention + tasks)
  { type: 'plan-week', hour: 9, minute: 0, days: '0' },
  // 8:05 — daily planning prompt (pick 1–3 daily focus tasks)
  { type: 'plan-day', hour: 8, minute: 5, days: '*' }
];

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  const secret = req.query.secret || (req.body && req.body.secret);
  if (process.env.TELEGRAM_SETUP_SECRET && secret !== process.env.TELEGRAM_SETUP_SECRET) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  const baseUrl = process.env.APP_URL || (process.env.VERCEL_URL ? 'https://' + process.env.VERCEL_URL : '');
  if (!baseUrl) return res.status(500).json({ error: 'APP_URL not set' });
  const tzOffset = Number(process.env.TZ_OFFSET || 0);

  const qstash = new Client({ token: process.env.QSTASH_TOKEN });

  // Delete any existing telegram schedules
  let deleted = 0;
  try {
    const existing = await qstash.schedules.list();
    for (const sched of existing) {
      if (sched.body) {
        try {
          const body = JSON.parse(sched.body);
          if (body.__telegram) {
            await qstash.schedules.delete(sched.scheduleId);
            deleted++;
          }
        } catch (e) { /* ignore */ }
      }
    }
  } catch (e) {
    console.error('List schedules error:', e.message);
  }

  // Create new schedules
  const created = [];
  for (const s of SCHEDULES) {
    try {
      let utcHour = s.hour - tzOffset;
      if (utcHour < 0) utcHour += 24;
      if (utcHour >= 24) utcHour -= 24;
      const cron = s.minute + ' ' + utcHour + ' * * ' + s.days;
      const result = await qstash.schedules.create({
        destination: baseUrl.replace(/\/$/, '') + '/api/telegram/prompt',
        cron: cron,
        body: JSON.stringify({ type: s.type, __telegram: true }),
        headers: { 'Content-Type': 'application/json' }
      });
      created.push({ type: s.type, cron, scheduleId: result.scheduleId });
    } catch (e) {
      console.error('Schedule create error for ' + s.type + ':', e.message);
      created.push({ type: s.type, error: e.message });
    }
  }

  return res.status(200).json({ ok: true, deleted, created });
};
