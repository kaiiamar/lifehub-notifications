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

module.exports = { claude, claudeOr, DEFAULT_MODEL };
