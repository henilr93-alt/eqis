// ecdDestinationRotator.js — picks the next N ECD destinations per run, cycling
// through the full ECD destination list. Pointer persisted to state/ecdRotation.json.
//
// The ECD destination list itself is loaded from state/ecdRotation.json (the
// `destinations` array). Phase 0 recon will populate this with the real Eagle
// Crest contracted destinations. Until then it ships with a placeholder seed
// list that the operator can edit by hand.

const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger');

const STATE_FILE = path.join(__dirname, '..', 'state', 'ecdRotation.json');

function loadState() {
  try {
    if (!fs.existsSync(STATE_FILE)) return null;
    const raw = fs.readFileSync(STATE_FILE, 'utf-8');
    return JSON.parse(raw);
  } catch (err) {
    logger.error('[ECD-ROTATOR] Failed to read state: ' + err.message);
    return null;
  }
}

function saveState(state) {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch (err) {
    logger.error('[ECD-ROTATOR] Failed to write state: ' + err.message);
  }
}

function getDestinations() {
  const state = loadState();
  if (!state || !Array.isArray(state.destinations) || state.destinations.length === 0) {
    return [];
  }
  return state.destinations.slice();
}

/**
 * Pick the next N destinations from the rotation.
 * Cycles forward through the list. If list <= N, returns the entire list and
 * resets the pointer to 0 (no rotation needed when inventory is small).
 *
 * @param {number} n  number of destinations to return
 * @returns {string[]} destination names
 */
function nextBatch(n) {
  const state = loadState() || { pointer: 0, destinations: [] };
  const list = Array.isArray(state.destinations) ? state.destinations : [];

  if (list.length === 0) {
    logger.warn('[ECD-ROTATOR] ECD destination list is empty. Populate state/ecdRotation.json.destinations');
    return [];
  }

  if (list.length <= n) {
    state.pointer = 0;
    state.lastBatch = list.slice();
    state.lastBatchAt = new Date().toISOString();
    saveState(state);
    return list.slice();
  }

  const out = [];
  let pointer = typeof state.pointer === 'number' ? state.pointer : 0;
  for (let i = 0; i < n; i++) {
    out.push(list[pointer % list.length]);
    pointer = (pointer + 1) % list.length;
  }

  state.pointer = pointer;
  state.lastBatch = out;
  state.lastBatchAt = new Date().toISOString();
  saveState(state);

  return out;
}

module.exports = { nextBatch, getDestinations };
