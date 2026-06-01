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
const { claudeOr } = require('./_ai.js');

// ----- AI reply helpers ----------------------------------------------------
// Warm, brief acknowledgements for gratitude/wins. Falls back to canned pools
// if the API is unavailable or slow. Kept to one or two sentences.
async function aiGratitudeReply(entryText, fallback) {
  const out = await claudeOr(null, {
    maxTokens: 80,
    temperature: 0.8,
    system: 'You are a warm, grounded companion inside a personal wellbeing app. The user just logged something they are grateful for. Reply in ONE short sentence (max 20 words) — genuine, never saccharine, never starting with "That\'s". No emojis unless it truly fits. British English.',
    prompt: 'They are grateful for: "' + entryText + '"\n\nYour one-sentence reply:'
  });
  return out ? '🙏 ' + out : fallback;
}
async function aiWinReply(entryText, fallback) {
  const out = await claudeOr(null, {
    maxTokens: 80,
    temperature: 0.8,
    system: 'You are a warm, encouraging companion inside a personal wellbeing app. The user just logged a win. Celebrate it in ONE short sentence (max 20 words) — genuine and specific to what they said, not generic hype. British English.',
    prompt: 'Their win: "' + entryText + '"\n\nYour one-sentence reply:'
  });
  return out ? '🏆 ' + out : fallback;
}

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

// Natural-language date parser — same logic as the web app's parseNaturalDate
function parseNaturalDate(input) {
  if (!input) return null;
  const s = input.trim().toLowerCase();
  const now = new Date(); now.setHours(12, 0, 0, 0);
  const dayMs = 86400000;

  if (s === 'today' || s === 'tonight') return localDateKey(now);
  if (s === 'tomorrow') return localDateKey(new Date(now.getTime() + dayMs));
  if (s === 'yesterday') return localDateKey(new Date(now.getTime() - dayMs));

  const dayNames = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'];
  const dayMatch = s.match(/^(?:next\s+|this\s+)?(\w+)$/);
  if (dayMatch) {
    const idx = dayNames.indexOf(dayMatch[1]);
    if (idx > -1) {
      let diff = idx - now.getDay();
      if (s.startsWith('next ')) {
        if (diff <= 0) diff += 7;
        else diff += 7;
      } else {
        if (diff <= 0) diff += 7;
      }
      return localDateKey(new Date(now.getTime() + diff * dayMs));
    }
  }

  const inMatch = s.match(/^in\s+(\d+)\s+(day|days|week|weeks)$/);
  if (inMatch) {
    const n = Number(inMatch[1]);
    const unit = inMatch[2].startsWith('week') ? 7 : 1;
    return localDateKey(new Date(now.getTime() + n * unit * dayMs));
  }

  const monthNames = ['january','february','march','april','may','june','july','august','september','october','november','december'];
  const monthShorts = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];
  function findMonth(str) {
    const i = monthNames.indexOf(str);
    if (i > -1) return i;
    return monthShorts.indexOf(str.slice(0, 3));
  }
  const dmMatch = s.match(/^(\d{1,2})(?:st|nd|rd|th)?\s+(\w+)$/);
  if (dmMatch) {
    const m = findMonth(dmMatch[2]);
    if (m > -1) {
      const dd = Number(dmMatch[1]);
      const dt = new Date(now.getFullYear(), m, dd, 12, 0, 0);
      if (dt < now) dt.setFullYear(now.getFullYear() + 1);
      return localDateKey(dt);
    }
  }
  const mdMatch = s.match(/^(\w+)\s+(\d{1,2})(?:st|nd|rd|th)?$/);
  if (mdMatch) {
    const m = findMonth(mdMatch[1]);
    if (m > -1) {
      const dd = Number(mdMatch[2]);
      const dt = new Date(now.getFullYear(), m, dd, 12, 0, 0);
      if (dt < now) dt.setFullYear(now.getFullYear() + 1);
      return localDateKey(dt);
    }
  }

  const slashMatch = s.match(/^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?$/);
  if (slashMatch) {
    const d = Number(slashMatch[1]);
    const m = Number(slashMatch[2]) - 1;
    let y = slashMatch[3] ? Number(slashMatch[3]) : now.getFullYear();
    if (y < 100) y += 2000;
    const dt = new Date(y, m, d, 12, 0, 0);
    if (dt < now && !slashMatch[3]) dt.setFullYear(y + 1);
    return localDateKey(dt);
  }

  if (s === 'this week') {
    const e = new Date(now); e.setDate(e.getDate() + (6 - e.getDay()));
    return localDateKey(e);
  }
  if (s === 'next week') {
    const start = new Date(now); start.setDate(start.getDate() + (7 - start.getDay()));
    const end = new Date(start); end.setDate(end.getDate() + 6);
    return localDateKey(end);
  }

  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;

  return null;
}

// Parse "do X by friday" → {text, dueDate}
function parseTaskInput(raw) {
  const byMatch = raw.match(/^(.+?)\s+by\s+(.+)$/i);
  if (byMatch) {
    const d = parseNaturalDate(byMatch[2]);
    if (d) return { text: byMatch[1].trim(), dueDate: d };
  }
  const onMatch = raw.match(/^(.+?)\s+on\s+(.+)$/i);
  if (onMatch) {
    const d = parseNaturalDate(onMatch[2]);
    if (d) return { text: onMatch[1].trim(), dueDate: d };
  }
  return { text: raw.trim(), dueDate: null };
}

// Week start key (matching the web app's weekKey — Sunday-anchored)
function weekStartKey(d) {
  const date = d || new Date();
  const ws = new Date(date);
  ws.setHours(0, 0, 0, 0);
  ws.setDate(ws.getDate() - ws.getDay());
  return localDateKey(ws);
}

function fmtDueRel(dateKey) {
  if (!dateKey) return '';
  const today = new Date(localDateKey() + 'T12:00:00');
  const d = new Date(dateKey + 'T12:00:00');
  const diff = Math.round((d - today) / 86400000);
  if (diff === 0) return 'today';
  if (diff === 1) return 'tomorrow';
  if (diff === -1) return 'yesterday';
  if (diff > 1 && diff <= 6) return 'in ' + diff + 'd';
  if (diff < -1 && diff >= -6) return Math.abs(diff) + 'd ago';
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

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

// ----- Task handlers -------------------------------------------------------
async function handleTaskAdd(rawText) {
  const state = await loadState();
  if (!state) return null;
  if (!state.tasks) state.tasks = [];
  const parsed = parseTaskInput(rawText);
  const task = {
    id: genId(),
    text: parsed.text,
    done: false,
    dueDate: parsed.dueDate || null,
    doneAt: null,
    createdAt: localDateKey()
  };
  state.tasks.push(task);
  await saveState(state);
  return task;
}

async function handleTaskTick(taskId) {
  const state = await loadState();
  if (!state) return null;
  const t = (state.tasks || []).find(x => x.id === taskId);
  if (!t) return null;
  const wasDone = !!t.done;
  t.done = !wasDone;
  t.doneAt = t.done ? localDateKey() : null;
  await saveState(state);
  return { task: t, done: !wasDone };
}

async function handleTaskStar(taskId) {
  const state = await loadState();
  if (!state) return null;
  const t = (state.tasks || []).find(x => x.id === taskId);
  if (!t) return null;
  const wkKey = weekStartKey();
  if (t.weekPriority === wkKey) delete t.weekPriority;
  else t.weekPriority = wkKey;
  await saveState(state);
  return t;
}

function findTaskByQuery(state, query) {
  const q = query.toLowerCase().trim();
  const tasks = (state.tasks || []).filter(t => !t.done);
  let t = tasks.find(x => x.text.toLowerCase() === q);
  if (t) return t;
  t = tasks.find(x => x.text.toLowerCase().startsWith(q));
  if (t) return t;
  t = tasks.find(x => x.text.toLowerCase().includes(q));
  return t || null;
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

// Render task buttons — one per task, with star toggle inline
function taskButtons(tasks) {
  const wkKey = weekStartKey();
  return tasks.map(t => {
    const isPri = t.weekPriority === wkKey;
    const due = t.dueDate ? ' · ' + fmtDueRel(t.dueDate) : '';
    return [{
      text: (t.done ? '✓ ' : '◯ ') + (isPri ? '⭐ ' : '') + t.text + due,
      callback_data: 'task:' + t.id
    }];
  });
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
  // Tasks
  if (lower === '/tasks' || lower === 'tasks') return { type: 'tasks-list' };
  if (lower === '/task' || lower === 'task') return { type: 'task-prompt' };
  if (lower === '/priorities' || lower === 'priorities') return { type: 'priorities-list' };

  // /task <text> — direct add with optional date parsing
  const taskAddMatch = trimmed.match(/^\/?task\s+(.+)$/i);
  if (taskAddMatch) return { type: 'task-add', text: taskAddMatch[1] };

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

  const starMatch = trimmed.match(/^\/?star\s+(.+)$/i);
  if (starMatch) return { type: 'star', query: starMatch[1] };

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

      // ---- Task tick ----
      if (data.startsWith('task:')) {
        const tid = data.slice('task:'.length);
        const result = await handleTaskTick(tid);
        if (result) {
          // Re-render the parent message if it was a task list
          const originalText = cq.message && cq.message.text || '';
          if (originalText.includes('tasks') || originalText.includes('priorities') || originalText.includes('Coming up')) {
            await refreshTasksMessage(chatId, messageId, originalText);
          }
          await tg('sendMessage', {
            chat_id: chatId,
            text: result.done ? '✓ ' + result.task.text + ' done.' : 'Untiked ' + result.task.text + '.'
          });
        }
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
            text: 'Hey ' + timeGreeting() + ' — Life Hub bot here.\n\nI\'ll check in throughout the day:\n☀️ 7am — mood + sleep + your tasks for the day\n📋 9am, 1pm, 7pm — habits at their times\n💧 11am, 2pm, 5pm, 8pm — water nudges\n🌙 9pm — bedtime catch-up + reflection\n📅 Saturday 2pm — weekly habit check\n\nTask commands:\n• /tasks — see your list with tick buttons\n• /task — I\'ll ask, you reply (date parsing: "X by friday")\n• /priorities — see this week\'s starred priorities\n• /star <task> — pin a task as priority for this week\n\nLogging:\n• /gratitude · /win — I\'ll ask, you reply\n• /water · /mood — quick buttons\n• /sleep — log hours\n• tick <habit name>\n\nLet\'s keep it light. ✨'
          });
          return res.status(200).json({ ok: true });

        case 'help':
          await tg('sendMessage', {
            chat_id: chatId,
            text: 'What I respond to:\n\nTasks:\n• /tasks — see all open tasks\n• /task — I\'ll ask\n• /task <text> — direct add\n• /task <text> by <date> — with due date\n• /priorities — this week\'s priorities\n• /star <task> — toggle priority\n\nLogging:\n• /gratitude · /win — I\'ll ask\n• /water · /mood — buttons\n• /sleep — log hours\n• /today — daily habits with ticks\n• tick <habit name>\n\nDate phrases I understand:\n• today, tomorrow, tonight\n• monday, friday, next monday\n• 5 dec, december 5, 5/12\n• in 3 days, in 2 weeks\n• this week, next week'
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
          var gFallback = fmtReply(pick(REPLIES.gratitudeLogged), { x: cmd.text });
          await tg('sendMessage', { chat_id: chatId, text: await aiGratitudeReply(cmd.text, gFallback) });
          return res.status(200).json({ ok: true });
        }

        case 'win': {
          await handleGratitudeWin(cmd.text);
          var wFallback = fmtReply(pick(REPLIES.winLogged), { x: cmd.text });
          await tg('sendMessage', { chat_id: chatId, text: await aiWinReply(cmd.text, wFallback) });
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

        case 'tasks-list': {
          const state = await loadState();
          if (!state) {
            await tg('sendMessage', { chat_id: chatId, text: 'Could not load Life Hub data.' });
            return res.status(200).json({ ok: true });
          }
          await sendTasksBoard(chatId, state);
          return res.status(200).json({ ok: true });
        }

        case 'priorities-list': {
          const state = await loadState();
          if (!state) {
            await tg('sendMessage', { chat_id: chatId, text: 'Could not load Life Hub data.' });
            return res.status(200).json({ ok: true });
          }
          const wkKey = weekStartKey();
          const pris = (state.tasks || []).filter(t => t.weekPriority === wkKey);
          if (!pris.length) {
            await tg('sendMessage', {
              chat_id: chatId,
              text: '⭐ No priorities set for this week yet. Star a task with /star <name> or in the app to add it here.'
            });
          } else {
            const done = pris.filter(t => t.done).length;
            await tg('sendMessage', {
              chat_id: chatId,
              text: '⭐ This week\'s priorities (' + done + '/' + pris.length + '):',
              reply_markup: { inline_keyboard: taskButtons(pris) }
            });
          }
          return res.status(200).json({ ok: true });
        }

        case 'task-prompt':
          await tg('sendMessage', {
            chat_id: chatId,
            text: '📝 What\'s the task? You can add a date too — like "book flights by friday" or "pay bill on 5 dec"',
            reply_markup: { force_reply: true, input_field_placeholder: 'task or "task by date"' }
          });
          return res.status(200).json({ ok: true });

        case 'task-add': {
          const task = await handleTaskAdd(cmd.text);
          if (!task) {
            await tg('sendMessage', { chat_id: chatId, text: 'Could not save that.' });
            return res.status(200).json({ ok: true });
          }
          const dueText = task.dueDate ? ' · due ' + fmtDueRel(task.dueDate) : ' · no due date';
          await tg('sendMessage', { chat_id: chatId, text: '✓ Added: ' + task.text + dueText });
          return res.status(200).json({ ok: true });
        }

        case 'star': {
          const state = await loadState();
          if (!state) {
            await tg('sendMessage', { chat_id: chatId, text: 'Could not load Life Hub data.' });
            return res.status(200).json({ ok: true });
          }
          const t = findTaskByQuery(state, cmd.query);
          if (!t) {
            await tg('sendMessage', { chat_id: chatId, text: 'No task matched "' + cmd.query + '".' });
            return res.status(200).json({ ok: true });
          }
          const updated = await handleTaskStar(t.id);
          const wkKey = weekStartKey();
          const isOn = updated.weekPriority === wkKey;
          await tg('sendMessage', {
            chat_id: chatId,
            text: isOn ? '⭐ "' + t.text + '" added to this week\'s priorities.' : '☆ "' + t.text + '" removed from priorities.'
          });
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
            var grFb = fmtReply(pick(REPLIES.gratitudeLogged), { x: text });
            await tg('sendMessage', { chat_id: chatId, text: await aiGratitudeReply(text, grFb) });
            return res.status(200).json({ ok: true });
          }
          if (replyTo && /win/i.test(replyTo)) {
            await handleGratitudeWin(text);
            var wnFb = fmtReply(pick(REPLIES.winLogged), { x: text });
            await tg('sendMessage', { chat_id: chatId, text: await aiWinReply(text, wnFb) });
            return res.status(200).json({ ok: true });
          }
          if (replyTo && /what.*task|book flights|task or/i.test(replyTo)) {
            const task = await handleTaskAdd(text);
            const dueText = task && task.dueDate ? ' · due ' + fmtDueRel(task.dueDate) : ' · no due date';
            await tg('sendMessage', { chat_id: chatId, text: '✓ Added: ' + (task ? task.text : text) + dueText });
            return res.status(200).json({ ok: true });
          }
          // Default — treat as gratitude if it's a sentence
          if (text.split(/\s+/).length >= 3) {
            await handleGratitude(text);
            var defFb = fmtReply(pick(REPLIES.gratitudeLogged), { x: text });
            var defReply = await aiGratitudeReply(text, defFb);
            await tg('sendMessage', { chat_id: chatId, text: defReply + '\n\n(Send /help if you wanted a different command.)' });
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

// ----- Tasks board ---------------------------------------------------------
async function sendTasksBoard(chatId, state) {
  const todayKey = localDateKey();
  const wkKey = weekStartKey();
  const wkEnd = new Date(); wkEnd.setDate(wkEnd.getDate() + 6);
  const wkEndKey = localDateKey(wkEnd);

  const open = (state.tasks || []).filter(t => !t.done);
  const priorities = open.filter(t => t.weekPriority === wkKey);
  const nonPri = open.filter(t => t.weekPriority !== wkKey);
  const overdue = nonPri.filter(t => t.dueDate && t.dueDate < todayKey);
  const today = nonPri.filter(t => !t.dueDate || t.dueDate === todayKey);
  const upcoming = nonPri.filter(t => t.dueDate && t.dueDate > todayKey && t.dueDate <= wkEndKey);

  const lines = [];
  lines.push('📋 Your tasks');

  let buttons = [];
  if (priorities.length) {
    lines.push('\n⭐ This week\'s priorities (' + priorities.filter(t => t.done).length + '/' + priorities.length + ')');
    buttons = buttons.concat(taskButtons(priorities));
  }
  if (overdue.length) {
    lines.push('\n⚠️ Overdue (' + overdue.length + ')');
    buttons = buttons.concat(taskButtons(overdue));
  }
  if (today.length) {
    lines.push('\n📌 Today + no date (' + today.length + ')');
    buttons = buttons.concat(taskButtons(today));
  }
  if (upcoming.length) {
    lines.push('\n📅 Coming up (' + upcoming.length + ')');
    buttons = buttons.concat(taskButtons(upcoming));
  }
  if (!open.length) {
    lines.push('\nAll clear ✓ Add one with /task');
  }

  await tg('sendMessage', {
    chat_id: chatId,
    text: lines.join('\n'),
    reply_markup: buttons.length ? { inline_keyboard: buttons } : undefined
  });
}

async function refreshTasksMessage(chatId, messageId, originalText) {
  const state = await loadState();
  if (!state) return;
  // Re-derive what kind of board this was — for simplicity, re-render everything
  // for /tasks; for /priorities show only priorities.
  const wkKey = weekStartKey();
  const todayKey = localDateKey();
  const wkEnd = new Date(); wkEnd.setDate(wkEnd.getDate() + 6);
  const wkEndKey = localDateKey(wkEnd);
  const open = (state.tasks || []).filter(t => !t.done);

  let allButtons = [];
  let lines = [];

  if (originalText.includes('priorities (')) {
    const pris = (state.tasks || []).filter(t => t.weekPriority === wkKey);
    const done = pris.filter(t => t.done).length;
    lines.push('⭐ This week\'s priorities (' + done + '/' + pris.length + '):');
    allButtons = taskButtons(pris);
  } else {
    const priorities = open.filter(t => t.weekPriority === wkKey);
    const nonPri = open.filter(t => t.weekPriority !== wkKey);
    const overdue = nonPri.filter(t => t.dueDate && t.dueDate < todayKey);
    const today = nonPri.filter(t => !t.dueDate || t.dueDate === todayKey);
    const upcoming = nonPri.filter(t => t.dueDate && t.dueDate > todayKey && t.dueDate <= wkEndKey);
    lines.push('📋 Your tasks');
    if (priorities.length) {
      lines.push('\n⭐ This week\'s priorities (' + priorities.filter(t => t.done).length + '/' + priorities.length + ')');
      allButtons = allButtons.concat(taskButtons(priorities));
    }
    if (overdue.length) {
      lines.push('\n⚠️ Overdue (' + overdue.length + ')');
      allButtons = allButtons.concat(taskButtons(overdue));
    }
    if (today.length) {
      lines.push('\n📌 Today + no date (' + today.length + ')');
      allButtons = allButtons.concat(taskButtons(today));
    }
    if (upcoming.length) {
      lines.push('\n📅 Coming up (' + upcoming.length + ')');
      allButtons = allButtons.concat(taskButtons(upcoming));
    }
    if (!open.length) lines.push('\nAll clear ✓ Add one with /task');
  }

  try {
    await tg('editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text: lines.join('\n'),
      reply_markup: allButtons.length ? { inline_keyboard: allButtons } : { inline_keyboard: [] }
    });
  } catch (e) { /* ignore */ }
}
