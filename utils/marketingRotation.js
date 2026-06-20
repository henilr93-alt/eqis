// marketingRotation.js — Tracks marketing's daily picks so the digest can:
//   1. Rotate which DESTINATION is featured each day (only one per day)
//   2. Within that destination, prefer hotels NOT shown in the last 7 days
// State lives at state/marketingPromoteHistory.json.

const fs = require('fs');
const path = require('path');

const STATE_FILE = path.join(__dirname, '..', 'state', 'marketingPromoteHistory.json');
const LOOKBACK_DAYS = 7;   // hotels shown in last 7 days are "recently seen"

function _today() { return new Date().toISOString().split('T')[0]; }

function _read() {
  try {
    if (!fs.existsSync(STATE_FILE)) return { byDestination: {}, destinationLog: [] };
    const raw = JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
    if (!raw || typeof raw !== 'object') return { byDestination: {}, destinationLog: [] };
    if (!raw.byDestination)   raw.byDestination = {};
    if (!raw.destinationLog)  raw.destinationLog = [];
    return raw;
  } catch { return { byDestination: {}, destinationLog: [] }; }
}

function _write(data) {
  try { fs.writeFileSync(STATE_FILE, JSON.stringify(data, null, 2)); }
  catch { /* swallow — not fatal for digest */ }
}

/**
 * Returns the set of hotel names recently shown for a given destination,
 * within the LOOKBACK_DAYS window.
 */
function recentlyShown(destination) {
  const data = _read();
  const entries = (data.byDestination[destination] || []);
  const cutoff = Date.now() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000;
  const set = new Set();
  for (const e of entries) {
    if (!e || !e.hotel || !e.sentAt) continue;
    if (new Date(e.sentAt).getTime() >= cutoff) set.add(e.hotel);
  }
  return set;
}

/**
 * Pick top-N hotels for a destination preferring those NOT in the recent
 * lookback set. If there are fewer fresh ones than N, top up with the
 * least-recently-seen entries from the seen pile.
 *
 * @param {string} destination
 * @param {Array}  rankedCandidates  candidates already sorted by desirability
 *                                   (e.g. total saving desc). Each must have
 *                                   a `hotelName` field.
 * @param {number} n                 how many to pick (default 3)
 */
function pickFreshHotels(destination, rankedCandidates, n) {
  const limit = n || 3;
  const seen = recentlyShown(destination);
  const fresh = [];
  const seenOnes = [];
  for (const c of rankedCandidates) {
    if (!c || !c.hotelName) continue;
    if (seen.has(c.hotelName)) seenOnes.push(c);
    else fresh.push(c);
    if (fresh.length >= limit) break;
  }
  const picked = fresh.slice(0, limit);
  if (picked.length < limit) {
    // Fall back to seen ones (least-recently-seen first would be nicer but
    // we don't have per-hotel timestamps in the ranking — just take in order)
    for (const c of seenOnes) {
      if (picked.length >= limit) break;
      picked.push(c);
    }
  }
  return picked;
}

/**
 * Record that we sent these hotels for a destination today, so tomorrow's
 * pickFreshHotels() can avoid them.
 */
function recordSent(destination, hotelNames) {
  if (!destination || !Array.isArray(hotelNames) || hotelNames.length === 0) return;
  const data = _read();
  const today = _today();
  const list = data.byDestination[destination] || [];
  for (const name of hotelNames) {
    if (typeof name === 'string' && name.length > 0) {
      list.push({ hotel: name, sentAt: new Date().toISOString(), date: today });
    }
  }
  // Trim to a reasonable cap (60 entries / destination, ~3 weeks of daily 3s)
  data.byDestination[destination] = list.slice(-60);
  _write(data);
}

/**
 * Pick ONE destination to feature today, using a least-recently-used policy.
 * `availableDestinations` is the set of destinations that actually have promote
 * candidates in today's ECD report. We pick the one whose last-sent timestamp
 * is the oldest (or never sent before — that wins outright).
 *
 * @param {string[]} availableDestinations
 * @returns {string|null}
 */
function pickDestinationForToday(availableDestinations) {
  if (!Array.isArray(availableDestinations) || availableDestinations.length === 0) return null;
  const data = _read();
  // Build a map: destination -> last sentAt timestamp (ms) or 0 if never sent
  const lastSentMs = {};
  for (const dest of availableDestinations) lastSentMs[dest] = 0;
  for (const entry of data.destinationLog) {
    if (!entry || !entry.destination || !entry.sentAt) continue;
    if (!(entry.destination in lastSentMs)) continue;
    const t = new Date(entry.sentAt).getTime();
    if (isFinite(t) && t > lastSentMs[entry.destination]) lastSentMs[entry.destination] = t;
  }
  // Pick the one with the smallest lastSentMs (never-sent → 0 → wins). Tiebreak
  // alphabetically for determinism.
  return availableDestinations.slice().sort((a, b) => {
    const diff = (lastSentMs[a] || 0) - (lastSentMs[b] || 0);
    return diff !== 0 ? diff : a.localeCompare(b);
  })[0] || null;
}

/**
 * Record that we featured this destination today (for tomorrow's LRU pick).
 */
function recordDestinationSent(destination) {
  if (!destination) return;
  const data = _read();
  data.destinationLog.push({ destination, sentAt: new Date().toISOString(), date: _today() });
  // Cap to last 90 entries (~3 months of daily sends)
  data.destinationLog = data.destinationLog.slice(-90);
  _write(data);
}

module.exports = {
  recentlyShown,
  pickFreshHotels,
  recordSent,
  pickDestinationForToday,
  recordDestinationSent,
  _internals: { _read, _write, LOOKBACK_DAYS },
};
