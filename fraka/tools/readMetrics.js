// Reads metricsHistory.json and produces summarized metrics for a time window.
const fs = require('fs');
const path = require('path');

const METRICS_PATH = path.join(__dirname, '..', '..', 'state', 'metricsHistory.json');

function loadHistory() {
  try { return JSON.parse(fs.readFileSync(METRICS_PATH, 'utf-8')); } catch { return []; }
}

/**
 * Read metrics from the last N hours and compute compact summaries per engine.
 * @param {number} hours
 */
function readMetrics(hours = 1) {
  const history = loadHistory();
  const cutoff = new Date(Date.now() - hours * 3600 * 1000);
  const recent = history.filter(e => new Date(e.timestamp) >= cutoff);

  const summary = {
    window: `last_${hours}h`,
    totalEntries: recent.length,
    engines: {
      searchPulse: summariseEngine(recent.filter(e => e.engineType === 'searchpulse'), 'searchpulse'),
      journey: summariseEngine(recent.filter(e => e.engineType === 'journey'), 'journey'),
      zipy: summariseEngine(recent.filter(e => e.engineType === 'zipy'), 'zipy'),
      fullBooking: summariseEngine(recent.filter(e => e.engineType === 'fullbooking'), 'fullbooking'),
    },
  };
  return summary;
}

function summariseEngine(entries, engineType) {
  if (entries.length === 0) {
    return { runs: 0, tokensUsed: 0, apiCalls: 0, lastTimestamp: null };
  }

  const base = {
    runs: entries.length,
    tokensInput: entries.reduce((s, e) => s + (e.tokensInput || 0), 0),
    tokensOutput: entries.reduce((s, e) => s + (e.tokensOutput || 0), 0),
    tokensUsed: entries.reduce((s, e) => s + (e.tokensUsed || 0), 0),
    apiCalls: entries.reduce((s, e) => s + (e.apiCalls || 0), 0),
    lastTimestamp: entries[entries.length - 1].timestamp,
  };

  if (engineType === 'searchpulse') {
    const healthBreakdown = {};
    for (const e of entries) {
      const h = e.overallHealth || 'UNKNOWN';
      healthBreakdown[h] = (healthBreakdown[h] || 0) + 1;
    }
    return {
      ...base,
      healthBreakdown,
      avgLoadTimeMs: Math.round(entries.reduce((s, e) => s + (e.avgLoadTimeMs || 0), 0) / entries.length),
      avgFilterPassRate: Math.round(entries.reduce((s, e) => s + (e.filterPassRate || 0), 0) / entries.length),
      zeroResultRoutes: [...new Set(entries.flatMap(e => e.zeroResultRoutes || []))],
      totalApiErrors: entries.reduce((s, e) => s + (e.apiErrors || 0), 0),
    };
  }

  if (engineType === 'journey') {
    return {
      ...base,
      statusBreakdown: entries.reduce((acc, e) => {
        const s = e.overallStatus || 'UNKNOWN';
        acc[s] = (acc[s] || 0) + 1;
        return acc;
      }, {}),
      bugsP0: entries.reduce((s, e) => s + (e.bugsP0 || 0), 0),
      bugsP1: entries.reduce((s, e) => s + (e.bugsP1 || 0), 0),
      bugsP2: entries.reduce((s, e) => s + (e.bugsP2 || 0), 0),
      bugsP3: entries.reduce((s, e) => s + (e.bugsP3 || 0), 0),
      uxIssues: entries.reduce((s, e) => s + (e.uxIssues || 0), 0),
      avgDurationMs: Math.round(entries.reduce((s, e) => s + (e.durationMs || 0), 0) / entries.length),
    };
  }

  if (engineType === 'zipy') {
    const latest = entries[entries.length - 1] || {};
    return {
      ...base,
      latest: {
        sessionsHarvested: latest.sessionsHarvested,
        sessionsAnalyzed: latest.sessionsAnalyzed,
        uniqueBugsFound: latest.uniqueBugsFound,
        systemicBugs: latest.systemicBugs,
        completionRate: latest.completionRate,
        errorRate: latest.errorRate,
      },
    };
  }

  return base;
}

module.exports = { readMetrics };
