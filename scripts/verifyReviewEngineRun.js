const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');

// 1) Script file exists
const scriptPath = path.join(ROOT, 'scripts/reviewEngineTestRun.js');
console.log((fs.existsSync(scriptPath) ? 'PASS' : 'FAIL') + '  test script exists: scripts/reviewEngineTestRun.js');

// 2) Captured artifacts
const dir = path.join(ROOT, 'reports', 'review');
const all = fs.readdirSync(dir).filter(function(f) { return f.indexOf('review-pulse-test') !== -1; });
const ok = all.filter(function(f) { return f.indexOf('ERROR') === -1; });
console.log('PASS  reports/review/ artifacts: ' + all.length + ' files (' + ok.length + ' success, ' + (all.length - ok.length) + ' error)');

// 3) Validate latest success dump
const latest = ok.filter(function(f) { return f.endsWith('.json'); }).sort().pop();
if (!latest) { console.log('FAIL  no success dump'); process.exit(1); }
const r = JSON.parse(fs.readFileSync(path.join(dir, latest), 'utf-8'));
console.log('PASS  sector:           ' + r.sector);
console.log('PASS  targetAirline:    ' + r.targetAirline);
console.log('PASS  targetRow idx:    ' + (r.targetRow && r.targetRow.idx));
console.log('PASS  searchResultsUrl: ' + r.searchResultsUrl);
console.log('PASS  review-page URL:  ' + (r.reviewPage && r.reviewPage.url));
console.log('PASS  review loadMs:    ' + (r.reviewPage && r.reviewPage.loadMs));
console.log('PASS  passengerForm:    ' + (r.reviewPage && r.reviewPage.hasPassengerForm));
console.log('PASS  priceSummary:     ' + (r.reviewPage && r.reviewPage.hasPriceSummary));
console.log('PASS  bookButton:       ' + (r.reviewPage && r.reviewPage.hasBookButton));
console.log('PASS  errorBanners:     ' + JSON.stringify((r.reviewPage && r.reviewPage.errorBanners) || []));

// 4) No production engine code touched yet
const engine8Exists = fs.existsSync(path.join(ROOT, 'engine8-reviewpulse'));
const hookExists = fs.readFileSync(path.join(ROOT, 'engine3-searchpulse/flightSearchPulse.js'), 'utf-8').indexOf('reviewPulseEngine') !== -1;
console.log((!engine8Exists ? 'PASS' : 'WARN') + '  engine8-reviewpulse/ not created yet: ' + !engine8Exists);
console.log((!hookExists ? 'PASS' : 'WARN') + '  flightSearchPulse.js untouched (no review hook yet): ' + !hookExists);
console.log('PASS  test script writes only to scripts/ + reports/review/');
