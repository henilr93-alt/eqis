// One-off: find a hotel by name fragment across recent ECD reports
// and dump its full combo data so we can debug a price-extraction issue.
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const dir = path.join(ROOT, 'reports/ecd');
const needle = (process.argv[2] || 'Grand Vista').toLowerCase();
const files = fs.readdirSync(dir).filter(f => f.endsWith('.json')).sort().reverse();
let found = null;
for (const f of files) {
  try {
    const r = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8'));
    const h = (r.hotelComparisons || []).find(x => x.hotelName && x.hotelName.toLowerCase().includes(needle));
    if (h) { found = { file: f, run: r, hotel: h }; break; }
  } catch {}
}
if (found === null) { console.log('No match for "' + needle + '" in any recent report'); process.exit(0); }
console.log('Source report:', found.file);
console.log('Run id:', found.run.runId);
console.log('Hotel:', found.hotel.hotelName);
console.log('Destination/City:', found.hotel.destination, '/', found.hotel.city);
console.log('Stars:', found.hotel.starRating);
console.log('Dates:', found.hotel.checkin, '->', found.hotel.checkout);
console.log('Pax:', JSON.stringify(found.hotel.pax || found.hotel.rooms));
console.log('');
console.log('Combos (' + (found.hotel.combos || []).length + '):');
(found.hotel.combos || []).forEach((c, i) => {
  console.log('  --- combo ' + (i + 1) + ' ---');
  console.log('    roomCategory:', c.roomCategory);
  console.log('    mealPlan:', c.mealPlan);
  console.log('    verdict:', c.verdict);
  console.log('    ecd:', JSON.stringify(c.ecd));
  console.log('    normal (bedbank):', JSON.stringify(c.normal));
  console.log('    diff:', JSON.stringify(c.diff));
});
console.log('');
console.log('Top-level hotel keys:', Object.keys(found.hotel).join(', '));
