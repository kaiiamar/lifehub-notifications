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

  // ── Mode: task/goal breakdown ──────────────────────────────────────────
  // POST { breakdown: { title, kind } } → { steps: [ ...micro-steps ] }.
  // Kept on this endpoint (rather than a new serverless function) to stay
  // within the Vercel Hobby 12-function cap.
  const bd = req.body && req.body.breakdown;
  if (bd && bd.title) {
    const kind = bd.kind === 'goal' ? 'goal' : 'task';
    const bdSystem = [
      'You help someone with ADHD beat activation energy by breaking a', kind,
      'into the smallest sensible next steps.',
      'Return 3 to 5 concrete micro-steps, each a single physical action that could be started in under two minutes.',
      'Each step MUST start with a verb, be under 8 words, and be specific (not "plan" or "think about").',
      'Order them so the very first step is almost frictionless.',
      'Return ONLY the steps, one per line, no numbering, no bullets, no preamble. British English.'
    ].join(' ');
    const bdOut = await claude({
      maxTokens: 200,
      temperature: 0.5,
      system: bdSystem,
      prompt: (kind === 'goal' ? 'Goal' : 'Task') + ': "' + String(bd.title).slice(0, 200) + '"\n\nThe micro-steps:'
    });
    if (!bdOut) return res.status(200).json({ steps: null });
    const steps = bdOut.split('\n')
      .map(function (s) { return s.replace(/^\s*(?:\d+[.)]|[-*•])\s*/, '').trim(); })
      .filter(function (s) { return s.length > 0; })
      .slice(0, 5);
    return res.status(200).json({ steps: steps });
  }

  // ── Mode: evening sweep one-liner ──────────────────────────────────────
  // POST { sweep: { habitsDone, habitsTotal, training, waterPct, focusDone,
  //        focusTotal, showingUp } } → { sweep: "<one sentence>" }.
  const sw = req.body && req.body.sweep;
  if (sw) {
    const parts = [];
    if (sw.habitsTotal != null) parts.push(sw.habitsDone + '/' + sw.habitsTotal + ' habits');
    if (sw.training) parts.push(String(sw.training));
    if (sw.waterPct != null) parts.push('water ' + sw.waterPct + '%');
    if (sw.focusTotal) parts.push(sw.focusDone + '/' + sw.focusTotal + ' focus tasks');
    if (sw.showingUp) parts.push(sw.showingUp + ' days showing up');
    if (!parts.length) return res.status(200).json({ sweep: null });
    const swSystem = [
      'You are a calm, grounded coach inside a wellbeing app for someone with ADHD.',
      'Write ONE short sentence (max 20 words) reflecting how today went, using only the facts given.',
      'Matter-of-fact and kind, like a steady coach — never cheerful hype.',
      'NEVER use guilt: no "you missed / failed / behind / should have". Frame any low number neutrally as information.',
      'No greeting, no emoji, no markdown, no sign-off. British English.'
    ].join(' ');
    const swOut = await claude({
      maxTokens: 60,
      temperature: 0.6,
      system: swSystem,
      prompt: 'Today: ' + parts.join(', ') + '.\n\nThe one-sentence reflection:'
    });
    if (!swOut) return res.status(200).json({ sweep: null });
    return res.status(200).json({ sweep: swOut.trim() });
  }

  // ── Mode: replan the training week ─────────────────────────────────────
  // POST { replan: { today, remainingDays:[...], sessions:[{key,desc}] } }
  // → { replan: { easy, quality, long, note } } with full weekday names.
  const rp = req.body && req.body.replan;
  if (rp) {
    const rpSystem = [
      'You are a running coach reshuffling the remaining runs of a half-marathon training week.',
      'Assign each run listed to one of the remaining weekdays provided.',
      'Rules: never place the quality session and the long run on consecutive days; the long run is the last hard session of the week; leave at least one easy or rest day before the long run; never schedule two hard runs back to back.',
      'Return ONLY compact JSON with full weekday names, e.g. {"easy":"Monday","quality":"Thursday","long":"Saturday","note":"one short sentence"}.',
      'Only use days from the remaining list. Omit a run key if it is not in the list to place. British English, no markdown, no preamble.'
    ].join(' ');
    const rpPrompt = 'Today is ' + (rp.today || '') + '. Remaining days this week: ' + ((rp.remainingDays || []).join(', ')) + '.\n'
      + 'Runs to place: ' + ((rp.sessions || []).map(function (s) { return s.key + ' (' + (s.desc || s.label || '') + ')'; }).join('; ')) + '.\n\nThe JSON:';
    const rpOut = await claude({ maxTokens: 160, temperature: 0.4, system: rpSystem, prompt: rpPrompt });
    if (!rpOut) return res.status(200).json({ replan: null });
    let parsed = null;
    try { const m = rpOut.match(/\{[\s\S]*\}/); if (m) parsed = JSON.parse(m[0]); } catch (e) { parsed = null; }
    return res.status(200).json({ replan: parsed });
  }

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
