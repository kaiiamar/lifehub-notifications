// Apple Health → Life Hub sync endpoint.
// ============================================================
// Called by an iOS Shortcut (Personal Automation) that reads HealthKit and
// POSTs a compact JSON payload. Writes weight / runs / steps into the shared
// STATE (Firebase), deduped, so the app + Telegram bot reflect them without
// any manual logging.
//
// Auth:  POST /api/health-sync?secret=<HEALTH_SYNC_SECRET>
// Body (every field optional):
//   {
//     "weight": { "value": 91.2, "date": "2026-07-13" },   // or [ {value,date}, ... ]
//     "runs":   [ { "distance": 5.2, "duration": "28:30", "date": "2026-07-13", "id": "<uuid>" } ],
//     "steps":  [ { "value": 8500, "date": "2026-07-13" } ] // or { value, date }
//   }
//
// Dedupe: weight = one entry per day (latest reading replaces); runs = by
// HealthKit id when present, else by date+distance; steps = latest per day.

const { loadState, saveState, localDateKey } = require('./telegram/_helpers.js');

function genId() { return Math.random().toString(36).slice(2, 9); }
function asArray(v) { return v == null ? [] : (Array.isArray(v) ? v : [v]); }

// Normalise any date-ish input to a YYYY-MM-DD key; default to today.
function toDateKey(d) {
  if (!d) return localDateKey();
  const s = String(d).trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const parsed = new Date(s);
  return isNaN(parsed.getTime()) ? localDateKey() : localDateKey(parsed);
}

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const secret = req.query.secret || (req.body && req.body.secret);
  if (!process.env.HEALTH_SYNC_SECRET) return res.status(500).json({ error: 'HEALTH_SYNC_SECRET not set' });
  if (secret !== process.env.HEALTH_SYNC_SECRET) return res.status(403).json({ error: 'Forbidden' });

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
  body = body || {};

  const state = await loadState();
  if (!state) return res.status(404).json({ error: 'No state found' });

  if (!state.metrics) state.metrics = {};
  if (!Array.isArray(state.metrics.weight)) state.metrics.weight = [];
  if (!Array.isArray(state.metrics.run)) state.metrics.run = [];
  if (!state.health) state.health = {};
  if (!state.health.steps) state.health.steps = {};

  const added = { weight: 0, runs: 0, steps: 0, skipped: 0 };

  // ── Weight — one entry per day; a new reading replaces the same date. ──
  asArray(body.weight).forEach(function (w) {
    if (!w || w.value == null) return;
    const val = Math.round(Number(w.value) * 10) / 10;
    if (!isFinite(val) || val <= 0) return;
    const date = toDateKey(w.date);
    state.metrics.weight = state.metrics.weight.filter(function (x) { return x.date !== date; });
    state.metrics.weight.push({ id: genId(), date: date, value: val, source: 'health' });
    added.weight++;
  });

  // ── Runs — dedupe by HealthKit id, else by date+distance. Auto-ticks a
  //    "run" habit and satisfies the Today training card for that day. ──
  asArray(body.runs).forEach(function (r) {
    if (!r || r.distance == null) return;
    const dist = Math.round(Number(r.distance) * 100) / 100;
    if (!isFinite(dist) || dist <= 0) return;
    const date = toDateKey(r.date);
    const hid = r.id ? String(r.id) : null;
    const dup = state.metrics.run.some(function (x) {
      if (hid && x.healthId) return x.healthId === hid;
      return x.date === date && Math.abs(Number(x.distance) - dist) < 0.05;
    });
    if (dup) { added.skipped++; return; }
    const entry = { id: genId(), date: date, distance: dist, time: r.duration || r.time || '', note: r.note || '', source: 'health' };
    if (hid) entry.healthId = hid;
    state.metrics.run.push(entry);
    added.runs++;
    (state.habits || []).forEach(function (h) {
      if (/run/i.test(h.name || '')) { if (!h.logs) h.logs = {}; h.logs[date] = true; }
    });
  });

  // ── Steps — daily count; latest reading per day wins. Stored under
  //    state.health.steps to avoid clashing with the app's weekly steps metric. ──
  asArray(body.steps).forEach(function (s) {
    if (!s || s.value == null) return;
    const val = Math.round(Number(s.value));
    if (!isFinite(val) || val < 0) return;
    state.health.steps[toDateKey(s.date)] = val;
    added.steps++;
  });

  state.health.lastSync = new Date().toISOString();

  await saveState(state);
  return res.status(200).json({ ok: true, added: added });
};
