// utils/supplierHealth.js
// Persistent store + rolling baseline for airline supplier health on Flight INTL.
// Backing file: state/supplierHealth.json
//
// Schema:
// {
//   "DEL→DXB": {
//     "searches": [
//       { "at": "2026-06-01T10:30:00Z", "airlines": [{"name":"Air India","count":42}, ...] },
//       ...
//     ]
//   },
//   ...
// }
//
// Public API:
//   recordSearch(sector, airlinesShown) → appends + trims (>7d evictions)
//   getBaseline(sector, windowHours = 24) → { airlines: [{name, appearanceRate, avgCount, samples}], totalSearches }
//   getAllSectors() → ["DEL→DXB", "BOM→DOH", ...]
//   detectAnomalies(sector, currentAirlines, threshold = 0.8) → [{name, baselineRate, currentlyMissing}]

const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'state', 'supplierHealth.json');
const TRIM_DAYS = 7;
const TRIM_MS = TRIM_DAYS * 24 * 60 * 60 * 1000;

function _read() {
  try { return JSON.parse(fs.readFileSync(FILE, 'utf-8')); }
  catch { return {}; }
}

function _write(data) {
  try { fs.writeFileSync(FILE, JSON.stringify(data, null, 2)); }
  catch { /* ignore */ }
}

function _trimOld(searches) {
  const now = Date.now();
  return searches.filter(s => {
    const t = new Date(s.at).getTime();
    return isFinite(t) && (now - t) <= TRIM_MS;
  });
}

function recordSearch(sector, airlinesShown, opts) {
  if (!sector) return;
  const o = opts || {};
  const airlines = Array.isArray(airlinesShown) ? airlinesShown : [];
  const data = _read();
  if (!data[sector]) data[sector] = { searches: [] };
  const entry = {
    at: new Date().toISOString(),
    airlines: airlines.map(a => ({ name: a.name, count: a.count })),
  };
  if (o.screenshotPath) entry.screenshotPath = o.screenshotPath;
  // CEO 2026-06-02: record outcome status so failed/SPF searches also show up
  // in the Supplier Health view (not just successful captures).
  entry.status = o.status || (airlines.length > 0 ? 'SUCCESS' : 'NO_AIRLINES');
  if (o.failureReason) entry.failureReason = String(o.failureReason).slice(0, 200);
  data[sector].searches.push(entry);
  data[sector].searches = _trimOld(data[sector].searches);
  _write(data);
}

function getBaseline(sector, windowHours) {
  const hours = windowHours || 24;
  const cutoffMs = Date.now() - (hours * 60 * 60 * 1000);
  const data = _read();
  const entry = data[sector];
  if (!entry || !entry.searches.length) return { airlines: [], totalSearches: 0 };
  const recent = entry.searches.filter(s => new Date(s.at).getTime() >= cutoffMs);
  const totalSearches = recent.length;
  if (totalSearches === 0) return { airlines: [], totalSearches: 0 };

  // Aggregate per airline name
  const agg = {}; // name → { appearances, totalCount }
  for (const search of recent) {
    for (const a of (search.airlines || [])) {
      if (!agg[a.name]) agg[a.name] = { appearances: 0, totalCount: 0 };
      agg[a.name].appearances += 1;
      agg[a.name].totalCount += (a.count || 0);
    }
  }
  const airlines = Object.entries(agg).map(([name, s]) => ({
    name,
    appearanceRate: s.appearances / totalSearches,
    appearancesIn: s.appearances,
    avgCount: Math.round(s.totalCount / Math.max(1, s.appearances)),
  })).sort((a, b) => b.appearanceRate - a.appearanceRate);
  return { airlines, totalSearches };
}

function getAllSectors() {
  return Object.keys(_read());
}

/**
 * For a freshly-completed search, return the list of airlines that have
 * historically appeared with ≥ threshold rate but are MISSING in this search.
 */
function detectAnomalies(sector, currentAirlines, threshold) {
  const thr = (typeof threshold === 'number') ? threshold : 0.8;
  const base = getBaseline(sector, 24);
  if (base.totalSearches < 5) return []; // not enough data
  const currentNames = new Set((currentAirlines || []).map(a => a.name.toLowerCase()));
  const flagged = [];
  for (const a of base.airlines) {
    if (a.appearanceRate >= thr && !currentNames.has(a.name.toLowerCase())) {
      flagged.push({
        name: a.name,
        baselineRate: a.appearanceRate,
        baselineCount: a.avgCount,
      });
    }
  }
  return flagged;
}

// Per-search view (CEO 2026-06-01): each row = one search, exact carrier counts. No averaging.
function getMatrix(windowHours) {
  const hours = windowHours || 24;
  const { classify } = require('./airlineClassifier');
  const cutoffMs = Date.now() - (hours * 60 * 60 * 1000);
  const data = _read();
  const rows = [];
  for (const sector of Object.keys(data)) {
    const entry = data[sector];
    if (!entry || !Array.isArray(entry.searches)) continue;
    for (const search of entry.searches) {
      const t = new Date(search.at).getTime();
      if (!isFinite(t) || t < cutoffMs) continue;
      let lccC = 0, fscC = 0, lccF = 0, fscF = 0;
      const airlineNames = { lcc: [], fsc: [] };
      for (const a of (search.airlines || [])) {
        const k = classify(a.name);
        const c = a.count || 0;
        if (k === 'LCC') { lccC++; lccF += c; airlineNames.lcc.push(a.name); }
        else if (k === 'FSC') { fscC++; fscF += c; airlineNames.fsc.push(a.name); }
      }
      rows.push({
        at: search.at,
        sector,
        lccCarriers: lccC,
        lccFlights: lccF,
        fscCarriers: fscC,
        fscFlights: fscF,
        lccAirlineNames: airlineNames.lcc,
        fscAirlineNames: airlineNames.fsc,
        // 2026-06-02: pass through status so dashboard can show "FAILED" /
        // "AUTOSUGGEST_DOWN" instead of misleading "0 airlines" for failed
        // searches that were recorded via Option B (record-every-outcome).
        status: search.status || (lccC + fscC > 0 ? 'SUCCESS' : 'NO_AIRLINES'),
        failureReason: search.failureReason || null,
      });
    }
  }
  rows.sort((a, b) => new Date(b.at) - new Date(a.at));
  return { rows, windowHours: hours };
}

module.exports = {
  recordSearch,
  getBaseline,
  getAllSectors,
  detectAnomalies,
  getMatrix,
};
