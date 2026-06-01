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
  isHabitWeeklyOutstanding
} = require('./_helpers.js');

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
      default:
        return res.status(400).json({ error: 'Unknown type: ' + type });
    }
    return res.status(200).json({ ok: true, type, result });
  } catch (e) {
    console.error('Prompt error:', type, e);
    return res.status(500).json({ error: e.message });
  }
};
