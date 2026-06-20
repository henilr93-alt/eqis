// Patch renderContractingDigest: cap=5 (was 3), add daily rotation.
const fs = require('fs');
const path = require('path');
const p = path.join(__dirname, '..', 'utils', 'emailTemplates.js');
let src = fs.readFileSync(p, 'utf-8');

const oldBlock = `function renderContractingDigest(input) {
  const hotels = Array.isArray(input.hotels) ? input.hotels : [];
  // 2026-06-12: per user — top 3 hotels, each shown as a card listing every
  // NORMAL_CHEAPER combo (room category + meal plan) so Sudhir sees the
  // exact per-room price gap rather than just the first category.
  const reneg = hotels.map(h => {
    const combos = (h.combos || []).filter(c => c.verdict === 'NORMAL_CHEAPER' && c.diff && typeof c.diff.absINR === 'number');
    if (combos.length === 0) return null;
    const totalOverpay = combos.reduce((acc, c) => acc + Math.abs(c.diff.absINR), 0);
    return { row: h, combos, totalOverpay };
  }).filter(Boolean)
    .sort((a, b) => b.totalOverpay - a.totalOverpay)
    .slice(0, HOTEL_CARD_LIMIT);

  const rows = reneg.map((it, i) => _ecdHotelCardHtml(it.row, it.combos, 'renegotiate', i + 1)).join('');
  const totalOverpay = reneg.reduce((a, b) => a + b.totalOverpay, 0);`;

const newBlock = `function renderContractingDigest(input) {
  const hotels = Array.isArray(input.hotels) ? input.hotels : [];
  // 2026-06-12: per user — Sudhir gets 5 hotels per day, ranked by largest
  // total overpay (top pricing difference). Hotels rotate daily so he sees
  // a fresh list each cycle to negotiate against.
  const rotation = require('./renegotiateRotation');
  const RENEG_HOTEL_LIMIT = 5;
  const ranked = hotels.map(h => {
    const combos = (h.combos || []).filter(c => c.verdict === 'NORMAL_CHEAPER' && c.diff && typeof c.diff.absINR === 'number');
    if (combos.length === 0) return null;
    const totalOverpay = combos.reduce((acc, c) => acc + Math.abs(c.diff.absINR), 0);
    return { hotelName: h.hotelName, row: h, combos, totalOverpay };
  }).filter(Boolean)
    .sort((a, b) => b.totalOverpay - a.totalOverpay);
  const reneg = rotation.pickFreshHotels(ranked, RENEG_HOTEL_LIMIT);
  if (reneg.length > 0) rotation.recordSent(reneg.map(r => r.hotelName));

  const rows = reneg.map((it, i) => _ecdHotelCardHtml(it.row, it.combos, 'renegotiate', i + 1)).join('');
  const totalOverpay = reneg.reduce((a, b) => a + b.totalOverpay, 0);`;

if (!src.includes(oldBlock)) { console.error('Old contracting block not found'); process.exit(1); }
src = src.replace(oldBlock, newBlock);
fs.writeFileSync(p, src);
console.log('OK: renderContractingDigest patched (5 hotels/day + rotation)');
