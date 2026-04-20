module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  res.status(200).json({ publicKey: process.env.VAPID_PUBLIC_KEY });
};
