const { kv } = require('@vercel/kv');

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();

  const userId = req.query.userId || (req.body && req.body.userId);
  if (!userId) return res.status(400).json({ error: 'Missing userId' });

  if (req.method === 'POST') {
    try {
      const { reminders } = req.body;
      if (!reminders) return res.status(400).json({ error: 'Missing reminders' });
      await kv.set(`reminders:${userId}`, JSON.stringify(reminders));
      return res.status(200).json({ ok: true });
    } catch (e) {
      console.error('Save reminders error:', e);
      return res.status(500).json({ error: 'Server error' });
    }
  }

  if (req.method === 'GET') {
    try {
      const data = await kv.get(`reminders:${userId}`);
      return res.status(200).json({ reminders: data ? JSON.parse(data) : null });
    } catch (e) {
      console.error('Get reminders error:', e);
      return res.status(500).json({ error: 'Server error' });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
};
