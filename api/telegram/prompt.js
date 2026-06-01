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
  await tg('sendMessage', {
    chat_id: chatId,
    text: '🌅 Morning. How are you feeling today?',
    reply_markup: { inline_keyboard: moodButtons }
  });
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
  const emoji = anchor === 'morning' ? '🌅' : anchor === 'midday' ? '☀️' : '🌙';
  const label = anchor === 'morning' ? 'morning' : anchor === 'midday' ? 'midday' : 'evening';
  const buttons = due.map(h => [{
    text: '◯ ' + (h.icon ? h.icon + ' ' : '') + h.name,
    callback_data: 'habit:' + h.id
  }]);
  await tg('sendMessage', {
    chat_id: chatId,
    text: emoji + ' Time for your ' + label + ' habits. Tap to tick:',
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
  await tg('sendMessage', {
    chat_id: chatId,
    text: '💧 Water break. ' + currentMl + ' / ' + targetMl + 'ml so far. ' + remaining + 'ml to go.',
    reply_markup: { inline_keyboard: [
      [
        { text: '+250ml', callback_data: 'water:250' },
        { text: '+500ml', callback_data: 'water:500' },
        { text: '+750ml', callback_data: 'water:750' }
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
  // Mood not logged?
  const m = state.mood && state.mood[today];
  const lines = [];
  lines.push('🌙 Before bed catch-up.');
  if (dueDaily.length) {
    lines.push('\nUntracked daily habits today:');
  } else {
    lines.push('\n✓ All daily habits done — well done.');
  }
  const buttons = dueDaily.slice(0, 8).map(h => [{
    text: '◯ ' + (h.icon ? h.icon + ' ' : '') + h.name,
    callback_data: 'habit:' + h.id
  }]);
  if (dueDaily.length > 8) {
    lines.push('(showing first 8 of ' + dueDaily.length + ')');
  }
  // Send the habits message first
  if (buttons.length) {
    await tg('sendMessage', {
      chat_id: chatId,
      text: lines.join('\n'),
      reply_markup: { inline_keyboard: buttons }
    });
  } else {
    await tg('sendMessage', { chat_id: chatId, text: lines.join('\n') });
  }
  // Then the gratitude prompt — separate so it stands out
  await tg('sendMessage', {
    chat_id: chatId,
    text: '🙏 End of day reflection — what is one thing you are grateful for today?',
    reply_markup: { force_reply: true, input_field_placeholder: 'a moment, person, or win…' }
  });
  return { sent: 'bedtime', habitsRemaining: dueDaily.length };
}

async function sendWeeklyCheckin(chatId) {
  const state = await loadState();
  if (!state) return { error: 'no-state' };
  const today = localDateKey();
  const outstanding = (state.habits || []).filter(h => isHabitWeeklyOutstanding(h, today));
  if (!outstanding.length) {
    await tg('sendMessage', { chat_id: chatId, text: '🎯 Weekly check-in: all weekly habits hit. Strong week.' });
    return { skipped: 'all-done' };
  }
  const buttons = outstanding.map(h => [{
    text: '◯ ' + (h.icon ? h.icon + ' ' : '') + h.name + ' (' + h.freq + ')',
    callback_data: 'habit:' + h.id
  }]);
  await tg('sendMessage', {
    chat_id: chatId,
    text: '📅 Weekly check-in. Anything below you have already done but forgot to tick?',
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
