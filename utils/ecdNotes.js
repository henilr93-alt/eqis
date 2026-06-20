// ecdNotes.js — Per-hotel contracting notes (status, target rate, notes,
// last contacted, watchlist flag). Indexed by hotelName.
const fs = require('fs');
const path = require('path');
const FILE = path.join(__dirname, '..', 'state', 'ecdNotes.json');

function readAll() {
  try { return JSON.parse(fs.readFileSync(FILE, 'utf-8')); }
  catch { return {}; }
}
function writeAll(data) {
  try { fs.writeFileSync(FILE, JSON.stringify(data, null, 2)); } catch {}
}
function get(hotelName) {
  const all = readAll();
  return all[hotelName] || { status: 'pending', notes: '', targetRate: null, lastContactedAt: null, watchlist: false };
}
function set(hotelName, fields) {
  if (!hotelName) return null;
  const all = readAll();
  const cur = all[hotelName] || {};
  const next = Object.assign({}, cur, fields, { updatedAt: new Date().toISOString() });
  all[hotelName] = next;
  writeAll(all);
  return next;
}
module.exports = { readAll, get, set };
