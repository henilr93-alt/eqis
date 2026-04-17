const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger');
const { CSS } = require('./shared/styles');
const { bugCard, uxCard, stepSection, statsBar, severityBadge, statusBadge, escapeHtml } = require('./shared/components');

function collectAllBugs(steps) {
  const bugs = [];
  for (const step of steps) {
    const eval_ = step.evaluation || {};
    for (const bug of eval_.bugs || []) {
      bugs.push({ ...bug, step: step.stepName });
    }
  }
  return bugs.sort((a, b) => {
    const order = { P0: 0, P1: 1, P2: 2, P3: 3 };
    return (order[a.severity] || 3) - (order[b.severity] || 3);
  });
}

function collectAllUxIssues(steps) {
  const issues = [];
  for (const step of steps) {
    const eval_ = step.evaluation || {};
    for (const issue of eval_.uxFriction || []) {
      issues.push({ ...issue, step: step.stepName });
    }
  }
  return issues;
}

function collectAllUiAmendments(steps) {
  const amendments = [];
  for (const step of steps) {
    const eval_ = step.evaluation || {};
    for (const item of eval_.uiAmendments || []) {
      amendments.push({ ...item, step: step.stepName });
    }
  }
  return amendments;
}

function countStats(allSteps) {
  let passed = 0, warned = 0, failed = 0, bugs = 0, uxIssues = 0, uiChanges = 0;
  for (const step of allSteps) {
    const eval_ = step.evaluation || {};
    const status = (eval_.overallStatus || step.status || '').toUpperCase();
    if (status === 'PASS' || status === 'COMPLETED') passed++;
    else if (status === 'WARN') warned++;
    else if (status === 'FAIL' || status === 'FAILED') failed++;
    bugs += (eval_.bugs || []).length;
    uxIssues += (eval_.uxFriction || []).length;
    uiChanges += (eval_.uiAmendments || []).length;
  }
  return { totalSteps: allSteps.length, passed, warned, failed, bugs, uxIssues, uiChanges };
}

function buildBugTable(bugs) {
  if (bugs.length === 0) return '<p style="color:#888;">No bugs found in this run.</p>';
  const rows = bugs.map(bug => `
    <tr>
      <td>${escapeHtml(bug.id || '')}</td>
      <td>${severityBadge(bug.severity)}</td>
      <td>${escapeHtml(bug.step || '')}</td>
      <td>${escapeHtml(bug.title || '')}</td>
      <td>${escapeHtml(bug.devFixRequired || '')}</td>
      <td>${escapeHtml(bug.estimatedEffort || '')}</td>
    </tr>
  `).join('');

  return `
    <table>
      <thead><tr><th>Bug ID</th><th>Severity</th><th>Step</th><th>Title</th><th>Dev Fix</th><th>Est. Effort</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

function buildUiAmendmentTable(amendments) {
  if (amendments.length === 0) return '<p style="color:#888;">No UI amendments needed.</p>';
  const rows = amendments.map(a => `
    <tr>
      <td><span class="badge badge-${(a.priority || 'low').toLowerCase() === 'high' ? 'p0' : (a.priority || 'low').toLowerCase() === 'medium' ? 'p2' : 'p3'}">${escapeHtml(a.priority || 'LOW')}</span></td>
      <td>${escapeHtml(a.element || '')}</td>
      <td>${escapeHtml(a.currentState || '')}</td>
      <td>${escapeHtml(a.recommendedChange || '')}</td>
    </tr>
  `).join('');

  return `
    <table>
      <thead><tr><th>Priority</th><th>Element</th><th>Current State</th><th>Recommended Change</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

async function build(runData, trendData) {
  const allSteps = [...(runData.flightSteps || []), ...(runData.hotelSteps || [])];
  const allBugs = collectAllBugs(allSteps);
  const allUxIssues = collectAllUxIssues(allSteps);
  const allUiAmendments = collectAllUiAmendments(allSteps);
  const stats = countStats(allSteps);

  const now = new Date();
  const istStr = now.toLocaleString('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
  const dateStr = istStr.slice(0, 10);
  const timeStr = istStr.slice(12, 17).replace(':', '-');
  const filename = `journey-report-${dateStr}_${timeStr}.html`;
  const reportDir = path.join(__dirname, '..', 'reports', 'journey');
  if (!fs.existsSync(reportDir)) fs.mkdirSync(reportDir, { recursive: true });
  const reportPath = path.join(reportDir, filename);

  const flightLabel = runData.flightScenario?.label || 'Unknown';
  const hotelLabel = runData.hotelScenario?.label || 'Unknown';
  const flightSource = runData.flightScenario?.source === 'zipy_trend' ? 'TREND-DRIVEN' : 'PRE-BUILT';
  const hotelSource = runData.hotelScenario?.source === 'zipy_trend' ? 'TREND-DRIVEN' : 'PRE-BUILT';
  const durationSec = runData.durationMs ? Math.round(runData.durationMs / 1000) : 'N/A';

  // Section 3: Zipy context panel
  let zipyContextHtml = '';
  if (trendData && trendData.trends) {
    zipyContextHtml = `
      <div class="context-panel">
        <div class="label">ZIPY INTELLIGENCE CONTEXT</div>
        <p>This run incorporates insights from today's Zipy analysis (${trendData.forDate}).</p>
        <p>Trend data was used to influence scenario selection.</p>
      </div>
    `;
  }

  // Section 8: Search Engine Intelligence
  let searchIntelHtml = `
    <div class="card">
      <h2>SEARCH & RESULTS ENGINE — QUALITY SIGNALS</h2>
      <div class="grid-2">
        <div>
          <h3>A) Search Form UX</h3>
          <ul>
            ${allSteps.filter(s => s.stepName === 'flightSearch' || s.stepName === 'hotelSearch').map(s => {
              const eval_ = s.evaluation || {};
              const friction = (eval_.uxFriction || []).map(f => `<li>${escapeHtml(f.observation)}</li>`).join('');
              return friction || '<li style="color:#34C759;">No friction points detected</li>';
            }).join('')}
          </ul>

          <h3>B) Results Page Performance</h3>
          <ul>
            ${allSteps.filter(s => s.stepName === 'flightResults' || s.stepName === 'hotelResults').map(s => {
              const eval_ = s.evaluation || {};
              return `<li>Load time: ${eval_.loadTimeAssessment || 'UNKNOWN'}</li>`;
            }).join('')}
          </ul>
        </div>
        <div>
          <h3>C) Zero Results / Errors</h3>
          <ul>
            ${allSteps.filter(s => s.status === 'failed').map(s =>
              `<li style="color:#FF3B30;">Failed: ${escapeHtml(s.stepName)} — ${escapeHtml(s.error || 'Unknown error')}</li>`
            ).join('') || '<li style="color:#34C759;">No failures detected</li>'}
          </ul>

          ${trendData ? `
          <h3>D) Cross-Engine Intelligence</h3>
          <p style="color:#88bbdd;">Zipy trend data from ${trendData.forDate} was available for correlation.</p>
          ` : ''}
        </div>
      </div>
    </div>
  `;

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>EQIS Journey Report — ${runData.runId}</title>
  <style>${CSS}</style>
</head>
<body>
  <div class="container">

    <!-- SECTION 1: Header -->
    <div class="header">
      <h1>JOURNEY TEST REPORT</h1>
      <div class="meta">Run ID: ${escapeHtml(runData.runId)} | ${now.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })} | Duration: ${durationSec}s</div>
      <div class="tagline">Flight: ${escapeHtml(flightLabel)} <span class="badge ${flightSource === 'TREND-DRIVEN' ? 'badge-warn' : 'badge-pass'}">${flightSource}</span></div>
      <div class="tagline">Hotel: ${escapeHtml(hotelLabel)} <span class="badge ${hotelSource === 'TREND-DRIVEN' ? 'badge-warn' : 'badge-pass'}">${hotelSource}</span></div>
    </div>

    <!-- SECTION 2: Quick Stats -->
    ${statsBar(stats)}

    <!-- SECTION 3: Zipy Context -->
    ${zipyContextHtml}

    <!-- SECTION 4: Bug Log Table -->
    <div class="card">
      <h2>BUG LOG</h2>
      ${buildBugTable(allBugs)}
    </div>

    <!-- SECTION 5: UX Friction Log -->
    <div class="card">
      <h2>UX FRICTION LOG</h2>
      ${allUxIssues.length > 0
        ? allUxIssues.map(issue => uxCard(issue)).join('')
        : '<p style="color:#888;">No UX friction points detected.</p>'
      }
    </div>

    <!-- SECTION 6: UI Amendment Checklist -->
    <div class="card">
      <h2>UI AMENDMENT CHECKLIST</h2>
      ${buildUiAmendmentTable(allUiAmendments)}
    </div>

    <!-- SECTION 7: Step-by-Step Walkthrough -->
    <div class="card">
      <h2>FLIGHT JOURNEY WALKTHROUGH</h2>
      ${(runData.flightSteps || []).map(step => stepSection(step)).join('')}
    </div>

    <div class="card">
      <h2>HOTEL JOURNEY WALKTHROUGH</h2>
      ${(runData.hotelSteps || []).map(step => stepSection(step)).join('')}
    </div>

    <!-- SECTION 8: Search Engine Intelligence -->
    ${searchIntelHtml}

    <!-- SECTION 9: Footer -->
    <div class="footer">
      Generated by ETRAV QA INTELLIGENCE SYSTEM<br>
      Journey Engine v1.0 | Next run: ${new Date(now.getTime() + 30 * 60000).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata' })}<br>
      Scenarios tested: ${escapeHtml(runData.flightScenario?.id || '')} + ${escapeHtml(runData.hotelScenario?.id || '')}
    </div>

  </div>
</body>
</html>`;

  fs.writeFileSync(reportPath, html);
  logger.info(`[REPORT] Journey report saved: ${reportPath}`);
  return reportPath;
}

module.exports = { build };
