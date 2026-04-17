const fs = require('fs');
const path = require('path');
const logger = require('./logger');
const { getLocalTimestamp } = require('./timezone');

const METRICS_PATH = path.join(__dirname, '..', 'state', 'metricsHistory.json');
const MAX_ENTRIES = 2000; // ~30 days at 96 pulses/day

async function writeMetrics(entry) {
  try {
    let history = [];
    try {
      const raw = fs.readFileSync(METRICS_PATH, 'utf-8');
      history = JSON.parse(raw);
    } catch { /* start fresh */ }

    history.push({
      timestamp: getLocalTimestamp(),
      ...entry,
    });

    if (history.length > MAX_ENTRIES) {
      history = history.slice(-MAX_ENTRIES);
    }

    fs.writeFileSync(METRICS_PATH, JSON.stringify(history));
    logger.info(`[METRICS] Entry written. Total entries: ${history.length}`);
  } catch (err) {
    logger.error(`[METRICS] Write failed: ${err.message}`);
  }
}

module.exports = { writeMetrics };
