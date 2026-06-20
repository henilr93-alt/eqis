// One-off patcher: swap renderMarketingDigest from "3 hotels per destination
// across all destinations" to "ONE destination per day, 3 hotels from it".
const fs = require('fs');
const path = require('path');
const p = path.join(__dirname, '..', 'utils', 'emailTemplates.js');
let src = fs.readFileSync(p, 'utf-8');

const oldFn = `function renderMarketingDigest(input) {
  const hotels = Array.isArray(input.hotels) ? input.hotels : [];
  // 2026-06-12: per user request — group by destination, show 3 hotels per
  // destination per day, rotate so consecutive days show different hotels.
  const rotation = require('./marketingRotation');
  // 1. Build all promote candidates (any ECD_CHEAPER combo with a diff)
  const candidates = hotels.map(h => {
    const combos = (h.combos || []).filter(c => c.verdict === 'ECD_CHEAPER' && c.diff && typeof c.diff.absINR === 'number');
    if (combos.length === 0) return null;
    const totalSaving = combos.reduce((acc, c) => acc + Math.abs(c.diff.absINR), 0);
    return { hotelName: h.hotelName, destination: h.destination || 'Unknown', row: h, combos, totalSaving };
  }).filter(Boolean);
  // 2. Group by destination, rank within each by total savings desc
  const byDest = {};
  for (const c of candidates) {
    if (!byDest[c.destination]) byDest[c.destination] = [];
    byDest[c.destination].push(c);
  }
  for (const dest of Object.keys(byDest)) {
    byDest[dest].sort((a, b) => b.totalSaving - a.totalSaving);
  }
  // 3. Per destination, pick top 3 hotels preferring those not shown in the
  //    last 7 days (rotation), then record what we sent for next-day rotation
  const PER_DEST_LIMIT = 3;
  const destinationGroups = [];
  let totalSavings = 0;
  const destNames = Object.keys(byDest).sort();
  for (const dest of destNames) {
    const picked = rotation.pickFreshHotels(dest, byDest[dest], PER_DEST_LIMIT);
    if (picked.length === 0) continue;
    destinationGroups.push({ destination: dest, items: picked });
    rotation.recordSent(dest, picked.map(p => p.hotelName));
    picked.forEach(p => { totalSavings += p.totalSaving; });
  }`;

const newFn = `function renderMarketingDigest(input) {
  const hotels = Array.isArray(input.hotels) ? input.hotels : [];
  // 2026-06-12: per user — exactly ONE destination per day, exactly 3 hotels
  // from that destination. Rotation = least-recently-used destination wins;
  // within the chosen destination, prefer hotels not shown in the last 7 days.
  const rotation = require('./marketingRotation');
  const candidates = hotels.map(h => {
    const combos = (h.combos || []).filter(c => c.verdict === 'ECD_CHEAPER' && c.diff && typeof c.diff.absINR === 'number');
    if (combos.length === 0) return null;
    const totalSaving = combos.reduce((acc, c) => acc + Math.abs(c.diff.absINR), 0);
    return { hotelName: h.hotelName, destination: h.destination || 'Unknown', row: h, combos, totalSaving };
  }).filter(Boolean);
  const byDest = {};
  for (const c of candidates) {
    if (!byDest[c.destination]) byDest[c.destination] = [];
    byDest[c.destination].push(c);
  }
  for (const dest of Object.keys(byDest)) {
    byDest[dest].sort((a, b) => b.totalSaving - a.totalSaving);
  }
  const availableDestinations = Object.keys(byDest).filter(d => byDest[d].length > 0);
  const chosenDestination = rotation.pickDestinationForToday(availableDestinations);
  const HOTEL_LIMIT = 3;
  let picked = [];
  let destinationGroups = [];
  let totalSavings = 0;
  if (chosenDestination) {
    picked = rotation.pickFreshHotels(chosenDestination, byDest[chosenDestination], HOTEL_LIMIT);
    if (picked.length > 0) {
      destinationGroups = [{ destination: chosenDestination, items: picked }];
      rotation.recordSent(chosenDestination, picked.map(p => p.hotelName));
      rotation.recordDestinationSent(chosenDestination);
      picked.forEach(p => { totalSavings += p.totalSaving; });
    }
  }`;

function mustReplace(needle, replacement, label) {
  if (!src.includes(needle)) {
    console.error('Could not find: ' + label);
    process.exit(1);
  }
  src = src.replace(needle, replacement);
  console.log('  patched: ' + label);
}

mustReplace(oldFn, newFn, 'main function block');
mustReplace(
  '  const totalHotels = destinationGroups.reduce((acc, g) => acc + g.items.length, 0);',
  '  const totalHotels = picked.length;',
  'totalHotels line',
);
mustReplace(
  "    '<div style=\"font-size:13px;color:#0a5f2e;margin-top:2px;\">across ' + destinationGroups.length + ' destination' + (destinationGroups.length === 1 ? '' : 's') + ' \\u2014 total potential ' + fmtINR(totalSavings) + ' in savings to highlight</div>',",
  "    '<div style=\"font-size:13px;color:#0a5f2e;margin-top:2px;\">' + (chosenDestination ? 'featured destination: ' + esc(chosenDestination) + ' \\u2014 ' : '') + 'total potential ' + fmtINR(totalSavings) + ' in savings to highlight</div>',",
  'hero caption line',
);
mustReplace(
  "        + 'Up to 3 hotels per destination per day, rotated so tomorrow\\'s digest covers different hotels where possible. '",
  "        + 'One featured destination per day with up to 3 hotels. Destinations rotate daily on a least-recently-used basis. '",
  'methodology note line',
);
mustReplace(
  '  // Override the outer summary fields to reflect destination grouping\n  const promote = destinationGroups.flatMap(g => g.items);',
  '  const promote = picked;',
  'outer summary fields',
);

fs.writeFileSync(p, src);
console.log('OK: utils/emailTemplates.js patched to single-destination-per-day mode.');
