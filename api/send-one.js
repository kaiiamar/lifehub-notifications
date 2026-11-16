'use strict';

const { Redis } = require('@upstash/redis');
const webpush = require('web-push');
const { assertBodySize, requireServiceBearer } = require('../lib/security.js');
const { eligibleOccurrence, localParts, normalizeSchedule, validDateKey, validTimeZone } = require('../lib/reminder-schedule.js');

function validCallbackReminder(body) {
  if (!body || typeof body.id !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(body.id)) return false;
  if (!normalizeSchedule(body.schedule) || !validTimeZone(body.timeZone)) return false;
  if (body.startDate && !validDateKey(body.startDate)) return false;
  if (body.endDate && !validDateKey(body.endDate)) return false;
  if (body.startDate && body.endDate && body.startDate > body.endDate) return false;
  return true;
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!requireServiceBearer(req, res, 'QSTASH_CALLBACK_SECRET')) return;
  if (!assertBodySize(req, res, 4096)) return;

  const { userId, id, label, emoji, message, schedule, startDate, endDate, timeZone } = req.body || {};
  const expectedUid = process.env.LIFEHUB_FIREBASE_UID;
  if (!expectedUid) return res.status(503).json({ error: 'LIFEHUB_FIREBASE_UID is not configured' });
  if (userId !== expectedUid) return res.status(403).json({ error: 'Forbidden' });
  if (!validCallbackReminder({ id, schedule, startDate, endDate, timeZone })) {
    return res.status(400).json({ error: 'Invalid reminder schedule' });
  }
  if (String(label || '').length > 80 || String(emoji || '').length > 24 || String(message || '').length > 280) {
    return res.status(400).json({ error: 'Reminder content is too long' });
  }
  if (!eligibleOccurrence({ schedule, startDate, endDate, timeZone }, new Date())) {
    return res.status(200).json({ ok: true, skipped: true });
  }
  if (!process.env.VAPID_PUBLIC_KEY || !process.env.VAPID_PRIVATE_KEY || !process.env.VAPID_EMAIL) {
    return res.status(503).json({ error: 'Push notifications are not configured' });
  }

  const redis = new Redis({ url: process.env.KV_REST_API_URL, token: process.env.KV_REST_API_TOKEN });
  const occurrence = localParts(new Date(), timeZone).dateKey;
  const dedupeKey = 'reminder-fired:' + userId + ':' + id + ':' + occurrence;
  let claimed = false;
  try {
    const result = await redis.set(dedupeKey, '1', { nx: true, ex: 35 * 24 * 60 * 60 });
    if (result === null) return res.status(200).json({ ok: true, deduplicated: true });
    claimed = true;
    const subRaw = await redis.get('sub:' + userId);
    if (!subRaw) {
      await redis.del(dedupeKey);
      return res.status(404).json({ error: 'No subscription found' });
    }
    const subscription = typeof subRaw === 'string' ? JSON.parse(subRaw) : subRaw;
    webpush.setVapidDetails(process.env.VAPID_EMAIL, process.env.VAPID_PUBLIC_KEY, process.env.VAPID_PRIVATE_KEY);
    await webpush.sendNotification(subscription, JSON.stringify({
      title: (emoji || '') + ' ' + (label || 'Reminder'),
      body: message || 'Time to check in!',
      icon: '/Life-Hub/icon-192.jpg',
      tag: id + ':' + occurrence
    }));
    return res.status(200).json({ ok: true });
  } catch (error) {
    if (claimed) {
      try { await redis.del(dedupeKey); } catch (cleanupError) { console.error('Reminder dedupe cleanup failed:', cleanupError.message); }
    }
    console.error('Send-one error:', error.statusCode || error.message);
    if (error.statusCode === 410 || error.statusCode === 404) await redis.del('sub:' + userId);
    return res.status(500).json({ error: 'Push failed' });
  }
};

module.exports.validCallbackReminder = validCallbackReminder;
