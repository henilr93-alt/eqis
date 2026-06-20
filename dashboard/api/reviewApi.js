// reviewApi.js — Dashboard endpoints for the Review Pulse engine.
//
// Endpoints:
//   GET /api/review/status              → engine status (enabled flag, today's summary)
//   GET /api/review/today               → today's REVIEW-{YYYY-MM-DD}.json rows
//   GET /api/review/history             → last N days' rolled-up summaries
//   GET /api/review/failures            → failure rows in the last 24h with details
//   GET /api/review/rotation            → current per-route ring buffer
//   GET /api/review/asset/:kind/:runId  → serves screenshot (.png) or recording (.webm)
//   GET /api/review/detail/:runId       → standalone HTML detail page (mirrors search-report)

const fs = require('fs');
const path = require('path');
const logger = require('../../utils/logger');

const REPORTS_DIR = path.join(__dirname, '..', '..', 'reports', 'review');
const ROTATION_FILE = path.join(__dirname, '..', '..', 'state', 'reviewPulseRotation.json');

const { TZ: _RV_TZ } = require('../../utils/timezone');
// IST (Asia/Kolkata) calendar date for today+offsetDays. Review report files are
// named by IST date so "Today" matches the operator's day, not UTC. (Before
// 2026-06-18 these used UTC, so at 00:00-05:30 IST "Today" showed the prior day.)
function _istDay(offset) {
  const d = new Date();
  if (offset) d.setTime(d.getTime() + offset * 86400000);
  return d.toLocaleString('en-CA', { timeZone: _RV_TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).slice(0, 10);
}
function _today() { return _istDay(0); }
function _prevDayIso(iso) { const d = new Date(iso + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() - 1); return d.toISOString().slice(0, 10); }
function _istDateOf(iso) { try { return new Date(iso).toLocaleString('en-CA', { timeZone: _RV_TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).slice(0, 10); } catch (e) { return null; } }
// Load a logical IST day: rows whose startedAt (in IST) falls on `date`. Reads the
// IST-named file AND the previous file, because legacy reports were UTC-named, so
// IST early-morning rows (00:00-05:30) live in the prior day's file. De-dupes by runId.
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
function _readJson(p, fallback) {
  try { if (!fs.existsSync(p)) return fallback; return JSON.parse(fs.readFileSync(p, 'utf-8')); }
  catch (e) { logger.warn('[REVIEW-API] read failed ' + p + ': ' + e.message); return fallback; }
}
function _loadDay(dateIso) {
  return _readJson(path.join(REPORTS_DIR, 'REVIEW-' + dateIso + '.json'), { date: dateIso, rows: [] });
}
function _summarise(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const total = list.length;
  let ok = 0, etravIssues = 0, eqisIssues = 0;
  const verdictCounts = {};
  let loadMsSum = 0, loadMsCount = 0, loadMsP95Pool = [];
  for (const r of list) {
    const v = r.verdict || 'UNKNOWN';
    verdictCounts[v] = (verdictCounts[v] || 0) + 1;
    if (v === 'REVIEW_OK') ok++;
    else if (v === 'PRICE_CHANGED' || v === 'FARE_CHANGE' || v === 'SOLD_OUT' || v === 'FARE_UNAVAILABLE' || v === 'SESSION_EXPIRED' || v === 'BANNER_ERROR' || v === 'FAILED_TO_LOAD' || v === 'RESULTS_NOT_LOADED') etravIssues++;
    else if (v === 'BOOK_BTN_MISSING' || v === 'BOOK_CLICK_NO_NAV' || v === 'REVIEW_LOAD_TIMEOUT' || v === 'JS_ERROR' || v === 'REVIEW_BROKEN' || v === 'TARGET_MISMATCH') eqisIssues++;
    const ms = r.metrics && typeof r.metrics.loadMs === 'number' ? r.metrics.loadMs : null;
    if (ms != null) { loadMsSum += ms; loadMsCount++; loadMsPool(loadMsP95Pool, ms); }
  }
  loadMsP95Pool.sort(function(a, b) { return a - b; });
  const p95 = loadMsP95Pool.length ? loadMsP95Pool[Math.max(0, Math.floor(0.95 * (loadMsP95Pool.length - 1)))] : 0;
  return {
    total,
    ok,
    etravIssues,
    eqisIssues,
    successRate: total ? (ok / total) * 100 : 0,
    avgLoadMs: loadMsCount ? Math.round(loadMsSum / loadMsCount) : 0,
    p95LoadMs: p95,
    verdictCounts,
  };
}
function loadMsPool(arr, ms) { arr.push(ms); }

function reviewStatusApi(req, res) {
  const enabled = String(process.env.REVIEW_PULSE_ENABLED || 'true').toLowerCase() !== 'false';
  const today = _loadIstDay(_today());
  res.json({
    enabled,
    today: { date: today.date, ..._summarise(today.rows) },
    lastUpdated: new Date().toISOString(),
  });
}

function reviewTodayApi(req, res) {
  const date = req.query.date || _today();
  const data = _loadIstDay(date);
  res.json({ date: data.date, rows: data.rows, summary: _summarise(data.rows) });
}

function reviewHistoryApi(req, res) {
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

function reviewFailuresApi(req, res) {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  const dates = [0, -1].map(function(o) { return _istDay(o); });
  const out = [];
  for (const iso of dates) {
    const day = _loadDay(iso);
    for (const r of (day.rows || [])) {
      if (!r || !r.startedAt) continue;
      if (new Date(r.startedAt).getTime() < cutoff) continue;
      if (r.verdict && r.verdict !== 'REVIEW_OK') out.push(r);
    }
  }
  out.sort(function(a, b) { return String(b.startedAt).localeCompare(String(a.startedAt)); });
  res.json({ failures: out.slice(0, 50) });
}

function reviewRotationApi(req, res) {
  res.json(_readJson(ROTATION_FILE, { 'flight-intl': {} }));
}

// ---------------------------------------------------------------- asset serve

function _findRowByRunId(runId) {
  if (!runId || !/^[A-Z0-9-]+$/i.test(runId)) return null;
  for (let i = 0; i < 14; i++) {
    const iso = _istDay(-i);
    const day = _loadDay(iso);
    const hit = (day.rows || []).find(function(r) { return r && r.runId === runId; });
    if (hit) return { row: hit, date: iso };
  }
  return null;
}

function reviewAssetApi(req, res) {
  const kind  = String(req.params.kind || '');
  const runId = String(req.params.runId || '');
  if (!/^[A-Z0-9-]+$/i.test(runId)) return res.status(400).json({ error: 'bad runId' });
  let abs = null, ct = null;
  if (kind === 'screenshot') {
    abs = path.join(REPORTS_DIR, 'screenshots', 'review-' + runId + '.png');
    ct  = 'image/png';
  } else if (kind === 'passenger') {
    abs = path.join(REPORTS_DIR, 'screenshots', 'review-' + runId + '-passenger.png');
    ct  = 'image/png';
  } else if (kind === 'recording') {
    // Prefer MP4 (seekable) — fall back to WebM for older runs.
    const mp4 = path.join(REPORTS_DIR, 'recordings', 'review-' + runId + '.mp4');
    const webm = path.join(REPORTS_DIR, 'recordings', 'review-' + runId + '.webm');
    if (fs.existsSync(mp4)) { abs = mp4; ct = 'video/mp4'; }
    else if (fs.existsSync(webm)) { abs = webm; ct = 'video/webm'; }
  } else {
    return res.status(400).json({ error: 'kind must be screenshot, passenger or recording' });
  }
  if (!abs || !fs.existsSync(abs)) return res.status(404).json({ error: 'not found', kind, runId });
  // Honour HTTP Range so the browser can seek without downloading the full file.
  const stat = fs.statSync(abs);
  const range = req.headers.range;
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Cache-Control', 'public, max-age=86400');
  res.setHeader('Content-Type', ct);
  if (range) {
    const m = /bytes=(\d*)-(\d*)/.exec(range);
    const start = m && m[1] ? parseInt(m[1], 10) : 0;
    const end   = m && m[2] ? parseInt(m[2], 10) : stat.size - 1;
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

function reviewDetailApi(req, res) {
  const runId = String(req.params.runId || '');
  const hit = _findRowByRunId(runId);
  if (!hit) {
    res.status(404).set('Content-Type', 'text/html').send('<h1>Review run ' + _esc(runId) + ' not found</h1>');
    return;
  }
  const r = hit.row;
  const token = encodeURIComponent(String(req.query.token || ''));
  const shotUrl = r.screenshotPath ? '/api/review/asset/screenshot/' + encodeURIComponent(runId) + '?token=' + token : null;
  const paxUrl  = r.passengerShotPath ? '/api/review/asset/passenger/' + encodeURIComponent(runId) + '?token=' + token : null;
  const recUrl  = r.recordingPath  ? '/api/review/asset/recording/'  + encodeURIComponent(runId) + '?token=' + token : null;
  const target  = r.target  || {};
  const metrics = r.metrics || {};
  const startedHuman = r.startedAt ? new Date(r.startedAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false }) + ' IST' : '—';
  const fmtMs = (ms) => ms == null ? '—' : (ms < 1000 ? ms + ' ms' : (ms/1000).toFixed(1) + ' s');
  const verdictTone = r.verdict === 'REVIEW_OK' ? 'ok' : r.severity === 'P1' ? 'err' : 'warn';
  const sevTone = r.severity === 'P1' ? 'err' : r.severity === 'P2' ? 'warn' : 'neu';
  const backHref = '/?token=' + token + '#review';

  const html = '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">'
    + '<meta name="viewport" content="width=device-width,initial-scale=1">'
    + '<title>Review ' + _esc(runId) + ' &middot; ' + _esc(r.sector) + '</title>'
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
    + '.shot-wrap{max-height:560px;overflow:auto;border:1px solid var(--border);border-radius:8px;background:var(--bg);}'
    + '.shot-wrap img.shot{border:0;border-radius:0;display:block;max-width:100%;max-height:none;cursor:zoom-out;}'
    + 'a{color:var(--accent);}'
    + 'details{margin-top:6px;}'
    + 'summary{cursor:pointer;font-size:13px;font-weight:600;color:var(--text);padding:4px 0;list-style:none;}'
    + 'summary::-webkit-details-marker{display:none;}'
    + 'summary::before{content:"\u25B8 ";font-size:11px;color:var(--dim);transition:.15s;}'
    + 'details[open] summary::before{content:"\u25BE ";}'
    + 'pre{background:#0F172A;color:#E2E8F0;padding:14px 16px;border-radius:8px;font-size:12px;overflow-x:auto;font-family:var(--mono);line-height:1.5;}'
    + '.muted{color:var(--muted);font-style:italic;font-size:13px;}'
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

    // Breadcrumb
    + '<div class="crumb"><a href="' + _esc(backHref) + '">EQIS Dashboard</a><span class="sep">/</span><a href="' + _esc(backHref) + '">Review Engine</a><span class="sep">/</span><span>' + _esc(runId) + '</span></div>'

    // Hero card
    + '<div class="hero">'
    +   '<div>'
    +     '<h1>&#x1F50D; ' + _esc(r.sector) + ' &middot; ' + _esc(target.airline || 'Unknown carrier') + (target.flightCode ? ' ' + _esc(target.flightCode) : '') + '</h1>'
    +     '<div class="sub">runId ' + _esc(runId) + ' &middot; ' + _esc(startedHuman) + (r.durationMs ? ' &middot; took ' + fmtMs(r.durationMs) : '') + '</div>'
    +   '</div>'
    +   '<div class="spacer"></div>'
    +   '<span class="pill ' + verdictTone + '">' + _esc(r.verdict || 'UNKNOWN') + '</span>'
    +   (r.severity ? '<span class="pill ' + sevTone + '">' + _esc(r.severity) + '</span>' : '')
    + '</div>'

    // KPI grid
    + '<div class="grid">'
    +   '<div class="card"><div class="k">Sector</div><div class="v">' + _esc(r.sector) + '</div></div>'
    +   '<div class="card"><div class="k">Airline / Flight</div><div class="v">' + _esc(target.airline || '—') + ' &middot; ' + _esc(target.flightCode || '—') + '</div></div>'
    +   '<div class="card"><div class="k">Fare</div><div class="v">' + _esc(target.fareLabel || '—') + (target.price ? ' &middot; &#8377;' + _esc(target.price) : '') + '</div></div>'
    +   '<div class="card"><div class="k">Review page load</div><div class="v">' + fmtMs(metrics.loadMs) + '</div></div>'
    +   '<div class="card"><div class="k">Duration</div><div class="v">' + fmtMs(r.durationMs) + '</div></div>'
    +   '<div class="card"><div class="k">Body text</div><div class="v">' + _esc(metrics.bodyTextLen || '—') + ' chars</div></div>'
    +   '<div class="card"><div class="k">Review URL</div><div class="v">' + (metrics.url ? '<a target="_blank" href="' + _esc(metrics.url) + '">' + _esc(metrics.url) + '</a>' : '—') + '</div></div>'
    +   '<div class="card"><div class="k">Error</div><div class="v">' + (r.error ? _esc(r.error) : '<span class="muted">none</span>') + '</div></div>'
    + '</div>'

    // Recording with chapter markers
    + '<div class="section">'
    +   '<h2>&#x1F4F9; Recording <span class="badge">click a marker to skip to that moment</span></h2>'
    +   (recUrl
        ? (
            '<div class="chapters-wrap">'
          +   '<div class="chapters" id="rp-chapters" data-dur-ms="' + (r.recordingDurationMs || 0) + '">'
          +     ((r.events || []).map(function(e) {
                  var kind = (e.kind || 'event').toLowerCase();
                  var pct = (r.recordingDurationMs && e.tsMs != null) ? Math.max(0, Math.min(99.5, (e.tsMs / r.recordingDurationMs) * 100)) : 0;
                  return '<button class="mk ' + kind + '" style="left:' + pct.toFixed(2) + '%;" data-ts="' + (e.tsMs || 0) + '" title="' + _esc(e.label) + ' @ ' + (e.tsMs || 0) + ' ms">'
                       +   '<span class="mk-lbl">' + _esc(e.label) + ' &middot; ' + ((e.tsMs || 0)/1000).toFixed(1) + 's</span>'
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

    // Passenger-area screenshot (scrolled to the Passenger/Traveller section)
    + '<div class="section">'
    +   '<h2>&#x1F465; Passenger details area <span class="badge">scrolled to the traveller form</span></h2>'
    +   (paxUrl
        ? '<a href="' + _esc(paxUrl) + '" target="_blank" rel="noopener" title="Click to open full-size in a new tab" style="display:inline-block;"><img class="shot" src="' + _esc(paxUrl) + '" alt="passenger-details area screenshot"></a>'
        : '<div class="muted">No passenger-area screenshot for this run (older run, or capture failed).</div>')
    + '</div>'

    // Raw JSON (collapsible)
    + '<div class="section">'
    +   '<details><summary>Raw row JSON</summary>'
    +     '<pre>' + _esc(JSON.stringify(r, null, 2)) + '</pre>'
    +   '</details>'
    + '</div>'

    + '</div></body></html>';
  res.set('Content-Type', 'text/html').send(html);
}

module.exports = {
  reviewStatusApi,
  reviewTodayApi,
  reviewHistoryApi,
  reviewFailuresApi,
  reviewRotationApi,
  reviewAssetApi,
  reviewDetailApi,
};
