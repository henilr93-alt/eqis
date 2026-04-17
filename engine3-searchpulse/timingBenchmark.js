const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger');

const HISTORY_PATH = path.join(__dirname, '..', 'state', 'timingHistory.json');

function loadHistory() {
  try {
    if (!fs.existsSync(HISTORY_PATH)) return [];
    return JSON.parse(fs.readFileSync(HISTORY_PATH, 'utf-8'));
  } catch { return []; }
}

function saveHistory(history) {
  // Keep last 48 entries (24 hours at 15-min intervals)
  const trimmed = history.slice(-48);
  fs.writeFileSync(HISTORY_PATH, JSON.stringify(trimmed, null, 2));
}

async function benchmarkTiming(currentTimings) {
  const history = loadHistory();

  const result = {
    improved: [],
    degraded: [],
    stable: [],
    newRoutes: [],
  };

  for (const timing of currentTimings) {
    const route = timing.routeLabel || timing.scenarioId;
    const fullPageMs = timing.derived?.fullPageMs;
    if (!fullPageMs) continue;

    // Find historical data for this route
    const historicalForRoute = history
      .filter(h => h.route === route)
      .map(h => h.fullPageMs);

    if (historicalForRoute.length === 0) {
      result.newRoutes.push({ route, currentMs: fullPageMs });
      continue;
    }

    const avg = historicalForRoute.reduce((a, b) => a + b, 0) / historicalForRoute.length;
    const pctChange = ((fullPageMs - avg) / avg) * 100;

    if (pctChange > 20) {
      result.degraded.push({ route, currentMs: fullPageMs, avgMs: Math.round(avg), pctChange: Math.round(pctChange) });
    } else if (pctChange < -20) {
      result.improved.push({ route, currentMs: fullPageMs, avgMs: Math.round(avg), pctChange: Math.round(pctChange) });
    } else {
      result.stable.push({ route, currentMs: fullPageMs, avgMs: Math.round(avg) });
    }
  }

  // Save current timings to history
  for (const timing of currentTimings) {
    history.push({
      route: timing.routeLabel || timing.scenarioId,
      fullPageMs: timing.derived?.fullPageMs || 0,
      timestamp: new Date().toISOString(),
    });
  }
  saveHistory(history);

  if (result.degraded.length > 0) {
    logger.warn(`[BENCHMARK] ${result.degraded.length} routes degraded >20%`);
  }

  return result;
}

function benchmarkToHtml(benchmark) {
  if (!benchmark) return '';
  let html = '';

  if (benchmark.degraded.length > 0) {
    html += '<h4 style="color:#FF3B30;">Degraded Routes</h4><ul>';
    for (const d of benchmark.degraded) {
      html += `<li style="color:#FF9500;">${d.route}: ${d.currentMs}ms (avg: ${d.avgMs}ms, +${d.pctChange}%)</li>`;
    }
    html += '</ul>';
  }

  if (benchmark.improved.length > 0) {
    html += '<h4 style="color:#34C759;">Improved Routes</h4><ul>';
    for (const i of benchmark.improved) {
      html += `<li style="color:#34C759;">${i.route}: ${i.currentMs}ms (avg: ${i.avgMs}ms, ${i.pctChange}%)</li>`;
    }
    html += '</ul>';
  }

  if (benchmark.degraded.length === 0 && benchmark.improved.length === 0) {
    html += '<p style="color:#888;">All routes within normal timing range.</p>';
  }

  return html;
}

module.exports = { benchmarkTiming, benchmarkToHtml };
