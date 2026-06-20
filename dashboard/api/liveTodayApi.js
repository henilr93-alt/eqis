// liveTodayApi.js — Aggregates today's per-engine activity for the Live tab.
// Returns:
//   {
//     generatedAt, todayIso, systemHealth,
//     hourlyBucketsLocal: ["00",...,"23"],
//     engines: {
//       searchpulse: { displayName, status, runs, success, fail, successRate,
//                      avgLoadMs, lastRunAt, hourlyRuns:[0..23], hourlyOk:[0..23],
//                      subEngines:{flightDom,flightIntl,hotelDom,hotelIntl: {runs,ok}},
//                      latestRunBadge, alerts:[] },
//       review:      { ...same shape, plus verdictCounts },
//       competitor:  { ...same shape, plus etravVsCt },
//       ecd:         { ...same shape, plus comboCount, brokenCount }
//     },
//     totals: { runs, success, fail }
//   }

const fs = require('fs');
const path = require('path');

const STATE = path.join(__dirname, '..', '..', 'state');
const REVIEW_REPORTS = path.join(__dirname, '..', '..', 'reports', 'review');

function read(p, fb) { try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return fb; } }
function todayIstIso() {
  // Anchor day to the user's local timezone (Asia/Kolkata for EQIS)
  const now = new Date();
  const istOffsetMin = 330; // IST = UTC+5:30
  const ist = new Date(now.getTime() + (istOffsetMin + now.getTimezoneOffset()) * 60000);
  return ist.toISOString().split('T')[0];
}
function pctRound(x) { return Math.max(0, Math.min(100, Math.round(x))); }

function _hourOfIso(iso) {
  if (!iso) return null;
  // bucket by IST hour
  const d = new Date(iso);
  if (isNaN(d)) return null;
  const ist = new Date(d.getTime() + (330 + d.getTimezoneOffset()) * 60000);
  return ist.getUTCHours();
}

function _searchpulseToday(metricsHistory, today) {
  const subKeys = { 'flight-dom':{runs:0,ok:0}, 'flight-intl':{runs:0,ok:0}, 'hotel-dom':{runs:0,ok:0}, 'hotel-intl':{runs:0,ok:0} };
  const hourlyRuns = new Array(24).fill(0);
  const hourlyOk   = new Array(24).fill(0);
  let runs = 0, success = 0, fail = 0;
  let loadMsSum = 0, loadMsCount = 0;
  let lastRunAt = null;
  const recentFailures = [];

  for (const e of metricsHistory) {
    if (e.engineType !== 'searchpulse') continue;
    if (!String(e.timestamp || '').startsWith(today)) continue;

    const h = _hourOfIso(e.timestamp);
    if (lastRunAt == null || e.timestamp > lastRunAt) lastRunAt = e.timestamp;

    // Each searchpulse "pulse" entry can carry multiple flight + hotel sub-searches.
    const flights = Array.isArray(e.flightSearches) ? e.flightSearches : [];
    const hotels  = Array.isArray(e.hotelSearches)  ? e.hotelSearches  : [];

    for (const s of flights) {
      runs++;
      if (s.status === 'SUCCESS') success++; else { fail++; if (recentFailures.length < 10 && s.status) recentFailures.push({ ts: e.timestamp, type: 'flight ' + (s.type || ''), status: s.status, label: s.label || '' }); }
      const sub = (s.type === 'domestic') ? 'flight-dom' : (s.type === 'international') ? 'flight-intl' : null;
      if (sub) { subKeys[sub].runs++; if (s.status === 'SUCCESS') subKeys[sub].ok++; }
      if (typeof s.loadTimeMs === 'number') { loadMsSum += s.loadTimeMs; loadMsCount++; }
      if (h != null) { hourlyRuns[h]++; if (s.status === 'SUCCESS') hourlyOk[h]++; }
    }
    for (const s of hotels) {
      runs++;
      if (s.status === 'SUCCESS') success++; else { fail++; if (recentFailures.length < 10 && s.status) recentFailures.push({ ts: e.timestamp, type: 'hotel ' + (s.type || ''), status: s.status, label: s.label || '' }); }
      const sub = (s.type === 'domestic') ? 'hotel-dom' : (s.type === 'international') ? 'hotel-intl' : null;
      if (sub) { subKeys[sub].runs++; if (s.status === 'SUCCESS') subKeys[sub].ok++; }
      if (typeof s.loadTimeMs === 'number') { loadMsSum += s.loadTimeMs; loadMsCount++; }
      if (h != null) { hourlyRuns[h]++; if (s.status === 'SUCCESS') hourlyOk[h]++; }
    }
  }

  const avgLoadMs = loadMsCount ? Math.round(loadMsSum / loadMsCount) : 0;
  const successRate = runs ? pctRound((success / runs) * 100) : 0;
  return { runs, success, fail, successRate, avgLoadMs, lastRunAt, hourlyRuns, hourlyOk, subEngines: subKeys, recentFailures };
}

function _ecdToday(metricsHistory, ecdHistory, today) {
  const hourlyRuns = new Array(24).fill(0);
  const hourlyOk   = new Array(24).fill(0);
  let runs = 0, ok = 0, broken = 0, combos = 0, lastRunAt = null;

  // Prefer ecdHistory.runs (richer per-run summary), filtered by today
  const ecdRuns = (ecdHistory && Array.isArray(ecdHistory.runs)) ? ecdHistory.runs : [];
  for (const r of ecdRuns) {
    const ts = r.timestamp || r.startedAt;
    if (!String(ts || '').startsWith(today)) continue;
    runs++;
    const h = _hourOfIso(ts);
    if (h != null) hourlyRuns[h]++;
    const c = (r.summary && r.summary.totalCombosCompared) || r.totalCombosCompared || 0;
    const b = (r.summary && r.summary.ecdBrokenCount)      || r.ecdBrokenCount      || 0;
    combos += c; broken += b;
    if (c > 0 && b === 0) { ok++; if (h != null) hourlyOk[h]++; }
    if (lastRunAt == null || ts > lastRunAt) lastRunAt = ts;
  }
  // Fallback: metricsHistory engineType==='ecd' for the run count if ecdHistory had nothing today
  if (runs === 0) {
    for (const e of metricsHistory) {
      if (e.engineType !== 'ecd') continue;
      if (!String(e.timestamp || '').startsWith(today)) continue;
      runs++;
      const h = _hourOfIso(e.timestamp);
      if (h != null) hourlyRuns[h]++;
      if (lastRunAt == null || e.timestamp > lastRunAt) lastRunAt = e.timestamp;
    }
  }
  const successRate = runs ? pctRound((ok / runs) * 100) : 0;
  return { runs, success: ok, fail: runs - ok, successRate, avgLoadMs: 0, lastRunAt, hourlyRuns, hourlyOk, combos, broken };
}

// _competitorToday() removed 2026-06-14 (engine 7 scrapped per user request)

function _reviewToday(today) {
  const file = path.join(REVIEW_REPORTS, 'REVIEW-' + today + '.json');
  const day = read(file, { rows: [] });
  const rows = Array.isArray(day.rows) ? day.rows : [];
  const hourlyRuns = new Array(24).fill(0);
  const hourlyOk   = new Array(24).fill(0);
  let runs = 0, ok = 0, etravIssues = 0, eqisIssues = 0;
  let loadMsSum = 0, loadMsCount = 0;
  let lastRunAt = null;
  const verdictCounts = {};
  const ETRAV = new Set(['PRICE_CHANGED','FARE_UNAVAILABLE','SESSION_EXPIRED','BANNER_ERROR','FAILED_TO_LOAD','RESULTS_NOT_LOADED']);
  const EQIS  = new Set(['BOOK_BTN_MISSING','BOOK_CLICK_NO_NAV','REVIEW_LOAD_TIMEOUT','JS_ERROR','REVIEW_BROKEN','TARGET_MISMATCH']);
  for (const r of rows) {
    runs++;
    const v = r.verdict || 'UNKNOWN';
    verdictCounts[v] = (verdictCounts[v] || 0) + 1;
    if (v === 'REVIEW_OK') ok++;
    else if (ETRAV.has(v)) etravIssues++;
    else if (EQIS.has(v))  eqisIssues++;
    const ms = r.metrics && typeof r.metrics.loadMs === 'number' ? r.metrics.loadMs : null;
    if (ms != null) { loadMsSum += ms; loadMsCount++; }
    const h = _hourOfIso(r.startedAt);
    if (h != null) { hourlyRuns[h]++; if (v === 'REVIEW_OK') hourlyOk[h]++; }
    if (lastRunAt == null || (r.startedAt || '') > lastRunAt) lastRunAt = r.startedAt;
  }
  const successRate = runs ? pctRound((ok / runs) * 100) : 0;
  const avgLoadMs = loadMsCount ? Math.round(loadMsSum / loadMsCount) : 0;
  return { runs, success: ok, fail: runs - ok, successRate, avgLoadMs, lastRunAt, hourlyRuns, hourlyOk, etravIssues, eqisIssues, verdictCounts };
}

function _statusFromHealthSignal(signal) {
  return signal && signal.overallHealth ? signal.overallHealth : 'UNKNOWN';
}

function liveTodayByEngineApi(req, res) {
  const today = todayIstIso();
  const metricsHistory = read(path.join(STATE, 'metricsHistory.json'), []) || [];
  const ecdHistory     = read(path.join(STATE, 'ecdHistory.json'), { runs: [] });
  const signal         = read(path.join(STATE, 'searchQualitySignal.json'), {});
  const engineState    = read(path.join(STATE, 'engineState.json'), {});

  const sp  = _searchpulseToday(metricsHistory, today);
  const ecd = _ecdToday(metricsHistory, ecdHistory, today);
  const rev = _reviewToday(today);

  const reviewEnabled = String(process.env.REVIEW_PULSE_ENABLED || 'true').toLowerCase() !== 'false';
  const ecdStatus = (engineState && engineState.ecd && engineState.ecd.status) || 'running';
  const spStatus  = (engineState && engineState.searchPulse && engineState.searchPulse.status) || 'running';

  const engines = {
    searchpulse: {
      displayName: 'SearchPulse',
      subtitle:    '4 sub-engines · Flight DOM/INTL · Hotel DOM/INTL',
      status:      spStatus,
      ...sp,
      systemHealth: _statusFromHealthSignal(signal),
    },
    review: {
      displayName: 'Review Pulse',
      subtitle:    'Flight INTL Book → Review-page audit · Engine 8',
      status:      reviewEnabled ? 'running' : 'paused',
      ...rev,
    },
    ecd: {
      displayName: 'ECD Engine',
      subtitle:    'Hotel bedbank pricing comparison · Engines 5 + 6',
      status:      ecdStatus,
      ...ecd,
    },
  };

  const totals = {
    runs:    sp.runs + ecd.runs + rev.runs,
    success: sp.success + ecd.success + rev.success,
    fail:    sp.fail + ecd.fail + rev.fail,
  };
  totals.successRate = totals.runs ? pctRound((totals.success / totals.runs) * 100) : 0;

  res.json({
    generatedAt: new Date().toISOString(),
    todayIso: today,
    systemHealth: _statusFromHealthSignal(signal),
    hourlyBucketsLocal: Array.from({ length: 24 }, (_, i) => String(i).padStart(2, '0')),
    engines,
    totals,
  });
}

module.exports = { liveTodayByEngineApi };
