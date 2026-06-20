// Verifier: confirms the marketing digest sends 1 destination/day with 3
// hotels, and that 3 consecutive days rotate through different destinations.
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
function freshLoad() {
  delete require.cache[require.resolve(path.join(ROOT, 'utils/emailTemplates'))];
  delete require.cache[require.resolve(path.join(ROOT, 'utils/marketingRotation'))];
  return require(path.join(ROOT, 'utils/emailTemplates'));
}

const tpl = freshLoad();
const rot = require(path.join(ROOT, 'utils/marketingRotation'));

console.log('Module exports:');
['renderTechDigest','renderMarketingDigest','renderContractingDigest'].forEach(k =>
  console.log('  ' + (typeof tpl[k] === 'function' ? 'PASS' : 'FAIL') + '  exports.' + k));
['pickFreshHotels','recordSent','recentlyShown','pickDestinationForToday','recordDestinationSent'].forEach(k =>
  console.log('  ' + (typeof rot[k] === 'function' ? 'PASS' : 'FAIL') + '  rotation.' + k));

// Reset and simulate 3 consecutive sends
fs.writeFileSync(path.join(ROOT, 'state/marketingPromoteHistory.json'),
  JSON.stringify({ byDestination: {}, destinationLog: [] }, null, 2));
const r = JSON.parse(fs.readFileSync(path.join(ROOT, 'reports/ecd/ECD-20260612-1500.json'), 'utf-8'));

const day1 = freshLoad().renderMarketingDigest({ hotels: r.hotelComparisons, runId: r.runId, summary: r.summary });
const day2 = freshLoad().renderMarketingDigest({ hotels: r.hotelComparisons, runId: r.runId, summary: r.summary });
const day3 = freshLoad().renderMarketingDigest({ hotels: r.hotelComparisons, runId: r.runId, summary: r.summary });

function destOf(html) {
  const m = html.match(/featured destination: ([^<\u2014]+) \u2014/);
  return m ? m[1].trim() : null;
}
const d1 = destOf(day1.html);
const d2 = destOf(day2.html);
const d3 = destOf(day3.html);
console.log('');
console.log('LRU rotation over 3 consecutive sends:');
console.log('  Day 1: ' + d1);
console.log('  Day 2: ' + d2);
console.log('  Day 3: ' + d3);
const allDifferent = (d1 && d2 && d3 && d1 !== d2 && d2 !== d3 && d1 !== d3);
console.log('  ' + (allDifferent ? 'PASS' : 'FAIL') + '  all 3 sends featured different destinations');

const html = day1.html;
const checks = [
  ['featured destination:',    'Hero shows featured destination'],
  ['\u{1F4CD}',                'Pin emoji in destination header'],
  ['One featured destination', 'Methodology note explains rule'],
  ['Your rate /night',         'Room-by-room column present'],
  ['Market /night',            'Market /night column present'],
];
console.log('');
console.log('Structural checks on day-1 HTML:');
checks.forEach(([n,l]) => console.log('  ' + (html.includes(n) ? 'PASS' : 'FAIL') + '  ' + l));
const cards      = (html.match(/border:1px solid #eee;border-radius:8px;/g) || []).length;
const destBlocks = (html.match(/border-bottom:2px solid #0a7f3f/g) || []).length;
console.log('  ' + (cards === 3      ? 'PASS' : 'FAIL') + '  Exactly 3 hotel cards (actual: ' + cards + ')');
console.log('  ' + (destBlocks === 1 ? 'PASS' : 'FAIL') + '  Exactly 1 destination block (actual: ' + destBlocks + ')');
console.log('  Subject:     ' + day1.subject);
console.log('  recordCount: ' + day1.recordCount + ((day1.recordCount === 3) ? '  PASS' : '  FAIL'));
