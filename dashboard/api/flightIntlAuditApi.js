// flightIntlAuditApi.js — Dashboard endpoints for Engine 9 (merged Flight INTL
// Audit: search + book + review on ONE continuous page).
//
// Adapted from reviewApi.js. Each unified row carries BOTH a search-page side
// (`row.search.status` + load/results) and a review/booking-page side
// (`row.verdict` mirrored at top-level, like a Review row) plus the shared
// evidence (one video + two screenshots for the whole search→book→review clip).
//
// Endpoints:
//   GET /api/flight-intl-audit/status              → engine status + today's summary
//   GET /api/flight-intl-audit/today               → today's AUDIT-{YYYY-MM-DD}.json rows
//   GET /api/flight-intl-audit/history             → last N days' rolled-up summaries
//   GET /api/flight-intl-audit/failures            → non-OK rows in the last 24h
//   GET /api/flight-intl-audit/asset/:kind/:runId  → screenshot/passenger/recording
//   GET /api/flight-intl-audit/detail/:runId       → standalone HTML detail page

const fs = require('fs');
const path = require('path');
const logger = require('../../utils/logger');
let auditVerifier = null;
try { auditVerifier = require('../../engine9-flightintlaudit/auditVerifier'); } catch (e) { /* optional */ }

const REPORTS_DIR = path.join(__dirname, '..', '..', 'reports', 'flight-intl-audit');

const { TZ: _TZ } = require('../../utils/timezone');
// IST (Asia/Kolkata) calendar date for today+offsetDays — report files are named
// by IST date so "Today" matches the operator's day, not UTC.
function _istDay(offset) {
  const d = new Date();
  if (offset) d.setTime(d.getTime() + offset * 86400000);
  return d.toLocaleString('en-CA', { timeZone: _TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).slice(0, 10);
}
function _today() { return _istDay(0); }
function _prevDayIso(iso) { const d = new Date(iso + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() - 1); return d.toISOString().slice(0, 10); }
function _istDateOf(iso) { try { return new Date(iso).toLocaleString('en-CA', { timeZone: _TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).slice(0, 10); } catch (e) { return null; } }

function _readJson(p, fallback) {
  try { if (!fs.existsSync(p)) return fallback; return JSON.parse(fs.readFileSync(p, 'utf-8')); }
  catch (e) { logger.warn('[FIA-API] read failed ' + p + ': ' + e.message); return fallback; }
}
function _loadDay(dateIso) {
  return _readJson(path.join(REPORTS_DIR, 'AUDIT-' + dateIso + '.json'), { date: dateIso, rows: [] });
}
// Load a logical IST day (merge IST-named + prev-day file, de-dupe by runId).
function _loadIstDay(date) {
  const merged = [].concat(_loadDay(date).rows || [], _loadDay(_prevDayIso(date)).rows || []);
  const seen = new Set(); const rows = [];
  for (const r of merged) {
    if (!r) continue;
    if (_istDateOf(r.startedAt) !== date) continue;
    const id = r.runId || (String(r.sector) + '|' + String(r.startedAt));
    if (seen.has(id)) continue;
    seen.add(id); rows.push(r);
  }
  return { date: date, rows: rows };
}

// Review-side verdict bucketing (keep in sync with reviewApi._summarise + the
// dashboard UI). REVIEW_OK = pass; Etrav-side = acceptable-but-flag; EQIS-side =
// never acceptable. SKIPPED rows (search never reached results) are counted
// separately so they don't drag the review success rate down.
const ETRAV_VERDICTS = ['PRICE_CHANGED', 'FARE_CHANGE', 'SOLD_OUT', 'FARE_UNAVAILABLE', 'SESSION_EXPIRED', 'BANNER_ERROR', 'FAILED_TO_LOAD', 'RESULTS_NOT_LOADED'];
const EQIS_VERDICTS = ['BOOK_BTN_MISSING', 'BOOK_CLICK_NO_NAV', 'REVIEW_LOAD_TIMEOUT', 'JS_ERROR', 'REVIEW_BROKEN', 'TARGET_MISMATCH'];

function _summarise(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const total = list.length;
  // search side
  let searchSuccess = 0, searchMsSum = 0, searchMsCount = 0;
  const searchStatusCounts = {};
  // review side
  let reviewOk = 0, etravIssues = 0, eqisIssues = 0, reviewSkipped = 0, reviewScored = 0;
  const verdictCounts = {};
  let loadMsSum = 0, loadMsCount = 0; const loadMsPool = [];

  for (const r of list) {
    const s = (r.search && r.search.status) || r.searchStatus || 'UNKNOWN';
    searchStatusCounts[s] = (searchStatusCounts[s] || 0) + 1;
    if (s === 'SUCCESS') searchSuccess++;
    const sMs = (r.search && r.search.loadTimeMs) || 0;
    if (sMs > 0) { searchMsSum += sMs; searchMsCount++; }

    const v = r.verdict || 'UNKNOWN';
    verdictCounts[v] = (verdictCounts[v] || 0) + 1;
    if (v === 'SKIPPED') { reviewSkipped++; }
    else {
      reviewScored++;
      if (v === 'REVIEW_OK') reviewOk++;
      else if (ETRAV_VERDICTS.indexOf(v) !== -1) etravIssues++;
      else if (EQIS_VERDICTS.indexOf(v) !== -1) eqisIssues++;
    }
    const m = r.review && r.review.metrics ? r.review.metrics : r.metrics;
    const ms = m && typeof m.loadMs === 'number' ? m.loadMs : null;
    if (ms != null) { loadMsSum += ms; loadMsCount++; loadMsPool.push(ms); }
  }
  loadMsPool.sort(function (a, b) { return a - b; });
  const p95 = loadMsPool.length ? loadMsPool[Math.max(0, Math.floor(0.95 * (loadMsPool.length - 1)))] : 0;
  return {
    total,
    // search-page side
    searchSuccess,
    searchSuccessRate: total ? (searchSuccess / total) * 100 : 0,
    avgSearchMs: searchMsCount ? Math.round(searchMsSum / searchMsCount) : 0,
    searchStatusCounts,
    // review/booking-page side
    ok: reviewOk,
    etravIssues,
    eqisIssues,
    reviewSkipped,
    reviewScored,
    successRate: reviewScored ? (reviewOk / reviewScored) * 100 : 0,
    avgReviewLoadMs: loadMsCount ? Math.round(loadMsSum / loadMsCount) : 0,
    p95ReviewLoadMs: p95,
    verdictCounts,
  };
}

function _enabled() {
  return String(process.env.FLIGHT_INTL_AUDIT_ENABLED || 'true').toLowerCase() !== 'false';
}

function statusApi(req, res) {
  const today = _loadIstDay(_today());
  res.json({
    enabled: _enabled(),
    today: { date: today.date, ..._summarise(today.rows) },
    lastUpdated: new Date().toISOString(),
  });
}

function todayApi(req, res) {
  const date = req.query.date || _today();
  const data = _loadIstDay(date);
  res.json({ date: data.date, rows: data.rows, summary: _summarise(data.rows) });
}

function historyApi(req, res) {
  const days = Math.min(30, Math.max(1, parseInt(req.query.days, 10) || 7));
  const out = [];
  for (let i = 0; i < days; i++) {
    const iso = _istDay(-i);
    const day = _loadDay(iso);
    if (!day.rows || day.rows.length === 0) continue;
    out.push({ date: iso, summary: _summarise(day.rows) });
  }
  res.json({ days: out });
}

function failuresApi(req, res) {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  const dates = [0, -1].map(function (o) { return _istDay(o); });
  const out = [];
  for (const iso of dates) {
    const day = _loadDay(iso);
    for (const r of (day.rows || [])) {
      if (!r || !r.startedAt) continue;
      if (new Date(r.startedAt).getTime() < cutoff) continue;
      const searchOk = ((r.search && r.search.status) || r.searchStatus) === 'SUCCESS';
      const reviewBad = r.verdict && r.verdict !== 'REVIEW_OK' && r.verdict !== 'SKIPPED';
      // A run is a "failure" if the search itself didn't load OR the review verdict is non-OK.
      if (!searchOk || reviewBad) out.push(r);
    }
  }
  out.sort(function (a, b) { return String(b.startedAt).localeCompare(String(a.startedAt)); });
  res.json({ failures: out.slice(0, 50) });
}

// ---------------------------------------------------------------- asset serve

function _findRowByRunId(runId) {
  if (!runId || !/^[A-Z0-9-]+$/i.test(runId)) return null;
  for (let i = 0; i < 14; i++) {
    const iso = _istDay(-i);
    const day = _loadDay(iso);
    const hit = (day.rows || []).find(function (r) { return r && r.runId === runId; });
    if (hit) return { row: hit, date: iso };
  }
  return null;
}

function assetApi(req, res) {
  const kind = String(req.params.kind || '');
  const runId = String(req.params.runId || '');
  if (!/^[A-Z0-9-]+$/i.test(runId)) return res.status(400).json({ error: 'bad runId' });
  let abs = null, ct = null;
  if (kind === 'screenshot') {
    abs = path.join(REPORTS_DIR, 'screenshots', 'audit-' + runId + '.png');
    ct = 'image/png';
  } else if (kind === 'passenger') {
    abs = path.join(REPORTS_DIR, 'screenshots', 'audit-' + runId + '-passenger.png');
    ct = 'image/png';
  } else if (kind === 'recording') {
    const mp4 = path.join(REPORTS_DIR, 'recordings', 'audit-' + runId + '.mp4');
    const webm = path.join(REPORTS_DIR, 'recordings', 'audit-' + runId + '.webm');
    if (fs.existsSync(mp4)) { abs = mp4; ct = 'video/mp4'; }
    else if (fs.existsSync(webm)) { abs = webm; ct = 'video/webm'; }
  } else {
    return res.status(400).json({ error: 'kind must be screenshot, passenger or recording' });
  }
  if (!abs || !fs.existsSync(abs)) return res.status(404).json({ error: 'not found', kind, runId });
  // Honour HTTP Range so the browser can seek the video without a full download.
  const stat = fs.statSync(abs);
  const range = req.headers.range;
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Cache-Control', 'public, max-age=86400');
  res.setHeader('Content-Type', ct);
  if (range) {
    const m = /bytes=(\d*)-(\d*)/.exec(range);
    const start = m && m[1] ? parseInt(m[1], 10) : 0;
    const end = m && m[2] ? parseInt(m[2], 10) : stat.size - 1;
    if (isNaN(start) || isNaN(end) || start >= stat.size) {
      res.status(416).setHeader('Content-Range', 'bytes */' + stat.size);
      return res.end();
    }
    res.status(206);
    res.setHeader('Content-Range', 'bytes ' + start + '-' + end + '/' + stat.size);
    res.setHeader('Content-Length', (end - start + 1));
    fs.createReadStream(abs, { start, end }).pipe(res);
  } else {
    res.setHeader('Content-Length', stat.size);
    fs.createReadStream(abs).pipe(res);
  }
}

// ---------------------------------------------------------------- detail page

function _esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function detailApi(req, res) {
  const runId = String(req.params.runId || '');
  const hit = _findRowByRunId(runId);
  if (!hit) {
    res.status(404).set('Content-Type', 'text/html').send('<h1>Audit run ' + _esc(runId) + ' not found</h1>');
    return;
  }
  const r = hit.row;
  const token = encodeURIComponent(String(req.query.token || ''));
  const base = '/api/flight-intl-audit/asset/';
  const shotUrl = r.screenshotPath ? base + 'screenshot/' + encodeURIComponent(runId) + '?token=' + token : null;
  const paxUrl = r.passengerShotPath ? base + 'passenger/' + encodeURIComponent(runId) + '?token=' + token : null;
  const recUrl = r.recordingPath ? base + 'recording/' + encodeURIComponent(runId) + '?token=' + token : null;
  const search = r.search || {};
  const review = r.review || {};
  const target = r.target || review.target || {};
  const metrics = review.metrics || r.metrics || {};
  const startedHuman = r.startedAt ? new Date(r.startedAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false }) + ' IST' : '—';
  const fmtMs = (ms) => ms == null ? '—' : (ms < 1000 ? ms + ' ms' : (ms / 1000).toFixed(1) + ' s');
  const searchOk = search.status === 'SUCCESS';
  const searchTone = searchOk ? 'ok' : 'err';
  const verdictTone = r.verdict === 'REVIEW_OK' ? 'ok' : r.verdict === 'SKIPPED' ? 'neu' : r.severity === 'P1' ? 'err' : 'warn';
  const sevTone = r.severity === 'P1' ? 'err' : r.severity === 'P2' ? 'warn' : 'neu';
  const backHref = '/?token=' + token + '#flight-intl-audit';
  const rtFare = r.roundTripFareChecked == null ? '—' : (r.roundTripFareChecked ? 'TICKED (combined RT fare)' : 'UNTICKED (two one-way legs)');

  const html = '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">'
    + '<meta name="viewport" content="width=device-width,initial-scale=1">'
    + '<title>Flight INTL Audit ' + _esc(runId) + ' &middot; ' + _esc(r.sector) + '</title>'
    + '<style>'
    + ':root{--bg:#F5F5F7;--card:#FFFFFF;--border:#E5E5EA;--text:#1D1D1F;--dim:#6E6E73;--muted:#AEAEB2;--accent:#0A6BD8;--mono:"DM Mono",ui-monospace,SFMono-Regular,Menlo,monospace;}'
    + '*{box-sizing:border-box;}'
    + 'body{font-family:-apple-system,BlinkMacSystemFont,"SF Pro Display","Segoe UI",sans-serif;background:var(--bg);color:var(--text);margin:0;padding:0;-webkit-font-smoothing:antialiased;}'
    + '.shell{max-width:1280px;margin:0 auto;padding:24px 28px 64px;}'
    + '.crumb{display:flex;gap:8px;align-items:center;font-size:12px;color:var(--dim);margin-bottom:14px;}'
    + '.crumb a{color:var(--accent);text-decoration:none;}'
    + '.crumb a:hover{text-decoration:underline;}'
    + '.crumb .sep{color:var(--muted);}'
    + '.hero{background:var(--card);border:1px solid var(--border);border-radius:14px;padding:22px 26px;display:flex;align-items:center;gap:14px;margin-bottom:18px;box-shadow:0 1px 2px rgba(0,0,0,0.03);}'
    + '.hero h1{margin:0;font-size:22px;font-weight:600;letter-spacing:-0.01em;}'
    + '.hero .sub{font-size:12px;color:var(--dim);margin-top:4px;font-family:var(--mono);}'
    + '.spacer{flex:1;}'
    + '.pill{display:inline-flex;align-items:center;padding:5px 12px;border-radius:999px;font-size:11px;font-weight:700;letter-spacing:0.04em;font-family:var(--mono);}'
    + '.pill.ok{background:rgba(21,163,74,0.10);color:#15803D;}'
    + '.pill.warn{background:rgba(234,88,12,0.10);color:#C2410C;}'
    + '.pill.err{background:rgba(220,38,38,0.10);color:#B91C1C;}'
    + '.pill.neu{background:rgba(110,110,115,0.10);color:var(--dim);}'
    + '.pill-lbl{font-size:9px;color:var(--dim);font-weight:600;text-transform:uppercase;letter-spacing:0.06em;margin-right:5px;}'
    + '.grid{display:grid;grid-template-columns:repeat(4,1fr);gap:14px;margin-bottom:22px;}'
    + '@media(max-width:980px){.grid{grid-template-columns:repeat(2,1fr);}}'
    + '@media(max-width:560px){.grid{grid-template-columns:1fr;}}'
    + '.card{background:var(--card);border:1px solid var(--border);border-radius:10px;padding:14px 16px;}'
    + '.k{font-size:10px;text-transform:uppercase;color:var(--dim);letter-spacing:0.08em;font-weight:600;}'
    + '.v{font-size:15px;margin-top:6px;font-family:var(--mono);color:var(--text);overflow-wrap:anywhere;}'
    + '.section{background:var(--card);border:1px solid var(--border);border-radius:14px;padding:22px 26px;margin-bottom:18px;box-shadow:0 1px 2px rgba(0,0,0,0.03);}'
    + '.section h2{margin:0 0 14px;font-size:14px;font-weight:600;letter-spacing:-0.01em;display:flex;align-items:center;gap:8px;}'
    + '.section h2 .badge{font-size:10px;color:var(--dim);font-weight:500;text-transform:uppercase;letter-spacing:0.08em;padding:2px 8px;background:var(--bg);border-radius:999px;}'
    + 'video{width:100%;max-width:760px;max-height:430px;background:#000;border-radius:8px;display:block;border:1px solid var(--border);object-fit:contain;}'
    + 'img.shot{max-width:100%;max-height:560px;width:auto;border:1px solid var(--border);border-radius:8px;display:block;object-fit:contain;cursor:zoom-in;}'
    + 'a{color:var(--accent);}'
    + 'details{margin-top:6px;}'
    + 'summary{cursor:pointer;font-size:13px;font-weight:600;color:var(--text);padding:4px 0;list-style:none;}'
    + 'summary::-webkit-details-marker{display:none;}'
    + 'summary::before{content:"\u25B8 ";font-size:11px;color:var(--dim);}'
    + 'details[open] summary::before{content:"\u25BE ";}'
    + 'pre{background:#0F172A;color:#E2E8F0;padding:14px 16px;border-radius:8px;font-size:12px;overflow-x:auto;font-family:var(--mono);line-height:1.5;}'
    + '.muted{color:var(--muted);font-style:italic;font-size:13px;}'
    + '.ptable{width:100%;border-collapse:collapse;}'
    + '.ptable td{padding:9px 4px;border-bottom:1px solid var(--border);font-size:13px;vertical-align:top;}'
    + '.ptable tr:last-child td{border-bottom:none;}'
    + '.ptable td.kk{color:var(--dim);font-size:11px;text-transform:uppercase;letter-spacing:0.06em;width:170px;font-weight:600;}'
    + '.ptable td.vv{font-family:var(--mono);color:var(--text);overflow-wrap:anywhere;}'
    + '.chapters-wrap{position:relative;margin-bottom:8px;}'
    + '.chapters{position:relative;height:36px;background:#0F172A;border-radius:6px;margin-bottom:6px;}'
    + '.chapters .mk{position:absolute;top:0;bottom:0;width:3px;background:#FFB020;cursor:pointer;border:none;padding:0;transition:.12s;}'
    + '.chapters .mk.click{background:#3B82F6;}'
    + '.chapters .mk.nav{background:#10B981;}'
    + '.chapters .mk.capture{background:#A855F7;}'
    + '.chapters .mk.load{background:#F59E0B;}'
    + '.chapters .mk:hover{width:5px;}'
    + '.chapters .mk-lbl{position:absolute;bottom:38px;left:50%;transform:translateX(-50%);background:#0F172A;color:#fff;font-size:11px;padding:4px 8px;border-radius:4px;white-space:nowrap;font-family:var(--mono);opacity:0;pointer-events:none;transition:.15s;}'
    + '.chapters .mk:hover .mk-lbl{opacity:1;}'
    + '.chapters-legend{display:flex;gap:14px;font-size:10px;color:var(--dim);align-items:center;}'
    + '.chapters-legend .lg{display:inline-flex;align-items:center;gap:5px;}'
    + '.chapters-legend .lg::before{content:"";width:10px;height:10px;border-radius:2px;background:currentColor;}'
    + '.chapters-legend .lg.click{color:#3B82F6;}'
    + '.chapters-legend .lg.nav  {color:#10B981;}'
    + '.chapters-legend .lg.cap  {color:#A855F7;}'
    + '.chapters-legend .lg.load {color:#F59E0B;}'
    + '</style></head><body>'
    + '<div class="shell">'

    + '<div class="crumb"><a href="' + _esc(backHref) + '">EQIS Dashboard</a><span class="sep">/</span><a href="' + _esc(backHref) + '">Flight INTL Audit</a><span class="sep">/</span><span>' + _esc(runId) + '</span></div>'

    // Hero — both verdicts side by side
    + '<div class="hero">'
    +   '<div>'
    +     '<h1>&#x2708;&#xFE0F;&#x1F50D; ' + _esc(r.sector) + ' &middot; ' + _esc(target.airline || 'Unknown carrier') + (target.flightCode ? ' ' + _esc(target.flightCode) : '') + '</h1>'
    +     '<div class="sub">runId ' + _esc(runId) + ' &middot; ' + _esc(startedHuman) + (r.durationMs ? ' &middot; took ' + fmtMs(r.durationMs) : '') + ' &middot; ' + _esc(r.tripType || 'one-way') + '</div>'
    +   '</div>'
    +   '<div class="spacer"></div>'
    +   '<span class="pill ' + searchTone + '"><span class="pill-lbl">search</span>' + _esc(search.status || 'UNKNOWN') + '</span>'
    +   '<span class="pill ' + verdictTone + '"><span class="pill-lbl">review</span>' + _esc(r.verdict || 'UNKNOWN') + '</span>'
    +   (r.severity ? '<span class="pill ' + sevTone + '">' + _esc(r.severity) + '</span>' : '')
    + '</div>'

    // KPI grid — search side + review side
    + '<div class="grid">'
    +   '<div class="card"><div class="k">Sector</div><div class="v">' + _esc(r.sector) + '</div></div>'
    +   '<div class="card"><div class="k">Trip / Cabin</div><div class="v">' + _esc(r.tripType || '—') + ' &middot; ' + _esc(r.cabinClass || '—') + '</div></div>'
    +   '<div class="card"><div class="k">Search results</div><div class="v">' + _esc(search.resultCount != null ? search.resultCount : '—') + ' &middot; ' + _esc(search.airlineCount || 0) + ' airlines</div></div>'
    +   '<div class="card"><div class="k">Search load</div><div class="v">' + fmtMs(search.loadTimeMs) + '</div></div>'
    +   '<div class="card"><div class="k">RoundTrip Fare box</div><div class="v">' + _esc(rtFare) + '</div></div>'
    +   '<div class="card"><div class="k">Airline / Flight</div><div class="v">' + _esc(target.airline || '—') + ' &middot; ' + _esc(target.flightCode || '—') + '</div></div>'
    +   '<div class="card"><div class="k">Fare</div><div class="v">' + _esc(target.fareLabel || '—') + (target.price ? ' &middot; &#8377;' + _esc(target.price) : '') + '</div></div>'
    +   '<div class="card"><div class="k">Review page load</div><div class="v">' + fmtMs(metrics.loadMs) + '</div></div>'
    +   '<div class="card"><div class="k">Review URL</div><div class="v">' + (metrics.url ? '<a target="_blank" href="' + _esc(metrics.url) + '">' + _esc(metrics.url) + '</a>' : '—') + '</div></div>'
    +   '<div class="card"><div class="k">Search URL</div><div class="v">' + (search.searchUrl ? '<a target="_blank" href="' + _esc(search.searchUrl) + '">' + _esc(search.searchUrl) + '</a>' : '—') + '</div></div>'
    +   '<div class="card"><div class="k">Search failure</div><div class="v">' + (search.failureReason ? _esc(search.failureReason) : '<span class="muted">none</span>') + '</div></div>'
    +   '<div class="card"><div class="k">Review error</div><div class="v">' + (review.error ? _esc(review.error) : (review.reason ? _esc(review.reason) : '<span class="muted">none</span>')) + '</div></div>'
    + '</div>'

    // Search details — full search-side parameters + performance, mirroring the
    // Flight INTL history individual-search report (searchReportApi) so the audit
    // detail surfaces the same search context (date, pax, cabin, trip, results…).
    + '<div class="section">'
    +   '<h2>&#x1F50E; Search details <span class="badge">same fields as Flight INTL history</span></h2>'
    +   '<table class="ptable">'
    +     '<tr><td class="kk">Sector</td><td class="vv">' + _esc(r.sector) + '</td></tr>'
    +     '<tr><td class="kk">Search Date</td><td class="vv">' + _esc(r.searchDate || '\u2014') + '</td></tr>'
    +     '<tr><td class="kk">Passengers</td><td class="vv">' + _esc(r.paxCount || '\u2014') + '</td></tr>'
    +     '<tr><td class="kk">Cabin Class</td><td class="vv">' + _esc(r.cabinClass || '\u2014') + '</td></tr>'
    +     '<tr><td class="kk">Trip Type</td><td class="vv">' + _esc(r.tripType || '\u2014') + '</td></tr>'
    +     '<tr><td class="kk">RoundTrip Fare</td><td class="vv">' + _esc(rtFare) + '</td></tr>'
    +     '<tr><td class="kk">Engine Type</td><td class="vv">INTERNATIONAL</td></tr>'
    +     '<tr><td class="kk">Status</td><td class="vv" style="color:' + (searchOk ? '#15803D' : '#B91C1C') + ';font-weight:700;">' + _esc(search.status || 'UNKNOWN') + '</td></tr>'
    +     '<tr><td class="kk">Search Duration</td><td class="vv">' + fmtMs(search.loadTimeMs) + '</td></tr>'
    +     '<tr><td class="kk">Results Found</td><td class="vv">' + _esc(search.resultCount != null ? search.resultCount : '\u2014') + '</td></tr>'
    +     '<tr><td class="kk">Airlines Shown</td><td class="vv">' + _esc(search.airlineCount || 0) + '</td></tr>'
    +     (search.searchUrl ? '<tr><td class="kk">Search URL</td><td class="vv"><a target="_blank" href="' + _esc(search.searchUrl) + '">' + _esc(search.searchUrl) + '</a></td></tr>' : '')
    +     (search.failureReason ? '<tr><td class="kk">Failure Reason</td><td class="vv" style="color:#B91C1C;">' + _esc(search.failureReason) + '</td></tr>' : '')
    +   '</table>'
    + '</div>'

    // Recording with chapter markers
    + '<div class="section">'
    +   '<h2>&#x1F4F9; Recording <span class="badge">one continuous search &rarr; book &rarr; review clip</span></h2>'
    +   (recUrl
        ? (
            '<div class="chapters-wrap">'
          +   '<div class="chapters" id="rp-chapters" data-dur-ms="' + (r.recordingDurationMs || 0) + '">'
          +     ((r.events || []).map(function (e) {
                  var kind = (e.kind || 'event').toLowerCase();
                  var pct = (r.recordingDurationMs && e.tsMs != null) ? Math.max(0, Math.min(99.5, (e.tsMs / r.recordingDurationMs) * 100)) : 0;
                  return '<button class="mk ' + kind + '" style="left:' + pct.toFixed(2) + '%;" data-ts="' + (e.tsMs || 0) + '" title="' + _esc(e.label) + ' @ ' + (e.tsMs || 0) + ' ms">'
                       +   '<span class="mk-lbl">' + _esc(e.label) + ' &middot; ' + ((e.tsMs || 0) / 1000).toFixed(1) + 's</span>'
                       + '</button>';
                }).join(''))
          +   '</div>'
          +   '<div class="chapters-legend">'
          +     '<span class="lg load">Load</span>'
          +     '<span class="lg click">Click</span>'
          +     '<span class="lg nav">Navigation</span>'
          +     '<span class="lg cap">Capture</span>'
          +     '<span style="margin-left:auto;">' + (r.events || []).length + ' events &middot; total ' + fmtMs(r.recordingDurationMs || 0) + '</span>'
          +   '</div>'
          + '</div>'
          + '<video id="rp-video" controls preload="metadata"' + (shotUrl ? ' poster="' + _esc(shotUrl) + '"' : '') + ' src="' + _esc(recUrl) + '"></video>'
          + '<script>(function(){var v=document.getElementById("rp-video");var c=document.getElementById("rp-chapters");if(!v||!c)return;function seek(ts){var t=ts/1000;v.pause();if(typeof v.fastSeek==="function"){try{v.fastSeek(t);return;}catch(e){}}v.currentTime=t;}c.addEventListener("click",function(e){var b=e.target.closest(".mk");if(!b)return;var ts=parseInt(b.getAttribute("data-ts"),10)||0;seek(ts);});v.addEventListener("loadedmetadata",function(){var dur=v.duration*1000;var declared=parseInt(c.getAttribute("data-dur-ms"),10)||0;if(dur>0&&Math.abs(dur-declared)>500){[].forEach.call(c.querySelectorAll(".mk"),function(b){var ts=parseInt(b.getAttribute("data-ts"),10)||0;b.style.left=Math.max(0,Math.min(99.5,(ts/dur)*100)).toFixed(2)+"%";});}});})();</script>'
          )
        : '<div class="muted">No recording captured for this run.</div>')
    + '</div>'

    // Screenshot
    + '<div class="section">'
    +   '<h2>&#x1F5BC;&#xFE0F; Screenshot <span class="badge">final review-page state</span></h2>'
    +   (shotUrl
        ? '<a href="' + _esc(shotUrl) + '" target="_blank" rel="noopener" title="Click to open full-size in a new tab" style="display:inline-block;"><img class="shot" src="' + _esc(shotUrl) + '" alt="review-page screenshot"></a>'
        : '<div class="muted">No screenshot captured for this run.</div>')
    + '</div>'

    // Passenger-area screenshot
    + '<div class="section">'
    +   '<h2>&#x1F465; Passenger details area <span class="badge">scrolled to the traveller form</span></h2>'
    +   (paxUrl
        ? '<a href="' + _esc(paxUrl) + '" target="_blank" rel="noopener" title="Click to open full-size in a new tab" style="display:inline-block;"><img class="shot" src="' + _esc(paxUrl) + '" alt="passenger-details area screenshot"></a>'
        : '<div class="muted">No passenger-area screenshot for this run.</div>')
    + '</div>'

    // FRAKA video-vs-data verification (if FRAKA audited this run)
    + (function () {
        let ver = null;
        try { ver = auditVerifier && auditVerifier.getVerification(runId); } catch (e) { ver = null; }
        if (!ver) return '';
        const chk = (v) => v === 'pass' ? '<span class="pill ok">PASS</span>' : v === 'fail' ? '<span class="pill err">FAIL</span>' : '<span class="pill neu">UNCLEAR</span>';
        const ovTone = ver.overallVerdict === 'MATCH' ? 'ok' : ver.overallVerdict === 'MISMATCH' ? 'err' : 'neu';
        const sideTone = ver.side === 'eqis' ? 'err' : ver.side === 'etrav' ? 'warn' : 'neu';
        return '<div class="section">'
          + '<h2>&#x1F916; FRAKA video-vs-data verification '
          +   '<span class="pill ' + ovTone + '">' + _esc(ver.overallVerdict || 'UNCLEAR') + '</span> '
          +   '<span class="pill ' + sideTone + '">' + _esc((ver.side || 'unclear').toUpperCase()) + '</span></h2>'
          + '<table class="ptable">'
          +   '<tr><td class="kk">Flight match</td><td class="vv">' + chk(ver.flightMatch) + '</td></tr>'
          +   '<tr><td class="kk">Passenger match</td><td class="vv">' + chk(ver.paxMatch) + '</td></tr>'
          +   '<tr><td class="kk">Fare &amp; price</td><td class="vv">' + chk(ver.fareMatch) + '</td></tr>'
          +   '<tr><td class="kk">Verdict justified</td><td class="vv">' + chk(ver.verdictJustified) + '</td></tr>'
          +   (ver.brokenFlow ? '<tr><td class="kk">Broken flow</td><td class="vv" style="color:#B91C1C;">' + _esc(ver.brokenFlow) + '</td></tr>' : '')
          +   (ver.affectedFile ? '<tr><td class="kk">Affected file</td><td class="vv">' + _esc(ver.affectedFile) + '</td></tr>' : '')
          +   '<tr><td class="kk">Root cause</td><td class="vv">' + _esc(ver.rootCause || '\u2014') + '</td></tr>'
          +   '<tr><td class="kk">Evidence</td><td class="vv">' + _esc(ver.evidence || '\u2014') + '</td></tr>'
          +   (ver.fixSuggestion ? '<tr><td class="kk">Fix suggestion</td><td class="vv">' + _esc(ver.fixSuggestion) + '</td></tr>' : '')
          +   (ver.proposalId ? '<tr><td class="kk">CEO proposal</td><td class="vv">' + _esc(ver.proposalId) + ' <span class="muted">(awaiting approval)</span></td></tr>' : '')
          +   '<tr><td class="kk">Verified at</td><td class="vv">' + _esc(ver.verifiedAt || '\u2014') + '</td></tr>'
          + '</table>'
          + '</div>';
      })()

    // Raw JSON
    + '<div class="section">'
    +   '<details><summary>Raw row JSON</summary>'
    +     '<pre>' + _esc(JSON.stringify(r, null, 2)) + '</pre>'
    +   '</details>'
    + '</div>'

    + '</div></body></html>';
  res.set('Content-Type', 'text/html').send(html);
}

// GET /api/flight-intl-audit/verifications → FRAKA video-vs-data verification records.
// Optional ?side=eqis|etrav, ?verdict=MATCH|MISMATCH|UNCLEAR, ?runId=...
function verificationsApi(req, res) {
  if (!auditVerifier) { res.json({ enabled: false, verifications: [], total: 0 }); return; }
  let list = [];
  try {
    list = auditVerifier.listVerifications({
      side: req.query.side || undefined,
      overallVerdict: req.query.verdict || undefined,
      runId: req.query.runId || undefined,
    });
  } catch (e) {
    logger.warn('[FIA-API] verifications read failed: ' + e.message);
  }
  let state = {};
  try { state = auditVerifier.loadState(); } catch (e) { state = {}; }
  res.json({
    enabled: auditVerifier.isEnabled(),
    total: state.totalVerified || list.length,
    lastVerifiedAt: state.lastVerifiedAt || null,
    mismatches: list.filter(v => v.overallVerdict === 'MISMATCH').length,
    eqisBreaks: list.filter(v => v.overallVerdict === 'MISMATCH' && v.side === 'eqis').length,
    verifications: list.slice(0, 200),
  });
}

// ------------------------------------------------ tech-team escalation summary
//
// Daily count of (a) how many Flight INTL Audit searches ran and (b) how many of
// those were auto-escalated to Etrav's tech team via the CMT camera-icon
// workflow (state/auditEscalations.json). Powers the Performance-tab report +
// its small pie chart. Searches/day come from the per-day AUDIT report files;
// escalations/day are bucketed by each ticket's IST timestamp.

const ESCALATION_STATE_PATH = path.join(__dirname, '..', '..', 'state', 'auditEscalations.json');

function _loadEscalations() {
  const st = _readJson(ESCALATION_STATE_PATH, { escalations: [] });
  return Array.isArray(st.escalations) ? st.escalations : [];
}

function escalationSummaryApi(req, res) {
  const days = Math.min(30, Math.max(1, parseInt(req.query.days, 10) || 7));
  const escalations = _loadEscalations();

  // Pre-bucket escalations by their IST calendar day.
  const escByDay = {};
  for (const e of escalations) {
    if (!e || !e.timestamp) continue;
    const d = _istDateOf(e.timestamp);
    if (!d) continue;
    escByDay[d] = (escByDay[d] || 0) + 1;
  }

  const out = [];
  let totalSearches = 0, totalEscalations = 0;
  for (let i = 0; i < days; i++) {
    const iso = _istDay(-i);
    const day = _loadDay(iso);
    const searches = (day.rows || []).length;
    const esc = escByDay[iso] || 0;
    if (searches === 0 && esc === 0) continue;
    totalSearches += searches;
    totalEscalations += esc;
    out.push({ date: iso, searches, escalations: esc });
  }

  res.json({
    days: out,                       // newest-first
    totalSearches,
    totalEscalations,
    escalationRate: totalSearches ? (totalEscalations / totalSearches) * 100 : 0,
    escalationEnabled: String(process.env.FLIGHT_INTL_AUDIT_ESCALATION_ENABLED || 'false').toLowerCase() === 'true',
    lastUpdated: new Date().toISOString(),
  });
}

module.exports = {
  flightIntlAuditStatusApi: statusApi,
  flightIntlAuditTodayApi: todayApi,
  flightIntlAuditHistoryApi: historyApi,
  flightIntlAuditFailuresApi: failuresApi,
  flightIntlAuditAssetApi: assetApi,
  flightIntlAuditDetailApi: detailApi,
  flightIntlAuditVerificationsApi: verificationsApi,
  flightIntlAuditEscalationSummaryApi: escalationSummaryApi,
};
