const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger');
const { CSS } = require('./shared/styles');
const { bugCard, severityBadge, escapeHtml } = require('./shared/components');

function buildSystemicBugCards(bugs) {
  if (!bugs || bugs.length === 0) return '<p style="color:#34C759;">No systemic bugs detected today.</p>';
  return bugs.map(bug => {
    const sev = (bug.severity || 'P3').toLowerCase();
    return `
      <div class="bug-card ${sev}" style="border: 1px solid ${sev === 'p0' ? '#FF3B30' : sev === 'p1' ? '#FF9500' : sev === 'p2' ? '#FFCC00' : '#34AADC'};">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
          <span>${severityBadge(bug.severity)} <strong>${escapeHtml(bug.title)}</strong></span>
          <span class="badge badge-${sev}">${bug.sessionCount || bug.occurrences || 0} SESSIONS</span>
        </div>
        <div class="bug-detail"><strong>WHAT'S BROKEN:</strong> ${escapeHtml(bug.consolidatedDescription || '')}</div>
        <div class="bug-detail"><strong>WHERE:</strong> ${escapeHtml(bug.affectedPage || '')}</div>
        <div class="bug-detail"><strong>SEEN IN:</strong> ${(bug.exampleSessions || []).map(escapeHtml).join(', ')}</div>
        <div class="bug-detail"><strong>DEV FIX:</strong> ${escapeHtml(bug.devFixRequired || '')}</div>
        <div class="bug-detail"><strong>URGENCY SCORE:</strong> ${bug.urgencyScore || 0}</div>
      </div>
    `;
  }).join('');
}

function buildDiagnosticsSection(data) {
  const { loginStatus, harvesterDiagnostics, errors, lastKnownSessions } = data;
  
  // Login status display
  const loginStatusHtml = loginStatus ? `
    <div class="diagnostic-item" style="background:#141414;border:1px solid #222;border-radius:8px;padding:12px;margin:8px 0;">
      <h4 style="color:#34AADC;margin:0 0 8px 0;">Login Status</h4>
      <p style="color:${loginStatus.success ? '#34C759' : '#FF3B30'};margin:4px 0;">Status: ${loginStatus.success ? 'SUCCESS' : 'FAILED'}</p>
      <p style="color:#888;font-size:13px;margin:4px 0;">Timestamp: ${escapeHtml(loginStatus.timestamp || 'Unknown')}</p>
      ${loginStatus.url ? `<p style="color:#888;font-size:13px;margin:4px 0;">URL: ${escapeHtml(loginStatus.url)}</p>` : ''}
      ${loginStatus.error ? `<p style="color:#FF3B30;font-size:13px;margin:4px 0;">Error: ${escapeHtml(loginStatus.error)}</p>` : ''}
    </div>
  ` : '<p style="color:#888;">No login status available</p>';

  // Harvester diagnostics from engine output
  const harvesterHtml = harvesterDiagnostics ? `
    <div class="diagnostic-item" style="background:#141414;border:1px solid #222;border-radius:8px;padding:12px;margin:8px 0;">
      <h4 style="color:#34AADC;margin:0 0 8px 0;">DOM Structure Analysis</h4>
      <div class="grid-2" style="font-size:13px;">
        <div>
          <p style="margin:4px 0;">Tables found: <span style="color:#34C759;">${harvesterDiagnostics.tableCount || 0}</span></p>
          <p style="margin:4px 0;">Table rows: <span style="color:#34C759;">${harvesterDiagnostics.rowCount || 0}</span></p>
          <p style="margin:4px 0;">List items: <span style="color:#34C759;">${harvesterDiagnostics.listItemCount || 0}</span></p>
        </div>
        <div>
          <p style="margin:4px 0;">Clickable divs: <span style="color:#34C759;">${harvesterDiagnostics.clickableDivCount || 0}</span></p>
          <p style="margin:4px 0;">Session elements: <span style="color:#34C759;">${harvesterDiagnostics.sessionElementCount || 0}</span></p>
          <p style="margin:4px 0;">Page title: <span style="color:#888;">${escapeHtml(harvesterDiagnostics.title || 'Unknown')}</span></p>
        </div>
      </div>
      ${harvesterDiagnostics.bodyClassList ? `<p style="margin:8px 0 4px 0;color:#888;font-size:12px;">Body classes: [${harvesterDiagnostics.bodyClassList.join(', ')}]</p>` : ''}
      ${harvesterDiagnostics.extractionMethods ? `<p style="margin:8px 0 4px 0;color:#888;font-size:12px;">Extraction methods tried: ${harvesterDiagnostics.extractionMethods.join(', ')}</p>` : ''}
    </div>
  ` : '';

  // React state extraction results
  const reactStateHtml = harvesterDiagnostics?.reactStateExtraction ? `
    <div class="diagnostic-item" style="background:#141414;border:1px solid #222;border-radius:8px;padding:12px;margin:8px 0;">
      <h4 style="color:#34AADC;margin:0 0 8px 0;">React State Extraction</h4>
      <p style="color:${harvesterDiagnostics.reactStateExtraction.success ? '#34C759' : '#FF3B30'};margin:4px 0;">
        Status: ${harvesterDiagnostics.reactStateExtraction.success ? 'SUCCESS' : 'FAILED'}
      </p>
      ${harvesterDiagnostics.reactStateExtraction.storesFound ? `<p style="color:#888;font-size:13px;margin:4px 0;">Stores found: ${harvesterDiagnostics.reactStateExtraction.storesFound.join(', ')}</p>` : ''}
      ${harvesterDiagnostics.reactStateExtraction.sessionsFromState ? `<p style="color:#888;font-size:13px;margin:4px 0;">Sessions from state: ${harvesterDiagnostics.reactStateExtraction.sessionsFromState}</p>` : ''}
    </div>
  ` : '';

  // Errors and blockers
  const errorsHtml = errors && errors.length > 0 ? `
    <div class="diagnostic-item" style="background:#1a0f0f;border:1px solid #FF3B30;border-radius:8px;padding:12px;margin:8px 0;">
      <h4 style="color:#FF3B30;margin:0 0 8px 0;">Errors Preventing Session Extraction</h4>
      ${errors.map(error => `
        <div style="margin:6px 0;padding:8px;background:#0f0f0f;border-radius:4px;">
          <p style="color:#FF3B30;font-weight:bold;margin:0 0 4px 0;">${escapeHtml(error.type || 'Unknown Error')}</p>
          <p style="color:#888;font-size:13px;margin:0 0 4px 0;">${escapeHtml(error.message || '')}</p>
          ${error.timestamp ? `<p style="color:#666;font-size:11px;margin:0;">Time: ${escapeHtml(error.timestamp)}</p>` : ''}
        </div>
      `).join('')}
    </div>
  ` : '';

  // Last known session metadata cache
  const lastSessionsHtml = lastKnownSessions && lastKnownSessions.length > 0 ? `
    <div class="diagnostic-item" style="background:#141414;border:1px solid #FFCC00;border-radius:8px;padding:12px;margin:8px 0;">
      <h4 style="color:#FFCC00;margin:0 0 8px 0;">Last Known Session Metadata (Cached)</h4>
      <p style="color:#888;font-size:13px;margin:0 0 8px 0;">From previous successful harvest:</p>
      ${lastKnownSessions.slice(0, 3).map(session => `
        <div style="margin:6px 0;padding:8px;background:#0f0f0f;border-radius:4px;font-size:12px;">
          <p style="color:#34C759;margin:0 0 4px 0;">ID: ${escapeHtml(session.sessionId || 'Unknown')}</p>
          <p style="color:#888;margin:0 0 2px 0;">Duration: ${session.duration || 0}s | Pages: ${session.pageCount || 0} | Device: ${escapeHtml(session.deviceType || 'unknown')}</p>
          <p style="color:#888;margin:0;font-size:11px;">Last seen: ${escapeHtml(session.lastSeen || 'Unknown')}</p>
        </div>
      `).join('')}
      ${lastKnownSessions.length > 3 ? `<p style="color:#666;font-size:11px;margin:8px 0 0 0;">... and ${lastKnownSessions.length - 3} more</p>` : ''}
    </div>
  ` : '<p style="color:#888;">No cached session metadata available</p>';

  return `
    <div class="card" style="background:linear-gradient(135deg, #3A1E1E20, #14141480);">
      <h2 style="color:#FF9500;">DIAGNOSTIC REPORT — Zero Sessions Harvested</h2>
      <p style="color:#888;margin-bottom:16px;">Detailed analysis of what prevented session extraction:</p>
      
      ${loginStatusHtml}
      ${harvesterHtml}
      ${reactStateHtml}
      ${errorsHtml}
      
      <h3 style="color:#FFCC00;margin:16px 0 8px 0;">Last Known Session Cache</h3>
      ${lastSessionsHtml}
    </div>
  `;
}

function buildTrendsDashboard(trends) {
  if (!trends) return '<p style="color:#888;">No trend data available.</p>';

  const ft = trends.flightTrends || {};
  const ht = trends.hotelTrends || {};
  const bp = trends.behavioralPatterns || {};

  const topRoutes = (ft.topRoutes || []).map(r =>
    `<li>${escapeHtml(r.route)} — ${r.count} searches (${escapeHtml(r.pct || '')})</li>`
  ).join('') || '<li>No data</li>';

  const topHotels = (ht.topDestinations || []).map(d =>
    `<li>${escapeHtml(d.destination)} — ${d.count} searches</li>`
  ).join('') || '<li>No data</li>';

  const dropOff = (bp.topDropOffPages || []).map(p =>
    `<li>${escapeHtml(p.page)} — ${escapeHtml(p.pct || '')}</li>`
  ).join('') || '<li>No data</li>';

  const anomalies = (trends.anomalies || []).map(a => {
    const color = a.severity === 'HIGH' ? '#FF3B30' : a.severity === 'MEDIUM' ? '#FFCC00' : '#34AADC';
    return `<div style="background:${color}15;border:1px solid ${color};border-radius:6px;padding:10px;margin:6px 0;">
      <strong style="color:${color};">${escapeHtml(a.flag)}</strong>
      <p style="font-size:13px;margin-top:4px;">${escapeHtml(a.detail)}</p>
    </div>`;
  }).join('') || '<p style="color:#888;">No anomalies detected.</p>';

  return `
    <div class="grid-2">
      <div>
        <h3>TOP FLIGHT ROUTES TODAY</h3>
        <ol>${topRoutes}</ol>

        <h3 style="margin-top:16px;">TOP HOTEL DESTINATIONS</h3>
        <ol>${topHotels}</ol>

        <h3 style="margin-top:16px;">DOMESTIC vs INTERNATIONAL</h3>
        <p>Flights: ${ft.domesticVsInternational?.domestic || 0} domestic / ${ft.domesticVsInternational?.international || 0} international</p>
        <p>Hotels: ${ht.domesticVsInternational?.domestic || 0} domestic / ${ht.domesticVsInternational?.international || 0} international</p>
      </div>
      <div>
        <h3>BEHAVIORAL METRICS</h3>
        <ul>
          <li>Avg session duration: ${bp.avgSessionDuration || 0}s</li>
          <li>Completion rate: ${escapeHtml(bp.completionRate || 'N/A')}</li>
          <li>Error rate: ${escapeHtml(bp.errorRate || 'N/A')}</li>
          <li>Mobile vs Desktop: ${bp.mobileVsDesktop?.mobile || 0} / ${bp.mobileVsDesktop?.desktop || 0}</li>
          <li>Avg pages/session: ${bp.avgPagesPerSession || 0}</li>
        </ul>

        <h3 style="margin-top:16px;">DROP-OFF PAGES</h3>
        <ol>${dropOff}</ol>

        <h3 style="margin-top:16px;">ANOMALY FLAGS</h3>
        ${anomalies}
      </div>
    </div>
  `;
}

function buildSessionDives(selectedSessions, sessionAnalyses) {
  if (!sessionAnalyses || sessionAnalyses.length === 0) return '<p style="color:#888;">No sessions analyzed.</p>';

  return sessionAnalyses.map(analysis => {
    const bugCount = (analysis.bugsObserved || []).length;
    const frictionCount = (analysis.frictionPoints || []).length;

    const bugsHtml = (analysis.bugsObserved || []).map(bugCard).join('');
    const frictionHtml = (analysis.frictionPoints || []).map(f => `
      <div style="margin:6px 0;padding:8px;background:#1a1a1a;border-radius:6px;">
        <strong>${escapeHtml(f.type)}</strong> at ${escapeHtml(f.location || '')}<br>
        <span style="color:#aaa;">${escapeHtml(f.description || '')}</span><br>
        <span style="color:#FFCC00;">Impact: ${escapeHtml(f.agentImpact || '')}</span>
      </div>
    `).join('');

    const uxHtml = (analysis.uxProblems || []).map(u => `
      <div style="margin:6px 0;padding:8px;background:#1a1a1a;border-radius:6px;">
        <strong>${escapeHtml(u.element)}</strong> — ${escapeHtml(u.problem)}<br>
        <span style="color:#34AADC;">Recommendation: ${escapeHtml(u.recommendation || '')}</span>
      </div>
    `).join('');

    return `
      <details>
        <summary>
          ${escapeHtml(analysis.sessionId)} | ${escapeHtml(analysis.productUsed || '')} | Stage: ${escapeHtml(analysis.journeyStage || '')} | ${bugCount} bugs | ${frictionCount} friction
        </summary>
        <div class="detail-content">
          ${bugsHtml}
          ${frictionHtml}
          ${uxHtml}
          ${(analysis.positives || []).length > 0 ? `<p style="color:#34C759;margin-top:8px;">Positives: ${analysis.positives.map(escapeHtml).join(', ')}</p>` : ''}
        </div>
      </details>
    `;
  }).join('');
}

// Helper function to extract diagnostics from zipyEngine output structure
function extractDiagnostics(engineOutput) {
  if (!engineOutput) return null;
  
  return {
    loginStatus: engineOutput.loginStatus || null,
    harvesterDiagnostics: engineOutput.harvesterDiagnostics || null,
    errors: engineOutput.errors || [],
    lastKnownSessions: engineOutput.lastKnownSessions || []
  };
}

async function build(data) {
  const { runId, allSessions, selectedSessions, sessionAnalyses, bugReport, trends, engineOutput } = data;

  const now = new Date();
  const istStr = now.toLocaleString('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
  const dateStr = istStr.slice(0, 10);
  const filename = `zipy-report-${dateStr}.html`;
  const reportDir = path.join(__dirname, '..', 'reports', 'zipy');
  if (!fs.existsSync(reportDir)) fs.mkdirSync(reportDir, { recursive: true });
  const reportPath = path.join(reportDir, filename);

  const sessionsAnalyzed = sessionAnalyses?.length || 0;
  const uniqueBugs = bugReport?.uniqueBugsFound || 0;
  const systemicCount = bugReport?.systemicBugs?.length || 0;
  const criticalSummary = bugReport?.criticalSummary || '';
  const totalSessions = allSessions?.length || 0;

  // Check if we have zero sessions harvested
  const hasZeroSessions = totalSessions === 0;

  // Extract diagnostics from engine output
  const diagnosticsData = extractDiagnostics(engineOutput);

  // Completion rate
  const completed = (sessionAnalyses || []).filter(a => a.completedToPayment).length;
  const completionRate = sessionsAnalyzed > 0 ? `${Math.round((completed / sessionsAnalyzed) * 100)}%` : 'N/A';
  const errorRate = trends?.behavioralPatterns?.errorRate || 'N/A';

  // Health status for dashboard
  const healthStatus = {
    status: hasZeroSessions ? 'DEGRADED' : (systemicCount > 0 ? 'ISSUES' : 'HEALTHY'),
    sessionsHarvested: totalSessions,
    sessionsAnalyzed: sessionsAnalyzed,
    criticalBugs: systemicCount,
    lastRunTime: now.toISOString(),
    diagnostics: hasZeroSessions ? diagnosticsData : null
  };

  // Write health status to a JSON file for the dashboard to consume
  const healthStatusPath = path.join(reportDir, 'health-status.json');
  fs.writeFileSync(healthStatusPath, JSON.stringify(healthStatus, null, 2));
  logger.info(`[REPORT] Zipy health status saved: ${healthStatusPath}`);

  // Recommended test scenarios for tomorrow
  const recommendedScenarios = (trends?.recommendedTestScenarios || []).map(s => {
    const urgencyColor = s.urgency === 'URGENT' ? '#FF3B30' : s.urgency === 'HIGH' ? '#FF9500' : '#FFCC00';
    return `
      <div style="background:#141414;border:1px solid #222;border-radius:8px;padding:12px;margin:8px 0;">
        <span style="background:${urgencyColor}20;color:${urgencyColor};padding:2px 8px;border-radius:4px;font-size:12px;">${escapeHtml(s.urgency)}</span>
        <strong style="margin-left:8px;">${escapeHtml(s.scenarioDescription)}</strong>
        <p style="color:#888;font-size:13px;margin-top:4px;">${escapeHtml(s.reason)}</p>
      </div>
    `;
  }).join('') || '<p style="color:#888;">No specific recommendations.</p>';

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>EQIS Zipy Report — ${dateStr}</title>
  <style>${CSS}</style>
</head>
<body>
  <div class="container">

    <!-- SECTION 1: Header -->
    <div class="header">
      <h1>ZIPY INTELLIGENCE REPORT</h1>
      <div class="meta">${now.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })} | ${totalSessions} sessions analyzed</div>
      <div class="tagline">Real agent behavior from the last 24 hours</div>
    </div>

    <!-- SECTION 2: Executive Summary -->
    <div class="card" style="background:linear-gradient(135deg, #1E3A5F20, #14141480);">
      <h2>EXECUTIVE SUMMARY</h2>
      <div class="stats-bar">
        <div class="stat-item"><div class="value">${totalSessions}</div><div class="label">Sessions Harvested</div></div>
        <div class="stat-item"><div class="value">${sessionsAnalyzed}</div><div class="label">Deep Analyzed</div></div>
        <div class="stat-item"><div class="value">${uniqueBugs}</div><div class="label">Unique Bugs</div></div>
        <div class="stat-item"><div class="value" style="color:#FF3B30;">${systemicCount}</div><div class="label">Systemic Bugs</div></div>
        <div class="stat-item"><div class="value">${completionRate}</div><div class="label">Completion Rate</div></div>
        <div class="stat-item"><div class="value">${escapeHtml(String(errorRate))}</div><div class="label">Error Rate</div></div>
      </div>
      <p style="color:#aaa;font-size:14px;">${escapeHtml(criticalSummary)}</p>
    </div>

    ${hasZeroSessions ? buildDiagnosticsSection(diagnosticsData) : ''}

    ${!hasZeroSessions ? `
    <!-- SECTION 3: Critical Bug Board -->
    <div class="card">
      <h2 style="color:#FF3B30;">BUGS REQUIRING IMMEDIATE ATTENTION</h2>
      <p style="color:#888;margin-bottom:12px;">These bugs appeared in multiple real agent sessions today</p>
      ${buildSystemicBugCards(bugReport?.systemicBugs)}
      ${(bugReport?.otherBugs || []).length > 0 ? `
        <h3 style="margin-top:20px;">Other Bugs</h3>
        ${buildSystemicBugCards(bugReport.otherBugs)}
      ` : ''}
    </div>

    <!-- SECTION 4: Search Trends Dashboard -->
    <div class="card">
      <h2>SEARCH TRENDS DASHBOARD</h2>
      ${buildTrendsDashboard(trends)}
    </div>

    <!-- SECTION 5: Session Deep Dives -->
    <div class="card">
      <h2>SESSION DEEP DIVES</h2>
      ${buildSessionDives(selectedSessions, sessionAnalyses)}
    </div>

    <!-- SECTION 6: Tomorrow's QA Priorities -->
    <div class="card">
      <h2>TOMORROW'S QA PRIORITIES</h2>
      <p style="color:#888;margin-bottom:12px;">Based on today's real agent data, test these scenarios tomorrow:</p>
      ${recommendedScenarios}
      <p style="color:#88bbdd;font-size:13px;margin-top:12px;">These have been automatically queued into tonight's journey tests.</p>
    </div>
    ` : `
    <!-- SECTION 3: Recovery Actions -->
    <div class="card">
      <h2 style="color:#FFCC00;">RECOVERY ACTIONS</h2>
      <p style="color:#888;margin-bottom:12px;">Since no sessions were harvested, consider these actions:</p>
      <ul style="color:#aaa;">
        <li>Check if Zipy dashboard has new sessions available</li>
        <li>Verify login credentials are valid</li>
        <li>Review DOM selectors in sessionHarvester.js</li>
        <li>Check network connectivity to Zipy service</li>
        <li>Monitor next harvest cycle in 10 minutes</li>
      </ul>
    </div>
    `}

    <!-- SECTION 7: Footer -->
    <div class="footer">
      Generated by ETRAV QA INTELLIGENCE SYSTEM<br>
      Zipy Engine v1.0 | Next run: ${hasZeroSessions ? 'retrying in 10 minutes' : 'tomorrow 06:00 IST'}
    </div>

  </div>
</body>
</html>`;

  fs.writeFileSync(reportPath, html);
  logger.info(`[REPORT] Zipy report saved: ${reportPath}`);
  return reportPath;
}

module.exports = { build };