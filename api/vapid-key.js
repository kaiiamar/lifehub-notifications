const { handleCors } = require('../lib/security.js');

module.exports = async function handler(req, res) {
  if (!handleCors(req, res, ['GET', 'OPTIONS'])) return;
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  if (!process.env.VAPID_PUBLIC_KEY) {
    return res.status(503).json({ error: 'Push notifications are not configured' });
  }
  return res.status(200).json({ publicKey: process.env.VAPID_PUBLIC_KEY });
};