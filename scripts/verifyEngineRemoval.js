const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const ROOT = path.join(__dirname, '..');

let ok = true;
function chk(label, cond) {
  console.log((cond ? 'PASS' : 'FAIL') + '  ' + label);
  if (!cond) ok = false;
}

chk('engine2-journey/ deleted',      !fs.existsSync(path.join(ROOT, 'engine2-journey')));
chk('engine4-fullbooking/ deleted',  !fs.existsSync(path.join(ROOT, 'engine4-fullbooking')));
chk('reports/journey/ deleted',      !fs.existsSync(path.join(ROOT, 'reports/journey')));
chk('reports/recordings/ deleted',   !fs.existsSync(path.join(ROOT, 'reports/recordings')));
chk('utils/etravLogin.js present',    fs.existsSync(path.join(ROOT, 'utils/etravLogin.js')));
chk('utils/etravBrowser.js present',  fs.existsSync(path.join(ROOT, 'utils/etravBrowser.js')));

const remainingEngines = [
  'engine3-searchpulse/flightSearchPulse',
  'engine3-searchpulse/hotelSearchPulse',
  'engine3-searchpulse/searchPulseEngine',
  'engine5-ecd/ecdEngine',
  'engine6-mirror/mirrorEngine',
  'engine7-competitor/competitorEngine',
  'engine8-reviewpulse/reviewPulseEngine',
  'dashboard/server',
];
remainingEngines.forEach(function(rel) {
  try { require(path.join(ROOT, rel)); chk(rel + ' loads', true); }
  catch (e) { chk(rel + ' loads (' + e.message + ')', false); }
});

// Look for stale references to deleted dirs (excluding our own removal scripts + my recon scripts)
function staleRefs(needle, excludeRx) {
  try {
    const out = execSync('grep -rln "' + needle + '" --include="*.js" --exclude-dir=node_modules .', { cwd: ROOT }).toString();
    const lines = out.trim().split('\n').filter(Boolean).filter(function(l) { return !excludeRx.test(l); });
    if (lines.length > 0) {
      console.log('  stale refs:');
      lines.forEach(function(l) { console.log('    ' + l); });
    }
    return lines.length === 0;
  } catch (e) { return true; /* grep no match = exit 1 */ }
}
chk('no stale require("../engine2-journey/...") in code we kept',
  staleRefs('engine2-journey', /scripts\/(intlReviewRecon|findEmiratesRecon|reviewEngineTestRun|removeEnginesPhase|verifyEngineRemoval|ecdRecon|ecdDetailRecon|testDetailScraper|patchDashboard)/));
chk('no stale require("../engine4-fullbooking/...") in code we kept',
  staleRefs('engine4-fullbooking', /scripts\/(removeEnginesPhase|patchDashboard)/));

process.exit(ok ? 0 : 1);
