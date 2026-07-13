// Weekly digest + rut detection helpers for the Life Hub bot.
// ============================================================
// Pure-ish functions that read a STATE object and return compact summaries.
// No network calls here — the caller (prompt.js) feeds the summary to Claude
// and sends the result via Telegram.

const { localDateKey, habitDayStatus } = require('./_helpers.js');

// YYYY-MM-DD for N days before today (local).
function daysAgoKey(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return localDateKey(d);
}

// All 7 day-keys (Sun→Sat) for the week containing refKey.
function weekDayKeys(refKey) {
  const d = new Date(refKey + 'T12:00:00Z');
  const dow = d.getUTCDay(); // 0 = Sunday
  const sunday = new Date(d);
  sunday.setUTCDate(d.getUTCDate() - dow);
  const out = [];
  for (let i = 0; i < 7; i++) {
    const x = new Date(sunday);
    x.setUTCDate(sunday.getUTCDate() + i);
    out.push(x.toISOString().slice(0, 10));
  }
  return out;
}

function round1(n) { return Math.round(n * 10) / 10; }

// Habit completion % over a set of day-keys (only days the habit was "due").
function habitPctOver(state, days, todayKey) {
  let total = 0, done = 0;
  (state.habits || []).forEach(function (h) {
    const startKey = h.startDate || '';
    days.forEach(function (d) {
      if (d > todayKey) return;
      if (startKey && d < startKey) return;
      const st = habitDayStatus(h, d);
      if (st === 'done' || st === 'todo') {
        total++;
        if (h.logs && h.logs[d]) done++;
      }
    });
  });
  return total > 0 ? { pct: Math.round(done / total * 100), total: total } : { pct: null, total: 0 };
}

function avgOver(state, days, todayKey, field) {
  const vals = days
    .filter(function (d) { return d <= todayKey && (state.mood || {})[d] && (state.mood || {})[d][field]; })
    .map(function (d) { return Number(state.mood[d][field]); });
  return vals.length ? round1(vals.reduce(function (s, v) { return s + v; }, 0) / vals.length) : null;
}

function sessionsOver(state, days) {
  const gym = (state.workouts || []).filter(function (w) {
    return days.indexOf(w.date) !== -1 && (w.type || '').toLowerCase() !== 'rest';
  }).length;
  const runs = (((state.metrics || {}).run) || []).filter(function (r) {
    return days.indexOf(r.date) !== -1;
  }).length;
  return gym + runs;
}

// Build a compact, factual summary of the week just gone (and last week for
// comparison). Returns an object of primitives — easy to turn into a prompt.
function buildWeekSummary(state) {
  const todayKey = localDateKey();
  const thisWk = weekDayKeys(todayKey);
  const lastWkRef = daysAgoKey(7);
  const lastWk = weekDayKeys(lastWkRef);

  const habitThis = habitPctOver(state, thisWk, todayKey);
  const habitLast = habitPctOver(state, lastWk, todayKey);

  // Best / worst habit this week
  const habitScores = (state.habits || []).map(function (h) {
    let total = 0, done = 0;
    thisWk.forEach(function (d) {
      if (d > todayKey) return;
      if (h.startDate && d < h.startDate) return;
      const st = habitDayStatus(h, d);
      if (st === 'done' || st === 'todo') { total++; if (h.logs && h.logs[d]) done++; }
    });
    return { name: h.name, pct: total > 0 ? Math.round(done / total * 100) : null };
  }).filter(function (x) { return x.pct != null; });
  habitScores.sort(function (a, b) { return b.pct - a.pct; });

  const tasksDone = (state.tasks || []).filter(function (t) {
    return t.done && t.doneAt && thisWk.indexOf(t.doneAt) !== -1;
  }).length;

  const grats = (state.gratitude || []).filter(function (g) {
    return g.date && thisWk.indexOf(g.date) !== -1;
  });
  const gratSnips = grats.slice(0, 5).map(function (g) { return g.gratitude || g.wins; })
    .filter(Boolean).join('; ').slice(0, 220);

  // Nearest upcoming goal deadline
  let upcoming = null;
  const soon = (state.goals || []).filter(function (g) {
    return !g.done && g.deadline && g.deadline >= todayKey;
  }).sort(function (a, b) { return a.deadline.localeCompare(b.deadline); })[0];
  if (soon) {
    const dl = Math.ceil((new Date(soon.deadline) - new Date()) / 86400000);
    if (dl <= 45) upcoming = soon.name + ' in ' + dl + ' days';
  }

  return {
    habitsThisWeek: habitThis.pct,
    habitsLastWeek: habitLast.pct,
    sessionsThisWeek: sessionsOver(state, thisWk),
    sessionsLastWeek: sessionsOver(state, lastWk),
    avgMoodThisWeek: avgOver(state, thisWk, todayKey, 'mood'),
    avgMoodLastWeek: avgOver(state, lastWk, todayKey, 'mood'),
    avgSleepThisWeek: avgOver(state, thisWk, todayKey, 'sleep'),
    avgSleepLastWeek: avgOver(state, lastWk, todayKey, 'sleep'),
    tasksDone: tasksDone,
    strongestHabit: habitScores[0] ? habitScores[0].name + ' (' + habitScores[0].pct + '%)' : null,
    weakestHabit: habitScores.length > 1 ? habitScores[habitScores.length - 1].name + ' (' + habitScores[habitScores.length - 1].pct + '%)' : null,
    gratitudeSnippets: gratSnips,
    upcomingEvent: upcoming
  };
}

// Turn the summary into prompt lines for Claude.
function summaryToLines(s) {
  const lines = [];
  if (s.habitsThisWeek != null) lines.push('Habits this week: ' + s.habitsThisWeek + '% (last week ' + (s.habitsLastWeek != null ? s.habitsLastWeek + '%' : 'n/a') + ')');
  if (s.sessionsThisWeek != null) lines.push('Workouts this week: ' + s.sessionsThisWeek + ' (last week ' + s.sessionsLastWeek + ')');
  if (s.avgMoodThisWeek != null) lines.push('Average mood: ' + s.avgMoodThisWeek + '/5 (last week ' + (s.avgMoodLastWeek != null ? s.avgMoodLastWeek + '/5' : 'n/a') + ')');
  if (s.avgSleepThisWeek != null) lines.push('Average sleep: ' + s.avgSleepThisWeek + 'h (last week ' + (s.avgSleepLastWeek != null ? s.avgSleepLastWeek + 'h' : 'n/a') + ')');
  if (s.tasksDone != null) lines.push('Tasks completed: ' + s.tasksDone);
  if (s.strongestHabit) lines.push('Strongest habit: ' + s.strongestHabit);
  if (s.weakestHabit) lines.push('Weakest habit: ' + s.weakestHabit);
  if (s.gratitudeSnippets) lines.push('Grateful for: ' + s.gratitudeSnippets);
  if (s.upcomingEvent) lines.push('Coming up: ' + s.upcomingEvent);
  return lines;
}

// ── RUT DETECTION ──
// Looks at the last few days for a drop-off in engagement. Returns
// { inRut:boolean, daysQuiet:number, lastActiveKey, signals:[...] }.
// "Active" = ticked a habit, logged mood, completed a task, logged water,
// or logged a workout on that day.
function dayHadActivity(state, dayKey) {
  const habitHit = (state.habits || []).some(function (h) { return h.logs && h.logs[dayKey]; });
  if (habitHit) return true;
  if ((state.mood || {})[dayKey] && (state.mood || {})[dayKey].mood) return true;
  if (Number((state.water || {})[dayKey] || 0) > 0) return true;
  const taskDone = (state.tasks || []).some(function (t) { return t.done && t.doneAt === dayKey; });
  if (taskDone) return true;
  const worked = (state.workouts || []).some(function (w) { return w.date === dayKey && (w.type || '').toLowerCase() !== 'rest'; });
  if (worked) return true;
  const ran = (((state.metrics || {}).run) || []).some(function (r) { return r.date === dayKey; });
  if (ran) return true;
  return false;
}

function detectRut(state) {
  const todayKey = localDateKey();
  // Count consecutive quiet days ending yesterday (don't penalise an
  // in-progress today). Look back up to 7 days.
  let daysQuiet = 0;
  let lastActiveKey = null;
  for (let i = 1; i <= 7; i++) {
    const k = daysAgoKey(i);
    if (dayHadActivity(state, k)) { lastActiveKey = k; break; }
    daysQuiet++;
  }
  // In a rut if 2+ consecutive quiet days (and the user has habits to do).
  const hasHabits = (state.habits || []).length > 0;
  const inRut = hasHabits && daysQuiet >= 2;
  return { inRut: inRut, daysQuiet: daysQuiet, lastActiveKey: lastActiveKey, todayKey: todayKey };
}

// Pick one easy, concrete restart action from the user's own setup.
function pickRestartAction(state) {
  // Prefer a daily habit they usually hit (so it feels achievable).
  const daily = (state.habits || []).filter(function (h) { return (h.freq || 'daily').toLowerCase() === 'daily'; });
  if (daily.length) {
    return { kind: 'habit', habit: daily[0], label: (daily[0].icon ? daily[0].icon + ' ' : '') + daily[0].name };
  }
  return { kind: 'water', label: 'log a glass of water' };
}

// ── TODAY'S TRAINING ──
// Reads the user's training plan template (Mon→Sun) and returns today's row,
// e.g. { day, session, label, sub }. Mirrors the web app's todaysTrainingSession.
const STRENGTH_LIBRARY = {
  'strength-a': { title: 'Strength A — Lower Body', exercises: 7 },
  'strength-b': { title: 'Strength B — Upper Body', exercises: 8 }
};

// Resolve which race-block week `key` falls in (block start … race day). Mirror
// of the web app's resolveHmWeek (js/workouts.js). Returns {week,n,total,
// daysToRace} or null when outside the block.
function _resolveHmWeek(block, key) {
  if (!block || !Array.isArray(block.weeks) || !block.weeks.length) return null;
  if (key < block.weeks[0].start || key > block.race.date) return null;
  let wk = null;
  for (let i = 0; i < block.weeks.length; i++) { if (block.weeks[i].start <= key) wk = block.weeks[i]; else break; }
  if (!wk) return null;
  function daysBetween(a, b) { return Math.round((new Date(b + 'T12:00:00Z') - new Date(a + 'T12:00:00Z')) / 86400000); }
  return { week: wk, n: wk.n, total: block.weeks.length, daysToRace: Math.max(0, daysBetween(key, block.race.date)) };
}

// Mirror of the web app's todaysTrainingSession (js/workouts.js): overlays the
// dated HM race block onto the weekly template when in-block, else returns the
// plain template row. Any change here MUST stay in sync with the frontend.
function todaysTraining(state) {
  const plan = state && state.trainingPlan;
  if (!plan || !Array.isArray(plan.template) || !plan.template.length) return null;
  const todayKey = localDateKey();
  const d = new Date(todayKey + 'T12:00:00Z');
  const dow = d.getUTCDay();            // 0 Sun..6 Sat
  const idx = (dow + 6) % 7;            // Mon=0..Sun=6
  const base = plan.template[idx];
  if (!base) return null;
  const block = plan.raceBlock;
  const ctx = block ? _resolveHmWeek(block, todayKey) : null;
  if (!ctx) return { row: base, def: STRENGTH_LIBRARY[base.session] || null };
  const rd = block.runDays || { easy: 2, quality: 4, long: 0 };
  const wk = ctx.week;
  const fuelText = wk.fuel ? 'practise fuelling: gel/sweets ~every 40min' : '';
  let runType = null;
  if (dow === rd.long) runType = 'long'; else if (dow === rd.quality) runType = 'quality'; else if (dow === rd.easy) runType = 'easy';
  const row = { day: base.day, session: base.session, label: base.label, sub: base.sub, run: base.run, desc: '', detail: '', fuelText: '', blockN: ctx.n, blockTotal: ctx.total, daysToRace: ctx.daysToRace, phase: wk.phase };
  if (todayKey === block.race.date) { row.session = 'run'; row.label = 'RACE DAY'; row.desc = wk.long; row.detail = block.paces.race; row.isRace = true; return { row: row, def: null }; }
  if (base.session === 'strength-a' || base.session === 'strength-b') {
    if (runType === 'easy') { row.run = true; row.easyRun = wk.easy; }
    return { row: row, def: STRENGTH_LIBRARY[base.session] || null };
  }
  if (runType === 'long') {
    // Race week: the long-run slot the day before the race is a shakeout (the
    // race itself is handled by the isRace branch above).
    if (wk.phase === 'race week') { row.session = 'run'; row.label = 'Shakeout'; row.desc = '2k easy shakeout or rest — race tomorrow'; row.detail = block.paces.easy; return { row: row, def: null }; }
    row.session = 'run'; row.label = 'Long run'; row.desc = wk.long; row.detail = block.paces.easy; row.fuelText = fuelText; return { row: row, def: null };
  }
  if (runType === 'quality') { row.session = 'run'; row.label = 'Quality session'; row.desc = wk.quality; row.detail = /interval/i.test(wk.quality) ? block.paces.interval : block.paces.tempo; return { row: row, def: null }; }
  if (runType === 'easy') { row.session = 'run'; row.label = 'Easy run'; row.desc = wk.easy; row.detail = block.paces.easy; return { row: row, def: null }; }
  row.session = 'rest'; row.label = 'Rest';
  return { row: row, def: null };
}

// ── "Showed up" streak (#5/#6) ──
function _dayHadActivity(state, dayKey) {
  if ((state.habits || []).some(function (h) { return h.logs && h.logs[dayKey]; })) return true;
  if ((state.mood || {})[dayKey] && ((state.mood || {})[dayKey].mood || (state.mood || {})[dayKey].sleep)) return true;
  if (Number((state.water || {})[dayKey] || 0) > 0) return true;
  if ((state.tasks || []).some(function (t) { return t.done && t.doneAt === dayKey; })) return true;
  if ((state.workouts || []).some(function (w) { return w.date === dayKey && (w.type || '').toLowerCase() !== 'rest'; })) return true;
  if ((((state.metrics || {}).run) || []).some(function (r) { return r.date === dayKey; })) return true;
  if ((state.gratitude || []).some(function (e) { return e.date === dayKey; })) return true;
  return false;
}
function showUpStreak(state) {
  var streak = 0;
  var d = new Date();
  if (!_dayHadActivity(state, localDateKey(d))) d.setDate(d.getDate() - 1);
  for (var i = 0; i < 400; i++) {
    if (_dayHadActivity(state, localDateKey(d))) { streak++; d.setDate(d.getDate() - 1); }
    else break;
  }
  return streak;
}

// ── "On this day" callback (#8) ──
// Finds a gratitude/win entry from ~1y, 6mo, 3mo or 1mo ago (in that order).
function onThisDay(state) {
  var grats = state.gratitude || [];
  if (!grats.length) return null;
  var offsets = [
    { label: 'A year ago today', days: 365 },
    { label: 'Six months ago today', days: 182 },
    { label: 'Three months ago today', days: 91 },
    { label: 'A month ago today', days: 30 }
  ];
  for (var i = 0; i < offsets.length; i++) {
    var d = new Date();
    d.setDate(d.getDate() - offsets[i].days);
    var key = localDateKey(d);
    var hit = grats.find(function (e) { return e.date === key && (e.gratitude || e.wins); });
    if (hit) return { label: offsets[i].label, text: hit.gratitude || hit.wins };
  }
  return null;
}

module.exports = {
  buildWeekSummary,
  summaryToLines,
  detectRut,
  pickRestartAction,
  weekDayKeys,
  daysAgoKey,
  todaysTraining,
  showUpStreak,
  onThisDay
};
