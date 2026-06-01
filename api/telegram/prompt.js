// Generic prompt sender — called by QStash on schedule.
// ============================================================
// Input via POST body: { type: 'morning' | 'water' | 'evening' | 'bedtime' | 'weekly' | 'anchor-morning' | 'anchor-midday' | 'anchor-evening' }
//
// Each type reads current Firestore state and crafts the appropriate prompt.
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
const { claude } = require('./_ai.js');
const { buildWeekSummary, summaryToLines, detectRut, pickRestartAction } = require('./_digest.js');

const SONNET_MODEL = process.env.ANTHROPIC_SONNET_MODEL || 'claude-sonnet-4-6';

async function sendMorningCheckin(chatId) {
  // Already logged?
  const state = await loadState();
  const today = localDateKey();
  const m = state && state.mood && state.mood[today];
  if (m && m.mood && m.sleep) {
    return { skipped: 'already-logged' };
  }
  const moodButtons = [
    [
      { text: '😞', callback_data: 'mood:1' },
      { text: '😐', callback_data: 'mood:2' },
      { text: '🙂', callback_data: 'mood:3' },
      { text: '😊', callback_data: 'mood:4' },
      { text: '🤩', callback_data: 'mood:5' }
    ]
  ];
  const greetings = [
    '🌅 Morning. How are you feeling today?',
    '☀️ New day. What\'s the vibe?',
    '🌅 Hey, how\'s today landing for you?',
    '☀️ Morning check-in — pick a face?'
  ];
  await tg('sendMessage', {
    chat_id: chatId,
    text: greetings[Math.floor(Math.random() * greetings.length)],
    reply_markup: { inline_keyboard: moodButtons }
  });

  // Then a tasks brief — what's on for today
  if (state) {
    const todayK = localDateKey();
    const wkStart = (function () {
      const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - d.getDay());
      return localDateKey(d);
    })();
    const open = (state.tasks || []).filter(t => !t.done);
    const priorities = open.filter(t => t.weekPriority === wkStart);
    const overdue = open.filter(t => t.dueDate && t.dueDate < todayK && t.weekPriority !== wkStart);
    const todays = open.filter(t => t.dueDate === todayK && t.weekPriority !== wkStart);

    const lines = [];
    if (priorities.length) {
      lines.push('⭐ This week:');
      priorities.forEach(t => lines.push('  ◯ ' + t.text));
    }
    if (overdue.length) {
      lines.push('\n⚠️ Overdue:');
      overdue.slice(0, 5).forEach(t => lines.push('  ◯ ' + t.text + ' (' + (t.dueDate || '') + ')'));
    }
    if (todays.length) {
      lines.push('\n📌 Today:');
      todays.forEach(t => lines.push('  ◯ ' + t.text));
    }
    if (lines.length) {
      lines.unshift('Quick brief —');
      lines.push('\nUse /tasks to tick anything off.');
      await tg('sendMessage', { chat_id: chatId, text: lines.join('\n') });
    }
  }

  return { sent: 'morning' };
}

async function sendAnchorPrompt(chatId, anchor) {
  const state = await loadState();
  if (!state) return { error: 'no-state' };
  const today = localDateKey();
  const due = (state.habits || []).filter(h => {
    const a = (h.anchor || 'anytime');
    return a === anchor && isHabitDailyDueToday(h, today);
  });
  if (!due.length) return { skipped: 'nothing-due' };
  const buttons = due.map(h => [{
    text: '◯ ' + (h.icon ? h.icon + ' ' : '') + h.name,
    callback_data: 'habit:' + h.id
  }]);
  const messages = {
    morning: ['🌅 Morning habits — what can we tick off?', '☀️ Time for the morning routine. Tap any:', '🌅 Quick AM check — any of these done?'],
    midday: ['☀️ Midday check — tap what you\'ve done:', '⏰ Lunchtime habits coming up. Anything ticked?', '☀️ How\'s the day going? Tick what\'s done:'],
    evening: ['🌙 Evening habits time. Tap to tick:', '🌙 Wind-down list. Anything done already?', '🌙 PM routine — tap any that you\'ve hit:']
  };
  const pool = messages[anchor] || messages.morning;
  await tg('sendMessage', {
    chat_id: chatId,
    text: pool[Math.floor(Math.random() * pool.length)],
    reply_markup: { inline_keyboard: buttons }
  });
  return { sent: 'anchor-' + anchor, count: due.length };
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

async function sendBedtimeCatchup(chatId) {
  const state = await loadState();
  if (!state) return { error: 'no-state' };
  const today = localDateKey();
  const dueDaily = (state.habits || []).filter(h => isHabitDailyDueToday(h, today));
  const allDaily = (state.habits || []).filter(h => (h.freq || 'daily').toLowerCase() === 'daily');
  // Send the catch-up first
  if (dueDaily.length) {
    const greetings = [
      '🌙 Before bed catch-up. Anything you forgot to tick?',
      '🌙 End of day check — tap anything you\'ve done:',
      '🌙 Quick run-through. Did any of these happen?'
    ];
    const buttons = allDaily.map(h => {
      const done = h.logs && h.logs[today];
      return [{
        text: (done ? '✓ ' : '◯ ') + (h.icon ? h.icon + ' ' : '') + h.name,
        callback_data: 'habit:' + h.id
      }];
    });
    await tg('sendMessage', {
      chat_id: chatId,
      text: greetings[Math.floor(Math.random() * greetings.length)],
      reply_markup: { inline_keyboard: buttons }
    });
  } else {
    await tg('sendMessage', {
      chat_id: chatId,
      text: '🌙 Big day. All daily habits done. Sleep well.'
    });
  }
  // Then the gratitude reflection
  const reflections = [
    '🙏 Before you sleep — what\'s one thing from today you\'re grateful for?',
    '🙏 End-of-day reflection. Anything stand out?',
    '🙏 Bedtime gratitude — what made today okay?',
    '🙏 One moment from today worth holding onto?'
  ];
  await tg('sendMessage', {
    chat_id: chatId,
    text: reflections[Math.floor(Math.random() * reflections.length)],
    reply_markup: { force_reply: true, input_field_placeholder: 'a moment, person, win…' }
  });
  return { sent: 'bedtime', habitsRemaining: dueDaily.length };
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

async function sendWeeklyDigest(chatId) {
  const state = await loadState();
  if (!state) return { error: 'no-state' };
  const summary = buildWeekSummary(state);
  const lines = summaryToLines(summary);
  if (!lines.length) {
    await tg('sendMessage', { chat_id: chatId, text: '📊 Weekly digest — not much logged this week yet. New week, fresh start. What\'s one thing you want to nail?' });
    return { skipped: 'no-data' };
  }

  const system = [
    'You are a warm, sharp weekly coach inside a wellbeing app for someone with ADHD working on productivity and sticking to goals.',
    'Write a SHORT weekly digest (Sunday evening) — 3 to 4 sentences, under 80 words.',
    'Open with the single most encouraging true thing from the data. Then name one thing that slipped, kindly.',
    'End with ONE specific, tiny focus for the week ahead drawn from the weakest area or upcoming deadline.',
    'Be specific to the numbers. Sound like a friend who pays attention, not a report.',
    'No markdown, no bullet points, no sign-off. One or two light emoji max. British English. Address them as "you".'
  ].join(' ');

  const text = await claude({
    model: SONNET_MODEL,
    maxTokens: 220,
    temperature: 0.7,
    system: system,
    prompt: 'This week\'s data:\n' + lines.join('\n') + '\n\nWrite the weekly digest:'
  });

  const fallback = '📊 Week in review: habits at ' + (summary.habitsThisWeek != null ? summary.habitsThisWeek + '%' : 'n/a')
    + ', ' + summary.sessionsThisWeek + ' workouts, ' + summary.tasksDone + ' tasks done. '
    + 'New week ahead — pick one thing to focus on.';

  await tg('sendMessage', { chat_id: chatId, text: (text || fallback) });
  return { sent: 'weekly-digest', habits: summary.habitsThisWeek };
}

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

  const action = pickRestartAction(state);

  const system = [
    'You are a kind, non-judgemental friend inside a wellbeing app. The user has ADHD and has gone quiet for a couple of days — no habits, mood, or activity logged.',
    'Send a SHORT, warm check-in (2 sentences, under 40 words). No guilt, no "you should".',
    'Acknowledge that off-days happen, then gently offer ONE tiny restart: "' + action.label + '".',
    'Sound human and low-pressure, like a mate texting. One soft emoji max. No markdown. British English.'
  ].join(' ');

  const text = await claude({
    maxTokens: 120,
    temperature: 0.8,
    system: system,
    prompt: 'It has been about ' + rut.daysQuiet + ' quiet days. Write the gentle check-in that ends by offering to ' + action.label + ':'
  });

  const fallback = 'Hey — noticed it\'s been a couple of quiet days. No stress, off-days are normal. Want to ease back in with just one thing: ' + action.label + '? 🌱';

  const reply_markup = action.kind === 'habit'
    ? { inline_keyboard: [[{ text: '✓ ' + action.label, callback_data: 'habit:' + action.habit.id }]] }
    : { inline_keyboard: [[{ text: '💧 + 1 glass', callback_data: 'water:250' }]] };

  await tg('sendMessage', { chat_id: chatId, text: (text || fallback), reply_markup: reply_markup });
  await kvSet('rutNudge', { date: rut.todayKey }, 60 * 60 * 24 * 7);
  return { sent: 'rut-check', daysQuiet: rut.daysQuiet };
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
      case 'anchor-morning':     result = await sendAnchorPrompt(chatId, 'morning'); break;
      case 'anchor-midday':      result = await sendAnchorPrompt(chatId, 'midday'); break;
      case 'anchor-evening':     result = await sendAnchorPrompt(chatId, 'evening'); break;
      case 'water':              result = await sendWaterPrompt(chatId); break;
      case 'bedtime':            result = await sendBedtimeCatchup(chatId); break;
      case 'weekly':             result = await sendWeeklyCheckin(chatId); break;
      case 'weekly-digest':      result = await sendWeeklyDigest(chatId); break;
      case 'rut-check':          result = await sendRutCheck(chatId); break;
      default:
        return res.status(400).json({ error: 'Unknown type: ' + type });
    }
    return res.status(200).json({ ok: true, type, result });
  } catch (e) {
    console.error('Prompt error:', type, e);
    return res.status(500).json({ error: e.message });
  }
};
