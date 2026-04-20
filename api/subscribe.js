const { kv } = require('@vercel/kv');

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { subscription, userId } = req.body;
    if (!subscription || !userId) return res.status(400).json({ error: 'Missing subscription or userId' });

    // Store subscription keyed by userId
    await kv.set(`sub:${userId}`, JSON.stringify(subscription));
    res.status(200).json({ ok: true });
  } catch (e) {
    console.error('Subscribe error:', e);
    res.status(500).json({ error: 'Server error' });
  }
};
