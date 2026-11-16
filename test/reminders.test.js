'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { cronForSchedule, eligibleOccurrence } = require('../lib/reminder-schedule.js');
const { scheduleIdFor, validateReminders } = require('../api/reminders.js');
const { validCallbackReminder } = require('../api/send-one.js');

const timeZone = 'Europe/London';
const clientPayload = [
  { id: 'aws-study', label: 'AWS study', emoji: '📘', message: 'Study.', enabled: true, schedule: { type: 'weekly', days: [1, 4, 5], time: '14:00' }, startDate: '2026-11-16', endDate: '2026-12-31' },
  { id: 'skincare-am', label: 'Morning skincare', emoji: '☀️', message: 'Morning skincare.', enabled: true, schedule: { type: 'daily', time: '07:00' } },
  { id: 'skincare-pm', label: 'Evening skincare', emoji: '🌙', message: 'Evening skincare.', enabled: true, schedule: { type: 'daily', time: '22:00' } },
  { id: 'monthly-reset', label: 'Monthly Reset', emoji: '🌿', message: 'Reset.', enabled: true, schedule: { type: 'monthly-last-weekday', weekday: 0, time: '11:00' } }
];

test('accepts the v75 client reminder payload and rejects the old contract', function () {
  const clean = validateReminders(clientPayload, timeZone);
  assert.equal(clean.length, 4);
  assert.deepEqual(clean[0].schedule, { type: 'weekly', days: [1, 4, 5], time: '14:00' });
  assert.equal(clean[0].timeZone, timeZone);
  assert.equal(validateReminders([{ id: 'old', label: 'Old', message: 'Old', hour: 14, minute: 0 }], timeZone), null);
  assert.equal(validateReminders(clientPayload, 'Not/A_Time_Zone'), null);
  clean.forEach(function (reminder) { assert.equal(validCallbackReminder(reminder), true); });
});

test('builds DST-safe local cron schedules for each approved cadence', function () {
  assert.equal(cronForSchedule(clientPayload[0].schedule, timeZone), 'CRON_TZ=Europe/London 0 14 * * 1,4,5');
  assert.equal(cronForSchedule(clientPayload[1].schedule, timeZone), 'CRON_TZ=Europe/London 0 7 * * *');
  assert.equal(cronForSchedule(clientPayload[3].schedule, timeZone), 'CRON_TZ=Europe/London 0 11 * * 0');
});

test('enforces weekly days, last Sunday, and inclusive study boundaries', function () {
  const study = Object.assign({ timeZone: timeZone }, clientPayload[0]);
  assert.equal(eligibleOccurrence(study, new Date('2026-11-16T14:00:00Z')), true);
  assert.equal(eligibleOccurrence(study, new Date('2026-11-17T14:00:00Z')), false);
  assert.equal(eligibleOccurrence(study, new Date('2026-12-31T14:00:00Z')), true);
  assert.equal(eligibleOccurrence(study, new Date('2027-01-01T14:00:00Z')), false);
  assert.equal(eligibleOccurrence(study, new Date('2026-11-12T14:00:00Z')), false);

  const reset = Object.assign({ timeZone: timeZone }, clientPayload[3]);
  assert.equal(eligibleOccurrence(reset, new Date('2026-11-22T11:00:00Z')), false);
  assert.equal(eligibleOccurrence(reset, new Date('2026-11-29T11:00:00Z')), true);
});

test('uses one stable QStash schedule id per user and reminder', function () {
  assert.equal(scheduleIdFor('user-a', 'aws-study'), scheduleIdFor('user-a', 'aws-study'));
  assert.notEqual(scheduleIdFor('user-a', 'aws-study'), scheduleIdFor('user-b', 'aws-study'));
  assert.match(scheduleIdFor('user-a', 'aws-study'), /^lifehub-[a-f0-9]{20}-aws-study$/);
});
