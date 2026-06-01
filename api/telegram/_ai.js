// Anthropic (Claude) helper for the Life Hub bot.
// ============================================================
// Thin wrapper around the Messages API. Designed to FAIL GRACEFULLY:
// every caller passes a fallback, and if the API errors, is slow, or the
// key is missing, we return the fallback instead of breaking the bot.
//
// Model is configurable via env var ANTHROPIC_MODEL (defaults to Haiku).

const DEFAULT_MODEL = process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5';
const API_URL = 'https://api.anthropic.com/v1/messages';
const TIMEOUT_MS = Number(process.env.ANTHROPIC_TIMEOUT_MS || 6000);

// Core call. Returns the text string, or null on any failure.
async function claude(opts) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return null;

  const body = {
    model: opts.model || DEFAULT_MODEL,
    max_tokens: opts.maxTokens || 200,
    messages: [{ role: 'user', content: opts.prompt }]
  };
  if (opts.system) body.system = opts.system;
  if (typeof opts.temperature === 'number') body.temperature = opts.temperature;

  // Abort if it takes too long — the bot should never hang on AI
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const res = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify(body),
      signal: controller.signal
    });
    clearTimeout(timer);
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      console.error('Anthropic API error', res.status, errText.slice(0, 300));
      return null;
    }
    const json = await res.json();
    // Response shape: { content: [{ type:'text', text:'...' }], ... }
    if (json && Array.isArray(json.content)) {
      const textPart = json.content.find(c => c.type === 'text');
      if (textPart && textPart.text) return textPart.text.trim();
    }
    return null;
  } catch (e) {
    clearTimeout(timer);
    if (e.name === 'AbortError') console.error('Anthropic call timed out');
    else console.error('Anthropic call failed:', e.message);
    return null;
  }
}

// Convenience: get a reply or fall back. Always resolves to a string.
async function claudeOr(fallback, opts) {
  const out = await claude(opts);
  return (out && out.length) ? out : fallback;
}

// Parse a free-text brain-dump into structured log actions.
// Returns an object (possibly empty) or null on failure.
// Schema:
//   { sleep?:number, mood?:1-5, water?:number(ml),
//     habits?:[string], gratitude?:string, wins?:string,
//     workouts?:[{kind:'gym'|'run', type?, distance?, time?, note?}],
//     tasks?:[{text, due?}] }
async function parseLifeLog(text, context) {
  const habitNames = (context && context.habitNames) || [];
  const system = [
    'You extract structured log data from a casual message someone sends to their personal wellbeing tracker.',
    'Return ONLY valid JSON, no prose, no markdown fences.',
    'Schema (include only keys the message actually mentions):',
    '{',
    '  "sleep": number (hours, e.g. 6.5),',
    '  "mood": integer 1-5 (1 awful, 3 ok, 5 great),',
    '  "water": number (millilitres to add, e.g. 500),',
    '  "habits": [strings that loosely match the user\'s habit names],',
    '  "workouts": [{"kind":"gym"|"run","type":string,"distance":number(km),"time":string,"note":string}],',
    '  "tasks": [{"text":string,"due":string(natural language like "friday" or "5 dec" or null)}],',
    '  "gratitude": string,',
    '  "wins": string',
    '}',
    'The user\'s habit names are: ' + (habitNames.length ? habitNames.join(', ') : '(none)') + '.',
    'For "habits", only include names that clearly map to one of those. Match loosely (e.g. "went for a run" → "Run once a week" if present).',
    'A run mentioned with distance goes in "workouts" as kind:run AND can also tick a running habit.',
    'Mood words: "great/amazing"=5, "good"=4, "ok/fine"=3, "meh/tired"=2, "awful/terrible"=1.',
    'If the message is purely reflective/grateful with no metrics, put it in "gratitude".',
    'If nothing is extractable, return {}.'
  ].join('\n');

  const out = await claude({
    maxTokens: 400,
    temperature: 0,
    system: system,
    prompt: 'Message: "' + text + '"\n\nJSON:'
  });
  if (!out) return null;
  // Strip any accidental fences
  let cleaned = out.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  try {
    return JSON.parse(cleaned);
  } catch (e) {
    // Try to find the first {...} block
    const m = cleaned.match(/\{[\s\S]*\}/);
    if (m) { try { return JSON.parse(m[0]); } catch (e2) { return null; } }
    return null;
  }
}

module.exports = { claude, claudeOr, parseLifeLog, DEFAULT_MODEL };
