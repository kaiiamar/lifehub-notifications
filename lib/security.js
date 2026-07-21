const crypto = require('crypto');
const { Redis } = require('@upstash/redis');
const { getFirebaseApp } = require('../api/telegram/_helpers.js');

let redis = null;

function fail(res, status, error) {
  res.status(status).json({ error: error });
  return null;
}

function safeEqual(actual, expected) {
  if (typeof actual !== 'string' || typeof expected !== 'string') return false;
  const left = Buffer.from(actual);
  const right = Buffer.from(expected);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function bearerToken(req) {
  const header = String((req.headers && req.headers.authorization) || '');
  return header.startsWith('Bearer ') ? header.slice(7) : '';
}

function handleCors(req, res, methods) {
  const configured = String(process.env.APP_ORIGIN || '');
  const allowed = configured.split(',').map(function (value) { return value.trim(); }).filter(Boolean);
  const origin = String((req.headers && req.headers.origin) || '');
  res.setHeader('Vary', 'Origin');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Access-Control-Allow-Methods', methods.join(','));
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');

  if (origin) {
    if (!allowed.length) return fail(res, 503, 'APP_ORIGIN is not configured');
    if (allowed.indexOf(origin) === -1) return fail(res, 403, 'Origin not allowed');
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return false;
  }
  return true;
}

function assertBodySize(req, res, maxBytes) {
  let size = 0;
  try { size = Buffer.byteLength(JSON.stringify(req.body || {}), 'utf8'); }
  catch (error) { return fail(res, 400, 'Invalid JSON body'); }
  if (size > maxBytes) return fail(res, 413, 'Request body too large');
  return true;
}
async function requireFirebaseUser(req, res) {
  const expectedUid = process.env.LIFEHUB_FIREBASE_UID;
  if (!expectedUid) return fail(res, 503, 'LIFEHUB_FIREBASE_UID is not configured');
  const token = bearerToken(req);
  if (!token) return fail(res, 401, 'Authentication required');
  try {
    const decoded = await getFirebaseApp().auth().verifyIdToken(token);
    if (!safeEqual(decoded.uid, expectedUid)) return fail(res, 403, 'Forbidden');
    return decoded;
  } catch (error) {
    return fail(res, 401, 'Invalid or expired token');
  }
}

function requireServiceBearer(req, res, envName) {
  const expected = process.env[envName];
  if (!expected) return fail(res, 503, envName + ' is not configured');
  if (!safeEqual(bearerToken(req), expected)) return fail(res, 401, 'Unauthorized');
  return true;
}

function requireTelegramWebhook(req, res) {
  const expected = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (!expected) return fail(res, 503, 'TELEGRAM_WEBHOOK_SECRET is not configured');
  const actual = String((req.headers && req.headers['x-telegram-bot-api-secret-token']) || '');
  if (!safeEqual(actual, expected)) return fail(res, 401, 'Unauthorized');
  return true;
}

async function enforceRateLimit(res, scope, subject, limit, windowSeconds) {
  if (!process.env.KV_REST_API_URL || !process.env.KV_REST_API_TOKEN) {
    return fail(res, 503, 'Rate limiting is not configured');
  }
  if (!redis) redis = new Redis({ url: process.env.KV_REST_API_URL, token: process.env.KV_REST_API_TOKEN });
  const bucket = Math.floor(Date.now() / (windowSeconds * 1000));
  const key = 'rate:' + scope + ':' + subject + ':' + bucket;
  try {
    const count = await redis.incr(key);
    if (count === 1) await redis.expire(key, windowSeconds + 5);
    res.setHeader('X-RateLimit-Limit', String(limit));
    res.setHeader('X-RateLimit-Remaining', String(Math.max(0, limit - count)));
    if (count > limit) return fail(res, 429, 'Too many requests');
    return true;
  } catch (error) {
    console.error('Rate limit failed:', error.message);
    return fail(res, 503, 'Rate limiting unavailable');
  }
}

module.exports = {
  assertBodySize,
  enforceRateLimit,
  handleCors,
  requireFirebaseUser,
  requireServiceBearer,
  requireTelegramWebhook
};