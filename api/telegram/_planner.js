// Planner logic for the Life Hub bot.
// ============================================================
// Underscore prefix => this is a SHARED LIBRARY, not a Vercel serverless
// function. It mirrors the web app's client-side planner (js/planner.js) so
// the bot and the app agree on today's/this week's plan and the single
// suggested action.
//
// Exports:
//   getToday(state)        -> { focusTasks[], commitments[], training }   (R11.2, R12.4)
//   getWeek(state)         -> { intention, weeklyTasks[], fixedTasks[] }  (R9.3)
//   pickOneAction(state)   -> { label, callback } | null                  (R6, Property 2)
//   parsePlannerText(raw)  -> { kind:'task'|'commitment'|'intention', ... } | null  (R12.2)
//   currentWeekKey()       -> Sunday-anchored week key (helper)
//
// Design guarantees:
//   * pickOneAction returns ONE item or null — NEVER a list (Property 2).
//   * Week keys are Sunday-anchored, matching js/navigation.js weekKey() so
//     bot and app agree on `weekPriority` values.

const { localDateKey } = require('./_helpers.js');
const { todaysTraining, weekDayKeys } = require('./_digest.js');

// ── Week / date helpers ─────────────────────────────────────────────────
// Sunday-anchored week key for the current local day. weekDayKeys() returns
// the 7 day-keys Sun→Sat for the week containing the reference key, so its
// first element is that week's Sunday — the same value js/navigation.js
// weekKey() produces (both anchor on Sunday, getDay()/getUTCDay() 0=Sunday).
function currentWeekKey() {
  return weekDayKeys(localDateKey())[0];
}

// Today's scheduled commitments, sorted chronologically by start time (R11.2).
// Parity with the frontend getTodayCommitments (js/planner.js): matches exact-
// date commitments AND weekly-recurring ones (recur==='weekly') that fall on
// the same weekday on/after their start date. Returns lightweight view objects
// with a per-occurrence `done` so recurring commitments report the right state
// for the requested day. (Part 5.5)
function todayCommitments(state, dateKey) {
  const key = dateKey || localDateKey();
  const keyDow = new Date(key + 'T12:00:00').getDay();
  const out = [];
  (state && state.commitments || []).forEach(function (c) {
    if (!c) return;
    let matches = false;
    if (c.date === key) matches = true;
    else if (c.recur === 'weekly' && c.date && key >= c.date && new Date(c.date + 'T12:00:00').getDay() === keyDow) matches = true;
    if (!matches) return;
    const done = (c.recur === 'weekly') ? !!(c.doneDates && c.doneDates[key]) : !!c.done;
    out.push({ id: c.id, text: c.text, start: c.start || '', end: c.end || '', recur: c.recur || null, done: done });
  });
  return out.sort(function (a, b) { return String(a.start || '').localeCompare(String(b.start || '')); });
}

function moodLoggedToday(state) {
  const today = localDateKey();
  const m = state && state.mood && state.mood[today];
  return !!(m && m.mood);
}

// ── getToday (R11.2, R12.4) ─────────────────────────────────────────────
// Everything for the single-screen daily view: today's focus tasks, today's
// commitments (chronological), and today's training row.
function getToday(state) {
  const today = localDateKey();
  const focusTasks = (state && state.tasks || []).filter(function (t) {
    return t && t.focusDate === today;
  });
  const commitments = todayCommitments(state, today);
  const training = todaysTraining(state);
  return { focusTasks: focusTasks, commitments: commitments, training: training };
}

// ── getWeek (R9.3) ──────────────────────────────────────────────────────
// The current week's intention, this week's flexible tasks
// (weekPriority === currentWeekKey), and fixed-date tasks kept separate.
function getWeek(state) {
  const wk = currentWeekKey();
  const tasks = (state && state.tasks) || [];

  // Only surface the intention if it belongs to the current week (R9.1).
  const intentionObj = state && state.weeklyIntention;
  const intention = (intentionObj && intentionObj.weekKey === wk) ? intentionObj : null;

  const weeklyTasks = tasks.filter(function (t) { return t && t.weekPriority === wk; });

  // Fixed-date tasks are those with a dueDate that are NOT this week's
  // flexible tasks — shown separately so weekly tasks never look overdue.
  const fixedTasks = tasks
    .filter(function (t) { return t && t.dueDate && t.weekPriority !== wk; })
    .slice()
    .sort(function (a, b) {
      return String(a.dueDate || '9999-12-31').localeCompare(String(b.dueDate || '9999-12-31'));
    });

  return { intention: intention, weeklyTasks: weeklyTasks, fixedTasks: fixedTasks };
}

// ── pickOneAction (R6, Property 2) ──────────────────────────────────────
// Returns the FIRST applicable single action by priority order, or null.
// NEVER returns a list. `callback` is a Telegram callback_data string, or
// null for a text-only suggestion (no button). Callback shapes match the
// rest of the bot: focus:<taskId>, commit:<id>, water:250.
//
// Priority (per design):
//   1. overdue fixed task, reframed as a fresh opportunity (offer to focus)
//   2. today's incomplete focus task
//   3. next incomplete commitment today
//   4. no focus set yet -> suggest picking one
//   5. log mood / water
function pickOneAction(state) {
  if (!state) return null;
  const today = localDateKey();
  const tasks = state.tasks || [];

  // 1) Overdue fixed-date task — reframed, never as a miss (R5.2). Offer to
  //    make it today's focus so the user acts on one concrete thing.
  const overdue = tasks.find(function (t) {
    return t && !t.done && t.dueDate && t.dueDate < today;
  });
  if (overdue) {
    return { label: 'Pick this back up: ' + overdue.text, callback: 'focus:' + overdue.id };
  }

  // 2) Today's incomplete focus task (completing happens in the app/tasks,
  //    so this is a text-only reminder — tapping focus: would un-focus it).
  const focus = tasks.find(function (t) { return t && t.focusDate === today && !t.done; });
  if (focus) {
    return { label: 'Focus: ' + focus.text, callback: null };
  }

  // 3) Next incomplete commitment today (earliest by start).
  const commitments = todayCommitments(state, today).filter(function (c) { return !c.done; });
  if (commitments.length) {
    const c = commitments[0];
    const when = c.start ? (' at ' + c.start) : '';
    return { label: 'Next up: ' + c.text + when, callback: 'commit:' + c.id };
  }

  // 4) No focus set for today at all — suggest picking one (R10.4).
  const anyFocusToday = tasks.some(function (t) { return t && t.focusDate === today; });
  if (!anyFocusToday) {
    return { label: 'Pick one focus task for today', callback: null };
  }

  // 5) Fall back to a tiny log action: mood, then water.
  if (!moodLoggedToday(state)) {
    return { label: 'Log how today is going', callback: null };
  }
  const settings = state.waterSettings || {};
  const target = Number(settings.target || 8);
  const currentGlasses = Number((state.water || {})[today] || 0);
  if (currentGlasses < target) {
    return { label: 'Add a glass of water', callback: 'water:250' };
  }

  return null;
}

// ── parsePlannerText (R12.2) ────────────────────────────────────────────
// Parse free text into structured planner data. Returns one of:
//   { kind:'intention', text }
//   { kind:'commitment', text, date, start, end }   (start present; end may be '')
//   { kind:'task', text, dueDate }                  (dueDate may be null)
// or null when the input is unparseable (empty / no meaningful words).
//
// Examples:
//   "maths course tuesday 2-4pm" -> commitment {date:<next Tue>, start:'14:00', end:'16:00'}
//   "intention: ship the project" -> intention
//   "call the dentist" -> task
//   "!!!"                         -> null

const _WEEKDAYS = {
  sunday: 0, sun: 0,
  monday: 1, mon: 1,
  tuesday: 2, tue: 2, tues: 2,
  wednesday: 3, wed: 3,
  thursday: 4, thu: 4, thur: 4, thurs: 4,
  friday: 5, fri: 5,
  saturday: 6, sat: 6
};

function pad2(n) { return (n < 10 ? '0' : '') + n; }

function keyPlusDays(key, n) {
  const d = new Date(key + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function dowOfKey(key) {
  return new Date(key + 'T12:00:00Z').getUTCDay();
}

// Next date (as key) whose weekday matches `targetDow`, counting today as 0.
function nextWeekdayKey(targetDow) {
  const today = localDateKey();
  const delta = (targetDow - dowOfKey(today) + 7) % 7;
  return keyPlusDays(today, delta);
}

// Convert an (hour, minute, am/pm) triple to a 24h "HH:MM" string.
function to24h(hour, minute, ampm) {
  let h = parseInt(hour, 10);
  const m = minute != null && minute !== '' ? parseInt(minute, 10) : 0;
  const ap = ampm ? String(ampm).toLowerCase() : '';
  if (ap === 'pm' && h < 12) h += 12;
  if (ap === 'am' && h === 12) h = 0;
  if (h > 23) h = 23;
  if (m > 59) return pad2(h) + ':00';
  return pad2(h) + ':' + pad2(m);
}

function parsePlannerText(raw) {
  if (raw == null) return null;
  const text = String(raw).trim();
  if (!text) return null;
  // Unparseable if there is no alphabetic content at all (pure symbols/digits).
  if (!/[a-z]/i.test(text)) return null;

  // ── Intention: "intention: ..." / "intention - ..." ──
  const intentMatch = text.match(/^intention\b[\s:–-]*(.*)$/i);
  if (intentMatch) {
    const body = intentMatch[1].trim();
    if (!body) return null;
    return { kind: 'intention', text: body };
  }

  // Working copy we strip matched tokens from to derive the clean label.
  let rest = text;

  // ── Date detection FIRST: today / tomorrow / weekday / ISO / dd/mm ──
  // Done before time parsing so an ISO date's dashes (e.g. "2026-07-08")
  // are not mistaken for a time range like "2-4pm".
  let date = null;

  if (/\btoday\b/i.test(rest)) {
    date = localDateKey();
    rest = rest.replace(/\btoday\b/i, ' ');
  } else if (/\btomorrow\b/i.test(rest)) {
    date = keyPlusDays(localDateKey(), 1);
    rest = rest.replace(/\btomorrow\b/i, ' ');
  } else {
    const isoMatch = rest.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
    const wdMatch = rest.match(/\b(sunday|saturday|thursday|thurs|wednesday|tuesday|tues|monday|friday|sun|mon|tue|wed|thu|thur|fri|sat)\b/i);
    const dmMatch = rest.match(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/);
    if (isoMatch) {
      date = isoMatch[0];
      rest = rest.replace(isoMatch[0], ' ');
    } else if (wdMatch) {
      date = nextWeekdayKey(_WEEKDAYS[wdMatch[1].toLowerCase()]);
      rest = rest.replace(wdMatch[0], ' ');
    } else if (dmMatch) {
      let yy = dmMatch[3] ? parseInt(dmMatch[3], 10) : new Date(localDateKey() + 'T12:00:00Z').getUTCFullYear();
      if (yy < 100) yy += 2000;
      date = yy + '-' + pad2(parseInt(dmMatch[2], 10)) + '-' + pad2(parseInt(dmMatch[1], 10));
      rest = rest.replace(dmMatch[0], ' ');
    }
  }

  // ── Time range: "2-4pm", "2pm-4pm", "14:00-16:00", "2:30 to 4pm" ──
  let start = null, end = '';
  const rangeRe = /\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*(?:-|–|—|to)\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/i;
  const rangeMatch = rest.match(rangeRe);
  if (rangeMatch) {
    let startAp = rangeMatch[3];
    const endAp = rangeMatch[6];
    // "2-4pm" => start inherits the end's am/pm marker.
    if (!startAp && endAp) startAp = endAp;
    start = to24h(rangeMatch[1], rangeMatch[2], startAp);
    end = to24h(rangeMatch[4], rangeMatch[5], endAp || startAp);
    rest = rest.replace(rangeMatch[0], ' ');
  } else {
    // ── Single time: "at 2pm", "7am", "14:00" ──
    const singleRe = /\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b|\b(\d{1,2}):(\d{2})\b/i;
    const singleMatch = rest.match(singleRe);
    if (singleMatch) {
      if (singleMatch[3] || singleMatch[2] != null || /am|pm/i.test(singleMatch[0])) {
        start = to24h(singleMatch[1], singleMatch[2], singleMatch[3]);
      } else {
        start = to24h(singleMatch[4], singleMatch[5], '');
      }
      rest = rest.replace(singleMatch[0], ' ');
    }
  }

  // Clean the label: drop leftover prepositions and stray separators.
  let label = rest
    .replace(/\b(from|at|on|by|starting)\b/gi, ' ')
    .replace(/[-–—]/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
  if (!label) label = text; // never end up with an empty label

  // A start time means it's a time-blocked commitment (R11.1). Default the
  // date to today when a time is given without an explicit day.
  if (start) {
    return {
      kind: 'commitment',
      text: label,
      date: date || localDateKey(),
      start: start,
      end: end || ''
    };
  }

  // Otherwise it's a task; a bare date becomes its due date.
  return { kind: 'task', text: label, dueDate: date };
}

module.exports = {
  getToday,
  getWeek,
  pickOneAction,
  parsePlannerText,
  currentWeekKey
};
