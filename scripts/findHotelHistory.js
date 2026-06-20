// Scan every ECD report for Grand Vista (or arg[0]) and dump bedbank/ECD prices
// over time so we can find the report where Sudhir saw the suspect ~1764 price.
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const dir = path.join(ROOT, 'reports/ecd');
const needle = (process.argv[2] || 'Grand Vista').toLowerCase();
const files = fs.readdirSync(dir).filter(f => f.endsWith('.json')).sort();
console.log('Scanning ' + files.length + ' reports for: ' + needle);
for (const f of files) {
  try {
    const r = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8'));
    const h = (r.hotelComparisons || []).find(x => x.hotelName && x.hotelName.toLowerCase().includes(needle));
    if (!h) continue;
    const combos = (h.combos || []).filter(c => c.normal && typeof c.normal.totalPrice === 'number');
    if (combos.length === 0) {
      console.log('  ' + f + ': hotel present, all bedbank null');
      continue;
    }
    console.log('  ' + f + ': ' + combos.length + ' combos w/ bedbank price');
    combos.forEach(c => {
      const ecdT  = c.ecd    && c.ecd.totalPrice;
      const normT = c.normal && c.normal.totalPrice;
      const pct   = c.diff   && c.diff.pct;
      console.log('      [' + c.verdict + '] ' + (c.roomCategory || '?') + ' / ' + (c.mealPlan || '?')
        + '   ECD=' + ecdT + '  bedbank=' + normT
        + (pct != null ? '  pct=' + pct.toFixed(1) + '%' : ''));
    });
  } catch (e) { console.log('  ' + f + ': parse err ' + e.message); }
}
