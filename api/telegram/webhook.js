// Telegram webhook — receives messages and inline-button taps from the bot.
// ============================================================
// All actions update Firestore so the web app reflects them on next load.
//
// Conversational flow:
//   - Inline buttons for taps (habits, water amounts, mood)
//   - force_reply for free-text input (gratitude, sleep)
//   - Friendly, varied replies — not CRUD-app robotic
const {
  loadState,
  saveState,
  tg,
  getChatId,
  localDateKey,
  habitDayStatus,
  isHabitDailyDueToday
} = require('./_helpers.js');

// ----- Tone helpers --------------------------------------------------------
// Pick a random friendly reply from a pool — keeps the bot feeling alive.
function pick(list) { return list[Math.floor(Math.random() * list.length)]; }

const REPLIES = {
  habitTicked: [
    'Nice. {h} ticked off ✓',
    '{h} done — that\'s one off the list.',
    'Got it, {h} logged.',
    '{h} ✓ — keep going.',
    'Boom. {h} is yours.'
  ],
  habitUntiked: [
    '{h} unticked.',
    'Took {h} back off — no worries.'
  ],
  moodLogged: {
    1: ['Tough one today — sending you something gentle. {e}', 'I\'ve got you. {e} noted.', 'Logged. Be kind to yourself today. {e}'],
    2: ['Logged {e}. Hope it lifts.', '{e} noted. One small win today might shift things.'],
    3: ['Solid middle. {e} logged.', 'Steady-as-she-goes mood {e} ✓'],
    4: ['Love that. {e} logged ✓', '{e} — good day energy.', 'Logged {e}. Stay in it.'],
    5: ['Yes! Glow day {e} 🎉', '{e} — riding high. Logged.', 'Top-tier energy. {e} ✓']
  },
  sleepLogged: [
    '{n}h sleep ✓ — that\'ll do.',
    'Got {n}h. Hope it was decent.',
    '{n}h logged. Now go drink some water.'
  ],
  waterAdded: [
    '+{ml}ml. You\'re at {pct}% today 💧',
    '{ml}ml down. {pct}% of your goal — keep sipping.',
    'Logged {ml}ml. {pct}% there 💧'
  ],
  waterGoalHit: [
    'Goal hit! 💧 You\'re fully hydrated today — beautiful.',
    'Full hydration unlocked 🎉 You\'ve smashed your water goal.',
    'That\'s the daily target ✓ Bonus glasses from here.'
  ],
  gratitudeLogged: [
    '🙏 Captured that — "{x}"',
    'Logged: "{x}". That\'s a good one.',
    'Saved 🙏 — "{x}"'
  ],
  winLogged: [
    '🏆 Logged that win — "{x}"',
    'Win banked: "{x}" 🏆',
    '"{x}" — celebrating that with you 🏆'
  ],
  noHabit: [
    'Hmm, no habit matched that. Try a closer name?',
    'I couldn\'t find that one — what\'s it called exactly?'
  ],
  unknown: [
    'I didn\'t quite catch that. Send /help for what I know.',
    'Lost on that one. Try /today or /help.'
  ]
};
function fmtReply(template, vars) {
  let out = template;
  Object.keys(vars || {}).forEach(k => { out = out.split('{' + k + '}').join(vars[k]); });
  return out;
}

// ----- Action handlers -----------------------------------------------------
function genId() { return Math.random().toString(36).slice(2, 9); }

async function handleHabitTick(habitId, chatId, messageId, allHabitsContext) {
  const state = await loadState();
  if (!state) return null;
  const habit = (state.habits || []).find(h => h.id === habitId);
  if (!habit) return null;
  const today = localDateKey();
  if (!habit.logs) habit.logs = {};
  const wasDone = !!habit.logs[today];
  habit.logs[today] = !wasDone;
  await saveState(state);
  return { habit, done: !wasDone };
}

async function handleMood(moodValue) {
  const state = await loadState();
  if (!state) return null;
  const today = localDateKey();
  if (!state.mood) state.mood = {};
  if (!state.mood[today]) state.mood[today] = {};
  state.mood[today].mood = Number(moodValue);
  await saveState(state);
  return state.mood[today];
}

async function handleSleep(sleepHours) {
  const state = await loadState();
  if (!state) return null;
  const today = localDateKey();
  if (!state.mood) state.mood = {};
  if (!state.mood[today]) state.mood[today] = {};
  state.mood[today].sleep = Number(sleepHours);
  await saveState(state);
  return state.mood[today];
}

async function handleWaterAdd(ml) {
  const state = await loadState();
  if (!state) return null;
  const today = localDateKey();
  if (!state.water) state.water = {};
  if (!state.waterSettings) state.waterSettings = {};
  const glassMl = Number(state.waterSettings.glassMl || 250);
  const target = Number(state.waterSettings.target || 8);
  const currentGlasses = Number(state.water[today] || 0);
  const wasAtGoal = currentGlasses >= target;
  const addGlasses = Number(ml) / glassMl;
  state.water[today] = Math.max(0, Math.round((currentGlasses + addGlasses) * 100) / 100);
  await saveState(state);
  const nowMl = Math.round(state.water[today] * glassMl);
  const targetMl = target * glassMl;
  const justHitGoal = !wasAtGoal && state.water[today] >= target;
  return { glasses: state.water[today], target, ml: nowMl, targetMl, justHitGoal };
}

async function handleWaterReset() {
  const state = await loadState();
  if (!state) return null;
  const today = localDateKey();
  if (!state.water) state.water = {};
  state.water[today] = 0;
  await saveState(state);
  return { glasses: 0 };
}

async function handleGratitude(text) {
  const state = await loadState();
  if (!state) return null;
  const today = localDateKey();
  if (!state.gratitude) state.gratitude = [];
  state.gratitude.push({ id: genId(), date: today, wins: '', gratitude: text.trim() });
  await saveState(state);
  return { count: state.gratitude.filter(e => e.date === today).length };
}

async function handleGratitudeWin(text) {
  const state = await loadState();
  if (!state) return null;
  const today = localDateKey();
  if (!state.gratitude) state.gratitude = [];
  state.gratitude.push({ id: genId(), date: today, wins: text.trim(), gratitude: '' });
  await saveState(state);
  return { count: state.gratitude.filter(e => e.date === today).length };
}

// ----- Reusable button builders --------------------------------------------
function habitButtons(habits, todayKey) {
  return habits.map(h => {
    const done = h.logs && h.logs[todayKey];
    return [{
      text: (done ? '✓ ' : '◯ ') + (h.icon ? h.icon + ' ' : '') + h.name,
      callback_data: 'habit:' + h.id
    }];
  });
}
function moodButtons() {
  return [[
    { text: '😞', callback_data: 'mood:1' },
    { text: '😐', callback_data: 'mood:2' },
    { text: '🙂', callback_data: 'mood:3' },
    { text: '😊', callback_data: 'mood:4' },
    { text: '🤩', callback_data: 'mood:5' }
  ]];
}
function waterButtons() {
  return [
    [
      { text: '+ 1 glass (250ml)', callback_data: 'water:250' },
      { text: '+ 2 glasses (500ml)', callback_data: 'water:500' }
    ],
    [
      { text: '+ Bottle (750ml)', callback_data: 'water:750' },
      { text: '+ Big bottle (1L)', callback_data: 'water:1000' }
    ],
    [
      { text: '🎯 Hit goal', callback_data: 'water:goal' }
    ]
  ];
}

// ----- Text command parsing ------------------------------------------------
function parseTextCommand(text) {
  const trimmed = (text || '').trim();
  if (!trimmed) return null;
  const lower = trimmed.toLowerCase();

  if (lower === '/start' || lower === 'start') return { type: 'start' };
  if (lower === '/help' || lower === 'help') return { type: 'help' };
  if (lower === '/today' || lower === 'today') return { type: 'today' };
  // Conversational shortcuts
  if (lower === '/gratitude' || lower === 'gratitude') return { type: 'gratitude-prompt' };
  if (lower === '/win' || lower === 'win') return { type: 'win-prompt' };
  if (lower === '/water' || lower === 'water') return { type: 'water-prompt' };
  if (lower === '/mood' || lower === 'mood') return { type: 'mood-prompt' };
  if (lower === '/sleep' || lower === 'sleep') return { type: 'sleep-prompt' };

  const moodMatch = lower.match(/^\/?mood\s+([1-5])$/);
  if (moodMatch) return { type: 'mood', value: Number(moodMatch[1]) };

  const sleepMatch = lower.match(/^\/?sleep\s+(\d+(?:\.\d+)?)$/);
  if (sleepMatch) return { type: 'sleep', value: Number(sleepMatch[1]) };

  const waterMatch = lower.match(/^\/?water\s+(\d+)$/);
  if (waterMatch) return { type: 'water', value: Number(waterMatch[1]) };

  const gratMatch = trimmed.match(/^\/?(?:log\s+)?gratitude\s*[:\-]\s*(.+)$/i);
  if (gratMatch) return { type: 'gratitude', text: gratMatch[1] };

  const winMatch = trimmed.match(/^\/?(?:log\s+)?win\s*[:\-]\s*(.+)$/i);
  if (winMatch) return { type: 'win', text: winMatch[1] };

  const tickMatch = trimmed.match(/^\/?tick\s+(.+)$/i);
  if (tickMatch) return { type: 'tick', query: tickMatch[1] };

  return { type: 'free-text', text: trimmed };
}

function findHabitByQuery(state, query) {
  const q = query.toLowerCase().trim();
  const habits = state.habits || [];
  let h = habits.find(x => x.name.toLowerCase() === q);
  if (h) return h;
  h = habits.find(x => x.name.toLowerCase().startsWith(q));
  if (h) return h;
  h = habits.find(x => x.name.toLowerCase().includes(q));
  return h || null;
}

// Conversational greetings based on time of day
function timeGreeting() {
  const hr = new Date().getHours();
  if (hr < 5) return 'Up late?';
  if (hr < 12) return 'Morning ☀️';
  if (hr < 17) return 'Hey there';
  if (hr < 21) return 'Evening 🌙';
  return 'Late night vibes';
}

// ----- Webhook handler -----------------------------------------------------
module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const update = req.body || {};
  const expectedChatId = getChatId();

  try {
    // ----- Callback query (button tap) ----
    if (update.callback_query) {
      const cq = update.callback_query;
      const chatId = cq.message && cq.message.chat && cq.message.chat.id;
      const messageId = cq.message && cq.message.message_id;
      const data = cq.data || '';

      if (expectedChatId && chatId !== expectedChatId) {
        await tg('answerCallbackQuery', { callback_query_id: cq.id, text: 'Not authorised' });
        return res.status(200).json({ ok: true });
      }
      await tg('answerCallbackQuery', { callback_query_id: cq.id });

      // ---- Habit tick: refresh the parent message with updated state ----
      if (data.startsWith('habit:')) {
        const hid = data.slice('habit:'.length);
        const result = await handleHabitTick(hid, chatId, messageId);
        if (!result) return res.status(200).json({ ok: true });

        // Re-render the message with the new state — keep buttons live for the rest
        const state = await loadState();
        const today = localDateKey();
        // Try to detect what kind of message this was based on the text/markup
        const originalText = cq.message && cq.message.text || '';

        if (originalText.includes('Today (')) {
          // /today board — refresh inline to show new state
          await refreshTodayMessage(chatId, messageId);
        } else if (originalText.includes('catch-up') || originalText.includes('habits today')) {
          // Bedtime catch-up — re-render with same logic
          await refreshHabitListMessage(chatId, messageId, originalText);
        } else if (originalText.includes('habits')) {
          // Anchor prompts — refresh
          await refreshHabitListMessage(chatId, messageId, originalText);
        } else {
          // Fallback: just edit this single button
          try {
            await tg('editMessageReplyMarkup', {
              chat_id: chatId, message_id: messageId,
              reply_markup: { inline_keyboard: [[{
                text: result.done ? '✓ ' + result.habit.name + ' — done' : '◯ ' + result.habit.name,
                callback_data: 'habit:' + result.habit.id
              }]] }
            });
          } catch (e) { /* ignore */ }
        }

        // Friendly acknowledgement (small, won't spam if you tap many)
        const tmpl = result.done ? pick(REPLIES.habitTicked) : pick(REPLIES.habitUntiked);
        await tg('sendMessage', { chat_id: chatId, text: fmtReply(tmpl, { h: result.habit.name }) });
        return res.status(200).json({ ok: true });
      }

      // ---- Mood tap ----
      if (data.startsWith('mood:')) {
        const m = Number(data.slice('mood:'.length));
        await handleMood(m);
        const moodEm = ['', '😞', '😐', '🙂', '😊', '🤩'];
        const tmpl = pick(REPLIES.moodLogged[m] || REPLIES.moodLogged[3]);
        const text = fmtReply(tmpl, { e: moodEm[m] });
        // Edit the original message to confirm
        try {
          await tg('editMessageReplyMarkup', { chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: [] } });
        } catch (e) { /* ignore */ }
        await tg('sendMessage', { chat_id: chatId, text: text });
        // Then ask about sleep
        await tg('sendMessage', {
          chat_id: chatId,
          text: 'And how did you sleep? Hours, like 7.5',
          reply_markup: { force_reply: true, input_field_placeholder: '7.5' }
        });
        return res.status(200).json({ ok: true });
      }

      // ---- Water tap ----
      if (data.startsWith('water:')) {
        const slug = data.slice('water:'.length);
        if (slug === 'goal') {
          // Set water to target glasses
          const state = await loadState();
          if (!state) return res.status(200).json({ ok: true });
          if (!state.waterSettings) state.waterSettings = {};
          const target = Number(state.waterSettings.target || 8);
          if (!state.water) state.water = {};
          state.water[localDateKey()] = target;
          await saveState(state);
          await tg('sendMessage', { chat_id: chatId, text: pick(REPLIES.waterGoalHit) });
        } else if (slug === '0') {
          await handleWaterReset();
          await tg('sendMessage', { chat_id: chatId, text: 'Water reset for today.' });
        } else {
          const ml = Number(slug);
          const result = await handleWaterAdd(ml);
          if (result) {
            const pct = Math.min(100, Math.round((result.ml / result.targetMl) * 100));
            const text = result.justHitGoal
              ? pick(REPLIES.waterGoalHit)
              : fmtReply(pick(REPLIES.waterAdded), { ml: ml, pct: pct });
            await tg('sendMessage', { chat_id: chatId, text: text });
          }
        }
        return res.status(200).json({ ok: true });
      }

      if (data === 'noop') return res.status(200).json({ ok: true });
      return res.status(200).json({ ok: true });
    }

    // ----- Message ----
    if (update.message) {
      const msg = update.message;
      const chatId = msg.chat && msg.chat.id;
      const text = msg.text || '';

      if (expectedChatId && chatId !== expectedChatId) {
        await tg('sendMessage', {
          chat_id: chatId,
          text: 'This bot is private. Your chat ID is: ' + chatId
        });
        return res.status(200).json({ ok: true });
      }
      if (!expectedChatId) {
        await tg('sendMessage', {
          chat_id: chatId,
          text: '👋 Bot is alive. Your chat ID is: ' + chatId + '\nAdd this to Vercel as TELEGRAM_CHAT_ID then redeploy.'
        });
        return res.status(200).json({ ok: true });
      }

      const cmd = parseTextCommand(text);
      if (!cmd) return res.status(200).json({ ok: true });

      switch (cmd.type) {
        case 'start':
          await tg('sendMessage', {
            chat_id: chatId,
            text: 'Hey ' + timeGreeting() + ' — Life Hub bot here.\n\nI\'ll check in throughout the day:\n☀️ 7am — mood + sleep\n📋 9am, 1pm, 7pm — habits at their times\n💧 11am, 2pm, 5pm, 8pm — water nudges\n🌙 9pm — bedtime catch-up + reflection\n📅 Saturday 2pm — weekly habit check\n\nQuick commands you can send anytime:\n• /today — what\'s still untracked (with tick buttons)\n• /gratitude — log a gratitude entry\n• /win — log a win\n• /water — quick water buttons\n• /mood — quick mood buttons\n• /sleep — log sleep hours\n• tick <habit name>\n\nLet\'s keep it light. ✨'
          });
          return res.status(200).json({ ok: true });

        case 'help':
          await tg('sendMessage', {
            chat_id: chatId,
            text: 'What I respond to:\n\n• /today — daily habits with tick buttons\n• /gratitude — I\'ll ask, you reply\n• /win — same flow for a win\n• /water — quick add buttons\n• /mood — quick mood emojis\n• /sleep — log sleep hours\n• tick <habit name> — tick by name\n• gratitude: <text> — log directly\n• win: <text> — log directly\n\nOr just message me a gratitude line and I\'ll log it.'
          });
          return res.status(200).json({ ok: true });

        case 'today': {
          const state = await loadState();
          if (!state) {
            await tg('sendMessage', { chat_id: chatId, text: 'Could not load Life Hub data.' });
            return res.status(200).json({ ok: true });
          }
          await sendTodayBoard(chatId, state);
          return res.status(200).json({ ok: true });
        }

        case 'gratitude-prompt':
          await tg('sendMessage', {
            chat_id: chatId,
            text: '🙏 What are you grateful for?',
            reply_markup: { force_reply: true, input_field_placeholder: 'a moment, person, anything…' }
          });
          return res.status(200).json({ ok: true });

        case 'win-prompt':
          await tg('sendMessage', {
            chat_id: chatId,
            text: '🏆 Tell me about a win — big or small.',
            reply_markup: { force_reply: true, input_field_placeholder: 'what\'s the win?' }
          });
          return res.status(200).json({ ok: true });

        case 'water-prompt': {
          const state = await loadState();
          const today = localDateKey();
          const settings = (state && state.waterSettings) || {};
          const glassMl = Number(settings.glassMl || 250);
          const target = Number(settings.target || 8);
          const currentGlasses = Number((state && state.water && state.water[today]) || 0);
          const currentMl = Math.round(currentGlasses * glassMl);
          const targetMl = target * glassMl;
          const pct = Math.min(100, Math.round((currentMl / targetMl) * 100));
          const status = currentMl >= targetMl
            ? 'You\'ve already hit your goal today 🎉 Bonus glass?'
            : currentMl + 'ml / ' + targetMl + 'ml so far (' + pct + '%). How much did you drink?';
          await tg('sendMessage', {
            chat_id: chatId,
            text: '💧 ' + status,
            reply_markup: { inline_keyboard: waterButtons() }
          });
          return res.status(200).json({ ok: true });
        }

        case 'mood-prompt':
          await tg('sendMessage', {
            chat_id: chatId,
            text: '🌡️ How are you feeling?',
            reply_markup: { inline_keyboard: moodButtons() }
          });
          return res.status(200).json({ ok: true });

        case 'sleep-prompt':
          await tg('sendMessage', {
            chat_id: chatId,
            text: '💤 How many hours of sleep?',
            reply_markup: { force_reply: true, input_field_placeholder: '7.5' }
          });
          return res.status(200).json({ ok: true });

        case 'mood': {
          await handleMood(cmd.value);
          const moodEm = ['', '😞', '😐', '🙂', '😊', '🤩'];
          const tmpl = pick(REPLIES.moodLogged[cmd.value] || REPLIES.moodLogged[3]);
          await tg('sendMessage', { chat_id: chatId, text: fmtReply(tmpl, { e: moodEm[cmd.value] }) });
          return res.status(200).json({ ok: true });
        }

        case 'sleep': {
          await handleSleep(cmd.value);
          await tg('sendMessage', { chat_id: chatId, text: fmtReply(pick(REPLIES.sleepLogged), { n: cmd.value }) });
          return res.status(200).json({ ok: true });
        }

        case 'water': {
          const result = await handleWaterAdd(cmd.value);
          if (result) {
            const pct = Math.min(100, Math.round((result.ml / result.targetMl) * 100));
            const text = result.justHitGoal
              ? pick(REPLIES.waterGoalHit)
              : fmtReply(pick(REPLIES.waterAdded), { ml: cmd.value, pct: pct });
            await tg('sendMessage', { chat_id: chatId, text: text });
          }
          return res.status(200).json({ ok: true });
        }

        case 'gratitude': {
          await handleGratitude(cmd.text);
          await tg('sendMessage', { chat_id: chatId, text: fmtReply(pick(REPLIES.gratitudeLogged), { x: cmd.text }) });
          return res.status(200).json({ ok: true });
        }

        case 'win': {
          await handleGratitudeWin(cmd.text);
          await tg('sendMessage', { chat_id: chatId, text: fmtReply(pick(REPLIES.winLogged), { x: cmd.text }) });
          return res.status(200).json({ ok: true });
        }

        case 'tick': {
          const state = await loadState();
          if (!state) {
            await tg('sendMessage', { chat_id: chatId, text: 'Could not load Life Hub data.' });
            return res.status(200).json({ ok: true });
          }
          const h = findHabitByQuery(state, cmd.query);
          if (!h) {
            await tg('sendMessage', { chat_id: chatId, text: pick(REPLIES.noHabit) });
            return res.status(200).json({ ok: true });
          }
          await handleHabitTick(h.id);
          await tg('sendMessage', { chat_id: chatId, text: fmtReply(pick(REPLIES.habitTicked), { h: h.name }) });
          return res.status(200).json({ ok: true });
        }

        case 'free-text': {
          // Routed reply to a force_reply prompt?
          const replyTo = msg.reply_to_message && msg.reply_to_message.text;

          if (replyTo && /how did you sleep|hours of sleep|how.*sleep/i.test(replyTo)) {
            const num = parseFloat(text);
            if (!isNaN(num)) {
              await handleSleep(num);
              await tg('sendMessage', { chat_id: chatId, text: fmtReply(pick(REPLIES.sleepLogged), { n: num }) });
              return res.status(200).json({ ok: true });
            }
          }
          if (replyTo && /grateful|gratitude|reflect/i.test(replyTo)) {
            await handleGratitude(text);
            await tg('sendMessage', { chat_id: chatId, text: fmtReply(pick(REPLIES.gratitudeLogged), { x: text }) });
            return res.status(200).json({ ok: true });
          }
          if (replyTo && /win/i.test(replyTo)) {
            await handleGratitudeWin(text);
            await tg('sendMessage', { chat_id: chatId, text: fmtReply(pick(REPLIES.winLogged), { x: text }) });
            return res.status(200).json({ ok: true });
          }
          // Default — treat as gratitude if it's a sentence
          if (text.split(/\s+/).length >= 3) {
            await handleGratitude(text);
            await tg('sendMessage', { chat_id: chatId, text: fmtReply(pick(REPLIES.gratitudeLogged), { x: text }) + '\n\n(Send /help if you wanted a different command.)' });
            return res.status(200).json({ ok: true });
          }
          await tg('sendMessage', { chat_id: chatId, text: pick(REPLIES.unknown) });
          return res.status(200).json({ ok: true });
        }

        default:
          return res.status(200).json({ ok: true });
      }
    }

    return res.status(200).json({ ok: true });
  } catch (e) {
    console.error('Webhook error:', e);
    return res.status(200).json({ ok: true, error: e.message });
  }
};

// ----- Helpers for live message refreshing ---------------------------------

async function sendTodayBoard(chatId, state) {
  const today = localDateKey();
  const dueDaily = (state.habits || []).filter(h => (h.freq || 'daily').toLowerCase() === 'daily');
  const m = (state.mood || {})[today] || {};

  const lines = [];
  lines.push('📋 Today (' + today + ')');
  lines.push('');
  if (!dueDaily.length) {
    lines.push('No daily habits to track.');
  } else {
    const remaining = dueDaily.filter(h => habitDayStatus(h, today) === 'todo').length;
    if (remaining === 0) lines.push('✓ All daily habits done. Beautiful.');
    else lines.push('Tap to tick — ' + remaining + ' still due:');
  }
  if (!m.mood) lines.push('• Mood not logged · /mood');
  if (!m.sleep) lines.push('• Sleep not logged · /sleep');

  const buttons = habitButtons(dueDaily, today);
  await tg('sendMessage', {
    chat_id: chatId,
    text: lines.join('\n'),
    reply_markup: buttons.length ? { inline_keyboard: buttons } : undefined
  });
}

// Re-render the /today board after a tap
async function refreshTodayMessage(chatId, messageId) {
  const state = await loadState();
  if (!state) return;
  const today = localDateKey();
  const dueDaily = (state.habits || []).filter(h => (h.freq || 'daily').toLowerCase() === 'daily');
  const m = (state.mood || {})[today] || {};

  const lines = [];
  lines.push('📋 Today (' + today + ')');
  lines.push('');
  const remaining = dueDaily.filter(h => habitDayStatus(h, today) === 'todo').length;
  if (remaining === 0) lines.push('✓ All daily habits done. Beautiful.');
  else lines.push('Tap to tick — ' + remaining + ' still due:');
  if (!m.mood) lines.push('• Mood not logged · /mood');
  if (!m.sleep) lines.push('• Sleep not logged · /sleep');

  const buttons = habitButtons(dueDaily, today);
  try {
    await tg('editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text: lines.join('\n'),
      reply_markup: buttons.length ? { inline_keyboard: buttons } : { inline_keyboard: [] }
    });
  } catch (e) { /* ignore */ }
}

// Re-render any message that's just a habit list (bedtime, anchor prompts)
async function refreshHabitListMessage(chatId, messageId, originalText) {
  const state = await loadState();
  if (!state) return;
  const today = localDateKey();
  // Use only daily habits that are due
  const dueDaily = (state.habits || []).filter(h => isHabitDailyDueToday(h, today));
  // Plus any already-ticked daily habits that were on the original message — but we don't know which.
  // Simpler: show all daily habits with current state
  const allDaily = (state.habits || []).filter(h => (h.freq || 'daily').toLowerCase() === 'daily');
  const buttons = habitButtons(allDaily, today);
  try {
    await tg('editMessageReplyMarkup', {
      chat_id: chatId,
      message_id: messageId,
      reply_markup: { inline_keyboard: buttons }
    });
  } catch (e) { /* ignore */ }
}
