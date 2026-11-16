'use strict';

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;
const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

function validTimeZone(value) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 80) return false;
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: value }).format(new Date());
    return true;
  } catch (error) {
    return false;
  }
}

function validDateKey(value) {
  const match = typeof value === 'string' && value.match(DATE_PATTERN);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function normalizeSchedule(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const timeMatch = typeof input.time === 'string' && input.time.match(TIME_PATTERN);
  if (!timeMatch) return null;
  if (input.type === 'daily') return { type: 'daily', time: input.time };
  if (input.type === 'weekly') {
    if (!Array.isArray(input.days) || !input.days.length) return null;
    const days = Array.from(new Set(input.days));
    if (days.some(function (day) { return !Number.isInteger(day) || day < 0 || day > 6; })) return null;
    days.sort(function (left, right) { return left - right; });
    return { type: 'weekly', days: days, time: input.time };
  }
  if (input.type === 'monthly-last-weekday') {
    if (!Number.isInteger(input.weekday) || input.weekday < 0 || input.weekday > 6) return null;
    return { type: 'monthly-last-weekday', weekday: input.weekday, time: input.time };
  }
  return null;
}

function cronForSchedule(schedule, timeZone) {
  const time = schedule.time.split(':').map(Number);
  let dayOfWeek = '*';
  if (schedule.type === 'weekly') dayOfWeek = schedule.days.join(',');
  if (schedule.type === 'monthly-last-weekday') dayOfWeek = String(schedule.weekday);
  return 'CRON_TZ=' + timeZone + ' ' + time[1] + ' ' + time[0] + ' * * ' + dayOfWeek;
}

function localParts(value, timeZone) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'short',
    hourCycle: 'h23',
    hour: '2-digit',
    minute: '2-digit'
  }).formatToParts(value || new Date());
  const result = {};
  parts.forEach(function (part) { if (part.type !== 'literal') result[part.type] = part.value; });
  return {
    year: Number(result.year),
    month: Number(result.month),
    day: Number(result.day),
    weekday: WEEKDAYS.indexOf(result.weekday),
    hour: Number(result.hour),
    minute: Number(result.minute),
    dateKey: result.year + '-' + result.month + '-' + result.day
  };
}

function eligibleOccurrence(reminder, value) {
  if (!reminder || !validTimeZone(reminder.timeZone)) return false;
  const schedule = normalizeSchedule(reminder.schedule);
  if (!schedule) return false;
  const parts = localParts(value || new Date(), reminder.timeZone);
  if (reminder.startDate && (!validDateKey(reminder.startDate) || parts.dateKey < reminder.startDate)) return false;
  if (reminder.endDate && (!validDateKey(reminder.endDate) || parts.dateKey > reminder.endDate)) return false;
  if (schedule.type === 'daily') return true;
  if (schedule.type === 'weekly') return schedule.days.indexOf(parts.weekday) !== -1;
  if (parts.weekday !== schedule.weekday) return false;
  const followingWeek = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + 7));
  return followingWeek.getUTCMonth() !== parts.month - 1;
}

module.exports = {
  cronForSchedule,
  eligibleOccurrence,
  localParts,
  normalizeSchedule,
  validDateKey,
  validTimeZone
};
