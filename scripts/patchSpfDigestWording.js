// Shift the SearchPulse digest wording from "today" to "yesterday" so the
// tech team understands the digest covers the previous closed day.
const fs = require('fs');
const path = require('path');
const p = path.join(__dirname, '..', 'utils', 'emailTemplates.js');
let src = fs.readFileSync(p, 'utf-8');

const swaps = [
  // hero box copy
  [
    'Etrav issue\' + ((totals.totalEtravIssues || 0) === 1 ? \'\' : \'s\') + \' today',
    'Etrav issue\' + ((totals.totalEtravIssues || 0) === 1 ? \'\' : \'s\') + \' yesterday',
    'hero "today" -> "yesterday"',
  ],
  // subject template
  [
    'SearchPulse daily report \\u2014 \'\n      + ((totals.totalEtravIssues || 0) > 0 ? (totals.totalEtravIssues || 0) + \' Etrav issue\' + ((totals.totalEtravIssues || 0) === 1 ? \'\' : \'s\') : \'all healthy\')\n      + \' \\u00b7 \' + successRate.toFixed(0) + \'% success on \' + totals.totalSearches + \' searches\'',
    'SearchPulse daily report (yesterday) \\u2014 \'\n      + ((totals.totalEtravIssues || 0) > 0 ? (totals.totalEtravIssues || 0) + \' Etrav issue\' + ((totals.totalEtravIssues || 0) === 1 ? \'\' : \'s\') : \'all healthy\')\n      + \' \\u00b7 \' + successRate.toFixed(0) + \'% success on \' + totals.totalSearches + \' searches\'',
    'subject -> mentions yesterday',
  ],
  // window caption
  [
    'Window: today (since 00:00 IST).',
    'Window: yesterday (00:00 to 23:59 IST).',
    'window caption -> yesterday',
  ],
  // section headings
  [
    '\\u{1F4CA} Search quality split &middot; per engine</h2>\'\n    + \'<div style="font-size:12px;color:#666;margin-bottom:10px;">Each chart splits today\\\'s searches',
    '\\u{1F4CA} Search quality split &middot; per engine</h2>\'\n    + \'<div style="font-size:12px;color:#666;margin-bottom:10px;">Each chart splits yesterday\\\'s searches',
    'pie-chart caption -> yesterday',
  ],
  [
    '\\u23F1 Slowest search per engine</h2>\'',
    '\\u23F1 Slowest search per engine (yesterday)</h2>\'',
    'slowest header -> yesterday',
  ],
  [
    'The longest single search from each engine today.',
    'The longest single search from each engine yesterday.',
    'slowest caption -> yesterday',
  ],
  [
    'No search durations recorded yet today.',
    'No search durations recorded yesterday.',
    'empty-state caption -> yesterday',
  ],
];

let ok = 0;
for (const [needle, replacement, label] of swaps) {
  if (src.includes(needle)) {
    src = src.replace(needle, replacement);
    console.log('  patched: ' + label);
    ok++;
  } else {
    console.log('  skip:    ' + label + '  (needle not found, may already be patched)');
  }
}

fs.writeFileSync(p, src);
console.log('Total patches applied: ' + ok);
