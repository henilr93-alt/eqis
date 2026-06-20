// Patch roster: tech team -> 4 real recipients + shift digest window to PREVIOUS day.
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');

// 1) Roster update
const rosterPath = path.join(ROOT, 'state/emailRoster.json');
const roster = JSON.parse(fs.readFileSync(rosterPath, 'utf-8'));
const tech = (roster.teams || []).find(t => t.id === 'tech');
if (!tech) { console.error('tech team not in roster'); process.exit(1); }
tech.emails = [
  'alpesh.p@etrav.in',
  'kavin.p@codemagen.com',
  'frank@codemagen.com',
  'director@etrav.in',
];
tech.notes = "SearchPulse daily performance — sent at 9am IST every day covering the PREVIOUS day's data.";
fs.writeFileSync(rosterPath, JSON.stringify(roster, null, 2));
console.log('OK: roster tech.emails set to ' + tech.emails.join(', '));

// 2) Shift gatherSpfData to previous-day window
const schedPath = path.join(ROOT, 'utils/dailyDigestScheduler.js');
let sched = fs.readFileSync(schedPath, 'utf-8');

const oldWindow = `function gatherSpfData() {
  const logDir = path.join(__dirname, '..', 'logs');
  const todayPath = path.join(logDir, 'eqis-' + _isoDayOffset(0) + '.log');
  const yestPath  = path.join(logDir, 'eqis-' + _isoDayOffset(-1) + '.log');

  let today, yesterday;
  try { today = _parseSearchPulseLog(todayPath); }
  catch (e) { logger.warn('[DIGEST] today log parse failed: ' + e.message); today = {}; }
  try { yesterday = _parseSearchPulseLog(yestPath); }
  catch (e) { logger.warn('[DIGEST] yesterday log parse failed: ' + e.message); yesterday = {}; }`;

const newWindow = `function gatherSpfData() {
  const logDir = path.join(__dirname, '..', 'logs');
  // 2026-06-12: digest now covers the PREVIOUS day (sent at 9am IST about
  // the day before), so the team sees the full closed window and not a
  // half-baked still-running day. Trend comparison uses day-before-previous.
  const todayPath = path.join(logDir, 'eqis-' + _isoDayOffset(-1) + '.log');
  const yestPath  = path.join(logDir, 'eqis-' + _isoDayOffset(-2) + '.log');

  let today, yesterday;
  try { today = _parseSearchPulseLog(todayPath); }
  catch (e) { logger.warn('[DIGEST] previous-day log parse failed: ' + e.message); today = {}; }
  try { yesterday = _parseSearchPulseLog(yestPath); }
  catch (e) { logger.warn('[DIGEST] day-before-previous log parse failed: ' + e.message); yesterday = {}; }`;

if (!sched.includes(oldWindow)) {
  console.error('Could not find gatherSpfData window block.');
  process.exit(1);
}
sched = sched.replace(oldWindow, newWindow);
fs.writeFileSync(schedPath, sched);
console.log('OK: gatherSpfData now reads yesterdays log as the main data source.');
