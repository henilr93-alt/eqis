const fs = require('fs');
const path = require('path');

const METRICS_PATH = path.join(__dirname, '..', '..', 'state', 'metricsHistory.json');

function readMetricsHistory() {
  try {
    return JSON.parse(fs.readFileSync(METRICS_PATH, 'utf-8'));
  } catch { return []; }
}

function metricsApi(req, res) {
  try {
    const history = readMetricsHistory();
    // Support from/to date range OR days-based filtering
    let filtered;
    if (req.query.from || req.query.to) {
      const fromDate = req.query.from ? new Date(req.query.from + 'T00:00:00') : new Date(0);
      const toDate = req.query.to ? new Date(req.query.to + 'T23:59:59') : new Date();
      filtered = history.filter(e => { const t = new Date(e.timestamp); return t >= fromDate && t <= toDate; });
    } else {
      const days = parseInt(req.query.days) || 7;
      const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
      filtered = history.filter(e => new Date(e.timestamp) >= cutoff);
    }

    res.json({
      searchHealthTimeline: buildHealthTimeline(filtered),
      loadTimeTimeline: buildLoadTimeTimeline(filtered),
      bugsPerDay: buildBugsPerDay(filtered),
      bugSeverityPie: buildBugSeverityPie(filtered),
      scenarioTypePie: buildScenarioTypePie(filtered),
      filterPassRate: buildFilterPassRate(filtered),
      topRoutesBar: buildTopRoutes(filtered),
      overallHealthDonut: buildOverallHealthDonut(filtered),
      tokenUsageTimeline: buildTokenUsageTimeline(filtered),
      searchPulseCriticalAlerts: buildSearchPulseCriticalAlerts(filtered),
      searchPulsePerformance: buildSearchPulsePerformance(filtered),
      meta: {
        totalRuns: filtered.length,
        daysRequested: parseInt(req.query.days) || (req.query.from ? 'custom' : 7),
        from: req.query.from || null,
        to: req.query.to || null,
        oldestEntry: filtered[0]?.timestamp || null,
        newestEntry: filtered[filtered.length - 1]?.timestamp || null,
      },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

function buildHealthTimeline(entries) {
  const pulseEntries = entries.filter(e => e.engineType === 'searchpulse');
  return {
    labels: pulseEntries.map(e => formatTime(e.timestamp)),
    datasets: [{
      label: 'Search Health',
      data: pulseEntries.map(e => healthToScore(e.overallHealth)),
      borderColor: '#1A73E8',
      backgroundColor: 'rgba(26,115,232,0.1)',
      tension: 0.3,
    }],
  };
}

function buildLoadTimeTimeline(entries) {
  const pulseEntries = entries.filter(e => e.engineType === 'searchpulse' && e.avgLoadTimeMs);
  return {
    labels: pulseEntries.map(e => formatTime(e.timestamp)),
    datasets: [
      {
        label: 'Avg Load Time (ms)',
        data: pulseEntries.map(e => e.avgLoadTimeMs),
        borderColor: '#FF9500',
        tension: 0.3,
      },
      {
        label: 'Threshold (5000ms)',
        data: pulseEntries.map(() => 5000),
        borderColor: '#FF3B30',
        borderDash: [5, 5],
        pointRadius: 0,
      },
    ],
  };
}

function buildBugsPerDay(entries) {
  const journeyEntries = entries.filter(e => e.engineType === 'journey');
  const byDay = groupByDay(journeyEntries);
  return {
    labels: Object.keys(byDay),
    datasets: [
      { label: 'P0', data: Object.values(byDay).map(d => d.p0 || 0), backgroundColor: '#FF3B30' },
      { label: 'P1', data: Object.values(byDay).map(d => d.p1 || 0), backgroundColor: '#FF9500' },
      { label: 'P2', data: Object.values(byDay).map(d => d.p2 || 0), backgroundColor: '#FFCC00' },
      { label: 'P3', data: Object.values(byDay).map(d => d.p3 || 0), backgroundColor: '#34AADC' },
    ],
  };
}

function buildBugSeverityPie(entries) {
  const journeyEntries = entries.filter(e => e.engineType === 'journey');
  const totals = { P0: 0, P1: 0, P2: 0, P3: 0 };
  for (const e of journeyEntries) {
    totals.P0 += e.bugsP0 || 0;
    totals.P1 += e.bugsP1 || 0;
    totals.P2 += e.bugsP2 || 0;
    totals.P3 += e.bugsP3 || 0;
  }
  return {
    labels: ['P0 Critical', 'P1 High', 'P2 Medium', 'P3 Low'],
    datasets: [{
      data: [totals.P0, totals.P1, totals.P2, totals.P3],
      backgroundColor: ['#FF3B30', '#FF9500', '#FFCC00', '#34AADC'],
      borderWidth: 0,
    }],
  };
}

function buildScenarioTypePie(entries) {
  const journeyEntries = entries.filter(e => e.engineType === 'journey');
  const counts = { domestic: 0, international: 0, roundtrip: 0, mirror: 0, dynamic: 0 };
  for (const e of journeyEntries) {
    if (e.scenarioSource === 'session_mirror') counts.mirror++;
    else if (e.flightType === 'domestic') counts.domestic++;
    else if (e.flightType === 'international') counts.international++;
    if (e.tripType === 'round-trip' || e.tripType === 'open-jaw') counts.roundtrip++;
  }
  return {
    labels: ['Domestic', 'International', 'Roundtrip', 'Mirror', 'Trend-Driven'],
    datasets: [{
      data: Object.values(counts),
      backgroundColor: ['#34C759', '#1A73E8', '#FF9500', '#AF52DE', '#FF2D55'],
      borderWidth: 0,
    }],
  };
}

function buildFilterPassRate(entries) {
  const pulseEntries = entries.filter(e => e.engineType === 'searchpulse' && e.filterPassRate !== undefined);
  return {
    labels: pulseEntries.map(e => formatTime(e.timestamp)),
    datasets: [{
      label: 'Filter Pass Rate %',
      data: pulseEntries.map(e => e.filterPassRate),
      borderColor: '#34C759',
      backgroundColor: 'rgba(52,199,89,0.1)',
      tension: 0.3,
    }],
  };
}

function buildTopRoutes(entries) {
  const routeCounts = {};
  for (const e of entries.filter(en => en.engineType === 'journey' && en.route)) {
    routeCounts[e.route] = (routeCounts[e.route] || 0) + 1;
  }
  const sorted = Object.entries(routeCounts).sort((a, b) => b[1] - a[1]).slice(0, 10);
  return {
    labels: sorted.map(([route]) => route),
    datasets: [{
      label: 'Times Tested',
      data: sorted.map(([, count]) => count),
      backgroundColor: '#1A73E8',
      borderRadius: 4,
    }],
  };
}

function buildOverallHealthDonut(entries) {
  const journeyEntries = entries.filter(e => e.engineType === 'journey');
  const counts = { PASS: 0, WARN: 0, FAIL: 0 };
  for (const e of journeyEntries) {
    if (e.overallStatus === 'PASS') counts.PASS++;
    else if (e.overallStatus === 'WARN') counts.WARN++;
    else counts.FAIL++;
  }
  return {
    labels: ['Pass', 'Warn', 'Fail'],
    datasets: [{
      data: [counts.PASS, counts.WARN, counts.FAIL],
      backgroundColor: ['#34C759', '#FFCC00', '#FF3B30'],
      borderWidth: 0,
    }],
  };
}

function buildTokenUsageTimeline(entries) {
  const byDay = groupByDay(entries);
  return {
    labels: Object.keys(byDay),
    datasets: [{
      label: 'Total Tokens / Day',
      data: Object.values(byDay).map(d => d.totalTokens || 0),
      borderColor: '#AF52DE',
      backgroundColor: 'rgba(175,82,222,0.1)',
      tension: 0.3,
    }],
  };
}




function groupByDay(entries) {
  const byDay = {};
  for (const e of entries) {
    const day = e.timestamp?.slice(0, 10);
    if (!day) continue;
    if (!byDay[day]) byDay[day] = { p0: 0, p1: 0, p2: 0, p3: 0, totalTokens: 0, count: 0 };
    byDay[day].p0 += e.bugsP0 || 0;
    byDay[day].p1 += e.bugsP1 || 0;
    byDay[day].p2 += e.bugsP2 || 0;
    byDay[day].p3 += e.bugsP3 || 0;
    byDay[day].totalTokens += e.tokensUsed || 0;
    byDay[day].count++;
  }
  return byDay;
}

function formatTime(iso) {
  if (!iso) return '';
  return iso.slice(11, 16);
}

function healthToScore(health) {
  return { HEALTHY: 4, WARN: 3, DEGRADED: 2, CRITICAL: 1 }[health] || 0;
}



function buildSearchPulseCriticalAlerts(entries) {
  const pulseEntries = entries.filter(e => e.engineType === 'searchpulse');
  if (pulseEntries.length === 0) return { zeroResultRoutes: [], delayedRoutes: [], totalAlerts: 0 };
  
  // Aggregate zero-result and delayed routes across last 24h
  const zeroResults = [];
  const delayed = [];
  for (const e of pulseEntries) {
    if (e.zeroResultRoutes) {
      for (const route of e.zeroResultRoutes) {
        zeroResults.push({ route, timestamp: e.timestamp, severity: 'P0' });
      }
    }
    if (e.delayedRoutes) {
      for (const r of e.delayedRoutes) {
        delayed.push({ route: r.route, loadTimeMs: r.loadTimeMs, timestamp: e.timestamp, severity: 'P1' });
      }
    }
    if (e.criticalAlerts) {
      for (const a of e.criticalAlerts) {
        if (a.type === 'ZERO_RESULTS' && !zeroResults.find(z => z.route === a.route && z.timestamp === e.timestamp)) {
          zeroResults.push({ route: a.route, timestamp: e.timestamp, severity: 'P0' });
        }
        if (a.type === 'DELAYED_RESULTS' && !delayed.find(d => d.route === a.route && d.timestamp === e.timestamp)) {
          delayed.push({ route: a.route, loadTimeMs: a.loadTimeMs, timestamp: e.timestamp, severity: 'P1' });
        }
      }
    }
  }
  
  return {
    zeroResultRoutes: zeroResults.slice(-20),
    delayedRoutes: delayed.slice(-20),
    totalAlerts: zeroResults.length + delayed.length,
    latestHealth: pulseEntries[pulseEntries.length - 1]?.overallHealth || 'UNKNOWN',
  };
}

function buildSearchPulsePerformance(entries) {
  const pulseEntries = entries.filter(e => e.engineType === 'searchpulse');
  if (pulseEntries.length === 0) return null;

  // Collect all individual searches with type info
  const allSearches = { flightDom: [], flightIntl: [], hotelDom: [], hotelIntl: [] };

  for (const e of pulseEntries) {
    for (const s of (e.flightSearches || [])) {
      const key = (s.type === 'international') ? 'flightIntl' : 'flightDom';
      allSearches[key].push({ results: s.results || 0, loadTimeMs: s.loadTimeMs || 0, status: s.status, rating: s.rating });
    }
    for (const s of (e.hotelSearches || [])) {
      const key = (s.type === 'international') ? 'hotelIntl' : 'hotelDom';
      allSearches[key].push({ results: s.results || 0, loadTimeMs: s.loadTimeMs || 0, status: s.status, rating: s.rating });
    }
  }

  function calcStats(searches, mode) {
    // mode: 'flightDom', 'flightIntl', 'hotelDom', 'hotelIntl', or 'all'
    //
    // RULE (CEO 2026-05-30): SPF searches are EXCLUDED from every metric the
    // Performance tab shows for all 4 SearchPulse engines. SPF means the
    // automation failed to submit a real search — it is not an Etrav data
    // point, so counting it against engine performance is misleading. We
    // detect SPF via the engine's stored rating field (preserved through the
    // reduction above); if that field is missing, fall back to a status-based
    // check that matches computeSearchRating() in searchPulseEngine.js.
    const isSpf = (s) => {
      if (s.rating === 'SPF') return true;
      // Fallback for legacy entries without rating: AUTOMATION_* + zero-duration FAILED
      const st = s.status || '';
      if (st === 'AUTOMATION_DATE_INCOMPLETE' || st === 'AUTOMATION_FIELD_INCOMPLETE' || st === 'AUTOMATION_FORM_RESET') return true;
      if (st === 'FAILED' && (s.loadTimeMs || 0) === 0 && (s.results || 0) === 0) return true;
      return false;
    };
    const spfExcluded = searches.filter(isSpf).length;
    searches = searches.filter(s => !isSpf(s));
    if (searches.length === 0) return { total: 0, delayed: 0, delayPct: 0, failed: 0, failPct: 0, success: 0, successPct: 0, onTime: 0, onTimePct: 0, spfExcluded, ratings: { perfect: 0, median: 0, delay: 0, critical: 0, failure: 0 } };
    const total = searches.length;
    const delayed = searches.filter(s => s.loadTimeMs > 20000).length;
    const failed = searches.filter(s => (s.results || 0) === 0).length;
    const success = total - failed;
    const onTime = searches.filter(s => s.loadTimeMs <= 20000).length;
    const isHotel = mode.startsWith('hotel');

    // Rating distribution (PERFECT/MEDIAN/DELAY/CRITICAL/FAILURE)
    const ratings = { perfect: 0, median: 0, delay: 0, critical: 0, failure: 0 };
    for (const s of searches) {
      const sec = s.loadTimeMs / 1000;
      const isOk = (s.results || 0) > 0;
      if (!isOk || sec === 0 || sec >= 100) { ratings.failure++; continue; }
      if (isHotel) {
        // Hotel: 1-20 PERFECT, 20-45 MEDIAN, 45-50 DELAY, 50+ CRITICAL
        if (sec <= 20) ratings.perfect++;
        else if (sec <= 45) ratings.median++;
        else if (sec <= 50) ratings.delay++;
        else ratings.critical++;
      } else if (mode === 'all') {
        // Aggregate: use flight INTL thresholds as a reasonable middle ground
        // 1-20 PERFECT, 20-30 MEDIAN, 30-40 DELAY, 40+ CRITICAL
        if (sec <= 20) ratings.perfect++;
        else if (sec <= 30) ratings.median++;
        else if (sec <= 40) ratings.delay++;
        else ratings.critical++;
      } else if (mode === 'flightDom') {
        // Flight DOM: 1-10 PERFECT, 10-20 MEDIAN, 20-30 DELAY, 30+ CRITICAL
        if (sec <= 10) ratings.perfect++;
        else if (sec <= 20) ratings.median++;
        else if (sec <= 30) ratings.delay++;
        else ratings.critical++;
      } else {
        // Flight INTL: 1-20 PERFECT, 20-30 MEDIAN, 30-40 DELAY, 40+ CRITICAL
        if (sec <= 20) ratings.perfect++;
        else if (sec <= 30) ratings.median++;
        else if (sec <= 40) ratings.delay++;
        else ratings.critical++;
      }
    }

    return {
      total,
      delayed, delayPct: Math.round((delayed / total) * 100),
      failed, failPct: Math.round((failed / total) * 100),
      success, successPct: Math.round((success / total) * 100),
      onTime, onTimePct: Math.round((onTime / total) * 100),
      spfExcluded, // CEO 2026-05-30: SPF count surfaced separately, not counted in `total`
      ratings,
    };
  }

  return {
    flightDom: calcStats(allSearches.flightDom, 'flightDom'),
    flightIntl: calcStats(allSearches.flightIntl, 'flightIntl'),
    hotelDom: calcStats(allSearches.hotelDom, 'hotelDom'),
    hotelIntl: calcStats(allSearches.hotelIntl, 'hotelIntl'),
    all: calcStats([...allSearches.flightDom, ...allSearches.flightIntl, ...allSearches.hotelDom, ...allSearches.hotelIntl], 'all'),
  };
}

module.exports = { metricsApi };