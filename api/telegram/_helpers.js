// Shared helpers for Telegram bot endpoints
// ============================================================
// Provides:
//  - getFirestore() — singleton Firestore client
//  - loadState() / saveState() — read/write the Life Hub user state
//  - tg() — Telegram API caller (sendMessage, editMessageText, answerCallbackQuery, etc.)
//  - localDateKey(d) / nowLocal() — timezone-aware date helpers (matches the web app)

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

function getFirestore() {
  getFirebaseApp();
  return admin.firestore();
}

const USER_ID = process.env.LIFEHUB_USER_ID || 'kai';
const SCHEMA_VERSION = 2;
const MAX_DOMAIN_BYTES = 700 * 1024;
const stateMetadata = new WeakMap();

function serialize(value) {
  return value === undefined ? undefined : JSON.stringify(value);
}

async function loadState() {
  const db = getFirestore();
  const userRef = db.collection('users').doc(USER_ID);
  const [rootSnap, domainsSnap] = await Promise.all([
    userRef.get(),
    userRef.collection('domains').get()
  ]);

  let state = {};
  if (rootSnap.exists) {
    const root = rootSnap.data();
    if (root && root.state) {
      try {
        state = typeof root.state === 'string'
          ? JSON.parse(root.state)
          : JSON.parse(JSON.stringify(root.state));
      } catch (e) {
        console.error('Legacy state parse failed:', e.message);
      }
    }
  }

  const revisions = {};
  domainsSnap.forEach(doc => {
    const record = doc.data() || {};
    revisions[doc.id] = Number(record.revision || 0);
    if (record.deleted) delete state[doc.id];
    else state[doc.id] = record.data;
  });

  if (!rootSnap.exists && domainsSnap.empty) return null;
  const serialized = {};
  Object.keys(state).forEach(domain => { serialized[domain] = serialize(state[domain]); });
  stateMetadata.set(state, { revisions, serialized });
  return state;
}

async function saveState(state) {
  const metadata = stateMetadata.get(state);
  if (!metadata) throw new Error('State must be loaded before it can be saved');

  const domains = new Set([...Object.keys(metadata.serialized), ...Object.keys(state)]);
  const changes = [];
  domains.forEach(domain => {
    const next = serialize(state[domain]);
    if (next === metadata.serialized[domain]) return;
    if (!/^[A-Za-z_$][A-Za-z0-9_$-]{0,99}$/.test(domain) || ['__proto__', 'prototype', 'constructor'].includes(domain)) {
      throw new Error('Invalid state domain: ' + domain);
    }
    if (next !== undefined && Buffer.byteLength(next, 'utf8') > MAX_DOMAIN_BYTES) {
      throw new Error('State domain exceeds 700 KB: ' + domain);
    }
    changes.push({ domain, deleted: next === undefined, data: next === undefined ? null : state[domain] });
  });
  if (!changes.length) return;

  const db = getFirestore();
  const userRef = db.collection('users').doc(USER_ID);
  const nextRevisions = {};
  await db.runTransaction(async tx => {
    const snapshots = [];
    for (const change of changes) {
      snapshots.push(await tx.get(userRef.collection('domains').doc(change.domain)));
    }
    snapshots.forEach((snap, index) => {
      const change = changes[index];
      const remoteRevision = snap.exists ? Number((snap.data() || {}).revision || 0) : 0;
      const expectedRevision = Number(metadata.revisions[change.domain] || 0);
      if (remoteRevision !== expectedRevision) {
        const error = new Error('State changed on another client: ' + change.domain);
        error.code = 'lifehub/revision-conflict';
        throw error;
      }
      nextRevisions[change.domain] = remoteRevision + 1;
    });
    changes.forEach(change => {
      tx.set(userRef.collection('domains').doc(change.domain), {
        data: change.data,
        deleted: change.deleted,
        revision: nextRevisions[change.domain],
        schemaVersion: SCHEMA_VERSION,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedBy: 'telegram'
      });
    });
    tx.set(userRef, {
      schemaVersion: SCHEMA_VERSION,
      domainStorage: true,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedBy: 'telegram'
    }, { merge: true });
  });

  changes.forEach(change => {
    metadata.revisions[change.domain] = nextRevisions[change.domain];
    if (change.deleted) delete metadata.serialized[change.domain];
    else metadata.serialized[change.domain] = serialize(change.data);
  });
}

// Telegram API caller — generic
async function tg(method, body) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN missing');
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const json = await res.json();
  if (!json.ok) {
    console.error('Telegram API error:', method, json.description || json);
    throw new Error('Telegram ' + method + ' failed: ' + (json.description || 'unknown'));
  }
  return json.result;
}

function getChatId() {
  const id = process.env.TELEGRAM_CHAT_ID;
  if (!id) return null;
  return Number(id);
}

// Local date key matching web app's localDateKey() — YYYY-MM-DD in local time.
// Defaults to UTC if TZ_OFFSET not set; UK is 0 in winter, 1 in summer (BST).
function localDateKey(date) {
  const d = date || new Date();
  const offset = Number(process.env.TZ_OFFSET || 0);
  const local = new Date(d.getTime() + offset * 3600000);
  const y = local.getUTCFullYear();
  const m = String(local.getUTCMonth() + 1).padStart(2, '0');
  const day = String(local.getUTCDate()).padStart(2, '0');
  return y + '-' + m + '-' + day;
}

function nowLocal() {
  const offset = Number(process.env.TZ_OFFSET || 0);
  return new Date(Date.now() + offset * 3600000);
}

// ----- Pending action storage (Redis) --------------------------------------
// Free-text logging parses a message into actions, stores them, and waits for
// the user to tap Confirm. We key by a short token embedded in the button.
let _redis = null;
function getRedis() {
  if (_redis) return _redis;
  try {
    const { Redis } = require('@upstash/redis');
    _redis = new Redis({ url: process.env.KV_REST_API_URL, token: process.env.KV_REST_API_TOKEN });
  } catch (e) {
    console.error('Redis init failed:', e.message);
    return null;
  }
  return _redis;
}

async function savePending(token, actions) {
  const r = getRedis();
  if (!r) return false;
  try {
    await r.set('pending:' + token, JSON.stringify(actions), { ex: 900 }); // 15 min expiry
    return true;
  } catch (e) {
    console.error('savePending failed:', e.message);
    return false;
  }
}

async function loadPending(token) {
  const r = getRedis();
  if (!r) return null;
  try {
    const raw = await r.get('pending:' + token);
    if (!raw) return null;
    return typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch (e) {
    console.error('loadPending failed:', e.message);
    return null;
  }
}

async function clearPending(token) {
  const r = getRedis();
  if (!r) return;
  try { await r.del('pending:' + token); } catch (e) { /* ignore */ }
}

// ----- Generic KV (Redis) ---------------------------------------------------
// Small reusable JSON store used by features that need to remember something
// across invocations (e.g. when the rut nudge last fired). Fails soft.
async function kvGet(key) {
  const r = getRedis();
  if (!r) return null;
  try {
    const raw = await r.get('lh:' + key);
    if (raw == null) return null;
    if (typeof raw === 'string') {
      try { return JSON.parse(raw); } catch (e) { return raw; }
    }
    return raw;
  } catch (e) {
    console.error('kvGet failed:', e.message);
    return null;
  }
}

async function kvSet(key, value, ttlSec) {
  const r = getRedis();
  if (!r) return false;
  try {
    const opts = ttlSec ? { ex: ttlSec } : undefined;
    await r.set('lh:' + key, JSON.stringify(value), opts);
    return true;
  } catch (e) {
    console.error('kvSet failed:', e.message);
    return false;
  }
}

// Habit helpers — match the web app's logic for "due today"
function habitDayStatus(h, dateKey) {
  const f = (h.freq || 'daily').toLowerCase();
  if (h.startDate && dateKey < h.startDate) return 'pre-start';
  if (h.logs && h.logs[dateKey]) return 'done';
  if (f === 'daily') return 'todo';
  // For weekly frequencies, check this week's hits
  if (/^\d+x\/week$/.test(f) || f === 'weekly') {
    const target = f === 'weekly' ? 1 : Number(f.split('x')[0]);
    const parts = dateKey.split('-');
    const d = new Date(+parts[0], +parts[1] - 1, +parts[2]);
    const ws = new Date(d); ws.setDate(ws.getDate() - ws.getDay());
    const we = new Date(ws); we.setDate(we.getDate() + 6);
    let count = 0;
    Object.keys(h.logs || {}).forEach(function(k) {
      if (!h.logs[k]) return;
      const kd = new Date(k + 'T12:00:00');
      if (kd >= ws && kd <= we) count++;
    });
    return count >= target ? 'rest' : 'todo';
  }
  return 'todo';
}

function isHabitDailyDueToday(h, todayKey) {
  // Stricter than habitDayStatus — only daily-frequency habits
  const f = (h.freq || 'daily').toLowerCase();
  if (f !== 'daily') return false;
  return habitDayStatus(h, todayKey) === 'todo';
}

function isHabitWeeklyOutstanding(h, todayKey) {
  // Weekly / Nx-week habits that haven't hit their target this week
  const f = (h.freq || 'daily').toLowerCase();
  if (!/^\d+x\/week$/.test(f) && f !== 'weekly') return false;
  return habitDayStatus(h, todayKey) === 'todo';
}

module.exports = {
  getFirebaseApp,
  getFirestore,
  loadState,
  saveState,
  tg,
  getChatId,
  localDateKey,
  nowLocal,
  habitDayStatus,
  isHabitDailyDueToday,
  isHabitWeeklyOutstanding,
  savePending,
  loadPending,
  clearPending,
  kvGet,
  kvSet
};
