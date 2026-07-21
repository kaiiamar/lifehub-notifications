const { Redis } = require('@upstash/redis');
const { assertBodySize, enforceRateLimit, handleCors, requireFirebaseUser } = require('../lib/security.js');

module.exports = async function handler(req, res) {
  if (!handleCors(req, res, ['POST', 'OPTIONS'])) return;
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!assertBodySize(req, res, 12 * 1024)) return;
  const user = await requireFirebaseUser(req, res);
  if (!user) return;
  if (!await enforceRateLimit(res, 'subscribe', user.uid, 10, 60 * 60)) return;

  const subscription = req.body && req.body.subscription;
  const endpoint = subscription && subscription.endpoint;
  const keys = subscription && subscription.keys;
  if (typeof endpoint !== 'string' || endpoint.length > 2048 || !endpoint.startsWith('https://')) {
    return res.status(400).json({ error: 'Invalid push subscription endpoint' });
  }
  if (!keys || typeof keys.p256dh !== 'string' || typeof keys.auth !== 'string' ||
      keys.p256dh.length > 256 || keys.auth.length > 256) {
    return res.status(400).json({ error: 'Invalid push subscription keys' });
  }

  try {
    const redis = new Redis({ url: process.env.KV_REST_API_URL, token: process.env.KV_REST_API_TOKEN });
    await redis.set('sub:' + user.uid, JSON.stringify({ endpoint: endpoint, keys: keys }));
    return res.status(200).json({ ok: true });
  } catch (error) {
    console.error('Subscribe error:', error.message);
    return res.status(500).json({ error: 'Server error' });
  }
};