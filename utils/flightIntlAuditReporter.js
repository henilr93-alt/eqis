/**
 * flightIntlAuditReporter.js — 3-hourly summary email of Engine 9
 * (Flight INTL Audit: search + book + review on one continuous run).
 *
 * Sends a summarised report covering, for the chosen time window:
 *   • how many searches were performed
 *   • how many failed on the SEARCH page
 *   • how many failed on the REVIEW page
 *   • top failure reasons (high → low) for searches AND reviews
 *   • which airlines failed on the review page
 *   • which searches failed on the search page (sector + reason)
 *
 * Self-contained and ADDITIVE: it only READS reports/flight-intl-audit/*.json
 * and reuses utils/mailer + utils/emailHistory. It does NOT touch any engine,
 * the daily-digest pipeline, or state/emailRoster.json.
 *
 * Boot integration: call register() once at EQIS boot — schedules the
 * "0 *​/3 * * *" cron (Asia/Kolkata). runOnce() is exposed for manual / CLI
 * triggering (e.g. test sends).
 */

const fs = require('fs');
const path = require('path');
const cron = require('node-cron');
const logger = require('./logger');
const mailer = require('./mailer');
const emailHistory = require('./emailHistory');

let TZ = 'Asia/Kolkata';
try { TZ = require('./timezone').TZ || TZ; } catch (e) { /* fallback above */ }

const REPORTS_DIR = path.join(__dirname, '..', 'reports', 'flight-intl-audit');
const REPORT_TYPE = 'flight_intl_audit_3h';
const REPORT_TYPE_DAILY = 'flight_intl_audit_24h';
const WINDOW_HOURS = 3;

// Recipients (kept OUT of state/emailRoster.json — that file is the CEO-managed
// daily-9am pipeline). Override with a comma-separated env var if needed.
const DEFAULT_RECIPIENTS = [
  'frank@codemagen.com',
  'alpesh.p@etrav.in',
  'kavin.p@codemagen.com',
  'director@etrav.in',
];
function recipients() {
  const env = process.env.FLIGHT_INTL_AUDIT_REPORT_RECIPIENTS;
  if (env && env.trim()) {
    return env.split(',').map((s) => s.trim()).filter(Boolean);
  }
  return DEFAULT_RECIPIENTS.slice();
}

/* ───────────────────────── Friendly labels ───────────────────────── */
// Plain-English label + which side owns the failure (Etrav vs EQIS automation).
const SEARCH_STATUS_INFO = {
  SUCCESS: { label: 'Search succeeded', side: 'OK' },
  FAILED: { label: 'Search timed out / hung', side: 'Etrav' },
  AUTOSUGGEST_DOWN: { label: 'City autosuggest not responding', side: 'Etrav' },
  ZERO_RESULTS: { label: 'No flights returned', side: 'Etrav' },
  ETRAV_FORM_CRASH: { label: 'Search form crashed', side: 'Etrav' },
  AUTOMATION_DATE_INCOMPLETE: { label: 'Date picker misfire', side: 'EQIS' },
  FLIGHT_FORM_NOT_LOADED: { label: 'Search form did not load', side: 'EQIS' },
  EQIS_AUTOMATION_BUG: { label: 'EQIS automation bug', side: 'EQIS' },
  UNKNOWN: { label: 'Unknown', side: '—' },
};
const REVIEW_VERDICT_INFO = {
  REVIEW_OK: { label: 'Review OK', side: 'OK' },
  SKIPPED: { label: 'Review skipped (search failed)', side: '—' },
  FAILED_TO_LOAD: { label: 'Review page failed to load', side: 'Etrav' },
  RESULTS_NOT_LOADED: { label: 'Results did not load', side: 'Etrav' },
  SOLD_OUT: { label: 'Sold out on review', side: 'Etrav' },
  PRICE_CHANGED: { label: 'Price changed on review', side: 'Etrav' },
  FARE_CHANGE: { label: 'Fare changed on review', side: 'Etrav' },
  FARE_UNAVAILABLE: { label: 'Fare unavailable on review', side: 'Etrav' },
  SESSION_EXPIRED: { label: 'Session expired', side: 'Etrav' },
  BANNER_ERROR: { label: 'Error banner shown', side: 'Etrav' },
  TARGET_MISMATCH: { label: 'Wrong flight shown vs selected', side: 'EQIS' },
  BOOK_BTN_MISSING: { label: 'Book button missing', side: 'EQIS' },
  BOOK_CLICK_NO_NAV: { label: 'Book click did not navigate', side: 'EQIS' },
  REVIEW_LOAD_TIMEOUT: { label: 'Review load timed out', side: 'EQIS' },
  REVIEW_BROKEN: { label: 'Review automation broke', side: 'EQIS' },
  JS_ERROR: { label: 'JavaScript error', side: 'EQIS' },
};
function searchLabel(s) { return (SEARCH_STATUS_INFO[s] || { label: s }).label; }
function searchSide(s) { return (SEARCH_STATUS_INFO[s] || { side: '—' }).side; }
function verdictLabel(v) { return (REVIEW_VERDICT_INFO[v] || { label: v }).label; }
function verdictSide(v) { return (REVIEW_VERDICT_INFO[v] || { side: '—' }).side; }

/* ───────────────────────────── Date helpers ──────────────────────── */
function _istDate(ms) {
  return new Date(ms).toLocaleString('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  }).slice(0, 10);
}
function _istClock(ms) {
  return new Date(ms).toLocaleString('en-GB', {
    timeZone: TZ, day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
  });
}
// All IST calendar dates the [startMs, endMs] window touches (so we load the
// right AUDIT-{date}.json files even across an IST midnight boundary).
function _istDatesInRange(startMs, endMs) {
  const dates = new Set();
  for (let t = startMs; t <= endMs + 86400000; t += 43200000) { // 12h steps
    dates.add(_istDate(t));
    if (t > endMs) break;
  }
  dates.add(_istDate(endMs));
  return Array.from(dates);
}

// IST is a fixed UTC+5:30 offset (no daylight saving) — used to turn an IST
// calendar date into exact millisecond day boundaries for the daily report.
const IST_OFFSET_MS = 5.5 * 3600 * 1000;
function _istMidnightMs(dateIso) {
  // 00:00:00 IST of dateIso === that day's UTC midnight minus the +5:30 offset.
  return Date.parse(dateIso + 'T00:00:00.000Z') - IST_OFFSET_MS;
}
// The full previous IST calendar day relative to nowMs:
//   startMs = yesterday 00:00 IST, endMs = today 00:00 IST.
function _prevDayWindow(nowMs) {
  const now = nowMs || Date.now();
  const todayIso = _istDate(now);
  const endMs = _istMidnightMs(todayIso);   // today 00:00 IST (yesterday just ended)
  const startMs = endMs - 86400000;         // yesterday 00:00 IST
  const dayIso = _istDate(startMs + 3600000); // sample mid-window → yesterday's date
  return { startMs, endMs, dayIso };
}

function _readDay(dateIso) {
  try {
    const p = path.join(REPORTS_DIR, 'AUDIT-' + dateIso + '.json');
    if (!fs.existsSync(p)) return [];
    const data = JSON.parse(fs.readFileSync(p, 'utf-8'));
    return Array.isArray(data.rows) ? data.rows : [];
  } catch (e) {
    logger.warn('[FIA-REPORT] read failed ' + dateIso + ': ' + e.message);
    return [];
  }
}

/* ─────────────────────────────── Gather ──────────────────────────── */
/**
 * Collect Engine 9 audit rows whose startedAt falls inside the window.
 * @param {Object} [opts]
 * @param {number} [opts.windowHours=3] how many hours back to cover
 * @param {number} [opts.endMs=Date.now()] window end
 */
function gather(opts) {
  const o = opts || {};
  const endMs = o.endMs || Date.now();
  const windowHours = o.windowHours || WINDOW_HOURS;
  const startMs = endMs - windowHours * 3600 * 1000;

  const seen = new Set();
  const rows = [];
  for (const d of _istDatesInRange(startMs, endMs)) {
    for (const r of _readDay(d)) {
      if (!r || !r.startedAt) continue;
      const t = new Date(r.startedAt).getTime();
      if (isNaN(t) || t < startMs || t > endMs) continue;
      const id = r.runId || (String(r.sector) + '|' + String(r.startedAt));
      if (seen.has(id)) continue;
      seen.add(id);
      rows.push(r);
    }
  }
  return { rows, startMs, endMs, windowHours };
}

/* ───────────────────────────── Aggregate ─────────────────────────── */
function _topEntries(countMap) {
  return Object.entries(countMap).sort((a, b) => b[1] - a[1]);
}

function aggregate(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const total = list.length;

  let searchFail = 0, reviewFail = 0, reviewOk = 0, reviewSkipped = 0;
  const searchFailByStatus = {};
  const reviewFailByVerdict = {};
  const reviewFailByAirline = {};
  // Full rows grouped by failure reason, so we can show the detail tables for
  // the single #1 reason on each side.
  const searchFailRowsByStatus = {};
  const reviewFailRowsByVerdict = {};

  for (const r of list) {
    const s = (r.search && r.search.status) || r.searchStatus || 'UNKNOWN';
    const v = r.verdict || (r.review && r.review.verdict) || 'UNKNOWN';

    // SEARCH side
    if (s !== 'SUCCESS') {
      searchFail++;
      searchFailByStatus[s] = (searchFailByStatus[s] || 0) + 1;
      (searchFailRowsByStatus[s] = searchFailRowsByStatus[s] || []).push(r);
    }

    // REVIEW side
    if (v === 'REVIEW_OK') { reviewOk++; }
    else if (v === 'SKIPPED') { reviewSkipped++; }
    else if (v && v !== 'UNKNOWN') {
      reviewFail++;
      reviewFailByVerdict[v] = (reviewFailByVerdict[v] || 0) + 1;
      const air = (r.review && r.review.target && r.review.target.airline)
        || (r.target && r.target.airline) || '(unknown airline)';
      reviewFailByAirline[air] = (reviewFailByAirline[air] || 0) + 1;
      (reviewFailRowsByVerdict[v] = reviewFailRowsByVerdict[v] || []).push(r);
    }
  }

  const topSearchReasons = _topEntries(searchFailByStatus);
  const topReviewReasons = _topEntries(reviewFailByVerdict);

  // The single #1 reason on each side + its detail rows.
  const topSearchStatus = topSearchReasons.length ? topSearchReasons[0][0] : null;
  const topReviewVerdict = topReviewReasons.length ? topReviewReasons[0][0] : null;

  return {
    total,
    searchSuccess: total - searchFail,
    searchFail,
    reviewOk,
    reviewFail,
    reviewSkipped,
    topSearchReasons,
    topReviewReasons,
    reviewFailAirlines: _topEntries(reviewFailByAirline),
    // #1-reason detail blocks for the two new tables
    topSearchStatus,
    topSearchRows: topSearchStatus ? searchFailRowsByStatus[topSearchStatus] : [],
    topReviewVerdict,
    topReviewRows: topReviewVerdict ? reviewFailRowsByVerdict[topReviewVerdict] : [],
  };
}

// Split a day's rows into the 8 fixed 3-hour blocks (12–3am … 9pm–12am IST) so
// the daily summary can show WHEN failures spiked. startMs = day 00:00 IST.
const TIMELINE_LABELS = [
  '12–3am', '3–6am', '6–9am', '9am–12pm',
  '12–3pm', '3–6pm', '6–9pm', '9pm–12am',
];
function timeline(rows, startMs) {
  const blocks = TIMELINE_LABELS.map((label) => ({
    label, total: 0, searchFail: 0, reviewFail: 0, reviewOk: 0,
  }));
  const BLOCK_MS = 3 * 3600 * 1000;
  for (const r of (Array.isArray(rows) ? rows : [])) {
    const t = new Date(r.startedAt).getTime();
    if (isNaN(t)) continue;
    let idx = Math.floor((t - startMs) / BLOCK_MS);
    if (idx < 0) idx = 0; if (idx > 7) idx = 7;
    const b = blocks[idx];
    b.total++;
    const s = (r.search && r.search.status) || r.searchStatus || 'UNKNOWN';
    if (s !== 'SUCCESS') b.searchFail++;
    const v = r.verdict || (r.review && r.review.verdict) || 'UNKNOWN';
    if (v === 'REVIEW_OK') b.reviewOk++;
    else if (v && v !== 'UNKNOWN' && v !== 'SKIPPED') b.reviewFail++;
  }
  return blocks;
}

/* ───────────────────────────── Render HTML ───────────────────────── */
function _esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function _pct(n, d) { return d ? Math.round((n / d) * 100) : 0; }

function _kpiCard(label, value, sub, color) {
  return '<td style="padding:14px 16px;background:#fff;border:1px solid #e5e7eb;border-radius:10px;vertical-align:top;">'
    + '<div style="font-size:28px;font-weight:700;color:' + (color || '#111827') + ';line-height:1.1;">' + value + '</div>'
    + '<div style="font-size:12px;color:#6b7280;margin-top:4px;">' + _esc(label) + '</div>'
    + (sub ? '<div style="font-size:11px;color:#9ca3af;margin-top:2px;">' + _esc(sub) + '</div>' : '')
    + '</td>';
}

function _reasonTable(title, entries, labelFn, sideFn, emptyMsg) {
  let rows = '';
  if (!entries.length) {
    rows = '<tr><td colspan="3" style="padding:10px 12px;color:#6b7280;font-size:13px;">' + _esc(emptyMsg) + '</td></tr>';
  } else {
    entries.forEach(([key, count], i) => {
      const bg = i % 2 ? '#fafafa' : '#fff';
      rows += '<tr style="background:' + bg + ';">'
        + '<td style="padding:9px 12px;font-size:13px;color:#111827;border-top:1px solid #eee;">' + _esc(labelFn(key)) + '</td>'
        + '<td style="padding:9px 12px;font-size:12px;color:#6b7280;border-top:1px solid #eee;">' + _esc(sideFn(key)) + '</td>'
        + '<td style="padding:9px 12px;font-size:14px;font-weight:600;text-align:right;color:#111827;border-top:1px solid #eee;">' + count + '</td>'
        + '</tr>';
    });
  }
  return '<h3 style="font-size:15px;color:#111827;margin:22px 0 8px;">' + _esc(title) + '</h3>'
    + '<table width="100%" cellspacing="0" cellpadding="0" style="border:1px solid #e5e7eb;border-radius:8px;border-collapse:separate;overflow:hidden;">'
    + '<tr style="background:#f3f4f6;"><th style="text-align:left;padding:8px 12px;font-size:11px;color:#6b7280;text-transform:uppercase;">Reason</th>'
    + '<th style="text-align:left;padding:8px 12px;font-size:11px;color:#6b7280;text-transform:uppercase;">Side</th>'
    + '<th style="text-align:right;padding:8px 12px;font-size:11px;color:#6b7280;text-transform:uppercase;">Count</th></tr>'
    + rows + '</table>';
}

// Small clickable "link" cell — shows a short label, opens the real URL.
function _linkCell(url, label) {
  if (!url) return '<span style="color:#9ca3af;font-size:12px;">—</span>';
  return '<a href="' + _esc(url) + '" style="color:#2563eb;font-size:12px;text-decoration:underline;" target="_blank">' + _esc(label || 'Open') + '</a>';
}

// Search-ID cell — shows the run ID as monospace, copy-paste-able text so the
// tech team can look the search up directly in the PMS (Etrav links resolve to
// the home page and aren't reliable, so we surface the ID instead).
function _idCell(id) {
  if (!id || id === '—') return '<span style="color:#9ca3af;font-size:12px;">—</span>';
  return '<span style="font-family:monospace;font-size:12px;color:#111827;background:#f3f4f6;padding:2px 6px;border-radius:4px;">' + _esc(id) + '</span>';
}

// Compact pill-style hyperlink button — shows a short label, opens the real URL
// in a new tab. Used to surface the raw Etrav search link next to the Search ID.
function _linkBtn(url, label) {
  if (!url) return '';
  return '<a href="' + _esc(url) + '" target="_blank" style="display:inline-block;font-size:11px;font-weight:600;color:#fff;background:#2563eb;padding:3px 9px;border-radius:5px;text-decoration:none;">' + _esc(label || 'Open') + '</a>';
}

// Horizontal bar chart as a PNG via QuickChart.io — same proven approach the
// daily-digest emails use (renders in every mail client). `entries` is
// [[key, count], ...] already sorted high → low; labelFn turns a key into plain
// English. Each bar's label carries the reason + share %, and the raw count
// sits at the bar tip — everything readable at a glance, no hover needed.
const PIE_COLORS = ['#dc2626', '#ea580c', '#d97706', '#0891b2', '#7c3aed', '#475569', '#0d9488'];
function _shortLabel(s, n) {
  s = String(s);
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}
function _barImg(title, entries, labelFn) {
  if (!entries || !entries.length) {
    return '<div style="text-align:center;padding:24px 8px;color:#16a34a;font-size:13px;">No failures in this window. 🎉</div>';
  }
  // Keep the top 6 reasons, roll everything else into "Other".
  const TOP = 6;
  const slices = entries.slice(0, TOP).map(([k, c]) => [labelFn(k), c]);
  const restCount = entries.slice(TOP).reduce((a, [, c]) => a + c, 0);
  if (restCount > 0) slices.push(['Other', restCount]);

  const total = entries.reduce((a, [, c]) => a + c, 0) || 1;
  // Axis label = "Reason (38%)"; the count number rides at the bar tip. The
  // wider chart lets us show fuller reason text before truncating.
  const labels = slices.map(([l, c]) => _shortLabel(l, 44) + ' (' + Math.round((c / total) * 100) + '%)');
  const data = slices.map(([, c]) => c);
  const colors = slices.map((_, i) => PIE_COLORS[i % PIE_COLORS.length]);
  const maxVal = Math.max.apply(null, data);

  // Chart.js v3 syntax — a horizontal bar is now type:'bar' + indexAxis:'y'.
  // (The old 'horizontalBar' type forced QuickChart into v2, which silently
  //  ignored options.plugins.* — that's why the title/header never showed and a
  //  stray "undefined" appeared. We force v3 via the &v=3 URL param below.)
  const config = {
    type: 'bar',
    data: { labels, datasets: [{ data, backgroundColor: colors, borderWidth: 0 }] },
    options: {
      indexAxis: 'y',
      layout: { padding: { right: 30, left: 6, top: 4, bottom: 4 } },
      plugins: {
        legend: { display: false },
        datalabels: { display: true, anchor: 'end', align: 'right', color: '#111827', font: { size: 13, weight: 'bold' } },
      },
      scales: {
        x: { beginAtZero: true, suggestedMax: Math.ceil(maxVal * 1.15), ticks: { precision: 0 }, grid: { color: '#eee' } },
        y: { ticks: { font: { size: 13 }, color: '#111827' }, grid: { display: false } },
      },
    },
  };
  const height = 60 + slices.length * 44;
  const url = 'https://quickchart.io/chart?v=3&w=880&h=' + height + '&bkg=white&c=' + encodeURIComponent(JSON.stringify(config));
  return '<img src="' + url + '" width="880" alt="' + _esc(title) + '" style="display:block;width:100%;max-width:880px;margin:0;" />';
}

// ── Table 1: searches that hit the #1 SEARCH-page failure reason ──
// Columns: Sector · Search date · Passengers + Cabin · Trip type + Search link
function _searchDetailTable(agg) {
  const title = 'Searches that hit the top search-page failure'
    + (agg.topSearchStatus ? ' — ' + searchLabel(agg.topSearchStatus) : '');
  const rowsData = agg.topSearchRows || [];
  let body;
  if (!rowsData.length) {
    body = '<tr><td colspan="4" style="padding:10px 12px;color:#6b7280;font-size:13px;">No search-page failures in this window. 🎉</td></tr>';
  } else {
    body = '';
    rowsData.forEach((r, i) => {
      const bg = i % 2 ? '#fafafa' : '#fff';
      const sector = r.sector || '—';
      const searchDate = r.searchDate || '—';
      const pax = r.paxCount || '—';
      const cabin = r.cabinClass || '—';
      const trip = r.tripType || '—';
      const searchId = r.runId || '—';
      const searchUrl = (r.search && r.search.searchUrl) || r.searchUrl || '';
      body += '<tr style="background:' + bg + ';">'
        + '<td style="padding:9px 12px;font-size:13px;font-weight:600;white-space:nowrap;border-top:1px solid #eee;vertical-align:top;">' + _esc(sector) + '</td>'
        + '<td style="padding:9px 12px;font-size:12px;border-top:1px solid #eee;vertical-align:top;white-space:nowrap;">' + _esc(searchDate) + '</td>'
        + '<td style="padding:9px 12px;font-size:12px;color:#4b5563;border-top:1px solid #eee;vertical-align:top;">' + _esc(pax) + ' · ' + _esc(cabin) + '</td>'
        + '<td style="padding:9px 12px;font-size:12px;border-top:1px solid #eee;vertical-align:top;white-space:nowrap;">' + _esc(trip) + ' · ' + _idCell(searchId) + ' ' + _linkBtn(searchUrl, 'Open search') + '</td>'
        + '</tr>';
    });
  }
  return '<h3 style="font-size:15px;color:#111827;margin:22px 0 8px;">' + _esc(title) + '</h3>'
    + '<table width="100%" cellspacing="0" cellpadding="0" style="border:1px solid #e5e7eb;border-radius:8px;border-collapse:separate;overflow:hidden;">'
    + '<tr style="background:#f3f4f6;">'
    + '<th style="text-align:left;padding:8px 12px;font-size:11px;color:#6b7280;text-transform:uppercase;">Sector</th>'
    + '<th style="text-align:left;padding:8px 12px;font-size:11px;color:#6b7280;text-transform:uppercase;">Search date</th>'
    + '<th style="text-align:left;padding:8px 12px;font-size:11px;color:#6b7280;text-transform:uppercase;">Passengers · Cabin</th>'
    + '<th style="text-align:left;padding:8px 12px;font-size:11px;color:#6b7280;text-transform:uppercase;">Trip · Search ID · Link</th></tr>'
    + body + '</table>';
}

// ── Table 2: searches that hit the #1 REVIEW-page failure reason ──
// Columns: Sector · Airline + flight no. · Fare + price · Review page link
function _reviewDetailTable(agg) {
  const title = 'Reviews that hit the top review-page failure'
    + (agg.topReviewVerdict ? ' — ' + verdictLabel(agg.topReviewVerdict) : '');
  const rowsData = agg.topReviewRows || [];
  let body;
  if (!rowsData.length) {
    body = '<tr><td colspan="4" style="padding:10px 12px;color:#6b7280;font-size:13px;">No review-page failures in this window. 🎉</td></tr>';
  } else {
    body = '';
    rowsData.forEach((r, i) => {
      const bg = i % 2 ? '#fafafa' : '#fff';
      const tgt = (r.review && r.review.target) || r.target || {};
      const sector = r.sector || '—';
      const airline = tgt.airline || '(unknown airline)';
      const flightCode = tgt.flightCode || '';
      const fareLabel = tgt.fareLabel || '—';
      const price = tgt.price ? ('₹' + tgt.price) : '—';
      const searchId = r.runId || '—';
      body += '<tr style="background:' + bg + ';">'
        + '<td style="padding:9px 12px;font-size:13px;font-weight:600;white-space:nowrap;border-top:1px solid #eee;vertical-align:top;">' + _esc(sector) + '</td>'
        + '<td style="padding:9px 12px;font-size:12px;color:#4b5563;border-top:1px solid #eee;vertical-align:top;">' + _esc(airline) + (flightCode ? ' · ' + _esc(flightCode) : '') + '</td>'
        + '<td style="padding:9px 12px;font-size:12px;color:#4b5563;border-top:1px solid #eee;vertical-align:top;">' + _esc(fareLabel) + ' · ' + _esc(price) + '</td>'
        + '<td style="padding:9px 12px;font-size:12px;border-top:1px solid #eee;vertical-align:top;white-space:nowrap;">' + _idCell(searchId) + '</td>'
        + '</tr>';
    });
  }
  return '<h3 style="font-size:15px;color:#111827;margin:22px 0 8px;">' + _esc(title) + '</h3>'
    + '<table width="100%" cellspacing="0" cellpadding="0" style="border:1px solid #e5e7eb;border-radius:8px;border-collapse:separate;overflow:hidden;">'
    + '<tr style="background:#f3f4f6;">'
    + '<th style="text-align:left;padding:8px 12px;font-size:11px;color:#6b7280;text-transform:uppercase;">Sector</th>'
    + '<th style="text-align:left;padding:8px 12px;font-size:11px;color:#6b7280;text-transform:uppercase;">Airline · Flight</th>'
    + '<th style="text-align:left;padding:8px 12px;font-size:11px;color:#6b7280;text-transform:uppercase;">Fare · Price</th>'
    + '<th style="text-align:left;padding:8px 12px;font-size:11px;color:#6b7280;text-transform:uppercase;">Search ID</th></tr>'
    + body + '</table>';
}

function render(agg, meta) {
  const windowLabel = _istClock(meta.startMs) + ' → ' + _istClock(meta.endMs) + ' IST';
  const subject = 'EQIS · Flight INTL Audit — ' + agg.searchFail + ' search + ' + agg.reviewFail
    + ' review failures (last ' + meta.windowHours + 'h)';

  // Airlines that failed on review
  let airlineTable;
  if (!agg.reviewFailAirlines.length) {
    airlineTable = '<p style="font-size:13px;color:#6b7280;">No airlines failed on the review page in this window.</p>';
  } else {
    let rows = '';
    agg.reviewFailAirlines.forEach(([air, count], i) => {
      const bg = i % 2 ? '#fafafa' : '#fff';
      rows += '<tr style="background:' + bg + ';"><td style="padding:9px 12px;font-size:13px;border-top:1px solid #eee;">' + _esc(air) + '</td>'
        + '<td style="padding:9px 12px;font-size:14px;font-weight:600;text-align:right;border-top:1px solid #eee;">' + count + '</td></tr>';
    });
    airlineTable = '<table width="100%" cellspacing="0" cellpadding="0" style="border:1px solid #e5e7eb;border-radius:8px;border-collapse:separate;overflow:hidden;">'
      + '<tr style="background:#f3f4f6;"><th style="text-align:left;padding:8px 12px;font-size:11px;color:#6b7280;text-transform:uppercase;">Airline</th>'
      + '<th style="text-align:right;padding:8px 12px;font-size:11px;color:#6b7280;text-transform:uppercase;">Review failures</th></tr>'
      + rows + '</table>';
  }

  // ── #1 SEARCH-page failure reason → search-detail table ──
  // Columns: Sector · Search date · Passengers + Cabin · Trip type + Search link
  const searchDetailTable = _searchDetailTable(agg);

  // ── #1 REVIEW-page failure reason → review-detail table ──
  // Columns: Sector · Airline + flight no. · Fare + price · Review page link
  const reviewDetailTable = _reviewDetailTable(agg);

  // ── Two bar charts at the top: search-fail reasons + review-fail reasons ──
  const searchBars = _barImg('Search-page failures by reason', agg.topSearchReasons, searchLabel);
  const reviewBars = _barImg('Review-page failures by reason', agg.topReviewReasons, verdictLabel);
  // Each chart gets its own clear HTML header so the reader always knows which
  // one is the search-page chart vs the review-page chart (guaranteed visible,
  // independent of whatever the chart image renders).
  const pieRow = '<h3 style="font-size:15px;color:#111827;margin:22px 0 10px;">Failure breakdown</h3>'
    + '<div style="margin-bottom:22px;">'
    +   '<h4 style="font-size:13px;color:#374151;margin:0 0 6px;font-weight:700;">🔍 Search-page failures (why a search did not work)</h4>'
    +   searchBars
    + '</div>'
    + '<div style="margin-bottom:6px;">'
    +   '<h4 style="font-size:13px;color:#374151;margin:0 0 6px;font-weight:700;">📋 Review-page failures (why the booking review did not work)</h4>'
    +   reviewBars
    + '</div>';

  const html = ''
    + '<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;background:#f3f4f6;padding:24px;">'
    + '<div style="max-width:960px;width:100%;margin:0 auto;background:#fff;border-radius:14px;overflow:hidden;border:1px solid #e5e7eb;">'
    // header
    + '<div style="background:#0f172a;padding:22px 24px;">'
    + '<div style="color:#fff;font-size:18px;font-weight:700;">Flight INTL Audit — Summary Report</div>'
    + '<div style="color:#94a3b8;font-size:13px;margin-top:4px;">Window: ' + _esc(windowLabel) + '</div>'
    + '<div style="color:#64748b;font-size:12px;margin-top:2px;">Engine 9 · search → book → review</div>'
    + '</div>'
    + '<div style="padding:24px;">'
    // KPIs
    + '<table width="100%" cellspacing="8" cellpadding="0" style="border-collapse:separate;"><tr>'
    + _kpiCard('Searches performed', agg.total, null, '#111827')
    + _kpiCard('Failed on search page', agg.searchFail, _pct(agg.searchFail, agg.total) + '% of searches', agg.searchFail ? '#dc2626' : '#16a34a')
    + _kpiCard('Failed on review page', agg.reviewFail, _pct(agg.reviewFail, agg.reviewOk + agg.reviewFail) + '% of reviews', agg.reviewFail ? '#dc2626' : '#16a34a')
    + '</tr></table>'
    + '<div style="font-size:12px;color:#6b7280;margin-top:10px;">'
    + 'Reviews passed: <b style="color:#16a34a;">' + agg.reviewOk + '</b> · '
    + 'Reviews skipped (search failed first): <b>' + agg.reviewSkipped + '</b>'
    + '</div>'
    // pie charts (replaces the old text reason-tables)
    + pieRow
    + '<h3 style="font-size:15px;color:#111827;margin:22px 0 8px;">Airlines that failed on review</h3>'
    + airlineTable
    + searchDetailTable
    + reviewDetailTable
    + '<p style="font-size:11px;color:#9ca3af;margin-top:24px;border-top:1px solid #eee;padding-top:12px;">'
    + 'Generated by EQIS · ' + _esc(_istClock(meta.endMs)) + ' IST. "Side" shows whether the failure is on the Etrav platform or EQIS automation.'
    + '</p>'
    + '</div></div></div>';

  const summaryLine = agg.total + ' searches · ' + agg.searchFail + ' search-fail · '
    + agg.reviewFail + ' review-fail · ' + agg.reviewOk + ' review-ok';

  return { subject, html, summaryLine, recordCount: agg.total };
}

/* ───────────────────── Daily (24-hour) summary ───────────────────── */
// Pretty "Fri 20 Jun 2026" label from a YYYY-MM-DD IST date.
function _dayLabel(dayIso) {
  const ms = _istMidnightMs(dayIso) + 12 * 3600000; // midday → safe from boundaries
  return new Date(ms).toLocaleDateString('en-GB', {
    timeZone: TZ, weekday: 'short', day: '2-digit', month: 'short', year: 'numeric',
  });
}

// Grouped bar chart: search-fail vs review-fail per 3-hour block (when spikes hit).
function _timelineChartImg(blocks) {
  const labels = blocks.map((b) => b.label);
  const searchData = blocks.map((b) => b.searchFail);
  const reviewData = blocks.map((b) => b.reviewFail);
  if (!searchData.some((n) => n > 0) && !reviewData.some((n) => n > 0)) {
    return '<div style="text-align:center;padding:18px 8px;color:#16a34a;font-size:13px;">No failures across any 3-hour block. 🎉</div>';
  }
  const config = {
    type: 'bar',
    data: {
      labels,
      datasets: [
        { label: 'Search-page failures', data: searchData, backgroundColor: '#dc2626' },
        { label: 'Review-page failures', data: reviewData, backgroundColor: '#ea580c' },
      ],
    },
    options: {
      plugins: {
        legend: { display: true, position: 'top', labels: { font: { size: 12 } } },
        datalabels: { display: false },
      },
      scales: {
        x: { grid: { display: false }, ticks: { font: { size: 11 }, color: '#111827' } },
        y: { beginAtZero: true, ticks: { precision: 0 }, grid: { color: '#eee' } },
      },
    },
  };
  const url = 'https://quickchart.io/chart?v=3&w=880&h=300&bkg=white&c=' + encodeURIComponent(JSON.stringify(config));
  return '<img src="' + url + '" width="880" alt="Failures by 3-hour block" style="display:block;width:100%;max-width:880px;margin:0;" />';
}

// 8-row timeline table + an "All day" totals row.
function _timelineTable(blocks) {
  let body = '';
  let tT = 0, tS = 0, tR = 0, tO = 0;
  blocks.forEach((b, i) => {
    const bg = i % 2 ? '#fafafa' : '#fff';
    tT += b.total; tS += b.searchFail; tR += b.reviewFail; tO += b.reviewOk;
    body += '<tr style="background:' + bg + ';">'
      + '<td style="padding:8px 12px;font-size:13px;font-weight:600;border-top:1px solid #eee;">' + _esc(b.label) + '</td>'
      + '<td style="padding:8px 12px;font-size:13px;text-align:right;border-top:1px solid #eee;">' + b.total + '</td>'
      + '<td style="padding:8px 12px;font-size:13px;text-align:right;border-top:1px solid #eee;color:' + (b.searchFail ? '#dc2626' : '#6b7280') + ';">' + b.searchFail + '</td>'
      + '<td style="padding:8px 12px;font-size:13px;text-align:right;border-top:1px solid #eee;color:' + (b.reviewFail ? '#dc2626' : '#6b7280') + ';">' + b.reviewFail + '</td>'
      + '<td style="padding:8px 12px;font-size:13px;text-align:right;border-top:1px solid #eee;color:#16a34a;">' + b.reviewOk + '</td>'
      + '</tr>';
  });
  body += '<tr style="background:#f3f4f6;font-weight:700;">'
    + '<td style="padding:9px 12px;font-size:13px;border-top:2px solid #e5e7eb;">All day</td>'
    + '<td style="padding:9px 12px;font-size:13px;text-align:right;border-top:2px solid #e5e7eb;">' + tT + '</td>'
    + '<td style="padding:9px 12px;font-size:13px;text-align:right;border-top:2px solid #e5e7eb;color:' + (tS ? '#dc2626' : '#111827') + ';">' + tS + '</td>'
    + '<td style="padding:9px 12px;font-size:13px;text-align:right;border-top:2px solid #e5e7eb;color:' + (tR ? '#dc2626' : '#111827') + ';">' + tR + '</td>'
    + '<td style="padding:9px 12px;font-size:13px;text-align:right;border-top:2px solid #e5e7eb;color:#16a34a;">' + tO + '</td>'
    + '</tr>';
  return '<table width="100%" cellspacing="0" cellpadding="0" style="border:1px solid #e5e7eb;border-radius:8px;border-collapse:separate;overflow:hidden;margin-top:12px;">'
    + '<tr style="background:#f3f4f6;">'
    + '<th style="text-align:left;padding:8px 12px;font-size:11px;color:#6b7280;text-transform:uppercase;">Time block (IST)</th>'
    + '<th style="text-align:right;padding:8px 12px;font-size:11px;color:#6b7280;text-transform:uppercase;">Searches</th>'
    + '<th style="text-align:right;padding:8px 12px;font-size:11px;color:#6b7280;text-transform:uppercase;">Search-fail</th>'
    + '<th style="text-align:right;padding:8px 12px;font-size:11px;color:#6b7280;text-transform:uppercase;">Review-fail</th>'
    + '<th style="text-align:right;padding:8px 12px;font-size:11px;color:#6b7280;text-transform:uppercase;">Review-OK</th></tr>'
    + body + '</table>';
}

// One change figure with arrow + colour. lowerIsBetter: true=fails (down=green),
// false=good metrics (up=green), null=neutral (grey).
function _changeCell(delta, lowerIsBetter) {
  if (delta === 0) return '<span style="color:#6b7280;">■ 0</span>';
  const up = delta > 0;
  let color = '#6b7280';
  if (lowerIsBetter === true || lowerIsBetter === false) {
    const good = lowerIsBetter ? !up : up;
    color = good ? '#16a34a' : '#dc2626';
  }
  return '<span style="color:' + color + ';font-weight:600;">' + (up ? '▲' : '▼') + ' ' + (up ? '+' : '') + delta + '</span>';
}

// Day-over-day comparison table (this day vs the day before).
function _trendTable(agg, prevAgg) {
  const hasPrev = prevAgg && prevAgg.total > 0;
  const p = (k) => (prevAgg ? prevAgg[k] : 0);
  const cell = (v) => '<td style="padding:9px 12px;font-size:13px;text-align:right;border-top:1px solid #eee;">' + v + '</td>';
  const mcell = (v) => '<td style="padding:9px 12px;font-size:13px;border-top:1px solid #eee;">' + v + '</td>';
  const row = (metric, cur, prev, change) =>
    '<tr>' + mcell(metric) + cell(cur) + cell(hasPrev ? prev : '—') + cell(hasPrev ? change : '—') + '</tr>';

  const sfPct = _pct(agg.searchFail, agg.total);
  const rfPct = _pct(agg.reviewFail, agg.reviewOk + agg.reviewFail);
  const psfPct = hasPrev ? _pct(p('searchFail'), p('total')) : 0;
  const prfPct = hasPrev ? _pct(p('reviewFail'), p('reviewOk') + p('reviewFail')) : 0;

  const rows = ''
    + row('Searches performed', agg.total, p('total'), _changeCell(agg.total - p('total'), null))
    + row('Failed on search page', agg.searchFail + ' (' + sfPct + '%)', p('searchFail') + ' (' + psfPct + '%)', _changeCell(agg.searchFail - p('searchFail'), true))
    + row('Failed on review page', agg.reviewFail + ' (' + rfPct + '%)', p('reviewFail') + ' (' + prfPct + '%)', _changeCell(agg.reviewFail - p('reviewFail'), true))
    + row('Reviews passed', agg.reviewOk, p('reviewOk'), _changeCell(agg.reviewOk - p('reviewOk'), false));

  const note = hasPrev ? ''
    : '<div style="font-size:12px;color:#9ca3af;margin-top:6px;">No data for the previous day to compare against.</div>';

  return '<table width="100%" cellspacing="0" cellpadding="0" style="border:1px solid #e5e7eb;border-radius:8px;border-collapse:separate;overflow:hidden;">'
    + '<tr style="background:#f3f4f6;">'
    + '<th style="text-align:left;padding:8px 12px;font-size:11px;color:#6b7280;text-transform:uppercase;">Metric</th>'
    + '<th style="text-align:right;padding:8px 12px;font-size:11px;color:#6b7280;text-transform:uppercase;">This day</th>'
    + '<th style="text-align:right;padding:8px 12px;font-size:11px;color:#6b7280;text-transform:uppercase;">Day before</th>'
    + '<th style="text-align:right;padding:8px 12px;font-size:11px;color:#6b7280;text-transform:uppercase;">Change</th></tr>'
    + rows + '</table>' + note;
}

// Airlines-that-failed table (same look as the 3-hourly report).
function _airlineTable(agg) {
  if (!agg.reviewFailAirlines.length) {
    return '<p style="font-size:13px;color:#6b7280;">No airlines failed on the review page this day.</p>';
  }
  let rows = '';
  agg.reviewFailAirlines.forEach(([air, count], i) => {
    const bg = i % 2 ? '#fafafa' : '#fff';
    rows += '<tr style="background:' + bg + ';"><td style="padding:9px 12px;font-size:13px;border-top:1px solid #eee;">' + _esc(air) + '</td>'
      + '<td style="padding:9px 12px;font-size:14px;font-weight:600;text-align:right;border-top:1px solid #eee;">' + count + '</td></tr>';
  });
  return '<table width="100%" cellspacing="0" cellpadding="0" style="border:1px solid #e5e7eb;border-radius:8px;border-collapse:separate;overflow:hidden;">'
    + '<tr style="background:#f3f4f6;"><th style="text-align:left;padding:8px 12px;font-size:11px;color:#6b7280;text-transform:uppercase;">Airline</th>'
    + '<th style="text-align:right;padding:8px 12px;font-size:11px;color:#6b7280;text-transform:uppercase;">Review failures</th></tr>'
    + rows + '</table>';
}

/**
 * Collect a full IST calendar day plus the day before it (for trend).
 * @param {Object} [opts]
 * @param {number} [opts.nowMs] override "now" (used by CLI / tests)
 */
function gatherDaily(opts) {
  const o = opts || {};
  const w = _prevDayWindow(o.nowMs);
  const cur = gather({ endMs: w.endMs, windowHours: 24 });
  const prev = gather({ endMs: w.startMs, windowHours: 24 });
  return {
    rows: cur.rows, startMs: w.startMs, endMs: w.endMs, dayIso: w.dayIso, windowHours: 24,
    prevRows: prev.rows, prevStartMs: prev.startMs, prevEndMs: prev.endMs,
  };
}

function renderDaily(meta) {
  const agg = aggregate(meta.rows);
  const prevAgg = aggregate(meta.prevRows);
  const blocks = timeline(meta.rows, meta.startMs);
  const dayLabel = _dayLabel(meta.dayIso);

  const subject = 'EQIS · Flight INTL Audit — DAILY ' + meta.dayIso + ' — '
    + agg.searchFail + ' search + ' + agg.reviewFail + ' review failures';

  const searchBars = _barImg('Search-page failures by reason', agg.topSearchReasons, searchLabel);
  const reviewBars = _barImg('Review-page failures by reason', agg.topReviewReasons, verdictLabel);
  const pieRow = '<h3 style="font-size:15px;color:#111827;margin:22px 0 10px;">Failure breakdown (full day)</h3>'
    + '<div style="margin-bottom:22px;">'
    +   '<h4 style="font-size:13px;color:#374151;margin:0 0 6px;font-weight:700;">🔍 Search-page failures (why a search did not work)</h4>'
    +   searchBars
    + '</div>'
    + '<div style="margin-bottom:6px;">'
    +   '<h4 style="font-size:13px;color:#374151;margin:0 0 6px;font-weight:700;">📋 Review-page failures (why the booking review did not work)</h4>'
    +   reviewBars
    + '</div>';

  const html = ''
    + '<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;background:#f3f4f6;padding:24px;">'
    + '<div style="max-width:960px;width:100%;margin:0 auto;background:#fff;border-radius:14px;overflow:hidden;border:1px solid #e5e7eb;">'
    // header
    + '<div style="background:#0f172a;padding:22px 24px;">'
    + '<div style="color:#fff;font-size:18px;font-weight:700;">Flight INTL Audit — Daily Summary</div>'
    + '<div style="color:#94a3b8;font-size:13px;margin-top:4px;">' + _esc(dayLabel) + ' · full day (00:00 → 24:00 IST)</div>'
    + '<div style="color:#64748b;font-size:12px;margin-top:2px;">Engine 9 · search → book → review</div>'
    + '</div>'
    + '<div style="padding:24px;">'
    // KPIs
    + '<table width="100%" cellspacing="8" cellpadding="0" style="border-collapse:separate;"><tr>'
    + _kpiCard('Searches performed', agg.total, null, '#111827')
    + _kpiCard('Failed on search page', agg.searchFail, _pct(agg.searchFail, agg.total) + '% of searches', agg.searchFail ? '#dc2626' : '#16a34a')
    + _kpiCard('Failed on review page', agg.reviewFail, _pct(agg.reviewFail, agg.reviewOk + agg.reviewFail) + '% of reviews', agg.reviewFail ? '#dc2626' : '#16a34a')
    + '</tr></table>'
    + '<div style="font-size:12px;color:#6b7280;margin-top:10px;">'
    + 'Reviews passed: <b style="color:#16a34a;">' + agg.reviewOk + '</b> · '
    + 'Reviews skipped (search failed first): <b>' + agg.reviewSkipped + '</b>'
    + '</div>'
    // day-over-day trend
    + '<h3 style="font-size:15px;color:#111827;margin:24px 0 8px;">Day-over-day trend</h3>'
    + _trendTable(agg, prevAgg)
    // 3-hour timeline
    + '<h3 style="font-size:15px;color:#111827;margin:24px 0 8px;">When failures happened (3-hour blocks)</h3>'
    + _timelineChartImg(blocks)
    + _timelineTable(blocks)
    // failure breakdown charts
    + pieRow
    // airlines + detail tables
    + '<h3 style="font-size:15px;color:#111827;margin:22px 0 8px;">Airlines that failed on review</h3>'
    + _airlineTable(agg)
    + _searchDetailTable(agg)
    + _reviewDetailTable(agg)
    + '<p style="font-size:11px;color:#9ca3af;margin-top:24px;border-top:1px solid #eee;padding-top:12px;">'
    + 'Generated by EQIS · ' + _esc(_istClock(meta.endMs)) + ' IST. Daily end-of-day summary for ' + _esc(meta.dayIso) + '. "Side" shows whether the failure is on the Etrav platform or EQIS automation.'
    + '</p>'
    + '</div></div></div>';

  const summaryLine = 'DAILY ' + meta.dayIso + ' · ' + agg.total + ' searches · '
    + agg.searchFail + ' search-fail · ' + agg.reviewFail + ' review-fail · ' + agg.reviewOk + ' review-ok';

  return { subject, html, summaryLine, recordCount: agg.total };
}

/* ─────────────────────────────── Run once ────────────────────────── */
let _running = false;
/**
 * Gather → aggregate → render → send → record. Always sends (no quality gate)
 * per the report owner's decision: a quiet window still mails "0 runs" so the
 * tech team knows the pipeline is alive.
 *
 * @param {Object} [opts]
 * @param {number} [opts.windowHours=3]
 * @param {string|string[]} [opts.to] override recipients (used for test sends)
 * @param {string} [opts.subjectPrefix] e.g. "[TEST] "
 */
async function runOnce(opts) {
  const o = opts || {};
  if (_running) { logger.info('[FIA-REPORT] already running — skipping overlap'); return null; }
  _running = true;
  try {
    const data = gather({ windowHours: o.windowHours });
    const agg = aggregate(data.rows);
    const rendered = render(agg, data);
    const to = o.to ? (Array.isArray(o.to) ? o.to : [o.to]) : recipients();
    const subject = (o.subjectPrefix || '') + rendered.subject;

    const sendRes = await mailer.send({ to, subject, html: rendered.html });
    const entry = emailHistory.append({
      teamId: 'flight_intl_audit',
      teamName: 'Flight INTL Audit (3-hourly)',
      reportType: REPORT_TYPE,
      status: sendRes.ok ? (sendRes.dryRun ? 'DRY_RUN' : 'OK') : 'FAILED',
      suppressionReason: null,
      recipients: sendRes.recipients,
      subject,
      summaryLine: rendered.summaryLine,
      recordCount: rendered.recordCount,
      messageId: sendRes.messageId,
      dryRun: !!sendRes.dryRun,
      error: sendRes.error,
    });
    logger.info('[FIA-REPORT] ' + entry.status + ' — ' + rendered.summaryLine
      + ' → ' + (sendRes.recipients || []).join(', '));
    return { sendRes, entry, agg };
  } catch (err) {
    logger.error('[FIA-REPORT] runOnce failed: ' + err.message);
    return null;
  } finally {
    _running = false;
  }
}

/**
 * Daily (24-hour) end-of-day summary: previous IST calendar day + day-over-day
 * trend + 3-hour timeline. Sent at 00:05 IST so it lands just after the final
 * 9pm–12am 3-hourly. Own running guard so it never collides with runOnce().
 *
 * @param {Object} [opts]
 * @param {number} [opts.nowMs] override "now" (CLI / tests)
 * @param {string|string[]} [opts.to] override recipients (test sends)
 * @param {string} [opts.subjectPrefix] e.g. "[TEST] "
 */
let _runningDaily = false;
async function runDailyOnce(opts) {
  const o = opts || {};
  if (_runningDaily) { logger.info('[FIA-REPORT] daily already running — skipping overlap'); return null; }
  _runningDaily = true;
  try {
    const data = gatherDaily({ nowMs: o.nowMs });
    const rendered = renderDaily(data);
    const to = o.to ? (Array.isArray(o.to) ? o.to : [o.to]) : recipients();
    const subject = (o.subjectPrefix || '') + rendered.subject;

    const sendRes = await mailer.send({ to, subject, html: rendered.html });
    const entry = emailHistory.append({
      teamId: 'flight_intl_audit_daily',
      teamName: 'Flight INTL Audit (daily 24h)',
      reportType: REPORT_TYPE_DAILY,
      status: sendRes.ok ? (sendRes.dryRun ? 'DRY_RUN' : 'OK') : 'FAILED',
      suppressionReason: null,
      recipients: sendRes.recipients,
      subject,
      summaryLine: rendered.summaryLine,
      recordCount: rendered.recordCount,
      messageId: sendRes.messageId,
      dryRun: !!sendRes.dryRun,
      error: sendRes.error,
    });
    logger.info('[FIA-REPORT] DAILY ' + entry.status + ' — ' + rendered.summaryLine
      + ' → ' + (sendRes.recipients || []).join(', '));
    return { sendRes, entry };
  } catch (err) {
    logger.error('[FIA-REPORT] runDailyOnce failed: ' + err.message);
    return null;
  } finally {
    _runningDaily = false;
  }
}

/* ───────────────────────────── Register cron ─────────────────────── */
let _registered = false;
function register() {
  if (_registered) return false;
  try {
    cron.schedule('0 */3 * * *', async () => {
      logger.info('[FIA-REPORT] 3-hourly trigger fired');
      try { await runOnce(); }
      catch (err) { logger.error('[FIA-REPORT] scheduled run failed: ' + err.message); }
    }, { timezone: TZ });
    // Daily 24-hour summary at 00:05 IST (just after the final 9pm–12am 3-hourly),
    // covering the full IST calendar day that just ended.
    cron.schedule('5 0 * * *', async () => {
      logger.info('[FIA-REPORT] daily 24h trigger fired');
      try { await runDailyOnce(); }
      catch (err) { logger.error('[FIA-REPORT] scheduled daily run failed: ' + err.message); }
    }, { timezone: TZ });
    _registered = true;
    logger.info('[FIA-REPORT] Registered: 0 */3 * * * + daily 5 0 * * * (' + TZ + ') · mailer '
      + (mailer.isEnabled() ? 'LIVE' : 'DRY-RUN — set GMAIL_OAUTH_* to enable sending'));
    return true;
  } catch (err) {
    logger.error('[FIA-REPORT] Failed to register cron: ' + err.message);
    return false;
  }
}

module.exports = {
  register,
  runOnce,
  runDailyOnce,
  gather,
  gatherDaily,
  aggregate,
  timeline,
  render,
  renderDaily,
  recipients,
  _internals: { SEARCH_STATUS_INFO, REVIEW_VERDICT_INFO },
};
