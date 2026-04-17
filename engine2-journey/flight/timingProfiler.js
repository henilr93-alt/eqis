const logger = require('../../utils/logger');

const TIMING_THRESHOLDS = {
  apiLatency: {
    fast: { max: 1500, label: 'FAST', color: '#34C759' },
    acceptable: { max: 3000, label: 'ACCEPTABLE', color: '#FFCC00' },
    slow: { max: 6000, label: 'SLOW', color: '#FF9500', bugSeverity: 'P2' },
    critical: { max: Infinity, label: 'CRITICAL', color: '#FF3B30', bugSeverity: 'P1' },
  },
  foldRender: {
    fast: { max: 500, label: 'FAST', color: '#34C759' },
    acceptable: { max: 1500, label: 'ACCEPTABLE', color: '#FFCC00' },
    slow: { max: 3000, label: 'SLOW', color: '#FF9500', bugSeverity: 'P2' },
    critical: { max: Infinity, label: 'CRITICAL', color: '#FF3B30', bugSeverity: 'P1' },
  },
  fullPage: {
    fast: { max: 3000, label: 'FAST', color: '#34C759' },
    acceptable: { max: 6000, label: 'ACCEPTABLE', color: '#FFCC00' },
    slow: { max: 10000, label: 'SLOW', color: '#FF9500', bugSeverity: 'P1' },
    critical: { max: Infinity, label: 'CRITICAL', color: '#FF3B30', bugSeverity: 'P0' },
  },
  filterReady: {
    fast: { max: 4000, label: 'FAST', color: '#34C759' },
    acceptable: { max: 7000, label: 'ACCEPTABLE', color: '#FFCC00' },
    slow: { max: Infinity, label: 'SLOW', color: '#FF9500', bugSeverity: 'P2' },
  },
};

const INTL_THRESHOLD_MULTIPLIER = 1.2;

async function profileSearchTiming(page, scenario, t0) {
  const isIntl = scenario.type === 'international';
  const multiplier = isIntl ? INTL_THRESHOLD_MULTIPLIER : 1.0;

  const timing = {
    scenarioId: scenario.id,
    routeLabel: scenario.label,
    isInternational: isIntl,
    t0,
    stages: {},
    derived: {},
    classification: {},
    autoBugs: [],
    networkRequests: [],
  };

  // T3: first result card in DOM
  try {
    const t3Start = Date.now();
    await page.waitForSelector(
      '[class*="flight-card"], [class*="result-item"], [data-testid="flight-result"]',
      { timeout: 15000 }
    );
    timing.stages.firstCardMs = Date.now() - t3Start;
    timing.derived.foldRenderMs = timing.stages.firstCardMs;
  } catch {
    timing.stages.firstCardMs = null;
    timing.autoBugs.push({
      id: 'TIMING-NO-RESULTS',
      severity: 'P0',
      title: 'No flight results appeared within 15 seconds',
      description: `Search for ${scenario.from}-${scenario.to} returned no visible results within timeout`,
      devFixRequired: 'Check search API response and result rendering pipeline',
    });
  }

  // T4: count cards
  await page.waitForTimeout(800);
  try {
    const cardCount = await page.$$eval(
      '[class*="flight-card"], [class*="result-item"]',
      els => els.length
    );
    timing.stages.totalCardsLoaded = cardCount;
  } catch {
    timing.stages.totalCardsLoaded = 0;
  }

  // T5: filter panel interactive
  try {
    const filterStart = Date.now();
    await page.waitForSelector(
      '[class*="filter-panel"], [class*="filters"], [data-testid="filters"]',
      { timeout: 10000 }
    );
    timing.stages.filterReadyMs = Date.now() - filterStart;
    timing.derived.filterReadyMs = timing.stages.filterReadyMs;
  } catch {
    timing.stages.filterReadyMs = null;
  }

  // T6: full idle
  await page.waitForLoadState('networkidle');
  timing.stages.fullPageMs = Date.now() - t0;
  timing.derived.fullPageMs = timing.stages.fullPageMs;

  // Classify each metric
  timing.classification = classifyTiming(timing.derived, multiplier);

  // Auto-generate bugs from thresholds
  for (const [metric, result] of Object.entries(timing.classification)) {
    if (result.bugSeverity) {
      timing.autoBugs.push({
        id: `TIMING-${metric.toUpperCase()}`,
        severity: result.bugSeverity,
        title: `${result.label} ${metric}: ${timing.derived[metric + 'Ms']}ms`,
        description: `${isIntl ? 'International' : 'Domestic'} route ${scenario.from}-${scenario.to}. ${metric} took ${timing.derived[metric + 'Ms']}ms, threshold: ${Math.round(result.max * multiplier)}ms`,
        devFixRequired: getTimingFixGuidance(metric),
        measuredMs: timing.derived[metric + 'Ms'],
        thresholdMs: Math.round(result.max * multiplier),
      });
    }
  }

  logger.info(`[TIMING] ${scenario.from}-${scenario.to}: fullPage=${timing.derived.fullPageMs}ms, firstCard=${timing.stages.firstCardMs}ms, cards=${timing.stages.totalCardsLoaded}`);
  return timing;
}

function classifyTiming(derived, multiplier) {
  const result = {};
  for (const [metric, thresholds] of Object.entries(TIMING_THRESHOLDS)) {
    const ms = derived[metric + 'Ms'];
    if (ms == null) continue;
    for (const [, t] of Object.entries(thresholds)) {
      if (ms <= t.max * multiplier) {
        result[metric] = { level: t.label, label: t.label, color: t.color, bugSeverity: t.bugSeverity || null, max: t.max };
        break;
      }
    }
  }
  return result;
}

function getTimingFixGuidance(metric) {
  const guidance = {
    apiLatency: 'Profile search API endpoint. Check GDS/supplier timeout config, caching layer, connection pooling.',
    foldRender: 'Profile React render pipeline. Check if result cards are virtualized. Reduce initial render batch size.',
    fullPage: 'Audit total network waterfall. Check for render-blocking scripts, unoptimized images in result cards.',
    filterReady: 'Filter panel should render from static config, not wait for API. Load filter options client-side immediately.',
  };
  return guidance[metric] || 'Profile the specific pipeline stage and optimize.';
}

function timingToHtml(timing) {
  if (!timing) return '';
  const rows = Object.entries(timing.derived).map(([metric, ms]) => {
    const cls = timing.classification[metric.replace('Ms', '')] || {};
    return `<tr>
      <td>${metric.replace('Ms', '')}</td>
      <td style="color:${cls.color || '#888'};">${ms}ms</td>
      <td><span style="color:${cls.color || '#888'};">${cls.label || 'N/A'}</span></td>
    </tr>`;
  }).join('');

  return `<table><thead><tr><th>Metric</th><th>Value</th><th>Classification</th></tr></thead><tbody>${rows}</tbody></table>`;
}

module.exports = { profileSearchTiming, timingToHtml, TIMING_THRESHOLDS, INTL_THRESHOLD_MULTIPLIER };
