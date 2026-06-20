// Insert Review-tab API route registration into dashboard/server.js between
// the History and Supplier Health blocks.
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const serverPath = path.join(ROOT, 'dashboard', 'server.js');
let src = fs.readFileSync(serverPath, 'utf-8');

const needle = '  // Supplier Health tab — Flight INTL airline filter trends';
const insert = '  // Review tab — Flight INTL Review Pulse (engine 8). Placed between\n  // History and Supplier Health per CEO request 2026-06-13.\n' +
  "  const reviewApi = require('./api/reviewApi');\n" +
  "  app.get('/api/review/status',   reviewApi.reviewStatusApi);\n" +
  "  app.get('/api/review/today',    reviewApi.reviewTodayApi);\n" +
  "  app.get('/api/review/history',  reviewApi.reviewHistoryApi);\n" +
  "  app.get('/api/review/failures', reviewApi.reviewFailuresApi);\n" +
  "  app.get('/api/review/rotation', reviewApi.reviewRotationApi);\n\n";

if (src.indexOf(needle) === -1) {
  console.error('Insertion anchor not found');
  process.exit(1);
}
if (src.indexOf("require('./api/reviewApi')") !== -1) {
  console.log('Already patched - skipping');
  process.exit(0);
}
src = src.replace(needle, insert + needle);
fs.writeFileSync(serverPath, src);
console.log('OK: dashboard/server.js patched with Review routes');
