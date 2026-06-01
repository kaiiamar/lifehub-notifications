// Telegram webhook — receives messages and inline-button taps from your bot.
// ============================================================
// Two main inputs to handle:
//  - message.text: free-form text (e.g. "log gratitude: ..." or replies to prompts)
//  - callback_query: button taps from inline keyboards
//
// All actions update Firestore so the web app reflects them on next load.
const {
  loadState,
  saveState,
  tg,
  getChatId,
  localDateKey,
  habitDayStatus
} = require('./_helpers.js');

// Generate a short id (matches the app's g())
function genId() {
  return Math.random().toString(36).slice(2, 9);
}

// ----- Action handlers ------------------------------------------------------

async function handleHabitTick(habitId, chatId, messageId) {
  const state = await loadState();
  if (!state) return tg('sendMessage', { chat_id: chatId, text: 'Could not load Life Hub data.' });
  const habit = (state.habits || []).find(h => h.id === habitId);
  if (!habit) return tg('sendMessage', { chat_id: chatId, text: 'Habit not found.' });
  const today = localDateKey();
  if (!habit.logs) habit.logs = {};
  const wasDone = !!habit.logs[today];
  habit.logs[today] = !wasDone;
  await saveState(state);
  // Edit the original button to show the new state
  if (messageId) {
    try {
      await tg('editMessageReplyMarkup', {
        chat_id: chatId,
        message_id: messageId,
        reply_markup: { inline_keyboard: [[{
          text: wasDone ? '◯ ' + habit.name : '✓ ' + habit.name + ' — done',
          callback_data: 'habit:' + habit.id
        }]] }
      });
    } catch (e) { /* ignore */ }
  }
  return { habit: habit.name, done: !wasDone };
}

async function handleMood(moodValue, chatId) {
  const state = await loadState();
  if (!state) return null;
  const today = localDateKey();
  if (!state.mood) state.mood = {};
  if (!state.mood[today]) state.mood[today] = {};
  state.mood[today].mood = Number(moodValue);
  await saveState(state);
  return state.mood[today];
}

async function handleSleep(sleepHours, chatId) {
  const state = await loadState();
  if (!state) return null;
  const today = localDateKey();
  if (!state.mood) state.mood = {};
  if (!state.mood[today]) state.mood[today] = {};
  state.mood[today].sleep = Number(sleepHours);
  await saveState(state);
  return state.mood[today];
}

async function handleWaterAdd(ml, chatId) {
  const state = await loadState();
  if (!state) return null;
  const today = localDateKey();
  if (!state.water) state.water = {};
  if (!state.waterSettings) state.waterSettings = {};
  const glassMl = Number(state.waterSettings.glassMl || 250);
  const target = Number(state.waterSettings.target || 8);
  // Convert ml addition to glass count (state.water[date] is glasses)
  const currentGlasses = Number(state.water[today] || 0);
  const addGlasses = Number(ml) / glassMl;
  state.water[today] = Math.max(0, Math.round((currentGlasses + addGlasses) * 100) / 100);
  await saveState(state);
  return {
    glasses: state.water[today],
    target: target,
    ml: Math.round(state.water[today] * glassMl),
    targetMl: target * glassMl
  };
}

async function handleWaterReset(chatId) {
  const state = await loadState();
  if (!state) return null;
  const today = localDateKey();
  if (!state.water) state.water = {};
  state.water[today] = 0;
  await saveState(state);
  return { glasses: 0 };
}

async function handleGratitude(text, chatId) {
  const state = await loadState();
  if (!state) return null;
  const today = localDateKey();
  if (!state.gratitude) state.gratitude = [];
  state.gratitude.push({
    id: genId(),
    date: today,
    wins: '',
    gratitude: text.trim()
  });
  await saveState(state);
  return { count: state.gratitude.filter(e => e.date === today).length };
}

async function handleGratitudeWin(text, chatId) {
  const state = await loadState();
  if (!state) return null;
  const today = localDateKey();
  if (!state.gratitude) state.gratitude = [];
  state.gratitude.push({
    id: genId(),
    date: today,
    wins: text.trim(),
    gratitude: ''
  });
  await saveState(state);
  return { count: state.gratitude.filter(e => e.date === today).length };
}

// Pending state — what is the bot waiting for from this chat right now?
// Stored in memory of the function instance only — for proper persistence we
// could use Redis, but Telegram includes message context via reply chains
// so we look at the message being replied to.
//
// Strategy: we use Telegram's `force_reply` or check if the user's text
// reply has a `reply_to_message` matching one of our prompts.

// ----- Text command parsing -------------------------------------------------

function parseTextCommand(text) {
  const trimmed = (text || '').trim();
  if (!trimmed) return null;
  const lower = trimmed.toLowerCase();

  // Quick commands
  if (lower === '/start' || lower === 'start') return { type: 'start' };
  if (lower === '/help' || lower === 'help') return { type: 'help' };
  if (lower === '/today' || lower === 'today') return { type: 'today' };

  // Mood: /mood 4 or "mood 4"
  const moodMatch = lower.match(/^\/?mood\s+([1-5])$/);
  if (moodMatch) return { type: 'mood', value: Number(moodMatch[1]) };

  // Sleep: /sleep 7.5 or "sleep 8"
  const sleepMatch = lower.match(/^\/?sleep\s+(\d+(?:\.\d+)?)$/);
  if (sleepMatch) return { type: 'sleep', value: Number(sleepMatch[1]) };

  // Water: /water 250 or "water 250"
  const waterMatch = lower.match(/^\/?water\s+(\d+)$/);
  if (waterMatch) return { type: 'water', value: Number(waterMatch[1]) };

  // Gratitude: "gratitude: ..." or "log gratitude: ..."
  const gratMatch = trimmed.match(/^\/?(?:log\s+)?gratitude\s*[:\-]\s*(.+)$/i);
  if (gratMatch) return { type: 'gratitude', text: gratMatch[1] };

  // Win: "win: ..." or "log win: ..."
  const winMatch = trimmed.match(/^\/?(?:log\s+)?win\s*[:\-]\s*(.+)$/i);
  if (winMatch) return { type: 'win', text: winMatch[1] };

  // Tick habit: "tick skincare am" → fuzzy match
  const tickMatch = trimmed.match(/^\/?tick\s+(.+)$/i);
  if (tickMatch) return { type: 'tick', query: tickMatch[1] };

  // Otherwise, default to gratitude if it looks like a free-form sentence
  // and we suspect it's a reply to the evening prompt.
  return { type: 'free-text', text: trimmed };
}

// Fuzzy habit match
function findHabitByQuery(state, query) {
  const q = query.toLowerCase().trim();
  const habits = state.habits || [];
  // Exact or starts-with first
  let h = habits.find(x => x.name.toLowerCase() === q);
  if (h) return h;
  h = habits.find(x => x.name.toLowerCase().startsWith(q));
  if (h) return h;
  // Includes match
  h = habits.find(x => x.name.toLowerCase().includes(q));
  return h || null;
}

// ----- Webhook handler ------------------------------------------------------

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  // Telegram only POSTs
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

      // Always acknowledge the tap immediately so Telegram doesn't show a spinner
      await tg('answerCallbackQuery', { callback_query_id: cq.id });

      if (data.startsWith('habit:')) {
        const hid = data.slice('habit:'.length);
        const result = await handleHabitTick(hid, chatId, messageId);
        if (result && result.done) {
          await tg('sendMessage', { chat_id: chatId, text: '✓ ' + result.habit + ' ticked.' });
        } else if (result) {
          await tg('sendMessage', { chat_id: chatId, text: 'Untiked ' + result.habit + '.' });
        }
        return res.status(200).json({ ok: true });
      }

      if (data.startsWith('mood:')) {
        const m = Number(data.slice('mood:'.length));
        await handleMood(m, chatId);
        const moodEm = ['', '😞', '😐', '🙂', '😊', '🤩'];
        await tg('sendMessage', {
          chat_id: chatId,
          text: 'Mood ' + moodEm[m] + ' logged. How much sleep did you get? Reply with hours like "sleep 7.5"',
          reply_markup: { force_reply: true, input_field_placeholder: 'sleep 7.5' }
        });
        return res.status(200).json({ ok: true });
      }

      if (data.startsWith('water:')) {
        const ml = Number(data.slice('water:'.length));
        if (ml === 0) {
          await handleWaterReset(chatId);
          await tg('sendMessage', { chat_id: chatId, text: 'Water reset for today.' });
        } else {
          const result = await handleWaterAdd(ml, chatId);
          const pct = Math.min(100, Math.round((result.ml / result.targetMl) * 100));
          await tg('sendMessage', {
            chat_id: chatId,
            text: '+' + ml + 'ml. ' + result.ml + 'ml / ' + result.targetMl + 'ml today (' + pct + '%) 💧'
          });
        }
        return res.status(200).json({ ok: true });
      }

      if (data === 'noop') {
        return res.status(200).json({ ok: true });
      }

      return res.status(200).json({ ok: true });
    }

    // ----- Message ----
    if (update.message) {
      const msg = update.message;
      const chatId = msg.chat && msg.chat.id;
      const text = msg.text || '';

      if (expectedChatId && chatId !== expectedChatId) {
        // Ignore — but reply once with chat ID so the owner knows what to set
        await tg('sendMessage', {
          chat_id: chatId,
          text: 'This bot is private. Your chat ID is: ' + chatId + '\nIf you are the owner, set TELEGRAM_CHAT_ID=' + chatId + ' in Vercel.'
        });
        return res.status(200).json({ ok: true });
      }

      const cmd = parseTextCommand(text);
      if (!cmd) return res.status(200).json({ ok: true });

      switch (cmd.type) {
        case 'start':
          await tg('sendMessage', {
            chat_id: chatId,
            text: 'Hey 👋\n\nLife Hub bot is connected. I will check in on:\n• 7am — mood + sleep\n• Throughout the day — habits at their anchor times\n• 11am, 2pm, 5pm, 8pm — water\n• 9pm — bedtime catch-up + gratitude reflection\n• Saturday 2pm — weekly habits\n\nFree-form commands:\n• "gratitude: X" — log a gratitude entry\n• "win: X" — log a win\n• "tick X" — tick a habit by name\n• "mood 4" — quick mood\n• "sleep 7.5" — log sleep\n• "water 250" — add water in ml\n• "/today" — see what is still due'
          });
          return res.status(200).json({ ok: true });

        case 'help':
          await tg('sendMessage', {
            chat_id: chatId,
            text: 'Commands:\n• gratitude: <text>\n• win: <text>\n• tick <habit name>\n• mood 1–5\n• sleep <hours>\n• water <ml>\n• /today'
          });
          return res.status(200).json({ ok: true });

        case 'today': {
          const state = await loadState();
          if (!state) {
            await tg('sendMessage', { chat_id: chatId, text: 'Could not load Life Hub data.' });
            return res.status(200).json({ ok: true });
          }
          const today = localDateKey();
          const dueDaily = (state.habits || []).filter(h => (h.freq || 'daily').toLowerCase() === 'daily' && habitDayStatus(h, today) === 'todo');
          const lines = [];
          lines.push('📋 Today (' + today + ')');
          if (dueDaily.length) {
            lines.push('\nDaily habits to do:');
            dueDaily.forEach(h => lines.push('• ' + h.name));
          } else {
            lines.push('\n✓ All daily habits done');
          }
          const m = (state.mood || {})[today];
          if (!m || !m.mood) lines.push('\n• Mood not logged');
          if (!m || !m.sleep) lines.push('• Sleep not logged');
          await tg('sendMessage', { chat_id: chatId, text: lines.join('\n') });
          return res.status(200).json({ ok: true });
        }

        case 'mood': {
          await handleMood(cmd.value, chatId);
          const moodEm = ['', '😞', '😐', '🙂', '😊', '🤩'];
          await tg('sendMessage', { chat_id: chatId, text: 'Mood ' + moodEm[cmd.value] + ' logged.' });
          return res.status(200).json({ ok: true });
        }

        case 'sleep': {
          await handleSleep(cmd.value, chatId);
          await tg('sendMessage', { chat_id: chatId, text: '💤 ' + cmd.value + 'h sleep logged.' });
          return res.status(200).json({ ok: true });
        }

        case 'water': {
          const result = await handleWaterAdd(cmd.value, chatId);
          const pct = Math.min(100, Math.round((result.ml / result.targetMl) * 100));
          await tg('sendMessage', { chat_id: chatId, text: '+' + cmd.value + 'ml. ' + result.ml + 'ml / ' + result.targetMl + 'ml today (' + pct + '%) 💧' });
          return res.status(200).json({ ok: true });
        }

        case 'gratitude': {
          await handleGratitude(cmd.text, chatId);
          await tg('sendMessage', { chat_id: chatId, text: '🙏 Logged: ' + cmd.text });
          return res.status(200).json({ ok: true });
        }

        case 'win': {
          await handleGratitudeWin(cmd.text, chatId);
          await tg('sendMessage', { chat_id: chatId, text: '🏆 Win logged: ' + cmd.text });
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
            await tg('sendMessage', { chat_id: chatId, text: 'No habit matched "' + cmd.query + '". Try a different name?' });
            return res.status(200).json({ ok: true });
          }
          await handleHabitTick(h.id, chatId, null);
          await tg('sendMessage', { chat_id: chatId, text: '✓ ' + h.name + ' ticked.' });
          return res.status(200).json({ ok: true });
        }

        case 'free-text': {
          // If this message is a reply to one of our prompts, route accordingly.
          // The `force_reply` markup includes the original message — check its content.
          const replyTo = msg.reply_to_message && msg.reply_to_message.text;
          if (replyTo && /sleep/i.test(replyTo)) {
            const num = parseFloat(text);
            if (!isNaN(num)) {
              await handleSleep(num, chatId);
              await tg('sendMessage', { chat_id: chatId, text: '💤 ' + num + 'h sleep logged.' });
              return res.status(200).json({ ok: true });
            }
          }
          if (replyTo && (/gratitude|reflect|grateful/i.test(replyTo))) {
            await handleGratitude(text, chatId);
            await tg('sendMessage', { chat_id: chatId, text: '🙏 Logged: ' + text });
            return res.status(200).json({ ok: true });
          }
          // Default: treat as gratitude if it looks like a sentence (>= 3 words, no special prefix)
          if (text.split(/\s+/).length >= 3) {
            await handleGratitude(text, chatId);
            await tg('sendMessage', { chat_id: chatId, text: '🙏 Logged as gratitude: ' + text + '\n\n(Send "/help" if you wanted a different command.)' });
            return res.status(200).json({ ok: true });
          }
          await tg('sendMessage', { chat_id: chatId, text: 'I did not understand that. Send /help for commands.' });
          return res.status(200).json({ ok: true });
        }

        default:
          return res.status(200).json({ ok: true });
      }
    }

    return res.status(200).json({ ok: true });
  } catch (e) {
    console.error('Webhook error:', e);
    // Still respond 200 — Telegram will retry otherwise
    return res.status(200).json({ ok: true, error: e.message });
  }
};
