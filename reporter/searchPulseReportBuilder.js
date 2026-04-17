const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger');
const { CSS } = require('./shared/styles');
const { escapeHtml } = require('./shared/components');
const { TZ, getLocalDateString } = require('../utils/timezone');

// ── Rating logic (mirrors searchPulseEngine.computeSearchRating) ─────────
function computeRating(r) {
  const sec = r.loadTimeMs / 1000;
  const isSuccess = (r.resultCount || 0) > 0;
  const isFlight = !!r.sector;
  const isDom = r.scenarioType === 'domestic';
  const url = r.searchUrl || '';
  const formSubmitted = isFlight
    ? (url.includes('/flights/oneway') || url.includes('/flights/roundtrip'))
    : url.includes('/hotels/search-results');
  if (sec === 0 && r.searchStatus === 'FAILED' && !formSubmitted) return 'SPF';
  if (r.searchStatus === 'AUTOSUGGEST_DOWN') return 'FAILURE!!!';
  if (!isSuccess || sec === 0 || sec >= 100) return 'FAILURE!!!';
  if (isFlight) {
    if (isDom) { if (sec <= 10) return 'PERFECT'; if (sec <= 20) return 'MEDIAN'; if (sec <= 30) return 'DELAY'; return 'CRITICAL'; }
    else { if (sec <= 20) return 'PERFECT'; if (sec <= 30) return 'MEDIAN'; if (sec <= 40) return 'DELAY'; return 'CRITICAL'; }
  } else {
    if (sec <= 20) return 'PERFECT'; if (sec <= 45) return 'MEDIAN'; if (sec <= 50) return 'DELAY'; return 'CRITICAL';
  }
}

const RATING_COLORS = {
  'PERFECT': { text: '#34C759', bg: '#1B4D2E' },
  'MEDIAN': { text: '#FFCC00', bg: '#4D3A00' },
  'DELAY': { text: '#FF9500', bg: '#4D2800' },
  'CRITICAL': { text: '#FF3B30', bg: '#4D0A0A' },
  'FAILURE!!!': { text: '#FF3B30', bg: '#330000' },
  'SPF': { text: '#9ca3af', bg: '#222' },
};

function ratingBadge(rating) {
  const c = RATING_COLORS[rating] || RATING_COLORS['FAILURE!!!'];
  return `<span style="display:inline-block;background:${c.bg};color:${c.text};font-size:13px;font-weight:700;padding:4px 14px;border-radius:6px;border:1px solid ${c.text};">${escapeHtml(rating)}</span>`;
}

function statusBadge(status) {
  const color = status === 'SUCCESS' ? '#34C759' : status === 'ZERO_RESULTS' ? '#FF3B30' : status === 'FAILED' ? '#FF3B30' : '#FFCC00';
  const bg = status === 'SUCCESS' ? '#1B4D2E' : '#4D0A0A';
  return `<span style="display:inline-block;background:${bg};color:${color};font-size:12px;font-weight:600;padding:3px 10px;border-radius:4px;">${escapeHtml(status)}</span>`;
}

// ── Health badge ─────────────────────────────────────────────
function healthBadgeHtml(health) {
  const colors = {
    HEALTHY: { bg: '#1B4D2E', text: '#34C759', icon: '&#10003;' },
    WARN: { bg: '#4D3A00', text: '#FFCC00', icon: '&#9888;' },
    DEGRADED: { bg: '#7D3A00', text: '#FF9500', icon: '!' },
    CRITICAL: { bg: '#4D0A0A', text: '#FF3B30', icon: '&#10007;' },
  };
  const c = colors[health] || colors.WARN;
  return `<div style="text-align:center;margin:16px 0;">
    <div style="display:inline-block;background:${c.bg};color:${c.text};font-size:24px;font-weight:700;padding:12px 40px;border-radius:8px;border:2px solid ${c.text};">
      ${c.icon} ${health}
    </div>
  </div>`;
}

// ── API health signals ───────────────────────────────────────
function apiHealthSignals(signals) {
  if (!signals || signals.length === 0) return '';
  return `<div class="card"><h2 style="color:#FF9500;">API HEALTH SIGNALS</h2>
    ${signals.map(s => {
      const color = s.type === 'ZERO_RESULTS' ? '#FF3B30' : s.type === 'SLOW' ? '#FFCC00' : '#FF9500';
      return `<div style="background:${color}15;border:1px solid ${color};border-radius:6px;padding:10px;margin:6px 0;">
        <strong style="color:${color};">${s.type}</strong>: ${escapeHtml(s.route)}
        ${s.loadTimeMs ? ` &mdash; ${(s.loadTimeMs / 1000).toFixed(1)}s` : ''}
        ${s.detail ? ` &mdash; ${escapeHtml(s.detail)}` : ''}
      </div>`;
    }).join('')}
  </div>`;
}

// ── Mirror results ───────────────────────────────────────────
function mirrorResultsSection(pulseData) {
  const mirrorResults = [...pulseData.flightPulses, ...pulseData.hotelPulses]
    .filter(p => p.scenarioSource === 'session_mirror');
  if (mirrorResults.length === 0) return '';
  return `<div class="card" style="background:#1E3A5F15;border-color:#1E3A5F;">
    <h2>REAL AGENT REPLAY RESULTS</h2>
    ${mirrorResults.map(r => `
      <div style="margin:8px 0;padding:12px;background:#141414;border-radius:8px;">
        <strong>${escapeHtml(r.label)}</strong>
        <span class="badge ${r.searchStatus === 'SUCCESS' ? 'badge-pass' : 'badge-fail'}">${r.searchStatus}</span>
        <p style="color:#88bbdd;font-size:13px;margin-top:4px;">${escapeHtml(r.mirrorReason || '')}</p>
        <p style="color:#aaa;font-size:13px;">${r.resultCount} results | ${(r.loadTimeMs / 1000).toFixed(1)}s load time</p>
      </div>
    `).join('')}
  </div>`;
}

// ── Summary stats bar ────────────────────────────────────────
function summaryStatsBar(pulseData) {
  const all = [...pulseData.flightPulses, ...pulseData.hotelPulses];
  const total = all.length;
  const successes = all.filter(r => (r.resultCount || 0) > 0).length;
  const failures = total - successes;
  const avgLoad = total > 0 ? (all.reduce((s, r) => s + (r.loadTimeMs || 0), 0) / total / 1000).toFixed(1) : '0';
  const apiErrors = all.reduce((s, r) => s + (r.apiErrors || 0), 0);
  return `<div class="stats-bar">
    <div class="stat-item"><div class="value" style="color:#eee;">${total}</div><div class="label">Searches</div></div>
    <div class="stat-item"><div class="value" style="color:#34C759;">${successes}</div><div class="label">Success</div></div>
    <div class="stat-item"><div class="value" style="color:${failures > 0 ? '#FF3B30' : '#34C759'};">${failures}</div><div class="label">Failed</div></div>
    <div class="stat-item"><div class="value" style="color:#FFCC00;">${avgLoad}s</div><div class="label">Avg Load</div></div>
    <div class="stat-item"><div class="value" style="color:${apiErrors > 0 ? '#FF9500' : '#34C759'};">${apiErrors}</div><div class="label">API Errors</div></div>
  </div>`;
}

// ── Filters status ───────────────────────────────────────────
function filtersHtml(filtersWorking) {
  if (!filtersWorking || Object.keys(filtersWorking).length === 0) return '<span style="color:#666;">No filter data</span>';
  return Object.entries(filtersWorking).map(([name, ok]) => {
    const color = ok === true ? '#34C759' : ok === false ? '#FF3B30' : '#FFCC00';
    const icon = ok === true ? '&#10003;' : ok === false ? '&#10007;' : '?';
    return `<span style="display:inline-block;background:${ok === true ? '#1B4D2E' : ok === false ? '#4D0A0A' : '#333'};color:${color};font-size:11px;padding:2px 8px;border-radius:4px;margin:2px;">${icon} ${escapeHtml(name)}</span>`;
  }).join(' ');
}

// ── Video player ─────────────────────────────────────────────
function videoPlayerHtml(recordingPath) {
  if (!recordingPath) return '';
  const filename = path.basename(recordingPath);
  return `<div style="margin-top:16px;">
    <h3 style="color:#7c3aed;font-size:14px;margin-bottom:8px;">&#127909; Session Recording</h3>
    <p style="font-size:11px;color:#666;margin-bottom:8px;">Full search session: form filling, search submission, and results loading.</p>
    <div style="background:#000;border-radius:10px;padding:4px;">
      <video controls playsinline preload="metadata" style="width:100%;border-radius:8px;display:block;">
        <source src="/api/download/recordings/${escapeHtml(filename)}" type="video/mp4">
        Your browser does not support video playback.
      </video>
    </div>
  </div>`;
}

// ── Screenshot ───────────────────────────────────────────────
function screenshotHtml(pulse) {
  // Use base64 screenshot if available
  if (pulse.screenshot && pulse.screenshot.image) {
    return `<div style="margin-top:16px;">
      <h3 style="color:#ea580c;font-size:14px;margin-bottom:8px;">&#128247; Screenshot &mdash; Search Results Page</h3>
      <div style="background:#0a0a0a;border:1px solid #333;border-radius:10px;padding:6px;text-align:center;">
        <img src="data:image/png;base64,${pulse.screenshot.image}" alt="Search results" style="max-width:100%;border-radius:8px;" />
      </div>
    </div>`;
  }
  // Fallback: use screenshotPath if available
  if (pulse.screenshotPath) {
    const filename = path.basename(pulse.screenshotPath);
    return `<div style="margin-top:16px;">
      <h3 style="color:#ea580c;font-size:14px;margin-bottom:8px;">&#128247; Screenshot &mdash; Search Results Page</h3>
      <div style="background:#0a0a0a;border:1px solid #333;border-radius:10px;padding:6px;text-align:center;">
        <img src="/api/download/journey/${escapeHtml(filename)}" alt="Search results" style="max-width:100%;border-radius:8px;"
             onerror="this.style.display='none';this.parentElement.innerHTML='<div style=color:#666;padding:16px>Screenshot not available</div>'" />
      </div>
    </div>`;
  }
  return '';
}

// ── Evaluation section ───────────────────────────────────────
function evaluationHtml(evaluation) {
  if (!evaluation) return '';
  const findings = (evaluation.criticalFindingsForSearchTeam || []);
  const completeness = (evaluation.dataCompletenessIssues || []);
  const positives = (evaluation.positives || []);
  if (findings.length === 0 && completeness.length === 0 && positives.length === 0) return '';
  return `<div style="margin-top:16px;padding-top:16px;border-top:1px solid #222;">
    <h3 style="color:#34AADC;font-size:14px;margin-bottom:10px;">AI Evaluation</h3>
    ${findings.length > 0 ? `<div style="margin-bottom:8px;"><strong style="color:#FF9500;font-size:12px;">CRITICAL FINDINGS</strong><ul style="padding-left:18px;margin:4px 0;">${findings.map(f => `<li style="color:#FF9500;font-size:13px;">${escapeHtml(f)}</li>`).join('')}</ul></div>` : ''}
    ${completeness.length > 0 ? `<div style="margin-bottom:8px;"><strong style="color:#FFCC00;font-size:12px;">DATA COMPLETENESS</strong><ul style="padding-left:18px;margin:4px 0;">${completeness.map(i => `<li style="color:#ccc;font-size:13px;">${escapeHtml(i)}</li>`).join('')}</ul></div>` : ''}
    ${positives.length > 0 ? `<div><strong style="color:#34C759;font-size:12px;">POSITIVES</strong><ul style="padding-left:18px;margin:4px 0;">${positives.map(p => `<li style="color:#34C759;font-size:13px;">${escapeHtml(p)}</li>`).join('')}</ul></div>` : ''}
  </div>`;
}

// ── Individual search card ───────────────────────────────────
function searchCard(pulse, type) {
  const isFlight = type === 'flight';
  const rating = computeRating(pulse);
  const isSuccess = (pulse.resultCount || 0) > 0;
  const ltSec = (pulse.loadTimeMs / 1000).toFixed(1);
  const borderColor = isSuccess ? '#34C759' : '#FF3B30';
  const typeLabel = isFlight
    ? (pulse.scenarioType === 'domestic' ? 'FLIGHT DOMESTIC' : 'FLIGHT INTERNATIONAL')
    : (pulse.scenarioType === 'domestic' ? 'HOTEL DOMESTIC' : 'HOTEL INTERNATIONAL');

  // Parameters grid
  let paramsHtml = '';
  if (isFlight) {
    paramsHtml = `
      <div class="param-grid">
        <div class="param-item"><div class="param-label">Sector</div><div class="param-value">${escapeHtml(pulse.sector || pulse.label)}</div></div>
        <div class="param-item"><div class="param-label">Search Date</div><div class="param-value">${escapeHtml(pulse.searchDate || '—')}</div></div>
        <div class="param-item"><div class="param-label">Passengers</div><div class="param-value">${escapeHtml(pulse.paxCount || '—')}</div></div>
        <div class="param-item"><div class="param-label">Cabin Class</div><div class="param-value">${escapeHtml(pulse.cabinClass || '—')}</div></div>
        <div class="param-item"><div class="param-label">Trip Type</div><div class="param-value">${escapeHtml(pulse.searchType || '—')}</div></div>
        ${pulse.returnOffset ? `<div class="param-item"><div class="param-label">Return Offset</div><div class="param-value">${pulse.returnOffset} days</div></div>` : ''}
      </div>`;
  } else {
    paramsHtml = `
      <div class="param-grid">
        <div class="param-item"><div class="param-label">Destination</div><div class="param-value">${escapeHtml(pulse.destination || pulse.label)}</div></div>
        <div class="param-item"><div class="param-label">Check-in</div><div class="param-value">${escapeHtml(pulse.searchDate || '—')}</div></div>
        <div class="param-item"><div class="param-label">Nights</div><div class="param-value">${pulse.nights || '—'}</div></div>
        <div class="param-item"><div class="param-label">Rooms</div><div class="param-value">${pulse.rooms || '—'}</div></div>
        <div class="param-item"><div class="param-label">Passengers</div><div class="param-value">${escapeHtml(pulse.paxCount || '—')}</div></div>
        ${pulse.starFilter ? `<div class="param-item"><div class="param-label">Star Filter</div><div class="param-value">${escapeHtml(pulse.starFilter)}</div></div>` : ''}
      </div>`;
  }

  // Results metrics row
  const ratingC = RATING_COLORS[rating] || RATING_COLORS['FAILURE!!!'];
  const resultsHtml = `
    <div class="param-grid" style="background:#0d0d0d;">
      <div class="param-item"><div class="param-label">Load Time</div><div class="param-value" style="color:${ratingC.text};">${ltSec}s</div></div>
      <div class="param-item"><div class="param-label">${isFlight ? 'Flights Found' : 'Hotels Found'}</div><div class="param-value" style="color:${isSuccess ? '#34C759' : '#FF3B30'};">${pulse.resultCount || 0}</div></div>
      ${isFlight && pulse.airlineCount ? `<div class="param-item"><div class="param-label">Airlines</div><div class="param-value">${pulse.airlineCount}</div></div>` : ''}
      <div class="param-item"><div class="param-label">API Errors</div><div class="param-value" style="color:${(pulse.apiErrors || 0) > 0 ? '#FF9500' : '#34C759'};">${pulse.apiErrors || 0}</div></div>
    </div>`;

  // Failure reason
  const failureHtml = pulse.failureReason
    ? `<div style="background:#330000;border:1px solid #FF3B30;border-radius:6px;padding:10px;margin-top:12px;">
        <strong style="color:#FF3B30;font-size:12px;">FAILURE REASON</strong>
        <p style="color:#ff8888;font-size:13px;margin-top:4px;">${escapeHtml(pulse.failureReason)}</p>
      </div>`
    : '';

  // API error detail
  const apiDetailHtml = pulse.apiErrorDetail
    ? `<div style="background:#332200;border:1px solid #FF9500;border-radius:6px;padding:10px;margin-top:8px;">
        <strong style="color:#FF9500;font-size:12px;">API ERROR DETAIL</strong>
        <p style="color:#ffbb88;font-size:13px;margin-top:4px;">${escapeHtml(pulse.apiErrorDetail)}</p>
      </div>`
    : '';

  // URL section
  const urlHtml = pulse.searchUrl
    ? `<div style="margin-top:12px;padding:10px;background:#0d0d0d;border-radius:8px;">
        <div style="font-size:11px;color:#666;text-transform:uppercase;margin-bottom:4px;">Search URL</div>
        <a href="${escapeHtml(pulse.searchUrl)}" target="_blank" style="color:#34AADC;font-size:12px;word-break:break-all;">${escapeHtml(pulse.searchUrl)}</a>
      </div>`
    : '';

  // Actions log
  const actionsHtml = (pulse.actions && pulse.actions.length > 0)
    ? `<details style="margin-top:12px;">
        <summary style="font-size:13px;color:#aaa;">Automation Steps (${pulse.actions.length})</summary>
        <div class="detail-content">
          <ol class="actions-list">${pulse.actions.map(a => `<li>${escapeHtml(a)}</li>`).join('')}</ol>
        </div>
      </details>`
    : '';

  // Filters
  const filtersSection = `<div style="margin-top:12px;">
    <div style="font-size:11px;color:#666;text-transform:uppercase;margin-bottom:6px;">Filters</div>
    ${filtersHtml(pulse.filtersWorking)}
  </div>`;

  // Search ID
  const searchIdHtml = pulse.searchId
    ? `<span style="font-size:11px;color:#555;font-family:monospace;margin-left:12px;">ID: ${escapeHtml(pulse.searchId)}</span>`
    : '';

  // Only show screenshot for non-success searches
  const showScreenshot = !isSuccess || rating === 'CRITICAL' || rating === 'DELAY';

  return `<div class="search-card" style="border-left:4px solid ${borderColor};">
    <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px;margin-bottom:16px;">
      <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;">
        <span style="font-size:11px;font-weight:700;color:#888;text-transform:uppercase;letter-spacing:1px;">${typeLabel}</span>
        ${statusBadge(pulse.searchStatus)}
        <span style="font-size:18px;font-weight:700;color:#eee;">${escapeHtml(isFlight ? (pulse.sector || pulse.label) : (pulse.destination || pulse.label))}</span>
        ${searchIdHtml}
      </div>
      <div>${ratingBadge(rating)}</div>
    </div>
    ${paramsHtml}
    ${resultsHtml}
    ${failureHtml}
    ${apiDetailHtml}
    ${filtersSection}
    ${urlHtml}
    ${actionsHtml}
    ${videoPlayerHtml(pulse.recordingPath)}
    ${showScreenshot ? screenshotHtml(pulse) : ''}
    ${evaluationHtml(pulse.evaluation)}
  </div>`;
}

// ── Extra CSS for report ─────────────────────────────────────
const REPORT_CSS = `
  .search-card {
    background: #141414;
    border: 1px solid #222;
    border-radius: 10px;
    padding: 24px;
    margin-bottom: 20px;
  }
  .param-grid {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 10px;
    margin: 12px 0;
    padding: 14px;
    background: #0a0a0a;
    border-radius: 8px;
    border: 1px solid #1a1a1a;
  }
  .param-item .param-label {
    font-size: 10px;
    color: #666;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    margin-bottom: 2px;
  }
  .param-item .param-value {
    font-size: 15px;
    color: #eee;
    font-weight: 600;
  }
  .actions-list {
    list-style: decimal;
    padding-left: 20px;
    color: #888;
    font-size: 13px;
  }
  .actions-list li { margin: 3px 0; }
  video {
    max-width: 100%;
    border-radius: 8px;
    background: #000;
  }
  @media (max-width: 768px) {
    .param-grid { grid-template-columns: repeat(2, 1fr); }
  }
`;

// ── Build report ─────────────────────────────────────────────
async function build(pulseData, trendData) {
  const now = new Date();
  const istStr = now.toLocaleString('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
  const dateStr = istStr.slice(0, 10);
  const timeStr = istStr.slice(12, 20).replace(/:/g, '-'); // HH-MM-SS
  const filename = `search-pulse-${dateStr}_${timeStr}.html`;
  const reportDir = path.join(__dirname, '..', 'reports', 'searchpulse');
  if (!fs.existsSync(reportDir)) fs.mkdirSync(reportDir, { recursive: true });
  const reportPath = path.join(reportDir, filename);

  const durationSec = pulseData.durationMs ? Math.round(pulseData.durationMs / 1000) : 'N/A';

  // Trend context
  let trendContext = '';
  if (trendData && trendData.trends) {
    const topRoutes = (trendData.trends.flightTrends?.topRoutes || []).slice(0, 3).map(r => r.route).join(', ');
    const topHotels = (trendData.trends.hotelTrends?.topDestinations || []).slice(0, 2).map(d => d.destination).join(', ');
    trendContext = `<div class="card" style="padding:12px;">
      <p style="color:#888;font-size:13px;">Today's top searches: ${escapeHtml(topRoutes || 'N/A')} (flights), ${escapeHtml(topHotels || 'N/A')} (hotels)</p>
    </div>`;
  }

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>EQIS Search Pulse &mdash; ${escapeHtml(pulseData.pulseId)}</title>
  <style>${CSS}${REPORT_CSS}</style>
</head>
<body>
  <div class="container">

    <!-- Header + Health Badge -->
    <div class="header">
      <h1>SEARCH PULSE REPORT</h1>
      <div class="meta">${escapeHtml(pulseData.pulseId)} | ${now.toLocaleString('en-IN', { timeZone: TZ })} | ${durationSec}s</div>
    </div>
    ${healthBadgeHtml(pulseData.overallHealth)}

    <!-- Critical Alerts -->
    ${(pulseData.criticalAlerts && pulseData.criticalAlerts.length > 0) ? `
    <div class="card" style="border:2px solid #FF3B30;background:#1a0a0a;">
      <h2 style="color:#FF3B30;">&#x1F6A8; CRITICAL ALERTS &mdash; IMMEDIATE ACTION REQUIRED</h2>
      ${pulseData.criticalAlerts.map(a => `
        <div style="padding:12px;margin:8px 0;border-radius:8px;background:${a.severity === 'P0' ? '#330000' : '#332200'};border-left:4px solid ${a.severity === 'P0' ? '#FF3B30' : '#FF9500'};">
          <span style="color:${a.severity === 'P0' ? '#FF3B30' : '#FF9500'};font-weight:bold;">[${escapeHtml(a.severity)}] ${escapeHtml(a.type)}</span>
          <span style="color:#ccc;margin-left:8px;">${escapeHtml(a.route)}</span>
          <div style="color:#ff8888;margin-top:4px;font-size:13px;">${escapeHtml(a.message)}</div>
          ${a.loadTimeMs ? `<div style="color:#888;font-size:12px;margin-top:2px;">Load time: ${(a.loadTimeMs / 1000).toFixed(1)}s${a.resultCount !== undefined ? ' | Results: ' + a.resultCount : ''}</div>` : ''}
        </div>
      `).join('')}
    </div>
    ` : ''}

    <!-- Summary Stats -->
    ${summaryStatsBar(pulseData)}

    <!-- Flight Searches -->
    ${pulseData.flightPulses.length > 0 ? `
    <div class="card">
      <h2>&#9992;&#65039; FLIGHT SEARCHES (${pulseData.flightPulses.length})</h2>
      ${pulseData.flightPulses.map(p => searchCard(p, 'flight')).join('')}
    </div>
    ` : ''}

    <!-- Hotel Searches -->
    ${pulseData.hotelPulses.length > 0 ? `
    <div class="card">
      <h2>&#127976; HOTEL SEARCHES (${pulseData.hotelPulses.length})</h2>
      ${pulseData.hotelPulses.map(p => searchCard(p, 'hotel')).join('')}
    </div>
    ` : ''}

    <!-- API Health Signals -->
    ${apiHealthSignals(pulseData.apiHealthSignals)}

    <!-- Mirror Scenario Results -->
    ${mirrorResultsSection(pulseData)}

    <!-- Trend Context -->
    ${trendContext}

    <!-- Footer -->
    <div class="footer">
      ${escapeHtml(pulseData.pulseId)} | Generated by EQIS Search Pulse Engine<br>
      Next pulse: scheduled per configured interval
    </div>

  </div>
</body>
</html>`;

  fs.writeFileSync(reportPath, html);
  logger.info(`[REPORT] Search pulse report saved: ${reportPath}`);
  return reportPath;
}

module.exports = { build };
