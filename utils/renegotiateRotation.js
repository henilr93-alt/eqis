// renegotiateRotation.js — Hotel-level rotation for Sudhir's renegotiate
// digest. Same pattern as marketingRotation's hotel rotation, but with its
// own state file so the two don't interfere. Sudhir gets a fresh list of
// 5 hotels each day; hotels shown in the last 7 days are deprioritised.

const fs = require('fs');
const path = require('path');

const STATE_FILE = path.join(__dirname, '..', 'state', 'renegotiateRotationHistory.json');
const LOOKBACK_DAYS = 7;

function _read() {
  try {
    if (!fs.existsSync(STATE_FILE)) return { sent: [] };
    const raw = JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
    if (!raw || typeof raw !== 'object' || !Array.isArray(raw.sent)) return { sent: [] };
    return raw;
  } catch { return { sent: [] }; }
}

function _write(data) {
  try { fs.writeFileSync(STATE_FILE, JSON.stringify(data, null, 2)); }
  catch { /* not fatal */ }
}

/**
 * Set of hotel names featured in the last LOOKBACK_DAYS days.
 */
function recentlyShown() {
  const data = _read();
  const cutoff = Date.now() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000;
  const set = new Set();
  for (const e of data.sent) {
    if (!e || !e.hotel || !e.sentAt) continue;
    if (new Date(e.sentAt).getTime() >= cutoff) set.add(e.hotel);
  }
  return set;
}

/**
 * Pick top-N hotels preferring those not in the recent lookback. Falls back
 * to the seen pile if fewer fresh hotels exist than N.
 *
 * @param {Array}  rankedCandidates  pre-sorted by desirability (e.g. total overpay desc)
 * @param {number} n
 */
function pickFreshHotels(rankedCandidates, n) {
  const limit = n || 5;
  const seen = recentlyShown();
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
    for (const c of seenOnes) {
      if (picked.length >= limit) break;
      picked.push(c);
    }
  }
  return picked;
}

/**
 * Record that we sent these hotels today, for tomorrow's rotation.
 */
function recordSent(hotelNames) {
  if (!Array.isArray(hotelNames) || hotelNames.length === 0) return;
  const data = _read();
  for (const name of hotelNames) {
    if (typeof name === 'string' && name.length > 0) {
      data.sent.push({ hotel: name, sentAt: new Date().toISOString() });
    }
  }
  // Cap to last ~150 entries (~30 days of 5/day)
  data.sent = data.sent.slice(-150);
  _write(data);
}

module.exports = { recentlyShown, pickFreshHotels, recordSent, _internals: { LOOKBACK_DAYS } };
