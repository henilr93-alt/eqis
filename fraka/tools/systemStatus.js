// Returns a compact blob describing the current EQIS state.
// Used by agent.js and reviewer.js to inject into Claude prompts.
const fs = require('fs');
const path = require('path');

const SYSTEM_STATE_PATH = path.join(__dirname, '..', '..', 'state', 'systemState.json');

function readJson(filePath) {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf-8')); } catch { return null; }
}

function getSystemStatus() {
  const state = readJson(SYSTEM_STATE_PATH) || {};
  let engineStates = {};
  let intervals = {};
  let cronPatterns = {};

  try {
    const cronManager = require('../../utils/cronManager');
    engineStates = cronManager.getEngineStates();
    intervals = cronManager.getIntervals();
    cronPatterns = cronManager.getCronPatterns();
  } catch { /* running outside of process where cronManager isn't loaded */ }

  const searchSignal = readJson(path.join(__dirname, '..', '..', 'state', 'searchQualitySignal.json')) || {};

  return {
    systemStatus: state.status || 'unknown',
    startedAt: state.startedAt || null,
    lastRuns: {
      searchPulse: state.lastSearchPulseRun || null,
      journey: state.lastJourneyRun || null,
      zipy: state.lastZipyRun || null,
      fullBooking: state.lastFullBookingRun || null,
    },
    totals: {
      searchPulse: state.totalSearchPulseRuns || 0,
      journey: state.totalJourneyRuns || 0,
      zipy: state.totalZipyRuns || 0,
      fullBooking: state.totalFullBookingRuns || 0,
    },
    engineStates,
    intervals,
    cronPatterns,
    currentSearchHealth: state.currentSearchHealth || searchSignal.overallHealth || 'UNKNOWN',
    apiHealthSignals: searchSignal.apiHealthSignals || [],
    timestamp: new Date().toISOString(),
  };
}

module.exports = { getSystemStatus };
