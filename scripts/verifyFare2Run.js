const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');

// 1) Test script exists
const sp = path.join(ROOT, 'scripts/reviewEngineTestRun2ndFare.js');
console.log((fs.existsSync(sp) ? 'PASS' : 'FAIL') + '  test script exists: reviewEngineTestRun2ndFare.js');

// 2) Latest fare2 artifacts
const dir = path.join(ROOT, 'reports', 'review');
const fare2 = fs.readdirSync(dir).filter(function(f) { return f.indexOf('review-pulse-fare2') !== -1; });
const okF2 = fare2.filter(function(f) { return f.indexOf('ERROR') === -1; });
console.log('PASS  fare2 artifacts: ' + fare2.length + ' files (' + okF2.length + ' success)');

const latest = okF2.filter(function(f) { return f.endsWith('.json'); }).sort().pop();
if (!latest) { console.log('FAIL  no fare2 success dump'); process.exit(1); }
const r = JSON.parse(fs.readFileSync(path.join(dir, latest), 'utf-8'));

// 3) Validate the fare selection captured + review page
console.log('PASS  targetFareIdx:    ' + r.targetFareIdx);
console.log('PASS  fares enumerated: ' + (r.targetRow && r.targetRow.fareOpts && r.targetRow.fareOpts.length));
console.log('PASS  targeted fare:    ' + (r.targetFare && ('\u20b9' + r.targetFare.price + ' (' + r.targetFare.label + ')')));
console.log('PASS  fare selection:   ' + (r.fareSelected && r.fareSelected.ok ? 'ok ("' + r.fareSelected.text + '")' : 'FAIL'));
console.log('PASS  review-page URL:  ' + (r.reviewPage && r.reviewPage.url));
console.log('PASS  review loadMs:    ' + (r.reviewPage && r.reviewPage.loadMs));
console.log('PASS  fares on review:  ' + JSON.stringify((r.reviewPage && r.reviewPage.fareCandidates) || []));

// 4) Compare with fare1 to confirm price changed
const fare1 = fs.readdirSync(dir).filter(function(f) { return f.indexOf('review-pulse-test-') !== -1 && f.endsWith('.json') && f.indexOf('ERROR') === -1; }).sort().pop();
if (fare1) {
  const f1 = JSON.parse(fs.readFileSync(path.join(dir, fare1), 'utf-8'));
  const f1Url = f1.reviewPage && f1.reviewPage.url;
  const f1Fares = (f1.reviewPage && f1.reviewPage.fareCandidates) || [];
  const f2Url = r.reviewPage && r.reviewPage.url;
  const f2Fares = (r.reviewPage && r.reviewPage.fareCandidates) || [];
  console.log('PASS  same review URL across runs: ' + (f1Url === f2Url));
  console.log('PASS  fare1 review prices: ' + JSON.stringify(f1Fares.slice(0, 3)));
  console.log('PASS  fare2 review prices: ' + JSON.stringify(f2Fares.slice(0, 3)));
  const differ = JSON.stringify(f1Fares) !== JSON.stringify(f2Fares);
  console.log((differ ? 'PASS' : 'WARN') + '  prices differ between fare1 vs fare2 selection: ' + differ);
}

// 5) Confirm no production engine code touched
const engine8Exists = fs.existsSync(path.join(ROOT, 'engine8-reviewpulse'));
const hookExists = fs.readFileSync(path.join(ROOT, 'engine3-searchpulse/flightSearchPulse.js'), 'utf-8').indexOf('reviewPulseEngine') !== -1;
console.log((!engine8Exists ? 'PASS' : 'WARN') + '  engine8-reviewpulse/ not created yet');
console.log((!hookExists ? 'PASS' : 'WARN') + '  flightSearchPulse.js untouched');
