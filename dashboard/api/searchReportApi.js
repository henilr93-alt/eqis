const fs = require('fs');
const path = require('path');

const METRICS_PATH = path.join(__dirname, '..', '..', 'state', 'metricsHistory.json');

function searchReportApi(req, res) {
  try {
    const { report, type, sector, destination } = req.query;
    const history = JSON.parse(fs.readFileSync(METRICS_PATH, 'utf-8'));

    // If searchId is provided, find the entry that ACTUALLY contains that searchId
    // (defensive against duplicate report filenames when 2 pulses run in same minute)
    let entry = null;
    if (req.query.searchId) {
      const sid = req.query.searchId;
      entry = history.find(e => {
        const all = [...(e.flightSearches || []), ...(e.hotelSearches || [])];
        return all.some(s => s.searchId === sid);
      });
    }
    // Fallback: match by report filename (legacy behavior for hotel/flight engines without searchId)
    if (!entry) entry = history.find(e => e.reportPath && path.basename(e.reportPath) === report);
    if (!entry) return res.status(404).send('<h2>Report not found</h2>');

    const allSearches = [...(entry.flightSearches || []), ...(entry.hotelSearches || [])];
    let search = null;
    // Match by searchId first (most precise)
    if (req.query.searchId) search = allSearches.find(s => s.searchId === req.query.searchId);
    // Match by destination for hotel searches (check BEFORE sector to avoid matching flight labels)
    if (!search && destination) search = allSearches.find(s => s.destination === destination);
    // Match by sector for flight searches (exact sector match only)
    if (!search && sector) search = allSearches.find(s => s.sector === sector);
    // Fallback: label match
    if (!search && (sector || destination)) search = allSearches.find(s => s.label && s.label.includes(sector || destination));
    if (!search && type) search = allSearches.find(s => s.type === type);
    if (!search) search = allSearches[0];
    if (!search) return res.status(404).send('<h2>Search not found in report</h2>');

    const isSuccess = search.results > 0;
    const ltSec = (search.loadTimeMs / 1000).toFixed(1);
    const isFlight = !!(search.sector);

    // Use stored rating from engine (authoritative) — fallback to computation if not stored
    let rating = search.rating || 'FAILURE!!!';
    let ratingColor = '#000000';
    const ratingColorMap = { 'PERFECT': '#16a34a', 'MEDIAN': '#ca8a04', 'DELAY': '#ea580c', 'CRITICAL': '#dc2626', 'FAILURE!!!': '#000000', 'SPF': '#9ca3af' };
    ratingColor = ratingColorMap[rating] || '#000000';
    if (!search.rating && isSuccess && search.loadTimeMs > 0) {
      const sec = search.loadTimeMs / 1000;
      const isDom = search.type === 'domestic';
      if (sec >= 100) { /* stays FAILURE!!! */ }
      else if (isFlight) {
        if (isDom) {
          if (sec <= 10) { rating = 'PERFECT'; ratingColor = '#16a34a'; }
          else if (sec <= 20) { rating = 'MEDIAN'; ratingColor = '#ca8a04'; }
          else if (sec <= 30) { rating = 'DELAY'; ratingColor = '#ea580c'; }
          else { rating = 'CRITICAL'; ratingColor = '#dc2626'; }
        } else {
          if (sec <= 20) { rating = 'PERFECT'; ratingColor = '#16a34a'; }
          else if (sec <= 30) { rating = 'MEDIAN'; ratingColor = '#ca8a04'; }
          else if (sec <= 40) { rating = 'DELAY'; ratingColor = '#ea580c'; }
          else { rating = 'CRITICAL'; ratingColor = '#dc2626'; }
        }
      } else {
        if (sec <= 20) { rating = 'PERFECT'; ratingColor = '#16a34a'; }
        else if (sec <= 45) { rating = 'MEDIAN'; ratingColor = '#ca8a04'; }
        else if (sec <= 50) { rating = 'DELAY'; ratingColor = '#ea580c'; }
        else { rating = 'CRITICAL'; ratingColor = '#dc2626'; }
      }
    }

    // Rating background for the badge
    const ratingBgMap = {
      'PERFECT': '#dcfce7', 'MEDIAN': '#fef9c3', 'DELAY': '#ffedd5',
      'CRITICAL': '#fee2e2', 'FAILURE!!!': '#f3f4f6', 'SPF': '#f3f4f6'
    };
    const ratingBg = ratingBgMap[rating] || '#f3f4f6';

    const escHtml = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    const ts = new Date(entry.timestamp).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });

    // Build parameter rows
    let paramRows = '';
    if (isFlight) {
      paramRows += '<tr><td>Sector</td><td class="val-bold">' + escHtml(search.sector) + '</td></tr>';
      paramRows += '<tr><td>Search Date</td><td>' + escHtml(search.searchDate) + '</td></tr>';
      paramRows += '<tr><td>Passengers</td><td>' + escHtml(search.paxCount) + '</td></tr>';
      paramRows += '<tr><td>Cabin Class</td><td>' + escHtml(search.cabinClass) + '</td></tr>';
      paramRows += '<tr><td>Trip Type</td><td>' + escHtml(search.searchType) + '</td></tr>';
    } else {
      paramRows += '<tr><td>Destination</td><td class="val-bold">' + escHtml(search.destination) + '</td></tr>';
      paramRows += '<tr><td>Check-in</td><td>' + escHtml(search.searchDate) + '</td></tr>';
      paramRows += '<tr><td>Nights</td><td>' + (search.nights || '-') + '</td></tr>';
      paramRows += '<tr><td>Rooms</td><td>' + (search.rooms || '-') + '</td></tr>';
    }
    paramRows += '<tr><td>Engine Type</td><td>' + escHtml((search.type || '').toUpperCase()) + '</td></tr>';
    paramRows += '<tr><td>Status</td><td style="color:' + (isSuccess ? '#16a34a' : '#dc2626') + ';font-weight:600;">' + escHtml(search.status) + '</td></tr>';
    if (search.searchId) {
      paramRows += '<tr><td>Search ID</td><td style="font-family:monospace;color:#6b7280;">' + escHtml(search.searchId) + '</td></tr>';
    }
    if (search.failureReason) {
      paramRows += '<tr><td style="color:#dc2626;font-weight:600;">Failure Reason</td><td style="color:#dc2626;background:#fee2e2;border-radius:6px;padding:10px 14px;font-size:12px;">' + escHtml(search.failureReason) + '</td></tr>';
    }

    // Stat cards
    const resultColor = isSuccess ? '#16a34a' : '#dc2626';
    const resultBg = isSuccess ? '#dcfce7' : '#fee2e2';
    const resultText = isSuccess ? 'SUCCESS' : 'FAILED';

    const airlineStat = search.airlineCount
      ? '<div class="stat-card"><div class="stat-num">' + search.airlineCount + '</div><div class="stat-lbl">Airlines</div></div>'
      : '';

    // Screenshot section
    let screenshotSection = '';
    if (search.screenshotPath && (rating === 'DELAY' || rating === 'CRITICAL' || rating === 'FAILURE!!!')) {
      let relPath = search.screenshotPath;
      if (relPath.includes('reports/journey/') || relPath.includes('reports\\journey\\')) {
        relPath = relPath.split(/reports[/\\]journey[/\\]/)[1] || relPath;
      }
      screenshotSection =
        '<div class="section">' +
        '<h3 class="section-title" style="color:#ea580c;">Screenshot — Search Results Page</h3>' +
        '<div style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:10px;padding:10px;text-align:center;">' +
        '<img src="/api/download/journey/' + relPath + '?token=' + (req.query.token || '') + '" ' +
        'style="max-width:100%;border-radius:8px;box-shadow:0 2px 8px rgba(0,0,0,0.08);" alt="Search results screenshot" ' +
        'onerror="this.style.display=\'none\';this.parentElement.innerHTML=\'<div style=color:#9ca3af;padding:20px>Screenshot not available</div>\'"/>' +
        '</div></div>';
    }

    // Session recording (MP4 video) section
    let recordingSection = '';
    if (search.recordingPath) {
      const videoFilename = require('path').basename(search.recordingPath);
      recordingSection =
        '<div class="section">' +
        '<h3 class="section-title" style="color:#7c3aed;">Session Recording</h3>' +
        '<p style="font-size:12px;color:#6b7280;margin-bottom:10px;">Full search session: form filling, search submission, and results loading.</p>' +
        '<div style="background:#000;border-radius:10px;padding:4px;text-align:center;">' +
        '<video controls playsinline style="max-width:100%;border-radius:8px;" preload="metadata">' +
        '<source src="/api/download/recordings/' + escHtml(videoFilename) + '?token=' + escHtml(req.query.token || '') + '" type="video/mp4">' +
        'Your browser does not support video playback.' +
        '</video>' +
        '</div></div>';
    }

    // URL section
    let urlSection = '';
    if (search.url) {
      urlSection =
        '<div class="section">' +
        '<h3 class="section-title" style="color:#2563eb;">Search URL</h3>' +
        '<a href="' + escHtml(search.url) + '" target="_blank" class="url-btn">Open Search on Etrav</a>' +
        '<div class="url-box"><a href="' + escHtml(search.url) + '" target="_blank">' + escHtml(search.url) + '</a></div>' +
        '</div>';
    }

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>EQIS Search Report — ${isFlight ? escHtml(search.sector) : escHtml(search.destination)}</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    background: #f3f4f6;
    color: #1f2937;
    padding: 24px;
    line-height: 1.5;
  }
  .container { max-width: 820px; margin: 0 auto; }

  /* Header */
  .header {
    background: linear-gradient(135deg, #1e3a5f 0%, #2563eb 100%);
    border-radius: 16px;
    padding: 28px 32px;
    margin-bottom: 24px;
    color: white;
    box-shadow: 0 4px 20px rgba(37,99,235,0.2);
  }
  .header h1 { font-size: 22px; font-weight: 700; margin-bottom: 6px; }
  .header .sub { font-size: 12px; color: rgba(255,255,255,0.7); }

  /* Stat cards row */
  .stats-row {
    display: flex;
    gap: 12px;
    margin-bottom: 24px;
    flex-wrap: wrap;
  }
  .stat-card {
    flex: 1;
    min-width: 110px;
    background: white;
    border: 1px solid #e5e7eb;
    border-radius: 12px;
    padding: 16px;
    text-align: center;
    box-shadow: 0 1px 3px rgba(0,0,0,0.04);
  }
  .stat-num { font-size: 24px; font-weight: 800; line-height: 1.2; }
  .stat-lbl { font-size: 10px; color: #6b7280; text-transform: uppercase; letter-spacing: 0.5px; margin-top: 4px; }

  /* Sections */
  .section {
    background: white;
    border: 1px solid #e5e7eb;
    border-radius: 12px;
    padding: 22px 24px;
    margin-bottom: 16px;
    box-shadow: 0 1px 3px rgba(0,0,0,0.04);
  }
  .section-title {
    font-size: 14px;
    font-weight: 700;
    color: #1e3a5f;
    margin-bottom: 14px;
    padding-bottom: 10px;
    border-bottom: 1px solid #f3f4f6;
  }

  /* Table */
  table { width: 100%; border-collapse: collapse; }
  td { padding: 10px 14px; border-bottom: 1px solid #f3f4f6; font-size: 13px; color: #374151; }
  td:first-child { color: #6b7280; font-size: 12px; font-weight: 500; width: 140px; }
  .val-bold { font-weight: 700; font-size: 16px; color: #111827; }

  /* URL */
  .url-btn {
    display: inline-block;
    background: #2563eb;
    color: white;
    padding: 10px 20px;
    border-radius: 8px;
    font-size: 13px;
    font-weight: 600;
    text-decoration: none;
    margin-bottom: 12px;
    transition: background 0.2s;
  }
  .url-btn:hover { background: #1d4ed8; }
  .url-box {
    background: #f9fafb;
    border: 1px solid #e5e7eb;
    border-radius: 8px;
    padding: 12px 14px;
  }
  .url-box a { color: #2563eb; font-size: 11px; word-break: break-all; text-decoration: none; }
  .url-box a:hover { text-decoration: underline; }

  /* Footer */
  .footer {
    text-align: center;
    margin-top: 28px;
    padding-top: 16px;
    border-top: 1px solid #e5e7eb;
    color: #9ca3af;
    font-size: 11px;
  }
</style>
</head>
<body>
<div class="container">

  <div class="header">
    <h1>${isFlight ? '&#x2708;&#xFE0F;' : '&#x1F3E8;'} Individual Search Report</h1>
    <div class="sub">Source: ${escHtml(report)} &nbsp;|&nbsp; ${ts}</div>
  </div>

  <div class="stats-row">
    <div class="stat-card">
      <div class="stat-num" style="color:${resultColor};background:${resultBg};display:inline-block;padding:4px 14px;border-radius:6px;font-size:16px;">${resultText}</div>
      <div class="stat-lbl">Result</div>
    </div>
    <div class="stat-card">
      <div class="stat-num" style="color:${ratingColor};background:${ratingBg};display:inline-block;padding:4px 14px;border-radius:6px;font-size:16px;">${rating}</div>
      <div class="stat-lbl">Rating</div>
    </div>
    <div class="stat-card">
      <div class="stat-num" style="color:#1f2937;">${ltSec}s</div>
      <div class="stat-lbl">Duration</div>
    </div>
    <div class="stat-card">
      <div class="stat-num" style="color:#1f2937;">${search.results || 0}</div>
      <div class="stat-lbl">${isFlight ? 'Flights' : 'Hotels'}</div>
    </div>
    ${airlineStat}
  </div>

  <div class="section">
    <h3 class="section-title">Search Parameters</h3>
    <table>${paramRows}</table>
  </div>

  <div class="section">
    <h3 class="section-title">Performance</h3>
    <table>
      <tr><td>Search Duration</td><td style="font-weight:700;color:${ratingColor};">${ltSec}s</td></tr>
      <tr><td>Rating</td><td style="font-weight:700;color:${ratingColor};">${rating}</td></tr>
      <tr><td>Results Found</td><td style="font-weight:600;">${search.results || 0}</td></tr>
      ${search.airlineCount ? '<tr><td>Airlines Shown</td><td>' + search.airlineCount + '</td></tr>' : ''}
    </table>
  </div>

  ${urlSection}
  ${screenshotSection}
  ${recordingSection}

  <div class="footer">EQIS SearchPulse Individual Report &nbsp;|&nbsp; Generated by FRAKA</div>
</div>
</body>
</html>`;

    res.setHeader('Content-Type', 'text/html');
    res.send(html);
  } catch (err) {
    const safeMsg = String(err.message || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    res.status(500).send('<h2>Error: ' + safeMsg + '</h2>');
  }
}

module.exports = { searchReportApi };
