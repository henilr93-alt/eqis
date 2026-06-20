// ecdActivity.js — small writeable state file showing what the ECD engine is
// currently doing. Engines call set() at each major step; dashboard polls
// /api/ecd/activity for a live status bar.

const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'state', 'ecdActivity.json');

function set(step, detail) {
  const data = {
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
    return { step: 'idle', detail: '', updatedAt: null };
  }
}

function clear() {
  set('idle', '');
}

module.exports = { set, get, clear };
