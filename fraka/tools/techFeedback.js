// Read/append tech feedback notes submitted via the Tech dashboard.
const fs = require('fs');
const path = require('path');
const logger = require('../../utils/logger');

const FEEDBACK_PATH = path.join(__dirname, '..', '..', 'state', 'fraka', 'techFeedback.json');

function loadFeedback() {
  try { return JSON.parse(fs.readFileSync(FEEDBACK_PATH, 'utf-8')); } catch { return []; }
}

function saveFeedback(list) {
  fs.writeFileSync(FEEDBACK_PATH, JSON.stringify(list, null, 2));
}

function appendFeedback(note, author = 'tech') {
  const list = loadFeedback();
  const entry = {
    id: 'FB-' + Date.now().toString(36),
    note,
    author,
    timestamp: new Date().toISOString(),
    status: 'open',
  };
  list.push(entry);
  // Trim to last 200
  const trimmed = list.slice(-200);
  saveFeedback(trimmed);
  logger.info(`[FRAKA] Tech feedback added: ${entry.id}`);
  return entry;
}

function getRecentFeedback(count = 20) {
  const list = loadFeedback();
  return list.slice(-count);
}

module.exports = { appendFeedback, getRecentFeedback, loadFeedback };
