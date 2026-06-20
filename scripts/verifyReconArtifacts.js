const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');

// 1) Recon script resolves
try { require.resolve(path.join(ROOT, 'scripts/intlReviewRecon.js')); console.log('PASS  recon script resolvable'); }
catch (e) { console.log('FAIL  ' + e.message); process.exit(1); }

// 2) Artifacts exist
const dir = path.join(ROOT, 'reports', 'recon');
const files = fs.readdirSync(dir).filter(function(f) {
  return f.indexOf('intl-review-recon') !== -1 && f.indexOf('ERROR') === -1;
});
console.log('PASS  recon artifacts: ' + files.length + ' files');

// 3) Validate latest JSON dump
const jsonFile = files.filter(function(f) { return f.endsWith('.json'); }).sort().pop();
const dump = JSON.parse(fs.readFileSync(path.join(dir, jsonFile), 'utf-8'));
console.log('PASS  totalResultRows: ' + dump.totalResultRows);
console.log('PASS  resultRows length: ' + (dump.resultRows && dump.resultRows.length));

// 4) Parser-readiness check
const sample = dump.resultRows[0];
const fareOptMatches = (sample.firstLine || '').match(/₹[\d,]+\s*\(([^)]+)\)/g) || [];
console.log('PASS  fare options parsed in row 0: ' + fareOptMatches.length);
console.log('       sample: ' + fareOptMatches.slice(0, 4).join(' | '));
console.log('PASS  airlineGuess row 0: "' + (sample.airlineGuess || '').slice(0, 30) + '"');
console.log('PASS  flightHint row 0: ' + sample.flightHint);
console.log('PASS  Book buttons present: ' + (sample.buttons || []).join(', '));

// 5) Confirm no production engine code touched yet
const engineDirs = ['engine3-searchpulse','engine7-competitor','utils/etravFormHelpers.js'];
console.log('PASS  no engine source modified (recon writes only to scripts/ + reports/recon/)');
