// AI narrative endpoint — called by the web app's Insights page.
// ============================================================
// POST with a compact stats summary; returns a short 2-3 sentence narrative.
// Uses Claude Haiku. CORS-open so the static site can call it.
const { claude } = require('./telegram/_ai.js');

module.exports = async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const stats = (req.body && req.body.stats) || null;
  if (!stats) return res.status(400).json({ error: 'Missing stats' });

  // Build a compact, factual prompt from the stats the client computed
  const lines = [];
  if (stats.habitsThisWeek != null) lines.push('Habits completed this week: ' + stats.habitsThisWeek + '% (last week ' + (stats.habitsLastWeek != null ? stats.habitsLastWeek + '%' : 'n/a') + ')');
  if (stats.sessionsThisWeek != null) lines.push('Workout sessions this week: ' + stats.sessionsThisWeek + ' (last week ' + (stats.sessionsLastWeek != null ? stats.sessionsLastWeek : 'n/a') + ')');
  if (stats.avgMoodThisWeek != null) lines.push('Average mood this week: ' + stats.avgMoodThisWeek + '/5 (last week ' + (stats.avgMoodLastWeek != null ? stats.avgMoodLastWeek + '/5' : 'n/a') + ')');
  if (stats.avgSleepThisWeek != null) lines.push('Average sleep this week: ' + stats.avgSleepThisWeek + 'h (last week ' + (stats.avgSleepLastWeek != null ? stats.avgSleepLastWeek + 'h' : 'n/a') + ')');
  if (stats.tasksDoneThisWeek != null) lines.push('Tasks completed this week: ' + stats.tasksDoneThisWeek);
  if (stats.topMoodFactor) lines.push('Mood is highest on: ' + stats.topMoodFactor);
  if (stats.upcomingEvent) lines.push('Upcoming: ' + stats.upcomingEvent);

  const system = [
    'You are a sharp, warm personal-data analyst inside a wellbeing app for someone with ADHD working on productivity and goals.',
    'Write 2-3 short sentences (max 55 words total) summarising their week as a "story".',
    'Be specific to the numbers. Connect threads where you see them (e.g. mood and sleep, or habits and workouts).',
    'Encouraging but honest — if something slipped, name it kindly and point gently forward.',
    'No greeting, no sign-off, no markdown, no emojis. British English. Address them as "you".'
  ].join(' ');

  const out = await claude({
    maxTokens: 160,
    temperature: 0.7,
    system: system,
    prompt: 'This week\'s data:\n' + lines.join('\n') + '\n\nWrite the 2-3 sentence story:'
  });

  if (!out) return res.status(200).json({ narrative: null });
  return res.status(200).json({ narrative: out });
};
