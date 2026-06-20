// rtFareRotation.js — Dedicated "RoundTrip Fare" toggle alternation for the
// merged Flight INTL Audit engine (Engine 9).
//
// On Etrav's INTERNATIONAL round-trip search form there is a "RoundTrip Fare"
// checkbox:
//   * TICKED   → results are same-airline COMBINED round-trip fares
//   * UNTICKED → results are two separate ONE-WAY legs (can be 2 different
//                airlines)
// Requirement: every consecutive round-trip search must ALTERNATE this toggle —
// run #1 ticked, run #2 unticked, run #3 ticked, …
//
// SearchPulse already does this, but via a SHARED counter (roundTripCount) that
// is also bumped by DOMESTIC round-trips (which don't even show the box), so the
// intl checked/unticked rhythm drifts. This engine keeps its OWN counter in its
// OWN state file so the intl alternation is clean and isolated.
//
// The counter only advances when nextChecked() is called — call it ONCE per
// round-trip intl run, right when building the scenario. One-way runs never call
// it (the box isn't shown).

const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger');

const STATE_PATH = path.join(__dirname, '..', 'state', 'flightIntlAuditRtFare.json');

function _read() {
  try { return JSON.parse(fs.readFileSync(STATE_PATH, 'utf-8')); }
  catch { return { rtFareCounter: 0 }; }
}

function _write(data) {
  try { fs.writeFileSync(STATE_PATH, JSON.stringify(data, null, 2)); }
  catch (e) { logger.warn('[FLIGHT-INTL-AUDIT] rtFare state write failed: ' + e.message); }
}

// Peek the current counter without advancing it.
function peek() {
  const data = _read();
  const n = data.rtFareCounter || 0;
  return { counter: n, shouldBeChecked: (n % 2) === 0 };
}

// Return whether THIS round-trip run should TICK the RoundTrip Fare box, then
// advance the counter so the next round-trip run flips. Even counter = checked.
//   @returns { shouldBeChecked: boolean, counter: number }
function nextChecked() {
  const data = _read();
  const n = data.rtFareCounter || 0;
  const shouldBeChecked = (n % 2) === 0;
  data.rtFareCounter = n + 1;
  _write(data);
  return { shouldBeChecked: shouldBeChecked, counter: n };
}

module.exports = { nextChecked, peek, STATE_PATH };
