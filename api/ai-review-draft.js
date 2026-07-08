// AI monthly review draft — called by the web app's Reviews page.
// ============================================================
// POST with a month summary; returns draft text for each review prompt.
// Uses Claude Sonnet (better reflective writing). Once a month, so cost is low.
const { claude } = require('./telegram/_ai.js');

const SONNET_MODEL = process.env.ANTHROPIC_SONNET_MODEL || 'claude-sonnet-4-5';

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const data = (req.body && req.body.summary) || null;
  if (!data) return res.status(400).json({ error: 'Missing summary' });

  // Build a factual brief from the month's data
  const lines = [];
  lines.push('Month: ' + (data.monthLabel || 'this month'));
  if (data.habitSummary) lines.push('Habits: ' + data.habitSummary);
  if (data.avgMood != null) lines.push('Average mood: ' + data.avgMood + '/5 over ' + (data.moodDays || 0) + ' logged days');
  if (data.avgSleep != null) lines.push('Average sleep: ' + data.avgSleep + 'h');
  if (data.workouts != null) lines.push('Workouts: ' + data.workouts + ' sessions, ' + (data.runKm || 0) + 'km run');
  if (data.tasksDone != null) lines.push('Tasks completed: ' + data.tasksDone);
  if (data.goalsProgress) lines.push('Goals: ' + data.goalsProgress);
  if (data.gratitudeThemes) lines.push('Gratitude entries mentioned: ' + data.gratitudeThemes);
  if (data.financeNote) lines.push('Finance: ' + data.financeNote);
  if (data.weakestHabit) lines.push('Weakest habit: ' + data.weakestHabit);
  if (data.strongestHabit) lines.push('Strongest habit: ' + data.strongestHabit);

  const system = [
    'You are helping someone with ADHD write their monthly review. They struggle with the blank page, so you write a FIRST DRAFT they can edit.',
    'Based only on the data given, write honest, specific, warm draft answers.',
    'Return ONLY valid JSON, no markdown fences, with these keys:',
    '{',
    '  "wins": "2-3 sentences on what went well, specific to the data",',
    '  "lessons": "2-3 sentences on what did not go to plan and why, kind but honest",',
    '  "focus": "one clear theme/focus for next month, drawn from the weakest areas",',
    '  "ssc": "Start: ... Stop: ... Continue: ... (one line each, based on the data)"',
    '}',
    'Write in first person as if they wrote it (\"I\"). British English. Be concrete, reference the actual numbers. Never invent events not in the data.'
  ].join('\n');

  const out = await claude({
    model: SONNET_MODEL,
    maxTokens: 700,
    temperature: 0.7,
    system: system,
    prompt: 'My month\'s data:\n' + lines.join('\n') + '\n\nWrite my review draft as JSON:'
  });

  if (!out) return res.status(200).json({ draft: null });
  let cleaned = out.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  let draft = null;
  try { draft = JSON.parse(cleaned); }
  catch (e) {
    const m = cleaned.match(/\{[\s\S]*\}/);
    if (m) { try { draft = JSON.parse(m[0]); } catch (e2) { /* */ } }
  }
  return res.status(200).json({ draft: draft });
};
