const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger');
const { CSS } = require('./shared/styles');
const { escapeHtml, severityBadge } = require('./shared/components');

function validationChecklist(validationResults, type) {
  if (!validationResults || Object.keys(validationResults).length === 0) {
    return '<p style="color:#888;">No validation results.</p>';
  }

  const rows = Object.entries(validationResults).map(([id, check]) => {
    const icon = check.passed === true ? '<span style="color:#34C759;">&#10003;</span>'
      : check.passed === false ? '<span style="color:#FF3B30;">&#10007;</span>'
      : '<span style="color:#FFCC00;">?</span>';
    return `<tr>
      <td>${icon}</td>
      <td>${escapeHtml(check.label)}</td>
      <td>${severityBadge(check.severity)}</td>
    </tr>`;
  }).join('');

  return `<table><thead><tr><th></th><th>Check</th><th>Severity</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function pnrAuditTable(runData) {
  const rows = [];
  if (runData.flightBooking) {
    rows.push(`<tr>
      <td>${escapeHtml(runData.flightBooking.pnr || 'N/A')}</td>
      <td>Flight</td>
      <td>${escapeHtml(runData.startTime)}</td>
      <td>${escapeHtml(runData.endTime || 'N/A')}</td>
      <td style="color:${runData.flightBooking.cancellationStatus === 'CANCELLED' ? '#34C759' : '#FF3B30'};">
        ${escapeHtml(runData.flightBooking.cancellationStatus)}
      </td>
    </tr>`);
  }
  if (runData.hotelBooking) {
    rows.push(`<tr>
      <td>${escapeHtml(runData.hotelBooking.pnr || 'N/A')}</td>
      <td>Hotel</td>
      <td>${escapeHtml(runData.startTime)}</td>
      <td>${escapeHtml(runData.endTime || 'N/A')}</td>
      <td style="color:${runData.hotelBooking.cancellationStatus === 'CANCELLED' ? '#34C759' : '#FF3B30'};">
        ${escapeHtml(runData.hotelBooking.cancellationStatus)}
      </td>
    </tr>`);
  }
  return `<table><thead><tr><th>PNR</th><th>Type</th><th>Created</th><th>Cancelled</th><th>Status</th></tr></thead><tbody>${rows.join('')}</tbody></table>`;
}

function bugsSection(runData) {
  const allBugs = [
    ...(runData.flightBooking?.bugs || []),
    ...(runData.hotelBooking?.bugs || []),
  ];
  if (allBugs.length === 0) return '<p style="color:#34C759;">No bugs found in booking/cancellation flow.</p>';

  return allBugs.map(bug => `
    <div class="bug-card ${(bug.severity || 'p2').toLowerCase()}" style="border-left:4px solid ${bug.severity === 'P0' ? '#FF3B30' : '#FF9500'};">
      <div>${severityBadge(bug.severity)} <strong>${escapeHtml(bug.title)}</strong></div>
      ${bug.description ? `<p style="color:#aaa;font-size:13px;">${escapeHtml(bug.description)}</p>` : ''}
      <p style="color:#888;font-size:13px;">Fix: ${escapeHtml(bug.devFixRequired || '')}</p>
      ${bug.pnr ? `<p style="color:#FF3B30;font-size:13px;font-weight:600;">PNR requiring manual action: ${escapeHtml(bug.pnr)}</p>` : ''}
    </div>
  `).join('');
}

async function build(runData) {
  const now = new Date();
  const istStr = now.toLocaleString('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
  const dateStr = istStr.slice(0, 10);
  const filename = `booking-report-${dateStr}.html`;
  const reportDir = path.join(__dirname, '..', 'reports', 'fullbooking');
  if (!fs.existsSync(reportDir)) fs.mkdirSync(reportDir, { recursive: true });
  const reportPath = path.join(reportDir, filename);

  const allCancelled = [runData.flightBooking, runData.hotelBooking]
    .filter(b => b?.pnr)
    .every(b => b.cancellationStatus === 'CANCELLED');

  const pnrList = runData.allPnrs.join(', ') || 'None';
  const bannerColor = allCancelled ? '#1B4D2E' : '#4D0A0A';
  const bannerText = allCancelled
    ? `PNRs generated: ${pnrList} — Status: ALL CANCELLED`
    : `PNRs generated: ${pnrList} — SOME REQUIRE MANUAL CANCELLATION`;

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>EQIS Full Booking Report — ${dateStr}</title>
  <style>${CSS}</style>
</head>
<body>
  <div class="container">

    <!-- Header -->
    <div class="header">
      <h1>FULL BOOKING FLOW TEST REPORT</h1>
      <div class="meta">${escapeHtml(runData.runId)} | ${now.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}</div>
      <div class="tagline">All test bookings were cancelled immediately after PNR capture</div>
    </div>

    <div style="background:${bannerColor};border-radius:8px;padding:16px;margin-bottom:24px;text-align:center;font-weight:600;">
      ${escapeHtml(bannerText)}
    </div>

    <!-- Confirmation Checklist -->
    <div class="card">
      <h2>BOOKING CONFIRMATION CHECKLIST</h2>
      <div class="grid-2">
        <div>
          <h3>Flight Confirmation</h3>
          ${validationChecklist(runData.flightBooking?.validationResults, 'flight')}
        </div>
        <div>
          <h3>Hotel Confirmation</h3>
          ${validationChecklist(runData.hotelBooking?.validationResults, 'hotel')}
        </div>
      </div>
    </div>

    <!-- Confirmation Screenshots -->
    <div class="card">
      <h2>CONFIRMATION SCREENSHOTS</h2>
      ${runData.flightBooking?.confirmationScreenshot ? `
        <h3>Flight Confirmation</h3>
        <div class="screenshot-container"><img src="data:image/png;base64,${runData.flightBooking.confirmationScreenshot}" alt="Flight Confirmation" /></div>
      ` : '<p style="color:#888;">No flight confirmation screenshot.</p>'}
      ${runData.hotelBooking?.confirmationScreenshot ? `
        <h3>Hotel Confirmation</h3>
        <div class="screenshot-container"><img src="data:image/png;base64,${runData.hotelBooking.confirmationScreenshot}" alt="Hotel Confirmation" /></div>
      ` : '<p style="color:#888;">No hotel confirmation screenshot.</p>'}
    </div>

    <!-- PNR Audit Log -->
    <div class="card">
      <h2>PNR AUDIT LOG</h2>
      ${pnrAuditTable(runData)}
    </div>

    <!-- Bugs -->
    <div class="card">
      <h2>BUGS IN BOOKING + CANCELLATION FLOW</h2>
      ${bugsSection(runData)}
    </div>

    <!-- URL Log -->
    <div class="card">
      <h2>SESSION URL LOG</h2>
      <p style="color:#888;font-size:13px;margin-bottom:8px;">All URLs captured during booking and cancellation flow.</p>
      ${runData.urlLog || '<p style="color:#888;">No URLs captured.</p>'}
    </div>

    <!-- Footer -->
    <div class="footer">
      Test passengers: EQISTEST / QA[xxxxxx]<br>
      Payment method: ${escapeHtml(process.env.BOOKING_TEST_PAYMENT_METHOD || 'hold')}<br>
      Generated by ETRAV QA INTELLIGENCE SYSTEM | Next full booking test: tomorrow at 02:00 IST
    </div>

  </div>
</body>
</html>`;

  fs.writeFileSync(reportPath, html);
  logger.info(`[REPORT] Full booking report saved: ${reportPath}`);
  return reportPath;
}

module.exports = { build };
