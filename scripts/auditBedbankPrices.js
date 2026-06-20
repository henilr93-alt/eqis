// Pattern-match across recent ECD reports: when bedbank has a matched
// totalPrice, is it close to (ECD totalPrice) / (nights × rooms)? If yes,
// strong signal that the bedbank scraper stored a per-night price as
// totalPrice.
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const dir = path.join(ROOT, 'reports/ecd');

function nights(ci, co) {
  if (!ci || !co) return 1;
  const ms = new Date(co) - new Date(ci);
  if (!isFinite(ms) || ms <= 0) return 1;
  return Math.max(1, Math.round(ms / 86400000));
}

const files = fs.readdirSync(dir).filter(f => f.endsWith('.json')).sort().reverse().slice(0, 25);
console.log('Analyzing ' + files.length + ' most-recent ECD reports for per-night-vs-total drift...');

let total = 0;
let suspiciousPerNight = 0;        // bedbank ≈ ECD/unit  (bedbank stored per-night?)
let suspiciousEcdPerNight = 0;     // ECD ≈ bedbank/unit  (ECD stored per-night?)
let normalRange = 0;               // within 0.5x to 2x — looks healthy
let extremeOther = 0;
const samples = { perNightBedbank: [], perNightEcd: [], normal: [] };

for (const f of files) {
  let r; try { r = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8')); } catch { continue; }
  const hotels = r.hotelComparisons || [];
  for (const h of hotels) {
    const N = nights(h.checkin, h.checkout);
    const R = Math.max(1, Number((h.pax && h.pax.rooms) || h.rooms || 1));
    const unit = N * R;
    for (const c of (h.combos || [])) {
      const ecdT = c.ecd && c.ecd.totalPrice;
      const bedT = c.normal && c.normal.totalPrice;
      if (typeof ecdT !== 'number' || typeof bedT !== 'number') continue;
      if (ecdT <= 0 || bedT <= 0) continue;
      total++;
      const ratio = ecdT / bedT;
      // Suspicious per-night-as-total on bedbank: ratio ~ unit (so ecd/bed ≈ N*R)
      const closenessToUnit = Math.abs(ratio - unit) / unit;
      const closenessToInvUnit = Math.abs(ratio - 1 / unit) / (1 / unit);
      if (closenessToUnit < 0.30 && unit > 1) {
        suspiciousPerNight++;
        if (samples.perNightBedbank.length < 5) samples.perNightBedbank.push({ hotel: h.hotelName, N, R, room: c.roomCategory, ecdT, bedT, ratio: ratio.toFixed(2), file: f });
      } else if (closenessToInvUnit < 0.30 && unit > 1) {
        suspiciousEcdPerNight++;
        if (samples.perNightEcd.length < 5) samples.perNightEcd.push({ hotel: h.hotelName, N, R, room: c.roomCategory, ecdT, bedT, ratio: ratio.toFixed(2), file: f });
      } else if (ratio >= 0.5 && ratio <= 2.0) {
        normalRange++;
        if (samples.normal.length < 3) samples.normal.push({ hotel: h.hotelName, N, R, room: c.roomCategory, ecdT, bedT, ratio: ratio.toFixed(2), file: f });
      } else {
        extremeOther++;
      }
    }
  }
}

console.log('');
console.log('Total matched combos analyzed: ' + total);
console.log('Buckets:');
console.log('  Bedbank looks like PER-NIGHT (ECD/bed ≈ nights×rooms): ' + suspiciousPerNight + '  (' + (total ? (100 * suspiciousPerNight / total).toFixed(1) : '0') + '%)');
console.log('  ECD     looks like PER-NIGHT (ECD/bed ≈ 1/(nights×rooms)): ' + suspiciousEcdPerNight + '  (' + (total ? (100 * suspiciousEcdPerNight / total).toFixed(1) : '0') + '%)');
console.log('  Normal range (0.5x - 2x):                      ' + normalRange);
console.log('  Other extreme:                                  ' + extremeOther);

console.log('');
console.log('=== SAMPLE: Bedbank stored per-night (suspicious) ===');
samples.perNightBedbank.forEach(s => {
  console.log('  ' + s.hotel + '  (' + s.room + ')');
  console.log('    nights=' + s.N + ' rooms=' + s.R + '  ECD=' + s.ecdT + '  bedbank=' + s.bedT + '  ratio=' + s.ratio + 'x (expected ~' + (s.N * s.R) + 'x if bedbank is per-night)');
  console.log('    bedbank if multiplied by unit: ' + (s.bedT * s.N * s.R) + '  (vs ECD ' + s.ecdT + ')');
  console.log('    source: ' + s.file);
});

console.log('');
console.log('=== SAMPLE: Normal-range comparisons (healthy data) ===');
samples.normal.forEach(s => {
  console.log('  ' + s.hotel + '  (' + s.room + '): ECD=' + s.ecdT + ' bed=' + s.bedT + ' ratio=' + s.ratio + 'x  (' + s.file + ')');
});
