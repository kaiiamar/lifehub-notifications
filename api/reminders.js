const { Redis } = require('@upstash/redis');
const { Client } = require('@upstash/qstash');
const { assertBodySize, enforceRateLimit, handleCors, requireFirebaseUser } = require('../lib/security.js');

function validateReminders(input) {
  if (!Array.isArray(input) || input.length > 20) return null;
  const clean = [];
  for (const item of input) {
    if (!item || typeof item.id !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(item.id)) return null;
    const hour = Number(item.hour);
    const minute = Number(item.minute);
    if (!Number.isInteger(hour) || hour < 0 || hour > 23 ||
        !Number.isInteger(minute) || minute < 0 || minute > 59) return null;
    const label = String(item.label || '').trim();
    const emoji = String(item.emoji || '').trim();
    const message = String(item.message || '').trim();
    if (!label || label.length > 80 || emoji.length > 24 || message.length > 280) return null;
    clean.push({
      id: item.id,
      label: label,
      emoji: emoji,
      message: message,
      hour: hour,
      minute: minute,
      enabled: item.enabled === true,
      condition: String(item.condition || 'none').slice(0, 32)
    });
  }
  return clean;
}

module.exports = async function handler(req, res) {
  if (!handleCors(req, res, ['GET', 'POST', 'OPTIONS'])) return;
  if (req.method !== 'GET' && req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!assertBodySize(req, res, 24 * 1024)) return;
  const user = await requireFirebaseUser(req, res);
  if (!user) return;
  if (!await enforceRateLimit(res, 'reminders', user.uid, 30, 60 * 60)) return;

  const redis = new Redis({ url: process.env.KV_REST_API_URL, token: process.env.KV_REST_API_TOKEN });
  if (req.method === 'GET') {
    try {
      const data = await redis.get('reminders:' + user.uid);
      return res.status(200).json({ reminders: data || null });
    } catch (error) {
      return res.status(500).json({ error: 'Server error' });
    }
  }

  const reminders = validateReminders(req.body && req.body.reminders);
  if (!reminders) return res.status(400).json({ error: 'Invalid reminders' });
  const callbackSecret = process.env.QSTASH_CALLBACK_SECRET;
  const baseUrl = process.env.APP_URL || (process.env.VERCEL_URL ? 'https://' + process.env.VERCEL_URL : '');
  if (!callbackSecret || !process.env.QSTASH_TOKEN || !baseUrl) {
    return res.status(503).json({ error: 'Reminder scheduling is not configured' });
  }

  try {
    const qstash = new Client({ token: process.env.QSTASH_TOKEN });
    const existing = await qstash.schedules.list();
    for (const schedule of existing) {
      if (!schedule.body) continue;
      try {
        const body = JSON.parse(schedule.body);
        if (body.userId === user.uid) await qstash.schedules.delete(schedule.scheduleId);
      } catch (error) { /* Ignore schedules owned by other integrations. */ }
    }

    let created = 0;
    const tzOffset = Number(process.env.TZ_OFFSET || 0);
    for (const reminder of reminders) {
      if (!reminder.enabled) continue;
      let utcHour = reminder.hour - tzOffset;
      if (utcHour < 0) utcHour += 24;
      if (utcHour >= 24) utcHour -= 24;
      await qstash.schedules.create({
        destination: baseUrl.replace(/\/$/, '') + '/api/send-one',
        cron: reminder.minute + ' ' + utcHour + ' * * *',
        body: JSON.stringify({
          userId: user.uid,
          label: reminder.label,
          emoji: reminder.emoji,
          message: reminder.message
        }),
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + callbackSecret
        }
      });
      created++;
    }

    await redis.set('reminders:' + user.uid, JSON.stringify(reminders));
    return res.status(200).json({ ok: true, scheduled: created });
  } catch (error) {
    console.error('Save reminders error:', error.message);
    return res.status(500).json({ error: 'Server error' });
  }
};