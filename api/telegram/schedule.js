// Register all the Telegram bot prompt schedules with QStash.
// ============================================================
// Call with POST and Authorization: Bearer <TELEGRAM_SETUP_SECRET>.
// Wipes any previously registered Life Hub Telegram schedules and creates fresh ones.
//
// All times below are LOCAL — converted to UTC via TZ_OFFSET env var.
const { Client } = require('@upstash/qstash');
const { requireServiceBearer } = require('../../lib/security.js');

const SCHEDULES = [
  // 8:00 — consolidated morning check-in (mood + training + morning habits +
  // daily focus-task picker, folded in from the old 8:05 plan-day ping)
  { type: 'morning', hour: 8, minute: 0, days: '*' },
  // 12:30 — midday check-in
  { type: 'midday', hour: 12, minute: 30, days: '*' },
  // 22:00 — evening / bedtime check-in
  { type: 'evening', hour: 22, minute: 0, days: '*' },
  // 15:00 — water reminder (skips when on pace / recently logged)
  { type: 'water', hour: 15, minute: 0, days: '*' },
  // Daily 17:00 — rut detector (only fires a message if 2+ quiet days)
  { type: 'rut-check', hour: 17, minute: 0, days: '*' },
  // Sunday 09:00 — single weekly review: close last week + open this week
  // (merges the old Sunday 18:00 digest and Sunday 09:00 planning prompts).
  { type: 'weekly-review', hour: 9, minute: 0, days: '0' }
  // Note: the daily 8:05 "plan-day" ping is now folded into the 8:00 morning
  // message (focus-task picker), so it no longer has its own schedule entry.
];

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!requireServiceBearer(req, res, 'TELEGRAM_SETUP_SECRET')) return;
  const callbackSecret = process.env.QSTASH_CALLBACK_SECRET;
  if (!callbackSecret || !process.env.QSTASH_TOKEN) {
    return res.status(503).json({ error: 'QStash security is not configured' });
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
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + callbackSecret
        }
      });
      created.push({ type: s.type, cron, scheduleId: result.scheduleId });
    } catch (e) {
      console.error('Schedule create error for ' + s.type + ':', e.message);
      created.push({ type: s.type, error: e.message });
    }
  }

  return res.status(200).json({ ok: true, deleted, created });
};
