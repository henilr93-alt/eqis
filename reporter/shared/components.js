function severityClass(severity) {
  return (severity || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function statusBadge(status) {
  const s = (status || 'unknown').toUpperCase();
  const cls = s === 'PASS' ? 'badge-pass' : s === 'WARN' ? 'badge-warn' : s === 'FAIL' ? 'badge-fail' : s === 'SKIPPED' ? 'badge-skipped' : 'badge-unknown';
  return `<span class="badge ${cls}">${s}</span>`;
}

function severityBadge(severity) {
  const s = (severity || 'P3').toUpperCase();
  return `<span class="badge badge-${s.toLowerCase()}">${s}</span>`;
}

function bugCard(bug) {
  const sev = (bug.severity || 'P3').toLowerCase();
  return `
    <div class="bug-card ${sev}">
      <div class="bug-title">${severityBadge(bug.severity)} ${escapeHtml(bug.title || 'Untitled Bug')}</div>
      <div class="bug-detail"><strong>Description:</strong> ${escapeHtml(bug.description || '')}</div>
      <div class="bug-detail"><strong>Location:</strong> ${escapeHtml(bug.elementLocation || bug.pageWhere || '')}</div>
      <div class="bug-detail"><strong>Dev Fix:</strong> ${escapeHtml(bug.devFixRequired || '')}</div>
      <div class="bug-detail"><strong>Est. Effort:</strong> ${escapeHtml(bug.estimatedEffort || 'N/A')}</div>
    </div>
  `;
}

function uxCard(issue) {
  const level = (issue.frictionLevel || 'LOW').toLowerCase();
  return `
    <div class="friction-card">
      <div class="friction-badge ${level}">${(issue.frictionLevel || 'LOW').toUpperCase()} FRICTION</div>
      <p><strong>Observation:</strong> ${escapeHtml(issue.observation || '')}</p>
      <p><strong>Agent Impact:</strong> ${escapeHtml(issue.agentImpact || '')}</p>
      <p><strong>Recommendation:</strong> ${escapeHtml(issue.recommendation || '')}</p>
    </div>
  `;
}

function stepSection(step, screenshotDir) {
  const eval_ = step.evaluation || {};
  const bugs = eval_.bugs || [];
  const uxFriction = eval_.uxFriction || [];
  const positives = eval_.positives || [];

  let screenshotHtml = '';
  if (step.screenshot) {
    screenshotHtml = `
      <div class="screenshot-container">
        <img src="data:image/png;base64,${step.screenshot}" alt="${step.stepName}" />
      </div>
    `;
  }

  return `
    <div class="step-section">
      <div class="step-header">
        <h3>Step: ${escapeHtml(step.stepName || 'Unknown')}</h3>
        ${statusBadge(eval_.overallStatus || step.status)}
        <span style="color:#888;font-size:13px;">${step.timestamp || ''}</span>
      </div>
      ${screenshotHtml}
      ${positives.length > 0 ? `
        <div style="margin:8px 0;">
          <strong style="color:#34C759;">What worked:</strong>
          <ul>${positives.map(p => `<li>${escapeHtml(p)}</li>`).join('')}</ul>
        </div>
      ` : ''}
      ${bugs.length > 0 ? `
        <div style="margin:8px 0;">
          <strong style="color:#FF3B30;">Issues found:</strong>
          ${bugs.map(bugCard).join('')}
        </div>
      ` : ''}
      ${uxFriction.length > 0 ? `
        <div style="margin:8px 0;">
          <strong style="color:#FFCC00;">UX notes:</strong>
          ${uxFriction.map(uxCard).join('')}
        </div>
      ` : ''}
    </div>
  `;
}

function statsBar(counts) {
  return `
    <div class="stats-bar">
      <div class="stat-item"><div class="value">${counts.totalSteps || 0}</div><div class="label">Total Steps</div></div>
      <div class="stat-item"><div class="value" style="color:#34C759;">${counts.passed || 0}</div><div class="label">Passed</div></div>
      <div class="stat-item"><div class="value" style="color:#FFCC00;">${counts.warned || 0}</div><div class="label">Warned</div></div>
      <div class="stat-item"><div class="value" style="color:#FF3B30;">${counts.failed || 0}</div><div class="label">Failed</div></div>
      <div class="stat-item"><div class="value">${counts.bugs || 0}</div><div class="label">Bugs</div></div>
      <div class="stat-item"><div class="value">${counts.uxIssues || 0}</div><div class="label">UX Issues</div></div>
      <div class="stat-item"><div class="value">${counts.uiChanges || 0}</div><div class="label">UI Changes</div></div>
    </div>
  `;
}

function tokenUsageBadge(tokenData) {
  if (!tokenData) return '';
  const total = (tokenData.input || 0) + (tokenData.output || 0);
  const cost = (total / 1_000_000 * 3.0).toFixed(4);
  return `
    <div style="font-size:11px; color:#555; border-top:1px solid #222; padding:8px 0; margin-top:16px;">
      Token usage this run:
      <span style="color:#888;">
        ${(tokenData.input || 0).toLocaleString()} in +
        ${(tokenData.output || 0).toLocaleString()} out =
        ${total.toLocaleString()} total
      </span>
      &nbsp;|&nbsp;
      API calls: <span style="color:#888;">${tokenData.calls || 0}</span>
      &nbsp;|&nbsp;
      Est. cost: <span style="color:#888;">~$${cost}</span>
    </div>
  `;
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

module.exports = {
  bugCard,
  uxCard,
  stepSection,
  statsBar,
  statusBadge,
  severityBadge,
  tokenUsageBadge,
  escapeHtml,
};
