// Firebase Admin singleton.
// ============================================================
// Extracted from the retired Telegram helpers so the security layer keeps a
// single place that parses FIREBASE_SERVICE_ACCOUNT and initialises the app.

const admin = require('firebase-admin');

let _firebaseApp = null;
function getFirebaseApp() {
  if (_firebaseApp) return _firebaseApp;
  let cred;
  try {
    const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
    if (!raw) throw new Error('FIREBASE_SERVICE_ACCOUNT env var missing');
    const json = typeof raw === 'string' ? JSON.parse(raw) : raw;
    cred = admin.credential.cert(json);
  } catch (e) {
    console.error('Firebase credential parse failed:', e.message);
    throw e;
  }
  _firebaseApp = admin.initializeApp({ credential: cred });
  return _firebaseApp;
}

module.exports = { getFirebaseApp };
