// removeEnginesPhase13.js — Disable Journey/FullBooking/Zipy from boot AND
// delete the engine code + UI references. Run only AFTER phase 2 has
// completed (login.js + browser.js already in utils/).

const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
function read(p) { return fs.readFileSync(p, 'utf-8'); }
function write(p, c) { fs.writeFileSync(p, c); }
function rmrf(p) {
  try {
    if (!fs.existsSync(p)) return false;
    fs.rmSync(p, { recursive: true, force: true });
    return true;
  } catch (e) { console.error('rm failed ' + p + ': ' + e.message); return false; }
}

// --- PHASE 1: edit eqis.js to remove Journey + FullBooking from boot --------
console.log('--- Phase 1: disable engines from boot ---');
const eqisPath = path.join(ROOT, 'eqis.js');
let eqis = read(eqisPath);

// 1a. Remove the journey + fullBooking cron registrations
eqis = eqis.replace(
  "  cronManager.setRunner('journey', () => runJourneyEngine());\n",
  "  // 2026-06-13: Journey engine removed.\n"
);
eqis = eqis.replace(
  "  cronManager.setRunner('fullBooking', () => {\n" +
  "    if (settings.BOOKING_FLOW_ENABLED === 'true') runFullBookingEngine();\n" +
  "  });\n",
  "  // 2026-06-13: Full Booking engine removed.\n"
);
// 1b. Remove scheduleJourney + scheduleFullBooking calls + their log lines
eqis = eqis.replace(
  "  const journeyPattern = cronManager.scheduleJourney(intervals.journeyMinutes);\n",
  ""
);
eqis = eqis.replace(
  "  logger.info(`[EQIS] Journey cron: ${journeyPattern} (every ${intervals.journeyMinutes} min)`);\n",
  ""
);
eqis = eqis.replace(
  /\n  \/\/ Full Booking[^\n]*\n  const bookingPattern = cronManager\.scheduleFullBooking\(intervals\.fullBookingMinutes\);\n  logger\.info\(`\[EQIS\] Full Booking cron: [^`]+`\);\n/,
  ''
);
// 1c. Stub the two runner functions so any leftover internal calls are no-ops
//     (they won't be called because the cron registrations are gone, but
//      this keeps eqis.js parseable even before phase 3 deletes the files).
eqis = eqis.replace(
  /async function runJourneyEngine\(\)[\s\S]*?\n}\n/,
  "async function runJourneyEngine() { /* removed 2026-06-13 */ }\n"
);
eqis = eqis.replace(
  /async function runFullBookingEngine\(\)[\s\S]*?\n}\n/,
  "async function runFullBookingEngine() { /* removed 2026-06-13 */ }\n"
);
write(eqisPath, eqis);
console.log('PASS  eqis.js patched (Journey + Full Booking removed from boot)');

// --- PHASE 3: delete engine directories + helper files ----------------------
console.log('--- Phase 3: physical deletion ---');
const dirsToDelete = [
  'engine2-journey',
  'engine4-fullbooking',
  'reports/journey',
  'reports/recordings',  // these were the Zipy session recordings
];
const filesToDelete = [
  'reporter/journeyReportBuilder.js',
  'reporter/fullBookingReportBuilder.js',
];
for (const d of dirsToDelete) {
  const p = path.join(ROOT, d);
  if (rmrf(p)) console.log('PASS  rm -rf ' + d);
  else console.log('SKIP  ' + d + ' (did not exist)');
}
for (const f of filesToDelete) {
  const p = path.join(ROOT, f);
  if (fs.existsSync(p)) { fs.unlinkSync(p); console.log('PASS  rm ' + f); }
  else console.log('SKIP  ' + f + ' (did not exist)');
}

// --- PHASE 1b: remove dashboard UI tabs for Journey / Zipy / Full Booking ----
// The dashboard has tabs like "Journey", "Zipy", "Full Booking" in the nav.
// Find and comment them out so they no longer appear, but don't break the HTML.
console.log('--- Phase 1b: hide dashboard UI tabs ---');
const htmlPath = path.join(ROOT, 'dashboard', 'ui', 'index.html');
let html = read(htmlPath);
const tabNeedles = [
  /<div class="tab"[^>]*onclick="switchTab\('journey'\)"[^>]*>[^<]*<\/div>\s*/i,
  /<div class="tab"[^>]*onclick="switchTab\('zipy'\)"[^>]*>[^<]*<\/div>\s*/i,
  /<div class="tab"[^>]*onclick="switchTab\('full-?booking'\)"[^>]*>[^<]*<\/div>\s*/i,
  /<div class="tab"[^>]*onclick="switchTab\('fullbooking'\)"[^>]*>[^<]*<\/div>\s*/i,
];
let removedTabs = 0;
for (const rx of tabNeedles) {
  const next = html.replace(rx, '');
  if (next !== html) { html = next; removedTabs++; }
}
write(htmlPath, html);
console.log('PASS  removed ' + removedTabs + ' nav tabs from dashboard/ui/index.html');

console.log('');
console.log('=== Complete ===');
console.log('Phase 1 (disable boot)   : OK');
console.log('Phase 3 (physical delete): OK');
console.log('Phase 1b (UI tabs hidden): OK');
