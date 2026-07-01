// Tone-enforced message composition for the Life Hub bot.
// ============================================================
// Underscore prefix => this is a SHARED LIBRARY, not a Vercel serverless
// function. It centralises the tone rules (R4/R5/R6/R8) so no caller can
// accidentally emit guilt language or hype.
//
// Exports:
//   TONE_RULES          — system-prompt string passed to claude()
//   sanitizeGuilt(text) — deterministic denylist scrub (R5 safety net)
//   composeWithFallback(deterministicText, {model}) — rephrase-or-fallback
//
// Design guarantees:
//   * sanitizeGuilt() is the last transform before send (Property 1).
//   * composeWithFallback() NEVER blocks on AI: if claude() returns null
//     (missing key, timeout, error), the deterministic string ships
//     (Property 7).

const { claude } = require('./_ai.js');
const {
  localDateKey,
  nowLocal,
  isHabitDailyDueToday
} = require('./_helpers.js');
const {
  todaysTraining,
  detectRut,
  pickRestartAction,
  buildWeekSummary,
  summaryToLines
} = require('./_digest.js');

// Sonnet model constant — mirrors prompt.js. Used only for the weekly digest
// (reflective, once a week). Everything else defaults to Haiku via _ai.js.
const SONNET_MODEL = process.env.ANTHROPIC_SONNET_MODEL || 'claude-sonnet-4-6';

// ── TONE_RULES ──────────────────────────────────────────────────────────
// Shared system prompt. Given to Claude when we ask it to rephrase a
// deterministic, already-rule-compliant string. Encodes R4.1/R4.2/R4.3,
// R5.1/R5.4, R6.1 and R8.4.
const TONE_RULES = [
  'You are a calm, grounded coach inside a personal wellbeing app for one user who has ADHD.',
  'Rewrite the given message so it reads naturally, WITHOUT changing its facts, numbers, or the single suggested action.',
  'Tone: calm and matter-of-fact, like a steady coach. Never cheerful hype, never exclamation-heavy praise.',
  'State concrete, data-specific facts (e.g. "Steps logged: 8k"). Do NOT invent numbers or add facts that are not already present.',
  'Use at most 2 emoji in the whole message.',
  'Keep routine messages under 50 words. Keep weekly/reflective messages under 80 words.',
  'Suggest at most ONE small action. Never present a to-do pile.',
  'NEVER reference the user\'s misses, gaps, lateness, or incompleteness.',
  'NEVER use phrases like "you missed", "you didn\'t", "you still haven\'t", "you forgot", "you failed", "behind", or "should have".',
  'Phrase everything as what the user CAN do next, not what they have not done.',
  'Return ONLY the rewritten message text — no markdown, no preamble, no sign-off. British English.'
].join(' ');

// ── sanitizeGuilt ───────────────────────────────────────────────────────
// Deterministic safety net. Splits text into sentences and drops any
// sentence containing a denylisted guilt/miss phrase. This guarantees R5
// even if the model drifts. Regex-only — no network, no state.
//
// Denylist (case-insensitive):
//   - you missed / you didn't / you still haven't / you forgot / you failed
//   - behind
//   - should have / should've
//   - haven't / hasn't ... yet (miss framing)
//   - "you're behind", "falling behind", etc. (covered by /behind/)
const GUILT_PATTERNS = [
  /you'?ve? (missed|didn'?t|still haven'?t|haven'?t|forgot|failed)/i,
  /you (missed|didn'?t|did not|still haven'?t|haven'?t|forgot|failed|never)/i,
  /\bbehind\b/i,
  /should('?ve| have)\b/i,
  /\bmissed\b/i,
  /\bfailed\b/i,
  /\bslipped\b/i,
  /fell (short|behind)/i,
  /\boverdue\b/i,
  /didn'?t (get|manage|do|finish)/i
];

// Split into sentences while keeping their trailing punctuation so we can
// rebuild the text cleanly. Handles . ! ? and newlines as separators.
function splitSentences(text) {
  // Match runs of non-terminator chars followed by an optional terminator.
  const matches = text.match(/[^.!?\n]+[.!?]*\n*|\n+/g);
  return matches || [text];
}

function isGuilty(sentence) {
  return GUILT_PATTERNS.some(function (re) { return re.test(sentence); });
}

function sanitizeGuilt(text) {
  if (!text || typeof text !== 'string') return text;
  const sentences = splitSentences(text);
  const kept = sentences.filter(function (s) {
    // Preserve pure-whitespace/newline chunks (structure), drop guilty ones.
    if (!s.trim()) return true;
    return !isGuilty(s);
  });
  // Rejoin and tidy up whitespace left behind by dropped sentences.
  let out = kept.join('')
    .replace(/[ \t]{2,}/g, ' ')      // collapse runs of spaces
    .replace(/\n{3,}/g, '\n\n')       // collapse excess blank lines
    .replace(/[ \t]+\n/g, '\n')       // trailing spaces before newline
    .replace(/\n[ \t]+/g, '\n')       // leading spaces after newline
    .trim();
  return out;
}

// ── composeWithFallback ─────────────────────────────────────────────────
// Given a deterministic, already-rule-compliant string, OPTIONALLY ask
// Claude to rephrase it for a more natural feel, then run sanitizeGuilt on
// whatever we ship. If Claude returns null (no key / timeout / error), or
// if sanitising the rephrase leaves nothing usable, ship the deterministic
// string (also sanitised, as the last transform before send).
//
// opts: { model } — optional model override passed through to claude().
async function composeWithFallback(deterministicText, opts) {
  const safeDeterministic = sanitizeGuilt(deterministicText || '');
  const options = opts || {};

  let rephrased = null;
  try {
    rephrased = await claude({
      model: options.model,        // undefined => _ai.js default (Haiku)
      maxTokens: options.maxTokens || 200,
      temperature: typeof options.temperature === 'number' ? options.temperature : 0.6,
      system: TONE_RULES,
      prompt: 'Rewrite this message, keeping every fact and the single action intact:\n\n' + deterministicText
    });
  } catch (e) {
    // claude() already fails soft, but never let a throw block the send.
    console.error('composeWithFallback rephrase failed:', e.message);
    rephrased = null;
  }

  if (!rephrased) return safeDeterministic;

  const safeRephrased = sanitizeGuilt(rephrased);
  // If sanitising gutted the rephrase (e.g. it was all guilt), fall back.
  if (!safeRephrased || !safeRephrased.trim()) return safeDeterministic;
  return safeRephrased;
}

// ── Message composers (R3, R4, R5, R6, R8, R13) ─────────────────────────
// Each composer pulls concrete values from STATE, builds a short,
// rule-compliant deterministic string, optionally lets Claude rephrase it
// (via composeWithFallback), and returns:
//   * routine composers:  { text, buttons }   — buttons is an inline_keyboard
//                                                 rows array (may be empty)
//   * composeWeeklyDigest: text                — no buttons
//
// The single "small action" (R6) comes from _planner.js's pickOneAction.
// IMPORTANT — dependency handling:
//   _planner.js is built in a LATER task (task 10) and may not exist yet.
//   To avoid a hard `require` crash, resolveAction() tries `_planner.js`
//   lazily inside try/catch and falls back to a small inline selector.
//   Callers (task 11, prompt.js) may ALSO pass a pre-computed action via
//   opts.action (any value, including null, is respected) — this is the
//   preferred path once _planner.js exists, e.g.:
//       composeMorning(state, { action: pickOneAction(state) })
//   A returned action has the shape { label, callback } | null, where
//   `callback` is a Telegram callback_data string (or null for text-only).

// Weekday / month names — manual formatter avoids relying on ICU locale data.
const _DOW = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const _MON = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

function dateLabel() {
  const d = nowLocal();
  return _DOW[d.getUTCDay()] + ' ' + d.getUTCDate() + ' ' + _MON[d.getUTCMonth()];
}

// The five mood-selection buttons, matching prompt.js / webhook `mood:` handler.
function moodButtonRow() {
  return [
    { text: '😞', callback_data: 'mood:1' },
    { text: '😐', callback_data: 'mood:2' },
    { text: '🙂', callback_data: 'mood:3' },
    { text: '😊', callback_data: 'mood:4' },
    { text: '🤩', callback_data: 'mood:5' }
  ];
}

function moodLoggedToday(state) {
  const today = localDateKey();
  const m = state && state.mood && state.mood[today];
  return !!(m && m.mood);
}

// Today's training as a single neutral line (R8.2), or null if none scheduled.
function trainingLine(state) {
  const t = todaysTraining(state);
  if (!t || !t.row) return null;
  const r = t.row;
  if (r.session === 'rest') return 'Training: rest day.';
  if (t.def) return 'Training: ' + r.label + ' (' + t.def.exercises + ' exercises).';
  // No strength def — need at least a label or session to say something useful.
  const name = r.label || r.session;
  if (!name) return null;
  return 'Training: ' + name + (r.sub ? ' — ' + r.sub : '') + '.';
}

// Morning-anchor daily habits still due today → tap-to-tick button rows
// (reuses the existing `habit:<id>` callback handled by webhook.js).
function morningHabitRows(state) {
  const today = localDateKey();
  const due = (state && state.habits || []).filter(function (h) {
    return (h.anchor || 'anytime') === 'morning' && isHabitDailyDueToday(h, today);
  });
  return due.map(function (h) {
    return [{ text: '◯ ' + (h.icon ? h.icon + ' ' : '') + h.name, callback_data: 'habit:' + h.id }];
  });
}

// Inline fallback action selector, used ONLY when _planner.js is absent and
// no action was passed in. Deliberately small: real priority logic lives in
// _planner.js (task 10). Reuses existing callback shapes so buttons work.
function fallbackPickOneAction(state) {
  if (!state) return null;
  const today = localDateKey();
  // 1) Today's incomplete focus task (text-only — completing goes via the app/tasks).
  const focus = (state.tasks || []).find(function (t) { return t.focusDate === today && !t.done; });
  if (focus) return { label: 'Focus: ' + focus.text, callback: null };
  // 2) First daily habit still due today.
  const habit = (state.habits || []).find(function (h) { return isHabitDailyDueToday(h, today); });
  if (habit) return { label: (habit.icon ? habit.icon + ' ' : '') + habit.name, callback: 'habit:' + habit.id };
  // 3) Water below goal.
  const settings = state.waterSettings || {};
  const glassMl = Number(settings.glassMl || 250);
  const target = Number(settings.target || 8);
  const currentMl = Number((state.water || {})[today] || 0) * glassMl;
  if (currentMl < target * glassMl) return { label: 'Add a glass of water', callback: 'water:250' };
  return null;
}

// Resolve the single small action for a nudge (R6). Order of precedence:
//   1. explicit opts.action (any value incl. null is honoured)
//   2. _planner.js pickOneAction() if the module exists (lazy require)
//   3. inline fallback selector
function resolveAction(state, opts) {
  opts = opts || {};
  if (Object.prototype.hasOwnProperty.call(opts, 'action')) return opts.action;
  try {
    // _planner.js is added in task 10; require lazily so this module never
    // crashes if it isn't there yet.
    const planner = require('./_planner.js');
    if (planner && typeof planner.pickOneAction === 'function') {
      return planner.pickOneAction(state);
    }
  } catch (e) {
    // _planner.js not present yet — fall through to the inline selector.
  }
  return fallbackPickOneAction(state);
}

// Turn an action into a single button row, unless it has no callback (text
// only) or it duplicates a habit already shown as its own button.
function actionButtonRow(action, existingRows) {
  if (!action || !action.callback) return null;
  const dup = (existingRows || []).some(function (row) {
    return row.some(function (b) { return b.callback_data === action.callback; });
  });
  if (dup) return null;
  return [{ text: action.label, callback_data: action.callback }];
}

// ── composeMorning (R3, R8) ─────────────────────────────────────────────
// Consolidated morning message: neutral greeting + date, mood row (omitted
// if mood already logged today), today's training line, morning-habit
// buttons, and ONE suggested small action. If nothing is due and there is
// no training, sends the mood prompt only. Returns { text, buttons }.
async function composeMorning(state, opts) {
  const moodDone = moodLoggedToday(state);
  const training = trainingLine(state);
  const habitRows = morningHabitRows(state);
  const action = resolveAction(state, opts);

  const nothingDue = habitRows.length === 0 && !training;

  const buttons = [];
  if (!moodDone) buttons.push(moodButtonRow());

  // R3.4: nothing due and no training → mood prompt only.
  if (nothingDue) {
    if (moodDone) {
      // Nothing to prompt at all — keep it to a light neutral hello.
      const text = await composeWithFallback('Morning — ' + dateLabel() + '. Nothing scheduled; take it at your pace.', opts);
      return { text: text, buttons: [] };
    }
    const text = await composeWithFallback('Morning — ' + dateLabel() + '. How are you feeling today?', opts);
    return { text: text, buttons: buttons };
  }

  const lines = ['Morning — ' + dateLabel() + '.'];
  if (!moodDone) lines.push('How are you feeling today?');
  if (training) lines.push(training);
  if (habitRows.length) lines.push('Morning habits are ready to tick below.');
  if (action) lines.push('One small step: ' + action.label + '.');

  habitRows.forEach(function (r) { buttons.push(r); });
  const actRow = actionButtonRow(action, buttons);
  if (actRow) buttons.push(actRow);

  const text = await composeWithFallback(lines.join('\n'), opts);
  return { text: text, buttons: buttons };
}

// ── composeMidday (R6, R7) ──────────────────────────────────────────────
// Light midday check with a single small action. Returns { text, buttons }.
async function composeMidday(state, opts) {
  const today = localDateKey();
  const action = resolveAction(state, opts);

  const settings = (state && state.waterSettings) || {};
  const glassMl = Number(settings.glassMl || 250);
  const currentMl = Math.round(Number((state && state.water || {})[today] || 0) * glassMl);

  const lines = ['Midday check-in.'];
  if (currentMl > 0) lines.push('Water so far: ' + currentMl + 'ml.');
  if (action) lines.push('One thing you could do now: ' + action.label + '.');
  else lines.push('You\'re on track — carry on at your pace.');

  const buttons = [];
  const actRow = actionButtonRow(action, buttons);
  if (actRow) buttons.push(actRow);

  const text = await composeWithFallback(lines.join('\n'), opts);
  return { text: text, buttons: buttons };
}

// ── composeEvening (R5, R7) ─────────────────────────────────────────────
// Low-pressure evening check-in with "already-done ⇒ skip" awareness: if
// everything for the day is done, frames a calm wind-down + a gratitude
// reflection instead of another action. Returns { text, buttons }.
async function composeEvening(state, opts) {
  const today = localDateKey();
  const dueDaily = (state && state.habits || []).filter(function (h) {
    return isHabitDailyDueToday(h, today);
  });
  const action = resolveAction(state, opts);

  const buttons = [];
  let lines;

  if (dueDaily.length === 0) {
    // Nothing left open — a settled wind-down + one reflective prompt (R5.2/R7.5).
    lines = ['Evening — ' + dateLabel() + '.', 'Everything for today is ticked.', 'One good moment from today worth holding onto?'];
  } else {
    lines = ['Evening — ' + dateLabel() + '.'];
    if (action) lines.push('If you fancy one more thing: ' + action.label + '.');
    else lines.push('Wind down whenever you\'re ready.');
    const actRow = actionButtonRow(action, buttons);
    if (actRow) buttons.push(actRow);
  }

  const text = await composeWithFallback(lines.join('\n'), opts);
  return { text: text, buttons: buttons };
}

// ── composeRutNudge (R5.3, R6.3) ────────────────────────────────────────
// Low-pressure re-engagement after a couple of quiet days, offering exactly
// ONE tiny restart action. Returns { text, buttons }.
async function composeRutNudge(state, opts) {
  const rut = detectRut(state);
  const restart = pickRestartAction(state); // { kind, habit?, label }

  const lines = ['Off-days happen — no pressure at all.', 'Whenever you\'re ready, one small thing to ease back in: ' + restart.label + '.'];

  const buttons = [];
  if (restart.kind === 'habit' && restart.habit) {
    buttons.push([{ text: '✓ ' + restart.label, callback_data: 'habit:' + restart.habit.id }]);
  } else {
    buttons.push([{ text: '💧 + 1 glass', callback_data: 'water:250' }]);
  }

  const text = await composeWithFallback(lines.join(' '), opts);
  return { text: text, buttons: buttons, daysQuiet: rut.daysQuiet };
}

// ── composeWeeklyDigest (R13) ───────────────────────────────────────────
// Reflective weekly review (Sonnet model). Opens with the single most
// encouraging true fact, names at most one thing that slipped (guilt-free),
// and ends with exactly one small focus for the week ahead. If little/no
// data, frames the coming week as a fresh start. Returns text (no buttons).
async function composeWeeklyDigest(state, opts) {
  const summary = buildWeekSummary(state);
  const lines = summaryToLines(summary);

  let deterministic;
  if (!lines.length) {
    // R13.4 — fresh start, no reference to lack of data as failure.
    deterministic = 'A fresh week ahead. Pick one small focus to aim for — something you\'d be glad to have done by Sunday.';
  } else {
    // Opening: single most encouraging true fact (R13.1).
    let open;
    if (summary.strongestHabit) open = 'Strongest this week: ' + summary.strongestHabit + '.';
    else if (summary.sessionsThisWeek) open = 'You got ' + summary.sessionsThisWeek + ' workouts in this week.';
    else if (summary.tasksDone) open = 'You completed ' + summary.tasksDone + ' tasks this week.';
    else if (summary.avgMoodThisWeek != null) open = 'Average mood this week: ' + summary.avgMoodThisWeek + '/5.';
    else open = 'You showed up this week — that counts.';

    // Optional gentle "one thing to nudge" (R13.2), framed without guilt.
    let slip = '';
    if (summary.weakestHabit) slip = ' One to nudge next week: ' + summary.weakestHabit + '.';

    // Closing: exactly one small focus for the week ahead (R13.3).
    let focus;
    if (summary.upcomingEvent) focus = ' This week\'s focus: ' + summary.upcomingEvent + '.';
    else if (summary.weakestHabit) focus = ' This week\'s focus: one more go at ' + summary.weakestHabit.replace(/\s*\(\d+%\)/, '') + '.';
    else focus = ' This week\'s focus: pick one thing that matters and start small.';

    deterministic = open + slip + focus;
  }

  // Weekly digest uses the Sonnet model (reflective, once a week).
  const digestOpts = Object.assign({}, opts, {
    model: (opts && opts.model) || SONNET_MODEL,
    maxTokens: (opts && opts.maxTokens) || 220,
    temperature: (opts && typeof opts.temperature === 'number') ? opts.temperature : 0.7
  });
  return await composeWithFallback(deterministic, digestOpts);
}

module.exports = {
  TONE_RULES,
  sanitizeGuilt,
  composeWithFallback,
  composeMorning,
  composeMidday,
  composeEvening,
  composeRutNudge,
  composeWeeklyDigest
};
