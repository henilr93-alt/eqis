// searchPulseActivity.js — small writeable state file showing what each
// SearchPulse sub-engine is currently doing. Sub-engines call set() at the
// start of a search and setIdle() at the end. The dashboard polls
// /api/searchpulse/activity for the live status bars on the History tab.
//
// Mirrors utils/ecdActivity.js — same writer pattern, per-category data.

const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'state', 'searchPulseActivity.json');

// category: 'flight-dom' | 'flight-intl' | 'hotel-dom' | 'hotel-intl'
function set(category, step, detail) {
  let data = {};
  try { data = JSON.parse(fs.readFileSync(FILE, 'utf-8')); } catch { /* fresh file */ }
  data[category] = {
    step: step || 'idle',
    detail: detail || '',
    updatedAt: new Date().toISOString(),
  };
  try { fs.writeFileSync(FILE, JSON.stringify(data, null, 2)); } catch { /* ignore */ }
}

function get() {
  try {
    return JSON.parse(fs.readFileSync(FILE, 'utf-8'));
  } catch {
    return {};
  }
}

function setIdle(category, lastResult) {
  set(category, 'idle', lastResult || '');
}

module.exports = { set, get, setIdle };
