// Verify renegotiate digest: 5 hotels/day, ranked by overpay, rotated daily.
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');

function freshLoad() {
  delete require.cache[require.resolve(path.join(ROOT, 'utils/emailTemplates'))];
  delete require.cache[require.resolve(path.join(ROOT, 'utils/renegotiateRotation'))];
  return require(path.join(ROOT, 'utils/emailTemplates'));
}

// Reset rotation
fs.writeFileSync(path.join(ROOT, 'state/renegotiateRotationHistory.json'), JSON.stringify({ sent: [] }, null, 2));
const r = JSON.parse(fs.readFileSync(path.join(ROOT, 'reports/ecd/ECD-20260612-1500.json'), 'utf-8'));

const day1 = freshLoad().renderContractingDigest({ hotels: r.hotelComparisons, runId: r.runId, summary: r.summary });
const day2 = freshLoad().renderContractingDigest({ hotels: r.hotelComparisons, runId: r.runId, summary: r.summary });
const day3 = freshLoad().renderContractingDigest({ hotels: r.hotelComparisons, runId: r.runId, summary: r.summary });

function hotelsOf(html) {
  const out = [];
  const re = /<span style="font-weight:700;font-size:14px;color:#0a0a0a;">([^<]+)<\/span>/g;
  let m;
  while ((m = re.exec(html))) out.push(m[1].trim());
  return out;
}
const d1 = hotelsOf(day1.html);
const d2 = hotelsOf(day2.html);
const d3 = hotelsOf(day3.html);

console.log('Day 1 (' + d1.length + ' hotels): ' + d1.join(', '));
console.log('Day 2 (' + d2.length + ' hotels): ' + d2.join(', '));
console.log('Day 3 (' + d3.length + ' hotels): ' + d3.join(', '));

const overlap12 = d1.filter(h => d2.includes(h)).length;
const overlap23 = d2.filter(h => d3.includes(h)).length;
console.log('');
console.log('Each day exactly 5 hotels: ' + (d1.length === 5 && d2.length === 5 && d3.length === 5 ? 'PASS' : 'FAIL'));
console.log('Day 1 vs Day 2 overlap:    ' + overlap12 + (overlap12 === 0 ? '  PASS (full rotation)' : '  (some repeats)'));
console.log('Day 2 vs Day 3 overlap:    ' + overlap23 + (overlap23 === 0 ? '  PASS (full rotation)' : '  (some repeats)'));
console.log('Subject day 1:             ' + day1.subject);
console.log('recordCount day 1:         ' + day1.recordCount);
