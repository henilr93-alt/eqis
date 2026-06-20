// fixRemainingRefs.js — Clean up stale references to engine2-journey and
// engine4-fullbooking that survived the bulk deletion.

const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
function read(p) { return fs.readFileSync(p, 'utf-8'); }
function write(p, c) { fs.writeFileSync(p, c); }

// 1) utils/sessionRecorder.js:99 — runtime require, P0 for SearchPulse
//    Switch to the relocated utils/etravLogin.
const srP = path.join(ROOT, 'utils', 'sessionRecorder.js');
let sr = read(srP);
sr = sr.replace(
  "require('../engine2-journey/login')",
  "require('./etravLogin')"
);
write(srP, sr);
console.log('PASS  utils/sessionRecorder.js patched');

// 2) fraka/tools/engineControl.js — top-level requires to deleted modules.
//    Replace the requires with no-op stubs so anything that calls them
//    just gets a harmless object.
const ecP = path.join(ROOT, 'fraka/tools/engineControl.js');
let ec = read(ecP);
ec = ec
  .replace(
    "const JourneyEngine = require('../../engine2-journey/journeyEngine');\n",
    "const JourneyEngine = { /* removed 2026-06-13 */ runJourneyEngine: async () => ({ removed: true }) };\n"
  )
  .replace(
    "const FullBookingEngine = require('../../engine4-fullbooking/fullBookingEngine');\n",
    "const FullBookingEngine = { /* removed 2026-06-13 */ runFullBookingEngine: async () => ({ removed: true }) };\n"
  );
write(ecP, ec);
console.log('PASS  fraka/tools/engineControl.js stubbed');

// 3) fraka/systemPrompt.js — text references only; remove the Journey/Full Booking
//    bullets so FRAKA doesn't keep talking about them.
const spP = path.join(ROOT, 'fraka/systemPrompt.js');
let sp = read(spP);
const before = sp;
sp = sp
  .replace(/- Engine 2 — Journey Test.*\n/g, '')
  .replace(/- Engine 4 — Full Booking.*\n/g, '')
  .replace(/.*engine2-journey\/.*\n/g, '')
  .replace(/.*engine4-fullbooking\/.*\n/g, '');
write(spP, sp);
console.log('PASS  fraka/systemPrompt.js cleaned (' + (before.length - sp.length) + ' bytes removed)');

// 4) Re-delete reports/journey + reports/recordings if recreated, but be
//    careful — sessionRecorder writes BOTH SearchPulse + Journey there.
//    Just delete the journey reports; leave recordings for SearchPulse.
const jr = path.join(ROOT, 'reports/journey');
if (fs.existsSync(jr)) { fs.rmSync(jr, { recursive: true, force: true }); console.log('PASS  reports/journey/ deleted (was recreated)'); }
console.log('NOTE  reports/recordings kept — SearchPulse session recorder still uses it');
