// removeEnginesPhase2.js — Relocate shared login + browser helpers OUT of
// engine2-journey/ into utils/ so we can safely delete engine2-journey later
// without breaking SearchPulse / ECD / Mirror.
//
// Idempotent: re-running this after success is a no-op.

const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');

function read(p) { return fs.readFileSync(p, 'utf-8'); }
function write(p, c) { fs.writeFileSync(p, c); }

// 1) Copy the two source files
const srcLogin = path.join(ROOT, 'engine2-journey', 'login.js');
const srcBrowser = path.join(ROOT, 'engine2-journey', 'browser.js');
const dstLogin = path.join(ROOT, 'utils', 'etravLogin.js');
const dstBrowser = path.join(ROOT, 'utils', 'etravBrowser.js');
if (!fs.existsSync(dstLogin)) {
  fs.copyFileSync(srcLogin, dstLogin);
  // Fix relative requires since the file moved up one directory
  let c = read(dstLogin);
  c = c.replace(/require\(['"]\.\.\/config\//g, "require('../config/")
       .replace(/require\(['"]\.\.\/utils\//g, "require('./");
  write(dstLogin, c);
  console.log('PASS  copied login.js -> utils/etravLogin.js');
} else {
  console.log('SKIP  utils/etravLogin.js already exists');
}
if (!fs.existsSync(dstBrowser)) {
  fs.copyFileSync(srcBrowser, dstBrowser);
  let c = read(dstBrowser);
  c = c.replace(/require\(['"]\.\.\/config\//g, "require('../config/")
       .replace(/require\(['"]\.\.\/utils\//g, "require('./");
  write(dstBrowser, c);
  console.log('PASS  copied browser.js -> utils/etravBrowser.js');
} else {
  console.log('SKIP  utils/etravBrowser.js already exists');
}

// 2) Update all importers to use the new location
const importers = [
  'engine3-searchpulse/searchPulseEngine.js',
  'engine3-searchpulse/cmtTrialRun.js',
  'engine5-ecd/ecdEngine.js',
  'engine6-mirror/mirrorEngine.js',
];
let totalRewrites = 0;
for (const rel of importers) {
  const p = path.join(ROOT, rel);
  let c = read(p);
  const before = c;
  c = c
    .replace(/require\(['"]\.\.\/engine2-journey\/login['"]\)/g, "require('../utils/etravLogin')")
    .replace(/require\(['"]\.\.\/engine2-journey\/browser['"]\)/g, "require('../utils/etravBrowser')");
  if (c !== before) {
    write(p, c);
    totalRewrites++;
    console.log('PASS  rewrote imports in ' + rel);
  } else {
    console.log('SKIP  no changes needed in ' + rel + ' (already migrated?)');
  }
}

console.log('---');
console.log('Phase 2 complete. ' + totalRewrites + ' files migrated.');
console.log('Next: verify all updated files still load with `node -e "require(\\\"./...\\\")".');
