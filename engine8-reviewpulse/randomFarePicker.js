// randomFarePicker.js — Pure functions for picking a random fare combo per
// route, avoiding combos picked in the last N reviews.
//
// State shape (state/reviewPulseRotation.json):
//   { "flight-intl": {
//       "BOM->DXB": {
//         recentPicks: [{ airline, flightCode, fareIdx, fareLabel, ts }, ...],
//         ringSize: 5
//       }
//     } }

const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger');

const STATE_FILE = path.join(__dirname, '..', 'state', 'reviewPulseRotation.json');
const DEFAULT_RING_SIZE = 10;  // 2026-06-15: bumped from 5 to 10 to widen diversity window

function _read() {
  try {
    if (!fs.existsSync(STATE_FILE)) return {};
    const raw = JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
    return (raw && typeof raw === 'object') ? raw : {};
  } catch (e) {
    logger.warn('[REVIEW-PICKER] state read failed: ' + e.message);
    return {};
  }
}

function _write(data) {
  try { fs.writeFileSync(STATE_FILE, JSON.stringify(data, null, 2)); }
  catch (e) { logger.warn('[REVIEW-PICKER] state write failed: ' + e.message); }
}

function _comboKey(c) {
  return (c.airline || '') + '|' + (c.flightCode || '') + '|' + (c.fareIdx == null ? '' : c.fareIdx);
}

/**
 * Pick a random combo from candidates, avoiding those reviewed in the last
 * N reviews on this route. Falls back to truly random if all are recent.
 *
 * @param {string} engineKey   e.g. 'flight-intl'
 * @param {string} routeKey    e.g. 'BOM->DXB'
 * @param {Array}  candidates  [{ airline, flightCode, fareIdx, fareLabel, price }]
 * @returns {Object|null}      the picked combo (or null if no candidates)
 */
function pick(engineKey, routeKey, candidates) {
  if (!Array.isArray(candidates) || candidates.length === 0) return null;
  const data = _read();
  const slot = (data[engineKey] && data[engineKey][routeKey]) || { recentPicks: [], ringSize: DEFAULT_RING_SIZE };
  const recent = slot.recentPicks || [];
  const recentKeys     = new Set(recent.map(_comboKey));
  const recentAirlines = new Set(recent.map(p => String(p.airline    || "").toLowerCase().trim()));
  const recentFares    = new Set(recent.map(p => String(p.fareLabel  || "").toLowerCase().trim()));

  // 2026-06-15: per-airline frequency cap. User rule: IndiGo at most 1 of
  // every 10 reviews on this route. Count current IndiGo (incl. 6E IATA)
  // picks in the ring; if cap is hit, exclude IndiGo from candidates BEFORE
  // tier selection. If after the cap there are zero candidates left, fall
  // back to the original set to avoid a dead route.
  const AIRLINE_CAPS = { "indigo": 1 };  // max occurrences in the last  picks
  const canonAirline = name => {
    const n = String(name || "").toLowerCase().trim();
    if (n === "6e" || n.startsWith("indigo")) return "indigo";
    return n;
  };
  const recentCanon = recent.map(p => canonAirline(p.airline));
  const counts = {};
  for (const a of recentCanon) counts[a] = (counts[a] || 0) + 1;
  const cappedAirlines = new Set(Object.keys(AIRLINE_CAPS).filter(a => (counts[a] || 0) >= AIRLINE_CAPS[a]));
  if (cappedAirlines.size > 0) {
    const filtered = candidates.filter(c => !cappedAirlines.has(canonAirline(c.airline)));
    if (filtered.length > 0) {
      logger.info("[REVIEW-PICKER] airline-cap: excluded " + [...cappedAirlines].join(",") + " (" + (candidates.length - filtered.length) + " of " + candidates.length + " combos dropped)");
      candidates = filtered;
    } else {
      logger.info("[REVIEW-PICKER] airline-cap: only capped airline(s) available, ignoring cap to avoid empty pool");
    }
  }

  // 2026-06-15: stricter tiered diversity per user request — at every review,
  // pick a combo with a different airline AND different fare type than any of
  // the last N reviews on this route. Walk through progressively wider tiers.
  const a = c => String(c.airline   || "").toLowerCase().trim();
  const f = c => String(c.fareLabel || "").toLowerCase().trim();

  // Tier 1: airline NEW + fareLabel NEW
  let pool = candidates.filter(c => !recentAirlines.has(a(c)) && !recentFares.has(f(c)));
  if (pool.length) { logger.info('[REVIEW-PICKER] tier1 (new airline + new fare): ' + pool.length + ' of ' + candidates.length + ' candidates'); return pool[Math.floor(Math.random() * pool.length)]; }

  // Tier 2: airline NEW (any fare)
  pool = candidates.filter(c => !recentAirlines.has(a(c)));
  if (pool.length) { logger.info('[REVIEW-PICKER] tier2 (new airline, fare may repeat): ' + pool.length + ' of ' + candidates.length); return pool[Math.floor(Math.random() * pool.length)]; }

  // Tier 3: fareLabel NEW (any airline)
  pool = candidates.filter(c => !recentFares.has(f(c)));
  if (pool.length) { logger.info('[REVIEW-PICKER] tier3 (new fare, airline may repeat): ' + pool.length + ' of ' + candidates.length); return pool[Math.floor(Math.random() * pool.length)]; }

  // Tier 4: avoid exact (airline+flight+fareIdx) combo only
  pool = candidates.filter(c => !recentKeys.has(_comboKey(c)));
  if (pool.length) { logger.info('[REVIEW-PICKER] tier4 (avoid exact combo): ' + pool.length + ' of ' + candidates.length); return pool[Math.floor(Math.random() * pool.length)]; }

  // Tier 5: nothing fresh — pure random (small route, no diversity possible)
  logger.info('[REVIEW-PICKER] tier5 (no fresh combos, pure random): ' + candidates.length);
  return candidates[Math.floor(Math.random() * candidates.length)];
}

/**
 * Append a pick to the route's ring buffer.
 */
function recordPick(engineKey, routeKey, combo) {
  if (!combo) return;
  const data = _read();
  if (!data[engineKey]) data[engineKey] = {};
  if (!data[engineKey][routeKey]) data[engineKey][routeKey] = { recentPicks: [], ringSize: DEFAULT_RING_SIZE };
  const slot = data[engineKey][routeKey];
  const ring = Math.max(1, Number(slot.ringSize) || DEFAULT_RING_SIZE);
  slot.recentPicks = (slot.recentPicks || []).concat([{
    airline:    combo.airline,
    flightCode: combo.flightCode,
    fareIdx:    combo.fareIdx,
    fareLabel:  combo.fareLabel,
    ts:         new Date().toISOString(),
  }]).slice(-ring);
  _write(data);
}

module.exports = { pick, recordPick, _internals: { _read, _write, _comboKey, DEFAULT_RING_SIZE } };
