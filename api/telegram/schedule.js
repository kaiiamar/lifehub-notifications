// Register all the Telegram bot prompt schedules with QStash.
// ============================================================
// Call: POST /api/telegram/schedule?secret=<TELEGRAM_SETUP_SECRET>
// Wipes any previously-registered telegram schedules and creates fresh ones.
//
// All times below are LOCAL — converted to UTC via TZ_OFFSET env var.
const { Client } = require('@upstash/qstash');

const SCHEDULES = [
  // 7am — morning mood + sleep check-in
  { type: 'morning', hour: 7, minute: 0, days: '*' },
  // Anchor habit prompts during the day
  { type: 'anchor-morning', hour: 9, minute: 0, days: '*' },
  { type: 'anchor-midday', hour: 13, minute: 0, days: '*' },
  { type: 'anchor-evening', hour: 19, minute: 0, days: '*' },
  // Water (2 reminders per day — trimmed from 4 to free QStash slots)
  { type: 'water', hour: 12, minute: 0, days: '*' },
  { type: 'water', hour: 17, minute: 0, days: '*' },
  // 9pm — bedtime catch-up + gratitude
  { type: 'bedtime', hour: 21, minute: 0, days: '*' },
  // Saturday 2pm — weekly habit check-in (cron uses 6 = Saturday)
  { type: 'weekly', hour: 14, minute: 0, days: '6' },
  // Sunday 6pm — AI weekly digest (Claude Sonnet reflection)
  { type: 'weekly-digest', hour: 18, minute: 0, days: '0' },
  // Daily 4pm — rut detector (only fires a message if 2+ quiet days)
  { type: 'rut-check', hour: 16, minute: 0, days: '*' }
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
