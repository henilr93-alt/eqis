const fs = require('fs');
const path = require('path');

const REPORTS_DIR = path.join(__dirname, '..', '..', 'reports');
const METRICS_PATH = path.join(__dirname, '..', '..', 'state', 'metricsHistory.json');

const PRICING = {
  inputPerMillion: 3.00,
  outputPerMillion: 15.00,
};

function calcCost(inputTokens, outputTokens) {
  const inputCost = (inputTokens / 1_000_000) * PRICING.inputPerMillion;
  const outputCost = (outputTokens / 1_000_000) * PRICING.outputPerMillion;
  return {
    inputCost: parseFloat(inputCost.toFixed(5)),
    outputCost: parseFloat(outputCost.toFixed(5)),
    totalCost: parseFloat((inputCost + outputCost).toFixed(5)),
  };
}

// Load metrics once per request and build a filename -> cost lookup map.
// Each metric entry has `reportPath` which contains the filename as basename.

function buildSubcategory(searches, type, fallbackLoadMs) {
  if (!searches || searches.length === 0) return { searches: [], results: 0, hasResults: false, avgLoadMs: fallbackLoadMs };
  // Filter by type, also infer from label if type field missing
  const filtered = searches.filter(s => {
    if (s.type) return s.type === type;
    // Fallback: infer from label text
    const lbl = (s.label || '').toLowerCase();
    if (type === 'domestic') return lbl.includes('domestic') || lbl.startsWith('dom');
    if (type === 'international') return lbl.includes('intl') || lbl.includes('international');
    return false;
  });
  const totalResults = filtered.reduce((sum, s) => sum + (s.results || 0), 0);
  const avgLoad = filtered.length > 0 ? Math.round(filtered.reduce((sum, s) => sum + (s.loadTimeMs || 0), 0) / filtered.length) : 0;
  return {
    searches: filtered.map(s => ({ searchId: s.searchId || '', label: s.label, results: s.results, loadTimeMs: s.loadTimeMs, status: s.status, url: s.url || '', sector: s.sector || '', searchDate: s.searchDate || '', paxCount: s.paxCount || '', cabinClass: s.cabinClass || '', searchType: s.searchType || '', destination: s.destination || '', nights: s.nights || 0, rooms: s.rooms || 0, starFilter: s.starFilter || '', airlineCount: s.airlineCount || 0, screenshotPath: s.screenshotPath || '', escalated: s.escalated || false, failureReason: s.failureReason || '', recordingPath: s.recordingPath || '', rating: s.rating || '' })),
    results: totalResults,
    hasResults: totalResults > 0,
    avgLoadMs: avgLoad || fallbackLoadMs,
    zeroRoutes: filtered.filter(s => (s.results || 0) === 0 && s.status !== 'FAILED').length,
  };
}

function buildCostIndex() {
  try {
    const history = JSON.parse(fs.readFileSync(METRICS_PATH, 'utf-8'));
    const index = {};
    for (const entry of history) {
      if (!entry.reportPath) continue;
      const filename = path.basename(entry.reportPath);
      const inTok = entry.tokensInput || Math.round((entry.tokensUsed || 0) * 0.85);
      const outTok = entry.tokensOutput || Math.round((entry.tokensUsed || 0) * 0.15);
      const cost = calcCost(inTok, outTok);
      // If the same filename appears multiple times (shouldn't), prefer the latest
      index[filename] = {
        tokensInput: inTok,
        tokensOutput: outTok,
        totalTokens: inTok + outTok,
        apiCalls: entry.apiCalls || 0,
        ...cost,
      };
      // SearchPulse-specific: separate flight/hotel results + load time
      if (entry.engineType === 'searchpulse') {
        const zeroRoutes = entry.zeroResultRoutes || [];
        const delayed = entry.delayedRoutes || [];
        const alerts = entry.criticalAlerts || [];
        // Classify zero-result routes by type
        const flightZero = zeroRoutes.filter(r => !r.toLowerCase().includes('hotel') && !r.toLowerCase().includes('room') && !r.match(/\d+N\b|\d+★/));
        const hotelZero = zeroRoutes.filter(r => r.toLowerCase().includes('hotel') || r.toLowerCase().includes('room') || r.match(/\d+N\b|\d+★/));
        // Classify delayed routes by type
        const flightDelayed = delayed.filter(d => !d.route?.toLowerCase().includes('hotel') && !d.route?.match(/\d+N\b|\d+★/));
        const hotelDelayed = delayed.filter(d => d.route?.toLowerCase().includes('hotel') || d.route?.match(/\d+N\b|\d+★/));
        index[filename].searchPulse = {
          overallHealth: entry.overallHealth || 'UNKNOWN',
          avgLoadTimeMs: entry.avgLoadTimeMs || 0,
          flight: {
            domestic: buildSubcategory(entry.flightSearches, 'domestic', entry.flightAvgLoadMs || entry.avgLoadTimeMs || 0),
            international: buildSubcategory(entry.flightSearches, 'international', entry.flightAvgLoadMs || entry.avgLoadTimeMs || 0),
            results: entry.flightResultCount || 0,
            hasResults: (entry.flightResultCount || 0) > 0,
            zeroRoutes: flightZero.length,
            delayed: flightDelayed.length,
            avgLoadMs: entry.flightAvgLoadMs || (entry.avgLoadTimeMs || 0),
            searches: (entry.flightSearches || []).map(s => ({ label: s.label, results: s.results, loadTimeMs: s.loadTimeMs, status: s.status, type: s.type || 'domestic' })),
          },
          hotel: {
            domestic: buildSubcategory(entry.hotelSearches, 'domestic', entry.hotelAvgLoadMs || entry.avgLoadTimeMs || 0),
            international: buildSubcategory(entry.hotelSearches, 'international', entry.hotelAvgLoadMs || entry.avgLoadTimeMs || 0),
            results: entry.hotelResultCount || 0,
            hasResults: (entry.hotelResultCount || 0) > 0,
            zeroRoutes: hotelZero.length,
            delayed: hotelDelayed.length,
            avgLoadMs: entry.hotelAvgLoadMs || (entry.avgLoadTimeMs || 0),
            searches: (entry.hotelSearches || []).map(s => ({ label: s.label, results: s.results, loadTimeMs: s.loadTimeMs, status: s.status, type: s.type || 'domestic' })),
          },
          totalZeroRoutes: zeroRoutes.length,
          totalDelayed: delayed.length,
        };
      }
    }
    return index;
  } catch { return {}; }
}

function historyApi(req, res) {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 50;
    const type = req.query.type || 'all';

    const reportFolders = {
      journey: 'journey',
      zipy: 'zipy',
      searchpulse: 'searchpulse',
      fullbooking: 'fullbooking',
    };

    const costIndex = buildCostIndex();
    const allReports = [];

    for (const [reportType, folder] of Object.entries(reportFolders)) {
      if (type !== 'all' && type !== reportType) continue;
      try {
        const dir = path.join(REPORTS_DIR, folder);
        if (!fs.existsSync(dir)) continue;
        const files = fs.readdirSync(dir);
        for (const file of files) {
          if (!file.endsWith('.html')) continue;
          const stat = fs.statSync(path.join(dir, file));
          // Look up cost for this specific session/report
          const cost = costIndex[file] || null;
          allReports.push({
            id: `${reportType}/${file}`,
            type: reportType,
            filename: file,
            folder,
            sizeBytes: stat.size,
            sizeKb: Math.round(stat.size / 1024),
            createdAt: stat.birthtime.toISOString(),
            modifiedAt: stat.mtime.toISOString(),
            downloadUrl: `/api/download/${reportType}/${file}`,
            cost,  // null if no metrics entry found, else {totalCost, inputCost, outputCost, tokensInput, tokensOutput, totalTokens, apiCalls}
            ...parseReportFilename(file, reportType),
          });
        }
      } catch { /* skip */ }
    }

    allReports.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    const total = allReports.length;
    const start = (page - 1) * limit;
    const paginated = allReports.slice(start, start + limit);

    res.json({
      reports: paginated,
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

function parseReportFilename(filename, type) {
  const match = filename.match(/(\d{4}-\d{2}-\d{2})(?:_(\d{2}-\d{2}))?/);
  return {
    date: match?.[1] || null,
    time: match?.[2]?.replace('-', ':') || null,
    label: buildReportLabel(type, match?.[1], match?.[2]),
  };
}

function buildReportLabel(type, date, time) {
  const typeLabels = {
    journey: 'Journey Test',
    zipy: 'Zipy Analysis',
    searchpulse: 'Search Pulse',
    fullbooking: 'Full Booking',
  };
  const base = typeLabels[type] || type;
  if (date && time) return `${base} — ${date} ${time.replace('-', ':')}`;
  if (date) return `${base} — ${date}`;
  return base;
}

module.exports = { historyApi };
