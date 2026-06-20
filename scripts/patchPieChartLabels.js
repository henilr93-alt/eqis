// Add explicit engine-name captions BELOW each pie chart image in the
// SearchPulse digest. QuickChart titles render inconsistently in small
// email-client sizes; plain-HTML captions are bulletproof.
const fs = require('fs');
const path = require('path');
const p = path.join(__dirname, '..', 'utils', 'emailTemplates.js');
let src = fs.readFileSync(p, 'utf-8');

// Replace each `<td>...<img></td>` pie-chart cell with a wrapped version
// that adds a labelled caption underneath.
const labels = [
  { idx: 0, alt: 'Flight Domestic split',      label: 'Flight Domestic' },
  { idx: 1, alt: 'Flight International split', label: 'Flight International' },
  { idx: 2, alt: 'Hotel Domestic split',       label: 'Hotel Domestic' },
  { idx: 3, alt: 'Hotel International split',  label: 'Hotel International' },
];

let patches = 0;
for (const L of labels) {
  // Match the existing line for this engine
  const needle =
    '<td width="50%" align="center" style="padding:6px;"><img src="\' + esc(engines[' + L.idx + '] ? _pieChartUrl(engines[' + L.idx + ']) : \'\') + \'" width="340" height="340" alt="' + L.alt + '" style="max-width:100%;height:auto;display:block;border:0;"></td>';
  const replacement =
    '<td width="50%" align="center" style="padding:6px;"><img src="\' + esc(engines[' + L.idx + '] ? _pieChartUrl(engines[' + L.idx + ']) : \'\') + \'" width="340" height="340" alt="' + L.alt + '" style="max-width:100%;height:auto;display:block;border:0;margin:0 auto;">' +
    '<div style="margin-top:6px;font-size:13px;font-weight:700;color:#0a0a0a;text-align:center;">\' + esc(engines[' + L.idx + '] ? engines[' + L.idx + '].name : \'' + L.label + '\') + \'</div>' +
    '<div style="font-size:11px;color:#666;text-align:center;margin-top:2px;">\' + (engines[' + L.idx + '] ? (engines[' + L.idx + '].total + \' search\' + (engines[' + L.idx + '].total === 1 ? \'\' : \'es\')) : \'\') + \'</div></td>';

  if (!src.includes(needle)) {
    console.log('  SKIP idx=' + L.idx + ' (' + L.label + ') — needle not found, may already be patched');
    continue;
  }
  src = src.replace(needle, replacement);
  console.log('  PATCH idx=' + L.idx + ' (' + L.label + ')');
  patches++;
}

fs.writeFileSync(p, src);
console.log('Applied ' + patches + ' / ' + labels.length + ' caption patches.');
