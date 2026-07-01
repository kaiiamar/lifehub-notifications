// Generic prompt sender — called by QStash on schedule.
// ============================================================
// Input via POST body: { type: 'morning' | 'midday' | 'evening' | 'water'
//   | 'weekly' | 'weekly-digest' | 'rut-check' | 'plan-week' | 'plan-day' }
//
// Each type reads current Firestore state and crafts the appropriate prompt.
// The consolidated morning/midday/evening messages, the reflective weekly
// digest and the rut nudge are built by the shared tone-enforced composers in
// _messages.js (one message, one small action, guilt-free by construction).
// The planner nudges (plan-week / plan-day) use _planner.js for day/week data.
const {
  loadState,
  tg,
  getChatId,
  localDateKey,
  isHabitDailyDueToday,
  isHabitWeeklyOutstanding,
  kvGet,
  kvSet
} = require('./_helpers.js');
const { detectRut } = require('./_digest.js');
const { composeMorning, composeMidday, composeEvening, composeWeeklyDigest, composeRutNudge, composeWithFallback } = require('./_messages.js');
const { pickOneAction, getToday, getWeek } = require('./_planner.js');

// Send a composed { text, buttons } result through Telegram. Wraps the
// sendMessage call in try/catch and logs { type, error } on failure so the
// delivery failure is recorded for later review (R1.3) rather than crashing
// the whole handler.
async function sendComposed(chatId, type, composed) {
  const payload = { chat_id: chatId, text: composed.text };
  if (composed.buttons && composed.buttons.length) {
    payload.reply_markup = { inline_keyboard: composed.buttons };
  }
  try {
    await tg('sendMessage', payload);
    return { sent: type };
  } catch (error) {
    console.error('Nudge delivery failed', { type: type, error: (error && error.message) ? error.message : String(error) });
    return { error: 'delivery-failed', type: type };
  }
}

// ── morning (R3, R6, R8) ────────────────────────────────────────────────
// Consolidated single-message morning check-in: mood row (omitted if mood
// already logged today), today's training, morning-habit buttons and ONE
// suggested small action — all attached to one sendMessage call.
async function sendMorningCheckin(chatId) {
  const state = await loadState();
  if (!state) return { error: 'no-state' };
  const composed = await composeMorning(state, { action: pickOneAction(state) });
  return await sendComposed(chatId, 'morning', composed);
}

// ── midday (R6, R7.2) ───────────────────────────────────────────────────
// Light midday check-in with a single small action.
async function sendMiddayCheckin(chatId) {
  const state = await loadState();
  if (!state) return { error: 'no-state' };
  const composed = await composeMidday(state, { action: pickOneAction(state) });
  return await sendComposed(chatId, 'midday', composed);
}

// ── evening (R5, R7.3, R7.4, R7.5) ──────────────────────────────────────
// Low-pressure evening check-in. Enforces "already-done ⇒ skip send"
// (R7.4 / Property 8): if the action this nudge would prompt is already
// complete for the day (pickOneAction returns null — nothing left to
// suggest), the handler returns without sending. Otherwise it sends a single
// calm evening message (never repeating earlier prompts, R7.5).
async function sendEveningCheckin(chatId) {
  const state = await loadState();
  if (!state) return { error: 'no-state' };
  const action = pickOneAction(state);
  if (!action) return { skipped: 'already-done' };
  const composed = await composeEvening(state, { action: action });
  return await sendComposed(chatId, 'evening', composed);
}

async function sendWaterPrompt(chatId) {
  const state = await loadState();
  const today = localDateKey();
  if (!state) return { error: 'no-state' };
  const settings = state.waterSettings || {};
  const glassMl = Number(settings.glassMl || 250);
  const target = Number(settings.target || 8);
  const targetMl = target * glassMl;
  const currentGlasses = Number((state.water || {})[today] || 0);
  const currentMl = Math.round(currentGlasses * glassMl);
  if (currentMl >= targetMl) return { skipped: 'goal-hit' };
  const remaining = targetMl - currentMl;
  const greetings = [
    '💧 Water check — ' + currentMl + 'ml so far. ' + remaining + 'ml to go.',
    '💧 Hydration nudge. Where are you at?',
    '💧 Quick sip break? You\'re at ' + Math.round((currentMl / targetMl) * 100) + '%.',
    '💧 ' + remaining + 'ml left to hit goal. Add what you\'ve drunk:'
  ];
  await tg('sendMessage', {
    chat_id: chatId,
    text: greetings[Math.floor(Math.random() * greetings.length)],
    reply_markup: { inline_keyboard: [
      [
        { text: '+ 1 glass', callback_data: 'water:250' },
        { text: '+ 2 glasses', callback_data: 'water:500' }
      ],
      [
        { text: '+ Bottle (750ml)', callback_data: 'water:750' },
        { text: '+ 1L', callback_data: 'water:1000' }
      ],
      [
        { text: '🎯 Hit goal', callback_data: 'water:goal' }
      ]
    ] }
  });
  return { sent: 'water', currentMl, targetMl };
}

async function sendWeeklyCheckin(chatId) {
  const state = await loadState();
  if (!state) return { error: 'no-state' };
  const today = localDateKey();
  const outstanding = (state.habits || []).filter(h => isHabitWeeklyOutstanding(h, today));
  if (!outstanding.length) {
    await tg('sendMessage', { chat_id: chatId, text: '🎯 Weekly check-in — all weekly habits hit. Strong week.' });
    return { skipped: 'all-done' };
  }
  const buttons = outstanding.map(h => [{
    text: '◯ ' + (h.icon ? h.icon + ' ' : '') + h.name + ' (' + h.freq + ')',
    callback_data: 'habit:' + h.id
  }]);
  const greetings = [
    '📅 Weekly check-in. Anything below you actually did but forgot to tick?',
    '📅 Saturday review — anything outstanding you can catch up on?',
    '📅 Quick weekly catch-up. Tap any you\'ve done:'
  ];
  await tg('sendMessage', {
    chat_id: chatId,
    text: greetings[Math.floor(Math.random() * greetings.length)],
    reply_markup: { inline_keyboard: buttons }
  });
  return { sent: 'weekly', count: outstanding.length };
}

// ── weekly-digest (R13) ─────────────────────────────────────────────────
// Reflective Sunday review built by composeWeeklyDigest (Sonnet model). The
// composer returns TEXT only (no buttons) and handles the fresh-start framing
// itself when little or no data was logged, so we send it directly. Wrapped
// in try/catch so a delivery failure is logged as { type, error } (R1.3)
// rather than throwing.
async function sendWeeklyDigest(chatId) {
  const state = await loadState();
  if (!state) return { error: 'no-state' };
  const text = await composeWeeklyDigest(state);
  try {
    await tg('sendMessage', { chat_id: chatId, text: text });
    return { sent: 'weekly-digest' };
  } catch (error) {
    console.error('Nudge delivery failed', { type: 'weekly-digest', error: (error && error.message) ? error.message : String(error) });
    return { error: 'delivery-failed', type: 'weekly-digest' };
  }
}

// ── rut-check (R5.3, R6.3) ──────────────────────────────────────────────
// Low-pressure re-engagement after a couple of quiet days. detectRut still
// decides WHETHER to send (not-in-rut ⇒ skip) and the existing 2-day debounce
// (kvGet/kvSet 'rutNudge') is preserved. The MESSAGE itself is now built by
// composeRutNudge (tone-enforced, one restart action) instead of an inline
// claude() call. Sent via sendComposed so delivery failures are logged.
async function sendRutCheck(chatId) {
  const state = await loadState();
  if (!state) return { error: 'no-state' };
  const rut = detectRut(state);
  if (!rut.inRut) return { skipped: 'not-in-rut', daysQuiet: rut.daysQuiet };

  // Debounce: don't nudge more than once every 2 days.
  const lastNudge = await kvGet('rutNudge');
  if (lastNudge && lastNudge.date) {
    const diff = (new Date(rut.todayKey) - new Date(lastNudge.date)) / 86400000;
    if (diff < 2) return { skipped: 'recently-nudged', daysQuiet: rut.daysQuiet };
  }

  const composed = await composeRutNudge(state);
  const result = await sendComposed(chatId, 'rut-check', composed);
  if (result && result.error) return result;
  await kvSet('rutNudge', { date: rut.todayKey }, 60 * 60 * 24 * 7);
  return { sent: 'rut-check', daysQuiet: rut.daysQuiet };
}

// ── plan-week (R9.1) ────────────────────────────────────────────────────
// Fires Sunday. Prompts the user to set a small weekly intention for the
// coming week. Uses getWeek(state) to reflect the current intention when one
// is already set for this week — in that case it's a gentle, guilt-free
// invitation to review/update rather than a demand. Weekly-task setting and
// intention saving happen via the /week and /plan commands (added in the
// webhook, task 14), so we point the user at those low-friction affordances.
async function sendPlanWeek(chatId) {
  const state = await loadState();
  if (!state) return { error: 'no-state' };
  const week = getWeek(state);

  const lines = [];
  if (week.intention && week.intention.text) {
    lines.push('This week\'s intention: ' + week.intention.text + '.');
    lines.push('Still the right focus? You can keep it or refresh it whenever you like.');
    lines.push('To update: send /week, or /plan intention: your new focus.');
  } else {
    lines.push('New week — a good moment to pick one small intention to aim for.');
    if (week.weeklyTasks && week.weeklyTasks.length) {
      lines.push('You already have ' + week.weeklyTasks.length + ' task(s) lined up for the week.');
    }
    lines.push('To set it: send /week, or /plan intention: your focus.');
  }

  const text = await composeWithFallback(lines.join('\n'));
  return await sendComposed(chatId, 'plan-week', { text: text, buttons: [] });
}

// ── plan-day (R10.4, R6.3) ──────────────────────────────────────────────
// Prompts the user to pick 1–3 daily focus tasks with a low-friction chooser.
// Uses getToday/getWeek. Only offers focus picking when fewer than 3 focus
// tasks are set for today; if 3 are already set (or all set focus tasks are
// done) it sends a neutral confirmation instead of another ask. Candidate
// tasks are drawn from this week's weeklyTasks + other open tasks, offered as
// tap-to-pick buttons using the focus:<taskId> callback (handled in task 14).
async function sendPlanDay(chatId) {
  const state = await loadState();
  if (!state) return { error: 'no-state' };

  const today = getToday(state);
  const focusTasks = today.focusTasks || [];
  const openFocus = focusTasks.filter(function (t) { return !t.done; });

  // Already at the 1–3 cap → neutral confirmation, no new ask (R10.1/R10.3).
  if (focusTasks.length >= 3) {
    if (openFocus.length === 0) {
      const text = await composeWithFallback('Today\'s focus is all ticked off. Nicely done — rest easy for the rest of the day.');
      return await sendComposed(chatId, 'plan-day', { text: text, buttons: [] });
    }
    const text = await composeWithFallback('Today\'s focus is set: ' + openFocus.length + ' task(s) to go. One at a time is plenty.');
    return await sendComposed(chatId, 'plan-day', { text: text, buttons: [] });
  }

  // Some focus already set (1–2) and all done → neutral confirmation (R10.3).
  if (focusTasks.length > 0 && openFocus.length === 0) {
    const text = await composeWithFallback('Today\'s focus is done. Add another if you like, or call it a win.');
    return await sendComposed(chatId, 'plan-day', { text: text, buttons: [] });
  }

  // Build the candidate list: this week's flexible tasks first, then other
  // open tasks — excluding anything already chosen as today's focus.
  const week = getWeek(state);
  const already = {};
  focusTasks.forEach(function (t) { if (t && t.id != null) already[t.id] = true; });

  const candidates = [];
  const seen = {};
  function addCandidate(t) {
    if (!t || t.done || t.id == null) return;
    if (already[t.id] || seen[t.id]) return;
    seen[t.id] = true;
    candidates.push(t);
  }
  (week.weeklyTasks || []).forEach(addCandidate);
  (state.tasks || []).forEach(addCandidate);

  const remainingSlots = 3 - focusTasks.length;
  const lines = [];
  if (focusTasks.length > 0) {
    lines.push('You\'ve got ' + focusTasks.length + ' focus task(s) for today.');
    lines.push('Room for ' + remainingSlots + ' more if you\'d like — pick from below.');
  } else {
    lines.push('Pick 1–3 focus tasks for today — small wins that\'d feel good to finish.');
  }

  const buttons = [];
  if (candidates.length) {
    // Cap the button list to keep the message light.
    candidates.slice(0, 6).forEach(function (t) {
      buttons.push([{ text: '◯ ' + t.text, callback_data: 'focus:' + t.id }]);
    });
  } else {
    lines.push('Nothing in your task list yet — add one with /plan or in the app.');
  }

  const text = await composeWithFallback(lines.join('\n'));
  return await sendComposed(chatId, 'plan-day', { text: text, buttons: buttons });
}

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST' && req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const type = (req.body && req.body.type) || req.query.type;
  if (!type) return res.status(400).json({ error: 'Missing type' });

  const chatId = getChatId();
  if (!chatId) return res.status(500).json({ error: 'TELEGRAM_CHAT_ID not configured' });

  try {
    let result;
    switch (type) {
      case 'morning':            result = await sendMorningCheckin(chatId); break;
      case 'midday':             result = await sendMiddayCheckin(chatId); break;
      case 'evening':            result = await sendEveningCheckin(chatId); break;
      case 'water':              result = await sendWaterPrompt(chatId); break;
      case 'weekly':             result = await sendWeeklyCheckin(chatId); break;
      case 'weekly-digest':      result = await sendWeeklyDigest(chatId); break;
      case 'rut-check':          result = await sendRutCheck(chatId); break;
      case 'plan-week':          result = await sendPlanWeek(chatId); break;
      case 'plan-day':           result = await sendPlanDay(chatId); break;
      default:
        return res.status(400).json({ error: 'Unknown type: ' + type });
    }
    return res.status(200).json({ ok: true, type, result });
  } catch (e) {
    console.error('Prompt error:', type, e);
    return res.status(500).json({ error: e.message });
  }
};
